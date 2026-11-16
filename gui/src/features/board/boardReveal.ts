/**
 * Pure math for bringing one node of the overview into view.
 *
 * The overview is a grid that fits the stage, so a card that is already whole in view must not move the view, and a card that is not
 * moves it the least needed, on the axis where it is outside. A move on the other axis would swing a grid sideways for no reason.
 */

export interface RevealViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface RevealRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RevealSize {
  width: number;
  height: number;
}

export const REVEAL_MARGIN = 12;

/**
 * How far to move a span so it lies whole inside [low, high]. The span keeps `margin` from the high edge and from the low edge, except that
 * a low edge which is an inset (low > 0) is already the margin: the layout rests there, so nothing may land below it.
 */
function shift(start: number, length: number, low: number, high: number, margin: number): number {
  const end = start + length;
  if (start >= low && end <= high) return 0;
  const lowMargin = low > 0 ? 0 : margin;
  // Larger than the room: show its start
  if (length + lowMargin + margin > high - low) return low + lowMargin - start;
  return start < low ? low + lowMargin - start : high - margin - end;
}

/**
 * The viewport that brings `rect` (in flow units) whole into the stage, or null when it already is whole in view.
 * `top` is the height at the top of the stage that the pane's own icons cover: a card there is not in view and is never moved under it.
 */
export function revealViewport(viewport: RevealViewport, rect: RevealRect, stage: RevealSize, margin: number = REVEAL_MARGIN, top: number = 0): RevealViewport | null {
  if (stage.width <= 0 || stage.height <= 0) return null;
  const { x, y, zoom } = viewport;
  const dx = shift(rect.x * zoom + x, rect.width * zoom, 0, stage.width, margin);
  const dy = shift(rect.y * zoom + y, rect.height * zoom, Math.min(top, stage.height), stage.height, margin);
  if (dx === 0 && dy === 0) return null;
  return { x: x + dx, y: y + dy, zoom };
}
