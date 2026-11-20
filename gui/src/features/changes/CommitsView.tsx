import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, Copy, GitCommitHorizontal, Loader2, RefreshCw, SquareArrowOutUpRight, StickyNote } from 'lucide-react';
import { Pill, foldSurface, rowSurface } from '../../design/index.js';
import { apiFetch } from '../../lib/api/client.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { useConfig } from '../../lib/api/queries.js';
import { useClockTick } from '../../lib/useClockTick.js';
import { usePlanFile } from '../plan/planFile.js';
import { agoText, type IncomingCommitsReport, type NewsPullRequest } from '../plan/whatsNew.js';
import { useBoard } from '../board/boardData.js';
import { noteAuthorName, noteCountText, notesOfCommit, takeNotesView, useCommitNotes, type CommitNoteEntry } from '../board/commitNotes.js';
import {
  forgeDisplayName,
  resolveCommitContext,
  safeForgeUrl,
  type CommitDetail,
  type CommitDetailFile,
  type CommitFileDiff,
  type CommitStepLink,
} from '../board/commitContext.js';
import type { useCommitDetail } from './commitData.js';
import { DiffErrorBoundary } from './DiffErrorBoundary.js';
import { PluggableDiffViewer } from './PluggableDiffViewer.js';
import { plusMinusText } from './changeSummary.js';
import { disposeChangesetModelsAfterEditors } from './utils/changesetModelStore.js';
import { globalChangesetSymbolIndex } from './utils/changesetSymbolIndex.js';
import { omittedNotice } from './utils/omittedContent.js';
import type { DiffViewMode } from './types.js';
import { commitKey, sameCommit, type CommitRef } from './commitsMode.js';
import {
  ancestorGroupIdsForCommit,
  applyCommitTreeKey,
  commitItemId,
  fileItemId,
  firstDescriptionLine,
  flattenCommitTree,
  formatCommitStepLabel,
  formatPrStateLabel,
  splitFilePath,
  statusCode,
  type CommitRepoGroup,
  type CommitTreeRow,
} from './commitListModel.js';

const PROBLEM_INCOMING_STATES = new Set<IncomingCommitsReport['repos'][number]['state']>([
  'sign-in',
  'offline',
  'error',
  'busy',
]);

const statusColour = (type: string) =>
  type === 'added'
    ? 'text-emerald-500'
    : type === 'deleted'
      ? 'text-destructive'
      : type === 'renamed' || type === 'copied'
        ? 'text-sky-400'
        : 'text-amber-500';

const isBinaryFile = (entry: CommitDetailFile): boolean => entry.additions === null && entry.deletions === null;
const fileCounts = (entry: CommitDetailFile): string => plusMinusText(entry.additions ?? undefined, entry.deletions ?? undefined);

function FileDiffStats({ entry }: { entry: CommitDetailFile }) {
  if (isBinaryFile(entry)) {
    return <span className="shrink-0 text-xs text-muted-foreground">binary</span>;
  }
  const counts = fileCounts(entry);
  if (!counts) return null;
  return <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{counts}</span>;
}

/** The ids of the toggles and rows after `from` in drawn order, then those before it nearest first: where focus goes if `from` disappears. */
function toggleFallbackIds(root: HTMLElement, from: HTMLElement): string[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>('[data-toggle-id],[data-tree-id]'));
  const at = all.indexOf(from);
  if (at < 0) return [];
  const idOf = (el: HTMLElement) => (el.dataset.toggleId ?? el.dataset.treeId)!;
  return [...all.slice(at + 1).map(idOf), ...all.slice(0, at).reverse().map(idOf)];
}

/** Single left-hand tree in Commits mode: commits newest-first with one open commit expanded beneath it. */
export function CommitsList({
  groups,
  commit,
  expanded,
  file,
  revealCommitSeq = 0,
  expandedDetail,
  recentPending,
  prsUnavailable = false,
  incomingReport,
  notes,
  checkingIncoming = false,
  onCheckIncoming,
  returnTo = 'board',
  onSelectCommit,
  onSelectFile,
  onTreeStateChange,
}: {
  groups: readonly CommitRepoGroup[];
  commit: CommitRef | null;
  expanded: CommitRef | null;
  file: string | null;
  revealCommitSeq?: number;
  expandedDetail: ReturnType<typeof useCommitDetail>;
  recentPending: boolean;
  /** The bounded refetches are spent and PR information is still pending: say it is not available instead of "loading". */
  prsUnavailable?: boolean;
  incomingReport?: IncomingCommitsReport;
  /** The notes an AI left on commits; a commit that has some shows how many, after its sha and age. */
  notes?: readonly CommitNoteEntry[];
  checkingIncoming?: boolean;
  onCheckIncoming?: () => void;
  returnTo?: 'board' | 'terminal';
  onSelectCommit: (commit: CommitRef) => void;
  onSelectFile: (commit: CommitRef, filePath: string) => void;
  onTreeStateChange: (next: { commit: CommitRef | null; expanded: CommitRef | null; file: string | null; chosen?: boolean }) => void;
}) {
  const clockNow = useClockTick();
  const checking = Boolean(checkingIncoming);
  const lastFetchAt = useMemo(() => {
    let newest: string | null = null;
    let newestMs = -Infinity;
    for (const repo of incomingReport?.repos ?? []) {
      if (!repo.lastFetchAt) continue;
      const ms = Date.parse(repo.lastFetchAt);
      if (Number.isFinite(ms) && ms > newestMs) {
        newestMs = ms;
        newest = repo.lastFetchAt;
      }
    }
    return newest;
  }, [incomingReport]);
  const statusRepos = useMemo(
    () => (incomingReport?.repos ?? []).filter((repo) => PROBLEM_INCOMING_STATES.has(repo.state) && Boolean(repo.message)),
    [incomingReport],
  );
  const multiRepo = (incomingReport?.repos.length ?? 0) > 1;
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocusId = useRef<string | null>(null);
  const focusedTreeItemRef = useRef<{ el: HTMLElement; id: string } | null>(null);
  const anchorOffsetRef = useRef<{ id: string; top: number } | null>(null);
  const groupMoveScrollRef = useRef<{ scrollTop: number; targetId: string } | null>(null);
  const restoringFocusRef = useRef(false);
  const programmaticScrollTopRef = useRef<number | null>(null);
  const lastCommittedLayoutRef = useRef<{ scrollTop: number; scrollHeight: number }>({
    scrollTop: 0,
    scrollHeight: 0,
  });
  const prevRowsRef = useRef<CommitTreeRow[] | null>(null);
  const scrolledFilesForRef = useRef<string | null>(null);
  const prevScrollStateRef = useRef<{ currentId: string | null; expandedId: string | null; focusTick: number; selectedTargetId: string | null }>({
    currentId: null,
    expandedId: null,
    focusTick: -1,
    selectedTargetId: null,
  });
  const [focusTick, setFocusTick] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const commitSignature = commit ? commitKey(commit) : null;
  const [trackedCommitKey, setTrackedCommitKey] = useState<string | null>(commitSignature);
  const [trackedRevealSeq, setTrackedRevealSeq] = useState(revealCommitSeq);

  if (commitSignature !== trackedCommitKey || revealCommitSeq !== trackedRevealSeq) {
    setTrackedCommitKey(commitSignature);
    setTrackedRevealSeq(revealCommitSeq);
    if (commit) {
      const ancestors = ancestorGroupIdsForCommit(groups, commit);
      if (ancestors.some((id) => collapsedGroups[id])) {
        setCollapsedGroups((prev) => {
          const next = { ...prev };
          for (const id of ancestors) delete next[id];
          return next;
        });
      }
    }
  }

  const toggleCollapsed = (id: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const expandedFiles = useMemo(() => {
    if (!expanded || !expandedDetail.data || !sameCommit(expandedDetail.data, expanded)) return [];
    return expandedDetail.data.files;
  }, [expanded, expandedDetail.data]);

  const rows = useMemo(
    () => flattenCommitTree(groups, expanded, expandedFiles, undefined, collapsedGroups),
    [groups, expanded, expandedFiles, collapsedGroups],
  );

  const selectedTargetId = useMemo(() => {
    if (!commit) return null;
    return file ? fileItemId(commit, file) : commitItemId(commit);
  }, [commit, file]);

  const currentId = useMemo(() => {
    if (!commit) return rows[0]?.id ?? null;
    if (file) {
      const fId = fileItemId(commit, file);
      if (rows.some((r) => r.id === fId)) return fId;
    }
    const cId = commitItemId(commit);
    if (rows.some((r) => r.id === cId)) return cId;
    return rows[0]?.id ?? null;
  }, [commit, file, rows]);

  const expandedId = expanded ? commitItemId(expanded) : null;
  const hasExpandedFiles = Boolean(expandedId && expandedFiles.length > 0);

  const findTreeItem = (root: HTMLElement, targetId: string) =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-tree-id]')).find(
      (el) => el.dataset.treeId === targetId,
    ) ?? null;

  const itemTopInRoot = (root: HTMLElement, el: HTMLElement) =>
    el.getBoundingClientRect().top - root.getBoundingClientRect().top;

  useLayoutEffect(() => {
    const root = treeRef.current;
    if (!root) return;

    const finishLayout = () => {
      const activeEl = focusedTreeItemRef.current;
      if (activeEl && activeEl.el.isConnected && !groupMoveScrollRef.current) {
        anchorOffsetRef.current = { id: activeEl.id, top: itemTopInRoot(root, activeEl.el) };
      }
      lastCommittedLayoutRef.current = { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight };
    };

    const rowsChanged = prevRowsRef.current !== null && prevRowsRef.current !== rows;
    prevRowsRef.current = rows;

    const prev = prevScrollStateRef.current;
    const collapsedSelectionFallback = Boolean(
      selectedTargetId
      && currentId !== selectedTargetId
      && prev.selectedTargetId === selectedTargetId
      && prev.focusTick === focusTick,
    );
    const navChanged =
      (!collapsedSelectionFallback && prev.currentId !== currentId) ||
      prev.expandedId !== expandedId ||
      prev.focusTick !== focusTick;
    if (prev.expandedId !== expandedId) {
      scrolledFilesForRef.current = null;
    }
    prevScrollStateRef.current = { currentId, expandedId, focusTick, selectedTargetId };

    if (pendingFocusId.current) {
      const targetId = pendingFocusId.current;
      pendingFocusId.current = null;
      const el = findTreeItem(root, targetId);
      if (el) {
        const beforeScroll = root.scrollTop;
        el.focus({ preventScroll: true });
        el.scrollIntoView?.({ block: 'nearest' });
        if (root.scrollTop !== beforeScroll) {
          programmaticScrollTopRef.current = root.scrollTop;
        }
        focusedTreeItemRef.current = { el, id: targetId };
        groupMoveScrollRef.current = null;
        if (expandedId && hasExpandedFiles) scrolledFilesForRef.current = expandedId;
        finishLayout();
        return;
      }
    }

    const held = focusedTreeItemRef.current;
    const active = document.activeElement;
    const focusWasLostFromTree = Boolean(
      held
      && !held.el.isConnected
      && (active === null || active === document.body || active === root),
    );
    if (held && !held.el.isConnected) {
      const replacement =
        findTreeItem(root, held.id)
        ?? (currentId ? findTreeItem(root, currentId) : null);
      if (focusWasLostFromTree) {
        restoringFocusRef.current = true;
        try {
          if (replacement) {
            replacement.focus({ preventScroll: true });
            focusedTreeItemRef.current = { el: replacement, id: replacement.dataset.treeId ?? held.id };
          } else {
            root.focus({ preventScroll: true });
          }
        } finally {
          restoringFocusRef.current = false;
        }
      } else if (replacement) {
        focusedTreeItemRef.current = { el: replacement, id: replacement.dataset.treeId ?? held.id };
      } else {
        focusedTreeItemRef.current = null;
      }
    }

    const filesJustAppeared = Boolean(expandedId && hasExpandedFiles && scrolledFilesForRef.current !== expandedId);
    if (filesJustAppeared) scrolledFilesForRef.current = expandedId;

    if ((navChanged || filesJustAppeared) && currentId) {
      const currentEl = findTreeItem(root, currentId);
      const beforeScroll = root.scrollTop;
      currentEl?.scrollIntoView?.({ block: 'nearest' });
      if (root.scrollTop !== beforeScroll) {
        programmaticScrollTopRef.current = root.scrollTop;
      }
      groupMoveScrollRef.current = null;
      finishLayout();
      return;
    }

    // Preserve scroll position when a visible focused item moves groups across a 1-step or 2-step refetch
    const prevLayout = lastCommittedLayoutRef.current;
    const anchor = anchorOffsetRef.current;
    if (
      focusWasLostFromTree
      && !groupMoveScrollRef.current
      && anchor
      && anchor.top >= 0
      && anchor.top <= root.clientHeight
      && held
    ) {
      groupMoveScrollRef.current = { scrollTop: prevLayout.scrollTop, targetId: held.id };
    }

    const pendingMove = groupMoveScrollRef.current;
    if (pendingMove && (focusWasLostFromTree || rowsChanged)) {
      const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
      const targetScroll = Math.max(0, Math.min(maxScroll, pendingMove.scrollTop));
      if (Math.abs(targetScroll - root.scrollTop) > 1) {
        programmaticScrollTopRef.current = targetScroll;
        root.scrollTop = targetScroll;
      } else if (root.scrollTop !== prevLayout.scrollTop) {
        programmaticScrollTopRef.current = root.scrollTop;
      }
      const targetEl = findTreeItem(root, pendingMove.targetId);
      const targetTop = targetEl ? itemTopInRoot(root, targetEl) : -1;
      const fitsScroll = Math.abs(targetScroll - pendingMove.scrollTop) <= 1;
      const inView = Boolean(targetEl && targetTop >= 0 && targetTop < root.clientHeight);
      if (fitsScroll && inView) {
        groupMoveScrollRef.current = null;
      }
    }

    finishLayout();
  }, [currentId, expandedId, hasExpandedFiles, focusTick, rows, selectedTargetId]);

  // A focused group toggle (repository, branch, pull request or section heading) can vanish when a refresh empties its group.
  // Focus then moves to the next toggle or row after it, else the one before it, instead of falling back to the page.
  const focusedToggleRef = useRef<{ el: HTMLElement; id: string; fallbackIds: string[] } | null>(null);
  useLayoutEffect(() => {
    const root = treeRef.current;
    const held = focusedToggleRef.current;
    if (!root || !held) return;
    // While the toggle is there, keep where focus would go in step with the list as drawn (rows open and close around it).
    if (held.el.isConnected) {
      held.fallbackIds = toggleFallbackIds(root, held.el);
      return;
    }
    const active = document.activeElement;
    const focusLost = active === null || active === document.body || active === root;
    const find = (id: string) => Array.from(root.querySelectorAll<HTMLElement>('[data-toggle-id],[data-tree-id]'))
      .find((el) => (el.dataset.toggleId ?? el.dataset.treeId) === id) ?? null;
    const target = [held.id, ...held.fallbackIds].map(find).find((el): el is HTMLElement => el !== null) ?? null;
    if (focusLost && target) {
      restoringFocusRef.current = true;
      try { target.focus({ preventScroll: true }); } finally { restoringFocusRef.current = false; }
      focusedToggleRef.current = target.dataset.toggleId
        ? { el: target, id: target.dataset.toggleId, fallbackIds: toggleFallbackIds(root, target) }
        : null;
    } else if (target?.dataset.toggleId) {
      focusedToggleRef.current = { el: target, id: target.dataset.toggleId, fallbackIds: toggleFallbackIds(root, target) };
    } else {
      focusedToggleRef.current = null;
    }
  });

  const handleTreeFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (restoringFocusRef.current) return;
    const root = treeRef.current;
    const toggle = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-toggle-id]') : null;
    if (root && toggle?.dataset.toggleId) {
      focusedToggleRef.current = { el: toggle, id: toggle.dataset.toggleId, fallbackIds: toggleFallbackIds(root, toggle) };
    } else {
      focusedToggleRef.current = null;
    }
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tree-id]') : null;
    const id = item?.dataset.treeId ?? null;
    if (!root || !item || !id) return;
    focusedTreeItemRef.current = { el: item, id };
    anchorOffsetRef.current = { id, top: itemTopInRoot(root, item) };
    groupMoveScrollRef.current = null;
  };

  const handleTreeBlur = (event: FocusEvent<HTMLDivElement>) => {
    const root = treeRef.current;
    const next = event.relatedTarget;
    if (next instanceof Node && root?.contains(next)) return;
    if (focusedToggleRef.current?.el.isConnected) focusedToggleRef.current = null;
    if (focusedTreeItemRef.current?.el.isConnected) {
      focusedTreeItemRef.current = null;
      anchorOffsetRef.current = null;
      groupMoveScrollRef.current = null;
    }
  };

  const handleTreeScroll = () => {
    const root = treeRef.current;
    if (!root) return;
    if (
      programmaticScrollTopRef.current !== null
      && Math.abs(root.scrollTop - programmaticScrollTopRef.current) <= 1
    ) {
      programmaticScrollTopRef.current = null;
      lastCommittedLayoutRef.current = { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight };
      return;
    }
    programmaticScrollTopRef.current = null;
    groupMoveScrollRef.current = null;
    lastCommittedLayoutRef.current = { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight };
    const focused = focusedTreeItemRef.current;
    if (!focused || !focused.el.isConnected) return;
    anchorOffsetRef.current = { id: focused.id, top: itemTopInRoot(root, focused.el) };
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const targetId =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-tree-id]')?.dataset.treeId ?? null
        : null;
    if (!targetId) return;
    const result = applyCommitTreeKey(
      rows,
      {
        commit,
        expanded,
        file,
        focusId: targetId,
      },
      event.key,
    );
    if (!result.handled) return;
    event.preventDefault();
    event.stopPropagation();
    pendingFocusId.current = result.focusId;
    setFocusTick((t) => t + 1);
    onTreeStateChange({
      commit: result.commit,
      expanded: result.expanded,
      file: result.file,
      chosen: result.chosen,
    });
  };

  const checkedLabel = useMemo(() => {
    if (lastFetchAt) {
      const age = agoText(lastFetchAt, new Date(clockNow));
      return `Checked ${age || 'just now'}`;
    }
    return checking ? 'Checking…' : '';
  }, [lastFetchAt, clockNow, checking]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(onCheckIncoming || checkedLabel || statusRepos.length > 0) && (
        <div className="shrink-0 border-b border-border/70 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {checkedLabel}
            </span>
            {onCheckIncoming && (
              <button
                type="button"
                data-testid="incoming-check-now"
                aria-disabled={checking || undefined}
                onClick={() => {
                  if (!checking) onCheckIncoming();
                }}
                className={cn(
                  'inline-flex min-h-6 shrink-0 items-center gap-1 rounded px-2 text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  checking ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-accent hover:text-foreground',
                )}
              >
                <RefreshCw className={cn('size-3', checking && 'animate-spin')} aria-hidden="true" />
                <span>{checking ? 'Checking…' : 'Check now'}</span>
              </button>
            )}
          </div>
          {statusRepos.map((repo) => (
            <p
              key={repo.repo}
              data-testid="incoming-status"
              className="mt-1 break-words text-xs leading-4 text-muted-foreground"
            >
              {multiRepo ? `${repo.repo}: ${repo.message}` : repo.message}
            </p>
          ))}
        </div>
      )}
      <div
        ref={treeRef}
        role="region"
        aria-label="Commits"
        data-testid="commits-tree-container"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onFocus={handleTreeFocus}
        onBlur={handleTreeBlur}
        onScroll={handleTreeScroll}
        className="min-h-0 flex-1 scroll-pt-9 overflow-y-auto overflow-x-hidden px-1.5 py-2 outline-none [scrollbar-gutter:stable]"
      >
        {groups.length === 0 && recentPending && (
          <p role="status" className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            Looking for recent commits…
          </p>
        )}
        {groups.length === 0 && !recentPending && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No commits in this workspace.</p>
        )}
        {groups.map((repoGroup) => {
          const repoCollapsed = Boolean(collapsedGroups[repoGroup.id]);
          return (
            <div key={repoGroup.id} data-testid="commit-repo-group" className="mb-2 last:mb-0">
              <div className="sticky top-0 z-10 bg-background py-0.5">
                <button
                  type="button"
                  data-testid="commit-repo-toggle"
                  data-toggle-id={repoGroup.id}
                  aria-expanded={!repoCollapsed}
                  onClick={() => toggleCollapsed(repoGroup.id)}
                  className={cn(
                    rowSurface({ now: false, hover: 'hover:bg-accent/50 hover:text-foreground' }),
                    'flex min-h-7 w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-xs font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  {repoCollapsed ? (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span
                    title={repoGroup.repo}
                    className={cn('truncate', repoGroup.remoteRepoLabel ? 'max-w-[60%] shrink-0' : 'min-w-0 flex-1')}
                  >
                    {repoGroup.repo}
                  </span>
                  {repoGroup.remoteRepoLabel && (
                    <span
                      data-testid="commit-repo-remote"
                      title={repoGroup.remoteRepoLabel}
                      className="min-w-0 flex-1 truncate font-normal text-muted-foreground"
                    >
                      {repoGroup.remoteRepoLabel}
                    </span>
                  )}
                </button>
              </div>
              {!repoCollapsed && repoGroup.branches.map((branchGroup) => {
                const branchCollapsed = Boolean(collapsedGroups[branchGroup.id]);
                return (
                  <div key={branchGroup.id} data-testid="commit-branch-group" className="mt-0.5 pl-1.5">
                    <button
                      type="button"
                      data-testid="commit-branch-toggle"
                      data-toggle-id={branchGroup.id}
                      aria-expanded={!branchCollapsed}
                      onClick={() => toggleCollapsed(branchGroup.id)}
                      className={cn(
                        rowSurface({ now: false, hover: 'hover:bg-accent/50 hover:text-foreground' }),
                        'flex min-h-6 w-full min-w-0 items-center gap-1.5 px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      {branchCollapsed ? (
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      {branchGroup.kind === 'local' && branchGroup.branch && branchGroup.base ? (
                        <span className="flex min-w-0 flex-1 items-center" title={branchGroup.label}>
                          <span data-testid="commit-branch-name" className="min-w-0 truncate font-medium text-foreground">
                            {branchGroup.branch}
                          </span>
                          <span data-testid="commit-branch-base" className="shrink-0 whitespace-pre text-muted-foreground">
                            {` → ${branchGroup.base}`}
                          </span>
                        </span>
                      ) : (
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={branchGroup.label}>
                          {branchGroup.label}
                        </span>
                      )}
                    </button>
                    {!branchCollapsed && (
                      <div className="mt-0.5 space-y-1">
                        {branchGroup.statusLabel && (
                          <p className="px-2 text-xs text-muted-foreground">{branchGroup.statusLabel}</p>
                        )}
                        {branchGroup.prsPending && !prsUnavailable && (
                          <p
                            role="status"
                            data-testid="commit-pr-loading"
                            className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-foreground"
                          >
                            <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
                            <span>PR information is loading</span>
                          </p>
                        )}
                        {branchGroup.prsPending && prsUnavailable && (
                          <p role="status" data-testid="commit-pr-unavailable" className="px-2 py-0.5 text-xs text-muted-foreground">
                            PR information is not available right now
                          </p>
                        )}
                        {branchGroup.prsStale && (
                          <p data-testid="commit-pr-stale" className="px-2 py-0.5 text-xs text-muted-foreground">
                            PR information may be out of date
                          </p>
                        )}
                        {branchGroup.sections.map((section) => {
                          const hasHeading = section.kind !== 'direct';
                          const sectionCollapsed = hasHeading && Boolean(collapsedGroups[section.id]);
                          const pr = section.pr;
                          const prStateLabel = pr ? formatPrStateLabel(pr.state) : null;
                          const prStateTone = pr?.state === 'OPEN' ? 'ai' : pr?.state === 'MERGED' ? 'done' : 'neutral';
                          const safePrUrl = safeForgeUrl(pr?.url);
                          const sectionTreeLabel = pr
                            ? `Commits in #${pr.number} ${pr.title}`
                            : section.label
                              ? `${section.label} commits in ${repoGroup.repo}`
                              : `Commits in ${repoGroup.repo} ${branchGroup.label}`;

                          return (
                            <div key={section.id} data-testid={`commit-section-${section.kind}`} className="min-w-0">
                              {section.kind === 'pr' && pr && prStateLabel && (
                                <div
                                  data-testid="commit-pr-heading"
                                  className={cn(foldSurface(false, { hover: false }), 'mb-0.5 flex min-h-7 min-w-0 items-center gap-1 px-1 py-0.5')}
                                >
                                  <button
                                    type="button"
                                    data-testid="commit-pr-toggle"
                                    data-toggle-id={section.id}
                                    aria-expanded={!sectionCollapsed}
                                    aria-label={`Toggle pull request #${pr.number}`}
                                    onClick={() => toggleCollapsed(section.id)}
                                    className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    {sectionCollapsed ? (
                                      <ChevronRight className="size-3.5" aria-hidden="true" />
                                    ) : (
                                      <ChevronDown className="size-3.5" aria-hidden="true" />
                                    )}
                                  </button>
                                  {safePrUrl ? (
                                    <a
                                      href={safePrUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      data-testid="commit-pr-link"
                                      title={`#${pr.number} ${pr.title} (${prStateLabel})`}
                                      className="inline-flex min-h-6 min-w-0 flex-1 items-center gap-1 rounded px-0.5 py-0.5 text-xs leading-4 font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                      <span className="shrink-0 font-mono text-muted-foreground">#{pr.number}</span>
                                      <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">{pr.title}</span>
                                      <Pill tone={prStateTone} className="shrink-0">{prStateLabel}</Pill>
                                    </a>
                                  ) : (
                                    <span
                                      data-testid="commit-pr-badge"
                                      title={`#${pr.number} ${pr.title} (${prStateLabel})`}
                                      className="inline-flex min-h-6 min-w-0 flex-1 items-center gap-1 rounded px-0.5 py-0.5 text-xs leading-4 font-medium text-foreground"
                                    >
                                      <span className="shrink-0 font-mono text-muted-foreground">#{pr.number}</span>
                                      <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">{pr.title}</span>
                                      <Pill tone={prStateTone} className="shrink-0">{prStateLabel}</Pill>
                                    </span>
                                  )}
                                </div>
                              )}
                              {(section.kind === 'unassigned-pr' || section.kind === 'on-base' || section.kind === 'older') && (
                                <button
                                  type="button"
                                  data-testid={
                                    section.kind === 'unassigned-pr'
                                      ? 'commit-unassigned-toggle'
                                      : section.kind === 'on-base'
                                        ? 'commit-on-base-toggle'
                                        : 'commit-older-toggle'
                                  }
                                  data-toggle-id={section.id}
                                  aria-expanded={!sectionCollapsed}
                                  onClick={() => toggleCollapsed(section.id)}
                                  className={cn(
                                    rowSurface({ now: false, hover: 'hover:bg-accent/50 hover:text-foreground' }),
                                    'mb-0.5 flex min-h-6 w-full min-w-0 items-center gap-1.5 px-1.5 py-0.5 text-left text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                  )}
                                >
                                  {sectionCollapsed ? (
                                    <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                                  ) : (
                                    <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                                  )}
                                  <span className="truncate" title={section.label}>{section.label}</span>
                                </button>
                              )}
                              {!sectionCollapsed && (
                                <div role="tree" aria-label={sectionTreeLabel} className="space-y-0.5">
                                  {section.commits.map((entry) => {
                                    const cId = commitItemId(entry);
                                    const isCurrentCommit = Boolean(commit && sameCommit(entry, commit));
                                    const isSelected = isCurrentCommit && file === null;
                                    const isExpanded = Boolean(expanded && sameCommit(entry, expanded));
                                    const shortSha = entry.sha.slice(0, 7);
                                    const age = entry.at ? agoText(entry.at, new Date(clockNow)) : '';
                                    const firstLine = firstDescriptionLine(entry.firstBodyLine);
                                    const noteCount = notes ? notesOfCommit(notes, entry.repo, entry.sha).length : 0;

                                    return (
                                      <div key={commitKey(entry)} className="min-w-0">
                                        <div
                                          role="treeitem"
                                          data-tree-id={cId}
                                          data-testid="commit-tree-item"
                                          aria-level={1}
                                          aria-expanded={isExpanded}
                                          aria-selected={isSelected}
                                          tabIndex={cId === currentId ? 0 : -1}
                                          onClick={() => {
                                            pendingFocusId.current = cId;
                                            setFocusTick((t) => t + 1);
                                            onSelectCommit({ repo: entry.repo, sha: entry.sha });
                                          }}
                                          className={cn(
                                            'flex min-h-7 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                            isSelected
                                              ? 'cur bg-accent text-foreground shadow-[inset_2px_0_0_0_hsl(var(--primary))]'
                                              : isCurrentCommit
                                                ? 'bg-accent/55 text-foreground shadow-[inset_2px_0_0_0_hsl(var(--primary)/0.6)]'
                                                : 'hover:bg-accent/50',
                                          )}
                                        >
                                          <div className="flex min-w-0 items-start gap-1.5">
                                            {isExpanded ? (
                                              <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                            ) : (
                                              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                            )}
                                            <span
                                              className={cn(
                                                'line-clamp-2 min-w-0 flex-1 text-xs leading-4 [overflow-wrap:anywhere]',
                                                isCurrentCommit ? 'font-semibold text-foreground' : 'font-medium text-foreground',
                                              )}
                                              title={entry.subject ?? shortSha}
                                            >
                                              {entry.subject ?? shortSha}
                                            </span>
                                          </div>
                                          <div className="flex min-w-0 flex-wrap items-center gap-x-1 pl-5 text-xs leading-4 text-muted-foreground">
                                            {entry.incoming && entry.author && (
                                              <span className="inline-flex max-w-full min-w-0 items-center gap-x-1">
                                                <span
                                                  data-testid="commit-item-author"
                                                  title={entry.author}
                                                  className="min-w-0 truncate font-medium text-foreground/85"
                                                >
                                                  {entry.author}
                                                </span>
                                                <span aria-hidden="true" className="shrink-0">·</span>
                                              </span>
                                            )}
                                            <code className="font-mono text-xs">{shortSha}</code>
                                            {age && (
                                              <>
                                                <span aria-hidden="true">·</span>
                                                <time dateTime={entry.at} title={entry.at}>{age}</time>
                                              </>
                                            )}
                                            {entry.fileCount !== undefined && (
                                              <>
                                                <span aria-hidden="true">·</span>
                                                <span>
                                                  {entry.fileCount} {entry.fileCount === 1 ? 'file' : 'files'}
                                                </span>
                                              </>
                                            )}
                                            {noteCount > 0 && (
                                              <>
                                                <span aria-hidden="true">·</span>
                                                <span data-testid="commit-item-notes" className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-300">
                                                  <StickyNote className="size-3" aria-hidden="true" />
                                                  {noteCountText(noteCount)}
                                                </span>
                                              </>
                                            )}
                                            {!entry.incoming && entry.pushed === false && (
                                              <>
                                                <span aria-hidden="true">·</span>
                                                <span className="text-warning-foreground">not pushed</span>
                                              </>
                                            )}
                                          </div>
                                          {firstLine && (
                                            <p className="truncate pl-5 text-xs leading-4 text-muted-foreground" title={firstLine}>
                                              {firstLine}
                                            </p>
                                          )}
                                        </div>

                                        {isExpanded && (
                                          <div
                                            role="group"
                                            aria-label={`Files in ${shortSha}`}
                                            className="mt-0.5 mb-1 ml-3 space-y-0.5 border-l border-border/60 pl-1.5"
                                          >
                                            {expandedDetail.isPending && expandedFiles.length === 0 ? (
                                              <p role="status" className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                                                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                                                Opening commit…
                                              </p>
                                            ) : expandedDetail.isError && expandedFiles.length === 0 ? (
                                              <p className="px-2 py-1 text-xs text-muted-foreground">
                                                Files unavailable.
                                              </p>
                                            ) : expandedFiles.length === 0 ? (
                                              <p className="px-2 py-1 text-xs text-muted-foreground">No files changed.</p>
                                            ) : (
                                              expandedFiles.map((fileEntry) => {
                                                const fId = fileItemId(entry, fileEntry.path);
                                                const isFileCurrent = Boolean(isCurrentCommit && file === fileEntry.path);
                                                const { name, dir } = splitFilePath(fileEntry.path);
                                                return (
                                                  <div
                                                    key={fId}
                                                    role="treeitem"
                                                    data-tree-id={fId}
                                                    data-testid="commit-tree-file"
                                                    aria-level={2}
                                                    aria-selected={isFileCurrent}
                                                    tabIndex={fId === currentId ? 0 : -1}
                                                    title={`${fileEntry.oldPath ? `${fileEntry.oldPath} → ` : ''}${fileEntry.path} · ${fileEntry.status}`}
                                                    onClick={() => {
                                                      pendingFocusId.current = fId;
                                                      setFocusTick((t) => t + 1);
                                                      onSelectFile({ repo: entry.repo, sha: entry.sha }, fileEntry.path);
                                                    }}
                                                    className={cn(
                                                      'flex min-h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                                      isFileCurrent ? 'cur bg-accent font-medium text-foreground' : 'text-foreground/90 hover:bg-accent/50',
                                                    )}
                                                  >
                                                    <span
                                                      aria-hidden="true"
                                                      className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', statusColour(fileEntry.status))}
                                                    >
                                                      {statusCode(fileEntry.status)}
                                                    </span>
                                                    <span className={cn('min-w-0 shrink truncate', fileEntry.status === 'deleted' && 'line-through opacity-70')}>
                                                      {name}
                                                    </span>
                                                    {dir ? (
                                                      <span className="min-w-[3ch] flex-1 truncate text-xs text-muted-foreground">{dir}</span>
                                                    ) : (
                                                      <span className="min-w-0 flex-1" aria-hidden="true" />
                                                    )}
                                                    <FileDiffStats entry={fileEntry} />
                                                  </div>
                                                );
                                              })
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div
        data-testid="commit-list-keys"
        className="shrink-0 border-t border-border bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground"
      >
        <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-0.5 leading-4">
          <span><kbd className="font-mono text-xs text-foreground/80">↑↓</kbd> move</span>
          <span><kbd className="font-mono text-xs text-foreground/80">→</kbd> open</span>
          <span><kbd className="font-mono text-xs text-foreground/80">←</kbd> close</span>
          <span><kbd className="font-mono text-xs text-foreground/80">Esc</kbd> back to {returnTo === 'terminal' ? 'Terminal' : 'Board'}</span>
        </span>
      </div>
    </div>
  );
}

/** A note's body as shown: plain text, without its first line when that only repeats the title (the title is made from it). */
function noteBodyText(note: CommitNoteEntry): string {
  const body = note.body.replace(/\r\n?/g, '\n').trim();
  const lines = body.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first >= 0 && lines[first]!.trim() === note.title.trim()) return lines.slice(first + 1).join('\n').trim();
  return body;
}

/** Commit details header + full description + clickable file grid shown when no file is open. */
function CommitOverview({
  workspace,
  commit,
  detail,
  incomingMeta,
  commitMeta,
  headingRef,
  ready,
  onOpenFile,
  onOpenStep,
}: {
  workspace: string;
  commit: CommitRef;
  detail: CommitDetail;
  incomingMeta?: { hostName: string | null; webUrl: string | null } | null;
  commitMeta?: { branch?: string | null; pr?: NewsPullRequest | null } | null;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  /** The detail shown is the settled read of this very commit (not a read under way for another form of its sha). */
  ready: boolean;
  onOpenFile: (file: string) => void;
  onOpenStep?: (step: CommitStepLink) => void;
}) {
  const plan = usePlanFile(workspace);
  const board = useBoard(workspace, { poll: false });
  const { steps } = useMemo(
    () => resolveCommitContext({ repo: commit.repo, sha: detail.sha || commit.sha, plan: plan.data, board: board.data }),
    [commit.repo, commit.sha, detail.sha, plan.data, board.data],
  );
  const formattedSteps = useMemo(
    () => steps.map((raw) => ({ raw, display: formatCommitStepLabel(raw) })),
    [steps],
  );
  const allNotes = useCommitNotes(workspace);
  const notes = useMemo(() => notesOfCommit(allNotes, commit.repo, detail.sha || commit.sha), [allNotes, commit.repo, commit.sha, detail.sha]);
  const notesRef = useRef<HTMLElement>(null);
  const hasNotes = notes.length > 0;
  const notesListRef = useRef<HTMLUListElement>(null);
  const [listOverflows, setListOverflows] = useState(false);
  // A scrolling list is a stop for the keyboard (to scroll it); one that fits is not
  useLayoutEffect(() => {
    const list = notesListRef.current;
    if (!list) { setListOverflows(false); return undefined; }
    const measure = () => setListOverflows(list.scrollHeight > list.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    // Measured a frame later, so a change of size caused by this very measure does not loop
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    observer.observe(list);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [hasNotes, notes]);
  // Review opened from a note marker or the "Notes" line: bring the Notes into view once, without moving focus
  useLayoutEffect(() => {
    if (!ready || !hasNotes || !takeNotesView(commit.repo, detail.sha || commit.sha)) return;
    notesRef.current?.scrollIntoView?.({ block: 'start' });
  }, [ready, hasNotes, commit.repo, commit.sha, detail.sha]);

  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const webUrl = safeForgeUrl(detail.webUrl);
  const forge = forgeDisplayName(detail.forge, webUrl);
  const ago = agoText(detail.at) || detail.at;
  const bodyText = detail.body.trim();
  const totalFiles = detail.files.length + detail.moreFiles;
  const countsText = plusMinusText(detail.additions, detail.deletions);
  const rawBranch = commitMeta?.branch !== undefined ? commitMeta.branch : detail.branch;
  const branchText = rawBranch === null ? 'Detached HEAD' : rawBranch;
  const prMeta = commitMeta?.pr ?? detail.pr ?? null;
  const prStateLabel = prMeta ? formatPrStateLabel(prMeta.state) : null;
  const prStateTone = prMeta?.state === 'OPEN' ? 'ai' : prMeta?.state === 'MERGED' ? 'done' : 'neutral';
  const safePrUrl = safeForgeUrl(prMeta?.url);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-4xl min-w-0">
        <div data-testid="commit-header">
          <header aria-label="Commit">
            <h2
              ref={headingRef}
              tabIndex={-1}
              data-testid="commit-subject"
              className="text-base font-semibold leading-snug text-foreground outline-none [overflow-wrap:anywhere]"
              title={detail.subject}
            >
              {detail.subject}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>by {detail.author}</span>
              <span aria-hidden="true">·</span>
              <time dateTime={detail.at} title={detail.at}>{ago}</time>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="inline-flex h-6 min-w-6 items-center gap-1 rounded px-1.5 font-mono text-xs hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title="Copy the full SHA"
                aria-label={`Copy SHA ${detail.shortSha}`}
                onClick={() => {
                  void safeCopyToClipboard(detail.sha).then(
                    (ok) => setCopied(ok ? 'copied' : 'failed'),
                    () => setCopied('failed'),
                  );
                }}
              >
                <span>{detail.shortSha}</span>
                <Copy className="size-3" aria-hidden="true" />
              </button>
              {copied && <span role="status" className="text-xs">{copied === 'copied' ? 'SHA copied' : 'Could not copy'}</span>}
              <span aria-hidden="true">·</span>
              <span data-testid="commit-repo" className="min-w-0 [overflow-wrap:anywhere]">{detail.repo || commit.repo}</span>
              {branchText && (
                <>
                  <span aria-hidden="true">·</span>
                  <span data-testid="commit-branch" className="min-w-0 [overflow-wrap:anywhere]">{branchText}</span>
                </>
              )}
              {prMeta && prStateLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  {safePrUrl ? (
                    <a
                      href={safePrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="commit-pr-link"
                      title={`#${prMeta.number} ${prMeta.title} (${prStateLabel})`}
                      className="inline-flex min-h-6 items-center gap-1 rounded px-1 text-xs font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span>#{prMeta.number}</span>
                      <Pill tone={prStateTone}>{prStateLabel}</Pill>
                    </a>
                  ) : (
                    <span data-testid="commit-pr-badge" title={prMeta.title} className="inline-flex min-h-6 items-center gap-1 text-xs font-medium text-foreground">
                      <span>#{prMeta.number}</span>
                      <Pill tone={prStateTone}>{prStateLabel}</Pill>
                    </span>
                  )}
                </>
              )}
              <span aria-hidden="true">·</span>
              {incomingMeta ? (
                <>
                  <span data-testid="commit-pushed">
                    {incomingMeta.hostName ? `on ${incomingMeta.hostName}, not in your copy yet` : 'not in your copy yet'}
                  </span>
                  {(safeForgeUrl(incomingMeta.webUrl ?? null) ?? webUrl) && (incomingMeta.hostName ?? forge) && (
                    <a
                      href={(safeForgeUrl(incomingMeta.webUrl ?? null) ?? webUrl)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open on ${incomingMeta.hostName ?? forge}`}
                      title={`Open on ${incomingMeta.hostName ?? forge}`}
                      className="inline-flex h-6 min-w-6 items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 text-xs font-medium text-foreground hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {`Open on ${incomingMeta.hostName ?? forge}`}
                      <SquareArrowOutUpRight className="size-3 opacity-70" aria-hidden="true" />
                    </a>
                  )}
                </>
              ) : (
                <>
                  <span
                    data-testid="commit-pushed"
                    className={detail.pushed ? undefined : 'text-warning-foreground'}
                  >
                    {detail.pushed ? 'pushed' : 'not pushed'}
                  </span>
                  {detail.pushed && webUrl && forge && (
                    <a
                      href={webUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open commit on ${forge}`}
                      title={`Open commit on ${forge}`}
                      className="inline-flex h-6 min-w-6 items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 text-xs font-medium text-foreground hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {forge}
                      <SquareArrowOutUpRight className="size-3 opacity-70" aria-hidden="true" />
                    </a>
                  )}
                </>
              )}
            </div>
            {formattedSteps.length > 0 && (
              <div data-testid="commit-steps" className="mt-2 flex flex-wrap items-center gap-1.5">
                {formattedSteps.map(({ raw, display }) => (
                  <button
                    key={raw.key}
                    type="button"
                    title={display.title}
                    onClick={() => onOpenStep?.(raw)}
                    className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 overflow-hidden rounded-md border border-border/70 bg-muted/40 px-2 text-xs text-foreground transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="shrink-0 text-muted-foreground">Step</span>
                    <span className="shrink-0 text-muted-foreground">·</span>
                    <span className="min-w-0 truncate font-medium">
                      {display.prefix ? `${display.prefix}: ${display.summary}` : display.summary}
                    </span>
                    {display.checkpoint && (
                      <>
                        <span className="shrink-0 text-muted-foreground">·</span>
                        <span className="min-w-0 truncate text-muted-foreground">{display.checkpoint}</span>
                      </>
                    )}
                  </button>
                ))}
              </div>
            )}
          </header>

          {bodyText && (
            <div
              data-testid="commit-body"
              className="mt-4 max-h-[42vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-border/50 bg-muted/20 p-3 text-[13px] leading-relaxed text-foreground/95 [overflow-wrap:anywhere]"
            >
              {bodyText}
            </div>
          )}
        </div>

        {hasNotes && (
          <section ref={notesRef} aria-label="Notes" data-testid="commit-notes" className="mt-4 scroll-mt-2">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-violet-700 dark:text-violet-300">
              <StickyNote className="size-3.5" aria-hidden="true" />
              Notes
              <span className="font-normal text-muted-foreground">· {notes.length}</span>
            </h3>
            <ul
              ref={notesListRef}
              tabIndex={listOverflows ? 0 : undefined}
              aria-label="Notes on this commit, newest first"
              className="max-h-[42vh] space-y-2 overflow-y-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {notes.map((note) => {
                const noteAgo = agoText(note.at) || note.at;
                return (
                  <li key={note.id} data-testid="commit-note" className="rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
                    <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      <span data-testid="commit-note-by" className="font-medium text-foreground/90">{noteAuthorName(note.by)}</span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={note.at} title={note.at}>{noteAgo}</time>
                    </div>
                    <p data-testid="commit-note-title" dir="auto" className="mt-1 text-[13px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{note.title}</p>
                    {noteBodyText(note) && (
                      <div data-testid="commit-note-body" dir="auto" className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/95 [overflow-wrap:anywhere]">{noteBodyText(note)}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section aria-label="Changed files" className="mt-5">
          <h3 data-testid="commit-file-count" className="mb-2 text-xs font-medium text-muted-foreground">
            {totalFiles === 0
              ? 'No files changed'
              : `${totalFiles} ${totalFiles === 1 ? 'file' : 'files'} changed`}
            {countsText && <span className="font-mono tabular-nums"> · {countsText}</span>}
          </h3>
          {detail.files.length > 0 && (
            <div data-testid="commit-files-grid" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {detail.files.map((fileEntry) => {
                const { name, dir } = splitFilePath(fileEntry.path);
                return (
                  <button
                    key={fileEntry.path}
                    type="button"
                    onClick={() => onOpenFile(fileEntry.path)}
                    title={`${fileEntry.oldPath ? `${fileEntry.oldPath} → ` : ''}${fileEntry.path} · ${fileEntry.status}`}
                    className="flex min-h-8 min-w-0 items-center gap-2 rounded-md border border-border/70 bg-card px-2.5 py-1.5 text-left text-xs transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      aria-hidden="true"
                      className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', statusColour(fileEntry.status))}
                    >
                      {statusCode(fileEntry.status)}
                    </span>
                    <span className={cn('max-w-[55%] shrink-0 truncate font-medium text-foreground', fileEntry.status === 'deleted' && 'line-through opacity-70')}>
                      {name}
                    </span>
                    {dir ? (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dir}</span>
                    ) : (
                      <span className="min-w-0 flex-1" aria-hidden="true" />
                    )}
                    <FileDiffStats entry={fileEntry} />
                  </button>
                );
              })}
            </div>
          )}
          {detail.moreFiles > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              +{detail.moreFiles} more {detail.moreFiles === 1 ? 'file' : 'files'} not shown
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/** The right side of Commits mode: either the commit overview (default) or a single file's slim diff view. */
export function CommitsMain({
  workspace,
  commit,
  detail,
  incomingMeta,
  commitMeta,
  file,
  ordered,
  hasNextCommit,
  onOpenFile,
  onSelectCommitView,
  onNextCommit,
  onStepFile,
  onOpenStep,
  viewMode,
  onToggleViewMode,
  fontControls,
  showToast,
  recentPending,
  focusTargetRequest,
}: {
  workspace: string;
  commit: CommitRef | null;
  detail: ReturnType<typeof useCommitDetail>;
  incomingMeta?: { hostName: string | null; webUrl: string | null } | null;
  commitMeta?: { branch?: string | null; pr?: NewsPullRequest | null } | null;
  file: string | null;
  ordered: string[];
  hasNextCommit: boolean;
  onOpenFile: (file: string) => void;
  onSelectCommitView: () => void;
  onNextCommit: () => void;
  onStepFile: (delta: 1 | -1) => void;
  onOpenStep?: (step: CommitStepLink) => void;
  viewMode: DiffViewMode;
  onToggleViewMode: () => void;
  fontControls: ReactNode;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  recentPending: boolean;
  focusTargetRequest?: { target: 'heading' | 'file'; seq: number } | null;
}) {
  const defaultEditor = useConfig().data?.config?.defaultEditor ?? null;
  const data = detail.data;
  const sha = data?.sha || commit?.sha || '';
  const repo = commit?.repo ?? '';

  const commitHeadingRef = useRef<HTMLHeadingElement>(null);
  const diffFileLineRef = useRef<HTMLParagraphElement>(null);
  const prevFooterBtnRef = useRef<HTMLButtonElement>(null);
  const nextFooterBtnRef = useRef<HTMLButtonElement>(null);
  const nextCommitFooterBtnRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<'heading' | 'next-footer' | 'prev-footer' | null>(null);
  const handledFocusSeqRef = useRef(focusTargetRequest?.seq ?? 0);

  const diffQuery = useQuery({
    queryKey: ['board-commit-diff', workspace, repo, sha, file],
    queryFn: ({ signal }) =>
      apiFetch<CommitFileDiff>(
        `/api/workspace/${encodeURIComponent(workspace)}/commits/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/diff?file=${encodeURIComponent(file!)}`,
        { signal },
      ),
    enabled: Boolean(data && file && commit),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const diff = diffQuery.data;
  const notice = diff
    ? omittedNotice(diff.contentOmitted || diff.diffOmitted ? { content: diff.contentOmitted, diff: diff.diffOmitted } : undefined)
    : null;
  const modelRepo = `commit-${sha}-${repo}`;
  const mounted = Boolean(file && diff && !diff.diffOmitted && diff.contentOmitted !== 'binary' && diff.diff);
  useEffect(() => {
    if (!mounted || !file) return undefined;
    const owned = { repoName: modelRepo, file, repoPath: diff?.repoPath };
    return () => {
      disposeChangesetModelsAfterEditors([owned]);
      globalChangesetSymbolIndex.removeFile(owned.repoName, owned.file);
    };
  }, [mounted, file, modelRepo, diff?.repoPath]);

  useLayoutEffect(() => {
    const req = pendingFocusRef.current;
    if (req === 'heading' && !file && data) {
      pendingFocusRef.current = null;
      commitHeadingRef.current?.focus({ preventScroll: true });
      return;
    }
    if (req === 'next-footer' && file) {
      pendingFocusRef.current = null;
      (nextFooterBtnRef.current ?? nextCommitFooterBtnRef.current ?? prevFooterBtnRef.current)?.focus({ preventScroll: true });
      return;
    }
    if (req === 'prev-footer' && file) {
      pendingFocusRef.current = null;
      (prevFooterBtnRef.current ?? nextFooterBtnRef.current ?? nextCommitFooterBtnRef.current)?.focus({ preventScroll: true });
      return;
    }

    if (focusTargetRequest && focusTargetRequest.seq !== handledFocusSeqRef.current) {
      if (!data && !detail.isPending) {
        handledFocusSeqRef.current = focusTargetRequest.seq;
        return;
      }
      if (focusTargetRequest.target === 'heading' && !file && data && commitHeadingRef.current) {
        handledFocusSeqRef.current = focusTargetRequest.seq;
        commitHeadingRef.current.focus({ preventScroll: true });
        return;
      }
      if (focusTargetRequest.target === 'file' && file && data && diffFileLineRef.current) {
        handledFocusSeqRef.current = focusTargetRequest.seq;
        diffFileLineRef.current.focus({ preventScroll: true });
      }
    }
  }, [file, data, sha, detail.isPending, focusTargetRequest]);

  if (!commit) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <GitCommitHorizontal className="size-8 opacity-35" aria-hidden="true" />
        {recentPending ? (
          <p role="status" className="text-xs">Looking for recent commits…</p>
        ) : (
          <p role="status" className="text-xs">No recent commits in this workspace.</p>
        )}
      </div>
    );
  }
  if (detail.isPending && !data) {
    return (
      <p role="status" className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        Opening commit…
      </p>
    );
  }
  // A failed fresh read of a commit already shown keeps showing it; the error is for a commit that could not be read at all.
  if (!data) {
    return (
      <p role="alert" className="p-3 text-xs text-destructive">
        {detail.error instanceof Error ? detail.error.message : 'Unable to open the commit.'}{' '}
        <button type="button" className="inline-flex min-h-6 items-center px-1 underline" onClick={() => void detail.refetch()}>
          Retry
        </button>
      </p>
    );
  }

  if (!file) {
    return (
      <CommitOverview
        workspace={workspace}
        commit={commit}
        detail={data}
        incomingMeta={incomingMeta}
        commitMeta={commitMeta}
        headingRef={commitHeadingRef}
        ready={!detail.isFetching && !detail.isPending}
        onOpenFile={onOpenFile}
        onOpenStep={onOpenStep}
      />
    );
  }

  const fileIndex = ordered.indexOf(file);
  const { name: fileName, dir: fileDir } = splitFilePath(file);
  const entry = data.files.find((candidate) => candidate.path === file);
  const renamedFrom = entry?.oldPath && entry.oldPath !== entry.path ? entry.oldPath : null;
  const prevFile = fileIndex > 0 ? ordered[fileIndex - 1] : undefined;
  const nextFile = fileIndex >= 0 && fileIndex < ordered.length - 1 ? ordered[fileIndex + 1] : undefined;
  const prevFileName = prevFile ? splitFilePath(prevFile).name : undefined;
  const nextFileName = nextFile ? splitFilePath(nextFile).name : undefined;

  return (
    <>
      <div className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/15 px-3 py-1">
        <button
          type="button"
          onClick={() => {
            pendingFocusRef.current = 'heading';
            onSelectCommitView();
          }}
          className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium text-foreground">{data.subject}</span>
          <code className="shrink-0 font-mono text-xs text-muted-foreground">{data.shortSha}</code>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">·</span>
          <span className="shrink-0 text-foreground underline underline-offset-2">Read the description</span>
        </button>
      </div>

      <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border px-3 py-1">
        <span
          aria-hidden="true"
          className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', statusColour(entry?.status ?? 'modified'))}
        >
          {statusCode(entry?.status ?? 'modified')}
        </span>
        <p
          ref={diffFileLineRef}
          tabIndex={-1}
          data-testid="commit-diff-file-line"
          className="min-w-0 flex-1 truncate rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={`${renamedFrom ? `${renamedFrom} → ` : ''}${file}`}
        >
          <span className={cn('font-semibold text-foreground', entry?.status === 'deleted' && 'line-through opacity-70')}>
            {fileName}
          </span>
          {fileDir && <span className="ml-1.5 text-muted-foreground">{fileDir}</span>}
          {renamedFrom && <span className="ml-1.5 text-muted-foreground">(renamed from {renamedFrom})</span>}
        </p>
        {entry && <FileDiffStats entry={entry} />}
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          file {fileIndex >= 0 ? fileIndex + 1 : '–'} of {ordered.length}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">{fontControls}</div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {diffQuery.isPending ? (
          <p role="status" className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            Opening {fileName}…
          </p>
        ) : diffQuery.isError || !diff ? (
          <p role="alert" className="p-3 text-xs text-destructive">
            {diffQuery.error instanceof Error ? diffQuery.error.message : 'Unable to load the diff.'}{' '}
            <button type="button" className="inline-flex min-h-6 items-center px-1 underline" onClick={() => void diffQuery.refetch()}>
              Retry
            </button>
          </p>
        ) : (
          <>
            {notice && (
              <p role="note" className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                {notice}
              </p>
            )}
            {diff.diffOmitted ? null : diff.contentOmitted === 'binary' ? (
              <pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-xs text-muted-foreground">
                {diff.diff.trim() || 'Binary file changed.'}
              </pre>
            ) : diff.diff ? (
              <DiffErrorBoundary key={`${repo}/${sha}/${file}`} filePath={file} fallbackContent={diff.diff}>
                <PluggableDiffViewer
                  filePath={file}
                  repoName={modelRepo}
                  repoPath={diff.repoPath}
                  patchText={diff.diff}
                  fullFileContent={diff.fileContent}
                  fullOriginalContent={diff.originalContent}
                  preExtractedSymbols={diff.symbols}
                  defaultEditor={defaultEditor}
                  viewMode={viewMode}
                  onToggleViewMode={onToggleViewMode}
                  fillContainer
                  showToast={showToast}
                  onNextFile={fileIndex >= 0 && fileIndex < ordered.length - 1 ? () => onStepFile(1) : undefined}
                  onPrevFile={fileIndex > 0 ? () => onStepFile(-1) : undefined}
                />
              </DiffErrorBoundary>
            ) : (
              <p className="p-3 text-xs text-muted-foreground">No changed lines in this file.</p>
            )}
          </>
        )}
      </div>

      {(prevFileName || nextFileName || hasNextCommit) && (
        <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-border bg-muted/10 px-3 py-1.5">
          {prevFileName ? (
            <button
              ref={prevFooterBtnRef}
              type="button"
              onClick={() => {
                pendingFocusRef.current = 'prev-footer';
                onStepFile(-1);
              }}
              className="inline-flex h-7 max-w-[48%] min-w-0 items-center gap-1 rounded-md border border-border/70 bg-background px-2.5 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span aria-hidden="true">←</span>
              <span className="truncate">{prevFileName}</span>
            </button>
          ) : (
            <span />
          )}
          {nextFileName ? (
            <button
              ref={nextFooterBtnRef}
              type="button"
              onClick={() => {
                pendingFocusRef.current = 'next-footer';
                onStepFile(1);
              }}
              className="inline-flex h-7 max-w-[48%] min-w-0 items-center gap-1 rounded-md border border-border/70 bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">Next file: {nextFileName}</span>
              <span aria-hidden="true">→</span>
            </button>
          ) : hasNextCommit ? (
            <button
              ref={nextCommitFooterBtnRef}
              type="button"
              onClick={() => {
                pendingFocusRef.current = 'heading';
                onNextCommit();
              }}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>Next commit</span>
              <span aria-hidden="true">→</span>
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}
