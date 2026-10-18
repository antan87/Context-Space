import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Bot, ChevronLeft, ChevronRight, FileCode, FileImage, FileText, FolderTree, Globe, Lightbulb, ListChecks,
  Loader2, Map as MapIcon, Maximize2, Minimize2, RefreshCw, Search, X, type LucideIcon,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { apiFetch } from '../../lib/api/client.js';
import { API_BASE } from '../../lib/apiBase.js';
import { useElementWidth } from '../../lib/useElementWidth.js';
import { cn } from '../../lib/utils.js';
import type { MarkdownDocumentLinks } from '../../components/ChatMarkdown.js';
import { FileTree, buildCompactedTree, filterTreeFiles, flattenTreeFiles } from '../changes/FileTree.js';
import { KnowledgeView } from '../knowledge/KnowledgeView.js';
import { useDocumentRequest } from '../workspace-shell/openRequests.js';
import type { DocumentKind, DocumentPreviewData } from './DocumentPreview.js';
import { DocumentViewer } from './DocumentViewer.js';

/** Matches the app's existing overlay idiom. */
const OVERLAY = 'fixed inset-0 z-[100] flex flex-col bg-background';
/** Below this width the list and the document cannot sit side by side, so the list opens over the document. */
const NARROW_PX = 620;
/** How long typing waits before the whole workspace is searched. */
const SEARCH_DELAY_MS = 200;

/**
 * The files ContextSpace keeps in the workspace, by what they are for rather than their file names, in this order.
 * They are pinned above the developer's own documents so there is one place to read them.
 */
const CONTEXTSPACE_DOCUMENTS: ReadonlyArray<{ name: string; label: string; purpose: string; icon: LucideIcon }> = [
  { name: 'PLAN.md', label: 'Plan', purpose: 'What the work is for, its checkpoints and decisions', icon: ListChecks },
  { name: 'contextspace-knowledge.md', label: 'Knowledge', purpose: 'Decisions and gotchas the assistants learned here', icon: Lightbulb },
  { name: 'contextspace-milestones.md', label: 'Delivery plan', purpose: 'Delivery order, open questions, decisions put off', icon: MapIcon },
  { name: 'AGENTS.md', label: 'Assistant instructions', purpose: 'What every assistant reads first here', icon: Bot },
  { name: 'contextspace-assignment.md', label: 'Current assignment', purpose: 'The goal as the assistants receive it', icon: ListChecks },
];
const PINNED = new Set(CONTEXTSPACE_DOCUMENTS.map((doc) => doc.name));
const KNOWLEDGE = 'contextspace-knowledge.md';

type RootDocument = { name: string; size: number; modifiedAt: string; kind: DocumentKind };
type Listing = { documents: RootDocument[]; folders: string[] };
/** A tree entry: a document, or the stand-in that keeps a folder visible until (or while) it has none. */
type Entry = { file: string; document?: RootDocument; folder?: string; state?: 'unopened' | 'loading' | 'empty' };

function DocumentIcon({ kind }: { kind: DocumentKind }) {
  switch (kind) {
    case 'html': return <Globe className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />;
    case 'image': return <FileImage className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />;
    case 'pdf': return <FileText className="size-3.5 shrink-0 text-rose-500" aria-hidden="true" />;
    case 'markdown': return <FileCode className="size-3.5 shrink-0 text-sky-500" aria-hidden="true" />;
    default: return <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
}

const foldersAbove = (name: string) => {
  const segments = name.split('/').slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
};

/**
 * The workspace's documents beside the chat: what ContextSpace keeps, pinned, and every folder of
 * the workspace root as a tree on the left; the open document fills the rest, with one slim row
 * of controls. Folders list their documents when opened; filtering searches the whole workspace.
 * In a narrow panel the list opens over the document instead of hiding it for good.
 */
export function RootDocumentsPanel({ workspaceId, workspacePath, panelActions }: { workspaceId: string; workspacePath?: string; panelActions?: ReactNode }) {
  const base = `/api/workspace/${encodeURIComponent(workspaceId)}/documents`;
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(0);
  const [preview, setPreview] = useState<DocumentPreviewData | null>(null);
  const [opening, setOpening] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [raw, setRaw] = useState(false);
  // Documents opened from a link, so Back returns to the one that linked them.
  const [trail, setTrail] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState<RootDocument[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [knowledgeAsFile, setKnowledgeAsFile] = useState(false);
  const [knowledgeExpanded, setKnowledgeExpanded] = useState(false);
  const [listHidden, setListHidden] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const width = useElementWidth(section);
  const narrow = width > 0 && width < NARROW_PX;
  const knowledgeOverlayRef = useRef<HTMLDivElement>(null);
  const knowledgeOverlayToggle = useRef<HTMLButtonElement>(null);
  const knowledgeInlineToggle = useRef<HTMLButtonElement>(null);
  const wasKnowledgeExpanded = useRef(false);

  // ─── Listing ───────────────────────────────────────────────────────────────
  const loadFolder = useCallback(async (folder: string, signal?: AbortSignal) => {
    setLoadingFolders((previous) => new Set(previous).add(folder));
    try {
      const listing = await apiFetch<{ documents: RootDocument[]; folders?: string[] }>(`${base}${folder ? `?${new URLSearchParams({ folder })}` : ''}`, { signal });
      setListings((previous) => ({ ...previous, [folder]: { documents: listing.documents, folders: listing.folders ?? [] } }));
      if (!folder) setListError('');
    } catch (error) {
      if (signal?.aborted) return;
      if (!folder) setListError(error instanceof Error ? error.message : 'Unable to load documents.');
    } finally {
      setLoadingFolders((previous) => {
        const next = new Set(previous);
        next.delete(folder);
        return next;
      });
    }
  }, [base]);

  // The root, and on refresh every folder already listed, so a new file appears where it was made.
  const listedFolders = useRef<Set<string>>(new Set());
  useEffect(() => { listedFolders.current = new Set(Object.keys(listings)); }, [listings]);
  useEffect(() => {
    const controller = new AbortController();
    for (const folder of new Set(['', ...listedFolders.current])) void loadFolder(folder, controller.signal);
    setSearched(null);
    return () => controller.abort();
  }, [loadFolder, revision]);

  // Filtering searches the whole workspace once, then narrows that list as the user types.
  const trimmed = query.trim().toLowerCase();
  const needsSearch = trimmed.length > 0 && searched === null;
  useEffect(() => {
    if (!needsSearch) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      void apiFetch<{ documents: RootDocument[] }>(`${base}?recursive=1`, { signal: controller.signal })
        .then((result) => setSearched(result.documents))
        .catch(() => { if (!controller.signal.aborted) setSearched([]); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, SEARCH_DELAY_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [base, needsSearch]);

  // ─── Tree model ────────────────────────────────────────────────────────────
  const rootListing = listings[''];
  const pinned = useMemo(() => CONTEXTSPACE_DOCUMENTS.filter((doc) => rootListing?.documents.some((file) => file.name === doc.name)
    && (!trimmed || `${doc.label} ${doc.name} ${doc.purpose}`.toLowerCase().includes(trimmed))), [rootListing, trimmed]);

  const entries = useMemo<Entry[]>(() => {
    if (trimmed) {
      const all = (searched ?? []).filter((doc) => !PINNED.has(doc.name));
      return filterTreeFiles(all.map((document) => ({ file: document.name, document })), trimmed);
    }
    const result: Entry[] = [];
    for (const [folder, listing] of Object.entries(listings)) {
      for (const document of listing.documents) if (folder || !PINNED.has(document.name)) result.push({ file: document.name, document });
      for (const child of listing.folders) {
        if (listings[child]) continue;
        result.push({ file: `${child}/…`, folder: child, state: loadingFolders.has(child) ? 'loading' : 'unopened' });
      }
      if (folder && listing.documents.length === 0 && listing.folders.length === 0) result.push({ file: `${folder}/…`, folder, state: 'empty' });
    }
    return result;
  }, [listings, loadingFolders, searched, trimmed]);
  const root = useMemo(() => buildCompactedTree(entries), [entries]);
  const treeExpanded = useMemo(() => {
    if (!trimmed) return expanded;
    // Every folder holding a match is open while filtering.
    const open = new Set<string>();
    for (const entry of entries) for (const folder of foldersAbove(entry.file)) open.add(folder);
    return open;
  }, [entries, expanded, trimmed]);

  /** Every document in reading order, for the previous and next buttons. */
  const order = useMemo(() => [
    ...pinned.map((doc) => doc.name),
    ...flattenTreeFiles(root).filter((entry) => entry.document).map((entry) => entry.file),
  ], [pinned, root]);
  const currentIndex = selected ? order.indexOf(selected) : -1;

  const changeExpanded = (next: Set<string>) => {
    if (trimmed) return;
    setExpanded(next);
    for (const folder of next) if (!listings[folder] && !loadingFolders.has(folder)) void loadFolder(folder);
  };

  // ─── Choosing a document ───────────────────────────────────────────────────
  /** Opens the folders above a document and lists them, so the tree shows where it is. */
  const reveal = useCallback((name: string) => {
    const folders = foldersAbove(name);
    if (folders.length === 0) return;
    setExpanded((previous) => new Set([...previous, ...folders]));
    for (const folder of folders) if (!listedFolders.current.has(folder)) void loadFolder(folder);
  }, [loadFolder]);

  const open = useCallback((name: string, options: { keepTrail?: boolean } = {}) => {
    if (!options.keepTrail) setTrail([]);
    if (name === KNOWLEDGE) setKnowledgeAsFile(false);
    setSelected(name);
    setKnowledgeExpanded(false);
    setDrawerOpen(false);
    setRevealKey((key) => key + 1);
    reveal(name);
  }, [reveal]);

  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setPreviewError(''); setRaw(false);
    if (!selected) { setOpening(false); return () => controller.abort(); }
    setOpening(true);
    void apiFetch<DocumentPreviewData>(`${base}/preview?name=${encodeURIComponent(selected)}`, { signal: controller.signal }).then(setPreview).catch((error) => {
      if (!controller.signal.aborted) setPreviewError(error instanceof Error ? error.message : 'Unable to open document.');
    }).finally(() => { if (!controller.signal.aborted) setOpening(false); });
    return () => controller.abort();
  }, [base, selected, revision]);

  // A document named in the chat (a path the CLI printed) opens here.
  const documentRequest = useDocumentRequest(workspaceId);
  const handledDocumentRequest = useRef(0);
  useEffect(() => {
    if (!documentRequest || documentRequest.id === handledDocumentRequest.current) return;
    handledDocumentRequest.current = documentRequest.id;
    open(documentRequest.request.name);
  }, [documentRequest, open]);

  const fileUrlFor = useCallback((name: string) => `${API_BASE}${base}/file?name=${encodeURIComponent(name)}`, [base]);
  const fileUrl = selected ? fileUrlFor(selected) : '';
  const links = useMemo<MarkdownDocumentLinks | undefined>(() => selected ? {
    workspaceRoot: workspacePath,
    documentPath: selected,
    fileUrl: fileUrlFor,
    onOpenFile: (name) => {
      if (name === selected) return;
      setTrail((previous) => [...previous, selected]);
      open(name, { keepTrail: true });
    },
  } : undefined, [fileUrlFor, selected, workspacePath, open]);
  const back = trail.at(-1);

  // ─── Knowledge, read as entries ────────────────────────────────────────────
  const isKnowledge = selected === KNOWLEDGE && !knowledgeAsFile;
  const showKnowledge = isKnowledge && preview?.kind === 'markdown' && typeof preview.content === 'string';
  useEffect(() => {
    if (knowledgeExpanded) {
      wasKnowledgeExpanded.current = true;
      knowledgeOverlayToggle.current?.focus();
      return;
    }
    if (wasKnowledgeExpanded.current) {
      wasKnowledgeExpanded.current = false;
      knowledgeInlineToggle.current?.focus();
    }
  }, [knowledgeExpanded]);
  useEffect(() => {
    if (!knowledgeExpanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setKnowledgeExpanded(false);
        return;
      }
      if (event.key === 'Tab' && knowledgeOverlayRef.current) {
        const focusable = knowledgeOverlayRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [knowledgeExpanded]);

  // ─── Layout ────────────────────────────────────────────────────────────────
  const listAsDrawer = narrow && selected !== null;
  const listVisible = narrow ? !listAsDrawer || drawerOpen : !listHidden;
  const toggleList = () => (narrow ? setDrawerOpen((value) => !value) : setListHidden((value) => !value));
  const iconButton = 'size-7 shrink-0 p-0';
  const pinnedLabel = CONTEXTSPACE_DOCUMENTS.find((doc) => doc.name === selected)?.label;

  const navigation = (
    <>
      {back && (
        <Button size="xs" variant="ghost" className="shrink-0 gap-1 px-1.5" onClick={() => { setTrail((previous) => previous.slice(0, -1)); open(back, { keepTrail: true }); }}>
          <ArrowLeft size={13} />Back to {back.split('/').pop()}
        </Button>
      )}
      <Button size="xs" variant="ghost" className={iconButton} aria-label="Previous document" title={currentIndex > 0 ? `Previous: ${order[currentIndex - 1]}` : 'No previous document'}
        disabled={currentIndex <= 0} onClick={() => open(order[currentIndex - 1]!)}>
        <ChevronLeft size={14} />
      </Button>
      <Button size="xs" variant="ghost" className={iconButton} aria-label="Next document" title={currentIndex >= 0 && currentIndex < order.length - 1 ? `Next: ${order[currentIndex + 1]}` : 'No next document'}
        disabled={currentIndex < 0 || currentIndex >= order.length - 1} onClick={() => open(order[currentIndex + 1]!)}>
        <ChevronRight size={14} />
      </Button>
    </>
  );

  const knowledgeHeader = (expandedNow: boolean) => (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs">
      {!expandedNow && navigation}
      <h3 className="min-w-0 flex-1 truncate font-medium">Knowledge</h3>
      <Button size="xs" variant="ghost" onClick={() => { if (expandedNow) setKnowledgeExpanded(false); setKnowledgeAsFile(true); }}>Show the file</Button>
      <Button ref={expandedNow ? knowledgeOverlayToggle : knowledgeInlineToggle} size="xs" variant="ghost" className={iconButton} aria-label="Expand knowledge" aria-pressed={expandedNow}
        title={expandedNow ? 'Collapse knowledge' : 'Expand knowledge'} onClick={() => setKnowledgeExpanded((value) => !value)}>
        {expandedNow ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </Button>
      <Button size="xs" variant="ghost" className={iconButton} aria-label="Close document" title="Close document" onClick={() => { if (expandedNow) setKnowledgeExpanded(false); setSelected(null); }}>
        <X size={13} />
      </Button>
    </div>
  );

  const list = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pt-2">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 size-3 text-muted-foreground" aria-hidden="true" />
          <input type="search" aria-label="Filter documents" placeholder="Filter documents…" value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setQuery(''); } }}
            className="h-7 w-full rounded border border-border bg-background pl-6 pr-6 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary [&::-webkit-search-cancel-button]:hidden" />
          {query && (
            <button type="button" aria-label="Clear filter" className="absolute right-1 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setQuery('')}>
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-2 [scrollbar-gutter:stable]">
        {pinned.length > 0 && (
          <div className="mb-2">
            <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">ContextSpace</h3>
            <ul aria-label="ContextSpace documents">
              {pinned.map((doc) => {
                const Icon = doc.icon;
                return (
                  <li key={doc.name}>
                    <button type="button" aria-pressed={selected === doc.name} title={`${doc.name}: ${doc.purpose}`}
                      className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent', selected === doc.name && 'bg-accent font-medium text-foreground')}
                      onClick={() => open(doc.name)}>
                      <Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                      <span className="truncate">{doc.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <h3 className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {trimmed ? 'Matching documents' : 'Workspace'}
          {(searching || (!rootListing && !listError)) && <Loader2 className="size-3 animate-spin" aria-label="Loading" />}
        </h3>
        {listError && (
          <div role="alert" className="space-y-1.5 px-2 text-xs text-destructive">
            <p>{listError}</p>
            <Button size="xs" variant="outline" onClick={() => setRevision((value) => value + 1)}>Retry documents</Button>
          </div>
        )}
        {rootListing && (
          <FileTree<Entry>
            label="Workspace documents tree"
            files={entries}
            root={root}
            selectedPath={selected ?? undefined}
            revealPath={selected ?? undefined}
            revealKey={revealKey}
            expandedPaths={treeExpanded}
            onExpandedPathsChange={changeExpanded}
            onActivateFile={(entry) => { if (entry.document) open(entry.document.name); }}
            renderFile={(entry) => entry.document ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1" title={entry.document.name}>
                <DocumentIcon kind={entry.document.kind} />
                <span className="truncate">{entry.document.name.split('/').pop()}</span>
              </span>
            ) : (
              <span className="px-1.5 py-1 text-[11px] italic text-muted-foreground">
                {entry.state === 'loading' ? 'Listing…' : entry.state === 'empty' ? 'No documents here' : 'Open the folder to list it'}
              </span>
            )}
          />
        )}
        {rootListing && !trimmed && entries.length === 0 && pinned.length === 0 && (
          <p className="px-2 text-xs text-muted-foreground">No documents in the workspace root yet. Refresh after a file is created.</p>
        )}
        {trimmed && searched !== null && entries.length === 0 && pinned.length === 0 && (
          <p className="px-2 text-xs text-muted-foreground">No matching documents.</p>
        )}
      </div>
    </div>
  );

  return (
    <section ref={setSection} aria-label="Workspace documents" className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div role="toolbar" aria-label="Documents" className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <Button size="xs" variant={listVisible ? 'secondary' : 'ghost'} className={iconButton} aria-expanded={listVisible}
          aria-label={listVisible ? 'Hide the document list' : 'Show the document list'} title={listVisible ? 'Hide the document list' : 'Show the document list'} onClick={toggleList}>
          <FolderTree className="size-3.5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate px-1 text-xs font-semibold">Documents</h2>
        <Button size="xs" variant="ghost" className={iconButton} aria-label="Refresh documents" title="Refresh documents" disabled={loadingFolders.size > 0 || opening}
          onClick={() => setRevision((value) => value + 1)}>
          <RefreshCw className={cn('size-3.5', loadingFolders.size > 0 && 'animate-spin')} />
        </Button>
        {panelActions && <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />}
        {panelActions}
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {listVisible && !listAsDrawer && (
          <aside aria-label="Documents to open" className={cn('flex min-h-0 flex-col bg-muted/10', narrow ? 'min-w-0 flex-1' : 'w-64 shrink-0 border-r border-border')}>
            {list}
          </aside>
        )}
        {listAsDrawer && drawerOpen && (
          <>
            <button type="button" aria-label="Close the document list" className="absolute inset-0 z-20 bg-background/40 backdrop-blur-[1px]" onClick={() => setDrawerOpen(false)} />
            <aside aria-label="Documents to open" className="absolute inset-y-0 left-0 z-30 flex w-[min(320px,88%)] flex-col border-r border-border bg-background shadow-2xl">
              {list}
            </aside>
          </>
        )}
        {!(narrow && !listAsDrawer) && (
          <article aria-label="Document preview" className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-muted-foreground">
                <FileText size={32} className="mb-2 opacity-40" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">Select a document to open it here.</p>
                <p className="mt-1 text-xs">Paths to documents printed in the chat open here too.</p>
              </div>
            ) : isKnowledge ? (
              <>
                <div className={cn('flex min-h-0 flex-1 flex-col', knowledgeExpanded && 'hidden')}>
                  {knowledgeHeader(false)}
                  <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                    {opening ? <p role="status" className="text-sm text-muted-foreground">Opening knowledge…</p>
                      : previewError ? <p role="alert" className="text-sm text-destructive">{previewError} <Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>Retry knowledge</Button></p>
                        : showKnowledge ? <KnowledgeView markdown={preview.content as string} /> : null}
                  </div>
                </div>
                {knowledgeExpanded && typeof document !== 'undefined' && createPortal(
                  <div ref={knowledgeOverlayRef} className={OVERLAY} role="dialog" aria-modal="true" aria-label="Expanded Knowledge" data-testid="knowledge-expanded">
                    {knowledgeHeader(true)}
                    <div className="min-h-0 flex-1 overflow-auto p-4">
                      <KnowledgeView markdown={(preview?.content as string) ?? ''} />
                    </div>
                  </div>,
                  document.body,
                )}
              </>
            ) : (
              <DocumentViewer
                fill
                leading={navigation}
                title={pinnedLabel ? `${pinnedLabel} (${selected})` : selected}
                preview={preview}
                raw={raw}
                onToggleRaw={preview?.kind === 'markdown' || preview?.kind === 'html' ? () => setRaw((value) => !value) : undefined}
                downloadHref={`${fileUrl}&download=1`}
                browserHref={preview?.kind === 'html' ? `${fileUrl}&open=1` : undefined}
                onClose={() => setSelected(null)}
                fileUrl={`${fileUrl}&revision=${revision}`}
                links={links}
                status={<>
                  {opening && <p role="status" className="text-sm text-muted-foreground">Opening document…</p>}
                  {previewError && <p role="alert" className="text-sm text-destructive">{previewError} <Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>Retry preview</Button></p>}
                </>}
              />
            )}
          </article>
        )}
      </div>
    </section>
  );
}
