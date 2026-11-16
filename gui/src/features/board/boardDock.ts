/**
 * The reader beside the board: where it stands in the Board section. Pure, so the choices are tested alone.
 */


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

/** What a file is called when nothing else names it: the last part of its path. */
export const fileTitle = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
