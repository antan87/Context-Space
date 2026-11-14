import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, Copy, GitCommitHorizontal, Loader2, SquareArrowOutUpRight } from 'lucide-react';
import { apiFetch } from '../../lib/api/client.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { useConfig } from '../../lib/api/queries.js';
import { usePlanFile } from '../plan/planFile.js';
import { agoText } from '../plan/whatsNew.js';
import { useBoard } from '../board/boardData.js';
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
import { commitKey, sameCommit, type CommitListGroup, type CommitRef } from './commitsMode.js';
import {
  applyCommitTreeKey,
  commitItemId,
  fileItemId,
  firstDescriptionLine,
  flattenCommitTree,
  formatCommitStepLabel,
  splitFilePath,
  statusCode,
} from './commitListModel.js';

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

/** Single left-hand tree in Commits mode: commits newest-first with one open commit expanded beneath it. */
export function CommitsList({
  groups,
  commit,
  expanded,
  file,
  expandedDetail,
  recentPending,
  returnTo = 'board',
  onSelectCommit,
  onSelectFile,
  onTreeStateChange,
}: {
  groups: readonly CommitListGroup[];
  commit: CommitRef | null;
  expanded: CommitRef | null;
  file: string | null;
  expandedDetail: ReturnType<typeof useCommitDetail>;
  recentPending: boolean;
  returnTo?: 'board' | 'terminal';
  onSelectCommit: (commit: CommitRef) => void;
  onSelectFile: (commit: CommitRef, filePath: string) => void;
  onTreeStateChange: (next: { commit: CommitRef | null; expanded: CommitRef | null; file: string | null; chosen?: boolean }) => void;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocusId = useRef<string | null>(null);
  const scrolledFilesForRef = useRef<string | null>(null);
  const prevScrollStateRef = useRef<{ currentId: string | null; expandedId: string | null; focusTick: number }>({
    currentId: null,
    expandedId: null,
    focusTick: -1,
  });
  const [focusTick, setFocusTick] = useState(0);

  const expandedFiles = useMemo(() => {
    if (!expanded || !expandedDetail.data || !sameCommit(expandedDetail.data, expanded)) return [];
    return expandedDetail.data.files;
  }, [expanded, expandedDetail.data]);

  const rows = useMemo(
    () => flattenCommitTree(groups, expanded, expandedFiles),
    [groups, expanded, expandedFiles],
  );

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

  useLayoutEffect(() => {
    const root = treeRef.current;
    if (!root) return;
    const prev = prevScrollStateRef.current;
    const navChanged =
      prev.currentId !== currentId ||
      prev.expandedId !== expandedId ||
      prev.focusTick !== focusTick;
    if (prev.expandedId !== expandedId) {
      scrolledFilesForRef.current = null;
    }
    prevScrollStateRef.current = { currentId, expandedId, focusTick };

    const findById = (targetId: string) =>
      Array.from(root.querySelectorAll<HTMLElement>('[data-tree-id]')).find(
        (el) => el.dataset.treeId === targetId,
      ) ?? null;

    if (pendingFocusId.current) {
      const targetId = pendingFocusId.current;
      pendingFocusId.current = null;
      const el = findById(targetId);
      if (el) {
        el.focus({ preventScroll: true });
        el.scrollIntoView?.({ block: 'nearest' });
        if (expandedId && hasExpandedFiles) scrolledFilesForRef.current = expandedId;
        return;
      }
    }

    const filesJustAppeared = Boolean(expandedId && hasExpandedFiles && scrolledFilesForRef.current !== expandedId);
    if (filesJustAppeared) scrolledFilesForRef.current = expandedId;

    if ((navChanged || filesJustAppeared) && currentId) {
      const currentEl = findById(currentId);
      currentEl?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [currentId, expandedId, hasExpandedFiles, focusTick]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const targetId =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-tree-id]')?.dataset.treeId ?? null
        : null;
    const result = applyCommitTreeKey(
      rows,
      {
        commit,
        expanded,
        file,
        focusId: targetId ?? currentId,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={treeRef}
        role="tree"
        aria-label="Commits"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-2 outline-none [scrollbar-gutter:stable]"
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
        {groups.map((group) => (
          <div key={group.label} className="mb-2 last:mb-0">
            <div
              role="presentation"
              className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground"
            >
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.commits.map((entry) => {
                const cId = commitItemId(entry);
                const isCurrentCommit = Boolean(commit && sameCommit(entry, commit));
                const isSelected = isCurrentCommit && file === null;
                const isExpanded = Boolean(expanded && sameCommit(entry, expanded));
                const shortSha = entry.sha.slice(0, 7);
                const age = entry.at ? agoText(entry.at) : '';
                const firstLine = firstDescriptionLine(entry.firstBodyLine);

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
                      <div className="flex min-w-0 items-center gap-1.5">
                        {isExpanded ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        )}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-xs leading-4',
                            isCurrentCommit ? 'font-semibold text-foreground' : 'font-medium text-foreground',
                          )}
                          title={entry.subject ?? shortSha}
                        >
                          {entry.subject ?? shortSha}
                        </span>
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1 pl-5 text-xs leading-4 text-muted-foreground">
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
                        {entry.pushed === false && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-600 dark:text-amber-400">not pushed</span>
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
          </div>
        ))}
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

/** Commit details header + full description + clickable file grid shown when no file is open. */
function CommitOverview({
  workspace,
  commit,
  detail,
  headingRef,
  onOpenFile,
  onOpenStep,
}: {
  workspace: string;
  commit: CommitRef;
  detail: CommitDetail;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
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
              <span data-testid="commit-repo">{detail.repo || commit.repo}</span>
              <span aria-hidden="true">·</span>
              <span
                data-testid="commit-pushed"
                className={detail.pushed ? undefined : 'text-amber-600 dark:text-amber-400'}
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
        headingRef={commitHeadingRef}
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
