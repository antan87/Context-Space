/**
 * Reviewed commit: choose the repositories and files to commit, see where each
 * commit lands (branch → remote) and whether its verification is still fresh,
 * and decide separately whether to push. A failed request keeps the message
 * and the selection; a partial result offers retries only for what did not
 * finish (a failed push retries the push, never the commit).
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, Lock, Save } from 'lucide-react';

import type { CommitRepoResult, CommitResponse, EvidenceState, Feature, RepoEvidence, WorkspaceRepository } from '../../types.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Spinner } from '../../components/ui/spinner.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { Textarea } from '../../components/ui/textarea.js';
import { invalidateDeliveryState, useProgression, useWorkspaceRepositories } from '../../lib/api/queries.js';
import { remoteLabel, submitCommit, submitPush } from './deliveryApi.js';

const EVIDENCE_TONE: Record<EvidenceState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  passed: 'success',
  'passed-dirty': 'success',
  'no-tests': 'neutral',
  missing: 'warning',
  stale: 'warning',
  failed: 'danger',
  'timed-out': 'danger',
  unreadable: 'danger',
};

const EVIDENCE_LABEL: Record<EvidenceState, string> = {
  passed: 'Verified',
  'passed-dirty': 'Verified (uncommitted)',
  'no-tests': 'No tests',
  missing: 'Not verified',
  stale: 'Verification stale',
  failed: 'Verification failed',
  'timed-out': 'Verification timed out',
  unreadable: 'State unreadable',
};

interface Props {
  ws: Feature;
  message: string;
  setMessage: (message: string) => void;
  onClose: () => void;
  /** Called after every repo committed (and pushed, when requested). */
  onCompleted: (results: CommitRepoResult[]) => void;
  /** Called after any request that may have changed Git state. */
  onGitChanged: () => void;
  /** The files the person unticked, and the push choice, kept by the caller so they outlive the form: closing it, looking at a file or closing the window loses nothing. */
  excluded?: Set<string>;
  onExcludedChange?: (excluded: Set<string>) => void;
  push?: boolean;
  onPushChange?: (push: boolean) => void;
}

const fileKey = (repo: string, file: string) => `${repo}\u0000${file}`;

export function CommitReviewPanel({ ws, message, setMessage, onClose, onCompleted, onGitChanged, excluded: heldExcluded, onExcludedChange, push: heldPush, onPushChange }: Props) {
  const wsId = ws.branchName;
  const queryClient = useQueryClient();
  const repositories = useWorkspaceRepositories(wsId);
  const progression = useProgression(wsId);
  const [ownExcluded, setOwnExcluded] = useState<Set<string>>(new Set());
  const [ownPush, setOwnPush] = useState(true);
  const excluded = heldExcluded ?? ownExcluded;
  const setExcluded = (update: (current: Set<string>) => Set<string>) => (onExcludedChange ?? setOwnExcluded)(update(excluded));
  const push = heldPush ?? ownPush;
  const setPush = onPushChange ?? setOwnPush;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CommitResponse | null>(null);

  const repos = repositories.data ?? [];
  const evidence = useMemo(
    () => new Map<string, RepoEvidence>((progression.data?.repos ?? []).map((r) => [r.name, r])),
    [progression.data],
  );
  const committable = (repo: WorkspaceRepository) => repo.editable && repo.onExpectedBranch && repo.dirty;

  const selection = useMemo(() => {
    const files: Record<string, string[]> = {};
    for (const repo of repos.filter(committable)) {
      const chosen = repo.changedFiles.map((f) => f.path).filter((file) => !excluded.has(fileKey(repo.name, file)));
      if (chosen.length > 0) files[repo.name] = chosen;
    }
    return files;
  }, [repos, excluded]);
  const selectedRepos = Object.keys(selection);
  const selectedCount = selectedRepos.reduce((sum, name) => sum + selection[name]!.length, 0);

  const toggleFile = (repo: string, file: string, include: boolean) => setExcluded((current) => {
    const next = new Set(current);
    if (include) next.delete(fileKey(repo, file)); else next.add(fileKey(repo, file));
    return next;
  });
  const toggleRepo = (repo: WorkspaceRepository, include: boolean) => setExcluded((current) => {
    const next = new Set(current);
    for (const file of repo.changedFiles) {
      if (include) next.delete(fileKey(repo.name, file.path)); else next.add(fileKey(repo.name, file.path));
    }
    return next;
  });

  const refresh = async () => {
    onGitChanged();
    await invalidateDeliveryState(queryClient, wsId);
  };

  const commit = async (files: Record<string, string[]>) => {
    setBusy(true);
    setError(null);
    const result = await submitCommit(wsId, { message: message.trim(), files, noPush: !push });
    setBusy(false);
    if (!result.ok) {
      // The draft (message, selection, push choice) stays exactly as it was.
      setError(result.error);
      if (result.kind !== 'network') await refresh();
      return;
    }
    await refresh();
    const merged = mergeOutcome(outcome, result.data);
    setOutcome(merged);
    if (result.data.results.length > 0 && result.data.results.every((r) => r.success)) {
      setMessage('');
      setExcluded(() => new Set());
      setOutcome(null);
      onCompleted(merged.results);
    }
  };

  const retryPush = async (names: string[]) => {
    setBusy(true);
    setError(null);
    const result = await submitPush(wsId, names);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refresh();
    setOutcome((current) => current && {
      ...current,
      results: current.results.map((r) => {
        const pushed = result.data.results.find((p) => p.name === r.repoName);
        return pushed ? { ...r, pushed: pushed.pushed, success: pushed.pushed, pushError: pushed.error } : r;
      }),
    });
  };

  const failedCommits = outcome?.results.filter((r) => !r.committed) ?? [];
  const failedPushes = outcome?.results.filter((r) => r.committed && !r.pushed && r.pushError) ?? [];
  const destinations = selectedRepos.map((name) => repos.find((r) => r.name === name)!).filter(Boolean);

  return (
    <section aria-labelledby="commit-review-title" className="relative mb-6 rounded-xl border border-border bg-card p-5 shadow-sm animate-rise">
      <h5 id="commit-review-title" className="mb-3 flex items-center gap-1.5 text-xs font-bold text-foreground">
        <Save size={13} className="text-primary" /> Review commit
      </h5>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive-foreground">
          <p className="font-semibold">The commit did not complete.</p>
          <p className="mt-1">{error}</p>
          <p className="mt-1 text-muted-foreground">Your message and file selection are kept.</p>
        </div>
      )}

      {repositories.isLoading ? (
        <div className="flex justify-center py-6"><Spinner className="size-5 text-primary" /></div>
      ) : repositories.isError ? (
        <div role="alert" className="mb-4 text-xs text-destructive-foreground">
          Could not read the repositories: {String((repositories.error as Error).message)}.
          <Button variant="outline" size="xs" className="ml-2" onClick={() => repositories.refetch()}>Retry</Button>
        </div>
      ) : (
        <div className="mb-4 space-y-3">
          {repos.filter((repo) => repo.dirty).map((repo) => {
            const proof = evidence.get(repo.name);
            const repoFiles = repo.changedFiles.map((f) => f.path);
            const chosen = selection[repo.name]?.length ?? 0;
            return (
              <div key={repo.name} className="rounded-lg border border-border/70 p-3" data-testid={`commit-repo-${repo.name}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {committable(repo) && (
                    <Checkbox
                      aria-label={`Commit changes in ${repo.name}`}
                      checked={chosen === repoFiles.length}
                      indeterminate={chosen > 0 && chosen < repoFiles.length}
                      onCheckedChange={(checked) => toggleRepo(repo, Boolean(checked))}
                    />
                  )}
                  <span className="font-semibold text-foreground">{repo.name}</span>
                  {repo.editable ? (
                    <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                      <GitBranch size={11} /> {repo.expectedBranch} → {push ? remoteLabel(repo.remoteUrl) : 'local only'}
                    </span>
                  ) : (
                    <StatusBadge tone="idle"><Lock size={10} /> read-only reference</StatusBadge>
                  )}
                  {proof && (
                    <StatusBadge tone={EVIDENCE_TONE[proof.state]} title={proof.detail}>{EVIDENCE_LABEL[proof.state]}</StatusBadge>
                  )}
                </div>
                {!repo.editable && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Not committed: this is your own checkout. Prepare it for editing to work on it in this workspace.
                  </p>
                )}
                {repo.editable && !repo.onExpectedBranch && (
                  <p className="mt-2 text-[11px] text-warning-foreground">
                    On {repo.branch ? `branch ${repo.branch}` : 'a detached HEAD'}, not {repo.expectedBranch}. Switch back before committing.
                  </p>
                )}
                {committable(repo) && (
                  <ul className="mt-2 space-y-1">
                    {repo.changedFiles.map((file) => (
                      <li key={file.path} className="flex items-center gap-2 font-mono text-[11px]">
                        <Checkbox
                          aria-label={`Include ${repo.name}/${file.path}`}
                          checked={!excluded.has(fileKey(repo.name, file.path))}
                          onCheckedChange={(checked) => toggleFile(repo.name, file.path, Boolean(checked))}
                        />
                        <span className="w-5 text-muted-foreground">{file.code.trim() || '??'}</span>
                        <span className="truncate">{file.path}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {proof && !proof.ready && committable(repo) && (
                  <p className="mt-2 text-[11px] text-muted-foreground">{proof.detail} Commits are allowed; finishing needs fresh verification.</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {outcome && (
        <div className="mb-4 space-y-1.5" aria-live="polite">
          {outcome.results.map((r) => (
            <p key={r.repoName} className="font-mono text-[11px]">
              <span className="font-semibold">{r.repoName}:</span>{' '}
              {r.committed ? `committed ${r.commitHash || ''} on ${r.branch}` : `not committed — ${r.message}`}
              {r.committed && (r.pushed ? ', pushed' : r.pushError ? `, push failed — ${r.pushError}` : ', not pushed')}
            </p>
          ))}
          {outcome.skipped.map((s) => (
            <p key={s.name} className="font-mono text-[11px] text-muted-foreground"><span className="font-semibold">{s.name}:</span> skipped — {s.reason}</p>
          ))}
        </div>
      )}

      <label className="mb-1 block text-[11px] font-semibold text-muted-foreground" htmlFor="commit-review-message">Commit message</label>
      <Textarea
        id="commit-review-message"
        className="mb-3 font-mono text-xs"
        placeholder="feat: describe the change"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <label className="mb-3 flex items-center gap-2 text-xs">
        <Checkbox checked={push} onCheckedChange={(checked) => setPush(Boolean(checked))} aria-label="Push after committing" />
        Push after committing
      </label>
      <p className="mb-3 text-[11px] text-muted-foreground" data-testid="commit-review-summary">
        {selectedCount === 0
          ? 'Select at least one file.'
          : `Commit ${selectedCount} file${selectedCount === 1 ? '' : 's'} in ${destinations.map((r) => `${r.name} (${r.expectedBranch})`).join(', ')}${push ? `, then push to ${destinations.map((r) => remoteLabel(r.remoteUrl)).join(', ')}` : ', without pushing'}. Other changes stay as they are.`}
      </p>

      <div className="flex flex-wrap justify-end gap-2.5">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Close</Button>
        {failedPushes.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => retryPush(failedPushes.map((r) => r.repoName))} disabled={busy}>
            Retry push ({failedPushes.map((r) => r.repoName).join(', ')})
          </Button>
        )}
        {failedCommits.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !message.trim()}
            onClick={() => commit(Object.fromEntries(failedCommits.map((r) => [r.repoName, selection[r.repoName] ?? []]).filter(([, files]) => files.length > 0)))}
          >
            Retry failed ({failedCommits.map((r) => r.repoName).join(', ')})
          </Button>
        )}
        <Button size="sm" onClick={() => commit(selection)} disabled={busy || !message.trim() || selectedCount === 0}>
          {busy ? <Spinner className="size-3" /> : null}
          {busy ? 'Working…' : push ? 'Commit & push selected' : 'Commit selected'}
        </Button>
      </div>
    </section>
  );
}

/** Keeps earlier results for repos a retry did not include. */
function mergeOutcome(previous: CommitResponse | null, next: CommitResponse): CommitResponse {
  if (!previous) return next;
  const retried = new Set(next.results.map((r) => r.repoName));
  return {
    ...next,
    results: [...previous.results.filter((r) => !retried.has(r.repoName)), ...next.results],
    skipped: next.skipped,
  };
}
