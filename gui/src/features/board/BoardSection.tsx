import { useOpenFileReference } from '../workspace-shell/useOpenFileReference.js';
import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Background, BackgroundVariant, ConnectionMode, MarkerType, ReactFlow, type DefaultEdgeOptions, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';
import { Archive, ChevronLeft, Code2, Kanban, ListPlus, Plus, RefreshCw, StickyNote } from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '../../components/ui/empty.js';
import { Spinner } from '../../components/ui/spinner.js';
import { useWorkGuidance } from '../../lib/api/queries.js';
import { cn } from '../../lib/utils.js';
import { usePageVisible } from '../../lib/usePageVisible.js';
import { useClockTick } from '../../lib/useClockTick.js';
import { useAnswerDecision, useChangePlanFile, usePlanFile, useRunCheckpointCheck, useSetPlanNow, useTickPlanStep } from '../plan/planFile.js';
import { focusOf, focusSignature, stableNow, workableKeys } from '../plan/focus.js';
import { boardNews, useMarkNewsSeen, useRecentCommits, useWhatsNew } from '../plan/whatsNew.js';
import { isTypingTarget } from '../../app/typingTarget.js';
import { useFeedConnected } from '../progress/useScreenFeed.js';
import { documentRequests, invalidateReferenceIntent, openCodeWindow, referenceIntentIsCurrent, useCodeWindowOpen, useDocumentRequest } from '../workspace-shell/openRequests.js';
import { filesChangedText } from '../changes/changeSummary.js';
import { useRepoChanges } from '../changes/useRepoChanges.js';
import { BoardActionsContext, BoardReadingContext, firstControl, type BoardActions, type ReaderTarget } from './boardActions.js';
import {
  areaLayout,
  areaPlace,
  areaRows,
  areaRowIds,
  areaView,
  READABLE_ZOOM,
  buildBoardAreas,
  overviewEdges,
  OVERVIEW_INSET,
  overviewPlan,
  resolveCountTarget,
  stepsText,
  waitingText,
  type AreaCountKind,
  type LooseTab,
  type OverviewNode,
} from './boardAreas.js';
import { addNoteChange, deleteNoteChange, isBoardAreaId, updateNoteChange, useBoard, useChangeBoard, useWorkspaceFiles, workspaceFilesKey } from './boardData.js';
import { formatWorkspaceFileCounts } from './workspaceFilesArea.js';
import { NoteDialog } from './NoteDialog.js';
import { fileTitle, readerDock } from './boardDock.js';
import { boardEdges, oneLinePerPair, type BoardNode } from './boardLayout.js';
import {
  buildBoardNav,
  readNavMode,
  navStartsOpen,
  readNavChoice,
  SIDEBAR,
  sidebarDock,
  totalBoardWaiting,
  writeNavMode,
  writeNavOpen,
  type NavItem,
  type NavMode,
} from './boardNav.js';
import { BoardArea, BoardAreaFold, BoardAreaMini, BoardAreaRow, BoardCheckpoint, BoardCommit, BoardDocument, BoardFile, BoardFoldRow, BoardLane, BoardMoreTile, BoardNote, BoardPager, BoardPlaceholder, BoardRowHead, BoardUncommitted } from './BoardNodes.js';
import { REVEAL_MARGIN, revealViewport } from './boardReveal.js';
import { BoardReader } from './BoardReader.js';
import { commitOpenFor } from './commitSequence.js';
import { collectAreaReaderTargets, findReaderTargetIndex, isSameReaderTarget, useReaderLayout, type ReaderLayout } from './boardReaderLayout.js';
import { BoardSidebar } from './BoardSidebar.js';
import { BoardNowLine } from './BoardNowLine.js';
import { AssignmentCard } from './AssignmentCard.js';
import { specTarget } from './assignmentCardView.js';
import { firstWaiting, newsLines as buildNewsLines, nowLineParts, nowLineTarget, type NewsLine } from './nowLine.js';
import { findThreadChain } from './boardThread.js';
import { isCodeWindowOpen } from '../workspace-shell/codeWindowOpen.js';
import { backLabel, backTarget, backTrail, pushTrail, startTrail, type ReaderTrail } from './boardReaderTrail.js';
import {
  backBoardLabel,
  backBoardTarget,
  backBoardTrail,
  canGoBackBoard,
  createBoardTrail,
  pushBoardTrail,
  type BoardTrail,
  type BoardTrailFocus,
} from './boardTrail.js';

const OVERVIEW_NODE_TYPES: NodeTypes = { area: BoardArea, areaRow: BoardAreaRow, areaMini: BoardAreaMini, areaFold: BoardAreaFold, checkpoint: BoardCheckpoint };
const AREA_NODE_TYPES: NodeTypes = {
  lane: BoardLane,
  checkpoint: BoardCheckpoint,
  document: BoardDocument,
  commit: BoardCommit,
  placeholder: BoardPlaceholder,
  uncommitted: BoardUncommitted,
  note: BoardNote,
  file: BoardFile,
  step: BoardRowHead,
  fold: BoardFoldRow,
  more: BoardMoreTile,
  pager: BoardPager,
};

const PAN_STEP = 96;
/** How many frames a jump from the Board index waits for the card to be drawn in its Area, before it gives up. */
const JUMP_FRAMES = 30;
/** How long a move of the view takes, in ms: none for those who ask for less motion. */
const moveMs = (ms: number) => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);
/** Lines point from the thing that was linked to the thing it was linked to. */
const EDGE_OPTIONS: DefaultEdgeOptions = { markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)', width: 14, height: 14 } };

/**
 * Arrow keys pan and zero puts the board back where it fits: the canvas is a keyboard stop of its own. Nothing zooms.
 */
function navigate(flow: ReactFlowInstance<any> | null, event: KeyboardEvent<HTMLDivElement>, onMoved: () => void, onFit: () => void) {
  const onNode = event.target instanceof HTMLElement && event.target.classList.contains('react-flow__node');
  if (!flow || (event.target !== event.currentTarget && !onNode) || event.altKey || event.ctrlKey || event.metaKey) return;
  const { x, y, zoom } = flow.getViewport();
  const pan = (dx: number, dy: number) => void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: moveMs(120) });
  switch (event.key) {
    case 'ArrowLeft': pan(PAN_STEP, 0); break;
    case 'ArrowRight': pan(-PAN_STEP, 0); break;
    case 'ArrowUp': pan(0, PAN_STEP); break;
    case 'ArrowDown': pan(0, -PAN_STEP); break;
    case '0': onFit(); event.preventDefault(); return;
    default: return;
  }
  onMoved();
  event.preventDefault();
}

/**
 * Whether a press went to the canvas itself.
 */
function isViewGesture(container: HTMLElement | null, target: EventTarget): boolean {
  if (!(target instanceof Element) || !container?.contains(target)) return false;
  if (target.closest('.react-flow__node button, .react-flow__node a, .react-flow__node [role="button"]')) return false;
  return Boolean(target.closest('.react-flow__pane'));
}

/**
 * A node that gets the keyboard's focus while out of view is brought into view.
 */
function showFocused(flow: ReactFlowInstance<any> | null, event: FocusEvent<HTMLDivElement>, size: { width: number; height: number }, onMoved: () => void) {
  const target = event.target as HTMLElement;
  const id = target.closest<HTMLElement>('.react-flow__node')?.dataset.id;
  const node = id ? flow?.getInternalNode(id) : undefined;
  if (!flow || !node) return;
  const { x, y, zoom } = flow.getViewport();
  const { x: left, y: top } = node.internals.positionAbsolute;
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  const next = revealViewport({ x, y, zoom }, { x: left, y: top, width, height }, size, REVEAL_MARGIN, OVERVIEW_INSET.top);
  if (!next) return;
  onMoved();
  void flow.setViewport(next, { duration: moveMs(200) });
}

/** Brings an overview node whole into view, moving the least needed, and not at all when it already is. */
function revealOverviewNode(flow: ReactFlowInstance<any> | null, node: { position: { x: number; y: number }; width?: number | null; height?: number | null }, size: { width: number; height: number }, onMoved: () => void, from?: { x: number; y: number; zoom: number }) {
  if (!flow) return;
  const next = revealViewport(from ?? flow.getViewport(), { x: node.position.x, y: node.position.y, width: node.width ?? 260, height: node.height ?? 160 }, size, REVEAL_MARGIN, OVERVIEW_INSET.top);
  if (!next) return;
  // The view is the person's now (as after a pan): a layout that changes later does not take it back
  onMoved();
  void flow.setViewport(next, { duration: moveMs(300) });
}

/** One part of the data that could not be read; the rest of the board still shows. */
function SourceProblem({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground">
    <span className="min-w-0 flex-1 break-words">{what} could not be read: {error instanceof Error ? error.message : 'unknown error'}</span>
    <Button size="xs" variant="outline" onClick={onRetry}><RefreshCw />Retry</Button>
  </div>;
}

type SteppedState = { areaId: string; origin: string; phase: 'open' | 'closing' } | null;

/**
 * Unscaled width and height of an element, unaffected by CSS scale transforms on ancestor planes.
 */
function useLayoutElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) {
      setSize((current) => (current.width === 0 && current.height === 0 ? current : { width: 0, height: 0 }));
      return;
    }
    const update = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    update();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = Math.round(entry.borderBoxSize?.[0]?.inlineSize ?? (entry.target as HTMLElement).offsetWidth);
        const height = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight);
        setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/**
 * The Board: a spatial 2-level surface where people and AIs collaborate.
 *
 * Level 0 ("Board"): Arranges workspace Areas (checkpoints, plan, work) as cards in a grid, as a grid of small cards, or as one-line rows
 * where the cards would not be readable, so that they fit whole on one screen at a readable size.
 *
 * Level 1 (inside an Area): Stepping into an Area recedes Level 0 behind a dimmed scrim while the
 * Area surface grows smoothly from the clicked card's transform-origin to fit all items whole on one
 * screen without scrolling.
 */
/** What a node stands for that is not drawn (the other tab, behind "+N more", on another page, in a folded row). */
const nodeHolds = (node: BoardNode): string[] | undefined =>
  node.type === 'fold' || node.type === 'more' || node.type === 'pager' || node.type === 'step' ? node.data.holds : node.type === 'lane' ? node.data.group?.holds : undefined;

export function BoardSection({ workspaceId, workspacePath, active, panelActions, readOnly = false, askInCLI }: { workspaceId: string; workspacePath?: string; active: boolean; panelActions?: ReactNode; readOnly?: boolean; askInCLI?: (context: string) => void }) {
  const plan = usePlanFile(workspaceId);
  const guidance = useWorkGuidance(workspaceId);
  const news = useWhatsNew(workspaceId);
  // The board draws the recent commits; the news only says which are new, so Got it never takes work off it
  const recent = useRecentCommits(workspaceId);

  const visible = usePageVisible();
  const listening = active && visible;
  const connected = useFeedConnected(workspaceId, listening);
  const boardQuery = useBoard(workspaceId, { poll: listening && !connected });
  const queryClient = useQueryClient();
  const workspaceFilesQuery = useWorkspaceFiles(workspaceId, { active: listening });
  const root = useRef<HTMLDivElement>(null);

  const planView = plan.data;
  // The focus and the "5 min ago" are worked out from this, so an idle board lets a claim run out
  const clock = useClockTick();
  // The Areas are built for a time that moves only when the focus does, so a tick leaves them (and the dialogs drawn from them) as they are
  const focusNow = useMemo(() => focusSignature(focusOf(planView, undefined, clock)), [planView, clock]);
  const [built, setBuilt] = useState(() => stableNow(undefined, focusNow, clock));
  if (built.signature !== focusNow) setBuilt(stableNow(built, focusNow, clock));
  const documents = guidance.data?.documents;
  const newsView = news.data;
  const docsNewsSig = newsView
    ? `${newsView.documents.more}:${newsView.documents.items.map((item) => `${item.name}:${item.change}`).join(',')}`
    : '';
  const prevDocsNewsRef = useRef<{ workspaceId: string; sig: string | null }>({ workspaceId, sig: null });
  useEffect(() => {
    if (!newsView) return;
    const prev = prevDocsNewsRef.current;
    if (prev.workspaceId !== workspaceId || prev.sig === null) {
      prevDocsNewsRef.current = { workspaceId, sig: docsNewsSig };
      return;
    }
    if (docsNewsSig !== prev.sig) {
      prevDocsNewsRef.current = { workspaceId, sig: docsNewsSig };
      if (newsView.documents.items.length > 0 || newsView.documents.more > 0) {
        void queryClient.invalidateQueries({ queryKey: workspaceFilesKey(workspaceId) });
      }
    }
  }, [workspaceId, newsView, docsNewsSig, queryClient]);
  const boardNewsView = useMemo(() => boardNews(newsView, recent.data), [newsView, recent.data]);
  const board = boardQuery.data;
  const workspaceFiles = workspaceFilesQuery.data?.files;
  const [showArchived, setShowArchived] = useState(false);

  // Source loading & error indicators
  const parts = [
    { what: 'The plan', query: plan },
    { what: 'The documents', query: guidance },
    { what: 'The commits', query: news },
    { what: 'The notes and files', query: boardQuery },
  ].map(({ what, query }) => ({ what, query, loading: !query.data && !query.isError, failed: !query.data && query.isError }));
  const loading = parts.some((part) => part.loading);
  const problems = parts.filter((part) => part.failed);

  // Logical Areas
  // The work not committed yet: the Code button counts it and the current Area draws one card for each repository that has some.
  // While the Code window is open that section polls the same listing, so this one rests.
  const codeOpen = useCodeWindowOpen(workspaceId);
  const { summary: changes } = useRepoChanges(workspaceId, { enabled: listening && !readOnly, paused: codeOpen });
  const areas = useMemo(
    () => buildBoardAreas({ plan: planView, documents, news: boardNewsView, board, workspaceFiles, showArchived, focusNow: built.at }).map((area) => (area.data.current && changes.repos.length > 0 ? { ...area, uncommitted: changes.repos } : area)),
    [planView, documents, boardNewsView, board, workspaceFiles, showArchived, changes.repos, built.at],
  );

  // Plane 0 (Overview) elements
  const [stageContainer, setStageContainer] = useState<HTMLDivElement | null>(null);
  const stageSize = useLayoutElementSize(stageContainer);
  const overviewFlow = useRef<ReactFlowInstance<OverviewNode> | null>(null);
  const [overviewInstance, setOverviewInstance] = useState<ReactFlowInstance<OverviewNode> | null>(null);
  const overviewTaken = useRef(false);
  const overviewTakenBefore = useRef(false);
  const takeOverview = useCallback(() => { overviewTaken.current = true; }, []);
  // The form the view was laid out for: a new form is a new layout, so the view goes back to the plan's
  const overviewForm = useRef<string | null>(null);
  // The Areas folded into the overview's last row, shown (not saved)
  const [foldOpen, setFoldOpen] = useState(false);

  const overview = useMemo(() => overviewPlan(areas, stageSize, { expanded: foldOpen }), [areas, stageSize, foldOpen]);
  const toggleFold = useCallback(() => {
    // The rows are laid out again and the view follows them
    overviewTaken.current = false;
    setFoldOpen((open) => !open);
  }, []);
  const overviewNodes = useMemo<OverviewNode[]>(
    () => overview.nodes.map((node): OverviewNode => (node.type === 'areaFold' ? { ...node, data: { ...node.data, onToggle: toggleFold } } : node)),
    [overview.nodes, toggleFold],
  );
  const overviewLines = useMemo(() => overviewEdges(areas, overviewNodes, board?.links ?? []), [areas, overviewNodes, board?.links]);
  // Only rows and small cards fold, and only they scroll: a form without a fold (or one that fits every Area) leaves the folded Areas as they were
  const foldNode = overview.nodes.find((node) => node.type === 'areaFold');
  const foldKind = foldNode?.data?.kind;
  const prevFoldKind = useRef(foldKind);
  useEffect(() => {
    if (!foldNode && foldOpen) {
      // The fold went away by itself (the window grew): the view is laid out again, as when the person closes it
      overviewTaken.current = false;
      setFoldOpen(false);
    } else if (prevFoldKind.current === 'more' && foldKind === 'done' && foldOpen) {
      overviewTaken.current = false;
      setFoldOpen(false);
    }
    prevFoldKind.current = foldKind;
  }, [foldNode, foldKind, foldOpen]);

  const totalArchived = board?.cards.filter((card) => card.archived).length ?? 0;

  // Reader state
  const [reader, setReader] = useState<{ target: ReaderTarget; request: number; trail: ReaderTrail } | null>(null);
  const [layout, setLayout] = useReaderLayout();
  const requests = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  /** Which node and control the opener was, to find it again when the rows were laid out again and its button was drawn anew. */
  const openerWas = useRef<{ node: string; label: string } | null>(null);
  const pressedLink = useRef<HTMLElement | null>(null);

  const show = useCallback((target: ReaderTarget, from: HTMLElement | null, preserveIntent = false) => {
    if (!preserveIntent) invalidateReferenceIntent();
    // A commit opens in the Code window (its Commits mode), with the commits of the row it was pressed in, in the order the row shows them.
    const commitOpen = commitOpenFor(areas, target);
    if (commitOpen) {
      openCodeWindow(workspaceId, { opener: from ?? pressedLink.current, commit: commitOpen, preserveIntent: true });
      return;
    }
    opener.current = from ?? pressedLink.current;
    const node = opener.current?.closest('.react-flow__node')?.getAttribute('data-id');
    const label = opener.current?.getAttribute('aria-label') ?? (opener.current instanceof HTMLAnchorElement ? opener.current.textContent?.trim() : null);
    openerWas.current = node && label ? { node, label } : null;
    requests.current += 1;
    const allTargets = areas.flatMap((a) => collectAreaReaderTargets(a));
    const matching = allTargets.find((t) => isSameReaderTarget(t, target) || (!t.source && !target.source && !t.repo && !target.repo && !t.commit && !target.commit && t.path === target.path));
    const resolved: ReaderTarget = matching
      ? { ...matching, ...target, ...(matching.card ? { card: matching.card } : {}), ...(matching.text ? { text: matching.text } : {}), ...(matching.byline ? { byline: matching.byline } : {}) }
      : target;
    setReader({ target: resolved, request: requests.current, trail: startTrail(resolved) });
  }, [areas, setReader, workspaceId]);

  const openInReader = useCallback((target: ReaderTarget, from: HTMLElement | null) => show(target, from), [show]);
  const closeReader = useCallback(() => {
    invalidateReferenceIntent();
    setReader(null);
    setThreadSelectedId(null);
  }, [setReader]);
  const changeLayout = useCallback((next: ReaderLayout) => setLayout(next), [setLayout]);

  // Following something from inside the reader is a step deeper: the place left stays on the trail, and Back, Alt+Left and Escape return to it.
  // (The card the trail started from keeps the keyboard and the light; the opener is not touched.)
  const openFileReference = useOpenFileReference(workspaceId, workspacePath ?? '');
  const areasRef = useRef(areas);
  useLayoutEffect(() => {
    areasRef.current = areas;
  }, [areas]);
  const openLinked = useCallback((path: string, line?: number, root = workspacePath) => {
    void openFileReference({ path, line, cwd: root, onReader: (resolved, intent) => {
      const allTargets = areasRef.current.flatMap((a) => collectAreaReaderTargets(a));
      requests.current += 1;
      const request = requests.current;
      setReader((current) => {
        if (!current || !referenceIntentIsCurrent(intent)) return current;
        const repo = resolved.origin.kind === 'repository' ? { name: resolved.origin.repoName, path: resolved.origin.repoPath } : undefined;
        const target = (!repo ? allTargets.find((t) => !t.source && !t.repo && !t.commit && t.path === resolved.file) : undefined)
          ?? { path: resolved.file, title: fileTitle(resolved.file), ...(repo ? { repo } : {}) };
        const trail = pushTrail(current.trail, target);
        return trail === current.trail ? { ...current, request } : { target, request, trail };
      });
    } });
  }, [openFileReference, workspacePath]);
  const goBack = useCallback(() => {
    invalidateReferenceIntent();
    requests.current += 1;
    const request = requests.current;
    setReader((current) => {
      const target = current && backTarget(current.trail);
      return current && target ? { target, request, trail: backTrail(current.trail) } : current;
    });
  }, []);
  const documentRequest = useDocumentRequest(workspaceId);
  useEffect(() => {
    if (!active || !documentRequest) return;
    const { name, repo, opener: from, intent } = documentRequest.request;
    if (intent === undefined || referenceIntentIsCurrent(intent)) {
      pressedLink.current = null;
      show({ path: name, title: fileTitle(name), repo }, from ?? null, intent !== undefined);
    }
    documentRequests.acknowledge(workspaceId, documentRequest.id);
  }, [active, documentRequest, show, workspaceId]);

  // Board index sidebar state
  const [boardRow, setBoardRow] = useState<HTMLDivElement | null>(null);
  const boardRowSize = useLayoutElementSize(boardRow);
  const navDock = sidebarDock(boardRowSize.width);
  // What the person chose (kept per device), else what suits the Areas: it starts closed when that gives a better form of the overview
  // (cards over small cards over rows). That is decided once, when the Areas and the section's size are known and the index docks (where it overlays, it takes no
  // room, so there is nothing to decide), and then left alone as the board changes. Until it is decided, and until the stage has the
  // size it has with the index as decided, the board is laid out but not drawn: the index and the rows are not seen for a moment and
  // then replaced by cards.
  const [navChoice, setNavChoice] = useState(readNavChoice);
  const [navAuto, setNavAuto] = useState<boolean | null>(null);
  const [navShown, setNavShown] = useState(false);
  const navOpen = navChoice ?? navAuto ?? false;
  const navUndecided = navChoice === null && navAuto === null && !navDock.overlays;
  // The plan, the documents and the notes make the Areas; the commits only add a line of counts to one, so the decision does not wait for them
  const areasLoading = [plan, guidance, boardQuery].some((query) => !query.data && !query.isError);
  useLayoutEffect(() => {
    if (!navUndecided || areasLoading || areas.length === 0 || boardRowSize.width === 0) return;
    setNavAuto(navStartsOpen(areas, boardRowSize));
  }, [navUndecided, areasLoading, areas, boardRowSize]);
  const stageWidth = boardRowSize.width - (navOpen ? SIDEBAR.width : SIDEBAR.railWidth);
  const stageDock = readerDock(stageWidth);
  const navSettling = navChoice === null && !navShown && !navDock.overlays;
  useLayoutEffect(() => {
    if (navSettling && !navUndecided && Math.abs(stageSize.width - stageWidth) <= 1 && stageSize.height > 0) setNavShown(true);
  }, [navSettling, navUndecided, stageSize, stageWidth]);
  useEffect(() => {
    // The stage is sized by the layout: this only keeps the board from staying hidden if it ever is not
    if (!navSettling || navUndecided) return;
    const timer = setTimeout(() => setNavShown(true), 400);
    return () => clearTimeout(timer);
  }, [navSettling, navUndecided]);
  const [narrowNavOpen, setNarrowNavOpen] = useState(false);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const navFocusDue = useRef(false);
  const navExpanded = navDock.overlays ? narrowNavOpen : navOpen;
  const onToggleNavOpen = useCallback(() => {
    navFocusDue.current = true;
    overviewTaken.current = false;
    writeNavOpen(!navOpen);
    setNavChoice(!navOpen);
  }, [navOpen]);
  const openNarrowNav = useCallback(() => {
    navFocusDue.current = true;
    setNarrowNavOpen(true);
  }, []);
  const closeNarrowNav = useCallback(() => {
    navFocusDue.current = true;
    setNarrowNavOpen(false);
  }, []);
  const [navMode, setNavModeState] = useState<NavMode>(readNavMode);
  const onNavModeChange = useCallback((next: NavMode) => {
    setNavModeState(next);
    writeNavMode(next);
  }, []);
  const [navQuery, setNavQuery] = useState('');
  const fileReturnPending = useRef<{ kind: 'reader' | 'code'; seen: boolean } | null>(null);
  const [fileReturn, setFileReturn] = useState(0);
  useEffect(() => {
    const pending = fileReturnPending.current;
    if (!pending) return;
    const busy = pending.kind === 'reader' ? Boolean(reader) : codeOpen;
    if (busy) { pending.seen = true; return; }
    if (!pending.seen) return;
    fileReturnPending.current = null;
    if (!active) return;
    if (navDock.overlays) setNarrowNavOpen(true);
    setFileReturn((value) => value + 1);
  }, [reader, codeOpen, active, navDock.overlays]);
  const navSections = useMemo(
    () => buildBoardNav(areas, { mode: navMode, query: navQuery }),
    [areas, navMode, navQuery],
  );
  const navWaitingCount = useMemo(() => totalBoardWaiting(areas), [areas]);

  useEffect(() => {
    if (!navDock.overlays && narrowNavOpen) {
      setNarrowNavOpen(false);
    }
  }, [navDock.overlays, narrowNavOpen]);

  // The rail and the header each have their own toggle, so the one that was pressed is gone when the index opens or
  // closes: focus the one that is shown now (the narrow drawer's search box takes the focus when it opens)
  useLayoutEffect(() => {
    if (!navFocusDue.current) return;
    navFocusDue.current = false;
    if (navDock.overlays && narrowNavOpen) return;
    navToggleRef.current?.focus({ preventScroll: true });
  }, [navExpanded, navDock.overlays, narrowNavOpen]);

  // Stepping In and Out state
  const [stepped, setStepped] = useState<SteppedState>(null);
  const steppedRef = useRef<SteppedState>(null);
  useLayoutEffect(() => { steppedRef.current = stepped; }, [stepped]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<string | null>(null);
  const focusing = useRef(false);

  const activeArea = areas.find((a) => a.id === stepped?.areaId);
  const [areaAddStepOpen, setAreaAddStepOpen] = useState(false);
  const [areaAddStepText, setAreaAddStepText] = useState('');
  const [areaAddStepError, setAreaAddStepError] = useState<string | null>(null);

  // Which row of the Area is open, and its page, if any (not saved). One at a time; it belongs to the Area it was opened in.
  const [openState, setOpenState] = useState<{ areaId: string; rowId: string; page: number } | null>(null);
  const steppedAreaId = stepped?.areaId;
  const openRow = openState && openState.areaId === steppedAreaId ? openState.rowId : null;
  const openPage = openState && openState.areaId === steppedAreaId ? openState.page : 0;
  const openRef = useRef<{ rowId: string | null; page: number }>({ rowId: null, page: 0 });
  useLayoutEffect(() => { openRef.current = { rowId: openRow, page: openPage }; }, [openRow, openPage]);
  useEffect(() => {
    if (!stepped) setOpenState(null);
  }, [stepped]);
  // Which tab of the row that is not tied to a step shows, if one was chosen (not saved); it belongs to the Area it was chosen in
  const [tabState, setTabState] = useState<{ areaId: string; tab: LooseTab } | null>(null);
  const looseTab = tabState && tabState.areaId === steppedAreaId ? tabState.tab : undefined;
  useEffect(() => {
    if (!stepped) setTabState(null);
  }, [stepped]);
  const chooseTab = useCallback((areaId: string, tab: LooseTab) => {
    setTabState((curr) => (curr && curr.areaId === areaId && curr.tab === tab ? curr : { areaId, tab }));
  }, []);

  // Board trail: places left before a jump (from Now line, news, index, count, step, picture)
  const [boardTrail, setBoardTrail] = useState<BoardTrail>(createBoardTrail);
  const boardTrailRef = useRef<BoardTrail>(boardTrail);
  useLayoutEffect(() => { boardTrailRef.current = boardTrail; }, [boardTrail]);
  const boardBackFocus = useRef<BoardTrailFocus | null>(null);

  const recordBoardJump = useCallback((originEl?: HTMLElement | null, originAreaId?: string) => {
    const active = (originEl && originEl.isConnected)
      ? originEl
      : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const nodeEl = active?.closest<HTMLElement>('.react-flow__node');
    const rawTestId = active?.dataset?.testid ?? active?.closest<HTMLElement>('[data-testid]:not(.react-flow__node):not([data-testid^="rf__"])')?.dataset?.testid;
    const testId = rawTestId?.startsWith('rf__') ? undefined : rawTestId;
    const navItem = active?.dataset?.navItem ?? active?.closest<HTMLElement>('[data-nav-item]')?.dataset?.navItem;
    const countKind = active?.dataset?.countKind ?? active?.closest<HTMLElement>('[data-count-kind]')?.dataset?.countKind;
    const ariaLabel = active?.getAttribute('aria-label') ?? (active instanceof HTMLAnchorElement ? active.textContent?.trim() : undefined);
    const nodeId = originAreaId ?? nodeEl?.dataset?.id ?? nodeEl?.getAttribute?.('data-id');
    const focus: BoardTrailFocus | null = active ? {
      ...(nodeId ? { nodeId } : {}),
      ...(ariaLabel ? { ariaLabel } : {}),
      ...(testId ? { testId } : {}),
      ...(active.id ? { id: active.id } : {}),
      ...(navItem ? { navItem } : {}),
      ...(countKind ? { countKind } : {}),
    } : null;

    const currStepped = steppedRef.current;
    const narrowWasOpen = Boolean(navDock.overlays && narrowNavOpen);
    if (currStepped?.phase === 'open') {
      const area = areas.find((a) => a.id === currStepped.areaId);
      const title = area?.data?.title ?? currStepped.areaId;
      setBoardTrail((curr) => pushBoardTrail(curr, {
        level: currStepped.areaId,
        title,
        openRow: openRef.current.rowId,
        tab: tabState && tabState.areaId === currStepped.areaId ? tabState.tab : undefined,
        page: openRef.current.page,
        fold: false,
        focus,
        narrowNavOpen: narrowWasOpen,
      }));
    } else {
      setBoardTrail((curr) => pushBoardTrail(curr, {
        level: 'overview',
        title: 'Overview',
        openRow: null,
        tab: null,
        page: 0,
        fold: foldOpen,
        focus,
        narrowNavOpen: narrowWasOpen,
      }));
    }
  }, [areas, tabState, foldOpen, navDock.overlays, narrowNavOpen]);

  // Pending jump to item or area
  const [pendingJump, setPendingJump] = useState<{
    areaId: string;
    nodeId: string;
    readerTarget?: ReaderTarget;
    /** A jump that only lights the card (the add of a note): no thread is selected, so nothing else dims */
    lightOnly?: boolean;
    request: number;
  } | null>(null);
  const pendingJumpRef = useRef<typeof pendingJump>(null);
  const jumpSeq = useRef(0);
  const jumpFrames = useRef(0);
  const [jumpTick, setJumpTick] = useState(0);

  // Follow the thread state: selected card and its connected chain (links, steps, commits)
  const [threadSelectedId, setThreadSelectedId] = useState<string | null>(null);

  const clearJump = useCallback(() => {
    pendingJumpRef.current = null;
    jumpFrames.current = 0;
    setPendingJump(null);
  }, []);

  const goBackOnBoard = useCallback(() => {
    const target = backBoardTarget(boardTrailRef.current);
    if (!target) return;

    setBoardTrail((curr) => backBoardTrail(curr));
    boardBackFocus.current = target.focus ?? null;
    focusTarget.current = null;
    if (target.narrowNavOpen) {
      setNarrowNavOpen(true);
    }

    if (target.level === 'overview') {
      if (steppedRef.current) {
        setAreaAddStepOpen(false);
        setAreaAddStepText('');
        setAreaAddStepError(null);
        clearJump();
        invalidateReferenceIntent();
        setThreadSelectedId(null);
        setReader(null);
        if (closeTimer.current) {
          clearTimeout(closeTimer.current);
          closeTimer.current = null;
        }
        if (target.fold !== undefined) {
          setFoldOpen(target.fold);
        }
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          setStepped(null);
        } else {
          setStepped((curr) => (curr ? { ...curr, phase: 'closing' } : null));
          closeTimer.current = setTimeout(() => {
            closeTimer.current = null;
            setStepped(null);
          }, 210);
        }
      } else {
        if (target.fold !== undefined) {
          setFoldOpen(target.fold);
        }
      }
    } else {
      clearJump();
      invalidateReferenceIntent();
      setThreadSelectedId(null);
      setReader(null);
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      if (target.tab) {
        chooseTab(target.level, target.tab as LooseTab);
      }
      const page = target.page ?? 0;
      if (target.openRow) {
        openRef.current = { rowId: target.openRow, page };
        setOpenState({ areaId: target.level, rowId: target.openRow, page });
      } else {
        openRef.current = { rowId: null, page: 0 };
        setOpenState(null);
      }
      setStepped((curr) =>
        curr?.areaId === target.level && curr.phase === 'open'
          ? curr
          : { areaId: target.level, origin: '50% 50%', phase: 'open' },
      );
    }
  }, [clearJump, setReader, setThreadSelectedId, chooseTab, setFoldOpen]);

  const boardBackTarget = backBoardTarget(boardTrail);
  const boardBackLabel = boardBackTarget ? backBoardLabel(boardBackTarget) : null;

  const jumpToArea = useCallback((areaId: string) => {
    clearJump();
    invalidateReferenceIntent();
    setNarrowNavOpen(false);
    if (reader) setReader(null);
    setThreadSelectedId(null);
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (!overviewNodes.some((n) => n.id === areaId)) {
      setFoldOpen(true);
    }
    const overviewNode = overviewNodes.find((n) => n.id === areaId);
    if (overviewNode && overviewFlow.current) {
      revealOverviewNode(overviewFlow.current, overviewNode, stageSize, takeOverview);
    }
    const nodeEl = stageContainer?.querySelector<HTMLElement>(`.react-flow__node[data-id="${areaId}"]`);
    let origin = '12% 50%';
    if (nodeEl && stageContainer) {
      const btnRect = nodeEl.getBoundingClientRect();
      const stageRect = stageContainer.getBoundingClientRect();
      if (stageRect.width > 0 && stageRect.height > 0) {
        const xPct = Math.round(((btnRect.left + btnRect.width / 2 - stageRect.left) / stageRect.width) * 100);
        const yPct = Math.round(((btnRect.top + btnRect.height / 2 - stageRect.top) / stageRect.height) * 100);
        origin = `${xPct}% ${yPct}%`;
      }
    }
    setStepped((curr) =>
      curr?.areaId === areaId && curr.phase === 'open'
        ? curr
        : { areaId, origin, phase: 'open' },
    );
  }, [clearJump, reader, setReader, setNarrowNavOpen, overviewNodes, stageContainer, stageSize, setThreadSelectedId, takeOverview]);

  const jumpToItem = useCallback((item: Pick<NavItem, 'areaId' | 'nodeId' | 'readerTarget'>, openReader?: boolean, lightOnly?: boolean) => {
    if (item.nodeId === null) {
      jumpToArea(item.areaId);
      return;
    }
    setNarrowNavOpen(false);
    invalidateReferenceIntent();
    // A jump that does not open the reader closes it, or the card would be behind it; one into another Area closes the old Area's reader too
    const opensReader = Boolean(openReader && item.readerTarget);
    if (!opensReader || stepped?.areaId !== item.areaId) setReader(null);
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (!stepped && overviewFlow.current) {
      const overviewNode = overviewNodes.find((n) => n.id === item.areaId);
      if (overviewNode) {
        revealOverviewNode(overviewFlow.current, overviewNode, stageSize, takeOverview);
      }
    }
    const nodeEl = stageContainer?.querySelector<HTMLElement>(`.react-flow__node[data-id="${item.areaId}"]`);
    let origin = '12% 50%';
    if (nodeEl && stageContainer) {
      const btnRect = nodeEl.getBoundingClientRect();
      const stageRect = stageContainer.getBoundingClientRect();
      if (stageRect.width > 0 && stageRect.height > 0) {
        const xPct = Math.round(((btnRect.left + btnRect.width / 2 - stageRect.left) / stageRect.width) * 100);
        const yPct = Math.round(((btnRect.top + btnRect.height / 2 - stageRect.top) / stageRect.height) * 100);
        origin = `${xPct}% ${yPct}%`;
      }
    }
    const nextJump = {
      areaId: item.areaId,
      nodeId: item.nodeId,
      ...(opensReader && item.readerTarget ? { readerTarget: item.readerTarget } : {}),
      ...(lightOnly ? { lightOnly: true } : {}),
      request: ++jumpSeq.current,
    };
    jumpFrames.current = 0;
    pendingJumpRef.current = nextJump;
    setPendingJump(nextJump);
    setStepped((curr) =>
      curr?.areaId === item.areaId && curr.phase === 'open'
        ? curr
        : { areaId: item.areaId, origin, phase: 'open' },
    );
  }, [jumpToArea, stepped, setReader, setNarrowNavOpen, overviewNodes, stageContainer, stageSize, takeOverview]);

  // The Now line: what is happening, what waits, what is new, and the way to search
  const focus = useMemo(() => focusOf(planView, undefined, clock), [planView, clock]);
  const nowParts = useMemo(() => nowLineParts({ focus, areas, news: newsView, now: new Date(clock) }), [focus, areas, newsView, clock]);
  const newsLines = useMemo(() => (newsView && !newsView.empty ? buildNewsLines(newsView, areas, new Date(clock)) : []), [newsView, areas, clock]);
  const markSeen = useMarkNewsSeen(workspaceId);
  const goToNow = useCallback(() => {
    const target = nowLineTarget(areas, focus);
    if (!target) return;
    const originBtn = root.current?.querySelector<HTMLElement>('[data-testid="board-now-main"]');
    recordBoardJump(originBtn);
    if (target.nodeId) jumpToItem({ areaId: target.areaId, nodeId: target.nodeId }, false, true);
    else jumpToArea(target.areaId);
  }, [areas, focus, jumpToItem, jumpToArea, recordBoardJump]);
  const goToQuestion = useCallback(() => {
    const waiting = firstWaiting(areas);
    if (waiting) {
      const originBtn = root.current?.querySelector<HTMLElement>('[data-testid="board-now-question"]');
      recordBoardJump(originBtn);
      jumpToItem(waiting, false);
    }
  }, [areas, jumpToItem, recordBoardJump]);
  const goToNews = useCallback((line: NewsLine) => {
    if (!line.jump) return;
    const originBtn = root.current?.querySelector<HTMLElement>('[data-testid="board-now-news"]');
    recordBoardJump(originBtn);
    if (line.jump.nodeId) jumpToItem({ areaId: line.jump.areaId, nodeId: line.jump.nodeId, readerTarget: line.jump.readerTarget }, false);
    else jumpToArea(line.jump.areaId);
  }, [jumpToItem, jumpToArea, recordBoardJump]);
  // The search is the Board index's own: opening it (it may be folded to its rail, or a drawer) and putting the keyboard in its box
  const [searchRequest, setSearchRequest] = useState(0);
  const openSearch = useCallback(() => {
    if (navDock.overlays) {
      if (!narrowNavOpen) openNarrowNav();
    } else if (!navOpen) {
      overviewTaken.current = false;
      writeNavOpen(true);
      setNavChoice(true);
    }
    setSearchRequest((n) => n + 1);
  }, [navDock.overlays, narrowNavOpen, navOpen, openNarrowNav]);
  useEffect(() => {
    if (!active || areas.length === 0) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      // Another pane that owns the key while the keyboard is in it (the chat's saved conversations) keeps it; a modal dialog keeps it from the Board behind it
      if (isTypingTarget(event.target) || isCodeWindowOpen() || document.querySelector('[role="dialog"]') || document.activeElement?.closest('[data-slash-owner]')) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, areas.length, openSearch]);

  // Stepped fallback redirect if active area disappeared
  useEffect(() => {
    if (!stepped) return;
    if (!loading && areas.length === 0) {
      clearJump();
      setReader(null);
      setStepped(null);
      return;
    }
    if (areas.length > 0 && !areas.some((a) => a.id === stepped.areaId)) {
      const fallback = areas.find((a) => a.data.current)?.id ?? areas[0]!.id;
      clearJump();
      setStepped((s) => (s ? { ...s, areaId: fallback } : null));
    }
  }, [stepped, loading, areas, setReader, clearJump]);

  const stepInto = useCallback((areaId: string, buttonEl: HTMLElement) => {
    clearJump();
    invalidateReferenceIntent();
    setThreadSelectedId(null);
    setReader(null);
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const btnRect = buttonEl.getBoundingClientRect();
    const stageRect = stageContainer?.getBoundingClientRect();
    const xPct = stageRect && stageRect.width > 0 ? Math.round(((btnRect.left + btnRect.width / 2 - stageRect.left) / stageRect.width) * 100) : 50;
    const yPct = stageRect && stageRect.height > 0 ? Math.round(((btnRect.top + btnRect.height / 2 - stageRect.top) / stageRect.height) * 100) : 50;
    setStepped({ areaId, origin: `${xPct}% ${yPct}%`, phase: 'open' });
  }, [stageContainer, clearJump, setThreadSelectedId]);

  const stepOut = useCallback(() => {
    const curr = steppedRef.current;
    if (!curr || curr.phase === 'closing') return;
    setAreaAddStepOpen(false);
    setAreaAddStepText('');
    setAreaAddStepError(null);
    focusTarget.current = curr.areaId;
    clearJump();
    invalidateReferenceIntent();
    setThreadSelectedId(null);
    setReader(null);
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStepped(null);
      return;
    }
    setStepped({ ...curr, phase: 'closing' });
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setStepped(null);
    }, 210);
  }, [setReader, clearJump, setThreadSelectedId]);

  const [areaCanvasContainer, setAreaCanvasContainer] = useState<HTMLDivElement | null>(null);
  // Focus restoration when reader closes. Declared before the step-in/step-out focus effects below: when a jump closes the
  // reader and changes the Area in one commit, the old opener is still connected here, so those later effects must run after
  // it and win (otherwise focus ends on the opener, then falls to BODY when React Flow removes it).
  const wasReaderOpen = useRef(false);
  /** The control to put the keyboard on when the reader has closed and the card it came from is not drawn yet (the rows are laid out again). */
  const openerRetry = useRef<{ was: { node: string; label: string }; card: string | null; until: number; placedFor: string | null } | null>(null);
  const [openerTick, setOpenerTick] = useState(0);
  /** The card the reader showed last: when it was walked on from the card it was opened on, that is the card to come back to */
  const lastReadCard = useRef<string | null>(null);
  /** A card's own control: the one the keyboard goes to */
  const findCardControl = useCallback((cardId: string) => {
    const nodeEl = Array.from(areaCanvasContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? []).find((el) => el.dataset.id === cardId);
    return nodeEl ? (firstControl(nodeEl, 'button') ?? firstControl(nodeEl)) : null;
  }, [areaCanvasContainer]);
  const findOpener = useCallback((was: { node: string; label: string }) => {
    const container = stepped ? areaCanvasContainer : stageContainer;
    const nodeEl = Array.from(container?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])
      .find((el) => el.dataset.id === was.node);
    if (!nodeEl) return null;
    return nodeEl.querySelector<HTMLElement>(`[aria-label="${was.label.replace(/["\\]/g, '\\$&')}"]`)
      ?? Array.from(nodeEl.querySelectorAll<HTMLAnchorElement>('a')).find((a) => a.textContent?.trim() === was.label)
      ?? null;
  }, [stepped, areaCanvasContainer, stageContainer]);
  useLayoutEffect(() => {
    if (reader) { wasReaderOpen.current = true; return; }
    if (!wasReaderOpen.current) return;
    wasReaderOpen.current = false;
    const read = lastReadCard.current;
    lastReadCard.current = null;
    const from = opener.current;
    const was = openerWas.current;
    // The reader was walked on to another card: that card is where the keyboard and the view come back to
    const card = stepped && was && read && read !== was.node ? read : null;
    opener.current = null;
    openerWas.current = null;
    if (skipFocusReturn.current) { skipFocusReturn.current = false; return; }
    const target = (stepped && card) ? findCardControl(card) : from?.isConnected && from.getClientRects().length > 0 ? from : was ? findOpener(was) : null;
    focusing.current = true;
    (target ?? (stepped ? areaCanvasContainer : stageContainer)?.querySelector<HTMLElement>('.react-flow') ?? root.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    focusing.current = false;
    if (was) {
      openerRetry.current = { was, card, until: Date.now() + 1500, placedFor: null };
      setOpenerTick((tick) => (tick + 1) % 1000);
    }
  }, [reader, stepped, areaCanvasContainer, stageContainer, findOpener, findCardControl]);

  // The newest nodes and stage size for the focus return below, which must not run again when they change
  const overviewNow = useRef({ nodes: overviewNodes, size: stageSize, viewport: overview.viewport });
  overviewNow.current = { nodes: overviewNodes, size: stageSize, viewport: overview.viewport };

  // Restore keyboard focus to Area button when stepping out
  const tryFocusArea = useCallback((id: string): boolean => {
    if (steppedRef.current?.phase === 'open' || boardBackFocus.current !== null) return false;
    const nodeEl = Array.from(stageContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])
      .find((el) => el.dataset.id === id);
    const btn = nodeEl?.querySelector<HTMLElement>('button.board-area');
    if (btn) {
      focusing.current = true;
      btn.focus({ preventScroll: true });
      focusing.current = false;
      const { nodes, size, viewport } = overviewNow.current;
      const overviewNode = nodes.find((n) => n.id === id);
      if (overviewNode) revealOverviewNode(overviewFlow.current, overviewNode, size, takeOverview, overviewTaken.current ? undefined : viewport ?? undefined);
      if (document.activeElement === btn || !steppedRef.current) {
        focusTarget.current = null;
      }
      return true;
    }
    return false;
  }, [stageContainer, takeOverview]);

  useLayoutEffect(() => {
    const id = focusTarget.current;
    if (!id || stepped?.phase === 'open') return;
    if (!tryFocusArea(id) && !foldOpen) {
      setFoldOpen(true);
    }
  }, [stepped, foldOpen, tryFocusArea]);

  useEffect(() => {
    const id = focusTarget.current;
    if (!id || stepped?.phase === 'open') return;
    let frame: number;
    let cancelled = false;
    const deadline = Date.now() + 2000;

    const check = () => {
      if (cancelled) return;
      const currentId = focusTarget.current;
      if (!currentId || steppedRef.current?.phase === 'open') return;
      if (tryFocusArea(currentId)) return;
      if (Date.now() < deadline) {
        frame = requestAnimationFrame(check);
      } else {
        focusTarget.current = null;
      }
    };

    frame = requestAnimationFrame(check);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [stepped, foldOpen, tryFocusArea, overviewNodes]);

  // Focus Back button when stepped into an area (skipping when a jump to an item is pending in this area)
  useLayoutEffect(() => {
    if (stepped?.phase === 'open') {
      if (pendingJumpRef.current?.areaId === stepped.areaId || boardBackFocus.current !== null) return;
      backButtonRef.current?.focus({ preventScroll: true });
    }
  }, [stepped?.phase, stepped?.areaId]);

  // Plane 0 Viewport auto-fitting
  const overviewViewport = overview.viewport;

  const formNow = overview.form;
  useEffect(() => {
    if (overviewForm.current !== formNow) {
      // Small cards and rows are only readable at zoom 1, which the old view may not have: whatever the person did, the new layout starts from the plan's view
      if (overviewForm.current !== null) overviewTaken.current = false;
      overviewForm.current = formNow;
    }
    if (!overviewViewport || !overviewInstance || overviewTaken.current) return;
    void overviewInstance.setViewport(overviewViewport, { duration: moveMs(200) });
  }, [overviewViewport, overviewInstance, formNow]);

  // Plane 1 (Inside Area) elements
  const areaHeadingId = useId();
  const areaSubmittingRef = useRef(false);
  const changePlanMutation = useChangePlanFile(workspaceId);

  const [areaRow, setAreaRow] = useState<HTMLDivElement | null>(null);
  const areaSection = useLayoutElementSize(areaRow);
  const areaDock = readerDock(areaSection.width);
  const areaCanvasSize = useLayoutElementSize(areaCanvasContainer);
  const areaFlow = useRef<ReactFlowInstance<BoardNode> | null>(null);
  const [areaInstance, setAreaInstance] = useState<ReactFlowInstance<BoardNode> | null>(null);

  useEffect(() => {
    if (!stepped) setAreaInstance(null);
  }, [stepped]);
  // The tab that shows when none was chosen is decided once, when the row first shows with tabs, and held: a picture arriving later does not turn it
  const looseDefault = useMemo(
    () => (stepped && activeArea ? areaRows(activeArea, { news: boardNewsView }).find((row) => row.tabs)?.tabs?.first : undefined),
    [stepped, activeArea, boardNewsView],
  );
  useEffect(() => {
    if (!steppedAreaId || !looseDefault) return;
    setTabState((curr) => (curr && curr.areaId === steppedAreaId ? curr : { areaId: steppedAreaId, tab: looseDefault }));
  }, [steppedAreaId, looseDefault]);
  /** Where a card is: its tab, its row and its page. */
  const showPlace = useCallback((areaId: string, place: { row: string | null; page: number; tab?: LooseTab }) => {
    if (place.tab) chooseTab(areaId, place.tab);
    setOpenState(place.row ? { areaId, rowId: place.row, page: place.page } : null);
  }, []);

  // The rows are laid out for the canvas as it is: what the reader docked beside it leaves
  const areaReady = areaCanvasSize.width > 0 && areaCanvasSize.height > 0;
  const areaDrawn = useMemo(() => {
    if (!activeArea || !areaReady) return { nodes: [] as BoardNode[], open: null };
    const { nodes, open } = areaLayout(activeArea, { news: boardNewsView, size: areaCanvasSize, openRow, page: openPage, ...(looseTab ? { tab: looseTab } : {}) });
    return { nodes: nodes.map((node) => (node.width !== undefined && node.height !== undefined ? { ...node, measured: { width: node.width, height: node.height } } : node) as BoardNode[][number]), open };
  }, [activeArea, areaReady, boardNewsView, areaCanvasSize, openRow, openPage, looseTab]);
  const areaNodes = areaDrawn.nodes;
  const areaOpen = areaDrawn.open;
  const rowIds = useMemo(() => (activeArea && areaReady ? areaRowIds(activeArea, { news: boardNewsView, size: areaCanvasSize }) : []), [activeArea, areaReady, boardNewsView, areaCanvasSize]);

  // A row that is no longer there (a live change took its things away), or a page past the end, is let go at once, so Escape works on the first press
  useEffect(() => {
    if (!openState || openState.areaId !== steppedAreaId || !areaReady || !activeArea) return;
    if (!rowIds.includes(openState.rowId)) setOpenState(null);
    else if (areaOpen && areaOpen.page !== openState.page) setOpenState({ ...openState, page: areaOpen.page });
  }, [openState, steppedAreaId, areaReady, activeArea, rowIds, areaOpen]);

  const areaEdges = useMemo(() => oneLinePerPair(boardEdges(areaNodes, board?.links ?? [])), [areaNodes, board]);
  // Inside an Area a line is drawn only for a card the pointer is on or the keyboard is in (`data-lit`, see index.css). This sets the attribute on the
  // lines in the DOM and keeps no state: a render on every hover or focus would move things under a press in progress.
  const litNodes = useRef<{ pointed: string | null; focused: string | null }>({ pointed: null, focused: null });
  const lightAreaEdges = useCallback((change: Partial<{ pointed: string | null; focused: string | null }>) => {
    litNodes.current = { ...litNodes.current, ...change };
    const { pointed, focused } = litNodes.current;
    for (const el of Array.from(areaCanvasContainer?.querySelectorAll<SVGElement>('.react-flow__edge') ?? [])) {
      const id = el.getAttribute('data-id') || el.id?.replace(/^react-flow__edge-/, '');
      const edge = areaEdges.find((entry) => entry.id === id);
      const lit = Boolean(edge) && [pointed, focused].some((node) => node !== null && (edge!.source === node || edge!.target === node));
      el.toggleAttribute('data-lit', lit);
    }
  }, [areaCanvasContainer, areaEdges]);
  // The lines are drawn again when the rows change: what was lit is lit again
  useLayoutEffect(() => { lightAreaEdges({}); }, [lightAreaEdges, areaNodes]);

  // A press anywhere ends the looking after the keyboard: whoever pressed has put it where they want it, and putting it back on the opener
  // in the middle of a drag over a card's text (the focus moves, and the selection stops) is the one thing to avoid.
  useEffect(() => {
    const leave = () => {
      openerRetry.current = null;
      focusTarget.current = null;
      boardBackFocus.current = null;
    };
    document.addEventListener('pointerdown', leave, true);
    return () => document.removeEventListener('pointerdown', leave, true);
  }, []);

  // Focus restoration when returning along the board trail
  const restoreBoardFocus = useCallback((focus: BoardTrailFocus, container: HTMLElement | null): boolean => {
    if (!container) return false;
    if (steppedRef.current?.phase === 'closing') return false;

    let target: HTMLElement | null = null;

    if (focus.countKind && focus.nodeId) {
      const nodeEl = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${focus.nodeId}"]`)
        ?? document.querySelector<HTMLElement>(`.react-flow__node[data-id="${focus.nodeId}"]`);
      if (nodeEl) {
        target = nodeEl.querySelector<HTMLElement>(`button[data-count-kind="${focus.countKind}"]`);
      }
    }

    if (!target && focus.countKind) {
      target = container.querySelector<HTMLElement>(`button[data-count-kind="${focus.countKind}"]`)
        ?? document.querySelector<HTMLElement>(`button[data-count-kind="${focus.countKind}"]`);
    }

    if (!target && focus.navItem) {
      target = container.querySelector<HTMLElement>(`button[data-nav-item="${focus.navItem}"]`)
        ?? document.querySelector<HTMLElement>(`button[data-nav-item="${focus.navItem}"]`);
    }

    if (!target && focus.testId) {
      target = container.querySelector<HTMLElement>(`[data-testid="${focus.testId}"]`) ?? document.querySelector<HTMLElement>(`[data-testid="${focus.testId}"]`);
    }

    if (!target && focus.nodeId) {
      const nodeEl = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${focus.nodeId}"]`)
        ?? document.querySelector<HTMLElement>(`.react-flow__node[data-id="${focus.nodeId}"]`);
      if (nodeEl) {
        if (focus.ariaLabel) {
          target = nodeEl.querySelector<HTMLElement>(`[aria-label="${focus.ariaLabel.replace(/["\\]/g, '\\$&')}"]`)
            ?? Array.from(nodeEl.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')).find((el) => el.textContent?.trim() === focus.ariaLabel)
            ?? null;
        }
        if (!target && !focus.ariaLabel) {
          target = firstControl(nodeEl, 'button') ?? firstControl(nodeEl) ?? nodeEl;
        }
      }
    }

    if (!target && focus.ariaLabel) {
      target = container.querySelector<HTMLElement>(`[aria-label="${focus.ariaLabel.replace(/["\\]/g, '\\$&')}"]`)
        ?? Array.from(container.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')).find((el) => el.textContent?.trim() === focus.ariaLabel)
        ?? document.querySelector<HTMLElement>(`[aria-label="${focus.ariaLabel.replace(/["\\]/g, '\\$&')}"]`);
    }

    if (!target && focus.id) {
      target = document.getElementById(focus.id);
    }

    if (target && target.isConnected) {
      if (!target.matches('button, a, input, select, textarea, [tabindex]')) {
        target = firstControl(target, 'button') ?? firstControl(target) ?? target;
      }

      if (focus.nodeId && overviewFlow.current) {
        const overviewNode = overviewNodes.find((n) => n.id === focus.nodeId);
        if (overviewNode) {
          revealOverviewNode(overviewFlow.current, overviewNode, stageSize, takeOverview, overviewTaken.current ? undefined : overview.viewport ?? undefined);
        }
      }

      focusing.current = true;
      target.focus({ preventScroll: true });
      focusing.current = false;

      return document.activeElement === target;
    }
    return false;
  }, [overviewNodes, stageSize, takeOverview, overview.viewport]);

  useLayoutEffect(() => {
    const focus = boardBackFocus.current;
    if (!focus) return;
    if (stepped?.phase === 'closing') return;
    const container = stepped?.phase === 'open' ? areaCanvasContainer : root.current;
    if (restoreBoardFocus(focus, container) && document.activeElement !== document.body) {
      boardBackFocus.current = null;
    }
  }, [boardTrail, stepped, areaCanvasContainer, restoreBoardFocus]);

  useEffect(() => {
    const focus = boardBackFocus.current;
    if (!focus) return;
    let frame: number;
    let cancelled = false;
    const deadline = Date.now() + 2000;

    const check = () => {
      if (cancelled) return;
      const currentFocus = boardBackFocus.current;
      if (!currentFocus) return;
      if (steppedRef.current?.phase === 'closing') {
        frame = requestAnimationFrame(check);
        return;
      }
      const container = steppedRef.current?.phase === 'open' ? areaCanvasContainer : root.current;
      if (restoreBoardFocus(currentFocus, container)) {
        if (document.activeElement === document.body) {
          frame = requestAnimationFrame(check);
          return;
        }
        boardBackFocus.current = null;
        return;
      }
      if (Date.now() < deadline) {
        frame = requestAnimationFrame(check);
      } else {
        if (currentFocus.nodeId) {
          const nodeEl = container?.querySelector<HTMLElement>(`.react-flow__node[data-id="${currentFocus.nodeId}"]`)
            ?? document.querySelector<HTMLElement>(`.react-flow__node[data-id="${currentFocus.nodeId}"]`);
          if (nodeEl) {
            const fallback = firstControl(nodeEl, 'button') ?? firstControl(nodeEl);
            if (fallback) fallback.focus({ preventScroll: true });
          }
        }
        boardBackFocus.current = null;
      }
    };

    frame = requestAnimationFrame(check);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [boardTrail, stepped, areaCanvasContainer, restoreBoardFocus, foldOpen]);

  // Alt+Left goes back on the board trail when focus is on the board and not in a field, reader or code window
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' || !event.altKey || event.defaultPrevented) return;
      if (isCodeWindowOpen()) return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (reader) return;
      if (event.target instanceof Element && event.target.closest('[data-board-reader]')) return;
      if (!canGoBackBoard(boardTrailRef.current)) return;

      const target = event.target;
      const inside = target instanceof Node && Boolean(root.current?.contains(target));
      if (!inside && target !== document.body && target !== document.documentElement) return;

      event.preventDefault();
      goBackOnBoard();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, reader, goBackOnBoard]);

  const areaSizeKey = `${areaCanvasSize.width}x${areaCanvasSize.height}`;
  useEffect(() => {
    const retry = openerRetry.current;
    if (!retry) return;
    const target = (stepped && retry.card) ? findCardControl(retry.card) : findOpener(retry.was);
    const active = document.activeElement;
    const adrift = !active || active === document.body || (active instanceof HTMLElement && active.classList.contains('react-flow'));
    // The keyboard has been put somewhere else meanwhile: leave it
    if (!adrift && active !== target) { openerRetry.current = null; return; }
    if (target && adrift) {
      focusing.current = true;
      target.focus({ preventScroll: true });
      focusing.current = false;
    }
    // The canvas has its whole size again and the card is on another page of the row, or in a row that is folded: its row is opened at its page
    if (!target && retry.placedFor !== areaSizeKey && activeArea && areaReady && !areaNodes.some((areaNode) => areaNode.id === (retry.card ?? retry.was.node))) {
      retry.placedFor = areaSizeKey;
      const place = areaPlace(activeArea, { news: boardNewsView, size: areaCanvasSize }, retry.card ?? retry.was.node);
      if (place) showPlace(activeArea.id, place);
    }
    // The rows may be laid out again a frame or two after the reader closed, so the keyboard is looked after for a few frames
    if (Date.now() > retry.until) { openerRetry.current = null; return; }
    const frame = requestAnimationFrame(() => setOpenerTick((tick) => (tick + 1) % 1000));
    return () => cancelAnimationFrame(frame);
  }, [openerTick, areaNodes, findOpener, activeArea, areaReady, boardNewsView, areaCanvasSize, areaSizeKey, showPlace, findCardControl]);

  const activeReaderCardId = useMemo(() => {
    // The card lit is the one the trail started from, not the file followed from it
    const lit = reader?.trail.origin;
    if (!lit) return null;
    if (lit.card) return lit.card;
    if (activeArea) {
      if (lit.path && !lit.repo && !lit.source && !lit.commit) {
        const match = activeArea.cards.find((c) => 'path' in c && c.path === lit.path);
        if (match) return match.id;
      }
      const allTargets = collectAreaReaderTargets(activeArea);
      const found = allTargets.find((t) => isSameReaderTarget(t, lit));
      if (found?.card) return found.card;
      if (lit.path && !lit.repo && !lit.source && !lit.commit) {
        const byPath = allTargets.find((t) => !t.repo && !t.source && !t.commit && t.path === lit.path);
        if (byPath?.card) return byPath.card;
      }
    }
    return null;
  }, [reader, activeArea]);

  useLayoutEffect(() => { if (reader && activeReaderCardId) lastReadCard.current = activeReaderCardId; }, [reader, activeReaderCardId]);

  // When the canvas changes size (the reader docks beside it, or leaves), the card the reader shows may no longer be drawn: its row is opened at the page it is on
  const lastAreaSize = useRef(areaSizeKey);
  useEffect(() => {
    const changed = lastAreaSize.current !== areaSizeKey;
    lastAreaSize.current = areaSizeKey;
    const card = activeReaderCardId;
    if (!changed || !card || !activeArea || !areaReady || areaNodes.some((areaNode) => areaNode.id === card)) return;
    const place = areaPlace(activeArea, { news: boardNewsView, size: areaCanvasSize }, card);
    if (place) showPlace(activeArea.id, place);
  }, [areaSizeKey, activeReaderCardId, activeArea, areaReady, areaNodes, boardNewsView, areaCanvasSize, showPlace]);

  // Opening or closing a row: the control that was pressed is swapped for another node, so the keyboard is put on the row's control again
  const rowFocus = useRef<{ rowId: string; pressed: HTMLElement | null } | null>(null);
  const rowFocusFrames = useRef(0);
  const keepFocusOn = useCallback((rowId: string) => {
    rowFocusFrames.current = 0;
    rowFocus.current = { rowId, pressed: document.activeElement instanceof HTMLElement ? document.activeElement : null };
  }, []);
  // A press that changes what the row shows ends the thread only when what it then shows holds nothing of it (no card of it, no "+N more", pager or header that holds one): the board is never left dark with nothing lit
  const keepsThread = useCallback((next: { openRow: string | null; page: number; tab: LooseTab | undefined }) => {
    if (!threadSelectedId || !activeArea || !areaReady) return false;
    const { nodes } = areaLayout(activeArea, { news: boardNewsView, size: areaCanvasSize, openRow: next.openRow, page: next.page, ...(next.tab ? { tab: next.tab } : {}) });
    const reached = findThreadChain({ selectedId: threadSelectedId, nodes: nodes as BoardNode[], links: board?.links ?? [], cards: board?.cards ?? [] });
    reached.delete(threadSelectedId);
    return nodes.some((node) => reached.has(node.id) || nodeHolds(node as BoardNode)?.some((id) => reached.has(id)));
  }, [threadSelectedId, activeArea, areaReady, boardNewsView, areaCanvasSize, board]);
  const toggleRow = useCallback((rowId: string) => {
    keepFocusOn(rowId);
    const closing = openState && openState.areaId === steppedAreaId && openState.rowId === rowId;
    if (!keepsThread({ openRow: closing ? null : rowId, page: 0, tab: looseTab })) setThreadSelectedId(null);
    setOpenState((curr) => {
      if (!steppedAreaId) return null;
      return curr && curr.areaId === steppedAreaId && curr.rowId === rowId ? null : { areaId: steppedAreaId, rowId, page: 0 };
    });
  }, [steppedAreaId, keepFocusOn, keepsThread, openState, looseTab]);
  const setRowTab = useCallback((rowId: string, tab: LooseTab) => {
    if (!steppedAreaId) return;
    if (!keepsThread({ openRow: openRow, page: openRow === rowId ? 0 : openPage, tab })) setThreadSelectedId(null);
    chooseTab(steppedAreaId, tab);
    setOpenState((curr) => (curr && curr.areaId === steppedAreaId && curr.rowId === rowId ? { ...curr, page: 0 } : curr));
  }, [steppedAreaId, chooseTab, keepsThread, openRow, openPage]);
  const setRowPage = useCallback((rowId: string, page: number) => {
    if (!keepsThread({ openRow: rowId, page: Math.max(0, page), tab: looseTab })) setThreadSelectedId(null);
    setOpenState((curr) => (steppedAreaId && curr && curr.rowId === rowId ? { ...curr, page: Math.max(0, page) } : curr));
  }, [steppedAreaId, keepsThread, openRow, looseTab]);
  // The control that was pressed may be swapped for another one a frame or two after the row changes (it is drawn then), so for
  // a few frames the keyboard is put on the row's control whenever the pressed one is gone
  const [rowFocusTick, setRowFocusTick] = useState(0);
  useEffect(() => {
    const pending = rowFocus.current;
    if (!pending) return;
    const gone = !pending.pressed?.isConnected || pending.pressed.matches(':disabled') || document.activeElement === document.body || document.activeElement === null;
    const controls = Array.from(areaCanvasContainer?.querySelectorAll<HTMLElement>('[data-row-control]') ?? []).filter((el) => el.dataset.rowControl === pending.rowId);
    if (gone && controls[0]) {
      rowFocus.current = null;
      focusing.current = true;
      controls[0].focus({ preventScroll: true });
      focusing.current = false;
      return;
    }
    if (rowFocusFrames.current >= 12) { rowFocus.current = null; return; }
    const frame = requestAnimationFrame(() => { rowFocusFrames.current += 1; setRowFocusTick((tick) => (tick + 1) % 1000); });
    return () => cancelAnimationFrame(frame);
  }, [areaNodes, areaCanvasContainer, rowFocusTick]);

  // The view of Level 1 never moves: whenever the rows change (a row opened or closed, a page, new data, the size of the canvas) it is set again
  useEffect(() => {
    if (!areaInstance || !steppedAreaId) return;
    void areaInstance.setViewport(areaView(), { duration: 0 });
  }, [areaInstance, steppedAreaId, areaNodes, areaCanvasSize]);

  const activeAreaId = activeArea?.id;

  // Highlight state for nodes jumped to from the Board index sidebar
  const [highlightedNode, setHighlightedNode] = useState<{ id: string; request: number } | null>(null);

  useEffect(() => {
    if (!highlightedNode) return;
    const timer = setTimeout(() => {
      setHighlightedNode((curr) => (curr?.request === highlightedNode.request ? null : curr));
    }, 2200);
    return () => clearTimeout(timer);
  }, [highlightedNode]);

  useLayoutEffect(() => {
    const nodes = areaCanvasContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [];
    for (const el of Array.from(nodes)) {
      if (highlightedNode && el.dataset.id === highlightedNode.id) {
        el.setAttribute('data-highlighted', 'true');
      } else if (el.hasAttribute('data-highlighted')) {
        el.removeAttribute('data-highlighted');
      }
    }
  }, [highlightedNode, areaCanvasContainer, areaNodes]);

  // Whenever the reader shows or navigates to a card or picture, ensure its containing row on the canvas
  // is unfolded at the right page so all items/pictures in that row are visible, and highlight the card.
  useEffect(() => {
    if (!reader || !activeReaderCardId || !activeArea || !areaReady) return;

    setHighlightedNode({ id: activeReaderCardId, request: ++jumpSeq.current });

    const place = areaPlace(activeArea, { news: boardNewsView, size: areaCanvasSize }, activeReaderCardId);
    if (place?.tab) chooseTab(activeArea.id, place.tab);
    if (place?.row) {
      const targetRow = place.row;
      const targetPage = place.page;
      setOpenState((curr) => {
        if (curr && curr.areaId === activeArea.id && curr.rowId === targetRow && curr.page === targetPage) {
          return curr;
        }
        return { areaId: activeArea.id, rowId: targetRow, page: targetPage };
      });
    }
  }, [reader, activeReaderCardId, activeArea, areaReady, boardNewsView, areaCanvasSize, chooseTab]);

  const threadChain = useMemo(() => {
    if (!threadSelectedId) return null;
    const nodes = stepped ? areaNodes : (overviewNodes as unknown as BoardNode[]);
    const chain = findThreadChain({
      selectedId: threadSelectedId,
      nodes,
      links: board?.links ?? [],
      cards: board?.cards ?? [],
    });
    // What the thread reaches that is not drawn (a picture on the other tab, behind "+N more") is stood for by what holds it: the line goes there
    if (stepped) {
      for (const node of nodes) {
        if (nodeHolds(node)?.some((id) => chain.has(id))) chain.add(node.id);
      }
    }
    return chain;
  }, [threadSelectedId, stepped, areaNodes, overviewNodes, board]);

  useLayoutEffect(() => {
    const container = stepped ? areaCanvasContainer : stageContainer;
    if (!container) return;
    const mark = () => {
    const flowEl = container.querySelector<HTMLElement>('.board-flow');
    if (flowEl) {
      // While the reader is open the board stays readable: the thread is not dimmed, and the open card is marked
      if (threadSelectedId && !reader) {
        flowEl.setAttribute('data-thread-active', 'true');
      } else {
        flowEl.removeAttribute('data-thread-active');
      }
    }
    const nodes = container.querySelectorAll<HTMLElement>('.react-flow__node');
    for (const el of Array.from(nodes)) {
      const id = el.dataset.id;
      if (reader && id && id === activeReaderCardId) el.setAttribute('data-reader-open', 'true');
      else el.removeAttribute('data-reader-open');
      if (!threadSelectedId || !threadChain || reader) {
        el.removeAttribute('data-thread');
        el.removeAttribute('data-thread-selected');
      } else if (id === threadSelectedId) {
        el.setAttribute('data-thread', 'active');
        el.setAttribute('data-thread-selected', 'true');
      } else if (id && threadChain.has(id)) {
        el.setAttribute('data-thread', 'active');
        el.removeAttribute('data-thread-selected');
      } else {
        el.removeAttribute('data-thread');
        el.removeAttribute('data-thread-selected');
      }
    }
    const edges = container.querySelectorAll<SVGElement>('.react-flow__edge');
    const currentEdges = stepped ? areaEdges : overviewLines;
    for (const el of Array.from(edges)) {
      const id = el.getAttribute('data-id') || el.id?.replace(/^react-flow__edge-/, '');
      if (!threadSelectedId || !threadChain || !id || reader) {
        el.removeAttribute('data-thread');
      } else {
        const edgeData = currentEdges.find((e) => e.id === id);
        if (edgeData && threadChain.has(edgeData.source) && threadChain.has(edgeData.target)) {
          el.setAttribute('data-thread', 'active');
        } else {
          el.removeAttribute('data-thread');
        }
      }
    }
    };
    mark();
    // The canvas draws a node a frame after the layout changed (a "+N more" that comes with another tab): it is marked when it appears
    const watch = new MutationObserver(mark);
    watch.observe(container, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [
    threadSelectedId,
    threadChain,
    reader,
    activeReaderCardId,
    stepped,
    areaCanvasContainer,
    stageContainer,
    areaNodes,
    overviewNodes,
    areaEdges,
    overviewLines,
  ]);

  // Executing pendingJump: a card in a folded row, behind "+N more" or on another page is drawn when its row is open at its page
  useEffect(() => {
    if (
      !pendingJump ||
      stepped?.phase !== 'open' ||
      activeAreaId !== pendingJump.areaId ||
      !areaReady ||
      !areaInstance
    ) {
      return;
    }

    const matchesTarget = (id: string | undefined, targetId: string) => {
      if (!id) return false;
      if (id === targetId) return true;
      if (id.includes(':step:') && targetId.includes(':step:')) {
        return id.split(':step:')[1] === targetId.split(':step:')[1];
      }
      return false;
    };

    const nodeEl = Array.from(
      areaCanvasContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [],
    ).find((el) => matchesTarget(el.dataset.id, pendingJump.nodeId));

    if (!nodeEl) {
      // The cards of an Area that was just chosen are drawn a frame or two later (and the old Area's are on the screen until then):
      // look again each frame for a while, and give up at once on a card that this Area does not have
      const drawn = areaNodes.some((areaNode) => matchesTarget(areaNode.id, pendingJump.nodeId));
      const place = drawn || !activeArea ? null : areaPlace(activeArea, { news: boardNewsView, size: areaCanvasSize }, pendingJump.nodeId);
      if (!drawn && (!place || jumpFrames.current >= JUMP_FRAMES)) {
        clearJump();
        backButtonRef.current?.focus({ preventScroll: true });
        return;
      }
      if (place?.tab) chooseTab(pendingJump.areaId, place.tab);
      if (place && (place.row !== openRef.current.rowId || (place.row !== null && place.page !== openRef.current.page))) {
        openRef.current = { rowId: place.row, page: place.page };
        setOpenState(place.row ? { areaId: pendingJump.areaId, rowId: place.row, page: place.page } : null);
      }
      if (jumpFrames.current >= JUMP_FRAMES) {
        clearJump();
        backButtonRef.current?.focus({ preventScroll: true });
        return;
      }
      const frame = requestAnimationFrame(() => {
        jumpFrames.current += 1;
        setJumpTick((tick) => tick + 1);
      });
      return () => cancelAnimationFrame(frame);
    }

    const jump = pendingJump;
    clearJump();

    const actualId = nodeEl.dataset.id ?? jump.nodeId;
    // Trigger node highlight
    setHighlightedNode({ id: actualId, request: jump.request });

    // Select thread (the add of a note only lights the note: a selected thread dims everything else)
    setThreadSelectedId(jump.lightOnly ? null : actualId);

    // The cards are not stops of their own (nothing is moved here), so the keyboard goes to the card's first control, or to the card itself
    const inner = firstControl(nodeEl);
    if (!inner && nodeEl.tabIndex < 0) nodeEl.tabIndex = -1;
    const cardFocusEl = nodeEl.tabIndex >= 0 ? nodeEl : (inner ?? nodeEl);

    if (jump.readerTarget) {
      const openerEl = firstControl(nodeEl, 'button') ?? cardFocusEl;
      openInReader(jump.readerTarget, openerEl);
    } else {
      focusing.current = true;
      cardFocusEl.focus({ preventScroll: true });
      focusing.current = false;
    }
  }, [
    pendingJump,
    stepped?.phase,
    activeAreaId,
    activeArea,
    areaReady,
    areaInstance,
    areaCanvasSize,
    areaCanvasContainer,
    areaNodes,
    boardNewsView,
    jumpTick,
    openInReader,
    clearJump,
  ]);

  // Narrow sidebar Escape handling
  useEffect(() => {
    if (!navDock.overlays || !narrowNavOpen || !active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (isCodeWindowOpen()) return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = event.target;
      const inside = target instanceof Node && Boolean(root.current?.contains(target));
      if (!inside && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      closeNarrowNav();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navDock.overlays, narrowNavOpen, active, closeNarrowNav]);

  // A press outside the reader closes it. In the large window or a docked one that covers the canvas: anywhere in the Board pane outside the window (the index and the Area
  // header too). Beside the canvas: anything in the Area except another card (the card does its own thing, and the reader shows it), so a row header,
  // "+N more", the pager, a tab or empty space closes it and still does its own action; the open card, pressed again, closes it and does nothing else.
  // The press must begin and end there, so a text selected in the window and dragged out of it does not close it. The reader's own menu is out of the DOM
  // of this pane (a portal), and a press that only dismisses that menu does not also close the reader.
  const skipFocusReturn = useRef(false);
  useEffect(() => {
    const pane = root.current;
    if (!reader || !pane) return undefined;
    const press: { down: 'no' | 'close' | 'same'; up: 'no' | 'close' | 'same'; ignored: boolean; x: number; y: number } = { down: 'no', up: 'no', ignored: false, x: 0, y: 0 };
    const currentCovers = stepped ? areaDock.covers : stageDock.covers;
    const classify = (target: EventTarget | null): 'no' | 'close' | 'same' => {
      if (!(target instanceof Element) || target.closest('[data-board-reader]')) return 'no';
      if (stepped) {
        if (!target.closest('#board-area')) return 'close';
        const nodeEl = target.closest('.react-flow__node');
        if (!nodeEl) return 'close';
        if (/react-flow__node-(fold|more|pager|step)(\s|$)/.test(nodeEl.getAttribute('class') ?? '')) return 'close';
        if (activeReaderCardId !== null && nodeEl.getAttribute('data-id') === activeReaderCardId) return 'same';
        return layout === 'large' || currentCovers ? 'close' : 'no';
      }
      // Level 0 overview (!stepped):
      if (!target.closest('#board-overview')) return 'close';
      const clickedBtn = target.closest('button');
      const openPath = reader?.target.path;
      const isSameThumbnail = Boolean(
        clickedBtn &&
        openPath &&
        (clickedBtn === opener.current ||
         clickedBtn.getAttribute('data-path') === openPath ||
         clickedBtn.getAttribute('aria-label') === (reader?.target.title || openPath) ||
         clickedBtn.querySelector(`img[src*="${encodeURIComponent(openPath)}"]`) ||
         clickedBtn.querySelector(`img[src*="${openPath}"]`))
      );
      if (isSameThumbnail) return 'same';
      if (layout === 'large' || currentCovers) return 'close';
      if (clickedBtn) {
        const isAnotherThumb = Boolean(
          clickedBtn.hasAttribute('data-path') ||
          clickedBtn.getAttribute('aria-label')?.includes('Picture') ||
          clickedBtn.querySelector('img')
        );
        if (isAnotherThumb) return 'no';
        return 'close';
      }
      return 'close';
    };
    const onDown = (event: PointerEvent) => {
      press.ignored = document.querySelector('[data-slot="menu-popup"]') !== null;
      press.down = classify(event.target);
      press.up = 'no';
      press.x = event.clientX;
      press.y = event.clientY;
    };
    // A drag (an attempt to pan, or a selection) is not a press
    const onUp = (event: PointerEvent) => {
      press.up = layout !== 'large' && !currentCovers && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8 ? 'no' : classify(event.target);
    };
    const onClick = (event: MouseEvent) => {
      const { down, up, ignored } = press;
      press.down = 'no';
      press.up = 'no';
      if (down === 'no' || down !== up || ignored) return;
      if (down === 'same') {
        // Nothing else of the press happens: the card would open the reader again, and select its thread
        event.stopPropagation();
      } else if (event.target instanceof Element && event.target.closest('button, a, [role="button"], [role="tab"]')) {
        // The control that was pressed keeps the keyboard
        skipFocusReturn.current = true;
      }
      closeReader();
    };
    pane.addEventListener('pointerdown', onDown, true);
    pane.addEventListener('pointerup', onUp, true);
    pane.addEventListener('click', onClick);
    return () => {
      pane.removeEventListener('pointerdown', onDown, true);
      pane.removeEventListener('pointerup', onUp, true);
      pane.removeEventListener('click', onClick);
    };
  }, [reader, layout, areaDock.covers, stageDock.covers, stepped, activeReaderCardId, closeReader]);

  // Reader Escape handling. Escape that closes the reader's open menu is the menu's alone: whether one was open is seen first, in the
  // capture phase, because the menu is already closing by the time this listener runs.
  const menuHadEscape = useRef(false);
  const canStepBack = useRef(false);
  canStepBack.current = Boolean(reader && backTarget(reader.trail));
  useEffect(() => {
    if (!reader || !active) return;
    const onCapture = (event: globalThis.KeyboardEvent) => { menuHadEscape.current = event.key === 'Escape' && document.querySelector('[data-slot="menu-popup"]') !== null; };
    window.addEventListener('keydown', onCapture, true);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || menuHadEscape.current) return;
      if (isCodeWindowOpen()) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (navDock.overlays && narrowNavOpen) return;
      const target = event.target;
      const inside = target instanceof Node && Boolean(root.current?.contains(target));
      if (!inside && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      // One step back: along the trail if there is one, else the reader closes
      if (canStepBack.current) goBack();
      else closeReader();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [reader, active, closeReader, goBack, navDock.overlays, narrowNavOpen]);

  // Stepped Area Escape handling (only when reader is closed and no modal dialog is open): an open row closes first, then the Area
  useEffect(() => {
    if (!stepped || stepped.phase !== 'open' || reader || !active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (isCodeWindowOpen()) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (navDock.overlays && narrowNavOpen) return;
      const target = event.target;
      const inside = target instanceof Node && Boolean(root.current?.contains(target));
      if (!inside && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      if (threadSelectedId) {
        setThreadSelectedId(null);
        return;
      }
      if (openRef.current.rowId) {
        const row = openRef.current.rowId;
        keepFocusOn(row);
        openRef.current = { rowId: null, page: 0 };
        setOpenState(null);
        return;
      }
      stepOut();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stepped, reader, active, stepOut, navDock.overlays, narrowNavOpen, keepFocusOn, threadSelectedId]);

  // Level 0 Escape clears thread selection
  useEffect(() => {
    if (stepped || !threadSelectedId || reader || !active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (isCodeWindowOpen()) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (navDock.overlays && narrowNavOpen) return;
      const target = event.target;
      const inside = target instanceof Node && Boolean(root.current?.contains(target));
      if (!inside && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      setThreadSelectedId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stepped, threadSelectedId, reader, active, navDock.overlays, narrowNavOpen]);

  // Reader sequential element navigation within the active area (or the area owning the Level 0 open target)
  const readerArea = useMemo(() => {
    if (activeArea) return activeArea;
    if (!reader) return null;
    return areas.find((a) => collectAreaReaderTargets(a).some((t) => isSameReaderTarget(t, reader.target) || (!t.source && !reader.target.source && !t.repo && !reader.target.repo && !t.commit && !reader.target.commit && t.path === reader.target.path))) ?? null;
  }, [activeArea, reader, areas]);

  const areaReaderTargets = useMemo(() => (readerArea ? collectAreaReaderTargets(readerArea) : []), [readerArea]);

  const currentReaderIndex = useMemo(() => {
    if (!reader) return -1;
    return findReaderTargetIndex(areaReaderTargets, reader.trail.origin);
  }, [areaReaderTargets, reader]);

  const hasPreviousTarget = currentReaderIndex > 0;
  const hasNextTarget = currentReaderIndex >= 0 && currentReaderIndex < areaReaderTargets.length - 1;
  const previousTarget = hasPreviousTarget ? areaReaderTargets[currentReaderIndex - 1] : null;
  const nextTarget = hasNextTarget ? areaReaderTargets[currentReaderIndex + 1] : null;

  const readerBackTarget = reader ? backTarget(reader.trail) : null;
  const readerBack = readerBackTarget ? backLabel(readerBackTarget) : null;

  const readerIndexInfo = currentReaderIndex >= 0 && areaReaderTargets.length > 0
    ? { current: currentReaderIndex + 1, total: areaReaderTargets.length }
    : undefined;

  const navigateToReaderTarget = useCallback(
    (target: ReaderTarget) => {
      invalidateReferenceIntent();
      requests.current += 1;
      const targetArea = readerArea ?? activeArea;
      const resolvedCard = target.card ?? (targetArea ? collectAreaReaderTargets(targetArea).find((t) => isSameReaderTarget(t, target))?.card : undefined);
      const resolvedTarget = resolvedCard ? { ...target, card: resolvedCard } : target;
      setReader({ target: resolvedTarget, request: requests.current, trail: startTrail(resolvedTarget) });
    },
    [readerArea, activeArea],
  );

  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({});
  const [busyStepKeys, setBusyStepKeys] = useState<Set<string>>(new Set());
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});

  const answerMutation = useAnswerDecision(workspaceId);
  const tickStepMutation = useTickPlanStep(workspaceId);
  const runCheckMutation = useRunCheckpointCheck(workspaceId);
  const setNowMutation = useSetPlanNow(workspaceId);
  const setNow = useCallback(async (key: string | null) => {
    try {
      await setNowMutation.mutateAsync(key);
      return true;
    } catch {
      return false;
    }
  }, [setNowMutation]);
  const nowKeys = useMemo(() => workableKeys(planView), [planView]);
  const nowKey = focus?.source === 'set' ? focus.step?.key ?? null : null;

  const answerDecision = useCallback(async (key: string, answer: string, expected?: string, options?: { optimistic?: boolean }) => {
    setDecisionErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await answerMutation.mutateAsync({ key, answer, expected, ...(options?.optimistic === false ? { optimistic: false } : {}) });
      return true;
    } catch (err) {
      setDecisionErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : 'Could not save answer.',
      }));
      throw err;
    }
  }, [answerMutation]);

  const toggleStep = useCallback(async (key: string, done: boolean, expected?: string) => {
    setBusyStepKeys((prev) => new Set(prev).add(key));
    setStepErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await tickStepMutation.mutateAsync({ key, done, expected });
      return true;
    } catch (err) {
      setStepErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : 'Could not update step.',
      }));
      return false;
    } finally {
      setBusyStepKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [tickStepMutation]);

  const runCheck = useCallback(async (checkpointKey: string) => {
    setBusyStepKeys((prev) => new Set(prev).add(checkpointKey));
    setStepErrors((prev) => {
      if (!prev[checkpointKey]) return prev;
      const next = { ...prev };
      delete next[checkpointKey];
      return next;
    });
    try {
      await runCheckMutation.mutateAsync({ key: checkpointKey });
      return true;
    } catch (err) {
      setStepErrors((prev) => ({
        ...prev,
        [checkpointKey]: err instanceof Error ? err.message : 'Check failed.',
      }));
      return false;
    } finally {
      setBusyStepKeys((prev) => {
        const next = new Set(prev);
        next.delete(checkpointKey);
        return next;
      });
    }
  }, [runCheckMutation]);

  const changeBoardMutation = useChangeBoard(workspaceId);

  // A note that was just added: the board goes to it as soon as the board data has it (no fixed delay; the data may arrive after the mutation returns)
  const boardIdsRef = useRef<Set<string>>(new Set());
  boardIdsRef.current = new Set(board?.cards.map((card) => card.id) ?? []);
  const [addedNoteId, setAddedNoteId] = useState<string | null>(null);
  useEffect(() => {
    if (!addedNoteId) return;
    const area = areas.find((entry) => entry.cards.some((card) => card.id === addedNoteId));
    if (!area) return;
    setAddedNoteId(null);
    jumpToItem({ areaId: area.id, nodeId: addedNoteId }, false, true);
  }, [addedNoteId, areas, jumpToItem]);

  const addNote = useCallback(async (note: { title: string; body?: string; area?: string; step?: string; pinned?: boolean }) => {
    try {
      const before = boardIdsRef.current;
      const result = await changeBoardMutation.mutateAsync({ changes: [addNoteChange(note)] });
      const added = result.cards.findLast((card) => !before.has(card.id));
      if (added) setAddedNoteId(added.id);
      return true;
    } catch (err) {
      console.error('Failed to add note:', err);
      return false;
    }
  }, [changeBoardMutation]);

  const updateNote = useCallback(async (id: string, updates: { title?: string; body?: string; pinned?: boolean; archived?: boolean; area?: string | null; step?: string | null }) => {
    try {
      await changeBoardMutation.mutateAsync({ changes: [updateNoteChange(id, updates)] });
      return true;
    } catch (err) {
      console.error('Failed to update note:', err);
      return false;
    }
  }, [changeBoardMutation]);

  const deleteNote = useCallback(async (id: string) => {
    try {
      await changeBoardMutation.mutateAsync({ changes: [deleteNoteChange(id)] });
      return true;
    } catch (err) {
      console.error('Failed to delete note:', err);
      return false;
    }
  }, [changeBoardMutation]);

  const availableAreas = useMemo(() => areas
    .filter((a) => isBoardAreaId(a.id))
    .map((a) => ({
      id: a.id,
      title: a.data.title,
      steps: a.planItems?.steps?.map((s) => ({ key: s.key, text: s.text, done: s.done })),
    })), [areas]);

  const [createNoteOpen, setCreateNoteOpen] = useState(false);
  const [createNoteDefaults, setCreateNoteDefaults] = useState<{ areaId?: string; stepKey?: string }>({});

  const openCreateNoteDialog = useCallback((defaultAreaId?: string, defaultStepKey?: string) => {
    let targetAreaId = defaultAreaId && isBoardAreaId(defaultAreaId) ? defaultAreaId : undefined;
    if (!targetAreaId) {
      if (stepped && activeArea && isBoardAreaId(activeArea.id)) {
        targetAreaId = activeArea.id;
      } else {
        const currentCheckpoint = areas.find((a) => a.data.kind === 'checkpoint' && a.data.current && isBoardAreaId(a.id));
        if (currentCheckpoint) {
          targetAreaId = currentCheckpoint.id;
        } else if (areas.some((a) => a.id === 'plan:own')) {
          targetAreaId = 'plan:own';
        } else {
          const firstValid = areas.find((a) => isBoardAreaId(a.id));
          targetAreaId = firstValid ? firstValid.id : undefined;
        }
      }
    }
    setCreateNoteDefaults({ areaId: targetAreaId, stepKey: defaultStepKey });
    setCreateNoteOpen(true);
  }, [stepped, activeArea, areas]);

  // Actions for Plane 0 & Plane 1
  const overviewActions = useMemo<BoardActions>(() => ({
    workspaceId,
    workspacePath,
    readOnly,
    openArea: stepInto,
    openStep: (areaId: string, stepKey: string, buttonEl?: HTMLElement | null) => {
      recordBoardJump(buttonEl ?? (document.activeElement as HTMLElement), areaId);
      const area = areas.find((a) => a.id === areaId);
      const rows = area ? areaRows(area, { news: newsView, size: stageSize }) : [];
      let targetNodeId = `row:step:${stepKey}`;
      for (const row of rows) {
        if (row.id === `row:step:${stepKey}`) {
          targetNodeId = `row:step:${stepKey}`;
          break;
        }
        if (row.groups?.some((g) => g.key === stepKey)) {
          targetNodeId = `${row.id}:step:${stepKey}`;
          break;
        }
      }
      jumpToItem({ areaId, nodeId: targetNodeId }, false, true);
    },
    openCount: (areaId: string, kind: AreaCountKind, buttonEl?: HTMLElement | null) => {
      recordBoardJump(buttonEl ?? (document.activeElement as HTMLElement), areaId);
      const area = areas.find((a) => a.id === areaId);
      if (!area) return;
      const target = resolveCountTarget(area, kind);
      clearJump();
      setThreadSelectedId(null);
      if (buttonEl) {
        stepInto(areaId, buttonEl);
      } else {
        const nodeEl = stageContainer?.querySelector<HTMLElement>(`.react-flow__node[data-id="${areaId}"]`);
        stepInto(areaId, nodeEl ?? document.body);
      }
      if (target.tab) {
        chooseTab(areaId, target.tab);
      }
      let targetPage = target.page ?? 0;
      if (target.cardId) {
        const place = areaPlace(area, { news: newsView, size: stageSize }, target.cardId);
        if (place) {
          if (place.row) target.rowId = place.row;
          if (place.tab) {
            target.tab = place.tab;
            chooseTab(areaId, place.tab);
          }
          targetPage = place.page;
        }
      }
      if (target.rowId) {
        openRef.current = { rowId: target.rowId, page: targetPage };
        setOpenState({ areaId, rowId: target.rowId, page: targetPage });
      }
      if (target.cardId) {
        jumpToItem({ areaId, nodeId: target.cardId }, false, true);
      } else if (target.stepKey) {
        const rows = areaRows(area, { news: newsView, size: stageSize });
        let targetNodeId = `row:step:${target.stepKey}`;
        for (const row of rows) {
          if (row.id === `row:step:${target.stepKey}`) {
            targetNodeId = `row:step:${target.stepKey}`;
            break;
          }
          if (row.groups?.some((g) => g.key === target.stepKey)) {
            targetNodeId = `${row.id}:step:${target.stepKey}`;
            break;
          }
        }
        jumpToItem({ areaId, nodeId: targetNodeId }, false, true);
      } else if (target.rowId === 'row:waiting') {
        jumpToItem({ areaId, nodeId: 'row:waiting' }, false, true);
      }
    },
    openInReader,
    toggleGroup: () => {},
    keepFocus: () => {},
    selectThread: (id) => setThreadSelectedId((curr) => (curr === id ? null : id)),
    answerDecision,
    decisionErrors,
    toggleStep,
    setNow,
    nowKeys,
    nowKey,
    runCheck,
    busyStepKeys,
    stepErrors,
    addNote,
    updateNote,
    deleteNote,
    availableAreas,
    askInCLI,
  }), [workspaceId, workspacePath, readOnly, stepInto, jumpToItem, clearJump, openInReader, chooseTab, setOpenState, stageContainer, answerDecision, setThreadSelectedId, decisionErrors, toggleStep, setNow, nowKeys, nowKey, runCheck, busyStepKeys, stepErrors, addNote, updateNote, deleteNote, availableAreas, askInCLI, areas, newsView, stageSize, recordBoardJump]);

  const areaActions = useMemo<BoardActions>(() => ({
    workspaceId,
    workspacePath,
    readOnly,
    openInReader,
    toggleGroup: () => {},
    keepFocus: () => {},
    toggleRow,
    setRowPage,
    setRowTab,
    selectThread: (id) => setThreadSelectedId((curr) => (curr === id ? null : id)),
    answerDecision,
    decisionErrors,
    toggleStep,
    setNow,
    nowKeys,
    nowKey,
    runCheck,
    busyStepKeys,
    stepErrors,
    addNote,
    updateNote,
    deleteNote,
    availableAreas,
    askInCLI,
  }), [workspaceId, workspacePath, readOnly, openInReader, toggleRow, setRowPage, setRowTab, answerDecision, setThreadSelectedId, decisionErrors, toggleStep, setNow, nowKeys, nowKey, runCheck, busyStepKeys, stepErrors, addNote, updateNote, deleteNote, availableAreas, askInCLI]);

  const backdropPress = useRef({ down: false, up: false });

  // `inArea`: in the header of an Area, narrower than LABELS_FROM the label gives way to the icon (the name and the tooltip stay), so that the
  // pane icon and Close are never pushed out of the header
  const noteButton = (defaultAreaId?: string, inArea = false) => (
    readOnly ? null : inArea ? (
      <>
        <IconButton
          label="Add a note"
          variant="outline"
          size="sm"
          icon={<StickyNote aria-hidden="true" />}
          className="nodrag nopan cursor-pointer @[44rem]:hidden"
          data-testid="area-add-note-icon"
          onClick={() => openCreateNoteDialog(defaultAreaId)}
        />
        <Button
          size="sm"
          variant="outline"
          title="Add a note"
          aria-label="Add a note"
          className="nodrag nopan hidden gap-1.5 px-2.5 text-[12.5px] font-medium @[44rem]:inline-flex"
          onClick={() => openCreateNoteDialog(defaultAreaId)}
        >
          <Plus className="size-4" aria-hidden="true" />
          <span className="sr-only">+ </span>
          <span>Note</span>
        </Button>
      </>
    ) : (
      <Button
        size="sm"
        variant="outline"
        title="Add a note"
        className="nodrag nopan gap-1.5 text-[12.5px] font-medium"
        onClick={() => openCreateNoteDialog(defaultAreaId)}
      >
        <Plus className="size-4" aria-hidden="true" />
        <span className="sr-only">+ </span>
        <span>Note</span>
      </Button>
    )
  );

  // The way into the Code window: the files changed and not committed yet. Shown with the Add buttons, at Level 0 and in an Area.
  // `inArea`: narrower than 44rem the word gives way to the icon, and the count stays
  const codeButton = (inArea = false) => {
    if (readOnly) return null;
    const name = changes.files > 0 ? `Code, ${filesChangedText(changes.files)}` : 'Code';
    return (
      <Button
        size="sm"
        variant="outline"
        title={name}
        aria-label={name}
        data-testid="board-code-button"
        className={cn('nodrag nopan min-h-[24px] cursor-pointer gap-1.5 px-2.5 text-[12.5px] font-medium', inArea && 'gap-0.5 px-1 @[34rem]:gap-1 @[34rem]:px-1.5 @[44rem]:gap-1.5 @[44rem]:px-2.5')}
        onClick={(event) => openCodeWindow(workspaceId, { opener: event.currentTarget })}
      >
        <Code2 className="size-4" aria-hidden="true" />
        <span className={inArea ? 'hidden @[44rem]:inline' : undefined}>Code</span>
        {changes.files > 0 && <span className={cn('tabular-nums text-muted-foreground', inArea && 'hidden @[30rem]:inline')}>{changes.files}</span>}
      </Button>
    );
  };

  // The pane's own icons (hide the chat, close) are the board's to show, since it has no title row of its own: quiet until pointed at or
  // focused. At the overview they stand in its top-right corner, which the layout leaves free; inside an Area, at the end of its heading.
  const paneIcons = panelActions && (
    <div className="flex shrink-0 items-center gap-0.5 opacity-50 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100 pointer-coarse:opacity-100">{panelActions}</div>
  );
  const paneCorner = (
    <div className="absolute right-2 top-1.5 z-10 flex items-center gap-1.5">
      {codeButton()}
      {noteButton()}
      {paneIcons}
    </div>
  );

  const notices = (problems.length > 0 || (loading && areas.length > 0)) && (
    <div className={cn('shrink-0 space-y-1.5 border-b border-border/60 px-4 py-2', areas.length === 0 && panelActions && 'pr-24')}>
      {problems.map((part) => (
        <SourceProblem key={part.what} what={part.what} error={part.query.error} onRetry={() => void part.query.refetch()} />
      ))}
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Still loading: {parts.filter((part) => part.loading).map((part) => part.what.replace(/^The /, '')).join(', ')}
        </p>
      )}
    </div>
  );

  let emptyBody;
  if (loading) {
    emptyBody = (
      <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner role="presentation" aria-hidden="true" className="size-4" />Loading the board
      </div>
    );
  } else if (problems.length === 0) {
    emptyBody = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Kanban aria-hidden="true" /></EmptyMedia>
          <EmptyDescription>Nothing on the board yet. The plan, documents and commits of this workspace appear here, and so do the notes and files you and the AI add.</EmptyDescription>
        </EmptyHeader>
        <div className="mt-2">
          {noteButton()}
        </div>
      </Empty>
    );
  }

  // Keep the overview reader mounted as loading/empty content gains its first Area.
  const body = (
      <div ref={setBoardRow} className={cn('relative flex min-h-0 flex-1 overflow-hidden', areas.length > 0 && navSettling && 'pointer-events-none opacity-0')} inert={areas.length > 0 && navSettling ? true : undefined}>
        {<BoardSidebar
          workspaceId={workspaceId}
          workspacePath={workspacePath}
          active={active}
          fileReturn={fileReturn}
          onOpenFile={(file, button) => {
            fileReturnPending.current = { kind: !file.document ? 'code' : 'reader', seen: false };
            if (navDock.overlays) setNarrowNavOpen(false);
            if (file.repo && !file.document) openCodeWindow(workspaceId, { opener: button, file: { repoName: file.repo.name, repoPath: file.repo.path, file: file.path } });
            else if (!file.document) openCodeWindow(workspaceId, { opener: button, workspaceFile: { workspaceId, file: file.path } });
            else show({ path: file.path, title: fileTitle(file.path), repo: file.repo }, button);
          }}
          dock={navDock}
          open={navOpen}
          onToggleOpen={onToggleNavOpen}
          narrowOpen={narrowNavOpen}
          onOpenNarrow={openNarrowNav}
          onCloseNarrow={closeNarrowNav}
          mode={navMode}
          onModeChange={onNavModeChange}
          query={navQuery}
          onQueryChange={setNavQuery}
          sections={navSections}
          waitingCount={navWaitingCount}
          steppedAreaId={stepped?.areaId ?? null}
          onJumpToArea={(areaId) => {
            recordBoardJump(document.activeElement as HTMLElement);
            jumpToArea(areaId);
          }}
          onJumpToItem={(item, openReaderTarget) => {
            recordBoardJump(document.activeElement as HTMLElement);
            jumpToItem(item, openReaderTarget);
          }}
          toggleButtonRef={navToggleRef}
          focusSearch={searchRequest}
        />}
        <div
          className="relative flex min-h-0 min-w-0 flex-1"
          inert={navDock.overlays && narrowNavOpen ? true : undefined}
        >
          {/* Plane 0 Overview: recedes behind scrim when stepped into */}
          <div
            id="board-overview"
            className="board-overview-plane absolute inset-0 flex"
            data-receded={stepped?.phase === 'open'}
            inert={stepped?.phase === 'open' ? true : undefined}
          >
            <div className="relative flex min-w-0 flex-1 flex-col" inert={!stepped && Boolean(reader) && (areas.length === 0 || layout === 'large' || stageDock.covers) ? true : undefined}>
              {guidance.data && (
                <AssignmentCard
                  key={workspaceId}
                  workspaceId={workspaceId}
                  guidance={guidance.data}
                  readOnly={readOnly}
                  hidden={Boolean(stepped) || !active}
                  readerOpen={Boolean(reader)}
                  onOpenSource={(doc, from) => openInReader(specTarget(doc), from)}
                />
              )}
              <div className="relative min-h-0 flex-1">
              <div
                ref={setStageContainer}
                className="absolute inset-0"
                onPointerDownCapture={(event) => {
                  overviewTakenBefore.current = overviewTaken.current;
                  if (isViewGesture(stageContainer, event.target)) overviewTaken.current = true;
                }}
                onMouseDownCapture={(event) => {
                  if (event.detail >= 2) overviewTaken.current = overviewTakenBefore.current;
                }}
                onWheelCapture={(event) => {
                  if (stageContainer?.contains(event.target as Node)) overviewTaken.current = true;
                }}
                onFocusCapture={(event) => {
                  if (!focusing.current) showFocused(overviewFlow.current, event, stageSize, () => { overviewTaken.current = true; });
                }}
              >
                {stepped?.phase !== 'open' && paneCorner}
                {areas.length > 0 && totalArchived > 0 && (
                  <div className="absolute left-3 top-2 z-10">
                    <Button
                      size="xs"
                      variant={showArchived ? 'secondary' : 'outline'}
                      aria-pressed={showArchived}
                      onClick={() => setShowArchived((s) => !s)}
                    >
                      <Archive aria-hidden="true" />
                      Archived ({totalArchived})
                    </Button>
                  </div>
                )}
                {areas.length > 0 ? <BoardActionsContext value={overviewActions}>
                    <ReactFlow
                      id="board-overview-flow"
                      className="board-flow"
                      proOptions={{ hideAttribution: true }}
                      aria-label="Board overview canvas. Arrow keys pan, zero puts the board back in view. Press an area to step into it."
                      tabIndex={0}
                      nodes={overviewNodes}
                      edges={overviewLines}
                      nodeTypes={OVERVIEW_NODE_TYPES}
                      defaultEdgeOptions={EDGE_OPTIONS}
                      defaultViewport={overviewViewport ?? undefined}
                      connectionMode={ConnectionMode.Loose}
                      onInit={(instance) => {
                        overviewFlow.current = instance;
                        setOverviewInstance(instance);
                      }}
                      onPaneClick={() => setThreadSelectedId(null)}
                      onKeyDown={(event) => {
                        navigate(overviewFlow.current, event, () => { overviewTaken.current = true; }, () => {
                          overviewTaken.current = false;
                          if (overviewViewport) void overviewFlow.current?.setViewport(overviewViewport, { duration: moveMs(200) });
                        });
                      }}
                      nodesDraggable={false}
                      nodesConnectable={false}
                      nodesFocusable={false}
                      edgesFocusable={false}
                      elementsSelectable={false}
                      deleteKeyCode={null}
                      panActivationKeyCode={null}
                      selectionKeyCode={null}
                      multiSelectionKeyCode={null}
                      zoomActivationKeyCode={null}
                      disableKeyboardA11y
                      zoomOnScroll={false}
                      zoomOnPinch={false}
                      zoomOnDoubleClick={false}
                      panOnScroll={foldOpen}
                      minZoom={READABLE_ZOOM}
                      maxZoom={1}
                      attributionPosition="bottom-center"
                    >
                      <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
                    </ReactFlow>
                </BoardActionsContext> : <div className="flex h-full flex-col">{emptyBody}</div>}
              </div>
              </div>
            </div>
            {!stepped && reader && (
              <BoardReader
                workspaceId={workspaceId}
                workspacePath={workspacePath}
                target={reader.target}
                request={reader.request}
                layout={layout}
                onLayout={changeLayout}
                covers={areas.length === 0 || stageDock.covers}
                width={stageDock.width}
                onClose={closeReader}
                onOpenFile={openLinked}
                active={active}
                back={readerBack ? { label: readerBack, onBack: goBack } : undefined}
                trailId={reader.trail.id}
                onNext={nextTarget ? () => navigateToReaderTarget(nextTarget) : undefined}
                onPrevious={previousTarget ? () => navigateToReaderTarget(previousTarget) : undefined}
                nextTitle={nextTarget?.title}
                previousTitle={previousTarget?.title}
                indexInfo={readerIndexInfo}
                onAskInCLI={askInCLI}
              />
            )}
          </div>

        {/* Plane 1 Stepped Area Surface */}
        {stepped && activeArea && (
          <div
            className={cn(
              'board-overview-scrim absolute inset-0 z-20 flex p-3 sm:p-4 bg-background/70',
              stepped.phase === 'closing' && 'pointer-events-none',
            )}
            inert={stepped.phase === 'closing' ? true : undefined}
            aria-hidden={stepped.phase === 'closing' ? 'true' : undefined}
            onPointerDown={(event) => {
              backdropPress.current = { down: event.target === event.currentTarget, up: false };
            }}
            onPointerUp={(event) => {
              backdropPress.current.up = event.target === event.currentTarget;
            }}
            onClick={(event) => {
              const { down, up } = backdropPress.current;
              backdropPress.current = { down: false, up: false };
              if (down && up && event.target === event.currentTarget) {
                stepOut();
              }
            }}
          >
            <section
              id="board-area"
              role="region"
              aria-labelledby={areaHeadingId}
              style={{ transformOrigin: stepped.origin }}
              className={cn(
                'relative flex h-full w-full flex-col overflow-clip rounded-2xl border border-border bg-background shadow-2xl',
                stepped.phase === 'closing' ? 'board-area-exit' : 'board-area-enter',
              )}
            >
              <header className="@container shrink-0 border-b border-border/60">
              {/* One 48 px line from 22rem up; narrower than that (a phone) the title keeps 7rem and the buttons wrap under it, so that nothing is pushed out */}
              <div className="flex min-h-12 flex-wrap items-center gap-x-1 gap-y-1 px-3 py-1.5 @[22rem]:flex-nowrap @[22rem]:gap-x-1.5 @[22rem]:py-0">
                {boardBackTarget && boardBackTarget.level !== 'overview' && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="max-w-40 shrink min-w-0 gap-1 font-medium"
                    data-testid="board-back-button"
                    aria-label={`Back to ${boardBackLabel}`}
                    title={`Back to ${boardBackLabel} (Alt+←)`}
                    onClick={goBackOnBoard}
                  >
                    <ChevronLeft aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate">{boardBackLabel}</span>
                  </Button>
                )}
                <Button
                  ref={backButtonRef}
                  type="button"
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  onClick={boardBackTarget?.level === 'overview' ? goBackOnBoard : stepOut}
                >
                  Board ›
                </Button>
                <h2
                  id={areaHeadingId}
                  className={cn(
                    'max-w-full truncate text-sm font-semibold text-foreground',
                    boardBackTarget && boardBackTarget.level !== 'overview'
                      ? 'min-w-[7.5rem] @[22rem]:min-w-[7.5rem]'
                      : 'min-w-[7rem] @[22rem]:min-w-[2rem]',
                  )}
                  title={activeArea.data.title}
                >
                  {activeArea.data.title}
                </h2>
                {activeArea.data.kind === 'checkpoint' && activeArea.data.done && (
                  <span className="sr-only shrink-0 @[26rem]:not-sr-only"><Badge variant="success">Done</Badge></span>
                )}
                {activeArea.data.kind === 'plan' && <span className="sr-only shrink-0 @[26rem]:not-sr-only"><Badge variant="outline">Plan</Badge></span>}
                {activeArea.data.waitingCount > 0 && !areaNodes.some((areaNode) => areaNode.id === activeArea.id) && (
                  <span className="sr-only shrink-0 @[26rem]:not-sr-only"><Badge variant="warning">{waitingText(activeArea.data.waitingCount)}</Badge></span>
                )}
                {activeArea.data.kind !== 'work' && (
                  <span className="sr-only shrink-0 whitespace-nowrap text-[12.5px] text-muted-foreground @[34rem]:not-sr-only @[34rem]:inline">
                    {activeArea.data.kind === 'files'
                      ? formatWorkspaceFileCounts(activeArea.data).join(' · ')
                      : stepsText(activeArea.data)}
                  </span>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-0.5 @[34rem]:gap-1">
                  {activeArea.data.kind !== 'work' && activeArea.data.kind !== 'files' && !readOnly && (
                    <>
                      <IconButton
                        label="Add a step"
                        variant="outline"
                        size="sm"
                        icon={<ListPlus aria-hidden="true" />}
                        className="nodrag nopan cursor-pointer @[44rem]:hidden"
                        data-testid="area-add-step-icon"
                        onClick={() => {
                          setAreaAddStepOpen(true);
                          setAreaAddStepError(null);
                        }}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="area-add-step-button"
                        title="Add a step"
                        aria-label="Add a step"
                        className="nodrag nopan hidden min-h-[24px] cursor-pointer gap-1.5 px-2.5 text-[12.5px] font-medium @[44rem]:inline-flex"
                        onClick={() => {
                          setAreaAddStepOpen(true);
                          setAreaAddStepError(null);
                        }}
                      >
                        <Plus className="size-4" aria-hidden="true" />
                        <span className="sr-only">+ </span>
                        <span>Step</span>
                      </Button>
                    </>
                  )}
                  {codeButton(true)}
                  {activeArea.data.kind !== 'files' && noteButton(activeArea.id, true)}
                  {activeArea.archivedCount > 0 && (
                    <Button
                      size="xs"
                      variant={showArchived ? 'secondary' : 'outline'}
                      className="shrink-0 gap-0.5 px-1 @[34rem]:gap-1 @[34rem]:px-1.5 @[44rem]:px-2"
                      aria-pressed={showArchived}
                      aria-label={`Archived (${activeArea.archivedCount})`}
                      title={`Archived (${activeArea.archivedCount})`}
                      onClick={() => setShowArchived((s) => !s)}
                    >
                      <Archive aria-hidden="true" />
                      <span className="hidden @[44rem]:inline">Archived </span>({activeArea.archivedCount})
                    </Button>
                  )}
                  {paneIcons}
                </div>
              </div>
              </header>
              {areaAddStepOpen && (
                <div data-testid="area-add-step-panel" className="border-b border-border bg-card px-3 py-2">
                  <form
                    data-testid="area-add-step-form"
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const step = areaAddStepText.trim();
                      if (!step || changePlanMutation.isPending || areaSubmittingRef.current) return;
                      areaSubmittingRef.current = true;
                      setAreaAddStepError(null);
                      try {
                        const cpKey = activeArea.checkpointKey ?? (activeArea.data.kind === 'checkpoint' ? activeArea.id.replace(/^area:checkpoint:|^checkpoint:/, '') : undefined);
                        await changePlanMutation.mutateAsync({
                          type: 'add',
                          step,
                          ...(cpKey ? { checkpoint: cpKey } : {}),
                        });
                        setAreaAddStepText('');
                        setAreaAddStepOpen(false);
                      } catch (err) {
                        setAreaAddStepError(err instanceof Error ? err.message : 'Could not add step.');
                      } finally {
                        areaSubmittingRef.current = false;
                      }
                    }}
                  >
                    <Input
                      autoFocus
                      data-testid="area-add-step-input"
                      aria-label="New step description"
                      placeholder={`Add step to ${activeArea.data.title}…`}
                      value={areaAddStepText}
                      onChange={(e) => setAreaAddStepText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setAreaAddStepOpen(false);
                          setAreaAddStepText('');
                          setAreaAddStepError(null);
                        }
                      }}
                      className="min-h-[28px] h-7 flex-1 text-[12.5px] px-2.5 py-1 min-w-[200px]"
                    />
                    <Button
                      size="xs"
                      type="submit"
                      data-testid="area-add-step-submit"
                      disabled={changePlanMutation.isPending || !areaAddStepText.trim()}
                      className="min-h-[24px] text-[12.5px] px-3 cursor-pointer"
                    >
                      {changePlanMutation.isPending ? 'Adding…' : 'Add'}
                    </Button>
                    <Button
                      size="xs"
                      type="button"
                      variant="ghost"
                      data-testid="area-add-step-cancel"
                      onClick={() => {
                        setAreaAddStepOpen(false);
                        setAreaAddStepText('');
                        setAreaAddStepError(null);
                      }}
                      className="min-h-[24px] text-[12.5px] px-2.5 cursor-pointer"
                    >
                      Cancel
                    </Button>
                    {areaAddStepError && <p role="alert" className="w-full text-[12.5px] text-destructive">{areaAddStepError}</p>}
                  </form>
                </div>
              )}
              <div ref={setAreaRow} className="relative flex min-h-0 flex-1">
                <div
                  className="relative min-w-0 flex-1"
                  inert={Boolean(reader) && (layout === 'large' || areaDock.covers) ? true : undefined}
                >
                  <div
                    ref={setAreaCanvasContainer}
                    className="absolute inset-0"
                    onFocus={(event) => lightAreaEdges({ focused: (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node')?.dataset.id ?? null })}
                    onBlur={() => lightAreaEdges({ focused: null })}
                  >
                    <BoardActionsContext value={areaActions}>
                      <BoardReadingContext value={reader?.trail.origin.card ?? null}>
                        <ReactFlow
                          id="board-area-flow"
                          className="board-flow board-flow-rows"
                          proOptions={{ hideAttribution: true }}
                          aria-label="Area canvas. Press a step, a folded row or a plus button to open that row."
                          tabIndex={0}
                          nodes={areaNodes}
                          edges={areaEdges}
                          onNodeMouseEnter={(_event, node) => lightAreaEdges({ pointed: node.id })}
                          onNodeMouseLeave={() => lightAreaEdges({ pointed: null })}
                          nodeTypes={AREA_NODE_TYPES}
                          defaultEdgeOptions={EDGE_OPTIONS}
                          defaultViewport={areaView()}
                          panOnDrag={false}
                          panOnScroll={false}
                          zoomOnScroll={false}
                          zoomOnPinch={false}
                          preventScrolling={false}
                          connectionMode={ConnectionMode.Loose}
                          onInit={(instance) => {
                            areaFlow.current = instance;
                            setAreaInstance(instance);
                          }}
                          onPaneClick={() => setThreadSelectedId(null)}
                          onNodeClick={(event, node) => {
                            const target = event.target as HTMLElement | null;
                            if (target?.closest('button, a, input, textarea, select')) return;
                            if (!['fold', 'more', 'pager'].includes(node.type ?? '')) {
                              setThreadSelectedId((curr) => (curr === node.id ? null : node.id));
                            }
                          }}
                          nodesDraggable={false}
                          nodesConnectable={false}
                          nodesFocusable={false}
                          edgesFocusable={false}
                          elementsSelectable={false}
                          deleteKeyCode={null}
                          panActivationKeyCode={null}
                          selectionKeyCode={null}
                          multiSelectionKeyCode={null}
                          zoomActivationKeyCode={null}
                          disableKeyboardA11y
                          zoomOnDoubleClick={false}
                          minZoom={READABLE_ZOOM}
                          maxZoom={READABLE_ZOOM}
                          attributionPosition="bottom-center"
                        >
                          <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
                        </ReactFlow>
                      </BoardReadingContext>
                    </BoardActionsContext>
                  </div>
                </div>
                {reader && (
                  <BoardReader
                    workspaceId={workspaceId}
                    workspacePath={workspacePath}
                    target={reader.target}
                    request={reader.request}
                    layout={layout}
                    onLayout={changeLayout}
                    covers={areaDock.covers}
                    width={areaDock.width}
                    onClose={closeReader}
                    onOpenFile={openLinked}
                    active={active}
                    back={readerBack ? { label: readerBack, onBack: goBack } : undefined}
                    trailId={reader.trail.id}
                    onNext={nextTarget ? () => navigateToReaderTarget(nextTarget) : undefined}
                    onPrevious={previousTarget ? () => navigateToReaderTarget(previousTarget) : undefined}
                    nextTitle={nextTarget?.title}
                    previousTitle={previousTarget?.title}
                    indexInfo={readerIndexInfo}
                    onAskInCLI={askInCLI}
                  />
                )}
              </div>
            </section>
          </div>
        )}
        </div>
      </div>
    );

  return (
    <div
      ref={root}
      data-board-pane
      className="relative flex h-full min-h-0 min-w-0 flex-col"
      onClickCapture={(event) => {
        pressedLink.current = event.target instanceof Element ? event.target.closest<HTMLElement>('a') : null;
      }}
    >
      {notices}
      {areas.length > 0 && (
        <BoardNowLine
          parts={nowParts}
          news={newsView}
          newsLines={newsLines}
          readOnly={readOnly}
          gotIt={{ pending: markSeen.isPending, error: markSeen.error instanceof Error ? markSeen.error.message : undefined, onGotIt: () => { if (newsView) markSeen.mutate(newsView.at); } }}
          back={!stepped && boardBackTarget && boardBackTarget.level !== 'overview' ? { label: boardBackLabel!, onBack: goBackOnBoard } : undefined}
          onNow={goToNow}
          onQuestion={goToQuestion}
          onNewsLine={goToNews}
          onSearch={openSearch}
        />
      )}
      {body}
      <NoteDialog
        open={createNoteOpen}
        onOpenChange={setCreateNoteOpen}
        defaultAreaId={createNoteDefaults.areaId}
        defaultStepKey={createNoteDefaults.stepKey}
        areas={availableAreas}
        onSave={async (newNote) => {
          return addNote({
            title: newNote.title,
            body: newNote.body,
            pinned: newNote.pinned,
            area: newNote.area ?? undefined,
            step: newNote.step ?? undefined,
          });
        }}
      />
    </div>
  );
}
