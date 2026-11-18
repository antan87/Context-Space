/**
 * @module core/workspace-db/errors
 * The ways the database itself can fail. They are typed so a caller can tell "busy, try again" from "this file is not
 * usable" without reading words. Refused changes are not exceptions: `applyBatch` returns them as issues.
 */

export type WorkspaceDbErrorCode =
  /** The file is not a SQLite database, or fails its integrity check. Nothing was changed. */
  | 'corrupt'
  /** The file was written by a newer ContextSpace. It is left untouched. */
  | 'too_new'
  /** Another process holds the write lock; retried for the allowed time and gave up. */
  | 'busy'
  /** The file at the path is no longer the one this connection opened (a restore replaced it). Open it again. */
  | 'replaced'
  /** A write was tried on a read-only connection. */
  | 'read_only'
  /** There is no database in this workspace. */
  | 'missing'
  /** The file is a database, but not a ContextSpace workspace database (other tables, no marker, a different schema). Not touched. */
  | 'foreign'
  /** The database could not be opened or migrated for another reason. */
  | 'open_failed'
  /** The call itself was wrong (bad arguments). */
  | 'invalid'
  /** A restore or backup could not be made. */
  | 'backup_failed'
  /** The query was refused or stopped. */
  | 'query_refused'
  | 'query_timeout';

export class WorkspaceDbError extends Error {
  readonly code: WorkspaceDbErrorCode;
  constructor(code: WorkspaceDbErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkspaceDbError';
    this.code = code;
  }
}

/** SQLite said the database is locked or busy. */
export function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { errcode?: number; code?: string };
  return e.errcode === 5 || e.errcode === 6 || /database (table )?is locked|SQLITE_BUSY/i.test(e.message);
}

/** SQLite said the file is not a database (or is damaged). */
export function isCorruptError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { errcode?: number };
  return e.errcode === 26 || e.errcode === 11 || /file is not a database|malformed|disk image/i.test(e.message);
}
