import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Check, CheckCircle2, Circle, Copy, Loader2 } from 'lucide-react';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import type { VerificationGateTelemetry } from '../cockpit/cockpitStore.js';
import { usePlan } from '../../lib/api/queries.js';
import { milestoneProgress } from '../plan/planView.js';
import { nextLine, verificationTitle, verificationText } from './workspaceStatus.js';

interface WorkspaceHeaderProps {
  workspaceId: string;
  title: string;
  /** Shown next to a custom name; omitted when the title already is the branch. */
  branchName?: string;
  mode: 'in-place' | 'worktree' | string;
  repoCount: number;
  changedFiles: number | null;
  verification: VerificationGateTelemetry;
  /** Warnings as small marks, each with its detail on demand. */
  marks?: ReactNode;
  actions?: ReactNode;
  /** Just who this is and its actions. The chat shows where the work stands in its own toolbar. */
  compact?: boolean;
}

function Fact({ label, children, to }: { label: string; children: ReactNode; to?: string }) {
  const body = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>{' '}
      <span className="min-w-0 font-medium text-foreground">{children}</span>
    </span>
  );
  return to
    ? <Link to={to} className="inline-flex h-6 min-w-0 items-center rounded-md border border-border/40 bg-muted/20 px-2 text-xs transition-colors hover:border-border/70 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">{body}</Link>
    : <span className="inline-flex h-6 min-w-0 items-center rounded-md border border-border/40 bg-muted/20 px-2 text-xs">{body}</span>;
}

/**
 * One header bar per workspace: who it is, its warnings as marks and its actions, with where the task stands (now,
 * next, changes, checks) on a short second line. Each status fact links to where the user acts on it. The goal is
 * on the plan, so it is not repeated here.
 */
export function WorkspaceHeader({ workspaceId, title, branchName, mode, repoCount, changedFiles, verification, marks, actions, compact = false }: WorkspaceHeaderProps) {
  const [copied, setCopied] = useState(false);
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  // Now and Next come from the plan, by the rule the plan, the strip and the AI use.
  const plan = usePlan(compact ? null : workspaceId).data;
  const now = plan?.focus.current;
  const next = nextLine(plan?.focus);
  const progress = plan ? milestoneProgress(plan) : { done: 0, total: 0 };
  const done = progress.total > 0 && progress.done === progress.total;

  return (
    <header className="border-b border-border/40 bg-card/60 px-4 py-1.5 backdrop-blur-xs sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h1 className="min-w-0 max-w-full truncate text-lg font-semibold tracking-tight text-foreground" title={title}>{title}</h1>
          {branchName && <button
            type="button"
            onClick={async () => { if (await safeCopyToClipboard(branchName)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border/40 bg-muted/20 px-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={copied ? 'Branch name copied' : `Copy branch name ${branchName}`}
          >
            {branchName}{copied ? <Check aria-hidden="true" size={12} className="text-[var(--state-done)]" /> : <Copy aria-hidden="true" size={12} />}
          </button>}
          {!compact && <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border/40 bg-muted/20 px-2 text-xs text-muted-foreground">{mode === 'in-place' ? 'In place' : 'Worktree'} · {repoCount} {repoCount === 1 ? 'repository' : 'repositories'}</span>}
        </div>
        {(marks || actions) && <div className="flex shrink-0 items-center gap-1.5">{marks}{actions}</div>}
        {/* Where the task stands, on its own line in the same bar; on a phone the plan says it. */}
        {!compact && <div aria-label="Task status" role="group" className="hidden w-full min-w-0 flex-wrap items-center gap-2 text-xs sm:flex">
          {now && <Fact label="Now" to={`${base}/plan`}>
            <span className="inline-block max-w-[22ch] truncate align-bottom sm:max-w-[32ch]" title={now.title}><InlinePlanMarkdown content={now.title} /></span>
          </Fact>}
          {next ? (
            <Fact label="Next" to={`${base}/plan`}>
              <span className="inline-flex min-w-0 max-w-[26ch] items-center gap-1 sm:max-w-[48ch]" title={next.waits ? `${next.title} · ${next.waits}` : next.title}>
                <ArrowRight aria-hidden="true" size={12} className="shrink-0 text-muted-foreground" />
                <span className="truncate"><InlinePlanMarkdown content={next.title} />{next.waits && <span className="font-normal text-muted-foreground"> · {next.waits}</span>}</span>
              </span>
            </Fact>
          ) : done ? <Fact label="Milestones">All done</Fact> : null}
          <Fact label="Changes" to={`${base}/changes`}>
            {changedFiles === null ? 'Unknown' : changedFiles === 0 ? 'None' : `${changedFiles} ${changedFiles === 1 ? 'file' : 'files'}`}
          </Fact>
          <Link
            to={`${base}/plan`}
            className={cn(
              'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring',
              verification.overallStatus === 'pass' ? 'border-[color-mix(in_oklab,var(--state-done)_35%,transparent)] text-[var(--state-done)]'
                : verification.overallStatus === 'fail' ? 'border-[color-mix(in_oklab,var(--state-reopened)_35%,transparent)] text-[var(--state-reopened)]'
                  : verification.overallStatus === 'running' ? 'border-[color-mix(in_oklab,var(--state-ai)_35%,transparent)] text-[var(--state-ai)]'
                    : 'border-border/40 bg-muted/20 text-muted-foreground',
            )}
            title={verificationTitle(verification)}
          >
            {verification.overallStatus === 'pass' ? <CheckCircle2 aria-hidden="true" size={12} />
              : verification.overallStatus === 'fail' ? <AlertCircle aria-hidden="true" size={12} />
                : verification.overallStatus === 'running' ? <Loader2 aria-hidden="true" size={12} className="animate-spin" />
                  : <Circle aria-hidden="true" size={12} />}
            {verificationText(verification)}
          </Link>
        </div>}

      </div>
    </header>
  );
}
