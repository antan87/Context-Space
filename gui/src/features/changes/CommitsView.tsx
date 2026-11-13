import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Copy, GitCommitHorizontal, Loader2, SquareArrowOutUpRight } from 'lucide-react';
import { apiFetch } from '../../lib/api/client.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import { useConfig } from '../../lib/api/queries.js';
import { usePlanFile } from '../plan/planFile.js';
import { agoText, type RecentCommits } from '../plan/whatsNew.js';
import { useBoard } from '../board/boardData.js';
import { forgeDisplayName, resolveCommitContext, safeForgeUrl, type CommitDetail, type CommitFileDiff } from '../board/commitContext.js';
import { treeFileOf, type CommitTreeFile, type useCommitDetail } from './commitData.js';
import { DiffErrorBoundary } from './DiffErrorBoundary.js';
import { PluggableDiffViewer } from './PluggableDiffViewer.js';
import { FileTree, buildCompactedTree, getAllDirectoryPaths } from './FileTree.js';
import { fileTypeGlyph } from './fileTypeGlyph.js';
import { plusMinusText } from './changeSummary.js';
import { disposeChangesetModelsAfterEditors } from './utils/changesetModelStore.js';
import { globalChangesetSymbolIndex } from './utils/changesetSymbolIndex.js';
import { omittedNotice } from './utils/omittedContent.js';
import type { DiffViewMode } from './types.js';
import { composeCommitList, indexInSequence, positionText, sameCommit, type CommitListGroup, type CommitRef, type CommitSequence } from './commitsMode.js';

const statusColour = (type: string) => (type === 'added' ? 'text-emerald-500' : type === 'deleted' ? 'text-destructive' : type === 'renamed' || type === 'copied' ? 'text-sky-400' : 'text-amber-500');
const statusLetter = (type: string) => (type === 'added' ? 'A' : type === 'deleted' ? 'D' : type === 'renamed' ? 'R' : type === 'copied' ? 'C' : 'M');

/** The left side of Commits mode: the files this commit changed, with +/- and status. */
export function CommitsTree({ commit, detail, file, onFile }: {
  commit: CommitRef | null;
  detail: ReturnType<typeof useCommitDetail>;
  file: string | null;
  onFile: (file: string) => void;
}) {
  // Folders the person closed, for this commit only: another commit starts open.
  const identity = commit ? `${commit.repo}\0${commit.sha}` : '';
  const [closed, setClosed] = useState<{ identity: string; folders: ReadonlySet<string> }>({ identity: '', folders: new Set() });
  const data = detail.data;
  const files = useMemo(() => (data?.files ?? []).map(treeFileOf), [data]);
  const root = useMemo(() => buildCompactedTree(files), [files]);
  const folders = useMemo(() => getAllDirectoryPaths(root), [root]);
  const expanded = useMemo(() => {
    const closedHere = closed.identity === identity ? closed.folders : new Set<string>();
    return new Set(folders.filter((folder) => !closedHere.has(folder)));
  }, [folders, closed, identity]);
  const total = (data?.files.length ?? 0) + (data?.moreFiles ?? 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 px-2.5 pb-1 pt-2.5 text-xs text-muted-foreground">
        {detail.isPending ? 'Opening commit…' : data ? <><span data-testid="commit-file-count">{total === 0 ? 'No files changed' : `${total} ${total === 1 ? 'file' : 'files'} changed`}</span>{plusMinusText(data.additions, data.deletions) && <span className="font-mono tabular-nums"> · {plusMinusText(data.additions, data.deletions)}</span>}</> : null}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2 [scrollbar-gutter:stable]">
        {data && files.length > 0 && (
          <FileTree
            label="Files changed in this commit"
            files={files}
            root={root}
            selectedPath={file ?? undefined}
            revealPath={file ?? undefined}
            expandedPaths={expanded}
            onExpandedPathsChange={(next) => setClosed({ identity, folders: new Set(folders.filter((folder) => !next.has(folder))) })}
            onActivateFile={(entry) => onFile(entry.file)}
            renderFile={(entry) => {
              const glyph = fileTypeGlyph(entry.file);
              const Glyph = glyph.icon;
              const type = (entry as CommitTreeFile).type;
              const old = (entry as CommitTreeFile).oldPath;
              const binary = (entry as CommitTreeFile).binary;
              const counts = plusMinusText((entry as CommitTreeFile).additions, (entry as CommitTreeFile).deletions);
              return (
                <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1" title={`${old ? `${old} → ` : ''}${entry.file} · ${type}`}>
                  <Glyph className={cn('size-3.5 shrink-0', glyph.className)} aria-hidden="true" />
                  <span className={cn('truncate', type === 'deleted' && 'line-through opacity-70')}>{entry.file.split('/').at(-1)}</span>
                  <span className="sr-only">{glyph.label}, {type}{old ? `, renamed from ${old}` : ''}</span>
                  {binary ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">binary</span> : counts && (
                    <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground" title={`${(entry as CommitTreeFile).additions ?? 0} added, ${(entry as CommitTreeFile).deletions ?? 0} removed`}>{counts}</span>
                  )}
                  <span aria-hidden="true" title={type} className={cn('shrink-0 font-mono text-[10px] font-semibold', !binary && !counts && 'ml-auto', statusColour(type))}>{statusLetter(type)}</span>
                </span>
              );
            }}
          />
        )}
        {data && data.moreFiles > 0 && <p className="px-2 pt-1 text-xs text-muted-foreground">+{data.moreFiles} more {data.moreFiles === 1 ? 'file' : 'files'} not shown</p>}
        {detail.isPending && <p role="status" className="flex items-center gap-1.5 p-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Opening commit…</p>}
      </div>
    </div>
  );
}

/** The header of a commit: it stays while the files and the diff change under it. */
function CommitHeader({ workspace, commit, detail, sequence, recent, held, onCommit, onStep }: {
  workspace: string;
  commit: CommitRef;
  detail: CommitDetail;
  sequence: CommitSequence | null;
  recent: RecentCommits | undefined;
  held: CommitSequence | null;
  onCommit: (commit: CommitRef) => void;
  onStep: (delta: 1 | -1) => void;
}) {
  const plan = usePlanFile(workspace);
  const board = useBoard(workspace, { poll: false });
  const { steps } = useMemo(() => resolveCommitContext({ repo: commit.repo, sha: detail.sha || commit.sha, plan: plan.data, board: board.data }), [commit.repo, commit.sha, detail.sha, plan.data, board.data]);
  const [bodyOpen, setBodyOpen] = useState<{ identity: string; open: boolean }>({ identity: '', open: false });
  const identity = `${commit.repo}\0${detail.sha}`;
  const open = bodyOpen.identity === identity && bodyOpen.open;
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const webUrl = safeForgeUrl(detail.webUrl);
  const forge = forgeDisplayName(detail.forge, webUrl);
  const ago = agoText(detail.at) || detail.at;
  const position = positionText(sequence, commit);
  const index = indexInSequence(sequence, commit);
  const hasPrevious = Boolean(sequence && index > 0);
  const hasNext = Boolean(sequence && index >= 0 && index < sequence.commits.length - 1);
  const groups: CommitListGroup[] = useMemo(() => composeCommitList(held ?? sequence, recent), [held, sequence, recent]);
  const longBody = detail.body.length > 220 || detail.body.split('\n').length > 3;
  const step = 'inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30';
  return (
    <header data-testid="commit-header" aria-label="Commit" className="max-h-[46%] shrink-0 overflow-y-auto border-b border-border bg-muted/10 px-3 py-2">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <h2 data-testid="commit-subject" className="min-w-[14rem] flex-1 text-sm font-semibold leading-5 text-foreground [overflow-wrap:anywhere]" title={detail.subject}>{detail.subject}</h2>
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Commits">
          <button type="button" className={step} disabled={!hasPrevious} aria-label="Previous commit" aria-keyshortcuts="[" title="Previous commit ([)" onClick={() => onStep(-1)}><ChevronLeft className="size-3.5" aria-hidden="true" /></button>
          {position && <span data-testid="commit-position" className="max-w-56 truncate px-1 text-xs tabular-nums text-muted-foreground" title={position}>{position}</span>}
          <button type="button" className={step} disabled={!hasNext} aria-label="Next commit" aria-keyshortcuts="]" title="Next commit (])" onClick={() => onStep(1)}><ChevronRight className="size-3.5" aria-hidden="true" /></button>
          <Menu>
            <MenuTrigger className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent" aria-label="Choose a commit" title="Choose another commit">
              <GitCommitHorizontal className="size-3.5" aria-hidden="true" />Commits<ChevronDown className="size-3" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-[min(30rem,92vw)] max-h-96" positionerClassName="z-[110]">
              {groups.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No other recent commits.</p>}
              {groups.map((group) => (
                <MenuGroup key={group.label}>
                  <MenuGroupLabel>{group.label}</MenuGroupLabel>
                  {group.commits.map((entry) => {
                    const current = sameCommit(entry, commit);
                    return (
                      <MenuItem key={`${entry.repo}/${entry.sha}`} data-testid="commit-choice" aria-current={current ? 'true' : undefined} onClick={() => onCommit({ repo: entry.repo, sha: entry.sha })}>
                        <code className="shrink-0 font-mono text-xs text-primary">{entry.sha.slice(0, 7)}</code>
                        <span className={cn('min-w-0 flex-1 truncate text-xs', current && 'font-semibold')}>{entry.subject ?? ''}</span>
                        {entry.at && <time dateTime={entry.at} className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{agoText(entry.at)}</time>}
                      </MenuItem>
                    );
                  })}
                </MenuGroup>
              ))}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <span>by {detail.author}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={detail.at} title={detail.at}>{ago}</time>
        <span aria-hidden="true">·</span>
        <button type="button" className="inline-flex h-6 items-center gap-1 rounded px-1 font-mono text-xs hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" title="Copy the full SHA" aria-label={`Copy SHA ${detail.shortSha}`}
          onClick={() => { void safeCopyToClipboard(detail.sha).then((ok) => setCopied(ok ? 'copied' : 'failed'), () => setCopied('failed')); }}>
          {detail.shortSha}<Copy className="size-3" aria-hidden="true" />
        </button>
        {copied && <span role="status" className="text-xs">{copied === 'copied' ? 'SHA copied' : 'Could not copy'}</span>}
        <span aria-hidden="true">·</span>
        <span data-testid="commit-repo">{detail.repo || commit.repo}</span>
        <span aria-hidden="true">·</span>
        <span data-testid="commit-pushed">{detail.pushed ? 'pushed' : 'not pushed'}</span>
        {detail.pushed && webUrl && forge && (
          <a href={webUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open commit on ${forge}`} title={`Open commit on ${forge}`}
            className="inline-flex h-6 items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 text-xs font-medium hover:border-border hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
            {forge}<SquareArrowOutUpRight className="size-2.5 opacity-70" aria-hidden="true" />
          </a>
        )}
      </div>
      {steps.length > 0 && (
        <p data-testid="commit-steps" className="mt-1 text-xs leading-4 text-foreground/90">
          <span className="text-muted-foreground">{steps.length === 1 ? 'Step: ' : 'Steps: '}</span>
          {steps.map((entry) => (entry.checkpointTitle ? `${entry.checkpointTitle} · ${entry.text}` : entry.text)).join(' · ')}
        </p>
      )}
      {detail.body && (
        <div className="mt-1.5">
          <div data-testid="commit-body" className={cn('whitespace-pre-wrap text-[13px] leading-5 text-foreground/90 [overflow-wrap:anywhere]', open ? 'max-h-48 overflow-y-auto' : 'line-clamp-3')}>{detail.body}</div>
          {longBody && (
            <button type="button" aria-expanded={open} className="mt-0.5 inline-flex h-6 items-center rounded px-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setBodyOpen({ identity, open: !open })}>{open ? 'Less' : 'More'}</button>
          )}
        </div>
      )}
    </header>
  );
}

/** The right side of Commits mode: the commit's header, the open file's bar and its diff. */
export function CommitsMain({ workspace, commit, detail, file, ordered, sequence, held, recent, onCommit, onStepCommit, onStepFile, viewMode, onToggleViewMode, fontControls, showToast, recentPending }: {
  workspace: string;
  commit: CommitRef | null;
  detail: ReturnType<typeof useCommitDetail>;
  file: string | null;
  ordered: string[];
  sequence: CommitSequence | null;
  held: CommitSequence | null;
  recent: RecentCommits | undefined;
  onCommit: (commit: CommitRef) => void;
  onStepCommit: (delta: 1 | -1) => void;
  onStepFile: (delta: 1 | -1) => void;
  viewMode: DiffViewMode;
  onToggleViewMode: () => void;
  fontControls: ReactNode;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  recentPending: boolean;
}) {
  const defaultEditor = useConfig().data?.config?.defaultEditor ?? null;
  const data = detail.data;
  const sha = data?.sha || commit?.sha || '';
  const repo = commit?.repo ?? '';
  const diffQuery = useQuery({
    queryKey: ['board-commit-diff', workspace, repo, sha, file],
    queryFn: ({ signal }) => apiFetch<CommitFileDiff>(`/api/workspace/${encodeURIComponent(workspace)}/commits/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/diff?file=${encodeURIComponent(file!)}`, { signal }),
    enabled: Boolean(data && file && commit),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const diff = diffQuery.data;
  const notice = diff ? omittedNotice(diff.contentOmitted || diff.diffOmitted ? { content: diff.contentOmitted, diff: diff.diffOmitted } : undefined) : null;
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

  if (!commit) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <GitCommitHorizontal className="size-8 opacity-35" aria-hidden="true" />
        {recentPending
          ? <p role="status" className="text-xs">Looking for recent commits…</p>
          : <p role="status" className="text-xs">No recent commits in this workspace.</p>}
      </div>
    );
  }
  if (detail.isPending) return <p role="status" className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Opening commit…</p>;
  // A failed fresh read of a commit already shown keeps showing it; the error is for a commit that could not be read at all.
  if (!data) {
    return (
      <p role="alert" className="p-3 text-xs text-destructive">
        {detail.error instanceof Error ? detail.error.message : 'Unable to open the commit.'} <button type="button" className="underline" onClick={() => void detail.refetch()}>Retry</button>
      </p>
    );
  }
  const fileIndex = file ? ordered.indexOf(file) : -1;
  const fileName = file?.split('/').at(-1) ?? '';
  const folder = file ? file.slice(0, file.length - fileName.length) : '';
  const entry = data.files.find((candidate) => candidate.path === file);
  const renamedFrom = entry?.oldPath && entry.oldPath !== entry.path ? entry.oldPath : null;
  return (
    <>
      <CommitHeader workspace={workspace} commit={commit} detail={data} sequence={sequence} recent={recent} held={held} onCommit={onCommit} onStep={onStepCommit} />
      {!file ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
          <p className="text-xs">{data.files.length === 0 ? 'This commit changed no files.' : 'Choose a file to see what this commit changed in it.'}</p>
        </div>
      ) : (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pl-2.5 pr-1">
            <p className="min-w-0 flex-1 truncate text-xs" title={`${renamedFrom ? `${renamedFrom} → ` : ''}${file}`}>
              <span className="text-muted-foreground">{folder}</span><span className="font-medium text-foreground">{fileName}</span>
              {renamedFrom && <span className="text-muted-foreground"> (renamed from {renamedFrom})</span>}
            </p>
            {ordered.length > 1 && (
              <div className="flex shrink-0 items-center">
                <Button size="xs" variant="ghost" className="size-6 p-0" disabled={fileIndex <= 0} aria-label="Previous file" aria-keyshortcuts="Alt+ArrowUp" title="Previous file (Alt+↑)" onClick={() => onStepFile(-1)}><ChevronLeft className="size-3.5" /></Button>
                <span data-testid="commit-file-position" className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">{fileIndex >= 0 ? fileIndex + 1 : '–'} / {ordered.length}</span>
                <Button size="xs" variant="ghost" className="size-6 p-0" disabled={fileIndex === ordered.length - 1} aria-label="Next file" aria-keyshortcuts="Alt+ArrowDown" title="Next file (Alt+↓)" onClick={() => onStepFile(1)}><ChevronRight className="size-3.5" /></Button>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-0.5">{fontControls}</div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {diffQuery.isPending ? (
              <p role="status" className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />Opening {fileName}…</p>
            ) : diffQuery.isError || !diff ? (
              <p role="alert" className="p-3 text-xs text-destructive">
                {diffQuery.error instanceof Error ? diffQuery.error.message : 'Unable to load the diff.'} <button type="button" className="underline" onClick={() => void diffQuery.refetch()}>Retry</button>
              </p>
            ) : (
              <>
                {notice && <p role="note" className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">{notice}</p>}
                {diff.diffOmitted ? null : diff.contentOmitted === 'binary' ? (
                  <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{diff.diff.trim() || 'Binary file changed.'}</pre>
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
        </>
      )}
    </>
  );
}
