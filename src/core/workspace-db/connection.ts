/**
 * @module core/workspace-db/connection
 * Opening the workspace database: `.contextspace/workspace.db` through Node's own `node:sqlite`.
 *
 * Policy, as Workrooms already keep it (`workrooms/sqlite-store.ts`): a rollback journal (`journal_mode=DELETE`,
 * `synchronous=FULL`), not WAL, because the SQLite that Node 22.13 bundles has the documented WAL reset race.
 * Migrations are numbered, each runs in one transaction, and `user_version` says how far the file is.
 *
 * Opening fails closed with a typed error. There is no in-memory fallback: a database that cannot open means the plan
 * cannot be changed, and the caller says so.
 *
 * Stdout and stderr: `node:sqlite` prints "ExperimentalWarning: SQLite is an experimental feature" once, on stderr
 * (Node 22.13; later Node versions are quiet). This module never writes to stdout and never touches the warning, so
 * a JSON consumer on stdout is safe and a person still sees it on stderr, as they do from Workrooms. A test pins it.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { TABLES, createStatements } from './definitions.js';
import { WorkspaceDbError, isBusyError, isCorruptError } from './errors.js';

export const DB_RELATIVE_PATH = path.join('.contextspace', 'workspace.db');

/** How the connection waits for another process's write lock. */
export type BusyMode = 'server' | 'cli';

/** The server never blocks its event loop: it asks again later, for this long. */
export const SERVER_BUSY_MS = 2000;
/** The command line may wait inside SQLite. */
export const CLI_BUSY_MS = 5000;

export interface Migration {
  version: number;
  /** Runs inside a `BEGIN IMMEDIATE` transaction; the version is recorded in the same one. */
  run(db: DatabaseSync): void;
}

function migrationOne(db: DatabaseSync): void {
  // A new database starts empty: nothing of ours, or of anyone else's, may be in the file.
  if ((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n > 0) {
    throw new WorkspaceDbError('foreign', 'This file already holds tables that are not ContextSpace\'s. It was not changed.');
  }
  for (const statement of createStatements()) db.exec(statement);
  const insert = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
  insert.run('workspace', WORKSPACE_MARKER);
  insert.run('db_id', randomBytes(8).toString('hex'));
  insert.run('revision', '0');
  insert.run('trailing_newline', '1');
  insert.run('created_at', new Date().toISOString());
}

/** The value of `meta.workspace`: what says this file is a ContextSpace workspace database. */
export const WORKSPACE_MARKER = 'contextspace-workspace-db';

/** Append only. Never edit a migration that has shipped. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, run: migrationOne }];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface OpenOptions {
  /** Open for reading only: no migration, no writes. */
  readOnly?: boolean;
  /** `server`: never wait in SQLite, retry asynchronously for 2 s. `cli`: wait up to 5 s. */
  busy: BusyMode;
  /** Schedule the day's backup after the first committed write (default true). */
  backups?: boolean;
  /** For tests: replaces the migration list. */
  migrations?: readonly Migration[];
}

export interface WorkspaceDb {
  readonly sqlite: DatabaseSync;
  readonly workspacePath: string;
  readonly file: string;
  readonly readOnly: boolean;
  readonly busy: BusyMode;
  readonly backups: boolean;
  /** Background work (a scheduled backup) that has not finished yet. */
  readonly pending: Set<Promise<unknown>>;
  close(): void;
  /** Resolves when background work has finished. */
  idle(): Promise<void>;
  /** False when another file now stands at the path, or none does (a restore replaced it): open it again. */
  isCurrent(): boolean;
  /** Set on the read view `withSnapshot` hands out: its `sqlite` is a separate read-only connection, so it can never see this connection's uncommitted rows. */
  readonly snapshot?: true;
  /** The separate read-only connection reads use (opened on first use). */
  readerConnection(): DatabaseSync;
  /** Runs `job` after every earlier job on this connection has finished: a transaction may wait between timers, so two must not interleave. */
  serialize<T>(job: () => Promise<T>): Promise<T>;
}

export const dbFilePath = (workspacePath: string): string => path.join(workspacePath, DB_RELATIVE_PATH);

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function identityOf(file: string): string {
  try {
    const stat = statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return '';
  }
}

function wrapOpenError(error: unknown, file: string): WorkspaceDbError {
  if (error instanceof WorkspaceDbError) return error;
  if (isCorruptError(error)) {
    return new WorkspaceDbError('corrupt', `The workspace database ${file} is not a usable SQLite database (${(error as Error).message}). It was not changed and nothing was started from an empty copy. Restore a backup from .contextspace/backups/.`, { cause: error });
  }
  if (isBusyError(error)) return new WorkspaceDbError('busy', `The workspace database ${file} is locked by another process. Try again in a moment.`, { cause: error });
  return new WorkspaceDbError('open_failed', `Could not open the workspace database ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

const userTables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);

/**
 * Whether this is a ContextSpace workspace database of the current schema: the marker and `db_id` in `meta`, and every
 * table and column of the definitions, no more and no fewer. A matching `user_version` alone proves nothing.
 */
export function validateWorkspaceSchema(db: DatabaseSync, file: string): void {
  const foreign = (why: string) => new WorkspaceDbError('foreign', `${file} is not a ContextSpace workspace database (${why}). It was not changed.`);
  const tables = new Set(userTables(db));
  for (const table of TABLES) {
    if (!tables.has(table.name)) throw foreign(`table ${table.name} is missing`);
    const live = (db.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>).map((c) => c.name).sort().join(',');
    const want = table.columns.map((c) => c.name).sort().join(',');
    if (live !== want) throw foreign(`table ${table.name} has columns ${live}, expected ${want}`);
  }
  for (const name of tables) if (!TABLES.some((t) => t.name === name)) throw foreign(`unknown table ${name}`);
  const meta = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  if (meta('workspace') !== WORKSPACE_MARKER) throw foreign('no workspace marker');
  if (!meta('db_id')) throw foreign('no db_id');
}

/** Identity check for a file older than the latest schema (before its migrations run): the marker must be there. */
function validateIdentity(db: DatabaseSync, file: string): void {
  const row = (userTables(db).includes('meta') ? db.prepare("SELECT value FROM meta WHERE key = 'workspace'").get() : undefined) as { value: string } | undefined;
  if (row?.value !== WORKSPACE_MARKER) throw new WorkspaceDbError('foreign', `${file} is not a ContextSpace workspace database (no workspace marker). It was not changed.`);
}

function migrate(db: DatabaseSync, migrations: readonly Migration[], file: string): void {
  for (const migration of migrations) {
    if (readUserVersion(db) >= migration.version) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have migrated while this one waited for the lock.
      if (readUserVersion(db) < migration.version) {
        if (migration.version > 1) validateIdentity(db, file);
        migration.run(db);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw wrapOpenError(error, file);
    }
  }
}

function openCore(workspacePath: string, options: OpenOptions, create: boolean): WorkspaceDb {
  const file = dbFilePath(workspacePath);
  const readOnly = options.readOnly === true;
  if (create && readOnly) throw new WorkspaceDbError('invalid', 'A database cannot be created read-only.');
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = migrations[migrations.length - 1]!.version;
  if (!create) {
    try { statSync(file); } catch {
      throw new WorkspaceDbError('missing', `There is no workspace database at ${file}. It is created once, by the migration, not by opening.`);
    }
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  let sqlite: DatabaseSync;
  try {
    sqlite = new DatabaseSync(file, { readOnly, allowExtension: false });
  } catch (error) {
    throw wrapOpenError(error, file);
  }
  try {
    // The very first statement sets the wait: the server never sits inside SQLite (it retries between timers, see openWorkspaceDbAsync).
    sqlite.exec(`PRAGMA busy_timeout = ${options.busy === 'cli' ? CLI_BUSY_MS : 0}`);
    const version = readUserVersion(sqlite);
    if (version > latest) {
      throw new WorkspaceDbError('too_new', `The workspace database ${file} was written by a newer ContextSpace (schema version ${version}; this one knows ${latest}). Upgrade ContextSpace. The file was not changed.`);
    }
    if (version === 0) {
      if (userTables(sqlite).length > 0) throw new WorkspaceDbError('foreign', `${file} is a database with tables of its own, not a ContextSpace workspace database. It was not changed.`);
      if (!create) throw new WorkspaceDbError('missing', `There is no workspace database in ${file} (the file is empty). It is created once, by the migration.`);
    }
    if (readOnly) {
      if (version < latest) throw new WorkspaceDbError('open_failed', `The workspace database ${file} has schema version ${version}; open it for writing once to bring it to ${latest}.`);
      sqlite.exec('PRAGMA query_only = ON');
    } else {
      sqlite.exec('PRAGMA journal_mode = DELETE');
      sqlite.exec('PRAGMA synchronous = FULL');
      if (version > 0 && version < latest) validateIdentity(sqlite, file);
      migrate(sqlite, migrations, file);
    }
    if (migrations === MIGRATIONS) validateWorkspaceSchema(sqlite, file);
    sqlite.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    try { sqlite.close(); } catch { /* ignore */ }
    throw wrapOpenError(error, file);
  }

  const identity = identityOf(file);
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let reader: DatabaseSync | null = null;
  return {
    sqlite,
    workspacePath,
    file,
    readOnly,
    busy: options.busy,
    backups: options.backups !== false,
    pending,
    close() {
      if (closed) return;
      closed = true;
      try { reader?.close(); } catch { /* ignore */ }
      try { sqlite.close(); } catch { /* ignore */ }
    },
    readerConnection() {
      if (readOnly) return sqlite;
      if (!this.isCurrent()) throw replaced();
      if (!reader) {
        reader = new DatabaseSync(file, { readOnly: true, allowExtension: false });
        reader.exec(`PRAGMA busy_timeout = ${options.busy === 'cli' ? CLI_BUSY_MS : 0}`);
        reader.exec('PRAGMA query_only = ON');
      }
      return reader;
    },
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    isCurrent() {
      if (identity === '') return true;
      const now = identityOf(file);
      return now !== '' && now === identity; // a vanished file is not the one we opened
    },
    serialize<T>(job: () => Promise<T>): Promise<T> {
      const run = tail.then(job, job);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/**
 * Opens an EXISTING workspace database. Throws {@link WorkspaceDbError}: `missing` (no file, or an empty one: creating
 * is a separate act, {@link createWorkspaceDb}), `foreign` (a database that is not ours, by marker or schema),
 * `corrupt`, `too_new`, `busy`. It never falls back to a memory database. In `server` mode the wait is 0 from the first
 * statement, so a lock held by another process makes this throw `busy` at once; {@link openWorkspaceDbAsync} retries.
 */
export function openWorkspaceDb(workspacePath: string, options: OpenOptions): WorkspaceDb {
  return openCore(workspacePath, options, false);
}

/** Creates the database (the migration), or opens it when it is already ours. Refuses a file with other tables. */
export function createWorkspaceDb(workspacePath: string, options: OpenOptions): WorkspaceDb {
  return openCore(workspacePath, options, true);
}

/** Opens like {@link openWorkspaceDb}; in `server` mode a busy file is retried between timers for up to 2 s. */
export async function openWorkspaceDbAsync(workspacePath: string, options: OpenOptions): Promise<WorkspaceDb> {
  const started = Date.now();
  let pause = 5;
  for (;;) {
    try {
      return openCore(workspacePath, options, false);
    } catch (error) {
      if (!(error instanceof WorkspaceDbError) || error.code !== 'busy' || options.busy === 'cli' || Date.now() - started >= SERVER_BUSY_MS) throw error;
      await sleep(pause);
      pause = Math.min(pause * 2, 200);
    }
  }
}

// ─── Meta ───────────────────────────────────────────────────────────────────

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string | number): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function readRevision(db: DatabaseSync): number {
  return Number(getMeta(db, 'revision') ?? 0);
}

export function readDbId(db: DatabaseSync): string {
  return getMeta(db, 'db_id') ?? '';
}

// ─── Waiting for the write lock ─────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const replaced = () => new WorkspaceDbError('replaced', 'The workspace database file was replaced or removed (a backup was restored). Open it again; nothing was written.');

/**
 * `BEGIN IMMEDIATE`. In `cli` mode SQLite waits (up to 5 s) inside the call. In `server` mode the call fails at once
 * when another process holds the lock, and this retries between timers with a growing pause for up to 2 s, so the
 * event loop keeps answering. Then it throws `busy`. The file's identity is checked before every try and once more
 * after the lock is won, so a connection that waited while the file was replaced or removed writes nothing.
 */
export async function beginImmediate(db: WorkspaceDb): Promise<void> {
  if (db.readOnly) throw new WorkspaceDbError('read_only', 'This connection was opened read-only.');
  const started = Date.now();
  let pause = 5;
  for (;;) {
    if (!db.isCurrent()) throw replaced();
    try {
      db.sqlite.exec('BEGIN IMMEDIATE');
      if (!db.isCurrent()) {
        try { db.sqlite.exec('ROLLBACK'); } catch { /* ignore */ }
        throw replaced();
      }
      return;
    } catch (error) {
      if (error instanceof WorkspaceDbError) throw error;
      if (!isBusyError(error)) throw wrapOpenError(error, db.file);
      if (db.busy === 'cli' || Date.now() - started >= SERVER_BUSY_MS) {
        throw new WorkspaceDbError('busy', `The workspace database is busy: another process is writing. Nothing was changed; try again in a moment.`, { cause: error });
      }
      await sleep(pause);
      pause = Math.min(pause * 2, 200);
    }
  }
}

/**
 * `COMMIT`. In `server` mode a commit that meets a reader in another process is refused at once (it needs every reader
 * gone); the transaction stays open, so this asks again between timers for up to 2 s, then rolls back and throws `busy`.
 */
export async function commitTransaction(db: WorkspaceDb): Promise<void> {
  const started = Date.now();
  let pause = 5;
  for (;;) {
    try {
      db.sqlite.exec('COMMIT');
      return;
    } catch (error) {
      if (!isBusyError(error)) throw error;
      if (db.busy === 'cli' || Date.now() - started >= SERVER_BUSY_MS) {
        try { db.sqlite.exec('ROLLBACK'); } catch { /* ignore */ }
        throw new WorkspaceDbError('busy', 'The workspace database is busy: another process is reading or writing. Nothing was changed; try again in a moment.', { cause: error });
      }
      await sleep(pause);
      pause = Math.min(pause * 2, 200);
    }
  }
}

/**
 * Runs `read` on a read view: one read transaction on a SEPARATE read-only connection, so everything it reads (blocks,
 * revision, cards) comes from one committed moment. It can never see rows this connection has written but not yet
 * committed (a server-mode commit that is being retried between timers keeps its transaction open across them). A
 * view that is already a snapshot is passed through; nothing here joins a transaction it did not start.
 */
export function withSnapshot<T>(db: WorkspaceDb, read: (view: WorkspaceDb) => T): T {
  if (db.snapshot) return read(db);
  const reader = db.readerConnection();
  const view: WorkspaceDb = { ...db, sqlite: reader, snapshot: true };
  reader.exec('BEGIN');
  try {
    return read(view);
  } finally {
    try { reader.exec('COMMIT'); } catch { try { reader.exec('ROLLBACK'); } catch { /* ignore */ } }
  }
}

/**
 * Runs a read that may meet another process's commit (in `server` mode a reader is refused at once while a commit is
 * being written). Asks again between timers for up to 2 s, then throws `busy`.
 */
export async function readWithRetry<T>(db: WorkspaceDb, read: () => T): Promise<T> {
  const started = Date.now();
  let pause = 5;
  for (;;) {
    try {
      return read();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      if (Date.now() - started >= SERVER_BUSY_MS) throw new WorkspaceDbError('busy', 'The workspace database is busy. Try again in a moment.', { cause: error });
      await sleep(pause);
      pause = Math.min(pause * 2, 200);
    }
  }
}
