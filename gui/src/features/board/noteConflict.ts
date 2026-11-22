/**
 * A note save refused because the note changed since the edit started (a workspace moved to its database answers 409
 * with `code: 'rev_conflict'` and the note as it is now). The dialog keeps what was typed and shows the other version.
 */

import { ApiError } from '../../lib/api/client.js';

/** The note as it is now, sent back with a refused save. */
export interface NoteConflictCurrent {
  title: string;
  body?: string;
  pinned?: boolean;
  area?: string;
  step?: string;
  rev: number;
  updatedBy?: string;
  updatedAt?: string;
}

/** Whether a save was refused because the note changed since the edit started (409 `rev_conflict`). */
export function isNoteConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && typeof error.body === 'object' && error.body !== null && (error.body as { code?: unknown }).code === 'rev_conflict';
}

/** The note as it is now, from a refused save, when the answer carries it. */
export function conflictCurrent(error: ApiError): NoteConflictCurrent | null {
  const current = (error.body as { current?: unknown }).current as Partial<NoteConflictCurrent> | null | undefined;
  return current && typeof current.title === 'string' && typeof current.rev === 'number' ? current as NoteConflictCurrent : null;
}

export type NoteField = 'title' | 'body' | 'pinned' | 'area' | 'step';

export interface NoteFormValues {
  title: string;
  body: string;
  pinned: boolean;
  area: string;
  step: string;
}

export interface NoteEditChanges {
  title?: string;
  body?: string;
  pinned?: boolean;
  area?: string | null;
  step?: string | null;
  rev?: number;
}

/**
 * Picks which fields an edit save should send.
 * - Normal save (`resolving` absent): fields whose current value differs from what the dialog started with (`initial`).
 * - Conflict overwrite ("Save yours over theirs", `resolving` present): only fields the person touched (`touched`)
 *   whose current value differs from their version (`resolving`), never touching fields the person left alone.
 * Returns `null` when nothing differs.
 */
export function pickNoteEditChanges(options: {
  current: NoteFormValues;
  initial: NoteFormValues;
  touched: ReadonlySet<NoteField>;
  rev?: number;
  resolving?: NoteConflictCurrent | null;
}): NoteEditChanges | null {
  const { current, initial, touched, rev, resolving } = options;
  const cleanTitle = current.title.trim();
  const cleanBody = current.body.slice(0, 4000);
  const changes: NoteEditChanges = { ...(rev !== undefined ? { rev } : {}) };

  if (resolving) {
    if (touched.has('title') && cleanTitle !== resolving.title.trim()) changes.title = cleanTitle;
    if (touched.has('body') && cleanBody !== (resolving.body ?? '')) changes.body = cleanBody;
    if (touched.has('pinned') && current.pinned !== Boolean(resolving.pinned)) changes.pinned = current.pinned;
    if (touched.has('area') && current.area !== (resolving.area ?? '')) changes.area = current.area || null;
    if (touched.has('step') && current.step !== (resolving.step ?? '')) changes.step = current.step || null;
  } else {
    if (cleanTitle !== initial.title.trim()) changes.title = cleanTitle;
    if (cleanBody !== initial.body) changes.body = cleanBody;
    if (current.pinned !== initial.pinned) changes.pinned = current.pinned;
    if (current.area !== initial.area) changes.area = current.area || null;
    if (current.step !== initial.step) changes.step = current.step || null;
  }

  const hasChange = changes.title !== undefined
    || changes.body !== undefined
    || changes.pinned !== undefined
    || changes.area !== undefined
    || changes.step !== undefined;
  return hasChange ? changes : null;
}
