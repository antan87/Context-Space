/**
 * @module core/workspace-db/backup
 * Daily backups and restore (v5 point 7).
 *
 * `maybeBackup` makes at most one backup per local day. The first process to create the day's claim file does the
 * work, in a CHILD process (`VACUUM INTO` a temp file, then `PRAGMA integrity_check` on it), so the caller's event loop
 * never waits on SQLite; then the temp file is promoted to `workspace-YYYY-MM-DD.db` by an atomic rename, and nothing
 * else ever writes under that name, so an interruption cannot leave a partial file there. Seven backups are kept. A temp
 * file is never a backup: only names that match the dated pattern count, and a stale temp or claim file is cleaned up.
 *
 * `restoreBackup` brings a backup back as a new generation: `db_id` changes (so every holder of an old revision is
 * refused with `db_changed`), the ids this database ever issued are carried over (so none is reused), and the file it
 * replaces is kept next to it, never deleted. The live file's write lock is held from the id scan until the new file
 * is in place; the new file is promoted by an atomic rename, after the old one has been linked aside, so at every
 * moment the live path holds either the old or the new file. A live file that is damaged does not stop a restore.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, constants, existsSync, linkSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dbFilePath, getMeta, setMeta, readRevision, SCHEMA_VERSION, validateWorkspaceSchema } from './connection.js';
import { WorkspaceDbError, isBusyError } from './errors.js';

export const BACKUPS_KEPT = 7;
const BACKUP_NAME = /^workspace-\d{4}-\d{2}-\d{2}\.db$/;
/** A claim or temp file older than this is the leftover of a process that died. */
const STALE_MS = 10 * 60_000;

export const backupsDir = (workspacePath: string): string => path.join(workspacePath, '.contextspace', 'backups');

/** The local calendar day, as YYYY-MM-DD. */
export function localDay(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function listBackups(workspacePath: string): string[] {
  const dir = backupsDir(workspacePath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => BACKUP_NAME.test(name)).sort().reverse();
}

export interface BackupResult {
  status: 'made' | 'exists' | 'claimed' | 'no_database';
  file?: string;
}

function removeStale(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('.')) continue;
    const full = path.join(dir, name);
    try {
      if (Date.now() - statSync(full).mtimeMs > STALE_MS) unlinkSync(full);
    } catch { /* gone already */ }
  }
}

// The child's program, as plain JavaScript in a string (nothing to locate in src, dist or the packaged app).
const COPY_CHILD = `
const { DatabaseSync } = require('node:sqlite');
const [source, temp] = process.argv.slice(1);
try {
  const reader = new DatabaseSync(source, { readOnly: true });
  reader.exec('PRAGMA busy_timeout = 5000');
  reader.exec("VACUUM INTO '" + temp.replace(/'/g, "''") + "'");
  reader.close();
  const copy = new DatabaseSync(temp, { readOnly: true });
  const row = copy.prepare('PRAGMA integrity_check').get();
  copy.close();
  if (row.integrity_check !== 'ok') throw new Error('integrity_check: ' + row.integrity_check);
  process.stdout.write('ok');
} catch (e) { process.stdout.write('error: ' + String(e && e.message || e)); process.exit(1); }
`;

/** Copies and checks the database in a child process; resolves when the copy is whole. */
function copyInChild(source: string, temp: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', COPY_CHILD, '--', source, temp], {
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { out += c; });
    child.on('error', (e) => reject(new WorkspaceDbError('backup_failed', `Could not start the backup: ${e.message}`, { cause: e })));
    child.on('close', (code) => {
      if (code === 0 && out === 'ok') resolve();
      else reject(new WorkspaceDbError('backup_failed', `The backup copy failed: ${out || `exit ${String(code)}`}`));
    });
  });
}

/** Makes today's backup unless it exists. Safe to call from any number of processes at once; never blocks the event loop. */
export async function maybeBackup(workspacePath: string, options: { now?: Date; hooks?: { afterClaim?: () => void; beforePublish?: () => void } } = {}): Promise<BackupResult> {
  const source = dbFilePath(workspacePath);
  if (!existsSync(source)) return { status: 'no_database' };
  const dir = backupsDir(workspacePath);
  mkdirSync(dir, { recursive: true });
  const day = localDay(options.now);
  const finalName = `workspace-${day}.db`;
  const finalPath = path.join(dir, finalName);
  if (existsSync(finalPath)) return { status: 'exists', file: finalName };
  removeStale(dir);
  // claim the day: only the process that creates the claim file makes the backup
  const claim = path.join(dir, `.claim-${day}`);
  try {
    closeSync(openSync(claim, 'wx'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'claimed' };
    throw error;
  }
  const temp = path.join(dir, `.tmp-${day}-${process.pid}-${randomBytes(4).toString('hex')}.db`);
  try {
    options.hooks?.afterClaim?.();
    // another process may have finished the whole backup between our first look and our claim
    if (existsSync(finalPath)) return { status: 'exists', file: finalName };
    await copyInChild(source, temp);
    options.hooks?.beforePublish?.();
    // Publish without replacing: link() fails when the daily file exists, so a file that is there is never overwritten.
    // (A file system without hard links falls back to a check under the claim, then a rename.)
    try {
      linkSync(temp, finalPath);
      unlinkSync(temp);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') { unlinkSync(temp); return { status: 'exists', file: finalName }; }
      if (existsSync(finalPath)) { unlinkSync(temp); return { status: 'exists', file: finalName }; }
      renameSync(temp, finalPath);
    }
    rotate(dir);
    return { status: 'made', file: finalName };
  } catch (error) {
    try { unlinkSync(temp); } catch { /* never made */ }
    throw error;
  } finally {
    try { unlinkSync(claim); } catch { /* ignore */ }
  }
}

function rotate(dir: string): void {
  const names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort().reverse();
  for (const name of names.slice(BACKUPS_KEPT)) {
    try { unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
  }
}

/** A backup must be a whole database of ours: integrity, version and schema. */
function assertBackup(file: string): void {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (row?.integrity_check !== 'ok') throw new WorkspaceDbError('backup_failed', `The backup ${file} failed its integrity check (${row?.integrity_check ?? 'no answer'}).`);
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > SCHEMA_VERSION) throw new WorkspaceDbError('too_new', `The backup was written by a newer ContextSpace (schema version ${version}).`);
    if (version < 1) throw new WorkspaceDbError('backup_failed', 'That file is not a workspace backup (no schema).');
    validateWorkspaceSchema(db, file);
  } catch (error) {
    if (error instanceof WorkspaceDbError) throw error;
    throw new WorkspaceDbError('backup_failed', `The backup ${file} is not a usable database (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  } finally {
    db?.close();
  }
}

export interface RestoreResult {
  dbId: string;
  revision: number;
  /** Where the database it replaced was kept. */
  keptAs: string | null;
  backup: string;
  idsCarried: number;
  /** Where the id ledger came from: `live` (read from the live file), `partial` (a damaged live file, what could be read) or `backup` (only the backup's own). */
  idsFrom: 'live' | 'partial' | 'backup' | 'none';
}

/** Collects every id a database ever issued, table by table, tolerating a damaged file. Returns what it could read and whether it all was. */
function scanIds(db: DatabaseSync): { ids: Set<string>; complete: boolean } {
  const ids = new Set<string>();
  let complete = true;
  for (const sql of ['SELECT id FROM ids_used', 'SELECT id FROM blocks', 'SELECT id FROM cards', 'SELECT legacy_id AS id FROM cards']) {
    try { for (const r of db.prepare(sql).all() as Array<{ id: string | null }>) if (r.id) ids.add(r.id); } catch { complete = false; }
  }
  return { ids, complete };
}

/**
 * Restores a backup (a file name from {@link listBackups}, or a path) as the workspace database, as a new generation:
 * `db_id` changes and the ids ever issued are carried over so none is reused. The ledger comes from the live file
 * while it can be read; when it is damaged, from whatever of it can still be read plus the backup's own, and when
 * nothing can be read, from the backup alone (ids made after the backup, in a file that cannot be read, may then be
 * issued again: the damaged file is kept so they can be found). The replaced file is kept as `workspace.db.replaced-<time>`,
 * never deleted. Close other connections afterwards: they now point at the old file and get `replaced`.
 */
export function restoreBackup(workspacePath: string, backup: string): RestoreResult {
  // NOT YET SAFE while other connections are open. It holds the live file's write lock only for its own scan and
  // promotion; a writer or opener in another process or connection is not fenced against the replacement, the Windows
  // rename of an open file is not handled, and the whole thing is synchronous. DB3 must fence it (close or refuse all
  // other openers and writers first, then restore) before anything calls it from a running app.
  const live = dbFilePath(workspacePath);
  const source = path.isAbsolute(backup) ? backup : path.join(backupsDir(workspacePath), backup);
  if (!existsSync(source)) throw new WorkspaceDbError('backup_failed', `There is no backup ${source}.`);
  assertBackup(source);
  mkdirSync(path.dirname(live), { recursive: true });
  const temp = path.join(path.dirname(live), `.restore-${process.pid}-${randomBytes(4).toString('hex')}.db`);
  copyFileSync(source, temp);
  const held: { db: DatabaseSync | null } = { db: null };
  const releaseLive = () => { try { held.db?.exec('ROLLBACK'); } catch { /* none open */ } try { held.db?.close(); } catch { /* ignore */ } held.db = null; };
  try {
    const restored = new DatabaseSync(temp);
    let result: Omit<RestoreResult, 'keptAs'>;
    try {
      restored.exec('PRAGMA journal_mode = DELETE');
      restored.exec('PRAGMA synchronous = FULL');
      restored.exec('PRAGMA foreign_keys = ON');
      restored.exec('BEGIN IMMEDIATE');
      let carried = 0;
      let idsFrom: RestoreResult['idsFrom'] = 'none';
      if (existsSync(live)) {
        let ids = new Set<string>();
        try {
          // hold the live file's write lock from here until the new file is in place: nothing is issued in between
          const current = new DatabaseSync(live);
          held.db = current;
          current.exec('PRAGMA busy_timeout = 5000');
          current.exec('BEGIN IMMEDIATE');
          const scan = scanIds(current);
          ids = scan.ids;
          idsFrom = scan.complete ? 'live' : 'partial';
        } catch (error) {
          if (isBusyError(error)) throw error;
          // the live file is damaged (not a database, or unreadable): recover what can be read from it, keep it aside
          releaseLive();
          try {
            const damaged = new DatabaseSync(live, { readOnly: true });
            try { const scan = scanIds(damaged); ids = scan.ids; idsFrom = ids.size ? 'partial' : 'backup'; } finally { damaged.close(); }
          } catch { idsFrom = 'backup'; }
        }
        const insert = restored.prepare('INSERT OR IGNORE INTO ids_used(id) VALUES (?)');
        for (const id of ids) insert.run(id);
        carried = ids.size;
      }
      restored.exec('INSERT OR IGNORE INTO ids_used(id) SELECT id FROM blocks UNION SELECT id FROM cards');
      const dbId = randomBytes(8).toString('hex');
      setMeta(restored, 'db_id', dbId);
      const revision = readRevision(restored) + 1;
      setMeta(restored, 'revision', revision);
      restored.prepare("INSERT INTO changes(revision, kind, at, by, summary, rows) VALUES (?, 'restore', ?, 'user', ?, NULL)").run(revision, new Date().toISOString(), `restored from backup ${path.basename(source)}`);
      restored.exec('COMMIT');
      result = { dbId, revision, backup: path.basename(source), idsCarried: carried, idsFrom };
    } finally {
      try { restored.close(); } catch { /* ignore */ }
    }
    // Promotion. The live path always holds a whole file: the old one is linked (or copied) aside first, then the new
    // one replaces it with one atomic rename. A crash before the rename leaves the old file in place and a copy aside;
    // after it, the new file in place and the old one aside.
    let keptAs: string | null = null;
    if (existsSync(live)) {
      keptAs = `${live}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { linkSync(live, keptAs); } catch { copyFileSync(live, keptAs, constants.COPYFILE_EXCL); }
      const journal = `${live}-journal`;
      if (existsSync(journal)) renameSync(journal, `${keptAs}-journal`); // a leftover journal must never be applied to the new file
    }
    if (process.platform === 'win32') releaseLive(); // Windows cannot replace a file that is open
    renameSync(temp, live);
    releaseLive();
    return { ...result, keptAs };
  } catch (error) {
    releaseLive();
    try { unlinkSync(temp); } catch { /* moved or never made */ }
    if (isBusyError(error)) throw new WorkspaceDbError('busy', 'The workspace database is busy: another process is writing. Try the restore again in a moment.', { cause: error });
    throw error;
  }
}
