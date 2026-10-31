import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, Check, CheckCircle2, Circle, Copy, FileDiff, FolderGit2, ListChecks, Loader2, MoreVertical } from 'lucide-react';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../../components/ui/menu.js';
import type { VerificationGateTelemetry } from '../cockpit/cockpitStore.js';
import { usePlanFile } from '../plan/planFile.js';
import { verificationTitle, verificationText } from './workspaceStatus.js';
import { WarningDialog, useWorkspaceWarnings, type WorkspaceWarning } from './WorkspaceMarks.js';

interface WorkspaceHeaderProps {
  workspaceId: string;
  title: string;
  /** Shown next to a custom name; omitted when the title already is the branch. */
  branchName?: string;
  mode: 'in-place' | 'worktree' | string;
  repoCount: number;
  changedFiles: number | null;
  verification: VerificationGateTelemetry;
  /** Whether this workspace can warn (an archived one cannot). */
  warns?: boolean;
  /** The icons that matter most, such as opening in an editor. */
  actions?: ReactNode;
  /** The workspace's own items in the menu, after the facts. */
  menuItems?: ReactNode;
  /** Just who this is and its actions. The chat shows where the work stands in its own toolbar. */
  compact?: boolean;
}

/**
 * One line per workspace: its name, the branch as quiet text (copy shows on hover or focus), the one checkpoint the
 * work is on, and at the right a dot for the checks, the primary actions and a menu. Everything else (where the
 * workspace lives, the next checkpoint, the changes, warnings that need action) is one press away in the menu, so the
 * board and the other panes start high. A warning puts a dot on the menu and a line in it.
 */
export function WorkspaceHeader({ workspaceId, title, branchName, mode, repoCount, changedFiles, verification, warns = true, actions, menuItems, compact = false }: WorkspaceHeaderProps) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<WorkspaceWarning | null>(null);
  const navigate = useNavigate();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  // Now and Next are the plan's first two checkpoints still open.
  const plan = usePlanFile(workspaceId).data;
  const open = plan?.checkpoints.filter((checkpoint) => !checkpoint.done) ?? [];
  const now = open[0];
  const next = open[1];
  const done = Boolean(plan?.checkpoints.length) && open.length === 0;
  // The chip goes entirely when it cannot show about ten characters of the checkpoint; the menu then carries Now.
  const hasNow = Boolean(now);
  const chipSlot = useRef<HTMLDivElement>(null);
  const [chipFits, setChipFits] = useState(false);
  useLayoutEffect(() => {
    const slot = chipSlot.current;
    if (!slot || typeof ResizeObserver === 'undefined') { setChipFits(Boolean(slot)); return; }
    // The container query (@[8.5rem]) decides whether the chip shows; the menu follows what it decided, so they never disagree.
    const measure = () => {
      const chip = slot.firstElementChild;
      setChipFits(Boolean(chip) && getComputedStyle(chip as Element).display !== 'none');
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [hasNow, done, compact]);
  const { warnings, dismiss } = useWorkspaceWarnings(workspaceId, warns);
  const place = `${mode === 'in-place' ? 'In place' : 'Worktree'} · ${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}`;
  const changes = changedFiles === null ? 'Unknown' : changedFiles === 0 ? 'None' : `${changedFiles} ${changedFiles === 1 ? 'file' : 'files'}`;
  const status = verification.overallStatus;
  const copyBranch = async () => { if (branchName && await safeCopyToClipboard(branchName)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } };

  return (
    <header className="h-11 shrink-0 border-b border-border/40 bg-card/60 px-4 backdrop-blur-xs sm:px-6">
      <div className="flex h-full items-center gap-x-3">
        <div className="flex min-w-0 flex-1 items-center gap-x-2.5 overflow-hidden">
          <h1 className="min-w-0 max-w-[40ch] shrink truncate text-base font-semibold tracking-tight text-foreground" title={title}>{title}</h1>
          {branchName && <button
            type="button"
            onClick={copyBranch}
            className="group/branch hidden h-6 min-w-[6ch] max-w-[32ch] shrink-[3] items-center gap-1 rounded-md px-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:inline-flex"
            aria-label={copied ? 'Branch name copied' : `Copy branch name ${branchName}`}
          >
            <span className="truncate">{branchName}</span>
            {copied ? <Check aria-hidden="true" size={12} className="shrink-0 text-[var(--state-done)]" /> : <Copy aria-hidden="true" size={12} className="shrink-0 opacity-0 transition-opacity group-hover/branch:opacity-100 group-focus-visible/branch:opacity-100" />}
          </button>}
          {/* Where the task stands: one chip. On a phone the plan says it. */}
          {!compact && (now || done) && <div ref={chipSlot} aria-label="Task status" role="group" className="@container hidden min-w-0 max-w-[28ch] grow basis-0 sm:flex">
            {now ? (
              <Link
                to={`${base}/plan`}
                className="hidden h-6 min-w-0 items-center gap-1.5 rounded-md border border-border/40 bg-muted/20 px-2 text-xs transition-colors hover:border-border/70 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring @[8.5rem]:inline-flex"
              >
                <span className="text-muted-foreground">Now</span>{' '}
                <span className="inline-block max-w-[22ch] truncate font-medium text-foreground sm:max-w-[28ch]" title={now.title}><InlinePlanMarkdown content={now.title} /></span>
              </Link>
            ) : (
              <span className="hidden h-6 items-center gap-1.5 rounded-md border border-border/40 bg-muted/20 px-2 text-xs @[8.5rem]:inline-flex"><span className="text-muted-foreground">Checkpoints</span> <span className="font-medium text-foreground">All done</span></span>
            )}
          </div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!compact && (
            <Link
              to={`${base}/plan`}
              title={verificationTitle(verification)}
              className={cn(
                'relative grid size-6 place-items-center rounded-md transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
                status === 'pass' ? 'text-[var(--state-done)]' : status === 'fail' ? 'text-[var(--state-reopened)]' : status === 'running' ? 'text-[var(--state-ai)]' : 'text-muted-foreground',
              )}
            >
              {status === 'pass' ? <CheckCircle2 aria-hidden="true" size={14} />
                : status === 'fail' ? <AlertCircle aria-hidden="true" size={14} />
                  : status === 'running' ? <Loader2 aria-hidden="true" size={14} className="animate-spin" />
                    : <Circle aria-hidden="true" size={14} />}
              <span className="sr-only">{verificationText(verification)}</span>
            </Link>
          )}
          {actions}
          <Menu>
            <MenuTrigger aria-label={warnings.length > 0 ? `Workspace actions, ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}` : "Workspace actions"} className="relative grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <MoreVertical aria-hidden="true" size={14} />
              {warnings.length > 0 && <span aria-hidden="true" data-testid="menu-warning-dot" className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--state-needs)]" />}
            </MenuTrigger>
            <MenuPopup align="end" className="w-64">
              {/* A fact, not an action: focusable so arrowing reads it, and it does nothing. */}
              <MenuItem aria-disabled="true" closeOnClick={false} className="flex items-center gap-2 py-1.5 text-xs font-normal text-muted-foreground">
                <FolderGit2 aria-hidden="true" size={12} /> <span>{place}</span>
              </MenuItem>
              {now && !chipFits && <MenuItem onClick={() => navigate(`${base}/plan`)} className="flex items-center gap-2 py-1.5 text-xs">
                <Circle aria-hidden="true" size={12} /> <span className="shrink-0 text-muted-foreground">Now ·</span> <span className="min-w-0 truncate" title={now.title}><InlinePlanMarkdown content={now.title} /></span>
              </MenuItem>}
              {next && <MenuItem onClick={() => navigate(`${base}/plan`)} className="flex items-center gap-2 py-1.5 text-xs">
                <ArrowRight aria-hidden="true" size={12} /> <span className="shrink-0 text-muted-foreground">Next</span> <span className="min-w-0 truncate" title={next.title}><InlinePlanMarkdown content={next.title} /></span>
              </MenuItem>}
              {!next && done && <MenuItem onClick={() => navigate(`${base}/plan`)} className="flex items-center gap-2 py-1.5 text-xs">
                <ListChecks aria-hidden="true" size={12} /> <span className="text-muted-foreground">Checkpoints</span> <span>All done</span>
              </MenuItem>}
              {branchName && <MenuItem onClick={() => void copyBranch()} className="flex items-center gap-2 py-1.5 text-xs sm:hidden">
                {copied ? <Check aria-hidden="true" size={12} className="text-[var(--state-done)]" /> : <Copy aria-hidden="true" size={12} />} <span>{copied ? 'Branch name copied' : 'Copy branch name'}</span>
              </MenuItem>}
              <MenuItem onClick={() => navigate(`${base}/changes`)} className="flex items-center gap-2 py-1.5 text-xs">
                <FileDiff aria-hidden="true" size={12} /> <span className="text-muted-foreground">Changes</span> <span>{changes}</span>
              </MenuItem>
              {warnings.map((warning) => (
                <MenuItem key={warning.id} onClick={() => setShown(warning)} className="flex items-center gap-2 py-1.5 text-xs text-[var(--state-needs)]">
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--state-needs)]" /> <span>{warning.label}</span>
                </MenuItem>
              ))}
              {menuItems && <MenuSeparator />}
              {menuItems}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <WarningDialog warning={shown} onClose={() => setShown(null)} onDismiss={dismiss} />
    </header>
  );
}
