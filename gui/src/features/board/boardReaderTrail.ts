import type { ReaderTarget } from './boardActions.js';
import { isSameReaderTarget } from './boardReaderLayout.js';

/** Places the reader keeps to step back through, with the one it shows last. Older than this are dropped. */
export const TRAIL_CAP = 20;

let nextTrailId = 0;

/**
 * What the reader followed from inside itself. `origin` is the card the trail started from (it stays lit and gets the keyboard back
 * when the reader closes); `entries` are the places visited, the one shown now last.
 */
export interface ReaderTrail {
  id: number;
  origin: ReaderTarget;
  entries: ReaderTarget[];
}

/** Opening something from the board, the index, the Now line, or moving to another card with [ and ], starts a new trail. */
export function startTrail(target: ReaderTarget): ReaderTrail {
  nextTrailId += 1;
  return { id: nextTrailId, origin: target, entries: [target] };
}

/** Following something from inside the reader. The place already shown adds nothing. */
export function pushTrail(trail: ReaderTrail, target: ReaderTarget): ReaderTrail {
  const last = trail.entries[trail.entries.length - 1];
  if (last && isSameReaderTarget(last, target)) return trail;
  return { id: trail.id, origin: trail.origin, entries: [...trail.entries, target].slice(-TRAIL_CAP) };
}

export function canGoBack(trail: ReaderTrail): boolean {
  return trail.entries.length > 1;
}

/** One step back; with nowhere to go back to, the trail as it is. */
export function backTrail(trail: ReaderTrail): ReaderTrail {
  return canGoBack(trail) ? { id: trail.id, origin: trail.origin, entries: trail.entries.slice(0, -1) } : trail;
}

/** The place one step back leads to, or null. */
export function backTarget(trail: ReaderTrail): ReaderTarget | null {
  return canGoBack(trail) ? trail.entries[trail.entries.length - 2]! : null;
}

/** What the Back button calls the place it returns to: a commit by its short sha, else the title. */
export function backLabel(target: ReaderTarget): string {
  return target.commit ? target.commit.sha.slice(0, 7) : target.title || target.path;
}
