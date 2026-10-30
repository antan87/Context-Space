import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Maximize2, PanelRight, X } from 'lucide-react';

import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { Button } from '../../components/ui/button.js';
import { apiFetch } from '../../lib/api/client.js';
import { cn } from '../../lib/utils.js';
import type { DocumentPreviewData } from '../work-guidance/DocumentPreview.js';
import { DocumentViewer } from '../work-guidance/DocumentViewer.js';
import { ESCAPE_MESSAGE } from '../work-guidance/previewPolicy.js';
import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { documentFileUrl, type ReaderTarget } from './boardActions.js';
import { LARGE_WINDOW, type ReaderLayout } from './boardReaderLayout.js';

/** How many frames the reader keeps trying to take the keyboard: something that is closing (a dialog) may hold it back for a moment. */
const FOCUS_FRAMES = 30;

/**
 * A file of the workspace, or a source document, read over the board or beside it, so the board stays in sight: the app's own
 * document viewer (Markdown, HTML in its sandboxed frame, PDFs and pictures, with their downloads). By default it is a large
 * window over the board, about 92% of the section wide and 88% high and centred, with the board dimmed but visible all round
 * it; "Side by side" docks it beside the canvas instead (the viewer's choice, kept by boardReaderLayout), and "Large" brings the
 * window back. A file is read by the request the documents panel makes; a source document by the work route that reads it
 * through the storage port, as the rest of the app does, and not from the folder. It has the title of what was opened, "Open in
 * Docs" for the full documents panel, and a way back to the board: "Back to board" in the window, Close when docked.
 * It takes the keyboard when it opens, shows something else, or comes to cover the canvas (which then cannot keep it); closing
 * it, with those, with a click on the dimmed board (a press and a release on it both) or with Escape (BoardSection; and from the page
 * of an HTML document, whose frame says so), gives the keyboard back to what opened it. An HTML page or a PDF takes all the height of
 * the window, and scrolls on its own.
 * `request` grows with every opening, so opening what is already shown still counts. Nothing of the document is put in the
 * board's own page: the viewer draws it, and HTML stays in its sandboxed frame.
 */
export function BoardReader({ workspaceId, workspacePath, target, request, layout, onLayout, covers, width, onClose, onOpenInDocs, onOpenFile }: {
  workspaceId: string;
  workspacePath?: string;
  target: ReaderTarget;
  request: number;
  /** A large window over the board, or docked beside it. */
  layout: ReaderLayout;
  onLayout: (layout: ReaderLayout) => void;
  /** The section has no room beside the canvas for a docked reader, which then covers it. (The large window covers the canvas whatever the room.) */
  covers: boolean;
  width: number;
  onClose: () => void;
  onOpenInDocs: (path: string) => void;
  /** A link in the document to another file of the workspace. */
  onOpenFile: (path: string) => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  /** What the reader is drawn in, directly in the section's row: the dimmed board behind the window, or nothing when docked. */
  const panel = useRef<HTMLDivElement>(null);
  const large = layout === 'large';
  // The canvas is out of reach, under the reader: in the window, and where the dock covers it.
  const covering = large || covers;
  /** Where the press that is going on began and ended: only one that did both on the dimmed board is a click on it, not a drag from a text in the window to the board, or from the board into the window. */
  const press = useRef({ down: false, up: false });
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
  // The card's text is one quiet line; when it has more, "More" opens it (up to a quarter of the reader) and "Less" closes it.
  const noteRef = useRef<HTMLDivElement>(null);
  const [noteOpenFor, setNoteOpenFor] = useState<string | null>(null);
  const [noteLong, setNoteLong] = useState(false);
  const noteKey = `${open}\u0000${target.text ?? ''}`;
  // Open only for the card it was opened on: another card is drawn closed from its first frame.
  const noteOpen = noteOpenFor === noteKey;
  // Closed, the one-line box never keeps a scroll position from when it was open.
  useEffect(() => { if (!noteOpen && noteRef.current) noteRef.current.scrollTop = 0; }, [noteOpen, noteKey]);
  useLayoutEffect(() => {
    const node = noteRef.current;
    if (!node || noteOpen) return undefined;
    const measure = () => setNoteLong(node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => watch.disconnect();
  }, [noteKey, noteOpen]);
  const raw = rawOpen === open;
  // A file can be downloaded and shown by the server; a source document is read through the storage port and has neither.
  const fileUrl = source ? '' : documentFileUrl(workspaceId, path);
  const links = useMemo<MarkdownDocumentLinks>(() => ({ workspaceRoot: workspacePath, documentPath: path, fileUrl: (name) => documentFileUrl(workspaceId, name), onOpenFile }), [workspaceId, workspacePath, path, onOpenFile]);

  // The words of the card the file belongs to: their links open files in this reader, by their path from the workspace folder
  const noteLinks = useMemo<MarkdownDocumentLinks>(() => ({ workspaceRoot: workspacePath, fileUrl: (name) => documentFileUrl(workspaceId, name), onOpenFile }), [workspaceId, workspacePath, onOpenFile]);

  // Escape pressed in the page of an HTML document, where the keyboard may be (a key in a frame never reaches this page): its script
  // says so with one fixed message. Only from a frame of this reader: its origin is "null", which says nothing, and a message from
  // anywhere else (the app's own page, another window) is not Escape.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data !== ESCAPE_MESSAGE || !event.source) return;
      const frames = panel.current?.querySelectorAll('iframe') ?? [];
      if (Array.from(frames).some((frame) => frame.contentWindow === event.source)) onClose();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onClose]);

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
    if (covering && lost) take();
  }, [covering, take]);

  return <div
    ref={panel}
    className={large ? 'absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-background/50' : 'contents'}
    onPointerDown={large ? (event) => { press.current = { down: event.target === event.currentTarget, up: false }; } : undefined}
    onPointerUp={large ? (event) => { press.current.up = event.target === event.currentTarget; } : undefined}
    onClick={large ? (event) => {
      const { down, up } = press.current;
      press.current = { down: false, up: false };
      if (down && up && event.target === event.currentTarget) onClose();
    } : undefined}
  >
    <section
      aria-label="Reader"
      className={cn('@container z-20 flex min-h-0 flex-col border-border bg-background',
        large ? 'overflow-hidden rounded-xl border shadow-2xl' : covers ? 'absolute inset-0' : 'relative shrink-0 border-l shadow-lg')}
      style={large ? { width: `${LARGE_WINDOW.width * 100}%`, height: `${LARGE_WINDOW.height * 100}%` } : covers ? undefined : { width }}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {large && <Button size="xs" variant="outline" onClick={onClose}><ArrowLeft aria-hidden="true" />Back to board</Button>}
        <h2 ref={title} tabIndex={-1} className="min-w-0 flex-1 truncate rounded-sm text-sm font-semibold text-foreground" title={target.title}>{target.title}</h2>
        <Button size="xs" variant="outline" onClick={() => onOpenInDocs(path)}><ExternalLink aria-hidden="true" />Open in Docs</Button>
        {/* Beside the canvas only where there is room for both: where the dock would cover it, it is no better than the window. */}
        {large
          ? !covers && <Button size="xs" variant="outline" onClick={() => onLayout('side')}><PanelRight aria-hidden="true" />Side by side</Button>
          : <Button size="xs" variant="outline" onClick={() => onLayout('large')}><Maximize2 aria-hidden="true" />Large</Button>}
        {!large && <Button size="xs" variant="ghost" onClick={onClose}><X aria-hidden="true" />Close</Button>}
      </header>
      <div className="min-h-0 flex-1">
        <DocumentViewer
          key={open}
          fill
          fillFrame
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
      {(target.text || target.byline) && <footer aria-label="About this card" className="flex max-h-[25%] shrink-0 flex-wrap items-start gap-x-3 border-t border-border px-3 py-1.5 text-xs leading-5 text-muted-foreground">
        {target.text && <div
          id="board-reader-note"
          ref={noteRef}
          data-closed={noteOpen ? undefined : ''}
          className={cn('board-text min-w-0 flex-[1_1_100%] break-words @[32.5rem]:flex-[1_1_0%]', noteOpen ? 'max-h-[calc(100%-1.25rem)] self-stretch overflow-auto @[32.5rem]:max-h-full' : 'line-clamp-1 max-h-5 overflow-hidden')}
        ><ChatMarkdown content={target.text} links={noteLinks} onCard cut={!noteOpen && noteLong} /></div>}
        {target.text && (noteLong || noteOpen) && <button
          type="button"
          aria-expanded={noteOpen}
          aria-controls="board-reader-note"
          className="shrink-0 rounded-sm text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setNoteOpenFor(noteOpen ? null : noteKey)}
        >{noteOpen ? 'Less' : 'More'}</button>}
        {target.byline && <p className="ml-auto min-w-0 max-w-[40%] truncate text-[11px]" title={target.byline}>{target.byline}</p>}
      </footer>}
    </section>
  </div>;
}
