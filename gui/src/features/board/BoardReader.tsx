import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Code2,
  Copy,
  Download,
  Eye,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRight,
  SquareArrowOutUpRight,
  Terminal,
  X,
} from 'lucide-react';

import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { Button } from '../../components/ui/button.js';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../../components/ui/menu.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { apiFetch } from '../../lib/api/client.js';
import { cn } from '../../lib/utils.js';
import type { DiffViewMode } from '../changes/types.js';
import type { DocumentPreviewData } from '../work-guidance/DocumentPreview.js';
import { DocumentViewer } from '../work-guidance/DocumentViewer.js';
import { ESCAPE_MESSAGE } from '../work-guidance/previewPolicy.js';
import { ChatMarkdown } from '../../components/ChatMarkdown.js';
import { documentFileUrl, type ReaderTarget } from './boardActions.js';
import { LARGE_WINDOW, type ReaderLayout } from './boardReaderLayout.js';
import { forgeDisplayName, safeForgeUrl, type CommitDetail } from './commitContext.js';
import { CommitReaderView } from './CommitReaderView.js';
import { ReaderPage } from './ReaderPage.js';
import { isCodeWindowOpen } from '../workspace-shell/codeWindowOpen.js';

/** How many frames the reader keeps trying to take the keyboard: something that is closing (a dialog) may hold it back for a moment. */
const FOCUS_FRAMES = 30;

/**
 * A file of the workspace, or a source document, read over the board or beside it, so the board stays in sight: the app's own
 * document viewer (Markdown, HTML in its sandboxed frame, PDFs and pictures, with their downloads). By default it is a large
 * window over the board, about 92% of the section wide and 88% high and centred, with the board dimmed but visible all round
 * it; "Side by side" docks it beside the canvas instead (the viewer's choice, kept by boardReaderLayout), and "Large" brings the
 * window back. A file is read by the request the documents panel makes; a source document by the work route that reads it
 * through the storage port, as the rest of the app does, and not from the folder. Its one quiet header line has the title of what
 * was opened, its path under it, a "More actions" menu (the layout, a new window, the source of a page, copy and download)
 * and Close. It takes the keyboard when it opens, shows something else, or comes to cover the canvas (which then cannot keep it);
 * closing it, with those, with a press outside it (BoardSection) or with Escape (BoardSection; and from the page of an HTML
 * document, whose frame says so), gives the keyboard back to what opened it. An HTML page or a PDF takes all the height of
 * the window, and scrolls on its own.
 * `request` grows with every opening, so opening what is already shown still counts. Nothing of the document is put in the
 * board's own page: the viewer draws it, and HTML stays in its sandboxed frame.
 */
export function BoardReader({
  active = true,
  workspaceId,
  workspacePath,
  target,
  request,
  layout,
  onLayout,
  covers,
  width,
  onClose,
  onOpenFile,
  back,
  trailId = 0,
  onNext,
  onPrevious,
  nextTitle,
  previousTitle,
  indexInfo,
  onAskInCLI,
}: {
  /** Whether the board section is currently active and visible. */
  active?: boolean;
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
  /** A link in the document to another file of the workspace. */
  onOpenFile: (path: string) => void;
  /** Where Back returns to (its name), when the reader followed something from inside itself. */
  back?: { label: string; onBack: () => void };
  /** A monotonic id for the trail: another trail starts clean with its own id. */
  trailId?: number;
  onNext?: () => void;
  onPrevious?: () => void;
  nextTitle?: string;
  previousTitle?: string;
  indexInfo?: { current: number; total: number };
  onAskInCLI?: (context: string) => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  /** What the reader is drawn in, directly in the section's row: the dimmed board behind the window, or nothing when docked. */
  const panel = useRef<HTMLDivElement>(null);
  const large = layout === 'large';
  // The canvas is out of reach, under the reader: in the window, and where the dock covers it.
  const covering = large || covers;
  const { path, source, commit } = target;
  // What is open: a commit, a source document, or a file.
  const open = commit ? `commit:${commit.repo}:${commit.sha}` : source ? `source:${source}` : path;
  const isHtml = !commit && !source && (path.toLowerCase().endsWith('.html') || path.toLowerCase().endsWith('.htm'));
  const [viewLink, setViewLink] = useState<{ open: string; url: string } | null>(null);
  const activeViewUrl = viewLink?.open === open ? viewLink.url : null;
  const handleViewUrlReady = useCallback((url: string) => {
    setViewLink({ open, url });
  }, [open]);

  const preview = useQuery({
    queryKey: ['board-reader', workspaceId, open],
    queryFn: async ({ signal }): Promise<DocumentPreviewData> => {
      const base = `/api/workspace/${encodeURIComponent(workspaceId)}`;
      if (!source) return apiFetch<DocumentPreviewData>(`${base}/documents/preview?name=${encodeURIComponent(path)}`, { signal });
      const read = await apiFetch<{ content?: string }>(`${base}/work/documents/${encodeURIComponent(source)}`, { signal });
      if (read.content === undefined) throw new Error('This source document is a link, not text.');
      return { name: path, kind: 'markdown', content: read.content };
    },
    enabled: !commit && !isHtml,
    retry: false,
  });
  const data = preview.data ?? null;

  const commitQuery = useQuery({
    queryKey: ['board-commit', workspaceId, commit?.repo, commit?.sha],
    queryFn: ({ signal }) =>
      apiFetch<CommitDetail>(
        `/api/workspace/${encodeURIComponent(workspaceId)}/commits/${encodeURIComponent(commit!.repo)}/${encodeURIComponent(commit!.sha)}`,
        { signal },
      ),
    enabled: Boolean(commit),
    retry: false,
  });
  const commitDetail = commitQuery.data ?? null;
  const safeWebUrl = safeForgeUrl(commitDetail?.webUrl);
  const forgeName = forgeDisplayName(commitDetail?.forge, safeWebUrl);

  const [maximized, setMaximized] = useState(false);
  const fullscreenToggleRef = useRef<HTMLButtonElement>(null);
  const pendingFullscreenFocus = useRef(false);
  // What each place of the trail was left as: a commit's open file and diff mode, a page's raw choice, and the scroll. Another trail starts clean.
  const [placeUi, setPlaceUi] = useState<{ trailId: number | undefined; places: Record<string, { file: string | null; mode: DiffViewMode | null; raw: boolean; top?: number }> }>({ trailId, places: {} });
  if (placeUi.trailId !== trailId) setPlaceUi({ trailId, places: {} });
  const place = placeUi.places[open];
  const commitSelectedFile = place?.file ?? null;
  const commitViewMode = place?.mode ?? null;
  const changePlace = useCallback((key: string, change: Partial<{ file: string | null; mode: DiffViewMode | null; raw: boolean; top?: number }>) => {
    setPlaceUi((prev) => ({ ...prev, places: { ...prev.places, [key]: { ...(prev.places[key] ?? { file: null, mode: null, raw: false }), ...change } } }));
  }, []);
  const setCommitSelectedFile = useCallback((file: string | null) => changePlace(open, { file }), [changePlace, open]);
  const setCommitViewMode = useCallback((mode: DiffViewMode | null) => changePlace(open, { mode }), [changePlace, open]);

  // The scroll of each place (the outermost thing that scrolls in the reader's body), put back when the place is shown again
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrolls = useRef(new Map<string, { el: Element; top: number }>());
  // Keyed by the trail too: another trail starts with every place at the top
  const scrollId = `${trailId ?? 0}|${open}`;
  const scrollKey = useRef(scrollId);
  useLayoutEffect(() => { scrollKey.current = scrollId; }, [scrollId]);
  const onBodyScroll = useCallback((event: UIEvent) => {
    const el = event.target;
    if (!(el instanceof Element)) return;
    const known = scrolls.current.get(scrollKey.current);
    if (known && known.el !== el && known.el.isConnected && known.el.contains(el)) return;
    scrolls.current.set(scrollKey.current, { el, top: el.scrollTop });
    // The position itself is kept in the ref above. State only says that this place has been scrolled, once, so scrolling a long page does not draw it again each time.
    const top = el.scrollTop;
    setPlaceUi((prev) => (prev.places[open]?.top !== undefined ? prev : { ...prev, places: { ...prev.places, [open]: { ...(prev.places[open] ?? { file: null, mode: null, raw: false }), top } } }));
  }, [open]);
  useEffect(() => {
    const saved = scrolls.current.get(scrollId);
    const body = bodyRef.current;
    if (!saved || typeof saved.top !== 'number' || saved.top < 0 || !body) return undefined;
    const want = saved.top;
    let frame = 0;
    let tries = 0;
    const find = (): HTMLElement | null => {
      const walk = (node: Element): HTMLElement | null => {
        for (const child of Array.from(node.children)) {
          if (child instanceof HTMLElement && child.scrollHeight > child.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(child).overflowY)) return child;
          const inner = walk(child);
          if (inner) return inner;
        }
        return null;
      };
      return walk(body);
    };
    const stop = () => cancelAnimationFrame(frame);
    const step = () => {
      // Hold the place for a moment while the page settles (a diff loads, its height changes), until the person moves it
      const el = find();
      if (el) el.scrollTop = want;
      if (tries++ < FOCUS_FRAMES) frame = requestAnimationFrame(step);
    };
    body.addEventListener('wheel', stop, { passive: true });
    body.addEventListener('pointerdown', stop);
    body.addEventListener('keydown', stop);
    step();
    return () => { stop(); body.removeEventListener('wheel', stop); body.removeEventListener('pointerdown', stop); body.removeEventListener('keydown', stop); };
  }, [scrollId]);

  const toggleMaximized = useCallback(() => {
    pendingFullscreenFocus.current = true;
    setMaximized((prev) => !prev);
  }, []);

  useLayoutEffect(() => {
    if (pendingFullscreenFocus.current) {
      pendingFullscreenFocus.current = false;
      fullscreenToggleRef.current?.focus({ preventScroll: true });
    }
  }, [maximized]);

  const handleClose = useCallback(() => {
    setMaximized(false);
    onClose();
  }, [onClose]);

  // Rendered or raw is for what is open: another file starts rendered.

  // The card's text is one quiet line; when it has more, "More" opens it (up to a quarter of the reader) and "Less" closes it.
  const noteRef = useRef<HTMLDivElement>(null);
  const [noteOpenFor, setNoteOpenFor] = useState<string | null>(null);
  const [noteLong, setNoteLong] = useState(false);
  const noteKey = `${open}\u0000${target.text ?? ''}`;
  // Open only for the card it was opened on: another card is drawn closed from its first frame.
  const noteOpen = noteOpenFor === noteKey;
  // Closed, the one-line box never keeps a scroll position from when it was open.
  useLayoutEffect(() => { if (!noteOpen && noteRef.current) noteRef.current.scrollTop = 0; }, [noteOpen, noteKey]);
  useLayoutEffect(() => {
    const node = noteRef.current;
    if (!node || noteOpen) return undefined;
    const measure = () => setNoteLong(node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => watch.disconnect();
  }, [noteKey, noteOpen]);
  const raw = place?.raw ?? false;
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
      if (isCodeWindowOpen()) return;
      const frames = panel.current?.querySelectorAll('iframe') ?? [];
      if (Array.from(frames).some((frame) => frame.contentWindow === event.source)) {
        if (maximized) setMaximized(false);
        else if (back) back.onBack();
        else onClose();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onClose, maximized, back]);

  // Escape when maximized: returns back to previous layout (large or side).
  // Escape that closes an open menu popup, find widget, or modal is theirs alone.
  useEffect(() => {
    if (!maximized || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (isCodeWindowOpen()) return;
      if (document.querySelector('[data-slot="menu-popup"], .find-widget.visible, .monaco-menu-container, [role="dialog"]:not([data-board-reader-fullscreen])')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingFullscreenFocus.current = true;
      setMaximized(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [maximized, active]);

  // Keyboard navigation between elements: [ and ] or Alt+ArrowLeft and Alt+ArrowRight
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The Code window over the board has these keys
      if (isCodeWindowOpen()) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          target.closest('.monaco-editor, [role="dialog"]:not([data-board-reader-fullscreen])'))
      ) {
        return;
      }
      if (event.defaultPrevented) return;

      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        if (back) {
          // One step back along the trail
          setMaximized(false);
          back.onBack();
        } else if (onPrevious) {
          // Previous card
          onPrevious();
        }
        // With no trail and no previous card, stay in the app: preventDefault is called and does nothing
      } else if (event.key === '[') {
        if (onPrevious) {
          event.preventDefault();
          onPrevious();
        }
      } else if (event.key === ']' || (event.altKey && event.key === 'ArrowRight')) {
        if (onNext) {
          event.preventDefault();
          onNext();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, onNext, onPrevious, back]);

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
    if (!active) return undefined;
    take();
    return () => cancelAnimationFrame(frame.current);
  }, [active, request, take]);
  // Covering the canvas makes it inert, and the keyboard drops to the page if it was on a card: it goes to the reader. Only then:
  // the keyboard may be somewhere else (the chat, a field), and stays there.
  useEffect(() => {
    const held = document.activeElement;
    const lost = !held || held === document.body || (held.closest('[inert]') !== null && Boolean(panel.current?.parentElement?.contains(held)));
    if (active && covering && lost) take();
  }, [active, covering, take]);

  const kind = data?.kind;
  const canViewSource = isHtml || kind === 'markdown' || kind === 'html';
  // A source document's "path" is its stored name.
  const copyLabel = source ? 'Copy name' : 'Copy path';
  // Said for what was open when it was copied: another card starts without it.
  const [copiedFor, setCopiedFor] = useState<{ open: string; result: 'done' | 'failed' } | null>(null);
  const copiedKey = `${request}:${open}`;
  const copied = copiedFor?.open === copiedKey ? copiedFor.result : null;
  const noun = commit ? 'SHA' : source ? 'name' : 'path';
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyPath = () => {
    const finish = (ok: boolean) => {
      setCopiedFor({ open: copiedKey, result: ok ? 'done' : 'failed' });
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedFor(null), 1500);
    };
    safeCopyToClipboard(path).then(finish, () => finish(false));
  };
  const copySha = () => {
    const shaToCopy = commitDetail?.sha ?? commit!.sha;
    const finish = (ok: boolean) => {
      setCopiedFor({ open: copiedKey, result: ok ? 'done' : 'failed' });
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedFor(null), 1500);
    };
    safeCopyToClipboard(shaToCopy).then(finish, () => finish(false));
  };
  const quiet = 'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent data-[popup-open]:text-foreground';

  const sectionNode = (
    <section
      aria-label="Reader"
      data-board-reader=""
      className={cn(
        '@container flex min-h-0 flex-col bg-background',
        maximized
          ? 'h-full w-full'
          : large
            ? 'z-20 overflow-hidden rounded-xl border border-border shadow-2xl'
            : covers
              ? 'absolute inset-0 z-20 border-border'
              : 'relative z-20 shrink-0 border-l border-border shadow-lg',
      )}
      style={
        maximized
          ? undefined
          : large
            ? { width: `${LARGE_WINDOW.width * 100}%`, height: `${LARGE_WINDOW.height * 100}%` }
            : covers
              ? undefined
              : { width }
      }
    >
      <header
        // With a trail the Back button has a row of its own where the window is narrow (the title would have no room), and the start of the line where it is wide
        className={cn('flex shrink-0 items-center gap-2 border-b border-border pl-3 pr-2 select-none', back ? 'h-auto min-h-12 flex-wrap py-1 @[44rem]:h-12 @[44rem]:flex-nowrap @[44rem]:py-0' : 'h-12')}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button, a, [role="button"], [role="menu"], input')) return;
          toggleMaximized();
        }}
      >
        {back && (
          <div className="order-0 flex basis-full @[44rem]:max-w-[30%] @[44rem]:basis-auto">
          <button
            type="button"
            className="nodrag nopan inline-flex h-6 max-w-full shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 pl-1 pr-2 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Back to ${back.label}`}
            title={`Back to ${back.label} (Esc or Alt+←)`}
            onClick={() => { setMaximized(false); back.onBack(); }}
          >
            <ChevronLeft aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{back.label}</span>
          </button>
          </div>
        )}
        <div className="order-1 min-w-0 flex-1">
          <h2
            ref={title}
            tabIndex={-1}
            className="truncate rounded-sm text-sm font-semibold leading-5 text-foreground cursor-default"
            title={commitDetail?.subject ?? target.title}
          >
            {commitDetail?.subject ?? target.title}
          </h2>
          {commit ? (
            <div className="flex min-w-0 items-center gap-1.5 leading-4">
              <p
                className="truncate font-mono text-xs text-muted-foreground"
                title={`${commit.repo} · ${commitDetail?.shortSha ?? commit.sha.slice(0, 7)}`}
              >
                {`${commit.repo} · ${commitDetail?.shortSha ?? commit.sha.slice(0, 7)}`}
              </p>
              {commitDetail?.pushed && safeWebUrl && forgeName && (
                <a
                  href={safeWebUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open commit on ${forgeName}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  title={`Open commit on ${forgeName}`}
                >
                  <span>{forgeName}</span>
                  <SquareArrowOutUpRight aria-hidden="true" className="size-2.5 opacity-70" />
                </a>
              )}
            </div>
          ) : (
            <p className="truncate font-mono text-[11px] leading-4 text-muted-foreground" title={path}>{path}</p>
          )}
        </div>
        <div className="order-3 flex items-center gap-1">
          {onAskInCLI && (
            <button
              type="button"
              onClick={() => {
                const summary = commitDetail?.subject
                  ? `${commitDetail.shortSha || commit?.sha}: ${commitDetail.subject}`
                  : target.title || path;
                onAskInCLI(summary);
              }}
              className="nodrag nopan inline-flex h-7 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 text-xs font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors cursor-pointer"
              title="Ask about this document in CLI"
            >
              <Terminal className="size-3.5" aria-hidden="true" />
              <span>Ask in CLI</span>
              <span aria-hidden="true">↗</span>
            </button>
          )}
          <Menu>
            <MenuTrigger className={quiet} aria-label="More actions" title="More actions">{copied === 'done' ? <Check aria-hidden="true" className="size-4" /> : copied === 'failed' ? <CircleAlert aria-hidden="true" className="size-4 opacity-70" /> : <MoreHorizontal aria-hidden="true" className="size-4" />}</MenuTrigger>
            <MenuPopup align="end" className="w-56" positionerClassName={maximized ? 'z-[110]' : undefined}>
              {/* Beside the canvas only where there is room for both: where the dock would cover it, it is no better than the window. */}
              {large
                ? !covers && (
                    <MenuItem
                      onClick={() => {
                        if (maximized) {
                          pendingFullscreenFocus.current = true;
                          setMaximized(false);
                        }
                        onLayout('side');
                      }}
                    >
                      <PanelRight aria-hidden="true" />Show beside the board
                    </MenuItem>
                  )
                : (
                    <MenuItem
                      onClick={() => {
                        if (maximized) {
                          pendingFullscreenFocus.current = true;
                          setMaximized(false);
                        }
                        onLayout('large');
                      }}
                    >
                      <Maximize2 aria-hidden="true" />Show large
                    </MenuItem>
                  )}
              {commit ? (
                <>
                  <MenuItem onClick={copySha}><Copy aria-hidden="true" />Copy sha</MenuItem>
                  {commitDetail?.pushed && safeWebUrl && forgeName && (
                    <MenuItem render={<a href={safeWebUrl} target="_blank" rel="noopener noreferrer" />}>
                      <SquareArrowOutUpRight aria-hidden="true" />Open on {forgeName}
                    </MenuItem>
                  )}
                </>
              ) : (
                <>
                  {!source && isHtml && (
                    <MenuItem render={<a href={activeViewUrl ?? `${fileUrl}&open=1`} target="_blank" rel="noopener noreferrer" />}>
                      <SquareArrowOutUpRight aria-hidden="true" />Open in browser
                    </MenuItem>
                  )}
                  {!source && !isHtml && kind === 'html' && (
                    <MenuItem render={<a href={`${fileUrl}&open=1`} target="_blank" rel="noopener noreferrer" />}>
                      <SquareArrowOutUpRight aria-hidden="true" />Open in new window
                    </MenuItem>
                  )}
                  {!source && (isHtml || kind === 'html') && <MenuSeparator />}
                  {canViewSource && (
                    <MenuItem onClick={() => changePlace(open, { raw: !raw })}>
                      {raw ? <Eye aria-hidden="true" /> : <Code2 aria-hidden="true" />}
                      {raw ? 'View page' : 'View source'}
                    </MenuItem>
                  )}
                  <MenuItem onClick={copyPath}><Copy aria-hidden="true" />{copyLabel}</MenuItem>
                  {!source && (
                    <MenuItem
                      render={
                        <a
                          href={isHtml && activeViewUrl ? `${activeViewUrl}?download=1` : `${fileUrl}&download=1`}
                          download={path.split('/').pop()}
                        />
                      }
                    >
                      <Download aria-hidden="true" />Download
                    </MenuItem>
                  )}
                </>
              )}
            </MenuPopup>
          </Menu>
          <span role="status" aria-live="polite" className="sr-only">
            {copied === 'done'
              ? commit
                ? 'SHA copied'
                : `${noun === 'name' ? 'Name' : 'Path'} copied`
              : copied === 'failed'
                ? commit
                  ? 'Could not copy the SHA'
                  : `Could not copy the ${noun}`
                : ''}
          </span>
          <button
            ref={fullscreenToggleRef}
            type="button"
            className={quiet}
            aria-label={maximized ? 'Exit full screen' : 'Full screen'}
            title={maximized ? 'Exit full screen (Esc)' : 'Full screen'}
            aria-pressed={maximized}
            onClick={toggleMaximized}
          >
            {maximized ? (
              <Minimize2 aria-hidden="true" className="size-4" />
            ) : (
              <Maximize2 aria-hidden="true" className="size-4" />
            )}
          </button>
          <button
            type="button"
            className={quiet}
            aria-label="Close"
            title="Close"
            onClick={handleClose}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        {indexInfo && indexInfo.total > 1 && (
          <div className="order-2 flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5" role="group" aria-label="Item navigation">
            <button
              type="button"
              className={cn(quiet, 'size-6 disabled:opacity-30 disabled:pointer-events-none')}
              aria-label={previousTitle ? `Previous: ${previousTitle} ([ or Alt+←])` : 'Previous item ([ or Alt+←])'}
              title={previousTitle ? `Previous: ${previousTitle} ([ or Alt+←])` : 'Previous item ([ or Alt+←])'}
              disabled={!onPrevious}
              onClick={onPrevious}
            >
              <ChevronLeft aria-hidden="true" className="size-3.5" />
            </button>
            <span
              className="px-1.5 font-mono text-[11px] font-medium tabular-nums text-muted-foreground select-none"
              aria-label={`Item ${indexInfo.current} of ${indexInfo.total}`}
            >
              {indexInfo.current} / {indexInfo.total}
            </span>
            <button
              type="button"
              className={cn(quiet, 'size-6 disabled:opacity-30 disabled:pointer-events-none')}
              aria-label={nextTitle ? `Next: ${nextTitle} (] or Alt+→)` : 'Next item (] or Alt+→)'}
              title={nextTitle ? `Next: ${nextTitle} (] or Alt+→)` : 'Next item (] or Alt+→)'}
              disabled={!onNext}
              onClick={onNext}
            >
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        )}
      </header>
      <div ref={bodyRef} onScrollCapture={onBodyScroll} className="min-h-0 flex-1 overflow-hidden">
        {commit ? (
          <CommitReaderView
            key={open}
            workspaceId={workspaceId}
            repo={commit.repo}
            sha={commit.sha}
            query={commitQuery}
            onOpenFile={onOpenFile}
            selectedFile={commitSelectedFile}
            onSelectFile={setCommitSelectedFile}
            diffViewMode={commitViewMode}
            onDiffViewModeChange={setCommitViewMode}
            initialScrollTop={place?.top}
          />
        ) : isHtml ? (
          <ReaderPage
            key={open}
            workspaceId={workspaceId}
            path={path}
            raw={raw}
            onViewUrlReady={handleViewUrlReady}
          />
        ) : (
          <DocumentViewer
            key={open}
            fill
            fillFrame
            chromeless
            title={path}
            preview={data}
            raw={raw}
            fileUrl={fileUrl}
            links={links}
            imageExpanded={maximized}
            onImageClick={toggleMaximized}
            status={<>
              {preview.isPending && <p role="status" className="text-sm text-muted-foreground">Opening document…</p>}
              {preview.isError && <p role="alert" className="text-sm text-destructive">
                {preview.error instanceof Error ? preview.error.message : 'Unable to open document.'}{' '}
                <Button size="sm" variant="outline" onClick={() => void preview.refetch()}>Retry preview</Button>
              </p>}
            </>}
          />
        )}
      </div>
      {!commit && (target.text || target.byline) && <footer aria-label="About this card" className="flex max-h-[25%] shrink-0 flex-wrap items-start gap-x-3 border-t border-border px-3 py-1.5 text-xs leading-5 text-muted-foreground">
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
  );

  if (maximized && typeof document !== 'undefined') {
    return createPortal(
      <div
        ref={panel}
        data-board-reader-fullscreen=""
        role="region"
        aria-label="Fullscreen Reader"
        className="fixed inset-0 z-[100] flex flex-col bg-background animate-fade-in"
      >
        {sectionNode}
      </div>,
      document.body,
    );
  }

  return (
    <div
      ref={panel}
      // The press outside the window that closes it is BoardSection's: it reaches the sidebar and the Area header too.
      className={large ? 'absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-background/50' : 'contents'}
    >
      {sectionNode}
    </div>
  );
}
