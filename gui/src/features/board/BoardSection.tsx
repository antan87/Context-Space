import '@xyflow/react/dist/style.css';

import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Background, BackgroundVariant, ConnectionMode, Controls, MarkerType, MiniMap, ReactFlow, type DefaultEdgeOptions, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';
import { Archive, Kanban, RefreshCw } from 'lucide-react';

import { Button } from '../../components/ui/button.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '../../components/ui/empty.js';
import { Spinner } from '../../components/ui/spinner.js';
import { useWorkGuidance } from '../../lib/api/queries.js';
import { useElementSize } from '../../lib/useElementSize.js';
import { usePageVisible } from '../../lib/usePageVisible.js';
import { goToWorkspace } from '../chat/chatRoute.js';
import { usePlanFile } from '../plan/planFile.js';
import { useWhatsNew } from '../plan/whatsNew.js';
import { useFeedConnected } from '../progress/useScreenFeed.js';
import { documentRequests } from '../workspace-shell/openRequests.js';
import { BoardActionsContext, type BoardActions } from './boardActions.js';
import { useBoard } from './boardData.js';
import { boardEdges, boardLayout, type BoardNode } from './boardLayout.js';
import { openingNodeId, openingView, type Viewport } from './boardView.js';
import { BoardCheckpoint, BoardCommit, BoardDocument, BoardFile, BoardLane, BoardNote, BoardPlaceholder } from './BoardNodes.js';

const NODE_TYPES: NodeTypes = { lane: BoardLane, checkpoint: BoardCheckpoint, document: BoardDocument, commit: BoardCommit, placeholder: BoardPlaceholder, note: BoardNote, file: BoardFile };

/** "Fit the board in view" shows everything, but never zoomed in past life size: a lone card is not blown up. */
const FIT = { padding: 0.12, maxZoom: 1 } as const;
const PAN_STEP = 96;
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

/** Arrow keys pan, plus and minus zoom, zero fits: the canvas is a keyboard stop, since its cards are read-only. */
function navigate(flow: ReactFlowInstance<BoardNode> | null, event: KeyboardEvent<HTMLDivElement>, onMoved: () => void) {
  if (!flow || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
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
 * Whether a press went to the canvas itself, the overview map or the zoom controls: moving the view by hand. The buttons
 * and links on the cards, the archived toggle and a dialog that is open over the board do not move it. A card's buttons
 * are tested first: React Flow's pane wraps the cards too, so they would count as the canvas.
 */
function isViewGesture(container: HTMLElement | null, target: EventTarget): boolean {
  if (!(target instanceof Element) || !container?.contains(target)) return false;
  if (target.closest('.react-flow__node button, .react-flow__node a, .react-flow__node [role="button"]')) return false;
  return Boolean(target.closest('.react-flow__pane, .react-flow__minimap, .react-flow__controls'));
}

/**
 * A card that gets the keyboard's focus while it is out of view is brought into view: a button that cannot be seen is
 * hard to use. Focus given by a click is left alone, so the card does not move away from under the pointer.
 */
function showFocused(flow: ReactFlowInstance<BoardNode> | null, event: FocusEvent<HTMLDivElement>, size: { width: number; height: number }, onMoved: () => void) {
  const target = event.target as HTMLElement;
  const id = target.closest<HTMLElement>('.react-flow__node')?.dataset.id;
  const node = id ? flow?.getInternalNode(id) : undefined;
  if (!flow || !node || !target.matches(':focus-visible')) return;
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

/**
 * The Board: the workspace's real work on a canvas you can pan and zoom: its documents, the checkpoints of its plan and
 * the commits of each repository that are new since you last looked, and the notes and files that you and the AI put
 * on it, with the lines between them. It opens on the work that is under way, at a zoom you can read; "fit the board
 * in view" shows the lot. Read-only for now. It uses the queries the other parts already use, so a part that fails
 * says so and the rest still draws. `active` is whether the board is the part on show: it stays mounted behind the others.
 */
export function BoardSection({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const plan = usePlanFile(workspaceId);
  const guidance = useWorkGuidance(workspaceId);
  const news = useWhatsNew(workspaceId);
  // While the board is shown and the page is in front it listens to the workspace's live feed, on its own or beside the
  // chat's strip, and reads again when something changes. Without the feed it reads every half minute.
  const visible = usePageVisible();
  const listening = active && visible;
  const connected = useFeedConnected(workspaceId, listening);
  const boardQuery = useBoard(workspaceId, { poll: listening && !connected });
  const navigateTo = useNavigate();
  const flow = useRef<ReactFlowInstance<BoardNode> | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(container);
  const [showArchived, setShowArchived] = useState(false);

  const planView = plan.data;
  const documents = guidance.data?.documents;
  const newsView = news.data;
  const board = boardQuery.data;
  const nodes = useMemo(() => boardLayout({ plan: planView, documents, news: newsView, board, showArchived }), [planView, documents, newsView, board, showArchived]);
  const edges = useMemo(() => boardEdges(nodes, board?.links ?? []), [nodes, board]);
  const archived = board?.cards.filter((card) => card.archived).length ?? 0;

  // The files on the cards open where the app opens documents: in Docs.
  const actions = useMemo<BoardActions>(() => ({
    workspaceId,
    openFile: (name) => { documentRequests.open(workspaceId, { name }); goToWorkspace(navigateTo, workspaceId, 'documents'); },
  }), [workspaceId, navigateTo]);

  // A part without data is still loading or has failed; one that has data and fails a later refresh keeps what it had.
  const parts = [
    { what: 'The plan', query: plan }, { what: 'The documents', query: guidance }, { what: 'The commits', query: news }, { what: 'The notes and files', query: boardQuery },
  ].map(({ what, query }) => ({ what, query, loading: !query.data && !query.isError, failed: !query.data && query.isError }));
  const loading = parts.some((part) => part.loading);
  const problems = parts.filter((part) => part.failed);

  // The canvas opens on the work under way, at a zoom you can read, and not before the board has a size: a board that is
  // hidden (it stays mounted behind the other sections) is opened when it is first shown. When another part arrives
  // later, or the work moves on to the next checkpoint, the view follows, unless the user has taken it over by
  // panning or zooming (the canvas, the map, the controls, the wheel, the arrow and zoom keys): then it stays where they
  // put it. "Fit" is always on the controls.
  const loaded = `${Boolean(planView)}${Boolean(documents)}${Boolean(newsView)}${Boolean(board)}`;
  const openKey = `${openingNodeId(nodes) ?? ''}|${loaded}`;
  const [opening, setOpening] = useState<Viewport | null>(null);
  const shownFor = useRef(openKey);
  const taken = useRef(false);
  const takeOver = () => { taken.current = true; };
  useEffect(() => {
    if (nodes.length === 0) { if (opening) setOpening(null); return; }
    if (opening) return;
    const viewport = openingView(nodes, size);
    if (viewport) { shownFor.current = openKey; setOpening(viewport); }
  }, [opening, nodes, size, openKey]);
  useEffect(() => {
    if (!opening || taken.current || shownFor.current === openKey || !flow.current) return;
    const viewport = openingView(nodes, size);
    if (!viewport) return;
    shownFor.current = openKey;
    void flow.current.setViewport(viewport, { duration: moveMs(300) });
  }, [opening, nodes, size, openKey]);

  const notices = (problems.length > 0 || (loading && nodes.length > 0)) && <div className="shrink-0 space-y-1.5 border-b border-border/60 px-4 py-2">
    {problems.map((part) => <SourceProblem key={part.what} what={part.what} error={part.query.error} onRetry={() => void part.query.refetch()} />)}
    {loading && <p role="status" className="text-xs text-muted-foreground">Still loading: {parts.filter((part) => part.loading).map((part) => part.what.replace(/^The /, '')).join(', ')}</p>}
  </div>;

  let body;
  if (nodes.length > 0) {
    body = <div className="relative min-h-0 flex-1">
      <div
        ref={setContainer} className="absolute inset-0"
        onPointerDownCapture={(event) => { if (isViewGesture(container, event.target)) taken.current = true; }}
        onWheelCapture={(event) => { if (container?.contains(event.target as Node)) taken.current = true; }}
        onFocusCapture={(event) => showFocused(flow.current, event, size, takeOver)}
      >
        {/* Ahead of the canvas, so it is the first stop for the keyboard, not the last one after every card. */}
        {opening && archived > 0 && <div className="absolute left-3 top-3 z-10">
          <Button size="xs" variant={showArchived ? 'secondary' : 'outline'} aria-pressed={showArchived} onClick={() => setShowArchived((shown) => !shown)}>
            <Archive aria-hidden="true" />Archived ({archived})
          </Button>
        </div>}
        {opening && <BoardActionsContext value={actions}>
          <ReactFlow
            className="board-flow"
            aria-label="Board canvas. Arrow keys pan, plus and minus zoom, zero fits the board in view."
            tabIndex={0}
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            defaultEdgeOptions={EDGE_OPTIONS}
            defaultViewport={opening}
            connectionMode={ConnectionMode.Loose}
            onInit={(instance) => { flow.current = instance; }}
            onKeyDown={(event) => navigate(flow.current, event, takeOver)}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            // Nothing here is selected, deleted or dragged, and React Flow would otherwise keep a window-wide listener for
            // these keys that swallows Space for the whole page, even while the board is hidden behind another section.
            deleteKeyCode={null}
            panActivationKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            zoomActivationKeyCode={null}
            disableKeyboardA11y
            minZoom={0.1}
            maxZoom={1.5}
            attributionPosition="bottom-center"
            ariaLabelConfig={ARIA_LABELS}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
            <Controls showInteractive={false} fitViewOptions={FIT} />
            <MiniMap pannable zoomable nodeClassName={minimapClass} />
          </ReactFlow>
        </BoardActionsContext>}
      </div>
    </div>;
  } else if (loading) {
    body = <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner role="presentation" aria-hidden="true" className="size-4" />Loading the board</div>;
  } else if (problems.length === 0) {
    body = <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><Kanban aria-hidden="true" /></EmptyMedia>
        <EmptyDescription>Nothing on the board yet. The plan, documents and commits of this workspace appear here, and so do the notes and files you and the AI add.</EmptyDescription>
      </EmptyHeader>
    </Empty>;
  }

  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    {notices}
    {body}
  </div>;
}
