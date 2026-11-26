import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Edit3, FileImage, FilePlus, Folder, FolderPlus, Search, Terminal, Upload, X } from 'lucide-react';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertTitle,
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
import { DocumentEditor } from './DocumentEditor.js';
import { NewDocumentDialog, NewFolderDialog } from './NewDocumentDialog.js';
import {
  getWorkspaceDocumentDrafts,
  isManagedReadOnlyItem,
  moveDocument,
  parseDocumentConflict,
  saveDocument,
  setWorkspaceDocumentDrafts,
  suggestCopyPath,
  suggestNumberedPath,
  uploadDocument,
  validateUploadFile,
  type DocumentConflictDetails,
  type DocumentFolderResult,
  type DocumentSaveResult,
  type ReaderDocumentDraftState,
  type SideDocumentDraftState,
  type WorkspaceDocumentDraftSnapshot,
} from './documentMutations.js';
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
    && el.getClientRects().length > 0
    && !el.matches(':disabled')
    && el.getAttribute('aria-disabled') !== 'true',
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

  const [draftSeed] = useState<WorkspaceDocumentDraftSnapshot | null>(() => getWorkspaceDocumentDrafts(workspaceId));
  const [stateWorkspaceId, setStateWorkspaceId] = useState(workspaceId);

  const [folder, setFolder] = useState(() => draftSeed?.folder ?? '');
  const [folderNavSeq, setFolderNavSeq] = useState(0);
  const [query, setQuery] = useState('');
  const isSearching = query.trim().length > 0;
  const [selectedPath, setSelectedPath] = useState<string | null>(() => draftSeed?.sideDraft?.path ?? null);
  const [readerPath, setReaderPath] = useState<string | null>(() => draftSeed?.readerPath ?? null);
  const [readerRaw, setReaderRaw] = useState(false);
  const [readerRequest, setReaderRequest] = useState(0);
  const [readerInitialEditing, setReaderInitialEditing] = useState(() =>
    Boolean(draftSeed?.readerPath && draftSeed.readerDrafts[draftSeed.readerPath]?.editing),
  );
  const [showEvidence, setShowEvidence] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());
  const [isWide, setIsWide] = useState(true);

  const [newDocOpen, setNewDocOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [uploadConflicts, setUploadConflicts] = useState<
    Array<{ id: string; file: File; folder: string; targetPath: string }>
  >([]);

  const [sideEditing, setSideEditing] = useState(() => Boolean(draftSeed?.sideDraft));
  const [sideEditPath, setSideEditPath] = useState<string | null>(() => draftSeed?.sideDraft?.path ?? null);
  const [sideEditContent, setSideEditContent] = useState(() => draftSeed?.sideDraft?.content ?? '');
  const [sideBaseContent, setSideBaseContent] = useState(() => draftSeed?.sideDraft?.baseContent ?? '');
  const [sideBaseRevision, setSideBaseRevision] = useState<string | undefined>(() => draftSeed?.sideDraft?.baseRevision);
  const [sideBaseModifiedAt, setSideBaseModifiedAt] = useState<string | undefined>(() => draftSeed?.sideDraft?.baseModifiedAt);
  const [sideBaseCatalogModifiedAt, setSideBaseCatalogModifiedAt] = useState<string | undefined>(
    () => draftSeed?.sideDraft?.baseCatalogModifiedAt,
  );
  const [sideSaving, setSideSaving] = useState(false);
  const [sideSaveError, setSideSaveError] = useState<string | null>(() => draftSeed?.sideDraft?.saveError ?? null);
  const [sideConflict, setSideConflict] = useState<DocumentConflictDetails | null>(() => draftSeed?.sideDraft?.conflict ?? null);
  const [sideAutoFocus, setSideAutoFocus] = useState(() => Boolean(draftSeed?.sideDraft));

  type PendingSideAction =
    | { type: 'cancel-edit' }
    | { type: 'select-doc'; path: string; opener?: HTMLElement | null }
    | { type: 'enter-folder'; folder: string; via: 'card' | 'crumb' }
    | { type: 'open-new-doc' }
    | { type: 'open-new-folder' }
    | { type: 'open-reader-link'; path: string; opener?: HTMLElement | null };
  const [pendingSideAction, setPendingSideAction] = useState<PendingSideAction | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newDocTriggerRef = useRef<HTMLButtonElement>(null);
  const newFolderTriggerRef = useRef<HTMLButtonElement>(null);
  const sideEditButtonRef = useRef<HTMLButtonElement>(null);
  const sideOpenInReaderRef = useRef<HTMLButtonElement>(null);
  const sideTextareaRef = useRef<HTMLTextAreaElement>(null);
  const sideLinkOriginRef = useRef<HTMLElement | null>(null);
  const keepSideEditingRef = useRef<HTMLButtonElement>(null);
  const pendingSideExitFocusRef = useRef(false);
  const sideAlertExitModeRef = useRef<'keep' | 'discard-stay' | 'discard-away'>('keep');
  const sideEditingRef = useRef(sideEditing);
  const activeRef = useRef(active);
  const readerPathRef = useRef(readerPath);
  const newDocOpenRef = useRef(newDocOpen);
  const newFolderOpenRef = useRef(newFolderOpen);
  const dragDepthRef = useRef(0);

  const readerOpenerRef = useRef<HTMLElement | null>(null);
  const readerOpenerKindRef = useRef<'open-button' | 'card' | null>(null);
  const readerOpenedPathRef = useRef<string | null>(draftSeed?.readerPath ?? null);
  const lastReaderPathRef = useRef<string | null>(draftSeed?.readerPath ?? null);
  const wasReaderOpenRef = useRef(false);
  const pendingFolderFocusRef = useRef<'card' | 'crumb' | null>(null);
  const readerRequestCloseRef = useRef<(() => void) | null>(null);
  type ReaderDraftState = ReaderDocumentDraftState;
  const [readerDrafts, setReaderDrafts] = useState<Record<string, ReaderDraftState>>(() => draftSeed?.readerDrafts ?? {});

  useLayoutEffect(() => {
    sideEditingRef.current = sideEditing;
    activeRef.current = active;
    readerPathRef.current = readerPath;
    newDocOpenRef.current = newDocOpen;
    newFolderOpenRef.current = newFolderOpen;
  }, [sideEditing, active, readerPath, newDocOpen, newFolderOpen]);

  // Switch workspace-scoped view state cleanly if workspaceId prop changes without a remount.
  useEffect(() => {
    if (stateWorkspaceId === workspaceId) return;
    const restored = getWorkspaceDocumentDrafts(workspaceId);
    readerOpenerRef.current = null;
    readerOpenerKindRef.current = null;
    readerOpenedPathRef.current = restored?.readerPath ?? null;
    lastReaderPathRef.current = restored?.readerPath ?? null;
    wasReaderOpenRef.current = false;
    pendingFolderFocusRef.current = null;
    pendingSideExitFocusRef.current = false;
    sideLinkOriginRef.current = null;
    setReaderDrafts(restored?.readerDrafts ?? {});
    dragDepthRef.current = 0;
    setFolder(restored?.folder ?? '');
    setQuery('');
    setSelectedPath(restored?.sideDraft?.path ?? null);
    setReaderPath(restored?.readerPath ?? null);
    setReaderRaw(false);
    setReaderInitialEditing(Boolean(restored?.readerPath && restored.readerDrafts[restored.readerPath]?.editing));
    setShowEvidence(false);
    setBrokenImages(new Set());
    setNewDocOpen(false);
    setNewFolderOpen(false);
    setIsDraggingFiles(false);
    setUploading(false);
    setUploadErrors([]);
    setUploadConflicts([]);
    setSideEditing(Boolean(restored?.sideDraft));
    setSideEditPath(restored?.sideDraft?.path ?? null);
    setSideEditContent(restored?.sideDraft?.content ?? '');
    setSideBaseContent(restored?.sideDraft?.baseContent ?? '');
    setSideBaseRevision(restored?.sideDraft?.baseRevision);
    setSideBaseModifiedAt(restored?.sideDraft?.baseModifiedAt);
    setSideBaseCatalogModifiedAt(restored?.sideDraft?.baseCatalogModifiedAt);
    setSideSaving(false);
    setSideSaveError(restored?.sideDraft?.saveError ?? null);
    setSideConflict(restored?.sideDraft?.conflict ?? null);
    setSideAutoFocus(Boolean(restored?.sideDraft));
    setPendingSideAction(null);
    setStateWorkspaceId(workspaceId);
  }, [stateWorkspaceId, workspaceId]);

  useEffect(() => {
    if (!active) {
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      setNewDocOpen(false);
      setNewFolderOpen(false);
      setPendingSideAction(null);
    }
  }, [active]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const clearDrag = () => {
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
    };
    window.addEventListener('blur', clearDrag);
    return () => window.removeEventListener('blur', clearDrag);
  }, []);

  const measureWide = useCallback(() => {
    const aside = asideRef.current;
    if (!aside) return false;
    const wideNow = getComputedStyle(aside).display !== 'none';
    setIsWide((prev) => (prev === wideNow ? prev : wideNow));
    return wideNow;
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;
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

  const sideDirty = sideEditing && sideEditContent !== sideBaseContent;

  // Keep workspace-scoped unsaved drafts persisted across unmount/remount (X, Ctrl+3, Terminal, rail toggle).
  useLayoutEffect(() => {
    if (stateWorkspaceId !== workspaceId) return;
    const sideDraft: SideDocumentDraftState | null = sideEditing && sideEditPath
      ? {
          path: sideEditPath,
          folder,
          content: sideEditContent,
          baseContent: sideBaseContent,
          baseRevision: sideBaseRevision,
          baseModifiedAt: sideBaseModifiedAt,
          baseCatalogModifiedAt: sideBaseCatalogModifiedAt,
          conflict: sideConflict,
          saveError: sideSaveError,
          dirty: sideDirty,
        }
      : null;
    const hasReaderDrafts = Object.keys(readerDrafts).length > 0;
    const persistedReaderPath = hasReaderDrafts && readerPath && readerDrafts[readerPath] ? readerPath : null;
    setWorkspaceDocumentDrafts(workspaceId, {
      folder,
      sideDraft,
      readerPath: persistedReaderPath,
      readerDrafts,
    });
  }, [
    stateWorkspaceId,
    workspaceId,
    folder,
    sideEditing,
    sideEditPath,
    sideEditContent,
    sideBaseContent,
    sideBaseRevision,
    sideBaseModifiedAt,
    sideBaseCatalogModifiedAt,
    sideConflict,
    sideSaveError,
    sideDirty,
    readerPath,
    readerDrafts,
  ]);
  const sideExternalChangeNotice = Boolean(
    sideEditing
    && sideEditPath === selectedItem?.path
    && sidePreviewData
    && (
      (sideBaseRevision && sidePreviewData.revision && sidePreviewData.revision !== sideBaseRevision)
      || (sideBaseModifiedAt && sidePreviewData.modifiedAt && sidePreviewData.modifiedAt !== sideBaseModifiedAt && sidePreviewData.content !== sideBaseContent)
      || (sideBaseCatalogModifiedAt && selectedItem?.modifiedAt && selectedItem.modifiedAt !== sideBaseCatalogModifiedAt && selectedItem.modifiedAt !== sideBaseModifiedAt)
    ),
  );

  const upsertCatalogItem = useCallback(
    (entry: {
      path: string;
      kind: DocumentCatalogKind;
      size: number;
      modifiedAt: string;
      title?: string;
      excerpt?: string;
      editable?: boolean;
    }) => {
      const normalized = normalizeCatalogPath(entry.path);
      if (!normalized) return;
      const slash = normalized.lastIndexOf('/');
      const itemFolder = slash < 0 ? '' : normalized.slice(0, slash);
      const itemName = slash < 0 ? normalized : normalized.slice(slash + 1);
      const defaultEditable = entry.kind === 'markdown' || entry.kind === 'text' || entry.kind === 'html';
      queryClient.setQueryData<DocumentCatalog>(documentCatalogKey(workspaceId), (prev) => {
        if (!prev) return prev;
        const prevItem = prev.items.find((i) => i.path === normalized);
        const nextItem: DocumentCatalogItem = {
          path: normalized,
          name: itemName,
          folder: itemFolder,
          kind: entry.kind,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          title: entry.title ?? prevItem?.title ?? itemName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
          excerpt: entry.excerpt ?? prevItem?.excerpt ?? '',
          evidence: prevItem?.evidence ?? false,
          editable: entry.editable ?? prevItem?.editable ?? defaultEditable,
          ...(prevItem?.readOnlyReason ? { readOnlyReason: prevItem.readOnlyReason } : {}),
        };
        const items = prevItem
          ? prev.items.map((i) => (i.path === normalized ? nextItem : i))
          : [...prev.items, nextItem];
        const folders = [...prev.folders];
        if (itemFolder) {
          const parts = itemFolder.split('/');
          let acc = '';
          for (const part of parts) {
            const parent = acc;
            acc = acc ? `${acc}/${part}` : part;
            if (!folders.some((f) => f.path === acc)) {
              folders.push({
                path: acc,
                name: part,
                parent,
                evidence: false,
                summary: '',
                folderCount: 0,
                docCount: 0,
                pictureCount: 0,
                evidenceCount: 0,
              });
            }
          }
        }
        return {
          ...prev,
          items,
          folders,
        };
      });
    },
    [queryClient, workspaceId],
  );

  const upsertCatalogFolder = useCallback(
    (folderPath: string) => {
      const normalized = normalizeCatalogPath(folderPath);
      if (!normalized) return;
      queryClient.setQueryData<DocumentCatalog>(documentCatalogKey(workspaceId), (prev) => {
        if (!prev) return prev;
        const folders = [...prev.folders];
        const parts = normalized.split('/');
        let acc = '';
        for (const part of parts) {
          const parent = acc;
          acc = acc ? `${acc}/${part}` : part;
          if (!folders.some((f) => f.path === acc)) {
            folders.push({
              path: acc,
              name: part,
              parent,
              evidence: false,
              summary: '',
              folderCount: 0,
              docCount: 0,
              pictureCount: 0,
              evidenceCount: 0,
            });
          }
        }
        return { ...prev, folders };
      });
    },
    [queryClient, workspaceId],
  );

  const seedPreviewCache = useCallback(
    (res: DocumentSaveResult) => {
      queryClient.setQueryData<DocumentPreviewData>(['documents-page-preview', workspaceId, res.name], {
        name: res.name,
        kind: res.kind,
        size: res.size,
        modifiedAt: res.modifiedAt,
        revision: res.revision,
        content: res.content,
        editable: true,
      });
    },
    [queryClient, workspaceId],
  );

  const openReader = useCallback(
    (
      docPath: string,
      opener: HTMLElement | null,
      openerKind: 'open-button' | 'card' = 'card',
      options?: { initialEditing?: boolean },
    ) => {
      const normalized = normalizeCatalogPath(docPath);
      if (!normalized) return;
      const fromInsideReader = Boolean(opener && overlayRef.current?.contains(opener));
      if (readerPath === null && !fromInsideReader) {
        readerOpenerRef.current = opener;
        readerOpenerKindRef.current = openerKind;
        readerOpenedPathRef.current = normalized;
      }
      if (readerPath !== null && normalized !== readerPath) {
        setReaderDrafts((prev) => {
          if (!(readerPath in prev) || prev[readerPath]?.dirty) return prev;
          const next = { ...prev };
          delete next[readerPath];
          return next;
        });
      }
      lastReaderPathRef.current = normalized;
      setReaderRaw(false);
      setReaderInitialEditing(Boolean(options?.initialEditing));
      setReaderPath(normalized);
      setReaderRequest((n) => n + 1);
    },
    [readerPath],
  );

  const closeReader = useCallback(() => {
    if (readerPath) {
      setReaderDrafts((prev) => {
        if (!(readerPath in prev)) return prev;
        const next = { ...prev };
        delete next[readerPath];
        return next;
      });
    }
    setReaderPath(null);
    setReaderRaw(false);
    setReaderInitialEditing(false);
  }, [readerPath]);

  const resolveSidePostExitFocus = useCallback((): HTMLElement | null => {
    if (isElementVisible(sideEditButtonRef.current)) return sideEditButtonRef.current;
    if (isElementVisible(sideOpenInReaderRef.current)) return sideOpenInReaderRef.current;
    if (listRef.current) {
      const cards = Array.from(listRef.current.querySelectorAll<HTMLElement>('button[data-doc-path]'));
      if (selectedPath) {
        const match = cards.find((el) => el.dataset.docPath === selectedPath && isElementVisible(el));
        if (match) return match;
      }
      const firstBtn = Array.from(listRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')).find(
        (el) => isElementVisible(el),
      );
      if (firstBtn) return firstBtn;
    }
    if (isElementVisible(searchRef.current)) return searchRef.current;
    return null;
  }, [selectedPath]);

  const resolveSideKeepEditingFocus = useCallback((): HTMLElement | null => {
    if (isElementVisible(sideTextareaRef.current)) return sideTextareaRef.current;
    if (isElementVisible(sideLinkOriginRef.current)) return sideLinkOriginRef.current;
    const editorTabs = [
      asideRef.current?.querySelector<HTMLElement>('[data-testid="document-editor"] [role="tab"][aria-selected="true"]') ?? null,
      asideRef.current?.querySelector<HTMLElement>('[data-testid="document-editor"] [role="tab"]') ?? null,
      sideOpenInReaderRef.current,
    ];
    for (const candidate of editorTabs) {
      if (isElementVisible(candidate)) return candidate;
    }
    return null;
  }, []);

  const applyFolderNavigation = useCallback((nextFolder: string, via: 'card' | 'crumb') => {
    const normalized = normalizeCatalogPath(nextFolder);
    pendingFolderFocusRef.current = via;
    sideLinkOriginRef.current = null;
    setSideEditing(false);
    setSideEditPath(null);
    setSideConflict(null);
    setSideSaveError(null);
    setFolder(normalized);
    setFolderNavSeq((n) => n + 1);
    setShowEvidence(false);
    setSelectedPath(null);
    setQuery('');
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  const enterFolder = useCallback(
    (nextFolder: string, via: 'card' | 'crumb') => {
      const normalized = normalizeCatalogPath(nextFolder);
      if (normalized === folder && !isSearching) return;
      if (sideDirty) {
        sideLinkOriginRef.current = null;
        setPendingSideAction({ type: 'enter-folder', folder: normalized, via });
        return;
      }
      applyFolderNavigation(normalized, via);
    },
    [folder, isSearching, sideDirty, applyFolderNavigation],
  );

  const startSideEdit = useCallback(
    (docPath: string, previewData: DocumentPreviewData | null, focus = true) => {
      if (!previewData || previewData.content === undefined) return;
      sideLinkOriginRef.current = null;
      setSideEditPath(docPath);
      setSideEditContent(previewData.content);
      setSideBaseContent(previewData.content);
      setSideBaseRevision(previewData.revision);
      setSideBaseModifiedAt(previewData.modifiedAt);
      setSideBaseCatalogModifiedAt(selectedItem?.path === docPath ? selectedItem.modifiedAt : previewData.modifiedAt);
      setSideConflict(null);
      setSideSaveError(null);
      setSideAutoFocus(focus);
      setSideEditing(true);
    },
    [selectedItem],
  );

  const discardSideEdit = useCallback((options?: { restoreFocus?: boolean }) => {
    if (options?.restoreFocus !== undefined) {
      pendingSideExitFocusRef.current = options.restoreFocus;
    }
    sideLinkOriginRef.current = null;
    setSideEditing(false);
    setSideEditPath(null);
    setSideEditContent('');
    setSideBaseContent('');
    setSideBaseRevision(undefined);
    setSideBaseModifiedAt(undefined);
    setSideBaseCatalogModifiedAt(undefined);
    setSideConflict(null);
    setSideSaveError(null);
    setSideAutoFocus(false);
  }, []);

  // A Save button that was focused turns disabled while saving / in conflict and the browser drops
  // focus to <body>. After a failed save, move it to the conflict choices (or the text).
  const refocusAfterFailedSideSave = useCallback(() => {
    requestAnimationFrame(() => {
      if (!activeRef.current || readerPathRef.current !== null) return;
      const active = document.activeElement;
      const lost = !active || active === document.body || (active as HTMLButtonElement).disabled === true;
      if (!lost) return;
      const conflictBtn = asideRef.current?.querySelector<HTMLElement>(
        '[data-testid="document-conflict-bar"] button:not([disabled])',
      ) ?? null;
      if (isElementVisible(conflictBtn)) {
        conflictBtn.focus({ preventScroll: true });
        return;
      }
      resolveSideKeepEditingFocus()?.focus({ preventScroll: true });
    });
  }, [resolveSideKeepEditingFocus]);

  const executeSideSave = useCallback(
    async (
      expectedRevOverride?: string | null,
      options?: { restoreFocus?: boolean },
    ): Promise<boolean> => {
      const targetPath = sideEditPath ?? selectedPath;
      if (!targetPath || sideSaving) return false;
      setSideSaving(true);
      setSideSaveError(null);
      try {
        const expectedRevision = expectedRevOverride === null ? undefined : (expectedRevOverride ?? sideBaseRevision);
        const saved = await saveDocument(workspaceId, {
          name: targetPath,
          content: sideEditContent,
          ...(expectedRevision ? { expectedRevision } : {}),
        });
        seedPreviewCache(saved);
        upsertCatalogItem({
          path: saved.name,
          kind: saved.kind,
          size: saved.size,
          modifiedAt: saved.modifiedAt,
          editable: true,
        });
        void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });
        setSideBaseContent(saved.content);
        setSideBaseRevision(saved.revision);
        setSideBaseModifiedAt(saved.modifiedAt);
        setSideBaseCatalogModifiedAt(saved.modifiedAt);
        setSideConflict(null);
        if (options?.restoreFocus !== false) {
          pendingSideExitFocusRef.current = true;
        }
        setSideEditing(false);
        setSideEditPath(null);
        return true;
      } catch (error) {
        const parsed = parseDocumentConflict(error);
        if (parsed) {
          setSideConflict(parsed);
          setSideSaveError(null);
          refocusAfterFailedSideSave();
          return false;
        }
        setSideSaveError(error instanceof Error ? error.message : 'Unable to save document.');
        refocusAfterFailedSideSave();
        return false;
      } finally {
        setSideSaving(false);
      }
    },
    [sideEditPath, selectedPath, sideSaving, sideBaseRevision, workspaceId, sideEditContent, seedPreviewCache, upsertCatalogItem, queryClient, refocusAfterFailedSideSave],
  );

  const saveCopyFromContent = useCallback(
    async (basePath: string, content: string): Promise<DocumentSaveResult> => {
      const existing = new Set((catalog?.items ?? []).map((i) => i.path));
      let candidate = suggestCopyPath(basePath, existing);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const saved = await saveDocument(workspaceId, {
            name: candidate,
            content,
            createOnly: true,
          });
          seedPreviewCache(saved);
          upsertCatalogItem({
            path: saved.name,
            kind: saved.kind,
            size: saved.size,
            modifiedAt: saved.modifiedAt,
            editable: true,
          });
          void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });
          return saved;
        } catch (error) {
          const parsed = parseDocumentConflict(error);
          if (parsed?.code === 'ALREADY_EXISTS') {
            existing.add(candidate);
            candidate = suggestCopyPath(basePath, existing);
            continue;
          }
          throw error;
        }
      }
      throw new Error('Could not find an available copy filename.');
    },
    [catalog?.items, workspaceId, seedPreviewCache, upsertCatalogItem, queryClient],
  );

  const handleSideSaveAsCopy = useCallback(async () => {
    const basePath = sideEditPath ?? selectedPath;
    if (!basePath || sideSaving) return;
    setSideSaving(true);
    setSideSaveError(null);
    try {
      const saved = await saveCopyFromContent(basePath, sideEditContent);
      pendingSideExitFocusRef.current = true;
      discardSideEdit();
      setSelectedPath(saved.name);
    } catch (error) {
      setSideSaveError(error instanceof Error ? error.message : 'Unable to save copy.');
    } finally {
      setSideSaving(false);
    }
  }, [sideEditPath, selectedPath, sideSaving, saveCopyFromContent, sideEditContent, discardSideEdit]);

  const handleSideLoadLatest = useCallback(() => {
    if (!sideConflict || sideConflict.currentContent === undefined) return;
    sideLinkOriginRef.current = null;
    setSideEditContent(sideConflict.currentContent);
    setSideBaseContent(sideConflict.currentContent);
    setSideBaseRevision(sideConflict.currentRevision ?? undefined);
    setSideBaseModifiedAt(sideConflict.currentModifiedAt ?? undefined);
    setSideBaseCatalogModifiedAt(sideConflict.currentModifiedAt ?? undefined);
    setSideConflict(null);
    setSideSaveError(null);
    requestAnimationFrame(() => {
      if (!activeRef.current || readerPathRef.current !== null) return;
      if (isElementVisible(sideTextareaRef.current)) {
        sideTextareaRef.current.focus({ preventScroll: true });
      } else {
        resolveSideKeepEditingFocus()?.focus({ preventScroll: true });
      }
    });
  }, [sideConflict, resolveSideKeepEditingFocus]);

  const requestCancelSideEdit = useCallback(() => {
    if (sideDirty) {
      sideLinkOriginRef.current = null;
      setPendingSideAction({ type: 'cancel-edit' });
      return;
    }
    pendingSideExitFocusRef.current = true;
    discardSideEdit();
  }, [sideDirty, discardSideEdit]);

  const performPendingSideAction = useCallback(
    (action: PendingSideAction) => {
      switch (action.type) {
        case 'cancel-edit':
          break;
        case 'select-doc':
          if (measureWide()) {
            setSelectedPath(action.path);
          } else {
            openReader(action.path, action.opener ?? null, 'card');
          }
          break;
        case 'enter-folder':
          applyFolderNavigation(action.folder, action.via);
          break;
        case 'open-new-doc':
          setNewDocOpen(true);
          break;
        case 'open-new-folder':
          setNewFolderOpen(true);
          break;
        case 'open-reader-link':
          openReader(action.path, action.opener ?? null, 'card');
          break;
      }
    },
    [applyFolderNavigation, measureWide, openReader],
  );

  const requestOpenNewDoc = useCallback(() => {
    if (sideDirty) {
      sideLinkOriginRef.current = null;
      setPendingSideAction({ type: 'open-new-doc' });
      return;
    }
    setNewDocOpen(true);
  }, [sideDirty]);

  const requestOpenNewFolder = useCallback(() => {
    if (sideDirty) {
      sideLinkOriginRef.current = null;
      setPendingSideAction({ type: 'open-new-folder' });
      return;
    }
    setNewFolderOpen(true);
  }, [sideDirty]);

  const clearSearch = useCallback(() => {
    setQuery('');
    searchRef.current?.focus();
  }, []);

  const handleDocumentCreated = useCallback(
    (saved: DocumentSaveResult) => {
      seedPreviewCache(saved);
      upsertCatalogItem({
        path: saved.name,
        kind: saved.kind,
        size: saved.size,
        modifiedAt: saved.modifiedAt,
        editable: true,
      });
      void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });

      const slash = saved.name.lastIndexOf('/');
      const docFolder = slash < 0 ? '' : saved.name.slice(0, slash);
      if (docFolder !== folder) {
        setFolder(docFolder);
        setShowEvidence(false);
      }
      setQuery('');

      if (measureWide()) {
        setSelectedPath(saved.name);
        setSideEditPath(saved.name);
        setSideEditContent(saved.content);
        setSideBaseContent(saved.content);
        setSideBaseRevision(saved.revision);
        setSideBaseModifiedAt(saved.modifiedAt);
        setSideBaseCatalogModifiedAt(saved.modifiedAt);
        setSideConflict(null);
        setSideSaveError(null);
        setSideAutoFocus(true);
        setSideEditing(true);
      } else {
        openReader(saved.name, null, 'card', { initialEditing: true });
      }
    },
    [seedPreviewCache, upsertCatalogItem, queryClient, workspaceId, folder, measureWide, openReader],
  );

  const handleFolderCreated = useCallback(
    (created: DocumentFolderResult) => {
      upsertCatalogFolder(created.folder);
      void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });
    },
    [upsertCatalogFolder, queryClient, workspaceId],
  );

  const processUploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0 || readOnly) return;
      setUploading(true);
      const nextErrors: string[] = [];
      const nextConflicts: Array<{ id: string; file: File; folder: string; targetPath: string }> = [];
      let firstUploaded: string | null = null;

      for (const file of list) {
        const checked = validateUploadFile(file);
        if (!checked.ok) {
          nextErrors.push(checked.error);
          continue;
        }
        try {
          const uploaded = await uploadDocument(workspaceId, {
            file,
            folder,
            createOnly: true,
          });
          firstUploaded ??= uploaded.name;
          upsertCatalogItem({
            path: uploaded.name,
            kind: uploaded.kind,
            size: uploaded.size,
            modifiedAt: uploaded.modifiedAt,
            editable: uploaded.kind === 'markdown' || uploaded.kind === 'text' || uploaded.kind === 'html',
          });
        } catch (error) {
          const parsed = parseDocumentConflict(error);
          if (parsed?.code === 'ALREADY_EXISTS') {
            const targetPath = folder ? `${folder}/${checked.fileName}` : checked.fileName;
            nextConflicts.push({
              id: `${targetPath}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              file,
              folder,
              targetPath,
            });
          } else {
            nextErrors.push(`${file.name}: ${error instanceof Error ? error.message : 'Upload failed.'}`);
          }
        }
      }

      if (firstUploaded) {
        void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });
        // An upload never ends or hides an edit session: read the live state, not the closure.
        if (!sideEditingRef.current) setSelectedPath(firstUploaded);
      }
      if (nextErrors.length > 0) {
        setUploadErrors((prev) => [...prev, ...nextErrors]);
      }
      if (nextConflicts.length > 0) {
        setUploadConflicts((prev) => [...prev, ...nextConflicts]);
      }
      setUploading(false);
    },
    [readOnly, workspaceId, folder, upsertCatalogItem, queryClient],
  );

  const handleKeepBothUpload = useCallback(
    async (entry: { id: string; file: File; folder: string; targetPath: string }) => {
      setUploading(true);
      const existing = new Set((catalog?.items ?? []).map((i) => i.path));
      let candidatePath = suggestNumberedPath(entry.targetPath, existing);
      try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const nextName = candidatePath.includes('/')
            ? candidatePath.slice(candidatePath.lastIndexOf('/') + 1)
            : candidatePath;
          try {
            const uploaded = await uploadDocument(workspaceId, {
              file: entry.file,
              folder: entry.folder,
              name: nextName,
              createOnly: true,
            });
            upsertCatalogItem({
              path: uploaded.name,
              kind: uploaded.kind,
              size: uploaded.size,
              modifiedAt: uploaded.modifiedAt,
              editable: uploaded.kind === 'markdown' || uploaded.kind === 'text' || uploaded.kind === 'html',
            });
            void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });
            setUploadConflicts((prev) => prev.filter((item) => item.id !== entry.id));
            if (!sideEditingRef.current) setSelectedPath(uploaded.name);
            return;
          } catch (error) {
            const parsed = parseDocumentConflict(error);
            if (parsed?.code === 'ALREADY_EXISTS') {
              existing.add(candidatePath);
              candidatePath = suggestNumberedPath(entry.targetPath, existing);
              continue;
            }
            setUploadErrors((prev) => [
              ...prev,
              `${entry.file.name}: ${error instanceof Error ? error.message : 'Upload failed.'}`,
            ]);
            setUploadConflicts((prev) => prev.filter((item) => item.id !== entry.id));
            return;
          }
        }
        setUploadErrors((prev) => [...prev, `${entry.file.name}: Could not find an available filename.`]);
        setUploadConflicts((prev) => prev.filter((item) => item.id !== entry.id));
      } finally {
        setUploading(false);
      }
    },
    [catalog?.items, workspaceId, upsertCatalogItem, queryClient],
  );

  const handleReaderSave = useCallback(
    async (docPath: string, content: string, options?: { expectedRevision?: string }) => {
      const saved = await saveDocument(workspaceId, {
        name: docPath,
        content,
        ...(options?.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
      });
      seedPreviewCache(saved);
      upsertCatalogItem({
        path: saved.name,
        kind: saved.kind,
        size: saved.size,
        modifiedAt: saved.modifiedAt,
        editable: true,
      });
      void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });
      return saved;
    },
    [workspaceId, seedPreviewCache, upsertCatalogItem, queryClient],
  );

  const handleReaderSaveAsCopy = useCallback(
    async (basePath: string, content: string) => {
      const saved = await saveCopyFromContent(basePath, content);
      setReaderDrafts((prev) => {
        if (!(basePath in prev)) return prev;
        const next = { ...prev };
        delete next[basePath];
        return next;
      });
      setReaderInitialEditing(false);
      lastReaderPathRef.current = saved.name;
      if (selectedPath === basePath || isWide) {
        setSelectedPath(saved.name);
      }
      setReaderPath(saved.name);
      setReaderRequest((n) => n + 1);
    },
    [saveCopyFromContent, selectedPath, isWide],
  );

  const handleReaderMove = useCallback(
    async (fromPath: string, toPath: string) => {
      const res = await moveDocument(workspaceId, fromPath, toPath);
      if (res.from === res.to) return;
      setReaderDrafts((prev) => {
        if (!(res.from in prev)) return prev;
        const next = { ...prev };
        delete next[res.from];
        return next;
      });
      queryClient.removeQueries({ queryKey: ['documents-page-preview', workspaceId, res.from] });
      void queryClient.invalidateQueries({ queryKey: documentCatalogKey(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ['documents-page-preview', workspaceId, res.to] });
      if (selectedPath === res.from) setSelectedPath(res.to);
      if (readerPath === res.from) {
        lastReaderPathRef.current = res.to;
        setReaderPath(res.to);
        setReaderRequest((n) => n + 1);
      }
    },
    [workspaceId, queryClient, selectedPath, readerPath],
  );

  // Move focus into the folder view after stepping into a folder card or breadcrumb.
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
    } else if (via === 'crumb') {
      const crumbButtons = crumbsRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
      const lastCrumb = crumbButtons?.[crumbButtons.length - 1];
      if (isElementVisible(lastCrumb ?? null)) {
        lastCrumb!.focus({ preventScroll: true });
      }
    }
  }, [folder, folderNavSeq, active]);

  useLayoutEffect(() => {
    if (!active || !pendingSideExitFocusRef.current) return;
    if (sideEditing || readerPath !== null || pendingSideAction || newDocOpen || newFolderOpen) return;
    pendingSideExitFocusRef.current = false;
    resolveSidePostExitFocus()?.focus({ preventScroll: true });
  }, [active, sideEditing, selectedPath, readerPath, pendingSideAction, newDocOpen, newFolderOpen, resolveSidePostExitFocus]);

  const prevReaderFocusRef = useRef<{ active: boolean; readerPath: string | null; readerRequest: number }>({
    active,
    readerPath,
    readerRequest,
  });

  useEffect(() => {
    if (!active || !sideEditing || !sideAutoFocus || newDocOpen) return;
    const frame = requestAnimationFrame(() => {
      sideTextareaRef.current?.focus({ preventScroll: true });
      setSideAutoFocus(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, sideEditing, sideAutoFocus, newDocOpen]);

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

      const wantsEditFocus = readerInitialEditing || Boolean(readerDrafts[readerPath]?.editing);
      const findFocusTarget = () => {
        if (wantsEditFocus) {
          const textarea = overlayRef.current?.querySelector<HTMLElement>('textarea');
          if (textarea) return textarea;
        }
        return overlayRef.current?.querySelector<HTMLElement>('button[aria-label="Close document"]') ?? null;
      };

      const target = findFocusTarget();
      if (target && (!wantsEditFocus || target.tagName === 'TEXTAREA')) {
        target.focus({ preventScroll: true });
      } else {
        const frame = requestAnimationFrame(() => {
          findFocusTarget()?.focus({ preventScroll: true });
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
  }, [readerPath, readerRequest, active, readerInitialEditing, readerDrafts]);

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
          const insideReader = event.target instanceof Node && Boolean(overlayRef.current?.contains(event.target));
          if (isTypingTarget(event.target) && !insideReader) return;
          event.preventDefault();
          if (readerRequestCloseRef.current) {
            readerRequestCloseRef.current();
          } else {
            closeReader();
          }
          return;
        }
        if (sideEditing && event.target instanceof Node && rootRef.current?.contains(event.target)) {
          if (isTypingTarget(event.target) && !asideRef.current?.contains(event.target)) return;
          event.preventDefault();
          requestCancelSideEdit();
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
  }, [active, readerPath, closeReader, sideEditing, requestCancelSideEdit]);

  // Escape inside a sandboxed HTML document iframe relays ESCAPE_MESSAGE.
  useEffect(() => {
    if (!active || readerPath === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data !== ESCAPE_MESSAGE || !event.source) return;
      if (isCodeWindowOpen()) return;
      if (hasVisibleOverlay()) return;
      const frames = overlayRef.current?.querySelectorAll('iframe') ?? [];
      if (Array.from(frames).some((frame) => frame.contentWindow === event.source)) {
        if (readerRequestCloseRef.current) {
          readerRequestCloseRef.current();
        } else {
          closeReader();
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [active, readerPath, closeReader]);

  const promoteSideEditToReader = useCallback(
    (docPath: string, opener: HTMLElement | null, openerKind: 'open-button' | 'card') => {
      if (sideEditing && sideEditPath === docPath) {
        setReaderDrafts((prev) => ({
          ...prev,
          [docPath]: {
            editing: true,
            dirty: sideDirty,
            draft: sideEditContent,
            baseContent: sideBaseContent,
            baseRevision: sideBaseRevision,
            baseModifiedAt: sideBaseModifiedAt,
          },
        }));
        pendingSideExitFocusRef.current = false;
        discardSideEdit();
        openReader(docPath, opener, openerKind, { initialEditing: true });
        return;
      }
      openReader(docPath, opener, openerKind);
    },
    [sideEditing, sideEditPath, sideDirty, sideEditContent, sideBaseContent, sideBaseRevision, sideBaseModifiedAt, discardSideEdit, openReader],
  );

  // When container narrows below 56rem (Split chat toggled, Ask in CLI, resize), promote active side edit into Reader.
  useLayoutEffect(() => {
    if (!active || isWide || !sideEditing || !sideEditPath || readerPath !== null || pendingSideAction) {
      return;
    }
    if (measureWide()) return;
    const matchingCard =
      listRef.current
        ? Array.from(listRef.current.querySelectorAll<HTMLElement>('button[data-doc-path]')).find(
            (el) => el.dataset.docPath === sideEditPath && isElementVisible(el),
          ) ?? null
        : null;
    promoteSideEditToReader(sideEditPath, matchingCard, 'card');
  }, [active, isWide, sideEditing, sideEditPath, readerPath, pendingSideAction, measureWide, promoteSideEditToReader]);

  const handleReaderDraftStateChange = useCallback(
    (docPath: string, state: ReaderDraftState) => {
      if (!state.editing && docPath === readerPath) {
        setReaderInitialEditing(false);
      }
      setReaderDrafts((prev) => {
        if (!state.editing && !state.dirty) {
          if (!(docPath in prev)) return prev;
          const next = { ...prev };
          delete next[docPath];
          return next;
        }
        const cur = prev[docPath];
        if (
          cur
          && cur.editing === state.editing
          && cur.dirty === state.dirty
          && cur.draft === state.draft
          && cur.baseContent === state.baseContent
          && cur.baseRevision === state.baseRevision
          && cur.baseModifiedAt === state.baseModifiedAt
        ) {
          return prev;
        }
        return { ...prev, [docPath]: state };
      });
    },
    [readerPath],
  );

  const handleCardClick = useCallback(
    (item: DocumentCatalogItem, target: HTMLElement) => {
      if (measureWide()) {
        if (selectedPath === item.path) return;
        if (sideDirty) {
          sideLinkOriginRef.current = null;
          setPendingSideAction({ type: 'select-doc', path: item.path });
          return;
        }
        if (sideEditing) discardSideEdit();
        setSelectedPath(item.path);
      } else {
        if (sideEditing && sideEditPath === item.path) {
          promoteSideEditToReader(item.path, target, 'card');
          return;
        }
        if (sideDirty) {
          sideLinkOriginRef.current = null;
          setPendingSideAction({ type: 'select-doc', path: item.path, opener: target });
          return;
        }
        if (sideEditing) discardSideEdit();
        openReader(item.path, target, 'card');
      }
    },
    [measureWide, selectedPath, sideDirty, sideEditing, sideEditPath, discardSideEdit, promoteSideEditToReader, openReader],
  );

  const handleCardDoubleClick = useCallback(
    (item: DocumentCatalogItem, target: HTMLElement) => {
      if (measureWide()) {
        if (sideDirty && sideEditPath !== item.path) return;
        promoteSideEditToReader(item.path, target, 'card');
      }
    },
    [measureWide, sideDirty, sideEditPath, promoteSideEditToReader],
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

  const makeSideEditorLinks = useCallback(
    (docPath: string): MarkdownDocumentLinks => ({
      workspaceRoot: workspacePath,
      documentPath: docPath,
      resolveReferences: true,
      fileUrl: (name) => documentFileUrl(workspaceId, name),
      onOpenFile: (linkedPath) => {
        const targetNorm = normalizeCatalogPath(linkedPath);
        const editNorm = sideEditPath ? normalizeCatalogPath(sideEditPath) : '';
        if (sideEditing && targetNorm && editNorm && targetNorm === editNorm) {
          return;
        }
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (sideDirty) {
          sideLinkOriginRef.current = opener;
          setPendingSideAction({ type: 'open-reader-link', path: linkedPath, opener });
          return;
        }
        if (sideEditing) {
          discardSideEdit({ restoreFocus: false });
        }
        openReader(linkedPath, opener, 'card');
      },
    }),
    [workspaceId, workspacePath, sideEditing, sideEditPath, sideDirty, discardSideEdit, openReader],
  );

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
    const countsText = formatFolderCounts(entry, { evidence: entry.evidence }) || (!entry.evidence ? 'Empty' : '');
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

  const availableFolders = useMemo(
    () => (catalog?.folders ?? []).filter((entry) => !entry.evidence).map((entry) => entry.path),
    [catalog?.folders],
  );

  const activeSideDoc: DocumentCatalogItem | null = selectedItem ?? (
    sideEditing && sideEditPath
      ? {
          path: sideEditPath,
          name: sideEditPath.split('/').pop() ?? sideEditPath,
          folder: sideEditPath.includes('/') ? sideEditPath.slice(0, sideEditPath.lastIndexOf('/')) : '',
          kind: inferKindFromPath(sideEditPath),
          size: sideEditContent.length,
          modifiedAt: sideBaseModifiedAt ?? '',
          title: sideEditPath.split('/').pop() ?? sideEditPath,
          excerpt: '',
          evidence: false,
          editable: true,
        }
      : null
  );
  const selectedManagedReadOnly = activeSideDoc ? isManagedReadOnlyItem(activeSideDoc) : false;
  const selectedReadOnlyReason = sidePreviewData?.readOnlyReason ?? activeSideDoc?.readOnlyReason;
  const selectedEditable = Boolean(
    !readOnly
    && activeSideDoc
    && activeSideDoc.editable
    && (sidePreviewData?.editable ?? true)
    && !selectedManagedReadOnly
    && (activeSideDoc.kind === 'markdown' || activeSideDoc.kind === 'text' || activeSideDoc.kind === 'html'),
  );
  const sideMissingOnDisk = Boolean(catalog && sideEditing && sideEditPath && !selectedItem);

  const readerManagedReadOnly = readerPath
    ? (readerItem ? isManagedReadOnlyItem(readerItem) : readerPath.toLowerCase() === 'agents.md')
    : false;
  const readerReadOnlyReason = readerPreviewData?.readOnlyReason ?? readerItem?.readOnlyReason;
  const readerEditable = Boolean(
    !readOnly
    && readerPath
    && (readerItem ? readerItem.editable : true)
    && (readerPreviewData?.editable ?? true)
    && !readerManagedReadOnly
    && (readerKind === 'markdown' || readerKind === 'text' || readerKind === 'html'),
  );

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (readOnly || readerPath !== null || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (readOnly || readerPath !== null || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (readOnly || readerPath !== null) return;
    if (!event.dataTransfer?.types?.includes('Files')) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (readOnly || readerPath !== null) return;
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    void processUploadFiles(event.dataTransfer.files);
  };

  const pendingActionLabel = pendingSideAction
    ? pendingSideAction.type === 'cancel-edit'
      ? 'Discard your edits and exit editing?'
      : pendingSideAction.type === 'select-doc' || pendingSideAction.type === 'open-reader-link'
        ? `Discard your edits and open "${pendingSideAction.path}"?`
        : pendingSideAction.type === 'enter-folder'
          ? `Discard your edits and open "${pendingSideAction.folder || 'All documents'}"?`
          : pendingSideAction.type === 'open-new-doc'
            ? 'Discard your edits and create a new document?'
            : 'Discard your edits and create a new folder?'
    : '';

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

        <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 @[52rem]:ml-auto @[52rem]:w-auto @[52rem]:shrink-0">
          <div className="relative min-w-0 basis-full @[28rem]:flex-1 @[28rem]:basis-52 @[64rem]:w-84 @[64rem]:flex-initial">
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
                  clearSearch();
                }
              }}
              placeholder="Find a document by title, words or path"
              aria-label="Find a document by title, words or path"
              className={cn('w-full pl-5 sm:text-[length:var(--type-ui-size)]', query ? 'pr-7' : 'pr-0.5')}
            />
            {query && (
              <IconButton
                size="xs"
                label="Clear search"
                icon={<X />}
                onClick={clearSearch}
                className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2"
              />
            )}
          </div>
          {!readOnly && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Button
                ref={newDocTriggerRef}
                type="button"
                size="sm"
                variant={sideEditing ? 'outline' : 'default'}
                data-testid="new-document-button"
                onClick={requestOpenNewDoc}
              >
                <FilePlus aria-hidden="true" />
                <span>New document</span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="upload-document-button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? <Spinner aria-hidden="true" className="size-3.5" /> : <Upload aria-hidden="true" />}
                <span>{uploading ? 'Uploading…' : 'Upload'}</span>
              </Button>
              <Button
                ref={newFolderTriggerRef}
                type="button"
                size="sm"
                variant="outline"
                data-testid="new-folder-button"
                onClick={requestOpenNewFolder}
              >
                <FolderPlus aria-hidden="true" />
                <span>New folder</span>
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={(event) => {
                  if (event.target.files && event.target.files.length > 0) {
                    void processUploadFiles(event.target.files);
                  }
                  event.target.value = '';
                }}
              />
            </div>
          )}
          {panelActions}
        </div>
      </header>

      {/* Main content area: single-column when < 56rem, split list + 380px preview when >= 56rem */}
      <div
        inert={active && readerPath !== null ? true : undefined}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="grid min-h-0 flex-1 grid-cols-1 @[56rem]:grid-cols-[minmax(0,1fr)_380px]"
      >
        <section
          ref={listRef}
          aria-label="Documents list"
          className="@container min-h-0 min-w-0 overflow-y-auto px-4 pb-10 pt-4 @[48rem]:px-5"
        >
          {isDraggingFiles && !readOnly && (
            <div
              role="status"
              data-testid="documents-drop-zone"
              className="pointer-events-none sticky top-2 z-10 mb-4 rounded-card border-2 border-dashed border-primary bg-card/95 px-4 py-3 text-center text-xs font-medium leading-4 text-foreground shadow-sm"
            >
              Drop files to add to {folder ? `"${folder}"` : 'workspace root'}
            </div>
          )}

          {uploadErrors.length > 0 && (
            <Alert variant="error" role="alert" data-testid="upload-error-banner" className="mb-4 py-2.5 text-xs">
              <AlertTitle className="text-xs font-semibold leading-4 text-foreground">
                Upload could not complete
              </AlertTitle>
              <AlertDescription className="gap-0.5 text-xs leading-4 text-foreground">
                {uploadErrors.map((errMsg, index) => (
                  <p key={`${index}-${errMsg}`}>{errMsg}</p>
                ))}
              </AlertDescription>
              <AlertAction>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setUploadErrors([])}
                >
                  Dismiss
                </Button>
              </AlertAction>
            </Alert>
          )}

          {uploadConflicts.map((entry) => (
            <Alert key={entry.id} variant="warning" role="alert" data-testid="upload-conflict-banner" className="mb-4 py-2.5 text-xs">
              <AlertDescription className="text-xs leading-4 text-foreground">
                <span>
                  <span className="font-mono">{entry.targetPath}</span> already exists. Keep both or skip?
                </span>
              </AlertDescription>
              <AlertAction className="flex-wrap">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={uploading}
                  onClick={() => void handleKeepBothUpload(entry)}
                >
                  Keep both
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={uploading}
                  onClick={() => setUploadConflicts((prev) => prev.filter((item) => item.id !== entry.id))}
                >
                  Skip
                </Button>
              </AlertAction>
            </Alert>
          ))}
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
                    onClick={clearSearch}
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
                  {!readOnly && (
                    <div className="mt-3 flex flex-wrap justify-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={requestOpenNewDoc}
                      >
                        <FilePlus aria-hidden="true" />
                        <span>New document</span>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={uploading}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Upload aria-hidden="true" />
                        <span>Upload files</span>
                      </Button>
                    </div>
                  )}
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
          {!activeSideDoc ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[length:var(--type-ui-size)] leading-[var(--type-ui-leading)] text-muted-foreground">
              Pick a document or picture to see its preview here.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 space-y-2 border-b border-border p-4">
                <h3 className="break-words text-base font-semibold leading-snug text-foreground">
                  {activeSideDoc.title}
                </h3>
                <p className="break-all font-mono text-xs leading-4 text-muted-foreground">
                  {activeSideDoc.path}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs leading-4 text-muted-foreground">
                  <KindLabel kind={kindLabelFor(activeSideDoc.kind)} className="text-xs leading-4" />
                  <span className="tabular-nums">{formatFileSize(activeSideDoc.size)}</span>
                  {activeSideDoc.modifiedAt && (
                    <span className="tabular-nums">{agoText(activeSideDoc.modifiedAt, nowDate)}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    ref={sideOpenInReaderRef}
                    size="sm"
                    variant="outline"
                    data-testid="open-in-reader"
                    onClick={(e) => promoteSideEditToReader(activeSideDoc.path, e.currentTarget, 'open-button')}
                  >
                    Open in reader
                  </Button>
                  {selectedEditable && !(sideEditing && sideEditPath === activeSideDoc.path) && (
                    <Button
                      ref={sideEditButtonRef}
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="side-edit-button"
                      disabled={!sidePreviewData || sidePreviewQuery.isError}
                      onClick={() => startSideEdit(activeSideDoc.path, sidePreviewData, true)}
                    >
                      <Edit3 aria-hidden="true" />
                      <span>Edit</span>
                    </Button>
                  )}
                  {!readOnly && askInCLI && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => askInCLI(askCard({ kind: 'file', title: activeSideDoc.title, path: activeSideDoc.path }))}
                    >
                      <Terminal aria-hidden="true" />
                      <span>Ask in CLI</span>
                    </Button>
                  )}
                </div>
                {!readOnly && selectedReadOnlyReason && (
                  <p data-testid="doc-readonly-reason" className="pt-0.5 text-xs leading-4 text-muted-foreground">
                    {selectedReadOnlyReason}
                  </p>
                )}
              </div>

              <div
                className={cn(
                  'min-h-0 min-w-0 flex-1 p-4',
                  sideEditing && sideEditPath === activeSideDoc.path
                    ? 'flex flex-col overflow-hidden'
                    : 'overflow-auto wrap-anywhere',
                )}
              >
                {sideEditing && sideEditPath === activeSideDoc.path ? (
                  <DocumentEditor
                    docPath={activeSideDoc.path}
                    kind={
                      activeSideDoc.kind === 'markdown' || activeSideDoc.kind === 'html'
                        ? activeSideDoc.kind
                        : 'text'
                    }
                    value={sideEditContent}
                    onChange={setSideEditContent}
                    dirty={sideDirty}
                    saving={sideSaving}
                    saveError={sideSaveError}
                    externalChangeNotice={sideExternalChangeNotice || sideMissingOnDisk}
                    conflict={sideConflict}
                    onSave={() => void executeSideSave()}
                    onCancel={requestCancelSideEdit}
                    onOverwriteConflict={() => void executeSideSave(sideConflict?.currentRevision ?? null)}
                    onSaveAsCopy={() => void handleSideSaveAsCopy()}
                    onLoadLatest={handleSideLoadLatest}
                    links={makeSideEditorLinks(activeSideDoc.path)}
                    fileUrl={documentFileUrl(workspaceId, activeSideDoc.path)}
                    autoFocus={sideAutoFocus}
                    compact
                    showActions
                    textareaRef={sideTextareaRef}
                  />
                ) : sidePreviewData ? (
                  <DocumentPreview
                    preview={sidePreviewData}
                    fileUrl={documentFileUrl(workspaceId, activeSideDoc.path)}
                    raw={false}
                    trusted
                    links={makeMarkdownLinks(activeSideDoc.path)}
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
            editable={readerEditable}
            onSave={
              readerEditable
                ? (content, options) => handleReaderSave(readerPath, content, options)
                : undefined
            }
            onSaveAsCopy={
              readerEditable
                ? (content) => handleReaderSaveAsCopy(readerPath, content)
                : undefined
            }
            onMove={
              !readOnly && !readerManagedReadOnly
                ? (to) => handleReaderMove(readerPath, to)
                : undefined
            }
            notice={
              !readOnly && readerReadOnlyReason ? (
                <p
                  data-testid="reader-readonly-reason"
                  className="mb-3 shrink-0 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-4 text-muted-foreground"
                >
                  {readerReadOnlyReason}
                </p>
              ) : undefined
            }
            initialEditing={readerInitialEditing || Boolean(readerDrafts[readerPath]?.editing)}
            initialDraft={readerDrafts[readerPath]}
            onDraftStateChange={(state) => handleReaderDraftStateChange(readerPath, state)}
            externalModifiedAt={readerItem?.modifiedAt}
            requestCloseRef={readerRequestCloseRef}
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

      {!readOnly && (
        <>
          <NewDocumentDialog
            open={active && newDocOpen}
            onOpenChange={setNewDocOpen}
            workspaceId={workspaceId}
            initialFolder={folder}
            availableFolders={availableFolders}
            returnFocusRef={newDocTriggerRef}
            onCreated={handleDocumentCreated}
          />
          <NewFolderDialog
            open={active && newFolderOpen}
            onOpenChange={setNewFolderOpen}
            workspaceId={workspaceId}
            parentFolder={folder}
            returnFocusRef={newFolderTriggerRef}
            onCreated={handleFolderCreated}
          />
        </>
      )}

      {active && pendingSideAction && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              sideAlertExitModeRef.current = 'keep';
              setPendingSideAction(null);
              requestAnimationFrame(() => {
                if (!activeRef.current || newDocOpenRef.current || newFolderOpenRef.current || readerPathRef.current !== null) {
                  return;
                }
                if (sideEditingRef.current) {
                  resolveSideKeepEditingFocus()?.focus({ preventScroll: true });
                } else {
                  resolveSidePostExitFocus()?.focus({ preventScroll: true });
                }
              });
            }
          }}
        >
          <AlertDialogPopup
            initialFocus={keepSideEditingRef}
            finalFocus={() => {
              if (
                !activeRef.current
                || sideAlertExitModeRef.current === 'discard-away'
                || newDocOpenRef.current
                || newFolderOpenRef.current
                || readerPathRef.current !== null
              ) {
                return false;
              }
              if (sideEditingRef.current) {
                return resolveSideKeepEditingFocus() ?? false;
              }
              return resolveSidePostExitFocus() ?? false;
            }}
            data-testid="side-discard-dialog"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
              <AlertDialogDescription>{pendingActionLabel}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                ref={keepSideEditingRef}
                type="button"
                variant="outline"
                autoFocus
                onClick={() => {
                  sideAlertExitModeRef.current = 'keep';
                  setPendingSideAction(null);
                  requestAnimationFrame(() => {
                    if (!activeRef.current || readerPathRef.current !== null) return;
                    resolveSideKeepEditingFocus()?.focus({ preventScroll: true });
                  });
                }}
              >
                Keep editing
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                onClick={() => {
                  const action = pendingSideAction;
                  const stayInSide = Boolean(
                    action
                    && (action.type === 'cancel-edit' || (action.type === 'select-doc' && measureWide())),
                  );
                  sideAlertExitModeRef.current = stayInSide ? 'discard-stay' : 'discard-away';
                  setPendingSideAction(null);
                  discardSideEdit({ restoreFocus: stayInSide });
                  if (action) performPendingSideAction(action);
                }}
              >
                Discard changes
              </Button>
              <Button
                type="button"
                variant="default"
                disabled={sideSaving || sideConflict !== null}
                onClick={() => {
                  const action = pendingSideAction;
                  const stayInSide = Boolean(
                    action
                    && (action.type === 'cancel-edit' || (action.type === 'select-doc' && measureWide())),
                  );
                  sideAlertExitModeRef.current = stayInSide ? 'discard-stay' : 'discard-away';
                  void executeSideSave(undefined, { restoreFocus: stayInSide }).then((ok) => {
                    if (!ok) {
                      sideAlertExitModeRef.current = 'keep';
                      pendingSideExitFocusRef.current = false;
                      setPendingSideAction(null);
                      requestAnimationFrame(() => {
                        if (!activeRef.current || readerPathRef.current !== null) return;
                        const conflictBtn = asideRef.current?.querySelector<HTMLElement>(
                          '[data-testid="document-conflict-bar"] button:not([disabled])',
                        ) ?? null;
                        if (isElementVisible(conflictBtn)) {
                          conflictBtn.focus({ preventScroll: true });
                          return;
                        }
                        resolveSideKeepEditingFocus()?.focus({ preventScroll: true });
                      });
                      return;
                    }
                    setPendingSideAction(null);
                    if (action) performPendingSideAction(action);
                  });
                }}
              >
                {sideSaving ? 'Saving…' : 'Save & continue'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </div>
  );
}
