import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Background, BackgroundVariant, ConnectionMode, MarkerType, ReactFlow, type DefaultEdgeOptions, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';
import { Archive, Kanban, Plus, RefreshCw } from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '../../components/ui/empty.js';
import { Spinner } from '../../components/ui/spinner.js';
import { useWorkGuidance } from '../../lib/api/queries.js';
import { cn } from '../../lib/utils.js';
import { usePageVisible } from '../../lib/usePageVisible.js';
import { goToWorkspace } from '../chat/chatRoute.js';
import { useAnswerDecision, useChangePlanFile, usePlanFile, useRunCheckpointCheck, useTickPlanStep } from '../plan/planFile.js';
import { useWhatsNew } from '../plan/whatsNew.js';
import { useFeedConnected } from '../progress/useScreenFeed.js';
import { documentRequests } from '../workspace-shell/openRequests.js';
import { BoardActionsContext, BoardReadingContext, firstControl, type BoardActions, type ReaderTarget } from './boardActions.js';
import {
  areaLayout,
  areaPlace,
  areaRowIds,
  areaView,
  READABLE_ZOOM,
  buildBoardAreas,
  overviewEdges,
  OVERVIEW_INSET,
  overviewPlan,
  stepsText,
  waitingText,
  type OverviewNode,
} from './boardAreas.js';
import { addNoteChange, deleteNoteChange, isBoardAreaId, updateNoteChange, useBoard, useChangeBoard } from './boardData.js';
import { NoteDialog } from './NoteDialog.js';
import { fileTitle, readerDock } from './boardDock.js';
import { boardEdges, type BoardNode } from './boardLayout.js';
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
import { BoardArea, BoardAreaFold, BoardAreaMini, BoardAreaRow, BoardCheckpoint, BoardCommit, BoardDocument, BoardFile, BoardFoldRow, BoardLane, BoardMoreTile, BoardNote, BoardPager, BoardPlaceholder, BoardRowHead } from './BoardNodes.js';
import { REVEAL_MARGIN, revealViewport } from './boardReveal.js';
import { BoardReader } from './BoardReader.js';
import { collectAreaReaderTargets, findReaderTargetIndex, isSameReaderTarget, useReaderLayout, type ReaderLayout } from './boardReaderLayout.js';
import { BoardSidebar } from './BoardSidebar.js';
import { findThreadChain } from './boardThread.js';

const OVERVIEW_NODE_TYPES: NodeTypes = { area: BoardArea, areaRow: BoardAreaRow, areaMini: BoardAreaMini, areaFold: BoardAreaFold, checkpoint: BoardCheckpoint };
const AREA_NODE_TYPES: NodeTypes = {
  lane: BoardLane,
  checkpoint: BoardCheckpoint,
  document: BoardDocument,
  commit: BoardCommit,
  placeholder: BoardPlaceholder,
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
export function BoardSection({ workspaceId, workspacePath, active, panelActions, readOnly = false, askInCLI }: { workspaceId: string; workspacePath?: string; active: boolean; panelActions?: ReactNode; readOnly?: boolean; askInCLI?: (context: string) => void }) {
  const plan = usePlanFile(workspaceId);
  const guidance = useWorkGuidance(workspaceId);
  const news = useWhatsNew(workspaceId);

  const visible = usePageVisible();
  const listening = active && visible;
  const connected = useFeedConnected(workspaceId, listening);
  const boardQuery = useBoard(workspaceId, { poll: listening && !connected });
  const navigateTo = useNavigate();

  const planView = plan.data;
  const documents = guidance.data?.documents;
  const newsView = news.data;
  const board = boardQuery.data;
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
  const areas = useMemo(
    () => buildBoardAreas({ plan: planView, documents, news: newsView, board, showArchived }),
    [planView, documents, newsView, board, showArchived],
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
  const hasFold = overview.nodes.some((node) => node.type === 'areaFold');
  useEffect(() => {
    if (!hasFold && foldOpen) {
      // The fold went away by itself (the window grew): the view is laid out again, as when the person closes it
      overviewTaken.current = false;
      setFoldOpen(false);
    }
  }, [hasFold, foldOpen]);
  const totalArchived = board?.cards.filter((card) => card.archived).length ?? 0;

  // Reader state
  const [reader, setReader] = useState<{ target: ReaderTarget; request: number } | null>(null);
  const [layout, setLayout] = useReaderLayout();
  const requests = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  /** Which node and control the opener was, to find it again when the rows were laid out again and its button was drawn anew. */
  const openerWas = useRef<{ node: string; label: string } | null>(null);
  const pressedLink = useRef<HTMLElement | null>(null);

  const show = useCallback((target: ReaderTarget, from: HTMLElement | null) => {
    opener.current = from ?? pressedLink.current;
    const node = opener.current?.closest('.react-flow__node')?.getAttribute('data-id');
    const label = opener.current?.getAttribute('aria-label') ?? (opener.current instanceof HTMLAnchorElement ? opener.current.textContent?.trim() : null);
    openerWas.current = node && label ? { node, label } : null;
    requests.current += 1;
    setReader({ target, request: requests.current });
  }, [setReader]);

  const openInReader = useCallback((target: ReaderTarget, from: HTMLElement | null) => show(target, from), [show]);
  const closeReader = useCallback(() => {
    setReader(null);
    setThreadSelectedId(null);
  }, [setReader]);
  const changeLayout = useCallback((next: ReaderLayout) => setLayout(next), [setLayout]);

  const openLinked = useCallback((path: string) => {
    const allTargets = areas.flatMap((a) => collectAreaReaderTargets(a));
    const matched = allTargets.find((t) => t.path === path);
    show(matched ?? { path, title: fileTitle(path) }, opener.current);
  }, [show, areas]);
  const openInDocs = useCallback((name: string) => {
    documentRequests.open(workspaceId, { name });
    goToWorkspace(navigateTo, workspaceId, 'documents');
  }, [workspaceId, navigateTo]);

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
  const navOpen = navChoice ?? navAuto ?? true;
  const navUndecided = navChoice === null && navAuto === null && !navDock.overlays;
  // The plan, the documents and the notes make the Areas; the commits only add a line of counts to one, so the decision does not wait for them
  const areasLoading = [plan, guidance, boardQuery].some((query) => !query.data && !query.isError);
  useLayoutEffect(() => {
    if (!navUndecided || areasLoading || areas.length === 0 || boardRowSize.width === 0) return;
    setNavAuto(navStartsOpen(areas, boardRowSize));
  }, [navUndecided, areasLoading, areas, boardRowSize]);
  const stageWidth = boardRowSize.width - (navOpen ? SIDEBAR.width : SIDEBAR.railWidth);
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

  // Pending jump to item or area
  const [pendingJump, setPendingJump] = useState<{
    areaId: string;
    nodeId: string;
    readerTarget?: ReaderTarget;
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

  const jumpToArea = useCallback((areaId: string) => {
    clearJump();
    setNarrowNavOpen(false);
    if (reader) setReader(null);
    setThreadSelectedId(null);
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
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

  const jumpToItem = useCallback((item: NavItem, openReader?: boolean) => {
    if (item.nodeId === null) {
      jumpToArea(item.areaId);
      return;
    }
    setNarrowNavOpen(false);
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
    setThreadSelectedId(null);
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
  const openerRetry = useRef<{ was: { node: string; label: string }; until: number; placed: boolean } | null>(null);
  const [openerTick, setOpenerTick] = useState(0);
  const findOpener = useCallback((was: { node: string; label: string }) => {
    const nodeEl = Array.from(areaCanvasContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])
      .find((el) => el.dataset.id === was.node);
    if (!nodeEl) return null;
    return nodeEl.querySelector<HTMLElement>(`[aria-label="${was.label.replace(/["\\]/g, '\\$&')}"]`)
      ?? Array.from(nodeEl.querySelectorAll<HTMLAnchorElement>('a')).find((a) => a.textContent?.trim() === was.label)
      ?? null;
  }, [areaCanvasContainer]);
  useLayoutEffect(() => {
    if (reader) { wasReaderOpen.current = true; return; }
    if (!wasReaderOpen.current) return;
    wasReaderOpen.current = false;
    const from = opener.current;
    const was = openerWas.current;
    opener.current = null;
    openerWas.current = null;
    const target = from?.isConnected ? from : was ? findOpener(was) : null;
    focusing.current = true;
    (target ?? areaCanvasContainer?.querySelector<HTMLElement>('.react-flow'))?.focus({ preventScroll: true });
    focusing.current = false;
    if (was) {
      openerRetry.current = { was, until: Date.now() + 1500, placed: false };
      setOpenerTick((tick) => (tick + 1) % 1000);
    }
  }, [reader, areaCanvasContainer, findOpener]);

  // The newest nodes and stage size for the focus return below, which must not run again when they change
  const overviewNow = useRef({ nodes: overviewNodes, size: stageSize, viewport: overview.viewport });
  overviewNow.current = { nodes: overviewNodes, size: stageSize, viewport: overview.viewport };

  // Restore keyboard focus to Area button when stepping out
  useLayoutEffect(() => {
    const id = focusTarget.current;
    if (!id || stepped?.phase === 'open') return;
    const nodeEl = Array.from(stageContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])
      .find((el) => el.dataset.id === id);
    const btn = nodeEl?.querySelector<HTMLElement>('button.board-area');
    if (btn) {
      focusing.current = true;
      btn.focus({ preventScroll: true });
      focusing.current = false;
      // The focus handler skips its own reveal while `focusing` is set, and the form of the overview may have changed (and moved the view) while the person was inside the Area
      // A view the layout still moves to (not taken by the person) is where the card will be, so it is revealed from there, not from where the view happens to be now
      const { nodes, size, viewport } = overviewNow.current;
      const overviewNode = nodes.find((n) => n.id === id);
      if (overviewNode) revealOverviewNode(overviewFlow.current, overviewNode, size, takeOverview, overviewTaken.current ? undefined : viewport ?? undefined);
      if (document.activeElement === btn || !stepped) {
        focusTarget.current = null;
      }
    }
  }, [stepped, stageContainer, takeOverview]);

  // Focus Back button when stepped into an area (skipping when a jump to an item is pending in this area)
  useLayoutEffect(() => {
    if (stepped?.phase === 'open') {
      if (pendingJumpRef.current?.areaId === stepped.areaId) return;
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
  const activeArea = areas.find((a) => a.id === stepped?.areaId);
  const areaHeadingId = useId();

  const [areaAddStepOpen, setAreaAddStepOpen] = useState(false);
  const [areaAddStepText, setAreaAddStepText] = useState('');
  const [areaAddStepError, setAreaAddStepError] = useState<string | null>(null);
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

  // The rows are laid out for the canvas as it is: what the reader docked beside it leaves
  const areaReady = areaCanvasSize.width > 0 && areaCanvasSize.height > 0;
  const areaDrawn = useMemo(() => {
    if (!activeArea || !areaReady) return { nodes: [] as BoardNode[], open: null };
    const { nodes, open } = areaLayout(activeArea, { news: newsView, size: areaCanvasSize, openRow, page: openPage });
    return { nodes: nodes.map((node) => (node.width !== undefined && node.height !== undefined ? { ...node, measured: { width: node.width, height: node.height } } : node) as BoardNode[][number]), open };
  }, [activeArea, areaReady, newsView, areaCanvasSize, openRow, openPage]);
  const areaNodes = areaDrawn.nodes;
  const areaOpen = areaDrawn.open;
  const rowIds = useMemo(() => (activeArea && areaReady ? areaRowIds(activeArea, { news: newsView, size: areaCanvasSize }) : []), [activeArea, areaReady, newsView, areaCanvasSize]);

  // A row that is no longer there (a live change took its things away), or a page past the end, is let go at once, so Escape works on the first press
  useEffect(() => {
    if (!openState || openState.areaId !== steppedAreaId || !areaReady || !activeArea) return;
    if (!rowIds.includes(openState.rowId)) setOpenState(null);
    else if (areaOpen && areaOpen.page !== openState.page) setOpenState({ ...openState, page: areaOpen.page });
  }, [openState, steppedAreaId, areaReady, activeArea, rowIds, areaOpen]);

  const areaEdges = useMemo(() => boardEdges(areaNodes, board?.links ?? []), [areaNodes, board]);

  // A press anywhere ends the looking after the keyboard: whoever pressed has put it where they want it, and putting it back on the opener
  // in the middle of a drag over a card's text (the focus moves, and the selection stops) is the one thing to avoid.
  useEffect(() => {
    const leave = () => { openerRetry.current = null; };
    document.addEventListener('pointerdown', leave, true);
    return () => document.removeEventListener('pointerdown', leave, true);
  }, []);

  useEffect(() => {
    const retry = openerRetry.current;
    if (!retry) return;
    const target = findOpener(retry.was);
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
    if (!target && !retry.placed && activeArea && areaReady && !areaNodes.some((areaNode) => areaNode.id === retry.was.node)) {
      retry.placed = true;
      const place = areaPlace(activeArea, { news: newsView, size: areaCanvasSize }, retry.was.node);
      if (place) setOpenState(place.row ? { areaId: activeArea.id, rowId: place.row, page: place.page } : null);
    }
    // The rows may be laid out again a frame or two after the reader closed, so the keyboard is looked after for a few frames
    if (Date.now() > retry.until) { openerRetry.current = null; return; }
    const frame = requestAnimationFrame(() => setOpenerTick((tick) => (tick + 1) % 1000));
    return () => cancelAnimationFrame(frame);
  }, [openerTick, areaNodes, findOpener, activeArea, areaReady, newsView, areaCanvasSize]);

  const activeReaderCardId = useMemo(() => {
    if (!reader?.target) return null;
    if (reader.target.card) return reader.target.card;
    if (activeArea) {
      if (reader.target.path) {
        const match = activeArea.cards.find((c) => 'path' in c && c.path === reader.target.path);
        if (match) return match.id;
      }
      const allTargets = collectAreaReaderTargets(activeArea);
      const found = allTargets.find((t) => isSameReaderTarget(t, reader.target));
      if (found?.card) return found.card;
    }
    return null;
  }, [reader, activeArea]);

  // When the canvas changes size (the reader docks beside it, or leaves), the card the reader shows may no longer be drawn: its row is opened at the page it is on
  const areaSizeKey = `${areaCanvasSize.width}x${areaCanvasSize.height}`;
  const lastAreaSize = useRef(areaSizeKey);
  useEffect(() => {
    const changed = lastAreaSize.current !== areaSizeKey;
    lastAreaSize.current = areaSizeKey;
    const card = activeReaderCardId;
    if (!changed || !card || !activeArea || !areaReady || areaNodes.some((areaNode) => areaNode.id === card)) return;
    const place = areaPlace(activeArea, { news: newsView, size: areaCanvasSize }, card);
    if (place) setOpenState(place.row ? { areaId: activeArea.id, rowId: place.row, page: place.page } : null);
  }, [areaSizeKey, activeReaderCardId, activeArea, areaReady, areaNodes, newsView, areaCanvasSize]);

  // Opening or closing a row: the control that was pressed is swapped for another node, so the keyboard is put on the row's control again
  const rowFocus = useRef<{ rowId: string; pressed: HTMLElement | null } | null>(null);
  const rowFocusFrames = useRef(0);
  const keepFocusOn = useCallback((rowId: string) => {
    rowFocusFrames.current = 0;
    rowFocus.current = { rowId, pressed: document.activeElement instanceof HTMLElement ? document.activeElement : null };
  }, []);
  const toggleRow = useCallback((rowId: string) => {
    keepFocusOn(rowId);
    setOpenState((curr) => {
      if (!steppedAreaId) return null;
      return curr && curr.areaId === steppedAreaId && curr.rowId === rowId ? null : { areaId: steppedAreaId, rowId, page: 0 };
    });
  }, [steppedAreaId, keepFocusOn]);
  const setRowPage = useCallback((rowId: string, page: number) => {
    setOpenState((curr) => (steppedAreaId && curr && curr.rowId === rowId ? { ...curr, page: Math.max(0, page) } : curr));
  }, [steppedAreaId]);
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

    const place = areaPlace(activeArea, { news: newsView, size: areaCanvasSize }, activeReaderCardId);
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
  }, [reader, activeReaderCardId, activeArea, areaReady, newsView, areaCanvasSize]);

  const threadChain = useMemo(() => {
    if (!threadSelectedId) return null;
    return findThreadChain({
      selectedId: threadSelectedId,
      nodes: stepped ? areaNodes : (overviewNodes as unknown as BoardNode[]),
      links: board?.links ?? [],
      cards: board?.cards ?? [],
    });
  }, [threadSelectedId, stepped, areaNodes, overviewNodes, board]);

  useLayoutEffect(() => {
    const container = stepped ? areaCanvasContainer : stageContainer;
    if (!container) return;
    const flowEl = container.querySelector<HTMLElement>('.board-flow');
    if (flowEl) {
      if (threadSelectedId) {
        flowEl.setAttribute('data-thread-active', 'true');
      } else {
        flowEl.removeAttribute('data-thread-active');
      }
    }
    const nodes = container.querySelectorAll<HTMLElement>('.react-flow__node');
    for (const el of Array.from(nodes)) {
      const id = el.dataset.id;
      if (!threadSelectedId || !threadChain) {
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
      if (!threadSelectedId || !threadChain || !id) {
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
  }, [
    threadSelectedId,
    threadChain,
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

    const nodeEl = Array.from(
      areaCanvasContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [],
    ).find((el) => el.dataset.id === pendingJump.nodeId);

    if (!nodeEl) {
      // The cards of an Area that was just chosen are drawn a frame or two later (and the old Area's are on the screen until then):
      // look again each frame for a while, and give up at once on a card that this Area does not have
      const drawn = areaNodes.some((areaNode) => areaNode.id === pendingJump.nodeId);
      const place = drawn || !activeArea ? null : areaPlace(activeArea, { news: newsView, size: areaCanvasSize }, pendingJump.nodeId);
      if (!drawn && (!place || jumpFrames.current >= JUMP_FRAMES)) {
        clearJump();
        backButtonRef.current?.focus({ preventScroll: true });
        return;
      }
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

    // Trigger node highlight
    setHighlightedNode({ id: jump.nodeId, request: jump.request });

    // Select thread
    setThreadSelectedId(jump.nodeId);

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
    newsView,
    jumpTick,
    openInReader,
    clearJump,
  ]);

  // Narrow sidebar Escape handling
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!navDock.overlays || !narrowNavOpen || !active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
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

  // A press outside the reader closes it: in the large window or a docked one that covers the canvas, anywhere in the Board pane outside the window (the index and the Area
  // header too); beside the canvas, on empty board space (a card or a row control does its own thing). The press must begin and end
  // there, so a text selected in the window and dragged out of it does not close it. The reader's own menu is out of the DOM of this
  // pane (a portal), and a press that only dismisses that menu does not also close the reader.
  useEffect(() => {
    const pane = root.current;
    if (!reader || !pane) return undefined;
    const press = { down: false, up: false, ignored: false };
    const closes = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest('[data-board-reader]')) return false;
      if (layout === 'large' || areaDock.covers) return true;
      return Boolean(areaCanvasContainer?.contains(target)) && !target.closest('.react-flow__node, button, a, [role="button"]');
    };
    const onDown = (event: PointerEvent) => {
      press.ignored = document.querySelector('[data-slot="menu-popup"]') !== null;
      press.down = closes(event.target);
      press.up = false;
    };
    const onUp = (event: PointerEvent) => { press.up = closes(event.target); };
    const onClick = () => {
      const { down, up, ignored } = press;
      press.down = false;
      press.up = false;
      if (down && up && !ignored) closeReader();
    };
    pane.addEventListener('pointerdown', onDown, true);
    pane.addEventListener('pointerup', onUp, true);
    pane.addEventListener('click', onClick);
    return () => {
      pane.removeEventListener('pointerdown', onDown, true);
      pane.removeEventListener('pointerup', onUp, true);
      pane.removeEventListener('click', onClick);
    };
  }, [reader, layout, areaDock.covers, areaCanvasContainer, closeReader]);

  // Reader Escape handling. Escape that closes the reader's open menu is the menu's alone: whether one was open is seen first, in the
  // capture phase, because the menu is already closing by the time this listener runs.
  const menuHadEscape = useRef(false);
  useEffect(() => {
    if (!reader || !active) return;
    const onCapture = (event: globalThis.KeyboardEvent) => { menuHadEscape.current = event.key === 'Escape' && document.querySelector('[data-slot="menu-popup"]') !== null; };
    window.addEventListener('keydown', onCapture, true);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || menuHadEscape.current) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (navDock.overlays && narrowNavOpen) return;
      const target = event.target;
      const inside = target instanceof Node && Boolean(root.current?.contains(target));
      if (!inside && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      closeReader();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [reader, active, closeReader, navDock.overlays, narrowNavOpen]);

  // Stepped Area Escape handling (only when reader is closed and no modal dialog is open): an open row closes first, then the Area
  useEffect(() => {
    if (!stepped || stepped.phase !== 'open' || reader || !active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
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

  // Reader sequential element navigation within the active area
  const areaReaderTargets = useMemo(() => (activeArea ? collectAreaReaderTargets(activeArea) : []), [activeArea]);

  const currentReaderIndex = useMemo(() => {
    if (!reader) return -1;
    return findReaderTargetIndex(areaReaderTargets, reader.target);
  }, [areaReaderTargets, reader]);

  const hasPreviousTarget = currentReaderIndex > 0;
  const hasNextTarget = currentReaderIndex >= 0 && currentReaderIndex < areaReaderTargets.length - 1;
  const previousTarget = hasPreviousTarget ? areaReaderTargets[currentReaderIndex - 1] : null;
  const nextTarget = hasNextTarget ? areaReaderTargets[currentReaderIndex + 1] : null;

  const readerIndexInfo = currentReaderIndex >= 0 && areaReaderTargets.length > 0
    ? { current: currentReaderIndex + 1, total: areaReaderTargets.length }
    : undefined;

  const navigateToReaderTarget = useCallback(
    (target: ReaderTarget) => {
      requests.current += 1;
      const resolvedCard = target.card ?? (activeArea ? collectAreaReaderTargets(activeArea).find((t) => isSameReaderTarget(t, target))?.card : undefined);
      const resolvedTarget = resolvedCard ? { ...target, card: resolvedCard } : target;
      setReader({ target: resolvedTarget, request: requests.current });
    },
    [activeArea],
  );

  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({});
  const [busyStepKeys, setBusyStepKeys] = useState<Set<string>>(new Set());
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});

  const answerMutation = useAnswerDecision(workspaceId);
  const tickStepMutation = useTickPlanStep(workspaceId);
  const runCheckMutation = useRunCheckpointCheck(workspaceId);

  const answerDecision = useCallback(async (key: string, answer: string, expected?: string) => {
    setDecisionErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await answerMutation.mutateAsync({ key, answer, expected });
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

  const addNote = useCallback(async (note: { title: string; body?: string; area?: string; step?: string; pinned?: boolean }) => {
    try {
      await changeBoardMutation.mutateAsync({ changes: [addNoteChange(note)] });
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
    openInReader: () => {},
    toggleGroup: () => {},
    keepFocus: () => {},
    selectThread: (id) => setThreadSelectedId((curr) => (curr === id ? null : id)),
    answerDecision,
    decisionErrors,
    toggleStep,
    runCheck,
    busyStepKeys,
    stepErrors,
    addNote,
    updateNote,
    deleteNote,
    availableAreas,
    askInCLI,
  }), [workspaceId, workspacePath, readOnly, stepInto, answerDecision, setThreadSelectedId, decisionErrors, toggleStep, runCheck, busyStepKeys, stepErrors, addNote, updateNote, deleteNote, availableAreas, askInCLI]);

  const areaActions = useMemo<BoardActions>(() => ({
    workspaceId,
    workspacePath,
    readOnly,
    openInReader,
    toggleGroup: () => {},
    keepFocus: () => {},
    toggleRow,
    setRowPage,
    selectThread: (id) => setThreadSelectedId((curr) => (curr === id ? null : id)),
    answerDecision,
    decisionErrors,
    toggleStep,
    runCheck,
    busyStepKeys,
    stepErrors,
    addNote,
    updateNote,
    deleteNote,
    availableAreas,
    askInCLI,
  }), [workspaceId, workspacePath, readOnly, openInReader, toggleRow, setRowPage, answerDecision, setThreadSelectedId, decisionErrors, toggleStep, runCheck, busyStepKeys, stepErrors, addNote, updateNote, deleteNote, availableAreas, askInCLI]);

  const backdropPress = useRef({ down: false, up: false });

  const noteButton = (defaultAreaId?: string) => (
    readOnly ? null : (
      <Button
        size="sm"
        variant="outline"
        className="nodrag nopan gap-1.5 text-[12.5px] font-medium"
        onClick={() => openCreateNoteDialog(defaultAreaId)}
      >
        <Plus className="size-4" aria-hidden="true" />
        <span className="sr-only">+ </span>
        Note
      </Button>
    )
  );

  // The pane's own icons (hide the chat, close) are the board's to show, since it has no title row of its own: quiet until pointed at or
  // focused. At the overview they stand in its top-right corner, which the layout leaves free; inside an Area, at the end of its heading.
  const paneIcons = panelActions && (
    <div className="flex shrink-0 items-center gap-0.5 opacity-50 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100 pointer-coarse:opacity-100">{panelActions}</div>
  );
  const paneCorner = (
    <div className="absolute right-2 top-1.5 z-10 flex items-center gap-1.5">
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

  let body;
  if (areas.length > 0) {
    body = (
      <div ref={setBoardRow} className={cn('relative flex min-h-0 flex-1 overflow-hidden', navSettling && 'pointer-events-none opacity-0')} inert={navSettling ? true : undefined}>
        <BoardSidebar
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
          onJumpToArea={jumpToArea}
          onJumpToItem={jumpToItem}
          toggleButtonRef={navToggleRef}
        />
        <div
          className="relative flex min-h-0 min-w-0 flex-1"
          inert={navDock.overlays && narrowNavOpen ? true : undefined}
        >
          {/* Plane 0 Overview: recedes behind scrim when stepped into */}
          <div
            id="board-overview"
          className="board-overview-plane absolute inset-0"
          data-receded={stepped?.phase === 'open'}
          inert={stepped?.phase === 'open' ? true : undefined}
        >
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
            {totalArchived > 0 && (
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
            <BoardActionsContext value={overviewActions}>
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
            </BoardActionsContext>
          </div>
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
                'relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl',
                stepped.phase === 'closing' ? 'board-area-exit' : 'board-area-enter',
              )}
            >
              <header className="@container flex h-12 shrink-0 items-center gap-1.5 border-b border-border/60 px-3">
                <Button
                  ref={backButtonRef}
                  type="button"
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  onClick={stepOut}
                >
                  Board ›
                </Button>
                <h2
                  id={areaHeadingId}
                  className="min-w-[7rem] truncate text-sm font-semibold text-foreground"
                  title={activeArea.data.title}
                >
                  {activeArea.data.title}
                </h2>
                {activeArea.data.kind === 'checkpoint' && (
                  activeArea.data.done ? (
                    <span className="sr-only shrink-0 @[26rem]:not-sr-only"><Badge variant="success">Done</Badge></span>
                  ) : activeArea.data.current ? (
                    <span className="sr-only shrink-0 @[26rem]:not-sr-only"><Badge variant="default">Current</Badge></span>
                  ) : (
                    <span className="sr-only shrink-0 @[26rem]:not-sr-only"><Badge variant="outline">Not done</Badge></span>
                  )
                )}
                {activeArea.data.kind === 'plan' && <span className="sr-only shrink-0 @[26rem]:not-sr-only"><Badge variant="outline">Plan</Badge></span>}
                {activeArea.data.waitingCount > 0 && !areaNodes.some((areaNode) => areaNode.id === activeArea.id) && (
                  <span className="sr-only shrink-0 @[26rem]:not-sr-only"><Badge variant="warning">{waitingText(activeArea.data.waitingCount)}</Badge></span>
                )}
                {activeArea.data.kind !== 'work' && (
                  <span className="sr-only shrink-0 whitespace-nowrap text-[12.5px] text-muted-foreground @[34rem]:not-sr-only @[34rem]:inline">{stepsText(activeArea.data)}</span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  {activeArea.data.kind !== 'work' && !readOnly && (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="area-add-step-button"
                      className="nodrag nopan gap-1.5 text-[12.5px] font-medium min-h-[24px] cursor-pointer"
                      onClick={() => {
                        setAreaAddStepOpen(true);
                        setAreaAddStepError(null);
                      }}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      <span className="sr-only">+ </span>
                      Step
                    </Button>
                  )}
                  {noteButton(activeArea.id)}
                  {activeArea.archivedCount > 0 && (
                    <Button
                      size="xs"
                      variant={showArchived ? 'secondary' : 'outline'}
                      className="shrink-0"
                      aria-pressed={showArchived}
                      aria-label={`Archived (${activeArea.archivedCount})`}
                      onClick={() => setShowArchived((s) => !s)}
                    >
                      <Archive aria-hidden="true" />
                      <span className="hidden @[26rem]:inline">Archived </span>({activeArea.archivedCount})
                    </Button>
                  )}
                  {paneIcons}
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
                  >
                    <BoardActionsContext value={areaActions}>
                      <BoardReadingContext value={reader?.target.card ?? null}>
                        <ReactFlow
                          id="board-area-flow"
                          className="board-flow board-flow-rows"
                          proOptions={{ hideAttribution: true }}
                          aria-label="Area canvas. Press a step, a folded row or a plus button to open that row."
                          tabIndex={0}
                          nodes={areaNodes}
                          edges={areaEdges}
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
                    onOpenInDocs={openInDocs}
                    onOpenFile={openLinked}
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
  } else if (loading) {
    body = (
      <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner role="presentation" aria-hidden="true" className="size-4" />Loading the board
      </div>
    );
  } else if (problems.length === 0) {
    body = (
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

  return (
    <div
      ref={root}
      className="relative flex h-full min-h-0 min-w-0 flex-col"
      onClickCapture={(event) => {
        pressedLink.current = event.target instanceof Element ? event.target.closest<HTMLElement>('a') : null;
      }}
    >
      {notices}
      {body}
      {areas.length === 0 && paneCorner}
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
