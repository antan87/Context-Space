import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ChevronRight, FileImage } from 'lucide-react';
import { apiFetch } from '../../lib/api/client.js';
import { useConfig } from '../../lib/api/queries.js';
import { cn } from '../../lib/utils.js';
import { useElementWidth } from '../../lib/useElementWidth.js';
import { DiffErrorBoundary } from '../changes/DiffErrorBoundary.js';
import { PluggableDiffViewer } from '../changes/PluggableDiffViewer.js';
import { disposeChangesetModelsAfterEditors } from '../changes/utils/changesetModelStore.js';
import { globalChangesetSymbolIndex } from '../changes/utils/changesetSymbolIndex.js';
import { omittedNotice } from '../changes/utils/omittedContent.js';
import type { DiffViewMode } from '../changes/types.js';
import { usePlanFile } from '../plan/planFile.js';
import { agoText } from '../plan/whatsNew.js';
import { documentFileUrl } from './boardActions.js';
import { useBoard } from './boardData.js';
import {
  resolveCommitContext,
  type CommitDetail,
  type CommitFileDiff,
  type CommitFileStatus,
} from './commitContext.js';

const STATUS_WORDS: Partial<Record<CommitFileStatus, string>> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  other: 'changed',
};

export function CommitReaderView({
  workspaceId,
  repo,
  sha,
  query,
  onOpenFile,
}: {
  workspaceId: string;
  repo: string;
  sha: string;
  query: UseQueryResult<CommitDetail, Error>;
  onOpenFile: (path: string) => void;
}) {
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const readerWidth = useElementWidth(containerEl);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [userViewMode, setUserViewMode] = useState<DiffViewMode | null>(null);
  const effectiveViewMode: DiffViewMode = userViewMode ?? (readerWidth >= 760 ? 'side-by-side' : 'unified');
  const configQuery = useConfig();
  const defaultEditor = configQuery.data?.config?.defaultEditor ?? null;
  const baseId = useId();
  const fileButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pendingFocusFileRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!openFilePath || pendingFocusFileRef.current !== openFilePath) return;
    pendingFocusFileRef.current = null;
    const btn = fileButtonRefs.current.get(openFilePath);
    if (btn) {
      btn.focus({ preventScroll: true });
      btn.scrollIntoView({ block: 'nearest' });
    }
  }, [openFilePath]);

  const plan = usePlanFile(workspaceId);
  const board = useBoard(workspaceId, { poll: false });

  const resolvedSha = query.data?.sha || sha;

  // Reset open file when commit sha changes
  const [lastSha, setLastSha] = useState(resolvedSha);
  if (lastSha !== resolvedSha) {
    setLastSha(resolvedSha);
    setOpenFilePath(null);
  }

  const diffQuery = useQuery({
    queryKey: ['board-commit-diff', workspaceId, repo, resolvedSha, openFilePath],
    queryFn: ({ signal }) =>
      apiFetch<CommitFileDiff>(
        `/api/workspace/${encodeURIComponent(workspaceId)}/commits/${encodeURIComponent(repo)}/${encodeURIComponent(resolvedSha)}/diff?file=${encodeURIComponent(openFilePath!)}`,
        { signal },
      ),
    enabled: Boolean(query.data && openFilePath),
    retry: false,
  });

  const diffData = diffQuery.data;
  const diffNotice = diffData
    ? omittedNotice(
        diffData.contentOmitted || diffData.diffOmitted
          ? { content: diffData.contentOmitted, diff: diffData.diffOmitted }
          : undefined,
      )
    : null;

  const mountedDiffRepoName = diffQuery.data ? `commit-${resolvedSha}-${diffQuery.data.repo || repo}` : '';
  const mountedDiffRepoPath = diffQuery.data?.repoPath;
  const hasMountedDiffEditor = Boolean(
    openFilePath &&
      diffQuery.data &&
      !diffQuery.data.diffOmitted &&
      diffQuery.data.contentOmitted !== 'binary' &&
      diffQuery.data.diff,
  );

  useEffect(() => {
    if (!hasMountedDiffEditor || !openFilePath || !mountedDiffRepoName) return;
    const owned = { repoName: mountedDiffRepoName, file: openFilePath, repoPath: mountedDiffRepoPath };
    return () => {
      disposeChangesetModelsAfterEditors([owned]);
      globalChangesetSymbolIndex.removeFile(owned.repoName, owned.file);
    };
  }, [hasMountedDiffEditor, openFilePath, mountedDiffRepoName, mountedDiffRepoPath]);

  if (query.isPending) {
    return <p role="status" className="px-5 py-4 text-sm text-muted-foreground">Opening commit…</p>;
  }

  if (query.isError || !query.data) {
    const errorMessage = query.error instanceof Error ? query.error.message : 'Unable to open commit.';
    return <p role="alert" className="px-5 py-4 text-sm text-destructive">{errorMessage}</p>;
  }

  const detail = query.data;
  const { steps, pictures } = resolveCommitContext({
    repo,
    sha: detail.sha || sha,
    plan: plan.data,
    board: board.data,
  });

  const totalFiles = detail.files.length + detail.moreFiles;
  const timeAgo = agoText(detail.at) || detail.at;

  return (
    <div ref={setContainerEl} className="h-full overflow-y-auto px-5 py-4">
      {/* 1. Quiet byline */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>by {detail.author}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={detail.at} title={detail.at}>
          {timeAgo}
        </time>
        <span aria-hidden="true">·</span>
        <code className="font-mono text-xs text-muted-foreground">{detail.shortSha}</code>
      </div>

      {/* 2. Full commit message */}
      <p className="mt-2 text-base font-semibold leading-6 text-foreground">{detail.subject}</p>
      {Boolean(detail.body) && (
        <div className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground/90">
          {detail.body}
        </div>
      )}

      {/* 3. Plan step and pictures links */}
      {(steps.length > 0 || pictures.length > 0) && (
        <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
          {steps.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">{steps.length === 1 ? 'Step' : 'Steps'}</p>
              <ul className="mt-1 space-y-1">
                {steps.map((step) => {
                  const stepLabel = step.checkpointTitle ? `${step.checkpointTitle} · ${step.text}` : step.text;
                  return (
                    <li key={step.key}>
                      {step.planPath ? (
                        <a
                          href={documentFileUrl(workspaceId, step.planPath)}
                          onClick={(e) => {
                            if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
                              e.preventDefault();
                              onOpenFile(step.planPath!);
                            }
                          }}
                          className="inline-flex items-baseline gap-1.5 rounded-xs text-[13px] leading-5 text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <span>{stepLabel}</span>
                        </a>
                      ) : (
                        <span className="inline-flex items-baseline gap-1.5 text-[13px] leading-5 text-foreground">
                          {stepLabel}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {pictures.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">{pictures.length === 1 ? 'Picture' : 'Pictures'}</p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                {pictures.map((pic) => (
                  <li key={pic.path}>
                    <a
                      href={documentFileUrl(workspaceId, pic.path)}
                      onClick={(e) => {
                        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
                          e.preventDefault();
                          onOpenFile(pic.path);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xs text-[13px] leading-5 text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <FileImage aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                      <span>{pic.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 4. Changed files with +/− */}
      <div className="mt-5 flex items-baseline justify-between gap-3 border-t border-border/60 pt-3">
        <h3 className="text-xs font-medium text-muted-foreground">
          {totalFiles === 0 ? 'No files changed' : `${totalFiles} ${totalFiles === 1 ? 'file' : 'files'} changed`}
        </h3>
        <div className="flex items-center gap-2 font-mono text-xs">
          {detail.additions > 0 && <span className="text-success-foreground">+{detail.additions}</span>}
          {detail.deletions > 0 && <span className="text-destructive-foreground">−{detail.deletions}</span>}
        </div>
      </div>

      {detail.files.length > 0 && (
        <ul aria-label="Changed files" className="mt-2 divide-y divide-border/60 rounded-lg border border-border/60 bg-card">
          {detail.files.map((file, index) => {
            const displayPath = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
            const statusWord = STATUS_WORDS[file.status] ?? null;
            const isBinary = file.additions === null && file.deletions === null;
            const isOpen = openFilePath === file.path;
            const panelId = `${baseId}-file-${index}`;

            return (
              <li key={displayPath} className="overflow-hidden first:rounded-t-lg last:rounded-b-lg">
                <button
                  type="button"
                  ref={(el) => {
                    if (el) fileButtonRefs.current.set(file.path, el);
                    else fileButtonRefs.current.delete(file.path);
                  }}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? panelId : undefined}
                  onClick={() => setOpenFilePath((prev) => (prev === file.path ? null : file.path))}
                  className={cn(
                    'group flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    isOpen && 'bg-muted/30',
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        'size-3.5 shrink-0 text-muted-foreground transition-transform',
                        isOpen ? 'rotate-90 opacity-100' : 'opacity-50 group-hover:opacity-100 group-focus-visible:opacity-100',
                      )}
                    />
                    <code className="min-w-0 truncate font-mono text-xs text-foreground" title={displayPath}>
                      {displayPath}
                    </code>
                    {statusWord && <span className="shrink-0 text-xs text-muted-foreground">{statusWord}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
                    {isBinary ? (
                      <span className="text-muted-foreground">binary</span>
                    ) : (
                      <>
                        {(file.additions ?? 0) > 0 && (
                          <span className="text-success-foreground">+{file.additions}</span>
                        )}
                        {(file.deletions ?? 0) > 0 && (
                          <span className="text-destructive-foreground">−{file.deletions}</span>
                        )}
                      </>
                    )}
                  </span>
                </button>

                {isOpen && (
                  <div
                    id={panelId}
                    role="region"
                    aria-label={`Diff for ${displayPath}`}
                    className="border-t border-border/60 bg-background/50"
                  >
                    {diffQuery.isPending ? (
                      <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
                        Loading diff…
                      </p>
                    ) : diffQuery.isError || !diffQuery.data ? (
                      <p role="alert" className="px-3 py-3 text-xs text-destructive">
                        {diffQuery.error instanceof Error ? diffQuery.error.message : 'Unable to load diff.'}
                      </p>
                    ) : !diffData ? null : (
                      <>
                        {diffNotice && (
                          <p role="note" className="border-b border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                            {diffNotice}
                          </p>
                        )}
                        {diffData.diffOmitted ? null : diffData.contentOmitted === 'binary' ? (
                          <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
                            {diffData.diff.trim() || 'Binary file changed.'}
                          </pre>
                        ) : diffData.diff ? (
                          <div className="px-2 pb-1">
                            <DiffErrorBoundary
                              key={`${repo}/${resolvedSha}/${file.path}`}
                              filePath={file.path}
                              fallbackContent={diffData.diff}
                            >
                              <PluggableDiffViewer
                                filePath={file.path}
                                repoName={mountedDiffRepoName}
                                repoPath={diffData.repoPath}
                                patchText={diffData.diff}
                                fullFileContent={diffData.fileContent}
                                fullOriginalContent={diffData.originalContent}
                                preExtractedSymbols={diffData.symbols}
                                defaultEditor={defaultEditor}
                                viewMode={effectiveViewMode}
                                onToggleViewMode={() =>
                                  setUserViewMode((prev) => {
                                    const current = prev ?? (readerWidth >= 760 ? 'side-by-side' : 'unified');
                                    return current === 'side-by-side' ? 'unified' : 'side-by-side';
                                  })
                                }
                                onPrevFile={
                                  index > 0
                                    ? () => {
                                        const targetPath = detail.files[index - 1]!.path;
                                        pendingFocusFileRef.current = targetPath;
                                        setOpenFilePath(targetPath);
                                      }
                                    : undefined
                                }
                                onNextFile={
                                  index < detail.files.length - 1
                                    ? () => {
                                        const targetPath = detail.files[index + 1]!.path;
                                        pendingFocusFileRef.current = targetPath;
                                        setOpenFilePath(targetPath);
                                      }
                                    : undefined
                                }
                              />
                            </DiffErrorBoundary>
                          </div>
                        ) : (
                          <p className="px-3 py-2.5 text-xs text-muted-foreground">No changed lines in this file.</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {detail.moreFiles > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          +{detail.moreFiles} more {detail.moreFiles === 1 ? 'file' : 'files'} not shown
        </p>
      )}
    </div>
  );
}
