/**
 * Where the board opens. Fitting everything shrinks a busy board to a map nobody can read, so it opens on the work that
 * is under way instead: the first checkpoint that is not done, with the cards around it, at a zoom you can read.
 * "Fit the board in view" stays on the controls for the whole picture. Pure, so the choice is tested alone.
 */

import { BOARD_SIZE, currentFrame, nodeRects, type BoardNode, type CheckpointNode, type Rect } from './boardLayout.js';

export interface Viewport { x: number; y: number; zoom: number }
export interface Size { width: number; height: number }

/** The zoom the board opens at: as close as it gets to life size, never smaller than 0.8 unless the work itself needs it. */
export const OPENING = { minZoom: 0.8, maxZoom: 1, margin: 0.06, reach: BOARD_SIZE.column + BOARD_SIZE.columnGap } as const;

/**
 * The node the board opens on: the first checkpoint that is not done, else the last one (all done), else the plan's own
 * frame, else the first thing in reading order. Undefined for an empty board.
 */
export function openingNodeId(nodes: BoardNode[]): string | undefined {
  const open = currentFrame(nodes.filter((node): node is CheckpointNode => node.type === 'checkpoint'));
  if (open) return open.id;
  const rects = nodeRects(nodes);
  return nodes.filter((node) => node.type !== 'lane')
    .sort((a, b) => rects.get(a.id)!.x - rects.get(b.id)!.x || rects.get(a.id)!.y - rects.get(b.id)!.y)[0]?.id;
}

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

/**
 * Where to put the viewport so the board opens on the current work. The focus is the node `openingNodeId` names; the
 * things within a column's reach of it join it one by one, nearest first, for as long as they all fit on screen at the
 * smallest zoom that is still easy to read. The view then centres on all of that, at the zoom that fits it, between
 * the smallest and life size. Null when the board is empty or the view has no size yet.
 */
export function openingView(nodes: BoardNode[], size: Size): Viewport | null {
  const focusId = openingNodeId(nodes);
  if (focusId === undefined || size.width <= 0 || size.height <= 0) return null;
  const rects = nodeRects(nodes);
  const focus = rects.get(focusId)!;
  // The work itself comes first: a frame taller than the view is shown at the zoom that fits it, not cut off.
  const floor = Math.min(OPENING.minZoom, zoomToFit(focus, size));

  const near = nodes.filter((node) => node.id !== focusId && node.type !== 'lane')
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
