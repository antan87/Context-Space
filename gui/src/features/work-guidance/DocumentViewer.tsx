import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Code2, Copy, Download, Edit3, ExternalLink, Eye, FolderInput, Maximize2, Minimize2, MoreHorizontal, Save, X } from 'lucide-react';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from '../../components/ui/menu.js';
import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { safeCopyToClipboard } from '../../lib/clipboard.js';
import { cn } from '../../lib/utils';
import { DocumentPreview, type DocumentPreviewData } from './DocumentPreview.js';

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
  onSave?: (content: string) => Promise<void> | void;
  /** Move or rename document */
  onMove?: (to: string) => Promise<void> | void;
  /** Initial editing state (useful for tests or opening directly in edit mode) */
  initialEditing?: boolean;
}

/**
 * Owns the maximize affordance for every document surface. Expanding fills the app viewport inside
 * the app's own borders — `fixed inset-0` portaled to `document.body` above the app shell, never the
 * browser Fullscreen API — so Download and the raw toggle stay reachable, and
 * docked side panels like the chat cannot overlap it.
 */
export function DocumentViewer({ title, preview, status, fileUrl = '', downloadHref, browserHref, links, raw, onToggleRaw, rawLabels = ['View source', 'View page'], onClose, compact = false, fill = false, fillFrame = false, chromeless = false, leading, notice, className, watching = false, onToggleWatch, editable, onSave, onMove, initialEditing = false }: DocumentViewerProps) {
  const [expanded, setExpanded] = useState(false);
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
  const moreInline = useRef<HTMLButtonElement>(null);
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

  // Edit state lapses when a different document is opened.
  const currentDocName = preview?.name ?? title;
  const previousDocName = useRef(currentDocName);
  useEffect(() => {
    if (currentDocName && previousDocName.current !== currentDocName) {
      previousDocName.current = currentDocName;
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
        // Escape inside an open menu closes the menu only.
        if (event.defaultPrevented || document.querySelector('[data-slot="menu-popup"]')) return;
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
  const guidance = notice;
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

  // The frame of a page or a PDF that has the body to itself, in a body that does not scroll.
  const framed = fill && fillFrame && !editing && !raw && (preview?.kind === 'html' || (preview?.kind === 'pdf' && preview.content === undefined));
  const body = (expandedNow: boolean) => editing
    ? editorView
    : preview
      ? <DocumentPreview preview={preview} fileUrl={fileUrl} raw={raw} expanded={expandedNow} fillFrame={framed && !expandedNow} trusted links={links} />
      : <>{status}</>;

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
        <Button size="xs" variant="ghost" className="size-7 shrink-0 p-0" aria-label="Edit document" title="Edit document" onClick={() => { setEditContent(preview?.content ?? ''); setEditing(true); }}>
          <Edit3 size={13} />
        </Button>
      )}
      {noPreview && downloadHref && !editing && (
        <a href={downloadHref} download={preview?.name.split('/').pop() ?? title.split('/').pop()} className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), 'h-7 shrink-0 gap-1 px-2 text-xs')}>
          <Download aria-hidden="true" size={13} />Download
        </a>
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
      {/* The rest sits in one menu so the title keeps its room in a narrow panel. */}
      <Menu>
        <MenuTrigger ref={expandedNow ? undefined : moreInline} aria-label="More document actions" title="More document actions" className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
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
          {!chromeless && fillChrome(false)}
          <div className={cn('min-h-0 flex-1 px-5 py-4', framed ? 'flex flex-col overflow-hidden' : 'overflow-auto')}>
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
