import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FileImage, Folder, Search, Terminal, X } from 'lucide-react';
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  IconButton,
  Input,
  KindLabel,
  Spinner,
} from '../../design/index.js';
import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { isTypingTarget } from '../../app/typingTarget.js';
import { apiFetch } from '../../lib/api/client.js';
import { useClockTick } from '../../lib/useClockTick.js';
import { usePageVisible } from '../../lib/usePageVisible.js';
import { cn } from '../../lib/utils.js';
import { askCard, type AskLine } from '../board/askText.js';
import { documentFileUrl } from '../board/boardActions.js';
import { agoText } from '../plan/whatsNew.js';
import { useFeedConnected } from '../progress/useScreenFeed.js';
import { DocumentPreview, type DocumentPreviewData } from '../work-guidance/DocumentPreview.js';
import { DocumentViewer } from '../work-guidance/DocumentViewer.js';
import { ESCAPE_MESSAGE } from '../work-guidance/previewPolicy.js';
import { isCodeWindowOpen } from '../workspace-shell/codeWindowOpen.js';
import {
  buildBreadcrumbs,
  changedLatelyItems,
  childFolders,
  cleanDocumentCatalog,
  directEvidenceSummary,
  documentCatalogKey,
  folderItems,
  formatFileSize,
  formatFolderCounts,
  inferKindFromPath,
  isFolderEvidence,
  kindLabelFor,
  normalizeCatalogPath,
  searchCatalog,
  type DocumentCatalog,
  type DocumentCatalogFolder,
  type DocumentCatalogItem,
  type DocumentCatalogKind,
} from './documentsCatalog.js';

export interface DocumentsPageProps {
  workspaceId: string;
  workspacePath?: string;
  active: boolean;
  panelActions?: ReactNode;
  readOnly?: boolean;
  askInCLI?: (context: string | AskLine) => void;
}

const CARD_SURFACE =
  'rounded-card border border-border bg-card text-left transition-all duration-120 hover:border-border-hover hover:shadow-card-hover focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-1 cursor-pointer';

function isElementVisible(el: Element | null): el is HTMLElement {
  return Boolean(
    el instanceof HTMLElement
    && el.isConnected
    && !el.closest('[inert], [hidden]')
    && el.getClientRects().length > 0,
  );
}

function hasVisibleOverlay(): boolean {
  return Array.from(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="menu-popup"], [data-slot="popover-popup"]'),
  ).some(isElementVisible);
}

/** Pure visual page skeleton bars so no text smaller than 12 px ever exists inside the card thumbnail. */
function DocMiniThumbnail({ kind }: { kind: DocumentCatalogKind }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-16 w-20 shrink-0 flex-col justify-between rounded-md border border-border bg-muted/50 p-2"
    >
      <div className="space-y-1.5">
        <div
          className={cn(
            'h-1.5 rounded-full',
            kind === 'html' ? 'w-11 bg-primary/50' : kind === 'pdf' ? 'w-9 bg-destructive/45' : 'w-12 bg-foreground/25',
          )}
        />
        <div className="h-1 w-full rounded-full bg-muted-foreground/25" />
        <div className="h-1 w-4/5 rounded-full bg-muted-foreground/20" />
        <div className="h-1 w-3/5 rounded-full bg-muted-foreground/20" />
      </div>
      <div className="flex items-center justify-between">
        <div className="h-1 w-5 rounded-full bg-muted-foreground/25" />
        <div className="size-1.5 rounded-full bg-border-hover" />
      </div>
    </div>
  );
}

export function DocumentsPage({
  workspaceId,
  workspacePath,
  active,
  panelActions,
  readOnly = false,
  askInCLI,
}: DocumentsPageProps) {
  const queryClient = useQueryClient();
  const visible = usePageVisible();
  const listening = Boolean(workspaceId) && active && visible;
  useFeedConnected(workspaceId, listening);
  const clockNow = useClockTick();
  const nowDate = useMemo(() => new Date(clockNow), [clockNow]);

  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [readerPath, setReaderPath] = useState<string | null>(null);
  const [readerRaw, setReaderRaw] = useState(false);
  const [readerRequest, setReaderRequest] = useState(0);
  const [showEvidence, setShowEvidence] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());
  const [isWide, setIsWide] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const readerOpenerRef = useRef<HTMLElement | null>(null);
  const readerOpenerKindRef = useRef<'open-button' | 'card' | null>(null);
  const readerOpenedPathRef = useRef<string | null>(null);
  const lastReaderPathRef = useRef<string | null>(null);
  const wasReaderOpenRef = useRef(false);
  const pendingFolderFocusRef = useRef<'card' | 'crumb' | null>(null);

  // Reset workspace-scoped view state only if workspaceId prop changes without a remount.
  const prevWorkspaceRef = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspaceRef.current === workspaceId) return;
    prevWorkspaceRef.current = workspaceId;
    readerOpenerRef.current = null;
    readerOpenerKindRef.current = null;
    readerOpenedPathRef.current = null;
    lastReaderPathRef.current = null;
    wasReaderOpenRef.current = false;
    setFolder('');
    setQuery('');
    setSelectedPath(null);
    setReaderPath(null);
    setReaderRaw(false);
    setShowEvidence(false);
    setBrokenImages(new Set());
  }, [workspaceId]);

  const measureWide = useCallback(() => {
    const aside = asideRef.current;
    if (!aside) return false;
    const wideNow = getComputedStyle(aside).display !== 'none';
    setIsWide((prev) => (prev === wideNow ? prev : wideNow));
    return wideNow;
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    measureWide();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      measureWide();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [measureWide, active]);

  // Refetch on browser window regain focus when active.
  useEffect(() => {
    if (!listening || typeof window === 'undefined') return;
    const onFocus = () => {
      void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [listening, queryClient, workspaceId]);

  const catalogQuery = useQuery<DocumentCatalog, Error>({
    queryKey: documentCatalogKey(workspaceId),
    queryFn: async ({ signal }) => {
      const raw = await apiFetch<unknown>(`/api/workspace/${encodeURIComponent(workspaceId)}/documents/catalog`, { signal });
      return cleanDocumentCatalog(raw);
    },
    enabled: Boolean(workspaceId) && active,
    staleTime: 60_000,
    refetchOnWindowFocus: listening ? 'always' : false,
    refetchInterval: listening ? 3 * 60_000 : false,
    retry: false,
  });

  const catalog = catalogQuery.data;
  const itemByPath = useMemo(() => {
    const map = new Map<string, DocumentCatalogItem>();
    for (const item of catalog?.items ?? []) map.set(item.path, item);
    return map;
  }, [catalog?.items]);

  const selectedItem = selectedPath ? itemByPath.get(selectedPath) ?? null : null;
  const readerItem = readerPath ? itemByPath.get(readerPath) ?? null : null;
  const readerKind: DocumentCatalogKind = readerItem?.kind ?? (readerPath ? inferKindFromPath(readerPath) : 'text');

  const sidePreviewNeedsFetch = Boolean(
    active
    && isWide
    && selectedItem
    && selectedItem.kind !== 'image'
    && selectedItem.kind !== 'pdf'
    && selectedItem.kind !== 'download',
  );
  const sidePreviewQuery = useQuery<DocumentPreviewData, Error>({
    queryKey: ['documents-page-preview', workspaceId, selectedItem?.path ?? ''],
    queryFn: ({ signal }) =>
      apiFetch<DocumentPreviewData>(
        `/api/workspace/${encodeURIComponent(workspaceId)}/documents/preview?name=${encodeURIComponent(selectedItem!.path)}`,
        { signal },
      ),
    enabled: sidePreviewNeedsFetch,
    staleTime: 30_000,
    retry: false,
  });

  const readerPreviewNeedsFetch = Boolean(
    active
    && readerPath
    && readerKind !== 'image'
    && readerKind !== 'pdf'
    && readerKind !== 'download',
  );
  const readerPreviewQuery = useQuery<DocumentPreviewData, Error>({
    queryKey: ['documents-page-preview', workspaceId, readerPath ?? ''],
    queryFn: ({ signal }) =>
      apiFetch<DocumentPreviewData>(
        `/api/workspace/${encodeURIComponent(workspaceId)}/documents/preview?name=${encodeURIComponent(readerPath!)}`,
        { signal },
      ),
    enabled: readerPreviewNeedsFetch,
    staleTime: 30_000,
    retry: false,
  });

  // Refresh open side/reader preview in place when a background catalog refetch sees a newer mtime,
  // without changing the queryKey (which would unmount the preview/reader and flash a loading state).
  const prevSideMetaRef = useRef<{ path: string; modifiedAt: string } | null>(null);
  useEffect(() => {
    if (!sidePreviewNeedsFetch || !selectedItem) {
      prevSideMetaRef.current = null;
      return;
    }
    const prev = prevSideMetaRef.current;
    if (prev && prev.path === selectedItem.path && prev.modifiedAt !== selectedItem.modifiedAt) {
      void queryClient.invalidateQueries({ queryKey: ['documents-page-preview', workspaceId, selectedItem.path] });
    }
    prevSideMetaRef.current = { path: selectedItem.path, modifiedAt: selectedItem.modifiedAt };
  }, [sidePreviewNeedsFetch, selectedItem, queryClient, workspaceId]);

  const prevReaderMetaRef = useRef<{ path: string; modifiedAt: string } | null>(null);
  useEffect(() => {
    if (!readerPreviewNeedsFetch || !readerPath || !readerItem) {
      prevReaderMetaRef.current = null;
      return;
    }
    const prev = prevReaderMetaRef.current;
    if (prev && prev.path === readerPath && prev.modifiedAt !== readerItem.modifiedAt) {
      void queryClient.invalidateQueries({ queryKey: ['documents-page-preview', workspaceId, readerPath] });
    }
    prevReaderMetaRef.current = { path: readerPath, modifiedAt: readerItem.modifiedAt };
  }, [readerPreviewNeedsFetch, readerPath, readerItem, queryClient, workspaceId]);

  const sidePreviewData: DocumentPreviewData | null = useMemo(() => {
    if (!selectedItem) return null;
    if (selectedItem.kind === 'image' || selectedItem.kind === 'pdf' || selectedItem.kind === 'download') {
      return {
        name: selectedItem.path,
        kind: selectedItem.kind,
        size: selectedItem.size,
        modifiedAt: selectedItem.modifiedAt,
      };
    }
    return sidePreviewQuery.data ?? null;
  }, [selectedItem, sidePreviewQuery.data]);

  const readerPreviewData: DocumentPreviewData | null = useMemo(() => {
    if (!readerPath) return null;
    if (readerKind === 'image' || readerKind === 'pdf' || readerKind === 'download') {
      return {
        name: readerPath,
        kind: readerKind,
        size: readerItem?.size,
        modifiedAt: readerItem?.modifiedAt,
      };
    }
    return readerPreviewQuery.data ?? null;
  }, [readerPath, readerKind, readerItem?.size, readerItem?.modifiedAt, readerPreviewQuery.data]);

  const openReader = useCallback(
    (docPath: string, opener: HTMLElement | null, openerKind: 'open-button' | 'card' = 'card') => {
      const normalized = normalizeCatalogPath(docPath);
      if (!normalized) return;
      const fromInsideReader = Boolean(opener && overlayRef.current?.contains(opener));
      if (readerPath === null && !fromInsideReader) {
        readerOpenerRef.current = opener;
        readerOpenerKindRef.current = openerKind;
        readerOpenedPathRef.current = normalized;
      }
      lastReaderPathRef.current = normalized;
      setReaderRaw(false);
      setReaderPath(normalized);
      setReaderRequest((n) => n + 1);
    },
    [readerPath],
  );

  const closeReader = useCallback(() => {
    setReaderPath(null);
    setReaderRaw(false);
  }, []);

  const enterFolder = useCallback((nextFolder: string, via: 'card' | 'crumb') => {
    const normalized = normalizeCatalogPath(nextFolder);
    pendingFolderFocusRef.current = via;
    setFolder(normalized);
    setShowEvidence(false);
    setSelectedPath(null);
    setQuery('');
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  // Move focus into the folder view after stepping into a folder card.
  useLayoutEffect(() => {
    const via = pendingFolderFocusRef.current;
    if (!via || !active) return;
    pendingFolderFocusRef.current = null;
    if (via === 'card') {
      const firstControl = listRef.current?.querySelector<HTMLElement>('button:not([disabled])');
      if (firstControl) {
        firstControl.focus({ preventScroll: true });
        return;
      }
      const crumbButtons = crumbsRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
      const lastCrumb = crumbButtons?.[crumbButtons.length - 1];
      lastCrumb?.focus({ preventScroll: true });
    }
  }, [folder, active]);

  const prevReaderFocusRef = useRef<{ active: boolean; readerPath: string | null; readerRequest: number }>({
    active,
    readerPath,
    readerRequest,
  });

  // Move focus into the reader when it opens, and restore focus to the opener when it closes.
  useLayoutEffect(() => {
    const prev = prevReaderFocusRef.current;
    prevReaderFocusRef.current = { active, readerPath, readerRequest };

    if (!active) {
      wasReaderOpenRef.current = false;
      return;
    }

    if (readerPath !== null) {
      wasReaderOpenRef.current = true;
      const shouldFocusReader =
        (prev.active && prev.readerPath === null)
        || prev.readerRequest !== readerRequest;
      if (!shouldFocusReader) return;

      const closeBtn = overlayRef.current?.querySelector<HTMLElement>('button[aria-label="Close document"]');
      if (closeBtn) {
        closeBtn.focus({ preventScroll: true });
      } else {
        const frame = requestAnimationFrame(() => {
          overlayRef.current?.querySelector<HTMLElement>('button[aria-label="Close document"]')?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
      }
      return;
    }

    const shouldRestoreFocus = wasReaderOpenRef.current && prev.active && prev.readerPath !== null;
    wasReaderOpenRef.current = false;
    if (!shouldRestoreFocus) return;

    const opener = readerOpenerRef.current;
    const openerKind = readerOpenerKindRef.current;
    const openedPath = readerOpenedPathRef.current;
    const lastPath = lastReaderPathRef.current;
    readerOpenerRef.current = null;
    readerOpenerKindRef.current = null;
    readerOpenedPathRef.current = null;
    lastReaderPathRef.current = null;

    if (isElementVisible(opener)) {
      opener.focus({ preventScroll: true });
      return;
    }
    if (openerKind === 'open-button') {
      const openBtn = asideRef.current?.querySelector<HTMLElement>('[data-testid="open-in-reader"]');
      if (isElementVisible(openBtn ?? null)) {
        openBtn!.focus({ preventScroll: true });
        return;
      }
    }
    if (listRef.current) {
      const cards = Array.from(listRef.current.querySelectorAll<HTMLElement>('button[data-doc-path]'));
      for (const candidatePath of [openedPath, lastPath]) {
        if (!candidatePath) continue;
        const match = cards.find((el) => el.dataset.docPath === candidatePath && isElementVisible(el));
        if (match) {
          match.focus({ preventScroll: true });
          return;
        }
      }
      const firstListBtn = Array.from(listRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')).find(
        (el) => isElementVisible(el),
      );
      if (firstListBtn) {
        firstListBtn.focus({ preventScroll: true });
        return;
      }
    }
    if (isElementVisible(searchRef.current)) {
      searchRef.current.focus({ preventScroll: true });
    }
  }, [readerPath, readerRequest, active]);

  // Keyboard shortcuts when DocumentsPage is active.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      if (isCodeWindowOpen()) return;
      if (hasVisibleOverlay()) return;

      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        if (readerPath !== null) {
          if (isTypingTarget(event.target)) return;
          event.preventDefault();
          closeReader();
        }
        return;
      }

      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (
          event.defaultPrevented
          || readerPath !== null
          || isTypingTarget(event.target)
          || (document.activeElement instanceof Element && Boolean(document.activeElement.closest('[data-slash-owner]')))
        ) {
          return;
        }
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, readerPath, closeReader]);

  // Escape inside a sandboxed HTML document iframe relays ESCAPE_MESSAGE.
  useEffect(() => {
    if (!active || readerPath === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data !== ESCAPE_MESSAGE || !event.source) return;
      if (isCodeWindowOpen()) return;
      if (hasVisibleOverlay()) return;
      const frames = overlayRef.current?.querySelectorAll('iframe') ?? [];
      if (Array.from(frames).some((frame) => frame.contentWindow === event.source)) {
        closeReader();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [active, readerPath, closeReader]);

  const handleCardClick = useCallback(
    (item: DocumentCatalogItem, target: HTMLElement) => {
      if (measureWide()) {
        setSelectedPath(item.path);
      } else {
        openReader(item.path, target, 'card');
      }
    },
    [measureWide, openReader],
  );

  const handleCardDoubleClick = useCallback(
    (item: DocumentCatalogItem, target: HTMLElement) => {
      if (measureWide()) {
        openReader(item.path, target, 'card');
      }
    },
    [measureWide, openReader],
  );

  const markBrokenImage = useCallback((docPath: string) => {
    setBrokenImages((prev) => {
      if (prev.has(docPath)) return prev;
      const next = new Set(prev);
      next.add(docPath);
      return next;
    });
  }, []);

  const makeMarkdownLinks = useCallback(
    (docPath: string): MarkdownDocumentLinks => ({
      workspaceRoot: workspacePath,
      documentPath: docPath,
      resolveReferences: true,
      fileUrl: (name) => documentFileUrl(workspaceId, name),
      onOpenFile: (linkedPath) => openReader(linkedPath, document.activeElement instanceof HTMLElement ? document.activeElement : null, 'card'),
    }),
    [workspaceId, workspacePath, openReader],
  );

  const isSearching = query.trim().length > 0;
  const breadcrumbs = useMemo(() => buildBreadcrumbs(folder), [folder]);

  const changedLately = useMemo(() => {
    if (!catalog || folder !== '' || isSearching) return [];
    return changedLatelyItems(catalog, 4);
  }, [catalog, folder, isSearching]);

  const visibleFolders = useMemo(() => {
    if (!catalog || isSearching) return [];
    return childFolders(catalog, folder, { includeEvidence: false });
  }, [catalog, folder, isSearching]);

  const visibleItems = useMemo(() => {
    if (!catalog || isSearching) return { documents: [] as DocumentCatalogItem[], pictures: [] as DocumentCatalogItem[] };
    return folderItems(catalog, folder, { includeEvidence: false });
  }, [catalog, folder, isSearching]);

  const evidenceSummary = useMemo(() => {
    if (!catalog || isSearching) return { totalCount: 0, folders: [] as DocumentCatalogFolder[], files: [] as DocumentCatalogItem[] };
    return directEvidenceSummary(catalog, folder);
  }, [catalog, folder, isSearching]);

  const searchResults = useMemo(() => {
    if (!catalog || !isSearching) return [];
    return searchCatalog(catalog, query, { includeEvidence: showEvidence });
  }, [catalog, query, isSearching, showEvidence]);

  const searchDocuments = useMemo(() => searchResults.filter((item) => item.kind !== 'image'), [searchResults]);
  const searchPictures = useMemo(() => searchResults.filter((item) => item.kind === 'image'), [searchResults]);
  const totalEvidenceInCatalog = useMemo(
    () => (catalog ? catalog.items.filter((item) => item.evidence).length : 0),
    [catalog],
  );

  const renderFolderCard = (entry: DocumentCatalogFolder) => {
    const countsText = formatFolderCounts(entry, { evidence: entry.evidence });
    return (
      <button
        key={entry.path}
        type="button"
        onClick={() => enterFolder(entry.path, 'card')}
        className={cn(CARD_SURFACE, 'flex min-h-12 flex-col gap-1.5 p-3')}
      >
        <div className="flex items-center gap-2 text-sm font-semibold leading-5 text-foreground">
          <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{entry.name}</span>
        </div>
        {entry.summary && (
          <p className="line-clamp-2 text-[length:var(--type-ui-size)] leading-[var(--type-ui-leading)] text-muted-foreground">
            {entry.summary}
          </p>
        )}
        {countsText && (
          <p className="text-xs leading-4 text-muted-foreground tabular-nums">{countsText}</p>
        )}
      </button>
    );
  };

  const renderDocumentCard = (item: DocumentCatalogItem, showFullPath = false) => {
    const selected = isWide && selectedPath === item.path;
    const ago = item.modifiedAt ? agoText(item.modifiedAt, nowDate) : '';
    return (
      <button
        key={item.path}
        type="button"
        data-doc-path={item.path}
        aria-pressed={selected ? 'true' : 'false'}
        onClick={(e) => handleCardClick(item, e.currentTarget)}
        onDoubleClick={(e) => handleCardDoubleClick(item, e.currentTarget)}
        className={cn(
          CARD_SURFACE,
          'grid grid-cols-[80px_minmax(0,1fr)] items-start gap-3 p-3',
          selected && 'border-primary ring-1 ring-primary',
        )}
      >
        <DocMiniThumbnail kind={item.kind} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="line-clamp-2 break-words text-sm font-semibold leading-5 text-foreground">
            {item.title}
          </span>
          {item.excerpt && (
            <span className="line-clamp-2 break-words text-[length:var(--type-ui-size)] leading-[var(--type-ui-leading)] text-muted-foreground">
              {item.excerpt}
            </span>
          )}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-4 text-muted-foreground">
            <KindLabel kind={kindLabelFor(item.kind)} className="text-xs leading-4" />
            <span className="min-w-0 truncate font-mono">{showFullPath ? item.path : item.name}</span>
            {ago && <span className="shrink-0 tabular-nums">{ago}</span>}
          </span>
        </div>
      </button>
    );
  };

  const renderPictureCard = (item: DocumentCatalogItem, showFullPath = false) => {
    const selected = isWide && selectedPath === item.path;
    const ago = item.modifiedAt ? agoText(item.modifiedAt, nowDate) : '';
    const isBroken = brokenImages.has(item.path);
    return (
      <button
        key={item.path}
        type="button"
        data-doc-path={item.path}
        aria-pressed={selected ? 'true' : 'false'}
        onClick={(e) => handleCardClick(item, e.currentTarget)}
        onDoubleClick={(e) => handleCardDoubleClick(item, e.currentTarget)}
        className={cn(
          CARD_SURFACE,
          'flex flex-col overflow-hidden p-0',
          selected && 'border-primary ring-1 ring-primary',
        )}
      >
        <div className="flex aspect-video w-full items-center justify-center overflow-hidden border-b border-border bg-muted/30">
          {isBroken ? (
            <FileImage aria-hidden="true" className="size-6 text-muted-foreground" />
          ) : (
            <img
              loading="lazy"
              decoding="async"
              src={documentFileUrl(workspaceId, item.path)}
              alt=""
              onError={() => markBrokenImage(item.path)}
              className="size-full object-cover object-top"
            />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 p-2.5">
          <span className="truncate text-sm font-semibold leading-5 text-foreground">{item.title}</span>
          <span className="flex items-center gap-2 text-xs leading-4 text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{showFullPath ? item.path : item.name}</span>
            {ago && <span className="shrink-0 tabular-nums">{ago}</span>}
          </span>
        </div>
      </button>
    );
  };

  const folderIsEvidence = catalog ? isFolderEvidence(catalog, folder) : false;
  const isEmptyFolder =
    !isSearching
    && Boolean(catalog)
    && changedLately.length === 0
    && visibleFolders.length === 0
    && visibleItems.documents.length === 0
    && visibleItems.pictures.length === 0
    && evidenceSummary.totalCount === 0;

  return (
    <div
      ref={rootRef}
      data-documents-page=""
      className="@container relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
    >
      {/* Compact hairline header */}
      <header
        inert={active && readerPath !== null ? true : undefined}
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card/60 px-4 py-2 @[48rem]:px-5"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h2 className="shrink-0 text-base font-semibold leading-6 text-foreground">Documents</h2>
          <nav ref={crumbsRef} aria-label="Breadcrumbs" className="min-w-0">
            <ol className="flex flex-wrap items-center gap-0.5 text-xs leading-4">
              {breadcrumbs.map((crumb, idx) => {
                const isCurrent = idx === breadcrumbs.length - 1 && !isSearching;
                return (
                  <li key={crumb.path || '__root__'} className="flex min-w-0 items-center gap-0.5">
                    {idx > 0 && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
                    <button
                      type="button"
                      onClick={() => enterFolder(crumb.path, 'crumb')}
                      aria-current={isCurrent ? 'page' : undefined}
                      className={cn(
                        'inline-flex min-h-6 max-w-full items-center rounded-md px-1.5 py-0.5 text-xs leading-4 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-ring',
                        isCurrent
                          ? 'font-semibold text-foreground'
                          : 'font-medium text-primary hover:bg-accent/60 hover:underline',
                      )}
                    >
                      <span className="truncate">{crumb.label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        </div>

        <div className="flex w-full min-w-0 items-center gap-1.5 @[38rem]:ml-auto @[38rem]:w-auto @[38rem]:shrink-0">
          <div className="relative min-w-0 flex-1 @[38rem]:w-84 @[38rem]:flex-initial">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              type="search"
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                }
              }}
              placeholder="Find a document by title, words or path"
              aria-label="Find a document by title, words or path"
              className={cn('w-full pl-6 sm:text-[length:var(--type-ui-size)]', query ? 'pr-7' : 'pr-0.5')}
            />
            {query && (
              <IconButton
                size="xs"
                label="Clear search"
                icon={<X />}
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2"
              />
            )}
          </div>
          {panelActions}
        </div>
      </header>

      {/* Main content area: single-column when < 56rem, split list + 380px preview when >= 56rem */}
      <div
        inert={active && readerPath !== null ? true : undefined}
        className="grid min-h-0 flex-1 grid-cols-1 @[56rem]:grid-cols-[minmax(0,1fr)_380px]"
      >
        <section
          ref={listRef}
          aria-label="Documents list"
          className="@container min-h-0 min-w-0 overflow-y-auto px-4 pb-10 pt-4 @[48rem]:px-5"
        >
          {catalogQuery.isPending && !catalog && (
            <div role="status" className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" className="size-4" />
              <span>Loading documents</span>
            </div>
          )}

          {catalogQuery.isError && !catalog && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Folder />
                </EmptyMedia>
                <EmptyTitle>Could not load documents</EmptyTitle>
                <EmptyDescription>
                  {catalogQuery.error instanceof Error ? catalogQuery.error.message : 'Unable to read workspace documents.'}
                </EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" size="sm" onClick={() => void catalogQuery.refetch()}>
                Retry
              </Button>
            </Empty>
          )}

          {catalog && isSearching && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[length:var(--type-ui-size)] font-semibold leading-5 text-muted-foreground">
                  Found {searchResults.length}
                </h3>
                {totalEvidenceInCatalog > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={showEvidence}
                    onClick={() => setShowEvidence((prev) => !prev)}
                  >
                    {showEvidence ? 'Hide evidence' : 'Include evidence'}
                  </Button>
                )}
              </div>

              {searchResults.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Search />
                    </EmptyMedia>
                    <EmptyTitle>No matching documents</EmptyTitle>
                    <EmptyDescription>
                      Nothing matched &ldquo;{query.trim()}&rdquo;. Try another title, word, or path.
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                  >
                    Clear search
                  </Button>
                </Empty>
              ) : (
                <>
                  {searchDocuments.length > 0 && (
                    <div className="grid grid-cols-1 gap-2.5 @[40rem]:grid-cols-2">
                      {searchDocuments.map((item) => renderDocumentCard(item, true))}
                    </div>
                  )}
                  {searchPictures.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-[length:var(--type-ui-size)] font-semibold leading-5 text-muted-foreground">
                        Pictures <span className="font-normal tabular-nums">{searchPictures.length}</span>
                      </h4>
                      <div className="grid grid-cols-1 gap-3 @[26rem]:grid-cols-2 @[46rem]:grid-cols-3">
                        {searchPictures.map((item) => renderPictureCard(item, true))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {catalog && !isSearching && (
            <div className="space-y-6">
              {changedLately.length > 0 && (
                <div className="space-y-2">
                  <h3 className="flex items-baseline gap-2 text-[length:var(--type-ui-size)] font-semibold leading-5 text-muted-foreground">
                    <span>Changed lately</span>
                    <span className="text-xs font-normal">documents only, logs left out</span>
                  </h3>
                  <div className="grid grid-cols-1 gap-2.5 @[28rem]:grid-cols-2 @[52rem]:grid-cols-4">
                    {changedLately.map((item) => {
                      const selected = isWide && selectedPath === item.path;
                      const ago = item.modifiedAt ? agoText(item.modifiedAt, nowDate) : '';
                      return (
                        <button
                          key={`recent:${item.path}`}
                          type="button"
                          data-doc-path={item.path}
                          aria-pressed={selected ? 'true' : 'false'}
                          onClick={(e) => handleCardClick(item, e.currentTarget)}
                          onDoubleClick={(e) => handleCardDoubleClick(item, e.currentTarget)}
                          className={cn(
                            CARD_SURFACE,
                            'flex min-w-0 flex-col gap-1 p-3',
                            selected && 'border-primary ring-1 ring-primary',
                          )}
                        >
                          <span className="line-clamp-2 break-words text-sm font-semibold leading-5 text-foreground">
                            {item.title}
                          </span>
                          <span className="flex items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                            <span className="min-w-0 truncate font-mono" title={item.path}>{item.path}</span>
                            {ago && <span className="shrink-0 tabular-nums">· {ago}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {visibleFolders.length > 0 && (
                <div className="space-y-2">
                  <h3 className="flex items-baseline gap-2 text-[length:var(--type-ui-size)] font-semibold leading-5 text-muted-foreground">
                    <span>Folders</span>
                    <span className="text-xs font-normal tabular-nums">{visibleFolders.length}</span>
                  </h3>
                  <div className="grid grid-cols-1 gap-2.5 @[28rem]:grid-cols-2 @[52rem]:grid-cols-3">
                    {visibleFolders.map(renderFolderCard)}
                  </div>
                </div>
              )}

              {visibleItems.documents.length > 0 && (
                <div className="space-y-2">
                  <h3 className="flex items-baseline gap-2 text-[length:var(--type-ui-size)] font-semibold leading-5 text-muted-foreground">
                    <span>{folderIsEvidence ? 'Evidence files' : 'Documents & pages'}</span>
                    <span className="text-xs font-normal tabular-nums">{visibleItems.documents.length}</span>
                  </h3>
                  <div className="grid grid-cols-1 gap-2.5 @[40rem]:grid-cols-2">
                    {visibleItems.documents.map((item) => renderDocumentCard(item, false))}
                  </div>
                </div>
              )}

              {visibleItems.pictures.length > 0 && (
                <div className="space-y-2">
                  <h3 className="flex items-baseline gap-2 text-[length:var(--type-ui-size)] font-semibold leading-5 text-muted-foreground">
                    <span>Pictures</span>
                    <span className="text-xs font-normal tabular-nums">{visibleItems.pictures.length}</span>
                  </h3>
                  <div className="grid grid-cols-1 gap-3 @[26rem]:grid-cols-2 @[46rem]:grid-cols-3">
                    {visibleItems.pictures.map((item) => renderPictureCard(item, false))}
                  </div>
                </div>
              )}

              {evidenceSummary.totalCount > 0 && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-dashed border-border bg-card/50 px-3.5 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5 text-[length:var(--type-ui-size)] leading-5 text-muted-foreground">
                      <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span>
                        <strong className="font-semibold text-foreground">Evidence and logs</strong> ·{' '}
                        <span className="tabular-nums">
                          {evidenceSummary.totalCount} {evidenceSummary.totalCount === 1 ? 'file' : 'files'}
                        </span>{' '}
                        (test logs, hashes, review reports). Folded away so they never crowd the documents.
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-expanded={showEvidence}
                      onClick={() => setShowEvidence((prev) => !prev)}
                    >
                      {showEvidence ? 'Hide' : 'Show them'}
                    </Button>
                  </div>

                  {showEvidence && (
                    <div className="space-y-4">
                      {evidenceSummary.folders.length > 0 && (
                        <div className="grid grid-cols-1 gap-2.5 @[28rem]:grid-cols-2 @[52rem]:grid-cols-3">
                          {evidenceSummary.folders.map(renderFolderCard)}
                        </div>
                      )}
                      {evidenceSummary.files.length > 0 && (
                        <div className="grid grid-cols-1 gap-2.5 @[40rem]:grid-cols-2">
                          {evidenceSummary.files.map((item) =>
                            item.kind === 'image' ? renderPictureCard(item, false) : renderDocumentCard(item, false),
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {isEmptyFolder && (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Folder />
                    </EmptyMedia>
                    <EmptyTitle>No documents here</EmptyTitle>
                    <EmptyDescription>
                      {folder ? `No documents or subfolders inside "${folder}".` : 'No workspace documents found yet.'}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          )}
        </section>

        {/* Right live preview pane (shown only when container >= 56rem) */}
        <aside
          ref={asideRef}
          aria-label="Document preview"
          className="hidden min-h-0 flex-col border-l border-border bg-card @[56rem]:flex"
        >
          {!selectedItem ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[length:var(--type-ui-size)] leading-[var(--type-ui-leading)] text-muted-foreground">
              Pick a document or picture to see its preview here.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 space-y-2 border-b border-border p-4">
                <h3 className="break-words text-base font-semibold leading-snug text-foreground">
                  {selectedItem.title}
                </h3>
                <p className="break-all font-mono text-xs leading-4 text-muted-foreground">
                  {selectedItem.path}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs leading-4 text-muted-foreground">
                  <KindLabel kind={kindLabelFor(selectedItem.kind)} className="text-xs leading-4" />
                  <span className="tabular-nums">{formatFileSize(selectedItem.size)}</span>
                  {selectedItem.modifiedAt && (
                    <span className="tabular-nums">{agoText(selectedItem.modifiedAt, nowDate)}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="default"
                    data-testid="open-in-reader"
                    onClick={(e) => openReader(selectedItem.path, e.currentTarget, 'open-button')}
                  >
                    Open in reader
                  </Button>
                  {!readOnly && askInCLI && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => askInCLI(askCard({ kind: 'file', title: selectedItem.title, path: selectedItem.path }))}
                    >
                      <Terminal aria-hidden="true" />
                      <span>Ask in CLI</span>
                    </Button>
                  )}
                </div>
              </div>

              <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4 wrap-anywhere">
                {sidePreviewData ? (
                  <DocumentPreview
                    preview={sidePreviewData}
                    fileUrl={documentFileUrl(workspaceId, selectedItem.path)}
                    raw={false}
                    trusted
                    links={makeMarkdownLinks(selectedItem.path)}
                  />
                ) : sidePreviewQuery.isError ? (
                  <div className="space-y-2">
                    <p role="alert" className="text-xs text-destructive">
                      {sidePreviewQuery.error instanceof Error ? sidePreviewQuery.error.message : 'Unable to load preview.'}
                    </p>
                    <Button size="sm" variant="outline" onClick={() => void sidePreviewQuery.refetch()}>
                      Retry preview
                    </Button>
                  </div>
                ) : (
                  <div role="status" className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Spinner aria-hidden="true" className="size-4" />
                    <span>Loading preview…</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Reader overlay inside the Documents container (never covers chat in Split mode) */}
      {active && readerPath !== null && (
        <div
          ref={overlayRef}
          role="region"
          aria-label="Document reader"
          data-documents-reader=""
          className="absolute inset-0 z-20 flex flex-col bg-background"
        >
          <DocumentViewer
            key={readerPath}
            fill
            fillFrame
            title={readerPath}
            preview={readerPreviewData}
            fileUrl={documentFileUrl(workspaceId, readerPath)}
            downloadHref={`${documentFileUrl(workspaceId, readerPath)}&download=1`}
            browserHref={readerKind === 'html' ? `${documentFileUrl(workspaceId, readerPath)}&open=1` : undefined}
            links={makeMarkdownLinks(readerPath)}
            raw={readerRaw}
            onToggleRaw={
              readerKind === 'markdown' || readerKind === 'html'
                ? () => setReaderRaw((prev) => !prev)
                : undefined
            }
            rawLabels={readerKind === 'markdown' ? ['View source', 'View formatted'] : ['View source', 'View page']}
            onClose={closeReader}
            status={
              readerPreviewQuery.isError ? (
                <div className="space-y-2">
                  <p role="alert" className="text-sm text-destructive">
                    {readerPreviewQuery.error instanceof Error ? readerPreviewQuery.error.message : 'Unable to open document.'}
                  </p>
                  <Button size="sm" variant="outline" onClick={() => void readerPreviewQuery.refetch()}>
                    Retry preview
                  </Button>
                </div>
              ) : (
                <div role="status" className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Spinner aria-hidden="true" className="size-4" />
                  <span>Opening document…</span>
                </div>
              )
            }
          />
        </div>
      )}
    </div>
  );
}
