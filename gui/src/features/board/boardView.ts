/**
 * Where the board opens. A board whose groups all fit the view's width at a zoom you can read opens on all of them, side
 * by side. Fitting everything on a busier board shrinks it to a map nobody can read, so that one opens on the work that
 * is under way instead: the first checkpoint that is not done, with the cards around it, at a zoom you can read.
 * "Fit the board in view" stays on the controls for the whole picture. Pure, so the choice is tested alone.
 */

import { BOARD_SIZE, currentFrame, isFolded, nodeRects, type BoardNode, type CheckpointNode, type Rect } from './boardLayout.js';

export interface Viewport { x: number; y: number; zoom: number }
export interface Size { width: number; height: number }

/** The zoom the board opens at: as close as it gets to life size, never smaller than 0.8 unless the work itself needs it. */
export const OPENING = { minZoom: 0.8, maxZoom: 1, margin: 0.06, reach: BOARD_SIZE.column + BOARD_SIZE.columnGap, allMinZoom: 0.7 } as const;

/**
 * The node the board opens on: the first checkpoint that is not done, else the last one (all done), else the plan's own
 * frame, else the first thing in reading order. Undefined for an empty board.
 */
export function openingNodeId(nodes: BoardNode[]): string | undefined {
  const open = currentFrame(nodes.filter((node): node is CheckpointNode => node.type === 'checkpoint'));
  if (open) return open.id;
  const rects = nodeRects(nodes);
  // A group counts as the one thing it is, open or folded, so the choice does not change as the user opens or folds it.
  const groups = new Set(nodes.filter((node) => node.type === 'lane' && node.data.group).map((node) => node.id));
  return nodes.filter((node) => (node.type === 'lane' ? groups.has(node.id) : !(node.parentId && groups.has(node.parentId))))
    .sort((a, b) => rects.get(a.id)!.x - rects.get(b.id)!.x || rects.get(a.id)!.y - rects.get(b.id)!.y)[0]?.id;
}

/** Whether a node is something to look at on its own: not a lane, which is only the box around its cards, unless it is folded into a summary. */
const drawn = (node: BoardNode) => node.type !== 'lane' || isFolded(node);

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/** How far apart two rectangles are: zero when they touch or overlap. */
function distance(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/** The zoom at which `rect` fills the view, less its margin. */
function zoomToFit(rect: Rect, size: Size): number {
  const room = 1 - 2 * OPENING.margin;
  return Math.min((size.width * room) / rect.width, (size.height * room) / rect.height);
}

/** The columns of the row of groups: the frames and the lanes, not the band of cards under them (and not the cards put elsewhere). */
const columns = (nodes: BoardNode[]) => nodes.filter((node) => node.type === 'checkpoint' || (node.type === 'lane' && node.id !== 'lane:board'));

/**
 * Where to put the viewport so the board opens on all of its groups, when every column, from the first to the last, fits
 * the width of the view at a zoom of at least `OPENING.allMinZoom` (less the margin): at the zoom that fits them, never past
 * life size, centred across, with the top of the row at the top margin. Null when they do not fit, when there is no group, or
 * when the work under way, open, would be cut off at the bottom of the view.
 */
function openingAll(nodes: BoardNode[], size: Size): Viewport | null {
  const rects = nodeRects(nodes);
  const row = columns(nodes).map((node) => rects.get(node.id)!);
  if (row.length === 0) return null;
  const left = Math.min(...row.map((rect) => rect.x));
  const width = Math.max(...row.map((rect) => rect.x + rect.width)) - left;
  const fit = (size.width * (1 - 2 * OPENING.margin)) / width;
  if (fit < OPENING.allMinZoom) return null;
  const zoom = Math.min(OPENING.maxZoom, fit);
  const top = Math.min(...row.map((rect) => rect.y));
  const view = { zoom, x: size.width / 2 - (left + width / 2) * zoom, y: size.height * OPENING.margin - top * zoom };
  const focus = openingNodeId(nodes);
  const work = focus === undefined ? undefined : rects.get(focus);
  return work && (work.y + work.height) * zoom + view.y > size.height * (1 - OPENING.margin) ? null : view;
}

/**
 * Where to put the viewport so the board opens on the current work. The focus is the node `openingNodeId` names; the
 * things within a column's reach of it join it one by one, nearest first, for as long as they all fit on screen at the
 * smallest zoom that is still easy to read. The view then centres on all of that, at the zoom that fits it, between
 * the smallest and life size. A board whose groups all fit the width of the view (`openingAll`) opens on all of them
 * instead. Null when the board is empty or the view has no size yet.
 */
export function openingView(nodes: BoardNode[], size: Size): Viewport | null {
  const focusId = openingNodeId(nodes);
  if (focusId === undefined || size.width <= 0 || size.height <= 0) return null;
  const all = openingAll(nodes, size);
  if (all) return all;
  const rects = nodeRects(nodes);
  const focus = rects.get(focusId)!;
  // The work itself comes first: a frame taller than the view is shown at the zoom that fits it, not cut off.
  const floor = Math.min(OPENING.minZoom, zoomToFit(focus, size));

  const near = nodes.filter((node) => node.id !== focusId && drawn(node))
    .map((node) => ({ id: node.id, rect: rects.get(node.id)!, apart: distance(focus, rects.get(node.id)!) }))
    .filter((entry) => entry.apart <= OPENING.reach)
    .sort((a, b) => a.apart - b.apart || a.rect.x - b.rect.x || a.rect.y - b.rect.y || (a.id < b.id ? -1 : 1));
  let bounds = focus;
  for (const entry of near) {
    const wider = union(bounds, entry.rect);
    if (zoomToFit(wider, size) >= floor) bounds = wider;
  }

  const zoom = Math.min(OPENING.maxZoom, Math.max(floor, zoomToFit(bounds, size)));
  return { zoom, x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom };
}
