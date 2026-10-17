import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldCheck, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { apiFetch } from '../../lib/api/client.js';
import { invalidateDeliveryState } from '../../lib/api/queries.js';
import type { BranchFleetMember, WorkspaceLifecycle, WorkspaceVerificationReport } from '../../types.js';
import { whenText } from './planView.js';

type Status = WorkspaceVerificationReport['overallStatus'];

/** What a run means for the developer, and what to do next. */
function resultText(report: WorkspaceVerificationReport, milestoneCheckActive: boolean): string {
  const seconds = report.durationMs !== undefined ? ` in ${(report.durationMs / 1000).toFixed(1)} s` : '';
  const repos = `${report.repos.length} ${report.repos.length === 1 ? 'repository' : 'repositories'}`;
  const messages: Record<Status, string> = {
    pass: `Tests passed${seconds} (${repos}).${milestoneCheckActive ? ' Finish the milestone in progress from the plan.' : ''}`,
    pass_dirty: report.canProgress
      ? 'Tests passed with uncommitted changes. Review the changes before continuing.'
      : 'Tests passed with uncommitted changes. Commit them and run the checks again before continuing.',
    'no-tests': 'No test command was found. Configure a verification command for this workspace and run it again.',
    timeout: 'Verification timed out. Check the command and output below, then retry.',
    fail: 'Verification failed. Review the repository details below, fix the problem, and retry.',
    skipped: 'Verification was skipped. Run verification before relying on a test result.',
  };
  return messages[report.overallStatus];
}

const TONE: Record<'pass' | 'warn' | 'fail', string> = {
  pass: 'border-state-done/30 bg-state-done/10 text-state-done',
  warn: 'border-warning/30 bg-warning/10 text-warning-foreground',
  fail: 'border-destructive/30 bg-destructive/10 text-destructive-foreground',
};
const toneOf = (status: Status) => status === 'pass' ? 'pass' : status === 'pass_dirty' || status === 'no-tests' || status === 'skipped' ? 'warn' : 'fail';

/** Other branches of this work: who else is on it, and how far apart the branches are. */
function OtherBranches({ fleet }: { fleet: BranchFleetMember[] }) {
  const manyRepos = new Set(fleet.map((member) => member.repoName)).size > 1;
  return <details className="group text-xs">
    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Other branches of this work ({fleet.length})</summary>
    <ul className="mt-2 space-y-1">
      {fleet.map((member) => <li key={`${member.repoName}:${member.branch}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border border-border/50 px-2.5 py-1.5">
        <span className="font-mono font-medium text-foreground">{member.branch}</span>
        {manyRepos && member.repoName && <span className="text-muted-foreground">{member.repoName}</span>}
        {member.isCurrent && <span className="text-muted-foreground">this workspace</span>}
        <span className="text-muted-foreground" title={`${member.ahead} commits ahead, ${member.behind} behind`}>{member.ahead} ahead · {member.behind} behind</span>
        {member.lastCommitAuthor && <span className="text-muted-foreground">{member.lastCommitAuthor}{member.lastCommitDate && whenText(member.lastCommitDate) ? `, ${whenText(member.lastCommitDate)}` : ''}</span>}
        {member.lastCommitMessage && <span className="min-w-0 max-w-[32ch] truncate italic text-muted-foreground" title={member.lastCommitMessage}>{member.lastCommitMessage}</span>}
      </li>)}
    </ul>
  </details>;
}

/**
 * The workspace's checks: run the tests of every repository and read why they failed. Milestones and
 * their own checks are in the plan above, so they are not listed again here.
 */
export function WorkspaceChecks({ workspaceId, readOnly = false }: { workspaceId: string; /** Archived: show the last result, run nothing. */ readOnly?: boolean }) {
  const [lifecycle, setLifecycle] = useState<WorkspaceLifecycle | null>(null);
  const [report, setReport] = useState<WorkspaceVerificationReport | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ status: Status; text: string } | null>(null);
  const queryClient = useQueryClient();
  const base = `/api/workspace/${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<{ lifecycle: WorkspaceLifecycle; report?: WorkspaceVerificationReport | null }>(`${base}/lifecycle?fleet=1`, { signal });
      // A response for a workspace the user already left must not replace the current one.
      if (signal?.aborted) return;
      setLifecycle(data.lifecycle);
      if (data.report !== undefined) setReport(data.report);
    } catch (error) {
      if (signal?.aborted) return;
      // Missing lifecycle state is normal for newly initialized or test workspaces.
      console.warn('Could not load the workspace checks:', error);
    }
  }, [base]);

  useEffect(() => {
    setReport(null);
    setMessage(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const run = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const data = await apiFetch<{ report: WorkspaceVerificationReport }>(`${base}/verify`, { method: 'POST', body: JSON.stringify({}) });
      setReport(data.report);
      const milestoneCheckActive = Boolean(lifecycle?.steps.some((step) => step.id === lifecycle.currentStepId && step.requiresVerification));
      setMessage({ status: data.report.overallStatus, text: resultText(data.report, milestoneCheckActive) });
      await load();
    } catch (error) {
      setMessage({ status: 'fail', text: `Verification failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setRunning(false);
      // The header's check, finishing and the repository views read shared queries; refresh them with this card.
      void invalidateDeliveryState(queryClient, workspaceId);
    }
  };

  const fleet = lifecycle?.fleet ?? [];
  return <section aria-labelledby={`${workspaceId}-checks`} className="space-y-3 rounded-xl border border-border/40 bg-card/60 px-4 py-3 shadow-2xs backdrop-blur-xs">
    <header className="flex flex-wrap items-center gap-2">
      <ShieldCheck aria-hidden="true" className="size-4 text-muted-foreground" />
      <h3 id={`${workspaceId}-checks`} className="text-xs font-semibold text-foreground/80">Checks</h3>
      <span className="text-xs text-muted-foreground">the tests of every repository; a milestone's own check is in the plan</span>
      <span className="flex-1" />
      {!readOnly && <Button size="xs" variant="outline" onClick={() => void run()} disabled={running}>
        <ShieldCheck className={running ? 'animate-spin' : ''} />{running ? 'Running the checks…' : 'Run verification'}
      </Button>}
    </header>

    {message && <div role="status" className={`flex items-start justify-between gap-2 rounded-lg border p-2.5 text-xs font-medium ${TONE[toneOf(message.status)]}`}>
      <span className="flex items-start gap-2">
        {message.status === 'pass' ? <CheckCircle2 aria-hidden="true" className="mt-px size-3.5 shrink-0" /> : <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0" />}
        <span>{message.text}</span>
      </span>
      <IconButton label="Dismiss" icon={<X />} className="-my-1 shrink-0" onClick={() => setMessage(null)} />
    </div>}

    {report && <details className="rounded-lg border border-border/50 p-2.5 text-xs" open={report.overallStatus !== 'pass'}>
      <summary className="cursor-pointer font-medium">Verification details ({report.overallStatus.replaceAll('_', ' ')})</summary>
      {report.repos.map((repo, index) => <div key={`${repo.repoName}-${index}`} className="mt-3 space-y-2 border-t border-border/50 pt-3">
        <p className="font-semibold">{repo.repoName}: {repo.status.replaceAll('_', ' ')}</p>
        <p className="break-all font-mono">{repo.command}{repo.exitCode !== null ? ` — exit code ${repo.exitCode}` : ''}</p>
        {repo.status === 'no-tests' && <p>No test command found. Configure a workspace verification command.</p>}
        {repo.status === 'timeout' && <p>The command exceeded its time limit. Check for a stalled test or split the suite, then retry.</p>}
        {repo.error && <p className="text-destructive">{repo.error}</p>}
        {(repo.stdout || repo.stderr) && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3">{[repo.stdout, repo.stderr].filter(Boolean).join('\n')}</pre>}
      </div>)}
    </details>}

    {fleet.length > 0 && <OtherBranches fleet={fleet} />}
  </section>;
}
