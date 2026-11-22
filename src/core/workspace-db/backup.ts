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
/** The live file's db_id and the ones it replaced, as far as they can be read. */
function formerOf(db: DatabaseSync): string[] {
  try {
    const own = getMeta(db, 'db_id');
    const parsed: unknown = JSON.parse(getMeta(db, 'former_db_ids') ?? '[]');
    return [...(own ? [own] : []), ...(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])];
  } catch {
    return [];
  }
}

function scanIds(db: DatabaseSync): { ids: Set<string>; complete: boolean } {
  const ids = new Set<string>();
  let complete = true;
  for (const sql of ['SELECT id FROM ids_used', 'SELECT id FROM blocks', 'SELECT id FROM cards', 'SELECT legacy_id AS id FROM cards']) {
    try { for (const r of db.prepare(sql).all() as Array<{ id: string | null }>) if (r.id) ids.add(r.id); } catch { complete = false; }
  }
  return { ids, complete };
}

/**
 * Windows promotion. A hard link to an open file cannot be removed again there, so nothing is linked: the live file is
 * RENAMED aside, which Windows refuses cleanly while any other connection has it open (nothing is changed then). Only
 * after that succeeds is the journal moved and the new file renamed into place. If a later step fails, the old file
 * and its journal are renamed back before the error is thrown; if that recovery fails too, the error says exactly
 * where each file is (never "nothing was changed"). The database file and its journal stay together under the live
 * name until recovery succeeds.
 * Remaining crash window: between renaming the live file aside and renaming the new one in, the live path is missing
 * while both whole files exist (`workspace.db.replaced-<time>` and the new `.restore-*` temp). Opening then reports
 * `missing`. Handling "live missing but a .replaced exists" belongs to DB3.
 */
function replaceOnWindows(live: string, temp: string): string | null {
  if (!existsSync(live)) { renameSync(temp, live); return null; }
  const journal = `${live}-journal`;
  // A name nothing uses (rename overwrites on some platforms): timestamp plus a random part, checked right before the rename.
  let keptAs = '';
  for (let attempt = 0; attempt < 5 && !keptAs; attempt += 1) {
    const name = `${live}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
    if (!existsSync(name) && !existsSync(`${name}-journal`)) keptAs = name;
  }
  if (!keptAs) throw new WorkspaceDbError('backup_failed', 'The restore could not find a free name for the replaced database. The backup was not installed and the workspace database was left in place.');
  const keptJournal = `${keptAs}-journal`;
  const inUse = (cause: unknown) => new WorkspaceDbError('file_in_use', 'The backup could not be restored because another connection still has the workspace database open. Close ContextSpace and every other program using this workspace, then restore again. The backup was not installed and the workspace database was left in place (SQLite may have finished an interrupted write while the restore checked it).', { cause });
  try {
    renameSync(live, keptAs); // the probe: refused while another handle holds the file
  } catch (error) {
    if (isFileInUse(error)) throw inUse(error);
    throw error; // nothing was moved
  }
  let journalMoved = false;
  try {
    if (existsSync(journal)) { renameSync(journal, keptJournal); journalMoved = true; } // a leftover journal must never be applied to the new file
    renameSync(temp, live);
    return keptAs;
  } catch (error) {
    // Recovery: the journal first, then the database, so the database is never openable without the journal it may need.
    // If the journal cannot go back, the database is not moved back either: both stay under their kept names.
    const fail = (where: string) => new WorkspaceDbError('backup_failed', `The restore failed (${(error as Error).message}) and the old database could not be put back: ${where}. Nothing was deleted. Close every program using this workspace, then put the database back at ${live} with its journal (if it has one) at ${journal}.`, { cause: error });
    if (journalMoved) {
      try {
        if (existsSync(journal)) throw new Error('a new journal appeared at the live path');
        renameSync(keptJournal, journal);
      } catch { throw fail(`the old database is at ${keptAs} and its journal is at ${keptJournal}`); }
    }
    try {
      renameSync(keptAs, live);
    } catch {
      let journalAt: string | null = existsSync(journal) ? journal : null; // a journal that was never moved aside is still at the live path
      if (journalMoved) { journalAt = keptJournal; try { renameSync(journal, keptJournal); } catch { journalAt = journal; } } // keep the pair together again
      throw fail(`the old database is at ${keptAs}${journalAt ? ` and its journal is at ${journalAt}` : ''}`);
    }
    if (isFileInUse(error)) throw inUse(error);
    throw error;
  }
}

/** Windows says an open file cannot be replaced with EPERM, EBUSY or EACCES. */
function isFileInUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
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
  return restoreCore(workspacePath, backup, null, 5000);
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * {@link restoreBackup} for a running server: the live file's write lock, which another process may hold for a while, is
 * won between timers (for up to `waitMs`, 5 s by default), so the event loop keeps answering while the restore waits.
 * Only the short work after that (copying the backup in, the id scan, the rename) runs on the loop. The caller fences
 * its own connections first (core/workspace-db-app `restoreBackupForApp`).
 */
export async function restoreBackupAsync(workspacePath: string, backup: string, options: { waitMs?: number } = {}): Promise<RestoreResult> {
  const live = dbFilePath(workspacePath);
  const waitMs = options.waitMs ?? 5000;
  let held: DatabaseSync | null = null;
  if (existsSync(live)) {
    let current: DatabaseSync | null = null;
    try {
      current = new DatabaseSync(live);
      current.exec('PRAGMA busy_timeout = 0');
    } catch {
      try { current?.close(); } catch { /* ignore */ }
      current = null; // a damaged file: the restore itself finds out, and keeps it aside
    }
    const started = Date.now();
    let pause = 5;
    while (current) {
      try {
        current.exec('BEGIN IMMEDIATE');
        held = current;
        break;
      } catch (error) {
        if (!isBusyError(error)) { try { current.close(); } catch { /* ignore */ } current = null; break; }
        if (Date.now() - started >= waitMs) {
          try { current.close(); } catch { /* ignore */ }
          throw new WorkspaceDbError('busy', 'Busy, try again in a moment: another process is writing to the workspace database, so the backup was not restored. Nothing was changed.', { cause: error });
        }
        await sleep(pause);
        pause = Math.min(pause * 2, 200);
      }
    }
  }
  return restoreCore(workspacePath, backup, held, 0);
}

/** `pre`: the live file's connection with its write lock already won (or null to take it here, waiting up to `busyMs`). */
function restoreCore(workspacePath: string, backup: string, pre: DatabaseSync | null, busyMs: number): RestoreResult {
  // Not fenced on its own: it holds the live file's write lock only for its own scan and promotion, waits for it inside
  // SQLite (up to 5 s), and the Windows rename of an open file is refused with `file_in_use` (nothing changed). A running
  // app calls core/workspace-db-app `restoreBackupForApp`, which fences it (the workspace locks, its own connections
  // closed and held back, every other connection told `replaced`) and waits between timers (`restoreBackupAsync`).
  const live = dbFilePath(workspacePath);
  const held: { db: DatabaseSync | null } = { db: pre };
  const releaseLive = () => { try { held.db?.exec('ROLLBACK'); } catch { /* none open */ } try { held.db?.close(); } catch { /* ignore */ } held.db = null; };
  const source = path.isAbsolute(backup) ? backup : path.join(backupsDir(workspacePath), backup);
  let temp: string;
  try {
    if (!existsSync(source)) throw new WorkspaceDbError('backup_failed', `There is no backup ${source}.`);
    assertBackup(source);
    // A journal at the live path with no database beside it belongs to a database that is not there (a failed recovery
    // left it). Installing a backup next to it could apply it to the wrong file: refuse before anything moves.
    if (!existsSync(live) && existsSync(`${live}-journal`)) {
      throw new WorkspaceDbError('backup_failed', `There is a journal at ${live}-journal but no database at ${live}. Move that journal away, or recover the old database it belongs to, before restoring. Nothing was changed.`);
    }
    mkdirSync(path.dirname(live), { recursive: true });
    temp = path.join(path.dirname(live), `.restore-${process.pid}-${randomBytes(4).toString('hex')}.db`);
    copyFileSync(source, temp);
  } catch (error) {
    releaseLive();
    throw error;
  }
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
      let former: string[] = [];
      if (existsSync(live)) {
        let ids = new Set<string>();
        try {
          // hold the live file's write lock from here until the new file is in place: nothing is issued in between
          let current = held.db;
          if (!current) {
            current = new DatabaseSync(live);
            held.db = current;
            current.exec(`PRAGMA busy_timeout = ${busyMs}`);
            current.exec('BEGIN IMMEDIATE');
          }
          const scan = scanIds(current);
          ids = scan.ids;
          idsFrom = scan.complete ? 'live' : 'partial';
          former = formerOf(current);
        } catch (error) {
          if (isBusyError(error)) throw error;
          // the live file is damaged (not a database, or unreadable): recover what can be read from it, keep it aside
          releaseLive();
          try {
            const damaged = new DatabaseSync(live, { readOnly: true });
            try { const scan = scanIds(damaged); ids = scan.ids; idsFrom = ids.size ? 'partial' : 'backup'; former = formerOf(damaged); } finally { damaged.close(); }
          } catch { idsFrom = 'backup'; }
        }
        const insert = restored.prepare('INSERT OR IGNORE INTO ids_used(id) VALUES (?)');
        for (const id of ids) insert.run(id);
        carried = ids.size;
      }
      restored.exec('INSERT OR IGNORE INTO ids_used(id) SELECT id FROM blocks UNION SELECT id FROM cards');
      const dbId = randomBytes(8).toString('hex');
      // the generations this file replaces: the exports they wrote are ours, and are written again from the new one
      const generations = [...new Set([...former, getMeta(restored, 'db_id'), ...formerOf(restored)].filter((id): id is string => typeof id === 'string' && id !== '' && id !== dbId))].slice(0, 50);
      setMeta(restored, 'former_db_ids', JSON.stringify(generations));
      setMeta(restored, 'db_id', dbId);
      const revision = readRevision(restored) + 1;
      setMeta(restored, 'revision', revision);
      restored.prepare("INSERT INTO changes(revision, kind, at, by, summary, rows) VALUES (?, 'restore', ?, 'user', ?, NULL)").run(revision, new Date().toISOString(), `restored from backup ${path.basename(source)}`);
      restored.exec('COMMIT');
      result = { dbId, revision, backup: path.basename(source), idsCarried: carried, idsFrom };
    } finally {
      try { restored.close(); } catch { /* ignore */ }
    }
    // Promotion. On POSIX the live path always holds a whole file: the old one is linked (or copied) aside first, then
    // the new one replaces it with one atomic rename. A crash before the rename leaves the old file in place and a copy
    // aside; after it, the new file in place and the old one aside.
    let keptAs: string | null = null;
    if (process.platform === 'win32') {
      releaseLive(); // Windows cannot replace a file that is open
      keptAs = replaceOnWindows(live, temp);
    } else {
      if (existsSync(live)) {
        keptAs = `${live}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try { linkSync(live, keptAs); } catch { copyFileSync(live, keptAs, constants.COPYFILE_EXCL); }
        const journal = `${live}-journal`;
        if (existsSync(journal)) renameSync(journal, `${keptAs}-journal`); // a leftover journal must never be applied to the new file
      }
      renameSync(temp, live);
      releaseLive();
    }
    return { ...result, keptAs };
  } catch (error) {
    releaseLive();
    try { unlinkSync(temp); } catch { /* moved or never made */ }
    if (isBusyError(error)) throw new WorkspaceDbError('busy', 'The workspace database is busy: another process is writing. Try the restore again in a moment.', { cause: error });
    throw error;
  }
}
