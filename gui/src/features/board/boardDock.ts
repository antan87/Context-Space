/**
 * The reader beside the board: where it stands in the Board section, and how the view moves so the card that was opened
 * stays in sight beside it. Pure, so the choices are tested alone.
 */

import { revealed } from './boardMoves.js';
import type { Viewport } from './boardView.js';
import type { Rect } from './boardLayout.js';

/** The reader takes about this share of the section, never less than `minWidth`, and leaves the canvas at least `minCanvas`. */
export const READER = { share: 0.45, minWidth: 360, minCanvas: 360 } as const;

export interface ReaderDock {
  /** The section is too narrow for both: the reader covers the whole canvas, and the canvas waits under it. */
  covers: boolean;
  width: number;
}

export function readerDock(sectionWidth: number): ReaderDock {
  const wanted = Math.max(READER.minWidth, Math.round(sectionWidth * READER.share));
  return sectionWidth - wanted < READER.minCanvas ? { covers: true, width: sectionWidth } : { covers: false, width: wanted };
}

/**
 * Where to put the view so `rect` (the card that was opened) is whole inside the part of the canvas the reader leaves
 * free, moved only as far as it takes. Null when it is in sight already, and when the reader covers the canvas: the
 * card is where it was when the reader closes.
 */
export function readerReveal(rect: Rect, view: Viewport, section: { width: number; height: number }, margin: number): Viewport | null {
  const dock = readerDock(section.width);
  return dock.covers ? null : revealed(rect, view, { width: section.width - dock.width, height: section.height }, margin);
}

/** What a file is called when nothing else names it: the last part of its path. */
export const fileTitle = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
