import { useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from '../../lib/api/client.js';
import type { WorkspaceFile } from '../workspace-shell/openRequests.js';
import { MonacoFileViewer } from './adapters/MonacoFileViewer.js';

type ReadResult = { content: string; omitted?: 'binary' | 'too-large' };

/** A workspace file has no Git actions, repository selector or cross-file repository opener. */
export function WorkspaceFileView({ file, requestId, backAction, breadcrumb }: { file: WorkspaceFile; requestId: number; backAction: ReactNode; breadcrumb?: ReactNode }) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; result?: ReadResult; error?: string }>({ key: '' });
  const key = JSON.stringify([file.workspaceId, file.file, requestId, retry]);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<ReadResult>(`/api/workspace/${encodeURIComponent(file.workspaceId)}/files/read?file=${encodeURIComponent(file.file)}`, { signal: controller.signal }).then(
      (result) => { if (!controller.signal.aborted) setState({ key, result }); },
      (error: unknown) => { if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => controller.abort();
  }, [file.workspaceId, file.file, key]);
  const current = state.key === key ? state : undefined;
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-code-view">
    <div role="toolbar" aria-label="Review" className="flex h-12 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-border bg-card px-2 @[34rem]:gap-2 @[34rem]:px-3 select-none">
      {backAction}
      {breadcrumb}
    </div>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-2.5 py-1.5 text-xs">
      <div className="min-w-0 truncate font-medium">{file.file}</div>
      <div className="shrink-0 text-muted-foreground">Workspace · {file.workspaceId} · Read only</div>
    </header>
    {!current && <p className="p-3 text-xs" role="status">Loading workspace file…</p>}
    {current?.error && <div className="p-3 text-xs"><p role="alert">{current.error}</p><button className="mt-2 rounded border px-2 py-1" onClick={() => setRetry((n) => n + 1)}>Retry</button></div>}
    {current?.result?.omitted && <p className="p-3 text-xs" role="status">{current.result.omitted === 'binary' ? 'Binary file: text preview omitted.' : 'File exceeds the 1 MiB preview limit.'}</p>}
    {current?.result && !current.result.omitted && <div className="min-h-0 flex-1"><MonacoFileViewer workspaceId={file.workspaceId} filePath={file.file} content={current.result.content} targetLine={file.line} jumpKey={requestId} /></div>}
  </div>;
}
