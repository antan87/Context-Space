import '@xyflow/react/dist/style.css';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type Edge, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';
import { Kanban, RefreshCw } from 'lucide-react';

import { Button } from '../../components/ui/button.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '../../components/ui/empty.js';
import { Spinner } from '../../components/ui/spinner.js';
import { useWorkGuidance } from '../../lib/api/queries.js';
import { useElementWidth } from '../../lib/useElementWidth.js';
import { usePlanFile } from '../plan/planFile.js';
import { useWhatsNew } from '../plan/whatsNew.js';
import { BoardCheckpoint, BoardCommit, BoardDocument, BoardLane, BoardPlaceholder } from './BoardNodes.js';
import { boardLayout, type BoardNode } from './boardLayout.js';

const NODE_TYPES: NodeTypes = { lane: BoardLane, checkpoint: BoardCheckpoint, document: BoardDocument, commit: BoardCommit, placeholder: BoardPlaceholder };

/** The board opens fitted to its content, but never zoomed in past life size: a lone card is not blown up. */
const FIT = { padding: 0.12, maxZoom: 1 } as const;
const PAN_STEP = 96;
const NO_EDGES: Edge[] = [];

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
function navigate(flow: ReactFlowInstance<BoardNode> | null, event: KeyboardEvent<HTMLDivElement>) {
  if (!flow || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
  const { x, y, zoom } = flow.getViewport();
  const pan = (dx: number, dy: number) => void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 120 });
  switch (event.key) {
    case 'ArrowLeft': pan(PAN_STEP, 0); break;
    case 'ArrowRight': pan(-PAN_STEP, 0); break;
    case 'ArrowUp': pan(0, PAN_STEP); break;
    case 'ArrowDown': pan(0, -PAN_STEP); break;
    case '+': case '=': void flow.zoomIn({ duration: 120 }); break;
    case '-': case '_': void flow.zoomOut({ duration: 120 }); break;
    case '0': void flow.fitView({ ...FIT, duration: 200 }); break;
    default: return;
  }
  event.preventDefault();
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
 * the recent commits of each repository. Read-only for now. It uses the queries the other parts already use, so a part
 * that fails says so and the rest still draws.
 */
export function BoardSection({ workspaceId }: { workspaceId: string }) {
  const plan = usePlanFile(workspaceId);
  const guidance = useWorkGuidance(workspaceId);
  const news = useWhatsNew(workspaceId);
  const flow = useRef<ReactFlowInstance<BoardNode> | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(container);

  const planView = plan.data;
  const documents = guidance.data?.documents;
  const newsView = news.data;
  const nodes = useMemo(() => boardLayout({ plan: planView, documents, news: newsView }), [planView, documents, newsView]);

  // A part without data is still loading or has failed; one that has data and fails a later refresh keeps what it had.
  const parts = [
    { what: 'The plan', query: plan }, { what: 'The documents', query: guidance }, { what: 'The commits', query: news },
  ].map(({ what, query }) => ({ what, query, loading: !query.data && !query.isError, failed: !query.data && query.isError }));
  const loading = parts.some((part) => part.loading);
  const problems = parts.filter((part) => part.failed);

  // The canvas fits as it opens. When another part arrives later it is fitted again, so it is not left out of view; the
  // canvas itself stays, with the user's own panning and zooming until then. A board that is hidden when the part arrives
  // (it stays mounted behind the other sections) has no width, so it is fitted when it is next shown.
  const loaded = `${Boolean(planView)}${Boolean(documents)}${Boolean(newsView)}`;
  const fittedFor = useRef(loaded);
  useEffect(() => {
    if (fittedFor.current === loaded || !width) return;
    fittedFor.current = loaded;
    void flow.current?.fitView({ ...FIT, duration: 200 });
  }, [loaded, width]);

  const notices = (problems.length > 0 || (loading && nodes.length > 0)) && <div className="shrink-0 space-y-1.5 border-b border-border/60 px-4 py-2">
    {problems.map((part) => <SourceProblem key={part.what} what={part.what} error={part.query.error} onRetry={() => void part.query.refetch()} />)}
    {loading && <p role="status" className="text-xs text-muted-foreground">Still loading: {parts.filter((part) => part.loading).map((part) => part.what.replace(/^The /, '')).join(', ')}</p>}
  </div>;

  let body;
  if (nodes.length > 0) {
    body = <div className="relative min-h-0 flex-1">
      <div ref={setContainer} className="absolute inset-0">
        <ReactFlow
          className="board-flow"
          aria-label="Board canvas. Arrow keys pan, plus and minus zoom, zero fits the board in view."
          tabIndex={0}
          nodes={nodes}
          edges={NO_EDGES}
          nodeTypes={NODE_TYPES}
          onInit={(instance) => { flow.current = instance; fittedFor.current = loaded; }}
          onKeyDown={(event) => navigate(flow.current, event)}
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
          fitView
          fitViewOptions={FIT}
          minZoom={0.1}
          maxZoom={1.5}
          attributionPosition="bottom-center"
          ariaLabelConfig={ARIA_LABELS}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
          <Controls showInteractive={false} fitViewOptions={FIT} />
          <MiniMap pannable zoomable nodeClassName={minimapClass} />
        </ReactFlow>
      </div>
    </div>;
  } else if (loading) {
    body = <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner role="presentation" aria-hidden="true" className="size-4" />Loading the board</div>;
  } else if (problems.length === 0) {
    body = <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><Kanban aria-hidden="true" /></EmptyMedia>
        <EmptyDescription>Nothing on the board yet: the plan, documents and commits of this workspace appear here.</EmptyDescription>
      </EmptyHeader>
    </Empty>;
  }

  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    {notices}
    {body}
  </div>;
}
