/**
 * Which groups of the Board are open and which are folded. A group is a checkpoint frame, the plan's own frame, the
 * documents column or a repository's commit lane. The board opens with the group the work is on open and the rest
 * folded, so it reads as the big picture first; the user opens what they want the details of. What they open or fold
 * is remembered for them, in this browser and for this workspace, as the difference from that default: so when the work
 * moves on, the checkpoint it moves to opens by itself, unless they folded it. Pure, apart from the storage.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** The groups the user opened (`true`) or folded (`false`) against the default, by group id. */
export type Folds = Readonly<Record<string, boolean>>;

/** More than this many remembered groups is a board that has changed a lot: the oldest are forgotten. */
export const FOLDS_LIMIT = 200;

export const foldsKey = (workspace: string) => `contextspace_board_folds_v1:${workspace}`;

/** Whether a group is open: what the user chose, else only the group the work is on (`current`). */
export function groupOpen(id: string, current: string | undefined, folds: Folds | undefined): boolean {
  return folds !== undefined && Object.hasOwn(folds, id) ? folds[id]! : id === current;
}

/** The choices with one group opened or folded. A choice that is the default is not kept: only what the user changed is. */
export function withFold(folds: Folds, id: string, open: boolean, current: string | undefined): Folds {
  const next: Record<string, boolean> = { ...folds };
  delete next[id];
  if (open !== (id === current)) next[id] = open;
  const ids = Object.keys(next);
  for (const old of ids.slice(0, Math.max(0, ids.length - FOLDS_LIMIT))) delete next[old];
  return next;
}

/** The choices from what storage held: only ids with a plain `true` or `false`, up to the limit. Anything else is dropped. */
export function cleanFolds(raw: unknown): Folds {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const folds: Record<string, boolean> = {};
  for (const [id, open] of Object.entries(raw)) {
    if (typeof open === 'boolean' && id.length <= 400 && Object.keys(folds).length < FOLDS_LIMIT) folds[id] = open;
  }
  return folds;
}

/** What this browser remembers for the workspace. Storage can be unavailable or hold anything: then the defaults apply. */
export function readFolds(workspace: string): Folds {
  try {
    const raw = window.localStorage.getItem(foldsKey(workspace));
    return raw ? cleanFolds(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function writeFolds(workspace: string, folds: Folds): void {
  try {
    if (Object.keys(folds).length === 0) window.localStorage.removeItem(foldsKey(workspace));
    else window.localStorage.setItem(foldsKey(workspace), JSON.stringify(folds));
  } catch { /* The choice holds for this visit only. */ }
}

/**
 * The user's choices for a workspace, and the way to change one. A change is kept in storage at once. `current` is the
 * group the work is on, which opens by default.
 */
export function useBoardFolds(workspace: string): [Folds, (id: string, open: boolean, current: string | undefined) => void] {
  const [held, setHeld] = useState(() => ({ workspace, folds: readFolds(workspace) }));
  let folds = held.folds;
  if (held.workspace !== workspace) {
    folds = readFolds(workspace);
    setHeld({ workspace, folds });
  }
  // A second change in the same moment starts from the first.
  const latest = useRef(folds);
  useEffect(() => { latest.current = folds; });
  const set = useCallback((id: string, open: boolean, current: string | undefined) => {
    const next = withFold(latest.current, id, open, current);
    latest.current = next;
    setHeld({ workspace, folds: next });
    writeFolds(workspace, next);
  }, [workspace]);
  return [folds, set];
}
