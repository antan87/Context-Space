/**
 * Guided finish: verification evidence → preview of remote effects → commit,
 * push and PR links per repository → cleanup readiness. Multi-repository Git
 * effects are not atomic, so a partial run is shown as partial, recorded, and
 * resumed by finishing again; nothing already done is repeated.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Flag } from 'lucide-react';

import type { Feature, FinishReport } from '../../types.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Input } from '../../components/ui/input.js';
import { Spinner } from '../../components/ui/spinner.js';
import { StatusBadge } from '../../components/ui/status-badge.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiFetch } from '../../lib/api/client.js';
import { invalidateDeliveryState, useLastFinish, useProgression, useWorkspaceRepositories } from '../../lib/api/queries.js';
import { remoteLabel, submitFinish } from './deliveryApi.js';
import { PlanFinishList } from '../plan/PlanFinishList.js';

const MIN_REASON = 8;

interface Props {
  ws: Feature;
  onClose: () => void;
  onGitChanged: () => void;
}

export function FinishPanel({ ws, onClose, onGitChanged }: Props) {
  const wsId = ws.branchName;
  const queryClient = useQueryClient();
  const progression = useProgression(wsId);
  const lastFinish = useLastFinish(wsId);
  const repositories = useWorkspaceRepositories(wsId);
  const [message, setMessage] = useState('');
  const [createPrs, setCreatePrs] = useState(true);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<null | 'verify' | 'preview' | 'finish'>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FinishReport | null>(null);
  const [result, setResult] = useState<FinishReport | null>(null);

  const policy = progression.data;
  const needsMessage = (repositories.data ?? []).some((r) => r.editable && r.onExpectedBranch && r.dirty);
  const interrupted = lastFinish.data && (lastFinish.data.status === 'partial' || lastFinish.data.status === 'running')
    ? lastFinish.data
    : null;
  const overrideReady = overriding && reason.trim().length >= MIN_REASON;
  const canFinish = Boolean(policy) && (policy!.ready || overrideReady) && (!needsMessage || message.trim().length > 0);

  const refresh = async () => {
    onGitChanged();
    await invalidateDeliveryState(queryClient, wsId);
  };

  const verify = async () => {
    setBusy('verify');
    setError(null);
    try {
      await apiFetch(`/api/workspace/${encodeURIComponent(wsId)}/verify`, { method: 'POST', body: JSON.stringify({ allowDirty: true }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'preview' : 'finish');
    setError(null);
    const outcome = await submitFinish(wsId, {
      message: message.trim() || undefined,
      createPrs,
      overrideReason: !policy?.ready && overriding ? reason.trim() : undefined,
      dryRun,
    });
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.error);
      if (!dryRun) await refresh();
      return;
    }
    if (dryRun) {
      setPreview(outcome.data);
      return;
    }
    setResult(outcome.data);
    setPreview(null);
    await refresh();
  };

  return (
    <section aria-labelledby="finish-title" className="relative mb-6 rounded-xl border border-border bg-card p-5 shadow-sm animate-rise">
      <h5 id="finish-title" className="mb-3 flex items-center gap-1.5 text-xs font-bold text-foreground">
        <Flag size={13} className="text-primary" /> Finish work
      </h5>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive-foreground">{error}</div>
      )}

      {interrupted && !result && (
        <div role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs" data-testid="finish-resume">
          <p className="font-semibold">The last finish {interrupted.status === 'running' ? 'stopped before it completed' : 'did not complete'}.</p>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
            {interrupted.repos.map((r) => (
              <li key={r.name}>
                {r.name}: {r.commitHash ? `committed ${r.commitHash}` : r.committed ? 'committed' : 'not committed'}
                {r.pushed ? ', pushed' : r.error ? `, failed — ${r.error}` : r.skipped ? ` (skipped: ${r.skipped})` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-1">Finishing again resumes from here; completed commits are not repeated.</p>
        </div>
      )}

      <h6 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">Open in the plan</h6>
      <PlanFinishList workspaceId={wsId} />

      <h6 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">1. Verification evidence</h6>
      {progression.isLoading ? <Spinner className="size-4" /> : progression.isError ? (
        <p role="alert" className="text-xs text-destructive-foreground">Could not read verification state. <Button variant="outline" size="xs" onClick={() => progression.refetch()}>Retry</Button></p>
      ) : (
        <ul className="mb-3 space-y-1 text-xs" data-testid="finish-evidence">
          {policy!.repos.length === 0 && <li className="text-muted-foreground">No editable repositories. Prepare a reference repository for editing first.</li>}
          {policy!.repos.map((repo) => (
            <li key={repo.name} className="flex items-start gap-2">
              <StatusBadge tone={repo.ready ? 'success' : repo.state === 'failed' || repo.state === 'timed-out' || repo.state === 'unreadable' ? 'danger' : 'warning'}>
                {repo.state}
              </StatusBadge>
              <span>{repo.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {policy && !policy.ready && (
        <div className="mb-3 space-y-2">
          {policy.repos.some((repo) => !repo.ready) && <Button variant="outline" size="sm" onClick={() => void verify()} disabled={busy !== null}>
            {busy === 'verify' ? <Spinner className="size-3" /> : null} Run verification
          </Button>}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={overriding} onCheckedChange={(checked) => setOverriding(Boolean(checked))} aria-label="Finish anyway, with a reason" />
            Finish anyway, with a reason
          </label>
          {overriding && (
            <>
              <label className="block text-[11px] text-muted-foreground" htmlFor="finish-override-reason">
                Why is finishing anyway acceptable? This reason is recorded with the finish.
              </label>
              <Textarea id="finish-override-reason" className="text-xs" value={reason} onChange={(e) => setReason(e.target.value)} />
            </>
          )}
        </div>
      )}

      <h6 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">2. Commit, push and pull requests</h6>
      {needsMessage && (
        <>
          <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="finish-message">Commit message for remaining changes</label>
          <Input id="finish-message" className="mb-2 font-mono text-xs" value={message} onChange={(e) => setMessage(e.target.value)} />
        </>
      )}
      <label className="mb-3 flex items-center gap-2 text-xs">
        <Checkbox checked={createPrs} onCheckedChange={(checked) => setCreatePrs(Boolean(checked))} aria-label="Create pull requests" />
        Create pull requests when the GitHub CLI is signed in (otherwise show compare links)
      </label>

      {preview && (
        <ul className="mb-3 space-y-1 font-mono text-[11px]" data-testid="finish-preview" aria-label="Finish preview">
          {preview.repos.map((r) => (
            <li key={r.name}>
              {r.name}: {r.skipped ? `skipped — ${r.skipped}` : [
                r.wouldCommit ? `commit on ${r.branch}` : null,
                r.wouldPush ? `push ${r.branch} → ${remoteLabel(r.remoteUrl)}` : null,
                r.compareUrl ? 'PR link' : null,
                r.error ?? null,
              ].filter(Boolean).join('; ') || 'nothing to do'}
            </li>
          ))}
        </ul>
      )}

      {result && (
        <div className="mb-3 space-y-1 text-xs" aria-live="polite" data-testid="finish-result">
          {result.blocked ? (
            <p role="alert" className="text-destructive-foreground">Finish refused, nothing changed: {result.policy.blockers.join(' ')}</p>
          ) : (
            <>
              {result.override && <p className="text-amber-700">Finished anyway. Recorded reason: {result.override.reason}</p>}
              {result.repos.map((r) => (
                <p key={r.name} className="font-mono text-[11px]">
                  {r.name}: {r.skipped ? `skipped — ${r.skipped}` : [
                    r.committed ? `committed ${r.commitHash ?? ''}`.trim() : null,
                    r.pushed ? 'pushed' : null,
                    r.error ? `failed — ${r.error}` : null,
                  ].filter(Boolean).join(', ') || 'nothing to do'}
                  {(r.prUrl || r.compareUrl) && (
                    <> · <a className="underline" href={r.prUrl ?? r.compareUrl} target="_blank" rel="noreferrer">{r.prUrl ? 'pull request' : 'open a pull request'}</a></>
                  )}
                </p>
              ))}
              <p className={result.safeToCleanup ? 'text-success-foreground' : 'text-muted-foreground'}>
                {result.safeToCleanup
                  ? 'Everything is committed and pushed. Remove the workspace with `ctxspace finish --cleanup` when you are done.'
                  : 'Cleanup is unavailable until every editable repository is committed and pushed. Finish again to retry what failed.'}
              </p>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2.5">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy !== null}>Close</Button>
        <Button variant="outline" size="sm" onClick={() => void run(true)} disabled={busy !== null || !canFinish}>
          {busy === 'preview' ? <Spinner className="size-3" /> : null} Preview
        </Button>
        <Button size="sm" onClick={() => void run(false)} disabled={busy !== null || !canFinish}>
          {busy === 'finish' ? <Spinner className="size-3" /> : null}
          {interrupted ? 'Resume finish' : 'Finish'}
        </Button>
      </div>
    </section>
  );
}
