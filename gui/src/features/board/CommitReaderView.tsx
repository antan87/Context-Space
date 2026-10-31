import type { UseQueryResult } from '@tanstack/react-query';
import { FileImage } from 'lucide-react';
import { usePlanFile } from '../plan/planFile.js';
import { agoText } from '../plan/whatsNew.js';
import { documentFileUrl } from './boardActions.js';
import { useBoard } from './boardData.js';
import {
  resolveCommitContext,
  type CommitDetail,
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
  const plan = usePlanFile(workspaceId);
  const board = useBoard(workspaceId, { poll: false });

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
    <div className="h-full overflow-y-auto px-5 py-4">
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
          {detail.files.map((file) => {
            const displayPath = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
            const statusWord = STATUS_WORDS[file.status] ?? null;
            const isBinary = file.additions === null && file.deletions === null;

            return (
              <li key={displayPath} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <code className="min-w-0 truncate font-mono text-xs text-foreground" title={displayPath}>
                    {displayPath}
                  </code>
                  {statusWord && <span className="shrink-0 text-xs text-muted-foreground">{statusWord}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
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
                </div>
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
