/**
 * @module core/workspace-db/import-record
 * The move's import record as the database keeps it (`meta.import_record`, JSON). `ctxspace plan migrate` writes it into
 * the staged database before that database is put in place, and marks it `done` once the move has finished. A
 * database whose record is missing or not `done` is never used for the app (DB3b checks it).
 */

import { beginImmediate, commitTransaction, getMeta, setMeta, type WorkspaceDb } from './connection.js';

export interface DbImportRecord {
  version: 1;
  /** The move's id: the same in the database, in `.contextspace/state.json`, in the switch file and in the archive's manifest. */
  id: string;
  status: 'moving' | 'done';
  [field: string]: unknown;
}

/** The record, or null when the database has none (or one that cannot be read). */
export function readImportRecord(db: WorkspaceDb): DbImportRecord | null {
  const raw = getMeta(db.sqlite, 'import_record');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DbImportRecord>;
    return parsed && typeof parsed.id === 'string' && (parsed.status === 'moving' || parsed.status === 'done') ? parsed as DbImportRecord : null;
  } catch {
    return null;
  }
}

/** Writes the record in its own short transaction. It is not a change to the plan: the revision and history stay as they are. */
export async function writeImportRecord(db: WorkspaceDb, record: DbImportRecord): Promise<void> {
  await beginImmediate(db);
  try {
    setMeta(db.sqlite, 'import_record', JSON.stringify(record));
    await commitTransaction(db);
  } catch (error) {
    try { db.sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
    throw error;
  }
}
