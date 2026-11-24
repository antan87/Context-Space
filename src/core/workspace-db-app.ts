/**
 * @module core/workspace-db-app
 * How the running app (the HTTP server) reaches a workspace that was moved to its database (`ctxspace plan migrate`).
 *
 * - {@link storeOf} says which store a workspace uses: its files (the switch is off: everything behaves as before) or its
 *   database (the switch is `on`). A move or restore in progress, or a switch that cannot be read, refuses with the
 *   switch's own sentence, as every old writer does.
 * - One server-mode connection per workspace is kept and opened again when the file under it was replaced (a restored
 *   backup, a restore of the move): `isCurrent()` is checked before every use, and a write that met a replacement wrote
 *   nothing, so it is tried once more on the new file.
 * - {@link readAppDb}: every read runs in one read transaction on the separate read-only connection (`withSnapshot`),
 *   inside `readWithRetry`, so a read that meets another process's commit asks again between timers and ends, at most
 *   2 s later, in a `busy` the person sees as "Busy, try again".
 * - {@link writeAppDb}: every write holds `.contextspace/plan-file.lock`, which also fences `plan migrate` and
 *   `plan restore`. The switch is checked again under the lock.
 *   Compiled runtime writes run in a worker (see workspace-db-write), including SQLite's Windows file waits.
 * - {@link restoreBackupForApp}: a backup restore fenced across this process's connections (closed, and new ones held
 *   back until it is done) and every other opener (they check `isCurrent()` before each use and get `replaced`), under
 *   the move's workspace locks, with the live file's lock won between timers.
 */

import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { acquireLock } from './locks.js';
import {
  SERVER_BUSY_MS, WorkspaceDbError, openWorkspaceDbAsync, readDbId, readWithRetry, restoreBackupAsync, withSnapshot,
  type RestoreResult, type WorkspaceDb,
} from './workspace-db/index.js';
import { WorkspaceMovedError, readSwitch } from './workspace-db-switch.js';

/** What a person is told when the database stays busy past the bounded wait. */
export const BUSY_MESSAGE = 'Busy, try again in a moment: another process is using the workspace database.';

/**
 * Which store the app uses for this workspace. `files`: the switch is off. `database`: the move finished (`on`). Any
 * other switch state (`moving`, `restoring`, unreadable) throws {@link WorkspaceMovedError}, which the routes answer with 409.
 */
export function storeOf(root: string): 'files' | 'database' {
  const record = readSwitch(root);
  if (!record) return 'files';
  if (record.state === 'on') return 'database';
  throw new WorkspaceMovedError(record);
}

interface Held {
  db: WorkspaceDb | null;
  opening: Promise<WorkspaceDb> | null;
  /** In-flight retirements whose handles or background backup jobs are still finishing. */
  retiring: Set<Promise<void>>;
  /** Set while a backup restore runs: nothing opens or uses a connection until it is settled. */
  gate: Promise<void> | null;
}

const held = new Map<string, Held>();
const writeTails = new Map<string, Promise<unknown>>();

/** One entry per workspace folder, however the path was spelled (a link, a trailing part). */
function keyOf(root: string): string {
  try { return realpathSync.native(root); } catch { return path.resolve(root); }
}

function entryOf(root: string): Held {
  const key = keyOf(root);
  let entry = held.get(key);
  if (!entry) held.set(key, entry = { db: null, opening: null, retiring: new Set(), gate: null });
  return entry;
}

async function retire(db: WorkspaceDb): Promise<void> {
  // let a transaction that is retrying between timers end first: closing under it would lose its answer
  await db.serialize(async () => undefined).catch(() => undefined);
  await db.idle().catch(() => undefined);
  db.close();
}

function retireIn(entry: Held, db: WorkspaceDb): Promise<void> {
  const job = retire(db).finally(() => { entry.retiring.delete(job); });
  entry.retiring.add(job);
  return job;
}

async function drainRetiring(entry: Held): Promise<void> {
  while (entry.retiring.size > 0) await Promise.allSettled([...entry.retiring]);
}

const isIdle = (entry: Held) => !entry.gate && !entry.db && !entry.opening && entry.retiring.size === 0;

/** The workspace's server connection, opened again when the file under it was replaced or removed. */
async function connection(root: string): Promise<WorkspaceDb> {
  for (;;) {
    const entry = entryOf(root);
    while (entry.gate) await entry.gate;
    if (held.get(keyOf(root)) !== entry) continue;
    if (entry.db && !entry.db.isCurrent()) {
      const old = entry.db;
      entry.db = null;
      await retireIn(entry, old);
      continue;
    }
    if (entry.db) return entry.db;
    if (entry.opening) {
      const db = await entry.opening;
      if (entry.gate || !db.isCurrent() || entry.db !== db) continue;
      return db;
    }
    const opening = openWorkspaceDbAsync(root, { busy: 'server' }).then((db) => {
      if (entry.opening === opening && !entry.gate && held.get(keyOf(root)) === entry) {
        entry.db = db;
      } else {
        void retireIn(entry, db);
      }
      return db;
    }).finally(() => { if (entry.opening === opening) entry.opening = null; });
    entry.opening = opening;
    const db = await opening;
    if (entry.gate || !db.isCurrent() || entry.db !== db) continue;
    return db;
  }
}

const isReplaced = (error: unknown) => error instanceof WorkspaceDbError && error.code === 'replaced';

/**
 * Reads the database in one committed moment. `busy` after the bounded wait becomes {@link BUSY_MESSAGE}. A read that
 * met a replaced file (or a handle closed for a backup restore) waits for any restore and runs on the new file.
 */
export async function readAppDb<T>(root: string, read: (view: WorkspaceDb) => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (storeOf(root) !== 'database') throw restoredMove();
      const db = await connection(root);
      if (storeOf(root) !== 'database') throw restoredMove();
      return await readWithRetry(db, () => {
        if (storeOf(root) !== 'database') throw restoredMove();
        return withSnapshot(db, read);
      });
    } catch (error) {
      if (isReplaced(error) && attempt < 2) continue;
      throw busyWords(error);
    }
  }
}

/**
 * Runs a write: under the plan lock (which a restore of the move takes first), with the switch checked again under it,
 * on the current connection. `retry` (default true) tries once more when the file was replaced before anything was
 * written; a write with outside effects (a check that ran) passes false.
 */
export async function writeAppDb<T>(root: string, write: (db: WorkspaceDb) => Promise<T>, options: { retry?: boolean } = {}): Promise<T> {
  return withAppDbWriteLock(root, async () => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await write(await connection(root)); }
      catch (error) {
        if (isReplaced(error) && attempt === 0 && options.retry !== false) continue;
        throw error;
      }
    }
  });
}

const restoredMove = () => new WorkspaceDbError('replaced', 'This workspace is no longer in its database (it was restored). Read it again.');

export async function withAppDbWriteLock<T>(root: string, write: () => Promise<T>): Promise<T> {
  const key = keyOf(root);
  const previous = writeTails.get(key) ?? Promise.resolve();
  const deadline = performance.now() + SERVER_BUSY_MS;
  let timer: ReturnType<typeof setTimeout>;
  const queueTimeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WorkspaceDbError('busy', BUSY_MESSAGE)), SERVER_BUSY_MS);
  });
  // Time out while waiting in the queue, and keep expired entries in order until they can be skipped.
  const pending = previous.catch(() => undefined).then(() => {
    clearTimeout(timer);
    return lockedWrite(root, write, deadline);
  }).finally(() => {
    if (writeTails.get(key) === pending) writeTails.delete(key);
  });
  writeTails.set(key, pending);
  return Promise.race([pending, queueTimeout]);
}

async function lockedWrite<T>(root: string, write: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new WorkspaceDbError('busy', BUSY_MESSAGE);
  if (storeOf(root) !== 'database') throw restoredMove();
  const release = await acquireLock(path.join(root, '.contextspace', 'plan-file.lock'), {
    staleMs: 60_000, timeoutMs: remaining, timeoutMessage: BUSY_MESSAGE,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === BUSY_MESSAGE) throw new WorkspaceDbError('busy', BUSY_MESSAGE);
    throw error;
  });
  try {
    if (performance.now() >= deadline) throw new WorkspaceDbError('busy', BUSY_MESSAGE);
    if (storeOf(root) !== 'database') throw restoredMove();
    return await write();
  } catch (error) {
    throw busyWords(error);
  } finally {
    await release();
  }
}

function busyWords(error: unknown): unknown {
  if (error instanceof WorkspaceDbError && error.code === 'busy') return new WorkspaceDbError('busy', BUSY_MESSAGE, { cause: error });
  return error;
}

/** Closes this process's connection to a workspace (tests, and a restore). */
export async function closeAppDb(root?: string): Promise<void> {
  const entries = root ? [[keyOf(root), held.get(keyOf(root))] as const] : [...held.entries()];
  for (const [key, entry] of entries) {
    if (!entry) continue;
    if (entry.opening) await entry.opening.catch(() => undefined);
    const db = entry.db;
    entry.db = null;
    if (db) await retireIn(entry, db);
    await drainRetiring(entry);
    if (isIdle(entry) && held.get(key) === entry) held.delete(key);
  }
}

/**
 * Restores a daily backup as the workspace database while the app runs. Fenced: under the move's workspace locks (so no
 * old writer, `plan migrate` or `plan restore` runs meanwhile), with this process's connection to it closed and new ones
 * held back until it is settled; other processes' connections check the file before each use and get `replaced`.
 * The live file's write lock is won between timers, so the event loop keeps answering. The replaced file is kept in
 * `.contextspace/archive/replaced/`, never deleted (a `.replaced-*` left beside the live file would read as an
 * interrupted swap). Afterwards the exports are written from the restored database.
 */
export async function restoreBackupForApp(root: string, backup: string, options: { waitMs?: number } = {}): Promise<RestoreResult & { keptIn: string | null }> {
  const { withWorkspaceLocks } = await import('./plan-migrate.js');
  // The locks first (an app write holds the plan lock while it uses its connection), then the gate for new uses.
  return withWorkspaceLocks(root, async () => {
    let entry = entryOf(root);
    while (entry.gate) {
      await entry.gate;
      entry = entryOf(root);
    }
    let open!: () => void;
    entry.gate = new Promise<void>((resolve) => { open = resolve; });
    let oldDbId: string | null = null;
    let restored: RestoreResult & { keptIn: string | null };
    try {
      if (storeOf(root) !== 'database') throw new WorkspaceDbError('invalid', 'This workspace is not in its database, so there is no backup to restore here.');
      while (entry.opening || entry.db || entry.retiring.size > 0) {
        if (entry.opening) await entry.opening.catch(() => undefined);
        const before = entry.db;
        entry.db = null;
        if (before) {
          if (oldDbId === null) {
            try { oldDbId = await readWithRetry(before, () => withSnapshot(before, (v) => readDbId(v.sqlite))); } catch { /* damaged or gone */ }
          }
          await retireIn(entry, before);
        }
        await drainRetiring(entry);
      }
      const result = await restoreBackupAsync(root, backup, options);
      restored = { ...result, keptIn: result.keptAs ? await keepReplaced(root, result.keptAs) : null };
    } finally {
      entry.gate = null;
      open();
    }
    const { publishExports } = await import('./workspace-db-exports.js');
    await Promise.resolve()
      .then(async () => publishExports(root, await connection(root), { replaceDbIds: oldDbId ? [oldDbId] : [], restore: true }))
      .catch((error: unknown) => {
        process.stderr.write(`exports after the restore were not written: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    return restored;
  });
}

/** Moves a replaced database (and its journal) out of `.contextspace/` into the archive. Returns where it went. */
async function keepReplaced(root: string, keptAs: string): Promise<string> {
  const dir = path.join(root, '.contextspace', 'archive', 'replaced');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, path.basename(keptAs));
  await fs.rename(keptAs, target);
  await fs.rename(`${keptAs}-journal`, `${target}-journal`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  return target;
}
