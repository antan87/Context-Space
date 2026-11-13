/**
 * Accessible, collapsible Board index navigation sidebar beside the Board canvas.
 *
 * Allows browsing and filtering everything on the board by Category or by Area, jumping
 * straight into any Area or card, or reading documents in BoardReader.
 */

import { useEffect, useId, useRef, useState, type Ref } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CornerDownRight,
  File,
  FileCode,
  FileImage,
  FileText,
  GitCommitHorizontal,
  Lightbulb,
  Kanban,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Search,
  X,
} from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { knowledgeCountText, knowledgeNavItems, knowledgeNewText } from '../knowledge/knowledgeIndex.js';
import type { KnowledgeEntry } from '../knowledge/knowledgeEntries.js';
import { BoardFiles, type IndexFile } from './BoardFiles.js';
import { SIDEBAR, type NavItem, type NavMode, type NavSection, type SidebarDock } from './boardNav.js';

export interface BoardSidebarProps {
  workspaceId: string;
  workspacePath?: string;
  active: boolean;
  fileReturn: number;
  onOpenFile: (file: IndexFile, button: HTMLElement) => void;
  dock: SidebarDock;
  open: boolean;
  onToggleOpen: () => void;
  narrowOpen: boolean;
  onOpenNarrow: () => void;
  onCloseNarrow: () => void;
  mode: NavMode;
  onModeChange: (mode: NavMode) => void;
  query: string;
  onQueryChange: (query: string) => void;
  sections: NavSection[];
  waitingCount: number;
  steppedAreaId: string | null;
  onJumpToArea: (areaId: string) => void;
  onJumpToItem: (item: NavItem, openReader?: boolean) => void;
  /** The workspace's knowledge: its entries once read (null before, or when it could not be read) and how many are new since the person looked. */
  knowledge?: { entries: readonly KnowledgeEntry[] | null; fresh: number };
  /** Opens Knowledge in the reader, on an entry (its key) or at the top. `button` is what the keyboard returns to. */
  onOpenKnowledge?: (button: HTMLElement, entry?: string) => void;
  toggleButtonRef?: Ref<HTMLButtonElement>;
  /** A number that goes up each time something asks for the search box (the Now line, the `/` key): the index opens if it is folded, and the box takes the keyboard. */
  focusSearch?: number;
}

function ItemIcon({ item }: { item: NavItem }) {
  const cls = 'size-3.5 shrink-0';
  if (item.category === 'waiting') {
    return <CircleHelp className={cn(cls, 'mt-0.5 text-warning-foreground')} aria-hidden="true" />;
  }
  if (item.category === 'commits') {
    return <GitCommitHorizontal className={cn(cls, 'mt-0.5 text-muted-foreground')} aria-hidden="true" />;
  }
  if (item.fileType === 'image') {
    return <FileImage className={cn(cls, 'mt-0.5 text-muted-foreground')} aria-hidden="true" />;
  }
  if (item.fileType === 'html' || item.fileType === 'markdown') {
    return <FileCode className={cn(cls, 'mt-0.5 text-muted-foreground')} aria-hidden="true" />;
  }
  if (item.category === 'areas') {
    return <Kanban className={cn(cls, 'mt-0.5 text-muted-foreground')} aria-hidden="true" />;
  }
  if (item.category === 'documents') {
    return <FileText className={cn(cls, 'mt-0.5 text-muted-foreground')} aria-hidden="true" />;
  }
  return <File className={cn(cls, 'mt-0.5 text-muted-foreground')} aria-hidden="true" />;
}

export function BoardSidebar({
  workspaceId, workspacePath, active, fileReturn, onOpenFile,
  dock,
  open,
  onToggleOpen,
  narrowOpen,
  onOpenNarrow,
  onCloseNarrow,
  mode,
  onModeChange,
  query,
  onQueryChange,
  sections,
  waitingCount,
  steppedAreaId,
  onJumpToArea,
  onJumpToItem,
  knowledge,
  onOpenKnowledge,
  toggleButtonRef,
  focusSearch = 0,
}: BoardSidebarProps) {
  const [filesMode, setFilesMode] = useState(false);
  const selectedFile = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!fileReturn) return;
    const frame = requestAnimationFrame(() => selectedFile.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [fileReturn]);
  const searchId = useId();
  const panelPrefix = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());

  const expanded = dock.overlays ? narrowOpen : open;
  const isSearching = query.trim().length > 0;

  // A search finds knowledge entries by their title too, under a group of their own
  const knowledgeMatches = !filesMode && knowledge?.entries && onOpenKnowledge ? knowledgeNavItems(knowledge.entries, query) : [];
  const matchCount = sections.reduce((sum, section) => sum + section.items.length, 0) + knowledgeMatches.length;
  const knowledgeNew = knowledgeNewText(knowledge?.fresh ?? 0);

  // The narrow drawer opens on its search box
  useEffect(() => {
    if (dock.overlays && narrowOpen) searchRef.current?.focus({ preventScroll: true });
  }, [dock.overlays, narrowOpen]);

  // The Now line's search asks for the box: once the index is open, the keyboard goes to it
  const searchHandled = useRef(0);
  useEffect(() => {
    if (!focusSearch || focusSearch === searchHandled.current || !expanded) return undefined;
    const frame = requestAnimationFrame(() => {
      searchHandled.current = focusSearch;
      searchRef.current?.focus({ preventScroll: true });
      searchRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSearch, expanded]);

  const handleToggle = () => {
    if (!dock.overlays) onToggleOpen();
    else if (narrowOpen) onCloseNarrow();
    else onOpenNarrow();
  };

  const toggleSection = (id: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 1. Collapsed rail (width 40px)
  const rail = (
      <div
        style={{ width: SIDEBAR.railWidth }}
        className="flex shrink-0 flex-col items-center gap-2 border-r border-border/60 bg-card py-2.5"
      >
        <Button
          ref={toggleButtonRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label={waitingCount > 0 ? `Board index, ${waitingCount} ${waitingCount === 1 ? 'waits' : 'wait'} for you` : 'Board index'}
          aria-expanded={false}
          onClick={handleToggle}
        >
          <PanelLeftOpen className="size-4" aria-hidden="true" />
        </Button>
        {waitingCount > 0 && (
          <Badge variant="warning" size="sm" aria-hidden="true" className="px-1 py-0 text-[10px]">
            {waitingCount}
          </Badge>
        )}
      </div>
    );

  // 2. Expanded sidebar navigation
  const sidebarNav = (
    <nav
      aria-label="Board index"
      style={{ width: dock.width }}
      className={cn(
        'flex flex-col border-border/60 bg-card text-card-foreground',
        dock.overlays
          ? 'absolute inset-y-0 left-0 z-40 border-r shadow-xl'
          : 'h-full shrink-0 border-r',
      )}
    >
      {/* Header with Board index button, mode switch, and collapse button */}
      <div className="flex flex-col gap-2 border-b border-border/60 p-2.5">
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-xs font-semibold text-foreground">Board index</span>
            {waitingCount > 0 && (
              <Badge variant="warning" size="sm">
                {waitingCount}
              </Badge>
            )}
          </div>
          <Button
            ref={expanded ? toggleButtonRef : undefined}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            aria-label="Board index"
            aria-expanded={true}
            onClick={handleToggle}
          >
            <PanelLeftClose className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {/* Mode selector (Category vs Area) */}
        <div className="flex items-center rounded-lg bg-muted p-0.5 text-xs">
          <button
            type="button"
            aria-pressed={!filesMode && mode === 'category'}
            className={cn(
              'min-h-6 flex-1 rounded-md px-2 py-0.5 font-medium transition-colors',
              !filesMode && mode === 'category'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => { setFilesMode(false); onModeChange('category'); }}
          >
            Category
          </button>
          <button
            type="button"
            aria-pressed={!filesMode && mode === 'area'}
            className={cn(
              'min-h-6 flex-1 rounded-md px-2 py-0.5 font-medium transition-colors',
              !filesMode && mode === 'area'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => { setFilesMode(false); onModeChange('area'); }}
          >
            Area
          </button>
          <button type="button" aria-pressed={filesMode} className={cn('min-h-6 flex-1 rounded-md px-2 py-0.5 font-medium', filesMode ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')} onClick={() => setFilesMode(true)}>Files</button>
        </div>

        {/* Search input with Escape clearing */}
        <div className="relative flex items-center">
          <label htmlFor={searchId} className="sr-only">
            Search the board
          </label>
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            value={query}
            placeholder={filesMode ? "Search files…" : "Search the board…"}
            className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                onQueryChange('');
              }
            }}
          />
          {query.length > 0 && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-1 flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
              onClick={() => onQueryChange('')}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {!filesMode && isSearching ? (matchCount === 0 ? 'No matches' : `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`) : ''}
        </div>
      </div>

      {/* Knowledge: always one press away, whatever the mode and however long the sections are */}
      {onOpenKnowledge && (
        <div className="shrink-0 border-b border-border/60 px-1.5 py-1">
          <button
            type="button"
            data-testid="board-index-knowledge"
            className="flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
            onClick={(event) => { selectedFile.current = event.currentTarget; onOpenKnowledge(event.currentTarget); }}
          >
            <Lightbulb className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="shrink-0 text-xs font-semibold text-foreground">Knowledge</span>
            {knowledge?.entries && <span className="min-w-0 truncate text-xs text-muted-foreground">· {knowledgeCountText(knowledge.entries.length)}</span>}
            {knowledgeNew && <span className="ml-auto shrink-0 rounded-md bg-info/10 px-1.5 text-xs font-medium text-info-foreground">{knowledgeNew}</span>}
          </button>
        </div>
      )}

      {/* Sections list */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {filesMode && <BoardFiles enabled={active && expanded} key={workspaceId} workspaceId={workspaceId} workspacePath={workspacePath} query={query} onOpen={(file, button) => { selectedFile.current = button; onOpenFile(file, button); }} />}
        {/* Found by title, right under the Knowledge entry: a long list of matches in the Areas does not push them out of sight */}
        {knowledgeMatches.length > 0 && (
          <div className="rounded-lg">
            <h3 className="px-1.5 py-1 text-xs font-semibold text-muted-foreground">
              Knowledge <span className="text-xs font-normal">({knowledgeMatches.length})</span>
            </h3>
            <ul className="mt-0.5 space-y-0.5 pl-2">
              {knowledgeMatches.map((match) => (
                <li key={match.key} className="rounded-md hover:bg-muted/40">
                  <button
                    type="button"
                    data-nav-knowledge={match.key}
                    className="flex w-full min-w-0 items-start gap-2 rounded-md p-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={(event) => { selectedFile.current = event.currentTarget; onOpenKnowledge?.(event.currentTarget, match.key); }}
                  >
                    <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">{match.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{match.subtitle}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!filesMode && sections.length === 0 && knowledgeMatches.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No matches found
          </div>
        )}

        {!filesMode && sections.map((section, index) => {
          const panelId = `${panelPrefix}-panel-${index}`;
          const isOpen = isSearching || !collapsedSections.has(section.id);

          return (
            <div key={section.id} className="rounded-lg">
              {/* Disclosure header with h3 button */}
              <div className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted/50">
                <h3 className="min-w-0 flex-1 text-xs font-semibold">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    disabled={isSearching}
                    className="flex min-h-6 w-full items-center gap-1.5 text-left text-xs font-semibold text-muted-foreground hover:text-foreground"
                    onClick={() => toggleSection(section.id)}
                  >
                    {isOpen ? (
                      <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">{section.title}</span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      ({section.items.length})
                    </span>
                    {section.waiting && (
                      <Badge variant="warning" size="sm" className="ml-auto">
                        Waiting
                      </Badge>
                    )}
                  </button>
                </h3>
                {mode === 'area' && section.areaId && (
                  <button
                    type="button"
                    className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label={`Step into ${section.title}`}
                    onClick={() => onJumpToArea(section.areaId!)}
                  >
                    <CornerDownRight className="size-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* Items in section */}
              <ul id={panelId} hidden={!isOpen} className="mt-0.5 space-y-0.5 pl-2">
                {section.items.map((item) => {
                  const isActive = steppedAreaId === item.areaId;
                  return (
                    <li
                      key={item.id}
                      data-active={isActive ? 'true' : undefined}
                      className={cn(
                        'group flex items-center justify-between rounded-md p-1.5 transition-colors',
                        isActive
                          ? 'bg-muted/70 text-foreground'
                          : 'hover:bg-muted/40 text-foreground',
                      )}
                    >
                      <button
                        type="button"
                        data-nav-item={item.id}
                        className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        onClick={() => onJumpToItem(item, false)}
                      >
                        <ItemIcon item={item} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-medium text-foreground">
                              {item.title}
                            </span>
                            {item.badge && (
                              <Badge variant={item.badge.variant} size="sm">
                                {item.badge.text}
                              </Badge>
                            )}
                          </div>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {item.subtitle}
                          </span>
                        </div>
                      </button>

                      {item.readerTarget && (
                        <button
                          type="button"
                          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-70 hover:opacity-100 hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
                          aria-label={`Read ${item.title} in reader`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onJumpToItem(item, true);
                          }}
                        >
                          <PanelRightOpen className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );

  // A stable wrapper keeps file buttons and their snapshot alive while a viewer covers the board.
  return <>
    {!expanded && rail}
    <div hidden={!expanded} style={expanded ? { display: 'contents' } : undefined}>
      {dock.overlays && <>
        <div aria-hidden="true" style={{ width: SIDEBAR.railWidth }} className="shrink-0 border-r border-border/60 bg-card" />
        <div aria-hidden="true" data-sidebar-backdrop="true" className="absolute inset-0 z-30 bg-background/60 backdrop-blur-xs" onClick={onCloseNarrow} />
      </>}
      {sidebarNav}
    </div>
  </>;
}
