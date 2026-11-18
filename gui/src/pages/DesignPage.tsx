import { useMemo, type MouseEvent } from 'react';
import { ReactFlow, type Node, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AREA_ROW, AREA_SIZE, areaCardHeight, type AreaData } from '../features/board/boardAreas.js';
import { BOARD_SIZE } from '../features/board/boardLayout.js';
import { ITEM_HEIGHT, READABLE_ZOOM, ROW_SIZE, WORKSPACE_FILE_SIZE } from '../features/board/boardRows.js';
import { CardContexts, cardFixtures, PAGE_ACTIONS, type CardFixture } from '../features/board/cards/cardFixtures.js';
import { CARD_KINDS } from './designPageLists.js';
import { DesignPieces } from './DesignPieces.js';

type Box = { width: number; height: number };

/** What a card is drawn at: the size the Board gives it (a card is `h-full w-full` of its node, so it needs one). */
function boxOf(fixture: CardFixture): Box {
  const { props, kind } = fixture;
  const data = props.data as Record<string, unknown>;
  const given = { width: props.width, height: props.height };
  const compact = data.compact === true;
  const sized = (width: number, height: number): Box => ({ width: given.width ?? width, height: given.height ?? height });
  switch (kind) {
    case 'area': return sized(AREA_SIZE.width, areaCardHeight(data as unknown as AreaData));
    case 'areaRow': return sized(AREA_ROW.minWidth, AREA_ROW.height);
    case 'areaMini': return sized(AREA_SIZE.width, AREA_SIZE.height);
    case 'areaFold': return sized(AREA_SIZE.width, AREA_ROW.height);
    // An open frame gets the room of its "Add step" row, which the Board's own heights leave out, so the button can be pressed here.
    case 'checkpoint': return sized(data.waitingOnly === true ? 420 : BOARD_SIZE.column, data.open === false ? BOARD_SIZE.folded : (Number(data.openHeight) || BOARD_SIZE.folded) + (data.waitingOnly === true ? 0 : 56));
    case 'lane': {
      const group = data.group as { open?: boolean; openHeight?: number } | undefined;
      return sized(BOARD_SIZE.column, group?.open ? Number(group.openHeight) || BOARD_SIZE.folded : BOARD_SIZE.folded);
    }
    case 'document': return sized(compact ? ROW_SIZE.card : BOARD_SIZE.card, compact ? ITEM_HEIGHT.document : BOARD_SIZE.document);
    case 'commit': return sized(compact ? ROW_SIZE.card : BOARD_SIZE.card, BOARD_SIZE.commit);
    case 'placeholder': return sized(compact ? ROW_SIZE.card : BOARD_SIZE.card, BOARD_SIZE.placeholder);
    case 'uncommitted': return sized(compact ? ROW_SIZE.card : BOARD_SIZE.card, ITEM_HEIGHT.uncommitted);
    case 'note': return sized(compact ? ROW_SIZE.card : BOARD_SIZE.card, compact ? ITEM_HEIGHT.note : BOARD_SIZE.note);
    case 'file': {
      if (!compact) return sized(BOARD_SIZE.card, BOARD_SIZE.file);
      if (data.group === 'documents') return sized(ROW_SIZE.card, WORKSPACE_FILE_SIZE.documentHeight);
      if (data.group === 'pictures') return sized(WORKSPACE_FILE_SIZE.pictureMaxWidth, WORKSPACE_FILE_SIZE.pictureHeight);
      return sized(ROW_SIZE.card, ITEM_HEIGHT.file);
    }
    case 'answer': return sized(BOARD_SIZE.card, data.variant === 'text' ? BOARD_SIZE.note + 40 : BOARD_SIZE.file);
    case 'step': return sized(2 * ROW_SIZE.card, data.prominent === true ? ROW_SIZE.current : ROW_SIZE.header);
    case 'fold': return sized(2 * ROW_SIZE.card, ROW_SIZE.fold);
    case 'more': return sized(ROW_SIZE.more, ROW_SIZE.header);
    case 'pager': return sized(ROW_SIZE.pager, ROW_SIZE.header);
    default: return sized(BOARD_SIZE.card, BOARD_SIZE.note);
  }
}

/** What the Area's canvas is: no panning, picking or dragging, at one fixed zoom. */
const FLOW_PROPS = {
  proOptions: { hideAttribution: true },
  panOnDrag: false,
  panOnScroll: false,
  zoomOnScroll: false,
  zoomOnPinch: false,
  zoomOnDoubleClick: false,
  preventScrolling: false,
  nodesDraggable: false,
  nodesConnectable: false,
  nodesFocusable: false,
  edgesFocusable: false,
  elementsSelectable: false,
  deleteKeyCode: null,
  panActivationKeyCode: null,
  selectionKeyCode: null,
  multiSelectionKeyCode: null,
  zoomActivationKeyCode: null,
  disableKeyboardA11y: true,
  minZoom: READABLE_ZOOM,
  maxZoom: READABLE_ZOOM,
  defaultViewport: { x: 0, y: 0, zoom: READABLE_ZOOM },
} as const;

/** Stops a press on a link from leaving the page (it would open another tab). */
function refuseLinks(event: MouseEvent<HTMLElement>) {
  if ((event.target as HTMLElement).closest('a[href]')) event.preventDefault();
}

/**
 * One card where the Board draws it: as a node of its own React Flow, at the Area's zoom, with the Board's contexts around it.
 * The box is the size it takes on the page (the node's size times the zoom).
 */
function DrawnCard({ fixture, now }: { fixture: CardFixture; now: Date }) {
  const box = boxOf(fixture);
  const { key, kind, Component, props, reading } = fixture;
  const nodeTypes = useMemo(() => ({ [kind]: Component }) as NodeTypes, [kind, Component]);
  const nodes = useMemo<Node[]>(() => [{
    id: props.id, type: kind, position: { x: 0, y: 0 }, width: box.width, height: box.height, data: props.data,
    draggable: false, selectable: false, connectable: false, deletable: false,
  }], [props, kind, box.width, box.height]);
  return (
    <figure
      data-testid={`design-card-${key}`}
      className="m-0 flex flex-col items-start gap-1.5"
      // A link on a card (a document's external address) goes nowhere on this page: presses here do nothing.
      onClickCapture={refuseLinks}
      onAuxClick={refuseLinks}
    >
      <div style={{ width: Math.ceil(box.width * READABLE_ZOOM), height: Math.ceil(box.height * READABLE_ZOOM) }}>
        <CardContexts now={now} reading={reading} actions={PAGE_ACTIONS}>
          <ReactFlow id={`design-${key}`} className="board-flow board-flow-rows" nodes={nodes} nodeTypes={nodeTypes} {...FLOW_PROPS} />
        </CardContexts>
      </div>
      <figcaption className="text-xs text-muted-foreground">{key}</figcaption>
    </figure>
  );
}

/**
 * The live design page, at `#/design`: nothing links to it. Every piece of the design module in each of its states, and every
 * kind of Board card in each state it has, so a change to one piece is seen everywhere it is drawn, in light and dark, at the
 * Board's own zoom. Fixture data only (`features/board/cards/cardFixtures.tsx`): it reads and writes nothing on the server.
 */
export function DesignPage() {
  const now = useMemo(() => new Date(), []);
  const fixtures = useMemo(() => cardFixtures(now), [now]);
  return (
    <main data-testid="design-page" className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Design page</h1>
        <p className="max-w-prose text-[13px] text-muted-foreground">
          Every piece of the design module and every kind of Board card, in each state. The cards are drawn at the Area's zoom ({READABLE_ZOOM}).
          Presses here do nothing: the data is made up and nothing is sent to the server.
        </p>
      </header>
      <section aria-labelledby="design-pieces-title" className="space-y-3">
        <h2 id="design-pieces-title" className="text-base font-semibold text-foreground">Pieces</h2>
        <DesignPieces />
      </section>
      <section aria-labelledby="design-cards-title" className="space-y-4">
        <h2 id="design-cards-title" className="text-base font-semibold text-foreground">Board cards</h2>
        {CARD_KINDS.map((kind) => {
          const ofKind = fixtures.filter((fixture) => fixture.kind === kind);
          return (
            <section key={kind} data-testid={`design-kind-${kind}`} aria-labelledby={`design-kind-${kind}-title`} className="space-y-2 rounded-lg border border-border bg-background p-4">
              <h3 id={`design-kind-${kind}-title`} className="text-sm font-semibold text-foreground">{kind}</h3>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                {ofKind.map((fixture) => <DrawnCard key={fixture.key} fixture={fixture} now={now} />)}
              </div>
            </section>
          );
        })}
      </section>
    </main>
  );
}
