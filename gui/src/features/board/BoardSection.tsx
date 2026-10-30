import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Background, BackgroundVariant, ConnectionMode, Controls, MarkerType, ReactFlow, type DefaultEdgeOptions, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';
import { Archive, Kanban, RefreshCw } from 'lucide-react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '../../components/ui/empty.js';
import { Spinner } from '../../components/ui/spinner.js';
import { useWorkGuidance } from '../../lib/api/queries.js';
import { cn } from '../../lib/utils.js';
import { usePageVisible } from '../../lib/usePageVisible.js';
import { goToWorkspace } from '../chat/chatRoute.js';
import { usePlanFile } from '../plan/planFile.js';
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
  fitBoundsView,
  overviewEdges,
  overviewLayout,
  stepsText,
  waitingText,
  type AreaNode,
} from './boardAreas.js';
import { useBoard } from './boardData.js';
import { fileTitle, readerDock } from './boardDock.js';
import { boardEdges, type BoardNode } from './boardLayout.js';
import {
  buildBoardNav,
  readNavMode,
  readNavOpen,
  sidebarDock,
  totalBoardWaiting,
  writeNavMode,
  writeNavOpen,
  type NavItem,
  type NavMode,
} from './boardNav.js';
import { BoardArea, BoardCheckpoint, BoardCommit, BoardDocument, BoardFile, BoardFoldRow, BoardLane, BoardMoreTile, BoardNote, BoardPager, BoardPlaceholder, BoardRowHead } from './BoardNodes.js';
import { BoardReader } from './BoardReader.js';
import { useReaderLayout, type ReaderLayout } from './boardReaderLayout.js';
import { BoardSidebar } from './BoardSidebar.js';

const OVERVIEW_NODE_TYPES: NodeTypes = { area: BoardArea };
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

/** "Fit the board in view" shows everything, but never zoomed in past life size: a lone card is not blown up. */
const FIT = { padding: 0.12, maxZoom: 1 } as const;
const PAN_STEP = 96;
/** How many frames a jump from the Board index waits for the card to be drawn in its Area, before it gives up. */
const JUMP_FRAMES = 30;
/** How long a move of the view takes, in ms: none for those who ask for less motion. */
const moveMs = (ms: number) => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms);
/** Lines point from the thing that was linked to the thing it was linked to. */
const EDGE_OPTIONS: DefaultEdgeOptions = { markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)', width: 14, height: 14 } };

const ARIA_LABELS = {
  'controls.ariaLabel': 'Board controls',
  'controls.zoomIn.ariaLabel': 'Zoom in',
  'controls.zoomOut.ariaLabel': 'Zoom out',
  'controls.fitView.ariaLabel': 'Fit the board in view',
  'minimap.ariaLabel': 'Board overview',
};

/**
 * Arrow keys pan, plus and minus zoom, zero fits: the canvas is a keyboard stop of its own.
 */
function navigate(flow: ReactFlowInstance<any> | null, event: KeyboardEvent<HTMLDivElement>, onMoved: () => void) {
  const onNode = event.target instanceof HTMLElement && event.target.classList.contains('react-flow__node');
  if (!flow || (event.target !== event.currentTarget && !onNode) || event.altKey || event.ctrlKey || event.metaKey) return;
  const { x, y, zoom } = flow.getViewport();
  const pan = (dx: number, dy: number) => void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: moveMs(120) });
  switch (event.key) {
    case 'ArrowLeft': pan(PAN_STEP, 0); break;
    case 'ArrowRight': pan(-PAN_STEP, 0); break;
    case 'ArrowUp': pan(0, PAN_STEP); break;
    case 'ArrowDown': pan(0, -PAN_STEP); break;
    case '+': case '=': void flow.zoomIn({ duration: moveMs(120) }); break;
    case '-': case '_': void flow.zoomOut({ duration: moveMs(120) }); break;
    case '0': void flow.fitView({ ...FIT, duration: moveMs(200) }); break;
    default: return;
  }
  onMoved();
  event.preventDefault();
}

/**
 * Whether a press went to the canvas itself, the overview map or the zoom controls.
 */
function isViewGesture(container: HTMLElement | null, target: EventTarget): boolean {
  if (!(target instanceof Element) || !container?.contains(target)) return false;
  if (target.closest('.react-flow__node button, .react-flow__node a, .react-flow__node [role="button"]')) return false;
  return Boolean(target.closest('.react-flow__pane, .react-flow__minimap, .react-flow__controls'));
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
  const seen = left * zoom + x >= 0 && top * zoom + y >= 0 && (left + width) * zoom + x <= size.width && (top + height) * zoom + y <= size.height;
  if (seen) return;
  onMoved();
  void flow.setCenter(left + width / 2, top + height / 2, { zoom, duration: moveMs(200) });
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
 * Level 0 ("Board"): Arranges workspace Areas (checkpoints, plan, work) in a 2D screen-proportioned
 * grid that fits whole on one screen without scrolling.
 *
 * Level 1 (inside an Area): Stepping into an Area recedes Level 0 behind a dimmed scrim while the
 * Area surface grows smoothly from the clicked card's transform-origin to fit all items whole on one
 * screen without scrolling.
 */
export function BoardSection({ workspaceId, workspacePath, active }: { workspaceId: string; workspacePath?: string; active: boolean }) {
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
  const overviewFlow = useRef<ReactFlowInstance<AreaNode> | null>(null);
  const [overviewInstance, setOverviewInstance] = useState<ReactFlowInstance<AreaNode> | null>(null);
  const overviewTaken = useRef(false);
  const overviewTakenBefore = useRef(false);

  const overviewNodes = useMemo(() => overviewLayout(areas, stageSize), [areas, stageSize]);
  const overviewLines = useMemo(() => overviewEdges(areas, overviewNodes, board?.links ?? []), [areas, overviewNodes, board?.links]);
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
    const label = opener.current?.getAttribute('aria-label');
    openerWas.current = node && label ? { node, label } : null;
    requests.current += 1;
    setReader({ target, request: requests.current });
  }, [setReader]);

  const openInReader = useCallback((target: ReaderTarget, from: HTMLElement | null) => show(target, from), [show]);
  const closeReader = useCallback(() => setReader(null), [setReader]);
  const changeLayout = useCallback((next: ReaderLayout) => setLayout(next), [setLayout]);

  const openLinked = useCallback((path: string) => show({ path, title: fileTitle(path) }, opener.current), [show]);
  const openInDocs = useCallback((name: string) => {
    documentRequests.open(workspaceId, { name });
    goToWorkspace(navigateTo, workspaceId, 'documents');
  }, [workspaceId, navigateTo]);

  // Board index sidebar state
  const [boardRow, setBoardRow] = useState<HTMLDivElement | null>(null);
  const boardRowSize = useLayoutElementSize(boardRow);
  const navDock = sidebarDock(boardRowSize.width);
  const [navOpen, setNavOpenState] = useState(readNavOpen);
  const [narrowNavOpen, setNarrowNavOpen] = useState(false);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const navFocusDue = useRef(false);
  const navExpanded = navDock.overlays ? narrowNavOpen : navOpen;
  const onToggleNavOpen = useCallback(() => {
    navFocusDue.current = true;
    setNavOpenState((curr) => {
      const next = !curr;
      writeNavOpen(next);
      return next;
    });
  }, []);
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

  const clearJump = useCallback(() => {
    pendingJumpRef.current = null;
    jumpFrames.current = 0;
    setPendingJump(null);
  }, []);

  const jumpToArea = useCallback((areaId: string) => {
    clearJump();
    setNarrowNavOpen(false);
    if (reader) setReader(null);
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setStepped((curr) =>
      curr?.areaId === areaId && curr.phase === 'open'
        ? curr
        : { areaId, origin: '12% 50%', phase: 'open' },
    );
  }, [clearJump, reader, setReader, setNarrowNavOpen]);

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
        : { areaId: item.areaId, origin: '12% 50%', phase: 'open' },
    );
  }, [jumpToArea, stepped, setReader, setNarrowNavOpen]);

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
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const btnRect = buttonEl.getBoundingClientRect();
    const stageRect = stageContainer?.getBoundingClientRect();
    const xPct = stageRect && stageRect.width > 0 ? Math.round(((btnRect.left + btnRect.width / 2 - stageRect.left) / stageRect.width) * 100) : 50;
    const yPct = stageRect && stageRect.height > 0 ? Math.round(((btnRect.top + btnRect.height / 2 - stageRect.top) / stageRect.height) * 100) : 50;
    setStepped({ areaId, origin: `${xPct}% ${yPct}%`, phase: 'open' });
  }, [stageContainer, clearJump]);

  const stepOut = useCallback(() => {
    const curr = steppedRef.current;
    if (!curr || curr.phase === 'closing') return;
    focusTarget.current = curr.areaId;
    clearJump();
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
  }, [setReader, clearJump]);

  const [areaCanvasContainer, setAreaCanvasContainer] = useState<HTMLDivElement | null>(null);
  // Focus restoration when reader closes. Declared before the step-in/step-out focus effects below: when a jump closes the
  // reader and changes the Area in one commit, the old opener is still connected here, so those later effects must run after
  // it and win (otherwise focus ends on the opener, then falls to BODY when React Flow removes it).
  const wasReaderOpen = useRef(false);
  /** The control to put the keyboard on when the reader has closed and the card it came from is not drawn yet (the rows are laid out again). */
  const openerRetry = useRef<{ was: { node: string; label: string }; until: number; placed: boolean } | null>(null);
  const [openerTick, setOpenerTick] = useState(0);
  const findOpener = useCallback((was: { node: string; label: string }) => Array.from(areaCanvasContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])
    .find((el) => el.dataset.id === was.node)?.querySelector<HTMLElement>(`[aria-label="${was.label.replace(/["\\]/g, '\\$&')}"]`) ?? null, [areaCanvasContainer]);
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
      if (document.activeElement === btn || !stepped) {
        focusTarget.current = null;
      }
    }
  }, [stepped, stageContainer]);

  // Focus Back button when stepped into an area (skipping when a jump to an item is pending in this area)
  useLayoutEffect(() => {
    if (stepped?.phase === 'open') {
      if (pendingJumpRef.current?.areaId === stepped.areaId) return;
      backButtonRef.current?.focus({ preventScroll: true });
    }
  }, [stepped?.phase, stepped?.areaId]);

  // Plane 0 Viewport auto-fitting
  const overviewViewport = useMemo(
    () => fitBoundsView(overviewNodes, stageSize, { topInset: totalArchived > 0 ? 52 : 28, bottomInset: 48 }),
    [overviewNodes, stageSize, totalArchived],
  );

  useEffect(() => {
    if (!overviewViewport || !overviewInstance || overviewTaken.current) return;
    void overviewInstance.setViewport(overviewViewport, { duration: moveMs(200) });
  }, [overviewViewport, overviewInstance]);

  // Plane 1 (Inside Area) elements
  const activeArea = areas.find((a) => a.id === stepped?.areaId);
  const areaHeadingId = useId();

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

  // When the canvas changes size (the reader docks beside it, or leaves), the card the reader shows may no longer be drawn: its row is opened at the page it is on
  const areaSizeKey = `${areaCanvasSize.width}x${areaCanvasSize.height}`;
  const lastAreaSize = useRef(areaSizeKey);
  useEffect(() => {
    const changed = lastAreaSize.current !== areaSizeKey;
    lastAreaSize.current = areaSizeKey;
    const card = reader?.target.card;
    if (!changed || !card || !activeArea || !areaReady || areaNodes.some((areaNode) => areaNode.id === card)) return;
    const place = areaPlace(activeArea, { news: newsView, size: areaCanvasSize }, card);
    if (place) setOpenState(place.row ? { areaId: activeArea.id, rowId: place.row, page: place.page } : null);
  }, [areaSizeKey, reader, activeArea, areaReady, areaNodes, newsView, areaCanvasSize]);

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
  }, [stepped, reader, active, stepOut, navDock.overlays, narrowNavOpen, keepFocusOn]);

  // Actions for Plane 0 & Plane 1
  const overviewActions = useMemo<BoardActions>(() => ({
    workspaceId,
    workspacePath,
    openArea: stepInto,
    openInReader: () => {},
    toggleGroup: () => {},
    keepFocus: () => {},
  }), [workspaceId, workspacePath, stepInto]);

  const areaActions = useMemo<BoardActions>(() => ({
    workspaceId,
    workspacePath,
    openInReader,
    toggleGroup: () => {},
    keepFocus: () => {},
    toggleRow,
    setRowPage,
  }), [workspaceId, workspacePath, openInReader, toggleRow, setRowPage]);

  const backdropPress = useRef({ down: false, up: false });

  const notices = (problems.length > 0 || (loading && areas.length > 0)) && (
    <div className="shrink-0 space-y-1.5 border-b border-border/60 px-4 py-2">
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
      <div ref={setBoardRow} className="relative flex min-h-0 flex-1 overflow-hidden">
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
            {totalArchived > 0 && (
              <div className="absolute left-3 top-3 z-10">
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
                aria-label="Board overview canvas. Arrow keys pan, plus and minus zoom, zero fits the board in view. Press an area to step into it."
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
                onKeyDown={(event) => {
                  navigate(overviewFlow.current, event, () => { overviewTaken.current = true; });
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
                minZoom={0.1}
                maxZoom={1.5}
                attributionPosition="bottom-center"
                ariaLabelConfig={ARIA_LABELS}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
                <Controls showInteractive={false} fitViewOptions={FIT} />
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
              <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
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
                  className="min-w-0 truncate text-sm font-semibold text-foreground"
                  title={activeArea.data.title}
                >
                  {activeArea.data.title}
                </h2>
                {activeArea.data.kind === 'checkpoint' && (
                  activeArea.data.done ? (
                    <Badge variant="success" className="shrink-0">Done</Badge>
                  ) : activeArea.data.current ? (
                    <Badge variant="default" className="shrink-0">Current</Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">Not done</Badge>
                  )
                )}
                {activeArea.data.kind === 'plan' && <Badge variant="outline" className="shrink-0">Plan</Badge>}
                {activeArea.data.waitingCount > 0 && !areaNodes.some((areaNode) => areaNode.id === activeArea.id) && (
                  <Badge variant="warning" className="shrink-0">{waitingText(activeArea.data.waitingCount)}</Badge>
                )}
                {activeArea.data.kind !== 'work' && (
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{stepsText(activeArea.data)}</span>
                )}
                <div className="flex-1" />
                {activeArea.archivedCount > 0 && (
                  <Button
                    size="xs"
                    variant={showArchived ? 'secondary' : 'outline'}
                    className="shrink-0"
                    aria-pressed={showArchived}
                    onClick={() => setShowArchived((s) => !s)}
                  >
                    <Archive aria-hidden="true" />
                    Archived ({activeArea.archivedCount})
                  </Button>
                )}
              </header>
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
                          ariaLabelConfig={ARIA_LABELS}
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
      </Empty>
    );
  }

  return (
    <div
      ref={root}
      className="flex h-full min-h-0 min-w-0 flex-col"
      onClickCapture={(event) => {
        pressedLink.current = event.target instanceof Element ? event.target.closest<HTMLElement>('a') : null;
      }}
    >
      {notices}
      {body}
    </div>
  );
}
