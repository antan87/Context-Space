import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Check, CheckCircle2, Circle, Copy, Loader2 } from 'lucide-react';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import type { LifecycleStep, WorkGuidance } from '../../types.js';
import type { VerificationGateTelemetry } from '../cockpit/cockpitStore.js';
import { nextMilestone, verificationText } from './workspaceStatus.js';

interface WorkspaceHeaderProps {
  workspaceId: string;
  title: string;
  /** Shown next to a custom name; omitted when the title already is the branch. */
  branchName?: string;
  brief?: string;
  mode: 'in-place' | 'worktree' | string;
  repoCount: number;
  changedFiles: number | null;
  stage?: WorkGuidance['assignment']['stage'];
  milestones: LifecycleStep[];
  verification: VerificationGateTelemetry;
  actions?: ReactNode;
  /** Just who this is and its actions. The chat shows where the work stands in the strip above it. */
  compact?: boolean;
}

const STAGE_LABELS: Record<WorkGuidance['assignment']['stage'], string> = {
  investigate: 'Investigate',
  design: 'Design',
  implement: 'Implement',
  verify: 'Verify',
  review: 'Review',
  release: 'Release',
};

function Fact({ label, children, to }: { label: string; children: ReactNode; to?: string }) {
  const body = (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>{' '}
      <span className="font-medium text-foreground">{children}</span>
    </span>
  );
  return to
    ? <Link to={to} className="inline-flex h-6 items-center rounded-md border border-border/40 bg-muted/20 px-2 text-xs transition-colors hover:border-border/70 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">{body}</Link>
    : <span className="inline-flex h-6 items-center rounded-md border border-border/40 bg-muted/20 px-2 text-xs">{body}</span>;
}

/**
 * One header per workspace: who it is, the brief, and where the task stands
 * (stage, next milestone, changes, verification). Each status fact links to
 * the destination where the user acts on it.
 */
export function WorkspaceHeader({ workspaceId, title, branchName, brief, mode, repoCount, changedFiles, stage, milestones, verification, actions, compact = false }: WorkspaceHeaderProps) {
  const [copied, setCopied] = useState(false);
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const next = nextMilestone(milestones);
  const done = milestones.length > 0 && !next;

  return (
    <header className={cn('border-b border-border/40 bg-card/60 backdrop-blur-xs px-4 sm:px-6', compact ? 'py-1.5' : 'pt-3 pb-2.5')}>
      <div className={cn('flex flex-wrap justify-between gap-x-4 gap-y-2', compact ? 'items-center' : 'items-start')}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-foreground" title={title}>{title}</h1>
            {branchName && <button
              type="button"
              onClick={async () => { if (await safeCopyToClipboard(branchName)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border/40 bg-muted/20 px-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={copied ? 'Branch name copied' : `Copy branch name ${branchName}`}
            >
              {branchName}{copied ? <Check aria-hidden="true" size={12} className="text-emerald-600 dark:text-emerald-400" /> : <Copy aria-hidden="true" size={12} />}
            </button>}
            <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border/40 bg-muted/20 px-2 text-xs text-muted-foreground">{mode === 'in-place' ? 'In place' : 'Worktree'} · {repoCount} {repoCount === 1 ? 'repository' : 'repositories'}</span>
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {/* Below the title row, not beside the actions, so a narrow screen gives it the whole width. */}
      {brief && !compact && <p className="mt-1 line-clamp-2 max-w-3xl text-sm text-muted-foreground leading-relaxed">{brief}</p>}

      {!compact && <div aria-label="Task status" role="group" className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
        {stage && <Fact label="Stage" to={`${base}/plan`}>{STAGE_LABELS[stage]}</Fact>}
        {next ? (
          <Fact label="Next" to={`${base}/plan`}>
            <span className="inline-flex min-w-0 max-w-[28ch] items-center gap-1 sm:max-w-[40ch]" title={next.title}><ArrowRight aria-hidden="true" size={12} className="shrink-0 text-muted-foreground" /><span className="truncate"><InlinePlanMarkdown content={next.title} /></span></span>
          </Fact>
        ) : done ? <Fact label="Milestones">All done</Fact> : null}
        <Fact label="Changes" to={`${base}/changes`}>
          {changedFiles === null ? 'Unknown' : changedFiles === 0 ? 'None' : `${changedFiles} ${changedFiles === 1 ? 'file' : 'files'}`}
        </Fact>
        <Link
          to={`${base}/plan`}
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring',
            verification.overallStatus === 'pass' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : verification.overallStatus === 'fail' ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400'
                : verification.overallStatus === 'running' ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400'
                  : 'border-border/40 bg-muted/20 text-muted-foreground',
          )}
          title={verification.summaryText}
        >
          {verification.overallStatus === 'pass' ? <CheckCircle2 aria-hidden="true" size={12} />
            : verification.overallStatus === 'fail' ? <AlertCircle aria-hidden="true" size={12} />
              : verification.overallStatus === 'running' ? <Loader2 aria-hidden="true" size={12} className="animate-spin" />
                : <Circle aria-hidden="true" size={12} />}
          {verificationText(verification)}
        </Link>
      </div>}
    </header>
  );
}
