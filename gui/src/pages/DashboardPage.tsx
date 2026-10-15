import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FileDiff, FolderGit2, Plus, RefreshCw } from 'lucide-react';
import type { Feature, WorkspaceStatus } from '../types.js';
import { Button } from '../components/ui/button.js';
import { Spinner } from '../components/ui/spinner.js';
import { repoName } from '../lib/status.js';
import { useWorktreeNavigationState } from '../features/worktrees/worktreeStore.js';
import { WorkspaceChatResume } from '../features/chat/WorkspaceChatResume.js';
import { NeedsYouOverview } from '../features/overview/NeedsYouOverview.js';
import { perfMarkOnce } from '../lib/perfMarks.js';

/** How many workspaces Recent work lists. The rest are in the sidebar. */
const RECENT_MAX = 6;

interface DashboardPageProps {
  workspaces: Feature[];
  workspaceStatuses: Record<string, WorkspaceStatus>;
  workspacesLoading?: boolean;
  checkedWorkspaceCount?: number;
  statusesComplete?: boolean;
  statusesError?: boolean;
  onRetryStatuses?: () => void;
  onOpenWorkspace: (id: string) => void;
  onNewWorkspace: () => void;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

/**
 * The Overview says what needs the developer across every workspace: questions, what waits for their OK, checks
 * that failed, what the AI finished lately, and changes to review. The workspaces themselves are in the sidebar;
 * Recent work lists the few on top of it, each with its saved conversations one click away.
 */
export function DashboardPage({
  workspaces,
  workspaceStatuses,
  workspacesLoading = false,
  checkedWorkspaceCount = 0,
  statusesComplete = false,
  statusesError = false,
  onRetryStatuses,
  onOpenWorkspace,
  onNewWorkspace,
}: DashboardPageProps) {
  // Usable means the overview is on screen; Git status is optional work.
  useEffect(() => {
    if (!workspacesLoading) perfMarkOnce('cs:overview-usable', { workspaces: workspaces.length });
    if (checkedWorkspaceCount > 0) perfMarkOnce('cs:overview-status-first', { checked: checkedWorkspaceCount });
    if (statusesComplete) perfMarkOnce('cs:overview-status-complete', { checked: checkedWorkspaceCount });
  }, [workspacesLoading, workspaces.length, checkedWorkspaceCount, statusesComplete]);

  const { customTitles } = useWorktreeNavigationState();
  const titleOf = (ws: Feature) => customTitles[ws.branchName]?.title || ws.name || ws.description || ws.branchName;
  const titles = Object.fromEntries(workspaces.map((ws) => [ws.branchName, titleOf(ws)]));
  const withChanges = workspaces.filter((ws) => (workspaceStatuses[ws.branchName]?.changedFiles ?? 0) > 0);
  const recent = workspaces.slice(0, RECENT_MAX);

  return (
    <div className="mx-auto max-w-4xl space-y-4 pb-12 animate-fade-in">
      <header className="flex flex-wrap items-center justify-between gap-4 px-1 pt-1">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">What needs you, across your workspaces.</p>
        </div>
        <Button onClick={onNewWorkspace} size="sm" className="gap-1.5 shadow-sm">
          <Plus size={14} /> New workspace
        </Button>
      </header>

      {workspacesLoading ? (
        <div className="rounded-xl border border-border bg-card p-10">
          <Spinner aria-label="Loading workspaces" className="mx-auto size-5 text-primary" />
        </div>
      ) : !workspaces.length ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <FolderGit2 className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No workspaces yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Choose repositories and describe what you want to do.</p>
          <Button onClick={onNewWorkspace} size="sm" className="mt-4">
            <Plus size={14} /> Create workspace
          </Button>
        </div>
      ) : <>
        <NeedsYouOverview workspaceIds={workspaces.map((ws) => ws.branchName)} titles={titles} />

        <section aria-labelledby="review-heading" className="space-y-1.5 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
          <h2 id="review-heading" className="text-base font-semibold text-foreground">Changes to review</h2>
          {statusesError ? <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
            Could not check the workspaces for changes.
            <Button size="xs" variant="outline" onClick={onRetryStatuses}><RefreshCw />Try again</Button>
          </div>
            : !statusesComplete && !withChanges.length ? <p role="status" className="text-sm text-muted-foreground">Checking {checkedWorkspaceCount} of {workspaces.length} workspaces…</p>
              : !withChanges.length ? <p className="text-sm text-muted-foreground">No changes waiting for review.</p>
                : <ul>{withChanges.map((ws) => {
                  const files = workspaceStatuses[ws.branchName]!.changedFiles;
                  return <li key={ws.id}>
                    <Link to={`/workspaces/${encodeURIComponent(ws.branchName)}/changes`} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring">
                      <FileDiff aria-hidden="true" className="size-4 shrink-0 text-[var(--state-needs)]" />
                      <span className="min-w-0 flex-1 truncate">{titleOf(ws)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{files} {files === 1 ? 'file' : 'files'} · Review diffs</span>
                    </Link>
                  </li>;
                })}</ul>}
        </section>

        <section aria-labelledby="recent-heading" className="space-y-2">
          <h2 id="recent-heading" className="px-1 text-base font-semibold text-foreground">Recent work</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {recent.map((ws) => {
              const title = titleOf(ws);
              return (
                <article key={ws.id} aria-label={title} className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-3 shadow-xs">
                  <button type="button" onClick={() => onOpenWorkspace(ws.branchName)} className="min-w-0 rounded text-left focus-visible:outline-2 focus-visible:outline-ring">
                    <h3 className="truncate text-sm font-semibold text-foreground hover:underline" title={title}>{title}</h3>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground" title={ws.repos.map(repoName).join(', ')}>
                      <span className="font-mono">{ws.branchName}</span> · {ws.repos.map(repoName).join(', ')}
                    </p>
                  </button>
                  <div className="mt-2 min-w-0 border-t border-border pt-2">
                    <WorkspaceChatResume workspace={ws.branchName} />
                  </div>
                </article>
              );
            })}
          </div>
          {workspaces.length > RECENT_MAX && <p className="px-1 text-xs text-muted-foreground">The other {workspaces.length - RECENT_MAX} workspaces are in the sidebar.</p>}
        </section>
      </>}
    </div>
  );
}
