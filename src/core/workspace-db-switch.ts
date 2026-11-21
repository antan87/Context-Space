/**
 * @module core/workspace-db-switch
 * The per-workspace switch that says a workspace was moved to its workspace database (`ctxspace plan migrate`).
 *
 * It is one small file, `.contextspace/workspace-db-switch.json`, absent by default. While it is there, every writer of
 * the old files (PLAN.md through the plan store, the Board file, Now, the seen files, the plan checks in state.json)
 * refuses and says why, because until the app reads the database (DB3b) a write to an old file would be lost or would
 * split the workspace in two. Its states:
 * - `moving`: a move started and has not finished (or was interrupted). `ctxspace plan migrate` finishes or undoes it.
 * - `on`: the move finished.
 * - `restoring`: `ctxspace plan restore` started and has not finished. Running it again finishes it.
 *
 * Checking is one `lstat` and, only when the file exists, one small read, so writers check it under their own lock,
 * right before they write. A switch file that cannot be read still counts as on: the guard fails closed.
 *
 * Its presence in a backend's code (`dist/core/workspace-db-switch.js`) is also how `plan migrate` tells a ContextSpace
 * that knows the database from an older one that would keep writing the old files.
 */

import { lstatSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/** Where the switch lives, relative to the workspace root (always with `/`). */
export const SWITCH_FILE = '.contextspace/workspace-db-switch.json';

export type SwitchState = 'moving' | 'on' | 'restoring';

export interface SwitchRecord {
  state: SwitchState | 'unreadable';
  /** The archive folder of the move, relative to the workspace, with `/`. */
  archive?: string;
  /** The move's import record id. */
  id?: string;
  at?: string;
  by?: string;
  /** Set on `restoring` when the move it undoes had finished: then every moved file must be in the archive. */
  finished?: boolean;
}

export const switchPath = (root: string): string => path.join(root, ...SWITCH_FILE.split('/'));

/** The switch, or null when it is off (no file). A file that is there but cannot be read is `unreadable`, which counts as on. */
export function readSwitch(root: string): SwitchRecord | null {
  const file = switchPath(root);
  try {
    lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { state: 'unreadable' };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SwitchRecord>;
    if (parsed && (parsed.state === 'moving' || parsed.state === 'on' || parsed.state === 'restoring')) {
      return {
        state: parsed.state,
        ...(typeof parsed.archive === 'string' ? { archive: parsed.archive } : {}),
        ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}),
        ...(typeof parsed.at === 'string' ? { at: parsed.at } : {}),
        ...(typeof parsed.by === 'string' ? { by: parsed.by } : {}),
        ...(parsed.finished === true ? { finished: true } : {}),
      };
    }
  } catch { /* unreadable: counts as on */ }
  return { state: 'unreadable' };
}

/** The sentence every refused writer says. */
export function movedMessage(record: SwitchRecord): string {
  const archive = record.archive ?? '<archive>';
  switch (record.state) {
    case 'on':
      return `This workspace was moved to the workspace database. Undo it with \`ctxspace plan restore ${archive}\`.`;
    case 'moving':
      return `This workspace is being moved to the workspace database, or a move was interrupted. Nothing was written. Finish it with \`ctxspace plan migrate\`, or undo it with \`ctxspace plan restore ${archive}\`.`;
    case 'restoring':
      return `This workspace is being restored from the workspace database, or a restore was interrupted. Nothing was written. Finish it with \`ctxspace plan restore ${archive}\`.`;
    default:
      return `This workspace was moved to the workspace database (${SWITCH_FILE} is there but cannot be read). Nothing was written. See \`ctxspace plan migrate --status\`.`;
  }
}

/** Raised by an old writer when the switch is on. `record` says which state and archive. */
export class WorkspaceMovedError extends Error {
  readonly code = 'moved';
  constructor(readonly record: SwitchRecord) {
    super(movedMessage(record));
    this.name = 'WorkspaceMovedError';
  }
}

/** Throws {@link WorkspaceMovedError} when the switch is on (in any state). Call it under the writer's own lock, right before writing. */
export function assertNotMoved(root: string): void {
  const record = readSwitch(root);
  if (record) throw new WorkspaceMovedError(record);
}

/** True when the switch file is there, in any state. */
export const isMoved = (root: string): boolean => readSwitch(root) !== null;
