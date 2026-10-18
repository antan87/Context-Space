import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, Edit3, ExternalLink, Eye, FolderInput, Maximize2, Minimize2, Save, ShieldAlert, X } from 'lucide-react';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils';
import { DocumentPreview, type DocumentPreviewData } from './DocumentPreview.js';
import { dependsOnExternalScript } from './previewPolicy.js';

/** Matches the app's existing overlay idiom (dialog.tsx, PluggableDiffViewer, WorktreeTitleModal). */
const OVERLAY = 'fixed inset-0 z-[100] flex flex-col bg-background';

export interface DocumentViewerProps {
  title: string;
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
  leading?: ReactNode;
  notice?: ReactNode;
  className?: string;
  /** Live watch status and toggle handler */
  watching?: boolean;
  onToggleWatch?: () => void;
  /** Enable editing and saving document directly */
  editable?: boolean;
  onSave?: (content: string) => Promise<void> | void;
  /** Move or rename document */
  onMove?: (to: string) => Promise<void> | void;
  /** Initial editing state (useful for tests or opening directly in edit mode) */
  initialEditing?: boolean;
}

/** Trust is per document and never persisted: it lapses as soon as the document is closed. */
function TrustControl({ trusted, onToggle, compact }: { trusted: boolean; onToggle: () => void; compact: boolean }) {
  return <Button
    size={compact ? 'xs' : 'sm'}
    variant={trusted ? 'destructive-outline' : 'outline'}
    aria-pressed={trusted}
    title={trusted ? 'Stop running scripts from this document' : 'Run scripts in this document so its styling can load'}
    onClick={onToggle}
  >
    <ShieldAlert size={compact ? 12 : 14} />
    {trusted ? 'Stop trusting' : 'Trust this document'}
  </Button>;
}

/**
 * Owns the maximize affordance for every document surface. Expanding fills the app viewport inside
 * the app's own borders — `fixed inset-0` portaled to `document.body` above the app shell, never the
 * browser Fullscreen API — so Download, the raw toggle and the trust control all stay reachable, and
 * docked side panels like the chat cannot overlap it.
 */
export function DocumentViewer({ title, preview, status, fileUrl = '', downloadHref, browserHref, links, raw, onToggleRaw, rawLabels = ['Raw text', 'Rendered view'], onClose, compact = false, fill = false, leading, notice, className, watching = false, onToggleWatch, editable, onSave, onMove, initialEditing = false }: DocumentViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [editing, setEditing] = useState(initialEditing);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [targetPath, setTargetPath] = useState('');
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const inlineToggle = useRef<HTMLButtonElement>(null);
  const overlayToggle = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const wasExpanded = useRef(false);
  const mountedRef = useRef(true);
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveStatusTimerRef.current) {
        clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = null;
      }
      if (copyPathTimerRef.current) {
        clearTimeout(copyPathTimerRef.current);
        copyPathTimerRef.current = null;
      }
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

  // Trust and edit state lapse when a different document is opened.
  const currentDocName = preview?.name ?? title;
  const previousDocName = useRef(currentDocName);
  useEffect(() => {
    if (currentDocName && previousDocName.current !== currentDocName) {
      previousDocName.current = currentDocName;
      setTrusted(false);
      setExpanded(false);
      setEditing(false);
      setEditContent(preview?.content ?? '');
      setSaveStatus(null);
      if (saveStatusTimerRef.current) {
        clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = null;
      }
      if (copyPathTimerRef.current) {
        clearTimeout(copyPathTimerRef.current);
        copyPathTimerRef.current = null;
      }
    }
  }, [currentDocName, preview?.content]);

  useEffect(() => {
    if (!editing && preview?.content !== undefined) {
      setEditContent(preview.content);
    }
  }, [preview?.content, editing]);

  const canEdit = (editable ?? Boolean(onSave)) && preview && (preview.kind === 'markdown' || preview.kind === 'html' || preview.kind === 'text') && preview.content !== undefined;

  const handleSave = async () => {
    if (!onSave || saving) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      await onSave(editContent);
      if (!mountedRef.current) return;
      setSaveStatus('Saved');
      if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setSaveStatus(null);
        saveStatusTimerRef.current = null;
      }, 2000);
      setEditing(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setSaveStatus(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void handleSave();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      setEditContent(preview?.content ?? '');
    }
  };

  useEffect(() => {
    if (expanded) {
      wasExpanded.current = true;
      overlayToggle.current?.focus();
      return;
    }
    if (wasExpanded.current) {
      wasExpanded.current = false;
      inlineToggle.current?.focus();
    }
  }, [expanded]);

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setExpanded(false);
        return;
      }
      if (event.key === 'Tab' && overlayRef.current) {
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
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const [copiedPath, setCopiedPath] = useState(false);
  const pathToCopy = preview?.name ?? title;
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
  const scriptBound = useMemo(
    () => preview?.kind === 'html' && !raw && dependsOnExternalScript(preview.content ?? ''),
    [preview, raw],
  );
  const trustControl = preview?.kind === 'html' && !raw
    ? <TrustControl trusted={trusted} onToggle={() => setTrusted(value => !value)} compact={compact} />
    : null;
  const guidance = <>
    {notice}
    {scriptBound && <p role="status" className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', compact ? 'mb-2' : 'mb-3')}>
      <ShieldAlert size={12} className="mt-0.5 shrink-0" />
      {trusted
        ? 'This document can run scripts from the internet, so remote code is running in a sandboxed frame.'
        : 'This page loads styling from an external script, which is blocked. Trust the document to load it.'}
    </p>}
  </>;
  const editorView = (
    <div className="flex flex-col flex-1 h-full min-h-[350px] gap-2">
      <textarea
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        onKeyDown={handleEditorKeyDown}
        aria-label={`Edit ${title}`}
        className="w-full flex-1 min-h-[350px] font-mono text-xs sm:text-sm p-4 bg-background text-foreground border border-border rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed"
        placeholder="Document content…"
      />
      {saveStatus && saveStatus !== 'Saved' && (
        <p role="alert" className="text-xs text-destructive">{saveStatus}</p>
      )}
    </div>
  );

  const body = (expandedNow: boolean) => editing
    ? editorView
    : preview
      ? <DocumentPreview preview={preview} fileUrl={fileUrl} raw={raw} expanded={expandedNow} trusted={trusted} links={links} />
      : <>{status}</>;

  const folder = (preview?.name ?? title).includes('/') ? (preview?.name ?? title).slice(0, (preview?.name ?? title).lastIndexOf('/') + 1) : '';
  const iconLink = 'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground';
  /** The reader's one row: where the document is, then what can be done with it, as quiet icons. */
  const fillChrome = (expandedNow: boolean) => (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs">
      {leading}
      <h3 className="min-w-0 flex-1 truncate font-normal" title={preview?.name ?? title}>
        {folder && <span className="text-muted-foreground">{folder}</span>}
        <span className="font-medium text-foreground">{title.slice(folder && title.startsWith(folder) ? folder.length : 0)}</span>
      </h3>
      {canEdit && !editing && (
        <Button size="xs" variant="ghost" className="size-7 shrink-0 p-0" aria-label="Edit document" title="Edit document" onClick={() => { setEditContent(preview?.content ?? ''); setEditing(true); }}>
          <Edit3 size={13} />
        </Button>
      )}
      {editing && (
        <>
          <Button size="xs" variant="default" className="h-7 shrink-0 gap-1 px-2 text-xs" disabled={saving} aria-label="Save document" onClick={handleSave}>
            <Save size={13} />{saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="xs" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => { setEditing(false); setEditContent(preview?.content ?? ''); }}>
            Cancel
          </Button>
        </>
      )}
      {onToggleWatch && (
        <Button size="xs" variant={watching ? 'secondary' : 'ghost'} className={cn('size-7 shrink-0 p-0', watching && 'text-emerald-500')}
          disabled={editing}
          aria-label={watching ? 'Watching document for changes (live reload)' : 'Watch document for changes'}
          aria-pressed={watching}
          title={editing ? 'Cannot watch while editing' : (watching ? 'Watching for changes (live reload active)' : 'Watch document for changes')}
          onClick={onToggleWatch}>
          <Eye size={13} />
        </Button>
      )}
      {onToggleRaw && !editing && <Button size="xs" variant="ghost" className="shrink-0" onClick={onToggleRaw}>{raw ? rawLabels[1] : rawLabels[0]}</Button>}
      {!editing && trustControl}
      <Button size="xs" variant="ghost" className="size-7 shrink-0 p-0" aria-label={copiedPath ? 'Path copied' : `Copy path ${pathToCopy}`} title={copiedPath ? 'Path copied to clipboard' : 'Copy path'} onClick={handleCopyPath}>
        {copiedPath ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
      </Button>
      {onMove && !editing && (
        <Button size="xs" variant="ghost" className="size-7 shrink-0 p-0" aria-label="Move or rename document" title="Move or rename document" onClick={() => { setTargetPath(preview?.name ?? title); setMoveError(null); setMoveOpen(true); }}>
          <FolderInput size={13} />
        </Button>
      )}
      {downloadHref && (
        <a className={iconLink} href={downloadHref} download={preview?.name.split('/').pop() ?? title.split('/').pop()} aria-label="Download" title="Download">
          <Download size={13} />
        </a>
      )}
      {browserHref && (
        <a className={iconLink} href={browserHref} target="_blank" rel="noopener noreferrer" aria-label="Open in browser" title="Open in your browser, where the document runs as authored">
          <ExternalLink size={13} />
        </a>
      )}
      <Button ref={expandedNow ? overlayToggle : inlineToggle} size="xs" variant="ghost" className="size-7 shrink-0 p-0" aria-label="Expand document" aria-pressed={expandedNow}
        title={expandedNow ? 'Collapse document' : 'Expand document'} onClick={() => setExpanded(value => !value)}>
        {expandedNow ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </Button>
      {onClose && (
        <Button size="xs" variant="ghost" className="size-7 shrink-0 p-0" aria-label="Close document" title="Close document" onClick={() => { if (expandedNow) setExpanded(false); onClose(); }}>
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
              onClick={() => { setTargetPath(preview?.name ?? title); setMoveError(null); setMoveOpen(true); }}
            >
              <FolderInput size={compact ? 11 : 13} />
              <span className="text-[11px] hidden sm:inline">Move</span>
            </Button>
          )}
        </div>
        <div className={cn('flex flex-wrap items-center gap-2', compact ? 'text-xs' : 'text-sm')}>
          {canEdit && !editing && (
            <Button
              size={buttonSize}
              variant="outline"
              className="gap-1.5"
              aria-label="Edit document"
              title="Edit document"
              onClick={() => { setEditContent(preview?.content ?? ''); setEditing(true); }}
            >
              <Edit3 size={compact ? 12 : 14} />
              <span>Edit</span>
            </Button>
          )}
          {editing && (
            <>
              <Button size={buttonSize} variant="default" className="gap-1.5" disabled={saving} aria-label="Save document" onClick={handleSave}>
                <Save size={compact ? 12 : 14} />
                <span>{saving ? 'Saving…' : 'Save'}</span>
              </Button>
              <Button size={buttonSize} variant="ghost" onClick={() => { setEditing(false); setEditContent(preview?.content ?? ''); }}>
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
          {!editing && trustControl}
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
          {onClose && <Button size={buttonSize} variant="ghost" aria-label="Close document" title="Close document" onClick={() => { if (expandedNow) setExpanded(false); onClose(); }}><X size={compact ? 12 : 14} /></Button>}
        </div>
      </div>
      {guidance}
    </>
  );

  return (
    <>
      {fill ? (
        <div className={cn('flex h-full min-h-0 flex-col', expanded && 'hidden', className)}>
          {fillChrome(false)}
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {guidance}
            {body(false)}
          </div>
        </div>
      ) : (
      <div className={cn(expanded && 'hidden', className)}>
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
          <DialogPopup className="max-w-md">
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
                  className="mt-1 font-mono text-xs"
                  onKeyDown={(e) => {
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
    </>
  );
}
