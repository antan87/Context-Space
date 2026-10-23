import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, X } from 'lucide-react';

import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { Button } from '../../components/ui/button.js';
import { apiFetch } from '../../lib/api/client.js';
import { cn } from '../../lib/utils.js';
import type { DocumentPreviewData } from '../work-guidance/DocumentPreview.js';
import { DocumentViewer } from '../work-guidance/DocumentViewer.js';
import { documentFileUrl, type ReaderTarget } from './boardActions.js';

/** How many frames the reader keeps trying to take the keyboard: something that is closing (a dialog) may hold it back for a moment. */
const FOCUS_FRAMES = 30;

/**
 * A file of the workspace, or a source document, read beside the board so the board stays in sight: the app's own document
 * viewer (Markdown, HTML in its sandboxed frame, PDFs and pictures, with their downloads). A file is read by the request the
 * documents panel makes; a source document by the work route that reads it through the storage port, as the rest of the app
 * does, and not from the folder. It has the title of what was opened, Close, and "Open in Docs" for the full documents panel.
 * It takes the keyboard when it opens, shows something else, or comes to cover the canvas (which then cannot keep it); closing
 * it, with Close or Escape (BoardSection), gives the keyboard back to what opened it. `request` grows with every opening, so
 * opening what is already shown still counts. Nothing of the document is put in the board's own page: the viewer draws it,
 * and HTML stays in its sandboxed frame.
 */
export function BoardReader({ workspaceId, workspacePath, target, request, covers, width, onClose, onOpenInDocs, onOpenFile }: {
  workspaceId: string;
  workspacePath?: string;
  target: ReaderTarget;
  request: number;
  /** The section has no room beside the canvas: the reader covers it. */
  covers: boolean;
  width: number;
  onClose: () => void;
  onOpenInDocs: (path: string) => void;
  /** A link in the document to another file of the workspace. */
  onOpenFile: (path: string) => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const { path, source } = target;
  // What is open: a source document or a file.
  const open = source ? `source:${source}` : path;

  const preview = useQuery({
    queryKey: ['board-reader', workspaceId, open],
    queryFn: async ({ signal }): Promise<DocumentPreviewData> => {
      const base = `/api/workspace/${encodeURIComponent(workspaceId)}`;
      if (!source) return apiFetch<DocumentPreviewData>(`${base}/documents/preview?name=${encodeURIComponent(path)}`, { signal });
      const read = await apiFetch<{ content?: string }>(`${base}/work/documents/${encodeURIComponent(source)}`, { signal });
      if (read.content === undefined) throw new Error('This source document is a link, not text.');
      return { name: path, kind: 'markdown', content: read.content };
    },
    retry: false,
  });
  const data = preview.data ?? null;
  // Rendered or raw is for what is open: another file starts rendered.
  const [rawOpen, setRawOpen] = useState<string | null>(null);
  const raw = rawOpen === open;
  // A file can be downloaded and shown by the server; a source document is read through the storage port and has neither.
  const fileUrl = source ? '' : documentFileUrl(workspaceId, path);
  const links = useMemo<MarkdownDocumentLinks>(() => ({ workspaceRoot: workspacePath, documentPath: path, fileUrl: (name) => documentFileUrl(workspaceId, name), onOpenFile }), [workspaceId, workspacePath, path, onOpenFile]);

  const frame = useRef(0);
  const take = useCallback(() => {
    cancelAnimationFrame(frame.current);
    let tries = 0;
    const step = () => {
      title.current?.focus({ preventScroll: true });
      if (document.activeElement !== title.current && tries++ < FOCUS_FRAMES) frame.current = requestAnimationFrame(step);
    };
    step();
  }, []);
  useEffect(() => {
    take();
    return () => cancelAnimationFrame(frame.current);
  }, [request, take]);
  // Covering the canvas makes it inert, and the keyboard drops to the page if it was on a card: it goes to the reader. Only then:
  // the keyboard may be somewhere else (the chat, a field), and stays there.
  useEffect(() => {
    const held = document.activeElement;
    const lost = !held || held === document.body || (held.closest('[inert]') !== null && Boolean(panel.current?.parentElement?.contains(held)));
    if (covers && lost) take();
  }, [covers, take]);

  return <section
    ref={panel} aria-label="Reader"
    className={cn('z-20 flex min-h-0 flex-col border-border bg-background', covers ? 'absolute inset-0' : 'relative shrink-0 border-l shadow-lg')}
    style={covers ? undefined : { width }}
  >
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
      <h2 ref={title} tabIndex={-1} className="min-w-0 flex-1 truncate rounded-sm text-sm font-semibold text-foreground" title={target.title}>{target.title}</h2>
      <Button size="xs" variant="outline" onClick={() => onOpenInDocs(path)}><ExternalLink aria-hidden="true" />Open in Docs</Button>
      <Button size="xs" variant="ghost" onClick={onClose}><X aria-hidden="true" />Close</Button>
    </header>
    <div className="min-h-0 flex-1">
      <DocumentViewer
        key={open}
        fill
        title={path}
        preview={data}
        raw={raw}
        onToggleRaw={data?.kind === 'markdown' || data?.kind === 'html' ? () => setRawOpen(raw ? null : open) : undefined}
        downloadHref={source ? undefined : `${fileUrl}&download=1`}
        browserHref={!source && data?.kind === 'html' ? `${fileUrl}&open=1` : undefined}
        fileUrl={fileUrl}
        links={links}
        status={<>
          {preview.isPending && <p role="status" className="text-sm text-muted-foreground">Opening document…</p>}
          {preview.isError && <p role="alert" className="text-sm text-destructive">
            {preview.error instanceof Error ? preview.error.message : 'Unable to open document.'}{' '}
            <Button size="sm" variant="outline" onClick={() => void preview.refetch()}>Retry preview</Button>
          </p>}
        </>}
      />
    </div>
  </section>;
}
