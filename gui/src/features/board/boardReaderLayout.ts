/**
 * Where a document that was opened from the Board is shown: in a large window over the board, which is the default, or
 * docked beside the canvas ("side by side"). The choice is the viewer's, kept in this browser for every workspace. Pure,
 * apart from the storage.
 */

import { useCallback, useState } from 'react';

export type ReaderLayout = 'large' | 'side';

/** The large window takes about this share of the Board section's width and height, centred: the board stays in sight all round it. */
export const LARGE_WINDOW = { width: 0.92, height: 0.88 } as const;

export const LAYOUT_KEY = 'contextspace_board_reader_layout_v1';

/** The layout from what storage held: anything but the dock is the large window. */
export const cleanLayout = (raw: unknown): ReaderLayout => (raw === 'side' ? 'side' : 'large');

/** What this browser remembers. Storage can be unavailable or hold anything: then the large window shows. */
export function readLayout(): ReaderLayout {
  try {
    return cleanLayout(window.localStorage.getItem(LAYOUT_KEY));
  } catch {
    return 'large';
  }
}

export function writeLayout(layout: ReaderLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout);
  } catch { /* The choice holds for this visit only. */ }
}

/** The layout of the reader, and the way to change it. A change is kept in storage at once. */
export function useReaderLayout(): [ReaderLayout, (layout: ReaderLayout) => void] {
  const [layout, setLayout] = useState(readLayout);
  const choose = useCallback((next: ReaderLayout) => {
    setLayout(next);
    writeLayout(next);
  }, []);
  return [layout, choose];
}
