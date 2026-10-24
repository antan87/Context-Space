import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Background, BackgroundVariant, ConnectionMode, Controls, MarkerType, MiniMap, ReactFlow, type DefaultEdgeOptions, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';
import { Archive, Kanban, RefreshCw, X } from 'lucide-react';

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
import { BoardActionsContext, BoardReadingContext, type BoardActions, type ReaderTarget } from './boardActions.js';
import {
  areaBoardLayout,
  buildBoardAreas,
  fitBoundsView,
  overviewEdges,
  overviewLayout,
  stepsText,
  waitingText,
  type AreaNode,
} from './boardAreas.js';
import { useBoard } from './boardData.js';
import { fileTitle, readerDock, readerReveal } from './boardDock.js';
import { boardEdges, nodeRects, type BoardNode } from './boardLayout.js';
import { MOVE_HELP, useBoardMoves, withMoves, type MoveNotice } from './boardMoves.js';
import { BoardArea, BoardCheckpoint, BoardCommit, BoardDocument, BoardFile, BoardLane, BoardNote, BoardPlaceholder } from './BoardNodes.js';
import { BoardReader } from './BoardReader.js';
import { useReaderLayout, type ReaderLayout } from './boardReaderLayout.js';

const OVERVIEW_NODE_TYPES: NodeTypes = { area: BoardArea };
const AREA_NODE_TYPES: NodeTypes = {
  lane: BoardLane,
  checkpoint: BoardCheckpoint,
  document: BoardDocument,
  commit: BoardCommit,
  placeholder: BoardPlaceholder,
  note: BoardNote,
  file: BoardFile,
};

/** "Fit the board in view" shows everything, but never zoomed in past life size: a lone card is not blown up. */
const FIT = { padding: 0.12, maxZoom: 1 } as const;
const PAN_STEP = 96;
/** How far from the edge of the view a group or card is put, when the view moves to show it: clear of corners. */
const OPEN_MARGIN = 40;
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

const minimapClass = (node: { type?: string; data: Record<string, unknown> }) =>
  `board-mini-${node.type}${node.type === 'checkpoint' && node.data.done ? ' board-mini-done' : ''}`;

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

/**
 * Status of the last card move on Level 1.
 */
function MoveStatus({ notice, onDismiss, onKeep }: { notice: MoveNotice; onDismiss: () => void; onKeep: (on: boolean) => void }) {
  return <div
    onPointerEnter={() => onKeep(true)} onPointerLeave={() => onKeep(false)}
    onFocus={() => onKeep(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onKeep(false); }}
    className={cn('pointer-events-auto flex max-w-lg items-center gap-2 rounded-lg border px-3 py-1.5 text-xs shadow-sm',
      notice.failed ? 'border-destructive/30 bg-destructive/10 text-destructive-foreground' : 'border-border bg-card text-foreground')}
  >
    <span aria-hidden="true" className="min-w-0 break-words">{notice.text}</span>
    {notice.undo && <Button size="xs" variant="outline" onClick={notice.undo}>Undo</Button>}
    {notice.failed && <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></Button>}
  </div>;
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
  const pressedLink = useRef<HTMLElement | null>(null);
  const revealing = useRef<string | null>(null);

  const show = useCallback((target: ReaderTarget, from: HTMLElement | null, reveal: boolean) => {
    opener.current = from ?? pressedLink.current;
    revealing.current = reveal ? opener.current?.closest('.react-flow__node')?.getAttribute('data-id') ?? null : null;
    requests.current += 1;
    setReader({ target, request: requests.current });
  }, [setReader]);

  const openInReader = useCallback((target: ReaderTarget, from: HTMLElement | null) => show(target, from, true), [show]);
  const closeReader = useCallback(() => setReader(null), [setReader]);
  const changeLayout = useCallback((next: ReaderLayout) => {
    if (next === 'side') revealing.current = opener.current?.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
    setLayout(next);
  }, [setLayout]);

  const openLinked = useCallback((path: string) => show({ path, title: fileTitle(path) }, opener.current, false), [show]);
  const openInDocs = useCallback((name: string) => {
    documentRequests.open(workspaceId, { name });
    goToWorkspace(navigateTo, workspaceId, 'documents');
  }, [workspaceId, navigateTo]);

  // Stepping In and Out state
  const [stepped, setStepped] = useState<SteppedState>(null);
  const steppedRef = useRef<SteppedState>(null);
  useLayoutEffect(() => { steppedRef.current = stepped; }, [stepped]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<string | null>(null);
  const focusing = useRef(false);

  // Stepped fallback redirect if active area disappeared
  useEffect(() => {
    if (!stepped) return;
    if (!loading && areas.length === 0) {
      setReader(null);
      setStepped(null);
      return;
    }
    if (areas.length > 0 && !areas.some((a) => a.id === stepped.areaId)) {
      const fallback = areas.find((a) => a.data.current)?.id ?? areas[0]!.id;
      setStepped((s) => (s ? { ...s, areaId: fallback } : null));
    }
  }, [stepped, loading, areas, setReader]);

  const stepInto = useCallback((areaId: string, buttonEl: HTMLElement) => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const btnRect = buttonEl.getBoundingClientRect();
    const stageRect = stageContainer?.getBoundingClientRect();
    const xPct = stageRect && stageRect.width > 0 ? Math.round(((btnRect.left + btnRect.width / 2 - stageRect.left) / stageRect.width) * 100) : 50;
    const yPct = stageRect && stageRect.height > 0 ? Math.round(((btnRect.top + btnRect.height / 2 - stageRect.top) / stageRect.height) * 100) : 50;
    setStepped({ areaId, origin: `${xPct}% ${yPct}%`, phase: 'open' });
  }, [stageContainer]);

  const stepOut = useCallback(() => {
    const curr = steppedRef.current;
    if (!curr || curr.phase === 'closing') return;
    focusTarget.current = curr.areaId;
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
  }, [setReader]);

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

  // Focus Back button when stepped into an area
  useLayoutEffect(() => {
    if (stepped?.phase === 'open') {
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
  const moveHelp = useId();

  const [areaRow, setAreaRow] = useState<HTMLDivElement | null>(null);
  const areaSection = useLayoutElementSize(areaRow);
  const areaDock = readerDock(areaSection.width);
  const [areaCanvasContainer, setAreaCanvasContainer] = useState<HTMLDivElement | null>(null);
  const areaCanvasSize = useLayoutElementSize(areaCanvasContainer);
  const areaFlow = useRef<ReactFlowInstance<BoardNode> | null>(null);
  const [areaInstance, setAreaInstance] = useState<ReactFlowInstance<BoardNode> | null>(null);
  const areaTaken = useRef(false);
  const areaTakenBefore = useRef(false);

  useEffect(() => {
    if (!stepped) setAreaInstance(null);
  }, [stepped]);

  const readerOpenRef = useRef(Boolean(reader));
  useLayoutEffect(() => {
    readerOpenRef.current = Boolean(reader);
  }, [reader]);

  const areaNodes = useMemo(
    () => (activeArea ? withMoves(areaBoardLayout(activeArea, { news: newsView, positions: board?.positions }), moveHelp) : []),
    [activeArea, newsView, board?.positions, moveHelp],
  );

  const moves = useBoardMoves({
    workspaceId,
    nodes: areaNodes,
    flow: areaFlow,
    size: areaCanvasSize,
    reveal: (view) => {
      areaTaken.current = true;
      void areaFlow.current?.setViewport(view, { duration: moveMs(120) });
    },
    focusNode: (id) => {
      const things = areaCanvasContainer?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [];
      (Array.from(things).find((thing) => thing.dataset.id === id) ?? areaCanvasContainer?.querySelector<HTMLElement>('.react-flow'))?.focus({ preventScroll: true });
    },
  });

  const areaEdges = useMemo(() => boardEdges(moves.shown, board?.links ?? []), [moves.shown, board]);

  // Plane 1 Viewport auto-fitting
  const areaViewport = useMemo(
    () => fitBoundsView(areaNodes, areaSection, { topInset: 28, bottomInset: 48, minAutoZoom: 0.4 }),
    [areaNodes, areaSection],
  );

  const loaded = `${Boolean(planView)}${Boolean(documents)}${Boolean(newsView)}${Boolean(board)}`;
  const activeAreaId = activeArea?.id;
  const areaFitKey = activeAreaId && areaSection.width > 0 && areaSection.height > 0
    ? `${activeAreaId}|${loaded}|${showArchived}|${areaSection.width}x${areaSection.height}`
    : null;
  const lastSteppedAreaId = useRef<string | null>(null);
  const steppedAreaFitted = useRef<string | null>(null);
  useEffect(() => {
    if (!activeAreaId) {
      lastSteppedAreaId.current = null;
      steppedAreaFitted.current = null;
      areaTaken.current = false;
      return;
    }
    if (!areaFitKey || !areaViewport || !areaInstance) return;
    if (lastSteppedAreaId.current !== activeAreaId) {
      lastSteppedAreaId.current = activeAreaId;
      steppedAreaFitted.current = areaFitKey;
      areaTaken.current = false;
      void areaInstance.setViewport(areaViewport, { duration: 0 });
      return;
    }
    if (steppedAreaFitted.current !== areaFitKey) {
      if (!areaTaken.current && !readerOpenRef.current) {
        steppedAreaFitted.current = areaFitKey;
        void areaInstance.setViewport(areaViewport, { duration: moveMs(200) });
      } else if (areaTaken.current) {
        steppedAreaFitted.current = areaFitKey;
      }
    }
  }, [activeAreaId, areaFitKey, areaViewport, areaInstance]);

  // Docked reader reveal in Plane 1
  useEffect(() => {
    const id = revealing.current;
    const instance = areaFlow.current;
    if (!reader || id === null || !instance || areaSection.width === 0) return;
    revealing.current = null;
    if (layout === 'large') return;
    const rect = nodeRects(moves.shown).get(id);
    const view = rect && readerReveal(rect, instance.getViewport(), areaSection, OPEN_MARGIN);
    if (view) {
      void instance.setViewport(view, { duration: moveMs(300) });
    }
  }, [reader, layout, moves.shown, areaSection]);

  // Reader Escape handling
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reader || !active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = event.target;
      const inside = target instanceof Node && Boolean(root.current?.contains(target));
      if (!inside && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      closeReader();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [reader, active, closeReader]);

  // Stepped Area Escape handling (only when reader is closed and no modal dialog is open)
  useEffect(() => {
    if (!stepped || stepped.phase !== 'open' || reader || !active) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      const target = event.target;
      const inside = target instanceof Node && Boolean(root.current?.contains(target));
      if (!inside && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      stepOut();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stepped, reader, active, stepOut]);

  // Focus restoration when reader closes
  const wasReaderOpen = useRef(false);
  useLayoutEffect(() => {
    if (reader) { wasReaderOpen.current = true; return; }
    if (!wasReaderOpen.current) return;
    wasReaderOpen.current = false;
    const from = opener.current;
    opener.current = null;
    focusing.current = true;
    (from?.isConnected ? from : areaCanvasContainer?.querySelector<HTMLElement>('.react-flow'))?.focus({ preventScroll: true });
    focusing.current = false;
  }, [reader, areaCanvasContainer]);

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
  }), [workspaceId, workspacePath, openInReader]);

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
      <div className="relative flex min-h-0 flex-1">
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
                {activeArea.data.waitingCount > 0 && (
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
                    onPointerDownCapture={(event) => {
                      areaTakenBefore.current = areaTaken.current;
                      if (isViewGesture(areaCanvasContainer, event.target)) areaTaken.current = true;
                    }}
                    onMouseDownCapture={(event) => {
                      if (event.detail >= 2) areaTaken.current = areaTakenBefore.current;
                    }}
                    onWheelCapture={(event) => {
                      if (areaCanvasContainer?.contains(event.target as Node)) areaTaken.current = true;
                    }}
                    onFocusCapture={(event) => {
                      if (!focusing.current) showFocused(areaFlow.current, event, areaCanvasSize, () => { areaTaken.current = true; });
                    }}
                  >
                    <p id={moveHelp} className="sr-only">{MOVE_HELP}</p>
                    <div role="status" className="sr-only">{moves.notice?.text}</div>
                    {moves.notice && (
                      <div className="pointer-events-none absolute inset-x-16 top-3 z-10 flex justify-center">
                        <MoveStatus notice={moves.notice} onDismiss={moves.dismiss} onKeep={moves.keepNotice} />
                      </div>
                    )}
                    <BoardActionsContext value={areaActions}>
                      <BoardReadingContext value={reader?.target.card ?? null}>
                        <ReactFlow
                          id="board-area-flow"
                          className="board-flow"
                          aria-label="Area canvas. Arrow keys pan, plus and minus zoom, zero fits the board in view. Drag a card to move it, or press Shift and an arrow key on it."
                          tabIndex={0}
                          nodes={moves.shown}
                          edges={areaEdges}
                          nodeTypes={AREA_NODE_TYPES}
                          defaultEdgeOptions={EDGE_OPTIONS}
                          defaultViewport={areaViewport ?? undefined}
                          connectionMode={ConnectionMode.Loose}
                          onInit={(instance) => {
                            areaFlow.current = instance;
                            setAreaInstance(instance);
                          }}
                          onKeyDown={(event) => {
                            if (!moves.onKeyDown(event)) navigate(areaFlow.current, event, () => { areaTaken.current = true; });
                          }}
                          onNodesChange={moves.onNodesChange}
                          onNodeDragStart={moves.onNodeDragStart}
                          onNodeDragStop={moves.onNodeDragStop}
                          nodeDragThreshold={3}
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
                          <MiniMap pannable zoomable nodeClassName={minimapClass} />
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
