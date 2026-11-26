import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Code2, Copy, Download, Edit3, ExternalLink, Eye, FolderInput, Maximize2, Minimize2, MoreHorizontal, Save, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  Button,
  buttonVariants,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from '../../design/index.js';
import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { DiagramFullScreenContext } from '../../components/diagramFixContext.js';
import { copyPictureToClipboard, safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils';
import type { ReaderLineTools } from '../board/ReaderLines.js';
import { DocumentEditor } from '../documents/DocumentEditor.js';
import { parseDocumentConflict, type DocumentConflictDetails } from '../documents/documentMutations.js';
import { isCodeWindowOpen } from '../workspace-shell/codeWindowOpen.js';
import { DocumentPreview, type DocumentPreviewData } from './DocumentPreview.js';
import { ESCAPE_MESSAGE } from './previewPolicy.js';

/** Matches the app's existing overlay idiom (dialog.tsx, PluggableDiffViewer, WorktreeTitleModal). */
const OVERLAY = 'fixed inset-0 z-[100] flex flex-col bg-background';

type DocumentViewerDiscardAction =
  | { type: 'cancel-edit' }
  | { type: 'close-reader' }
  | { type: 'open-link'; path: string; line?: number };

function normalizeDocPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

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

export interface DocumentViewerProps {
  title: string;
  lineTools?: ReaderLineTools;
  /** Null while the preview request is in flight; `status` is shown in the body instead. */
  preview: DocumentPreviewData | null;
  status?: ReactNode;
  fileUrl?: string;
  downloadHref?: string;
  /**
   * Link that hands the document to the real browser, where it renders as authored. Separate from
   * `downloadHref` on purpose: downloading and rendering are different trust decisions, and a user
   * who saved the file should not have also granted it browser-level script execution.
   */
  browserHref?: string;
  /** Forwarded to the renderer so markdown documents can follow links to sibling files. */
  links?: MarkdownDocumentLinks;
  raw: boolean;
  /** Omit to hide the raw/rendered toggle, which is what a non-markdown/non-HTML document wants. */
  onToggleRaw?: () => void;
  rawLabels?: [string, string];
  onClose?: () => void;
  compact?: boolean;
  /**
   * Fills its container: one slim header row and a body that scrolls on its own, for a reader that
   * takes the panel's whole height. `leading` goes at the start of that row (navigation, Back).
   */
  fill?: boolean;
  /**
   * With `fill`: the frame of an HTML page (or a PDF) takes the whole height of the body, which then does not scroll, so the
   * page scrolls on its own and nothing scrolls twice. Other documents still scroll in the body. Without it the frame is a
   * fixed share of the screen's height and the body scrolls around it.
   */
  fillFrame?: boolean;
  /** With `fill`: no row of its own: the reader around it draws the title and the actions. */
  chromeless?: boolean;
  leading?: ReactNode;
  notice?: ReactNode;
  className?: string;
  /** Live watch status and toggle handler */
  watching?: boolean;
  onToggleWatch?: () => void;
  /** Enable editing and saving document directly */
  editable?: boolean;
  onSave?: (
    content: string,
    options?: { expectedRevision?: string },
  ) => Promise<{ revision?: string; content?: string; modifiedAt?: string } | void> | void;
  /** Save a copy to a new path when resolving a 409 conflict */
  onSaveAsCopy?: (content: string) => Promise<void> | void;
  /** Move or rename document */
  onMove?: (to: string) => Promise<void> | void;
  /** Initial editing state (useful for tests or opening directly in edit mode) */
  initialEditing?: boolean;
  /** Optional initial unsaved draft (e.g. restored after switching tabs) */
  initialDraft?: {
    draft: string;
    baseContent: string;
    baseRevision?: string;
    baseModifiedAt?: string;
  };
  /** Reports live editing / dirty state to parent containers */
  onDraftStateChange?: (state: {
    editing: boolean;
    dirty: boolean;
    draft: string;
    baseContent: string;
    baseRevision?: string;
    baseModifiedAt?: string;
  }) => void;
  /** Latest catalog modifiedAt to surface external disk updates while editing */
  externalModifiedAt?: string;
  /** Exposes close-request handler (honors dirty guard) for parent Escape shortcuts */
  requestCloseRef?: React.MutableRefObject<(() => void) | null>;
  /** Direct click handler for image preview (e.g. toggle full screen) */
  onImageClick?: () => void;
  /** Controlled image expanded state (e.g. driven by BoardReader fullscreen) */
  imageExpanded?: boolean;
}

/**
 * Owns the maximize affordance for every document surface. Expanding fills the app viewport inside
 * the app's own borders — `fixed inset-0` portaled to `document.body` above the app shell, never the
 * browser Fullscreen API — so Download and the raw toggle stay reachable, and
 * docked side panels like the chat cannot overlap it.
 */
export function DocumentViewer({
  title,
  preview,
  status,
  fileUrl = '',
  downloadHref,
  browserHref,
  links,
  raw,
  onToggleRaw,
  rawLabels = ['View source', 'View page'],
  onClose,
  compact = false,
  fill = false,
  fillFrame = false,
  chromeless = false,
  leading,
  notice,
  className,
  watching = false,
  onToggleWatch,
  editable,
  onSave,
  onSaveAsCopy,
  onMove,
  initialEditing = false,
  initialDraft,
  onDraftStateChange,
  externalModifiedAt,
  requestCloseRef,
  onImageClick,
  imageExpanded,
  lineTools,
}: DocumentViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(initialEditing);
  const [editorTab, setEditorTab] = useState<'write' | 'preview'>('write');
  const [editContent, setEditContent] = useState(() => initialDraft?.draft ?? preview?.content ?? '');
  const [baseContent, setBaseContent] = useState(() => initialDraft?.baseContent ?? preview?.content ?? '');
  const [baseRevision, setBaseRevision] = useState<string | undefined>(() => initialDraft?.baseRevision ?? preview?.revision);
  const [baseModifiedAt, setBaseModifiedAt] = useState<string | undefined>(() => initialDraft?.baseModifiedAt ?? preview?.modifiedAt);
  const [baseCatalogModifiedAt, setBaseCatalogModifiedAt] = useState<string | undefined>(() => externalModifiedAt);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DocumentConflictDetails | null>(null);
  const [discardPrompt, setDiscardPrompt] = useState<DocumentViewerDiscardAction | null>(null);
  const [restoreExpandedAfterPrompt, setRestoreExpandedAfterPrompt] = useState(false);
  const [pictureCopyStatus, setPictureCopyStatus] = useState<{ ok: boolean; message: string; repeat: boolean } | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetPath, setTargetPath] = useState('');
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const viewerRootRef = useRef<HTMLDivElement>(null);
  const inlineToggle = useRef<HTMLButtonElement>(null);
  const overlayToggle = useRef<HTMLButtonElement>(null);
  const inlineEditRef = useRef<HTMLButtonElement>(null);
  const overlayEditRef = useRef<HTMLButtonElement>(null);
  const inlineCloseRef = useRef<HTMLButtonElement>(null);
  const overlayCloseRef = useRef<HTMLButtonElement>(null);
  const moreInline = useRef<HTMLButtonElement>(null);
  const overlayMoreRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const keepEditingButtonRef = useRef<HTMLButtonElement>(null);
  const linkOriginRef = useRef<HTMLElement | null>(null);
  const pendingEditExitFocusRef = useRef(false);
  const viewerAlertExitModeRef = useRef<'keep' | 'exit-edit' | 'leave-doc'>('keep');
  const wasExpanded = useRef(false);
  const mountedRef = useRef(true);
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPictureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPictureGenRef = useRef(0);
  const seededInitialEditRef = useRef(Boolean(initialDraft || preview?.content !== undefined));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveStatusTimerRef.current) {
        clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = null;
      }
      if (copyPictureTimerRef.current) {
        clearTimeout(copyPictureTimerRef.current);
        copyPictureTimerRef.current = null;
      }
      if (copyPathTimerRef.current) {
        clearTimeout(copyPathTimerRef.current);
        copyPathTimerRef.current = null;
      }
      setPictureCopyStatus(null);
    };
  }, []);

  const handleMoveSubmit = async () => {
    if (!onMove || moving || !targetPath.trim()) return;
    setMoving(true);
    setMoveError(null);
    try {
      await onMove(targetPath.trim());
      if (!mountedRef.current) return;
      setMoveOpen(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setMoveError(err instanceof Error ? err.message : 'Failed to move document');
    } finally {
      if (mountedRef.current) {
        setMoving(false);
      }
    }
  };

  // Edit state lapses when a different document is opened.
  const currentDocName = preview?.name ?? title;
  const previousDocName = useRef(currentDocName);
  useEffect(() => {
    if (currentDocName && previousDocName.current !== currentDocName) {
      previousDocName.current = currentDocName;
      seededInitialEditRef.current = false;
      setExpanded(false);
      setEditing(false);
      setEditorTab('write');
      linkOriginRef.current = null;
      setEditContent(preview?.content ?? '');
      setBaseContent(preview?.content ?? '');
      setBaseRevision(preview?.revision);
      setBaseModifiedAt(preview?.modifiedAt);
      setBaseCatalogModifiedAt(externalModifiedAt);
      setConflict(null);
      setDiscardPrompt(null);
      setSaveStatus(null);
      if (saveStatusTimerRef.current) {
        clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = null;
      }
      if (copyPathTimerRef.current) {
        clearTimeout(copyPathTimerRef.current);
        copyPathTimerRef.current = null;
      }
      setPictureCopyStatus(null);
      if (copyPictureTimerRef.current) {
        clearTimeout(copyPictureTimerRef.current);
        copyPictureTimerRef.current = null;
      }
    }
  }, [currentDocName, preview?.content, preview?.revision, preview?.modifiedAt, externalModifiedAt]);

  useEffect(() => {
    if (!editing && preview?.content !== undefined) {
      setEditContent(preview.content);
      setBaseContent(preview.content);
      setBaseRevision(preview.revision);
      setBaseModifiedAt(preview.modifiedAt);
      setBaseCatalogModifiedAt(externalModifiedAt);
      seededInitialEditRef.current = false;
    } else if (editing && !seededInitialEditRef.current && preview?.content !== undefined) {
      seededInitialEditRef.current = true;
      setEditContent(preview.content);
      setBaseContent(preview.content);
      setBaseRevision(preview.revision);
      setBaseModifiedAt(preview.modifiedAt);
      setBaseCatalogModifiedAt(externalModifiedAt);
    }
  }, [preview?.content, preview?.revision, preview?.modifiedAt, editing, externalModifiedAt]);

  const dirty = editing && editContent !== baseContent;

  const onDraftStateChangeRef = useRef(onDraftStateChange);
  useEffect(() => {
    onDraftStateChangeRef.current = onDraftStateChange;
  }, [onDraftStateChange]);
  useEffect(() => {
    onDraftStateChangeRef.current?.({
      editing,
      dirty,
      draft: editContent,
      baseContent,
      baseRevision,
      baseModifiedAt,
    });
  }, [editing, dirty, editContent, baseContent, baseRevision, baseModifiedAt]);

  const canEdit =
    (editable ?? Boolean(onSave))
    && preview
    && (preview.kind === 'markdown' || preview.kind === 'html' || preview.kind === 'text')
    && preview.content !== undefined;

  const externalChangeNotice = Boolean(
    editing
    && preview
    && (
      (baseRevision && preview.revision && preview.revision !== baseRevision)
      || (baseModifiedAt && preview.modifiedAt && preview.modifiedAt !== baseModifiedAt && preview.content !== baseContent)
      || (baseCatalogModifiedAt && externalModifiedAt && externalModifiedAt !== baseCatalogModifiedAt && externalModifiedAt !== baseModifiedAt)
    ),
  );

  const resolvePostEditExitFocus = useCallback(
    (preferExpanded = expanded): HTMLElement | null => {
      const primary = preferExpanded
        ? [overlayEditRef.current, overlayToggle.current, overlayCloseRef.current, overlayMoreRef.current]
        : [inlineEditRef.current, inlineToggle.current, inlineCloseRef.current, moreInline.current];
      const secondary = preferExpanded
        ? [inlineEditRef.current, inlineToggle.current, inlineCloseRef.current, moreInline.current]
        : [overlayEditRef.current, overlayToggle.current, overlayCloseRef.current, overlayMoreRef.current];
      for (const candidate of [...primary, ...secondary]) {
        if (isElementVisible(candidate)) return candidate;
      }
      return null;
    },
    [expanded],
  );

  const resolveKeepEditingFocus = useCallback((): HTMLElement | null => {
    if (isElementVisible(editorTextareaRef.current)) return editorTextareaRef.current;
    if (isElementVisible(linkOriginRef.current)) return linkOriginRef.current;
    const container = expanded ? overlayRef.current : viewerRootRef.current;
    const candidates = [
      container?.querySelector<HTMLElement>('[data-testid="document-editor"] [role="tab"][aria-selected="true"]') ?? null,
      container?.querySelector<HTMLElement>('[data-testid="document-editor"] [role="tab"]') ?? null,
      expanded ? overlayCloseRef.current : inlineCloseRef.current,
    ];
    for (const candidate of candidates) {
      if (isElementVisible(candidate)) return candidate;
    }
    return null;
  }, [expanded]);

  const enterEditMode = useCallback(() => {
    if (!preview) return;
    seededInitialEditRef.current = true;
    linkOriginRef.current = null;
    setEditorTab('write');
    setEditContent(preview.content ?? '');
    setBaseContent(preview.content ?? '');
    setBaseRevision(preview.revision);
    setBaseModifiedAt(preview.modifiedAt);
    setBaseCatalogModifiedAt(externalModifiedAt);
    setConflict(null);
    setSaveStatus(null);
    setEditing(true);
    requestAnimationFrame(() => {
      editorTextareaRef.current?.focus();
    });
  }, [preview, externalModifiedAt]);


  // A Save button that was focused turns disabled while saving / in conflict and the browser drops
  // focus to <body>. After a failed save, move it to the conflict choices (or the text).
  const refocusAfterFailedSave = useCallback(() => {
    requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      const active = document.activeElement;
      const lost = !active || active === document.body || (active as HTMLButtonElement).disabled === true;
      if (!lost) return;
      for (const container of [overlayRef.current, viewerRootRef.current]) {
        const conflictBtn = container?.querySelector<HTMLElement>(
          '[data-testid="document-conflict-bar"] button:not([disabled])',
        ) ?? null;
        if (isElementVisible(conflictBtn)) {
          conflictBtn.focus({ preventScroll: true });
          return;
        }
      }
      resolveKeepEditingFocus()?.focus({ preventScroll: true });
    });
  }, [resolveKeepEditingFocus]);
  const executeSave = useCallback(async (expectedRevOverride?: string | null): Promise<boolean> => {
    if (!onSave || saving) return false;
    setSaving(true);
    setSaveStatus(null);
    try {
      const expectedRevision = expectedRevOverride === null
        ? undefined
        : (expectedRevOverride ?? baseRevision);
      const res = await onSave(editContent, expectedRevision ? { expectedRevision } : undefined);
      if (!mountedRef.current) return false;
      const nextContent = res && typeof res === 'object' && typeof res.content === 'string' ? res.content : editContent;
      const nextRevision = res && typeof res === 'object' && typeof res.revision === 'string' ? res.revision : preview?.revision;
      const nextModifiedAt = res && typeof res === 'object' && typeof res.modifiedAt === 'string' ? res.modifiedAt : preview?.modifiedAt;
      setBaseContent(nextContent);
      setBaseRevision(nextRevision);
      setBaseModifiedAt(nextModifiedAt);
      setBaseCatalogModifiedAt(nextModifiedAt);
      setConflict(null);
      setSaveStatus('Saved');
      if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setSaveStatus(null);
        saveStatusTimerRef.current = null;
      }, 2000);
      pendingEditExitFocusRef.current = true;
      setEditing(false);
      onDraftStateChangeRef.current?.({
        editing: false,
        dirty: false,
        draft: nextContent,
        baseContent: nextContent,
        baseRevision: nextRevision,
        baseModifiedAt: nextModifiedAt,
      });
      return true;
    } catch (err) {
      if (!mountedRef.current) return false;
      const parsedConflict = parseDocumentConflict(err);
      if (parsedConflict) {
        setConflict(parsedConflict);
        setSaveStatus(null);
        refocusAfterFailedSave();
        return false;
      }
      setSaveStatus(err instanceof Error ? err.message : 'Failed to save');
      refocusAfterFailedSave();
      return false;
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [onSave, saving, baseRevision, editContent, preview, refocusAfterFailedSave]);

  const handleSave = useCallback(() => executeSave(), [executeSave]);

  const handleOverwriteConflict = useCallback(() => {
    if (!conflict) return;
    void executeSave(conflict.currentRevision);
  }, [conflict, executeSave]);

  const handleSaveAsCopy = useCallback(async () => {
    if (!onSaveAsCopy || saving) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      await onSaveAsCopy(editContent);
      if (!mountedRef.current) return;
      setConflict(null);
      pendingEditExitFocusRef.current = true;
      setEditing(false);
      onDraftStateChangeRef.current?.({
        editing: false,
        dirty: false,
        draft: editContent,
        baseContent: editContent,
        baseRevision: preview?.revision,
        baseModifiedAt: preview?.modifiedAt,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setSaveStatus(err instanceof Error ? err.message : 'Failed to save copy');
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [onSaveAsCopy, saving, editContent, preview]);

  const handleLoadLatest = useCallback(() => {
    if (!conflict || conflict.currentContent === undefined) return;
    linkOriginRef.current = null;
    setEditContent(conflict.currentContent);
    setBaseContent(conflict.currentContent);
    setBaseRevision(conflict.currentRevision ?? undefined);
    setBaseModifiedAt(conflict.currentModifiedAt ?? undefined);
    setBaseCatalogModifiedAt(conflict.currentModifiedAt ?? undefined);
    setConflict(null);
    setSaveStatus(null);
    requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      resolveKeepEditingFocus()?.focus({ preventScroll: true });
    });
  }, [conflict, resolveKeepEditingFocus]);

  const discardAndExitEdit = useCallback((options?: { restoreFocus?: boolean }) => {
    const cleanContent = preview?.content ?? baseContent;
    linkOriginRef.current = null;
    setEditorTab('write');
    setConflict(null);
    setSaveStatus(null);
    if (options?.restoreFocus !== false) {
      pendingEditExitFocusRef.current = true;
    }
    setEditing(false);
    setEditContent(cleanContent);
    setBaseContent(cleanContent);
    setBaseRevision(preview?.revision);
    setBaseModifiedAt(preview?.modifiedAt);
    setBaseCatalogModifiedAt(externalModifiedAt);
    onDraftStateChangeRef.current?.({
      editing: false,
      dirty: false,
      draft: cleanContent,
      baseContent: cleanContent,
      baseRevision: preview?.revision,
      baseModifiedAt: preview?.modifiedAt,
    });
  }, [preview?.content, preview?.revision, preview?.modifiedAt, baseContent, externalModifiedAt]);

  const handleRequestCancelEdit = useCallback(() => {
    linkOriginRef.current = null;
    if (dirty) {
      if (expanded) {
        setExpanded(false);
        setRestoreExpandedAfterPrompt(true);
      }
      setDiscardPrompt({ type: 'cancel-edit' });
      return;
    }
    discardAndExitEdit();
  }, [dirty, expanded, discardAndExitEdit]);

  const handleRequestClose = useCallback(() => {
    linkOriginRef.current = null;
    if (editing && dirty) {
      if (expanded) {
        setExpanded(false);
        setRestoreExpandedAfterPrompt(true);
      }
      setDiscardPrompt({ type: 'close-reader' });
      return;
    }
    if (expanded) setExpanded(false);
    onClose?.();
  }, [editing, dirty, expanded, onClose]);

  useEffect(() => {
    if (!requestCloseRef) return;
    requestCloseRef.current = () => {
      if (editing) {
        handleRequestCancelEdit();
      } else {
        handleRequestClose();
      }
    };
    return () => {
      requestCloseRef.current = null;
    };
  }, [requestCloseRef, editing, handleRequestCancelEdit, handleRequestClose]);

  useEffect(() => {
    if (expanded) {
      wasExpanded.current = true;
      if (pendingEditExitFocusRef.current && !editing && !discardPrompt) {
        pendingEditExitFocusRef.current = false;
        const target = resolvePostEditExitFocus(true);
        if (target) {
          target.focus({ preventScroll: true });
          return;
        }
      }
      if (editing) {
        const target = isElementVisible(editorTextareaRef.current)
          ? editorTextareaRef.current
          : resolveKeepEditingFocus();
        target?.focus({ preventScroll: true });
      } else {
        overlayToggle.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (discardPrompt) {
      return;
    }
    if (pendingEditExitFocusRef.current && !editing) {
      pendingEditExitFocusRef.current = false;
      wasExpanded.current = false;
      const target = resolvePostEditExitFocus(false);
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
    }
    if (wasExpanded.current) {
      wasExpanded.current = false;
      if (isElementVisible(inlineToggle.current)) {
        inlineToggle.current.focus({ preventScroll: true });
      }
    }
  }, [expanded, editing, discardPrompt, resolvePostEditExitFocus, resolveKeepEditingFocus]);

  // Lock background scrolling while expanded.
  useEffect(() => {
    if (!expanded || typeof document === 'undefined') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const hasCoveringOverlay = () =>
      Array.from(
        document.querySelectorAll('[data-slot="menu-popup"], [data-slot="popover-popup"], [role="alertdialog"], [role="dialog"]'),
      ).some((el) => el !== overlayRef.current && el.getClientRects().length > 0 && !el.closest('[inert], [hidden]'));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      if (isCodeWindowOpen()) return;
      if (event.key === 'Escape') {
        // Escape inside an open menu, popover, or external dialog closes that overlay only.
        if (event.defaultPrevented || hasCoveringOverlay()) return;
        event.preventDefault();
        event.stopPropagation();
        if (editing) {
          handleRequestCancelEdit();
        } else {
          setExpanded(false);
        }
        return;
      }
      if (event.key === 'Tab' && overlayRef.current && !hasCoveringOverlay()) {
        const focusable = overlayRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data !== ESCAPE_MESSAGE || !event.source) return;
      if (isCodeWindowOpen() || hasCoveringOverlay()) return;
      const frames = overlayRef.current?.querySelectorAll('iframe') ?? [];
      if (Array.from(frames).some((frame) => frame.contentWindow === event.source)) {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('message', onMessage);
    };
  }, [expanded, editing, handleRequestCancelEdit]);

  const [copiedPath, setCopiedPath] = useState(false);
  const pathToCopy = preview?.name ?? title;
  const canCopyPicture = preview?.kind === 'image' && Boolean(fileUrl);
  // Another document is a new copy target: a copy of the one before must not write over it
  useEffect(() => { copyPictureGenRef.current += 1; }, [fileUrl, pathToCopy]);
  const handleCopyPicture = () => {
    if (!fileUrl) return;
    const gen = ++copyPictureGenRef.current;
    const repeat = pictureCopyStatus ? !pictureCopyStatus.repeat : false;
    void copyPictureToClipboard({
      src: fileUrl,
      fallbackPath: pathToCopy,
      isCurrent: () => mountedRef.current && gen === copyPictureGenRef.current,
    }).then((result) => {
      if (!mountedRef.current || gen !== copyPictureGenRef.current) return;
      setPictureCopyStatus({ ok: result.ok, message: result.message, repeat });
      if (copyPictureTimerRef.current) clearTimeout(copyPictureTimerRef.current);
      copyPictureTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setPictureCopyStatus(null);
        copyPictureTimerRef.current = null;
      }, 2500);
    });
  };
  const handleCopyPath = () => {
    void safeCopyToClipboard(pathToCopy).then((ok) => {
      if (!mountedRef.current) return;
      setCopiedPath(ok);
      if (copyPathTimerRef.current) clearTimeout(copyPathTimerRef.current);
      if (ok) {
        copyPathTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          setCopiedPath(false);
          copyPathTimerRef.current = null;
        }, 1500);
      }
    });
  };

  const buttonSize = compact ? 'xs' : 'sm';
  const guidance = notice;
  const guardedLinks: MarkdownDocumentLinks | undefined = links
    ? {
        ...links,
        onOpenFile: (linkedPath, line) => {
          const targetNorm = normalizeDocPath(linkedPath);
          const currentNorm = normalizeDocPath(currentDocName);
          if (editing && dirty && targetNorm && targetNorm !== currentNorm) {
            linkOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (expanded) {
              setExpanded(false);
              setRestoreExpandedAfterPrompt(true);
            }
            setDiscardPrompt({ type: 'open-link', path: linkedPath, line });
            return;
          }
          if (editing && targetNorm && targetNorm === currentNorm) {
            return;
          }
          if (editing && !dirty && targetNorm && targetNorm !== currentNorm) {
            discardAndExitEdit({ restoreFocus: false });
          }
          links.onOpenFile(linkedPath, line);
        },
      }
    : undefined;

  const editorKind = preview?.kind === 'markdown' || preview?.kind === 'html' ? preview.kind : 'text';
  const editorView = (
    <DocumentEditor
      docPath={preview?.name ?? title}
      kind={editorKind}
      value={editContent}
      onChange={setEditContent}
      dirty={dirty}
      saving={saving}
      saveError={saveStatus && saveStatus !== 'Saved' ? saveStatus : null}
      externalChangeNotice={externalChangeNotice}
      conflict={conflict}
      onSave={() => void handleSave()}
      onCancel={handleRequestCancelEdit}
      onOverwriteConflict={handleOverwriteConflict}
      onSaveAsCopy={() => void handleSaveAsCopy()}
      onLoadLatest={handleLoadLatest}
      links={guardedLinks}
      fileUrl={fileUrl}
      autoFocus={initialEditing}
      showActions={false}
      textareaRef={editorTextareaRef}
      tab={editorTab}
      onTabChange={setEditorTab}
    />
  );

  const isImageExpanded = expanded || Boolean(imageExpanded);
  const handleImageClick = onImageClick ?? (() => setExpanded((value) => !value));

  // The frame of a page or a PDF that has the body to itself, in a body that does not scroll.
  const framed = fill && fillFrame && !editing && !raw && (preview?.kind === 'html' || (preview?.kind === 'pdf' && preview.content === undefined));
  const hasExpand = !fill || !chromeless;
  const body = (expandedNow: boolean) => {
    const content = editing
      ? expandedNow === expanded
        ? editorView
        : null
      : preview
        ? <DocumentPreview
            lineTools={lineTools}
            preview={preview}
            fileUrl={fileUrl}
            raw={raw}
            expanded={expandedNow || isImageExpanded}
            fillFrame={framed && !expandedNow}
            trusted
            links={guardedLinks}
            onImageClick={preview.kind === 'image' ? handleImageClick : undefined}
          />
        : <>{status}</>;
    return hasExpand
      ? <DiagramFullScreenContext value={expandedNow ? 'fullscreen' : 'available'}>{content}</DiagramFullScreenContext>
      : content;
  };

  const folder = (preview?.name ?? title).includes('/') ? (preview?.name ?? title).slice(0, (preview?.name ?? title).lastIndexOf('/') + 1) : '';
  /** A document with nothing to preview (a .docx): the body only offers the download, so the row does too. */
  const noPreview = preview?.kind === 'download' && preview.content === undefined;
  /** The reader's one row: where the document is, then what can be done with it, as quiet icons. */
  const fillChrome = (expandedNow: boolean) => (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs">
      {leading}
      <h3 className="min-w-0 flex-1 truncate font-normal" title={preview?.name ?? title}>
        {folder && <span className="text-muted-foreground">{folder}</span>}
        <span className="font-medium text-foreground">{title.slice(folder && title.startsWith(folder) ? folder.length : 0)}</span>
      </h3>
      {watching && <span role="img" aria-label="Watching for changes" title="Watching for changes" className="inline-flex shrink-0 text-muted-foreground"><Eye aria-hidden="true" size={13} /></span>}
      {canEdit && !editing && (
        <Button ref={expandedNow ? overlayEditRef : inlineEditRef} size="xs" variant="outline" className="h-7 shrink-0 gap-1 px-2 text-xs" aria-label="Edit document" title="Edit document" onClick={enterEditMode}>
          <Edit3 aria-hidden="true" size={13} />
          <span>Edit</span>
        </Button>
      )}
      {noPreview && downloadHref && !editing && (
        <a href={downloadHref} download={preview?.name.split('/').pop() ?? title.split('/').pop()} className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'h-7 shrink-0 gap-1 px-2 text-xs')}>
          <Download aria-hidden="true" size={13} />Download
        </a>
      )}
      {editing && (
        <>
          <Button size="xs" variant="default" className="h-7 shrink-0 gap-1 px-2 text-xs" disabled={saving || conflict !== null} aria-label="Save document" onClick={() => void handleSave()}>
            <Save aria-hidden="true" size={13} />{saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="xs" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={saving} onClick={handleRequestCancelEdit}>
            Cancel
          </Button>
        </>
      )}
      {/* The rest sits in one menu so the title keeps its room in a narrow panel. */}
      <Menu>
        <MenuTrigger ref={expandedNow ? overlayMoreRef : moreInline} aria-label="More document actions" title="More document actions" className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <MoreHorizontal aria-hidden="true" size={14} />
        </MenuTrigger>
        <MenuPopup align="end" className="w-60" positionerClassName={expandedNow ? 'z-[110]' : undefined}>
          {onToggleWatch && (
            <MenuCheckboxItem checked={watching} disabled={editing} onCheckedChange={() => onToggleWatch()} aria-label="Watch document for changes">
              Watch for changes
            </MenuCheckboxItem>
          )}
          {onToggleRaw && !editing && <MenuItem onClick={onToggleRaw}><Code2 aria-hidden="true" />{raw ? rawLabels[1] : rawLabels[0]}</MenuItem>}
          <MenuItem onClick={handleCopyPath} aria-label={copiedPath ? 'Path copied' : `Copy path ${pathToCopy}`}>
            {copiedPath ? <Check aria-hidden="true" className="text-emerald-500" /> : <Copy aria-hidden="true" />}{copiedPath ? 'Path copied' : 'Copy path'}
          </MenuItem>
          {onMove && !editing && (
            <MenuItem onClick={() => { setTargetPath(preview?.name ?? title); setMoveError(null); setExpanded(false); setMoveOpen(true); }}><FolderInput aria-hidden="true" />Move or rename</MenuItem>
          )}
          {downloadHref && (
            <MenuItem render={<a href={downloadHref} download={preview?.name.split('/').pop() ?? title.split('/').pop()} />}><Download aria-hidden="true" />Download</MenuItem>
          )}
          {browserHref && (
            <MenuItem render={<a href={browserHref} target="_blank" rel="noopener noreferrer" />}><ExternalLink aria-hidden="true" />Open in browser</MenuItem>
          )}
        </MenuPopup>
      </Menu>
      {canCopyPicture && (
        <>
          <Button
            size="xs"
            variant="outline"
            className="nodrag nopan h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={handleCopyPicture}
          >
            <Copy aria-hidden="true" className="size-3.5" />
            <span>Copy picture</span>
          </Button>
          <span
            role="status"
            aria-live="polite"
            className={
              pictureCopyStatus
                ? cn('px-1 text-xs font-medium whitespace-nowrap', pictureCopyStatus.ok ? 'text-primary' : 'text-destructive')
                : 'sr-only'
            }
          >
            {pictureCopyStatus ? `${pictureCopyStatus.message}${pictureCopyStatus.repeat ? '\u00A0' : ''}` : ''}
          </span>
        </>
      )}
      <Button ref={expandedNow ? overlayToggle : inlineToggle} size="xs" variant="ghost" className="size-7 shrink-0 p-0" aria-label="Expand document" aria-pressed={expandedNow}
        title={expandedNow ? 'Collapse document' : 'Expand document'} onClick={() => setExpanded(value => !value)}>
        {expandedNow ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </Button>
      {onClose && (
        <Button ref={expandedNow ? overlayCloseRef : inlineCloseRef} size="xs" variant="ghost" className="size-7 shrink-0 p-0" aria-label="Close document" title="Close document" onClick={handleRequestClose}>
          <X size={13} />
        </Button>
      )}
    </div>
  );

  const chrome = (expandedNow: boolean) => (
    <>
      <div className={cn('flex flex-wrap items-center justify-between gap-2', compact ? 'mb-2' : 'mb-3')}>
        <div className="flex items-center gap-2 min-w-0">
          <h3 className={cn('break-all font-semibold', compact ? 'text-xs' : 'text-sm')}>{title}</h3>
          {preview?.kind && (
            <span className="shrink-0 rounded bg-muted/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {preview.kind}
            </span>
          )}
          <Button
            size={compact ? 'xs' : 'sm'}
            variant="ghost"
            className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground gap-1 shrink-0"
            aria-label={copiedPath ? 'Path copied' : `Copy path ${pathToCopy}`}
            title={copiedPath ? 'Path copied to clipboard' : 'Copy path'}
            onClick={handleCopyPath}
          >
            {copiedPath ? <Check size={compact ? 11 : 13} className="text-emerald-500" /> : <Copy size={compact ? 11 : 13} />}
            <span className="text-[11px] hidden sm:inline">{copiedPath ? 'Copied' : 'Copy path'}</span>
          </Button>
          {onMove && !editing && (
            <Button
              size={compact ? 'xs' : 'sm'}
              variant="ghost"
              className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground gap-1 shrink-0"
              aria-label="Move or rename document"
              title="Move or rename document"
              onClick={() => { setTargetPath(preview?.name ?? title); setMoveError(null); setExpanded(false); setMoveOpen(true); }}
            >
              <FolderInput size={compact ? 11 : 13} />
              <span className="text-[11px] hidden sm:inline">Move</span>
            </Button>
          )}
        </div>
        <div className={cn('flex flex-wrap items-center gap-2', compact ? 'text-xs' : 'text-sm')}>
          {canEdit && !editing && (
            <Button
              ref={expandedNow ? overlayEditRef : inlineEditRef}
              size={buttonSize}
              variant="outline"
              className="gap-1.5"
              aria-label="Edit document"
              title="Edit document"
              onClick={enterEditMode}
            >
              <Edit3 size={compact ? 12 : 14} />
              <span>Edit</span>
            </Button>
          )}
          {editing && (
            <>
              <Button size={buttonSize} variant="default" className="gap-1.5" disabled={saving || conflict !== null} aria-label="Save document" onClick={() => void handleSave()}>
                <Save size={compact ? 12 : 14} />
                <span>{saving ? 'Saving…' : 'Save'}</span>
              </Button>
              <Button size={buttonSize} variant="ghost" disabled={saving} onClick={handleRequestCancelEdit}>
                Cancel
              </Button>
            </>
          )}
          {onToggleWatch && (
            <Button
              size={buttonSize}
              variant={watching ? 'secondary' : 'outline'}
              className={cn('gap-1.5', watching && 'text-emerald-500')}
              disabled={editing}
              aria-label={watching ? 'Watching document for changes (live reload)' : 'Watch document for changes'}
              aria-pressed={watching}
              title={editing ? 'Cannot watch while editing' : (watching ? 'Watching for changes (live reload active)' : 'Watch document for changes')}
              onClick={onToggleWatch}
            >
              <Eye size={compact ? 12 : 14} />
              <span>{watching ? 'Watching' : 'Watch'}</span>
            </Button>
          )}
          {onToggleRaw && !editing && <Button size={buttonSize} variant="outline" onClick={onToggleRaw}>{raw ? rawLabels[1] : rawLabels[0]}</Button>}
          {canCopyPicture && (
            <>
              <Button
                size={buttonSize}
                variant="outline"
                className="nodrag nopan gap-1 text-xs"
                onClick={handleCopyPicture}
              >
                <Copy size={compact ? 12 : 14} aria-hidden="true" />
                <span>Copy picture</span>
              </Button>
              <span
                role="status"
                aria-live="polite"
                className={
                  pictureCopyStatus
                    ? cn('text-xs font-medium whitespace-nowrap', pictureCopyStatus.ok ? 'text-primary' : 'text-destructive')
                    : 'sr-only'
                }
              >
                {pictureCopyStatus ? `${pictureCopyStatus.message}${pictureCopyStatus.repeat ? '\u00A0' : ''}` : ''}
              </span>
            </>
          )}
          {downloadHref && (
            <a
              className={cn(buttonVariants({ variant: 'outline', size: buttonSize }), 'gap-1.5')}
              href={downloadHref}
              download={preview?.name.split('/').pop() ?? title.split('/').pop()}
            >
              <Download size={compact ? 12 : 14} />
              <span>Download</span>
            </a>
          )}
          {browserHref && (
            <a
              className={cn(buttonVariants({ variant: 'outline', size: buttonSize }), 'gap-1.5')}
              href={browserHref}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in your browser, where the document runs as authored"
            >
              <ExternalLink size={compact ? 12 : 14} />
              <span>Open in browser</span>
            </a>
          )}
          <Button
            ref={expandedNow ? overlayToggle : inlineToggle}
            size={buttonSize}
            variant="ghost"
            aria-label="Expand document"
            aria-pressed={expandedNow}
            title={expandedNow ? 'Collapse document' : 'Expand document'}
            onClick={() => setExpanded(value => !value)}
          >
            {expandedNow ? <Minimize2 size={compact ? 12 : 14} /> : <Maximize2 size={compact ? 12 : 14} />}
            {expandedNow ? 'Collapse' : 'Expand'}
          </Button>
          {onClose && <Button ref={expandedNow ? overlayCloseRef : inlineCloseRef} size={buttonSize} variant="ghost" aria-label="Close document" title="Close document" onClick={handleRequestClose}><X size={compact ? 12 : 14} /></Button>}
        </div>
      </div>
      {guidance}
    </>
  );

  return (
    <>
      {fill ? (
        <div ref={viewerRootRef} className={cn('flex h-full min-h-0 flex-col', expanded && 'hidden', className)}>
          {!chromeless && fillChrome(false)}
          <div className={cn('min-h-0 flex-1 px-5 py-4', framed || editing || (isImageExpanded && preview?.kind === 'image') ? 'flex flex-col overflow-hidden' : 'overflow-auto')}>
            {guidance}
            {body(false)}
          </div>
        </div>
      ) : (
      <div ref={viewerRootRef} className={cn(expanded && 'hidden', className)}>
        {chrome(false)}
        <div className={cn('overflow-auto', expanded ? 'h-full' : 'max-h-[70vh]')}>
          {body(false)}
        </div>
      </div>
      )}
      {expanded && typeof document !== 'undefined' && createPortal(
        <div
          ref={overlayRef}
          className={OVERLAY}
          role="dialog"
          aria-modal="true"
          aria-label={`Expanded ${title}`}
          data-testid="document-viewer-expanded"
        >
          {fill ? (
            <>
              {fillChrome(true)}
              <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3 sm:p-4">
                {guidance}
                {body(true)}
              </div>
            </>
          ) : (
          <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
            <div className="shrink-0 border-b border-border/60 pb-2 mb-2">
              {chrome(true)}
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              {body(true)}
            </div>
          </div>
          )}
        </div>,
        document.body,
      )}
      {moveOpen && (
        <Dialog open={moveOpen} onOpenChange={(next) => !next && setMoveOpen(false)}>
          <DialogPopup className="max-w-md" finalFocus={() => moreInline.current ?? true}>
            <DialogHeader>
              <DialogTitle>Move or rename document</DialogTitle>
              <DialogDescription>
                Specify the new path for this document relative to the workspace.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <label className="block text-xs text-muted-foreground">
                Document path
                <Input
                  value={targetPath}
                  onChange={(e) => setTargetPath(e.target.value)}
                  placeholder="path/to/document.md"
                  autoFocus
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="mt-1 font-mono text-xs"
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter' && targetPath.trim() && !moving) {
                      e.preventDefault();
                      void handleMoveSubmit();
                    }
                  }}
                />
              </label>
              {moveError && <p role="alert" className="text-xs text-destructive">{moveError}</p>}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setMoveOpen(false)} disabled={moving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleMoveSubmit} disabled={!targetPath.trim() || targetPath.trim() === (preview?.name ?? title) || moving}>
                {moving ? 'Moving…' : 'Move'}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
      {discardPrompt && (
        <AlertDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              viewerAlertExitModeRef.current = 'keep';
              setDiscardPrompt(null);
              if (restoreExpandedAfterPrompt) {
                setRestoreExpandedAfterPrompt(false);
                setExpanded(true);
              }
            }
          }}
        >
          <AlertDialogPopup
            initialFocus={keepEditingButtonRef}
            finalFocus={() => {
              if (viewerAlertExitModeRef.current !== 'keep') {
                return false;
              }
              return resolveKeepEditingFocus() ?? false;
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base font-semibold text-foreground">
                Unsaved changes
              </AlertDialogTitle>
              <AlertDialogDescription className="text-sm text-muted-foreground">
                You have unsaved edits to <span className="font-mono text-foreground">{preview?.name ?? title}</span>. Discard your changes or save before continuing?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                ref={keepEditingButtonRef}
                type="button"
                variant="outline"
                size="sm"
                autoFocus
                onClick={() => {
                  viewerAlertExitModeRef.current = 'keep';
                  setDiscardPrompt(null);
                  if (restoreExpandedAfterPrompt) {
                    setRestoreExpandedAfterPrompt(false);
                    setExpanded(true);
                  }
                  requestAnimationFrame(() => {
                    resolveKeepEditingFocus()?.focus({ preventScroll: true });
                  });
                }}
              >
                Keep editing
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                onClick={() => {
                  const action = discardPrompt;
                  viewerAlertExitModeRef.current = action.type === 'cancel-edit' ? 'exit-edit' : 'leave-doc';
                  setDiscardPrompt(null);
                  setRestoreExpandedAfterPrompt(false);
                  discardAndExitEdit({ restoreFocus: action.type === 'cancel-edit' });
                  if (action.type === 'close-reader') {
                    onClose?.();
                  } else if (action.type === 'open-link') {
                    links?.onOpenFile(action.path, action.line);
                  }
                }}
              >
                Discard changes
              </Button>
              {!conflict && (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    const action = discardPrompt;
                    viewerAlertExitModeRef.current = action.type === 'cancel-edit' ? 'exit-edit' : 'leave-doc';
                    setDiscardPrompt(null);
                    setRestoreExpandedAfterPrompt(false);
                    void executeSave().then((ok) => {
                      if (!ok) {
                        viewerAlertExitModeRef.current = 'keep';
                        requestAnimationFrame(() => {
                          if (!mountedRef.current) return;
                          for (const container of [overlayRef.current, viewerRootRef.current]) {
                            const conflictBtn = container?.querySelector<HTMLElement>(
                              '[data-testid="document-conflict-bar"] button:not([disabled])',
                            ) ?? null;
                            if (isElementVisible(conflictBtn)) {
                              conflictBtn.focus({ preventScroll: true });
                              return;
                            }
                          }
                          resolveKeepEditingFocus()?.focus({ preventScroll: true });
                        });
                        return;
                      }
                      if (action.type === 'close-reader') {
                        onClose?.();
                      } else if (action.type === 'open-link') {
                        links?.onOpenFile(action.path, action.line);
                      }
                    });
                  }}
                >
                  {actionLabelForSave(discardPrompt)}
                </Button>
              )}
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </>
  );
}

function actionLabelForSave(action: DocumentViewerDiscardAction | null): string {
  return action?.type === 'close-reader' ? 'Save & close' : 'Save & continue';
}
