/**
 * @module core/plan-migrate
 * The real move of a workspace to its workspace database (`ctxspace plan migrate`), the way back (`ctxspace plan
 * restore <archive>`), and what state a workspace is in (`ctxspace plan migrate --status`).
 *
 * The move, under the four locks today's writers honour (the plan, the Board, the state, the seen file, in that order):
 * 1. refuse when an older ContextSpace could still write the old files, or the workspace was moved already;
 * 2. snapshot and hash every source the rehearsal reads;
 * 3. build and check a staged database in `.contextspace/.db-staging-<id>/` (the same build as the rehearsal); any
 *    problem ends it here with the rehearsal's report, and nothing in the workspace has changed;
 * 4. write the import record: the archive's `manifest.json` (every source with its hash, and the hashes of the two new
 *    files), the switch file in state `moving` (from here every old writer refuses), and `workspaceDb` in state.json;
 *    the staged database already carries the same record;
 * 5. link the staged database into place (never over a file that is there);
 * 6. move the old PLAN.md into the archive and create the new one (an exclusive create: a save in between is never
 *    overwritten), then create `contextspace-data.json`;
 * 7. move every other source into the archive;
 * 8. mark the record done, in the database, in state.json and in the switch (`on`), and make the first backup.
 *
 * Every step after 4 is idempotent and checks its own result, so an interrupted move resumes from what is on disk:
 * `migrate` again finishes it. A move that stopped before its database was in place is undone and started again. A
 * source that changed during the move (something ignored the locks) undoes the whole move instead. Undoing (`restore`,
 * or a failed move) puts every archived file back byte for byte after checking each against the manifest, moves the
 * database and the two new files into the archive (nothing is ever deleted), keeps any file that came back since in
 * the archive too, takes the record out of state.json, and clears the switch last.
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { getActiveStorageProvider, isBuiltInLocalStorageProvider } from './adapters/registry.js';
import { getGeneratorVersion } from './analysis-cache.js';
import { resolveWorkspaceFilePath, resolveWorkspaceFilePathSync } from './constants.js';
import { acquireLock, type ReleaseLock } from './locks.js';
import { PlanFileError } from './plan-file.js';
import { buildMigrationDatabase, relativePosix, renderRehearsal, type RehearsalReport } from './plan-migrate-rehearsal.js';
import { findOlderWriters, type OlderWriter } from './older-writers.js';
import { durableWriteFile as atomicWriteFile, syncDirectory, writeFileSynced } from '../resources/fs-safety.js';
import {
  dbFilePath, exportPlanMarkdown, exportPortableSnapshot, listBackups, maybeBackup, openWorkspaceDb, readDbId, readImportRecord, readRevision,
  restoreBackup, stripExport, writeImportRecord, type DbImportRecord, type Unmapped, type WorkspaceDb,
} from './workspace-db/index.js';
import { SWITCH_FILE, readSwitch, switchPath, type SwitchRecord } from './workspace-db-switch.js';

export const ARCHIVE_ROOT = '.contextspace/archive';
export const DATA_FILE = 'contextspace-data.json';
const DB_REL = '.contextspace/workspace.db';
const MANIFEST = 'manifest.json';
const STAGING_PREFIX = '.db-staging-';
/** The database and its backups never go into Git (design §5). A workspace's root .gitignore is only written when it is made, so the move adds them to `.contextspace/.gitignore`, as line notes do. */
const IGNORE_REL = '.contextspace/.gitignore';
const IGNORE_LINES = ['workspace.db*', 'backups/', `${STAGING_PREFIX}*`];

/** Every file the rehearsal reads that the move archives, workspace-relative with `/`. The state file is kept (copied), since it holds more than the plan. */
const MOVED_SOURCES = [
  'PLAN.md', 'contextspace-plan.json', 'contextspace-board.json',
  '.contextspace/plan-changes.jsonl', '.contextspace/board-changes.jsonl', '.contextspace/plan-now.json', '.contextspace/plan-seen.json', '.contextspace/seen.json',
];

export type MigrateStep = 'snapshot' | 'staged' | 'recorded' | 'database' | 'plan' | 'data' | 'archived' | 'switch';

export interface SourceEntry { path: string; sha256: string; bytes: number; action: 'move' | 'copy' }

export interface Manifest {
  format: 'contextspace-pre-db-archive';
  version: 1;
  id: string;
  at: string;
  by: string;
  contextspace: string;
  workspace: string;
  archive: string;
  staging: string;
  sources: SourceEntry[];
  state: { path: string; existed: boolean };
  /** The lines the move adds to `.contextspace/.gitignore`, and the hash of the file it writes. */
  ignore: { existed: boolean; added: string[]; sha256: string };
  exports: { plan: string; data: string };
  database: { dbId: string; revision: number };
  counts: { blocks: number; items: number; cards: number; links: number; positions: number };
  unmapped: Unmapped[];
}

export interface MigrateOptions {
  by: string;
  now?: Date;
  /** Called after each step: a test seam that stands for the process stopping there (an error from it is not cleaned up). */
  afterStep?: (step: MigrateStep) => void | Promise<void>;
  /** Replaces the older-ContextSpace check (tests). */
  findOlderWriters?: (root: string) => Promise<OlderWriter[]>;
  /** Make the first backup after the move (default true). */
  backup?: boolean;
}

export interface MigrateResult {
  workspace: string;
  archive: string;
  id: string;
  /** `fresh`: a new move. `resumed`: an interrupted move was finished. `restarted`: an interrupted move was undone and run again. */
  how: 'fresh' | 'resumed' | 'restarted';
  counts: Manifest['counts'];
  unmapped: Unmapped[];
  moved: string[];
  kept: string[];
  backup: string | null;
  backupProblem?: string;
  elapsedMs: number;
}

/** A refusal: nothing was changed. `report` is the rehearsal's when the build found a problem. */
export class MoveRefusedError extends PlanFileError {
  constructor(message: string, readonly report?: RehearsalReport, readonly olderWriters?: OlderWriter[]) {
    super(message, 'conflict');
    this.name = 'MoveRefusedError';
  }
}

/**
 * A restore that cannot go ahead because files the move archived are gone from the archive and from their places.
 * Running restore or migrate again would refuse the same way, so its words say what to bring back first.
 */
export class ArchiveIncompleteError extends MoveRefusedError {
  constructor(readonly archive: string, readonly missing: string[]) {
    super([
      `The restore was not started: files the move archived are missing from ${archive}. Nothing was changed.`,
      ...missing.map((c) => `  - ${c}`),
      `Bring those files back to ${archive}/files/ (from Git or a backup; the manifest there has their hashes), then run \`ctxspace plan restore ${archive}\`.`,
    ].join('\n'));
    this.name = 'ArchiveIncompleteError';
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const toFs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function hashFile(file: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(file));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** Windows keeps a file busy for a moment after another program closed it: retry a removal a few times. */
async function unlinkRetry(file: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.unlink(file);
      return;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * Puts the file at `from` at `to` without ever replacing a file at `to`: a hard link, then `from` is removed. Where hard
 * links are not supported, an exclusive copy. Throws with code EEXIST when something is at `to`.
 */
async function placeExclusive(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.link(from, to);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw error;
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes(errorCode(error) ?? '')) throw error;
    await fs.copyFile(from, to, constants.COPYFILE_EXCL);
    await syncFile(to);
  }
  await unlinkRetry(from);
  await syncDirectory(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) await syncDirectory(path.dirname(from));
}

/** Flushes a file's bytes (a copy made by the fallback above). */
async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** A rename that survives a power cut: both folders are flushed after it. */
async function renameSynced(from: string, to: string): Promise<void> {
  await fs.rename(from, to);
  await syncDirectory(path.dirname(to));
  if (path.dirname(from) !== path.dirname(to)) await syncDirectory(path.dirname(from));
}

/** Moves a file to a name nothing uses yet inside `dir` (the archive): `name`, else `name.2`, `name.3`. Returns the name used. */
async function moveInto(file: string, dir: string, name: string): Promise<string> {
  await mkdirSynced(dir, path.dirname(name));
  for (let n = 1; n < 100; n += 1) {
    const target = path.join(dir, n === 1 ? name : `${name}.${n}`);
    if (await exists(target)) continue;
    await renameSynced(file, target);
    return target;
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}

/** Makes `sub` (relative, `/` or native) inside `dir` and flushes each new folder's entry in its parent. */
async function mkdirSynced(dir: string, sub: string): Promise<void> {
  let at = dir;
  for (const part of sub.split(/[\\/]/).filter((p) => p && p !== '.')) {
    const next = path.join(at, part);
    if (!(await exists(next))) { await fs.mkdir(next); await syncDirectory(at); }
    at = next;
  }
}

/** Never follows a link out of the workspace: every folder on the way to `rel`, and the file itself, must be real. */
async function refuseLinks(root: string, rel: string): Promise<void> {
  let current = root;
  for (const segment of rel.split('/')) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) {
      throw new MoveRefusedError(`${relativePosix(root, current)} is a link. ContextSpace does not move or write through links (one could point outside the workspace). Nothing was changed: replace it with the real file or folder, then try again.`);
    }
  }
}

// ─── Locks ──────────────────────────────────────────────────────────────────

/**
 * The locks today's writers take, in a fixed order: the plan (PLAN.md), the older planning notes and plan store (the
 * order the older plan's own move takes them in), the Board, the state, the seen file.
 */
async function withWorkspaceLocks<T>(root: string, run: () => Promise<T>): Promise<T> {
  const dot = path.join(root, '.contextspace');
  const locks = [
    { file: path.join(dot, 'plan-file.lock'), staleMs: 60_000 },
    { file: path.join(root, '.contextspace-planning.lock'), staleMs: 60_000 },
    { file: path.join(root, '.contextspace-plan.lock'), staleMs: 60_000 },
    { file: path.join(dot, 'board.lock'), staleMs: 60_000 },
    { file: resolveWorkspaceFilePathSync(root, 'stateLock').path, staleMs: 60_000 },
    { file: path.join(dot, 'seen.lock'), staleMs: 30_000 },
  ];
  const held: ReleaseLock[] = [];
  try {
    for (const lock of locks) {
      held.push(await acquireLock(lock.file, {
        staleMs: lock.staleMs, timeoutMs: 10_000,
        timeoutMessage: `The workspace is busy: another session holds ${relativePosix(root, lock.file)}. Nothing was changed; try again in a moment.`,
      }));
    }
    return await run();
  } finally {
    for (const release of held.reverse()) await release().catch(() => undefined);
  }
}

// ─── Records ────────────────────────────────────────────────────────────────

async function writeSwitch(root: string, record: SwitchRecord): Promise<void> {
  await atomicWriteFile(switchPath(root), `${JSON.stringify(record, null, 2)}\n`);
}

const archiveDir = (root: string, archive: string) => toFs(root, archive);
const archivedFile = (root: string, archive: string, rel: string) => path.join(archiveDir(root, archive), 'files', ...rel.split('/'));

/** A manifest read from anywhere, checked: ours, and naming only files inside the workspace. Null when it is not. */
function checkedManifest(value: unknown, archive: string): Manifest | null {
  const parsed = value as Manifest | null;
  if (parsed?.format !== 'contextspace-pre-db-archive' || !Array.isArray(parsed.sources) || parsed.archive !== archive || typeof parsed.id !== 'string') return null;
  for (const source of parsed.sources) {
    if (typeof source.path !== 'string' || source.path.split('/').some((part) => part === '..' || part === '') || path.isAbsolute(source.path)) return null;
  }
  return parsed;
}

/**
 * The move's manifest. `manifest.json` in the archive first. If that file cannot be read (a power cut can leave a new
 * file empty), the same manifest is also kept in the state file's record (`workspaceDb.manifest`) and in the database's
 * import record (the live database, or a staged one the move had not put in place yet); the first readable copy that
 * names this archive is used, and `from` says which.
 */
async function readManifestFrom(root: string, archive: string): Promise<{ manifest: Manifest; from: string }> {
  const file = path.join(archiveDir(root, archive), MANIFEST);
  let problem = '';
  try {
    const found = checkedManifest(JSON.parse(await fs.readFile(file, 'utf8')), archive);
    if (found) return { manifest: found, from: relativePosix(root, file) };
    problem = 'it is not a ContextSpace archive manifest for this archive';
  } catch (error) {
    problem = reason(error);
  }
  // the copy in the state file's record
  try {
    const state = await resolveWorkspaceFilePath(root, 'state');
    const record = (JSON.parse(await fs.readFile(state.path, 'utf8')) as { workspaceDb?: { manifest?: unknown } }).workspaceDb;
    const found = checkedManifest(record?.manifest, archive);
    if (found) return { manifest: found, from: `${relativePosix(root, state.path)} (workspaceDb.manifest)` };
  } catch { /* next copy */ }
  // the copy in a database's import record: the live one, any staged one, then the ones a restore moved into the archive
  const dot = path.join(root, '.contextspace');
  const dir = archiveDir(root, archive);
  const archivedDbs = (await fs.readdir(path.join(dir, 'database')).catch(() => [] as string[])).filter((n) => /^workspace\.db(\.\d+)?$/.test(n)).map((n) => path.join(dir, 'database', n));
  const files = [
    dbFilePath(root),
    ...(await fs.readdir(dot).catch(() => [] as string[])).filter((n) => n.startsWith(STAGING_PREFIX)).map((n) => dbFilePath(path.join(dot, n))),
    ...archivedDbs,
    dbFilePath(path.join(dir, 'staging')),
  ];
  for (const dbFile of files) {
    if (!existsSync(dbFile)) continue;
    const found = checkedManifest(importRecordIn(dbFile)?.manifest, archive);
    if (found) return { manifest: found, from: `${relativePosix(root, dbFile)} (its import record)` };
  }
  throw new PlanFileError(`The archive's manifest ${relativePosix(root, file)} cannot be read (${problem}), and no copy of it was found in the state file or a database, so ContextSpace cannot tell which files belong where. Nothing was changed. Every original file is either in its place or in ${archive}/files/.`, 'conflict');
}

async function readManifest(root: string, archive: string): Promise<Manifest> {
  return (await readManifestFrom(root, archive)).manifest;
}

/** The import record a database file carries, read straight from the file (wherever it lies), or null. Never writes. */
function importRecordIn(file: string): { manifest?: unknown } | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'import_record'").get() as { value?: string } | undefined;
    return row?.value ? JSON.parse(row.value) as { manifest?: unknown } : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * The manifest for a command that goes on to change files: when it came from a copy, manifest.json is written again
 * from it (a damaged one is kept beside it as manifest.json.damaged), so the archive describes itself once more.
 */
async function readManifestRepairing(root: string, archive: string): Promise<Manifest> {
  const { manifest, from } = await readManifestFrom(root, archive);
  const file = path.join(archiveDir(root, archive), MANIFEST);
  if (from !== relativePosix(root, file)) {
    if (await exists(file)) await moveInto(file, archiveDir(root, archive), `${MANIFEST}.damaged`);
    await atomicWriteFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}

/** The archive of the move this workspace is in, when the switch file cannot say: the state file's record, else the newest archive with a manifest and no `restored.json`. */
async function currentArchiveGuess(root: string): Promise<string | null> {
  const undone = (archive: string) => exists(path.join(archiveDir(root, archive), 'restored.json'));
  try {
    const state = await resolveWorkspaceFilePath(root, 'state');
    const archive = (JSON.parse(await fs.readFile(state.path, 'utf8')) as { workspaceDb?: { archive?: unknown } }).workspaceDb?.archive;
    if (typeof archive === 'string' && archive.startsWith(`${ARCHIVE_ROOT}/pre-db-`) && !archive.slice(ARCHIVE_ROOT.length + 1).includes('/') && await exists(archiveDir(root, archive)) && !(await undone(archive))) return archive;
  } catch { /* below */ }
  const names = (await fs.readdir(toFs(root, ARCHIVE_ROOT)).catch(() => [] as string[])).filter((n) => n.startsWith('pre-db-')).sort().reverse();
  for (const name of names) {
    const archive = `${ARCHIVE_ROOT}/${name}`;
    if (await undone(archive)) continue;
    if (await readManifest(root, archive).then(() => true, () => false)) return archive;
  }
  return null;
}

/** Whether the move had finished, when the switch file cannot say: its record in the state file or the live database says `done`. */
async function moveFinished(root: string, manifest: Manifest): Promise<boolean> {
  try {
    const state = await resolveWorkspaceFilePath(root, 'state');
    const record = (JSON.parse(await fs.readFile(state.path, 'utf8')) as { workspaceDb?: { id?: unknown; status?: unknown } }).workspaceDb;
    if (record?.id === manifest.id && record.status === 'done') return true;
  } catch { /* the database */ }
  if (!existsSync(dbFilePath(root))) return false;
  let db: WorkspaceDb | null = null;
  try { db = openQuiet(root, true); const record = readImportRecord(db); return record?.id === manifest.id && record.status === 'done'; } catch { return false; } finally { db?.close(); }
}

/** The state file's text and value; a file that cannot be parsed is a refusal (it holds more than the plan, so it is never written over). */
async function readStateFile(file: string): Promise<{ bytes: Buffer | null; value: Record<string, unknown> }> {
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); } catch (error) { if (errorCode(error) === 'ENOENT') return { bytes: null, value: {} }; throw error; }
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return { bytes, value: value as Record<string, unknown> };
  } catch { /* below */ }
  throw new MoveRefusedError(`${path.basename(file)} cannot be read as JSON, and the move keeps its record there. Nothing was changed. Fix the file (ctxspace doctor can help), then try again.`);
}

async function writeStateRecord(root: string, stateRel: string, record: Record<string, unknown>): Promise<void> {
  const file = toFs(root, stateRel);
  const { value } = await readStateFile(file);
  value.workspaceDb = record;
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function stateRecordOf(manifest: Manifest, status: 'moving' | 'done', finishedAt?: string): Record<string, unknown> {
  return {
    version: 1, id: manifest.id, status, at: manifest.at, by: manifest.by, contextspace: manifest.contextspace, archive: manifest.archive,
    sources: manifest.sources, exports: manifest.exports, database: manifest.database, ...(finishedAt ? { finishedAt } : {}),
    manifest, // a second copy of the archive's manifest.json, for when that file is lost
  };
}

function dbRecordOf(manifest: Manifest, status: 'moving' | 'done'): DbImportRecord {
  return { version: 1, id: manifest.id, status, at: manifest.at, by: manifest.by, contextspace: manifest.contextspace, archive: manifest.archive, sources: manifest.sources, exports: manifest.exports, manifest };
}

function openQuiet(folder: string, readOnly: boolean): WorkspaceDb {
  return openWorkspaceDb(folder, { busy: 'cli', readOnly, backups: false });
}

/** The import record id the database at `folder` carries, or null (no database, not ours, or none). */
function importIdAt(folder: string): string | null {
  if (!existsSync(dbFilePath(folder))) return null;
  let db: WorkspaceDb | null = null;
  try {
    db = openQuiet(folder, false); // read-write, so SQLite rolls back a write a crash left half done
    return readImportRecord(db)?.id ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// ─── Refusals before anything moves ─────────────────────────────────────────

function refuseForState(record: SwitchRecord, root: string): never {
  if (record.state === 'on') {
    throw new MoveRefusedError(`This workspace was already moved to the workspace database${record.at ? ` on ${record.at}` : ''}. Nothing was changed. See \`ctxspace plan migrate --status\`; undo it with \`ctxspace plan restore ${record.archive ?? '<archive>'}\`.`);
  }
  if (record.state === 'restoring') {
    throw new MoveRefusedError(`A restore of this workspace was interrupted. Nothing was changed. Finish it first: \`ctxspace plan restore ${record.archive ?? '<archive>'}\`.`);
  }
  throw new MoveRefusedError(`${SWITCH_FILE} is there but cannot be read, so ContextSpace cannot tell what state ${root} is in. Nothing was changed. \`ctxspace plan migrate --status\` names the move it belongs to; undo that one with \`ctxspace plan restore <archive>\`.`);
}

function olderWritersMessage(found: OlderWriter[]): string {
  return [
    `The move was not started: ${found.length === 1 ? 'a ContextSpace that does not know the workspace database could still write' : 'ContextSpace programs that do not know the workspace database could still write'} this workspace's old files, and what they wrote would be lost. Nothing was changed.`,
    ...found.map((f) => `  - ${f.what}.\n    Found: ${f.found}\n    To stop it: ${f.stop}.`),
  ].join('\n');
}

function blockers(report: RehearsalReport): string[] {
  const out: string[] = [];
  if (!report.roundTrip.identical) out.push('the plan does not come back from the database exactly as it is in PLAN.md');
  out.push(...report.keyProblems);
  for (const s of report.skipped) {
    // The plan or the whole Board not read means a person would find them empty after the move.
    if (s.skipped.startsWith('the plan') || s.skipped.startsWith('the whole board')) out.push(`${s.input}: ${s.problem}`);
  }
  for (const c of report.collisions) out.push(`would be left out: ${c}`);
  return out;
}

// ─── The move ───────────────────────────────────────────────────────────────

/** `ctxspace plan migrate`: moves the workspace at `workspacePath` to its database, or finishes a move that was interrupted. */
export async function migrateWorkspace(workspacePath: string, options: MigrateOptions): Promise<MigrateResult> {
  const started = Date.now();
  const root = await fs.realpath(workspacePath);
  if (!isBuiltInLocalStorageProvider(getActiveStorageProvider())) {
    throw new MoveRefusedError('This workspace keeps its files through a storage adapter other than the built-in local one, which cannot hold the workspace database yet. Nothing was changed.');
  }
  await refuseLinks(root, `${ARCHIVE_ROOT}/x`);
  const first = readSwitch(root);
  if (first && first.state !== 'moving') refuseForState(first, root);
  const hook = options.afterStep;
  const stopped = new Set<unknown>();
  const seam: MigrateOptions = { ...options, afterStep: hook && (async (step) => { try { await hook(step); } catch (error) { stopped.add(error); throw error; } }) };
  try {
    const older = await (options.findOlderWriters ?? findOlderWriters)(root);
    if (older.length) throw new MoveRefusedError(olderWritersMessage(older), undefined, older);
    return await moveUnderLocks(root, seam, started);
  } catch (error) {
    if (stopped.has(error)) throw error;
    const now = readSwitch(root);
    if (error instanceof ArchiveIncompleteError && now?.state === 'moving') {
      // Neither finishing nor undoing can go ahead until the missing files are back: say only what works.
      throw new MoveRefusedError(`${error.message.replace(/\s*Nothing was changed\.?/g, '').trim()} Until then this workspace stays in the middle of a move (${error.archive}), and every old writer refuses.`);
    }
    if (error instanceof MoveRefusedError && now?.state === 'moving') {
      // A refusal while a move is half done changed nothing more, but the workspace is not as it was: say so.
      throw new MoveRefusedError(`${error.message.replace(/\s*Nothing was changed\.?/g, '').trim()} Nothing more was changed, but this workspace is still in the middle of a move (${now.archive ?? 'its archive'}), and every old writer refuses until it is settled. Run \`ctxspace plan migrate\` again to finish it, or \`ctxspace plan restore ${now.archive ?? '<archive>'}\` to undo it.`, error.report, error.olderWriters);
    }
    if (error instanceof PlanFileError) throw error;
    throw new PlanFileError(now?.archive
      ? `The move stopped (${reason(error)}). Nothing is lost: every old file is in its place or in ${now.archive}/files/, and every old writer refuses until this is settled. Run \`ctxspace plan migrate\` again to finish it, or \`ctxspace plan restore ${now.archive}\` to undo it.`
      : `The move stopped before it changed anything (${reason(error)}). Nothing was changed.`, 'conflict');
  }
}

async function moveUnderLocks(root: string, options: MigrateOptions, started: number): Promise<MigrateResult> {
  return withWorkspaceLocks(root, async () => {
    const record = readSwitch(root);
    if (record && record.state !== 'moving') refuseForState(record, root);
    if (record?.state === 'moving') {
      if (!record.archive) throw new MoveRefusedError(`${SWITCH_FILE} says a move is under way but names no archive. Nothing was changed. See \`ctxspace plan migrate --status\`.`);
      const manifest = await readManifestRepairing(root, record.archive);
      if (importIdAt(root) === manifest.id) {
        return finish(root, await continueMove(root, manifest, options), 'resumed', started, options);
      }
      // Stopped before its database was in place: nothing in the workspace was moved yet. Undo it, then move afresh.
      await rollBack(root, manifest, { by: options.by, why: 'an earlier move stopped before its database was put in place' });
      return finish(root, await freshMove(root, options), 'restarted', started, options);
    }
    return finish(root, await freshMove(root, options), 'fresh', started, options);
  });
}

/** `root` is the workspace this command acts on: never `manifest.workspace`, which names where the move started (a copy of a half-moved workspace still names its original). */
async function finish(root: string, manifest: Manifest, how: MigrateResult['how'], started: number, options: MigrateOptions): Promise<MigrateResult> {
  let backup: string | null = null;
  let backupProblem: string | undefined;
  if (options.backup !== false) {
    try {
      const made = await maybeBackup(root);
      backup = made.file ? `.contextspace/backups/${made.file}` : null;
    } catch (error) {
      backupProblem = reason(error);
    }
  }
  return {
    workspace: root, archive: manifest.archive, id: manifest.id, how, counts: manifest.counts, unmapped: manifest.unmapped,
    moved: manifest.sources.filter((s) => s.action === 'move').map((s) => s.path), kept: manifest.sources.filter((s) => s.action === 'copy').map((s) => s.path),
    backup, ...(backupProblem ? { backupProblem } : {}), elapsedMs: Date.now() - started,
  };
}

async function freshMove(root: string, options: MigrateOptions): Promise<Manifest> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const id = randomBytes(6).toString('hex');
  const dot = path.join(root, '.contextspace');
  await fs.mkdir(dot, { recursive: true });

  // Nothing of a database may be in the way: a database without a finished move is never used, and never written over.
  for (const rel of [DB_REL, `${DB_REL}-journal`, DATA_FILE]) {
    await refuseLinks(root, rel);
    if (await exists(toFs(root, rel))) {
      throw new MoveRefusedError(rel === DATA_FILE
        ? `${DATA_FILE} is already there, and the move writes that file. Nothing was changed. If it came from another copy of this workspace, move it out of the workspace first.`
        : `There is already ${rel}, but no finished move says it belongs to this workspace, so it was not used or changed. Nothing was changed. Move it out of .contextspace/ (keep it if it may be someone's), then try again.`);
    }
  }
  // Staging folders an earlier attempt left before it wrote its record: built from files that are all still in place.
  for (const name of await fs.readdir(dot)) {
    if (name.startsWith(STAGING_PREFIX)) await fs.rm(path.join(dot, name), { recursive: true, force: true });
  }

  // ── step 2: the snapshot
  const found = await resolveWorkspaceFilePath(root, 'state');
  const stateRel = relativePosix(root, found.path);
  await refuseLinks(root, stateRel);
  const sources: SourceEntry[] = [];
  const snapshot = async (rel: string, action: SourceEntry['action']) => {
    await refuseLinks(root, rel);
    let bytes: Buffer;
    try { bytes = await fs.readFile(toFs(root, rel)); } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      if (errorCode(error) === 'EISDIR') throw new MoveRefusedError(`${rel} is a folder, not a file. Nothing was changed.`);
      throw error;
    }
    sources.push({ path: rel, sha256: sha256(bytes), bytes: bytes.length, action });
  };
  for (const rel of MOVED_SOURCES) await snapshot(rel, 'move');
  await snapshot(stateRel, 'copy');
  await snapshot(IGNORE_REL, 'copy');
  const ignoreBefore = await fs.readFile(toFs(root, IGNORE_REL), 'utf8').catch((error: unknown) => { if (errorCode(error) === 'ENOENT') return null; throw error; });
  const ignoreAdded = IGNORE_LINES.filter((line) => !(ignoreBefore ?? '').split(/\r?\n/).includes(line));
  const ignoreText = `${ignoreBefore ?? ''}${ignoreBefore && !ignoreBefore.endsWith('\n') ? '\n' : ''}${ignoreAdded.map((line) => `${line}\n`).join('')}`;
  await readStateFile(found.path); // a state file that cannot be read is refused before anything is built
  await options.afterStep?.('snapshot');

  // ── step 3: the staged database, checked
  const stagingName = `${STAGING_PREFIX}${id}`;
  const staging = path.join(dot, stagingName);
  await fs.mkdir(staging);
  let manifest: Manifest;
  try {
    const report = await buildMigrationDatabase(root, staging);
    const problems = blockers(report);
    if (problems.length) {
      throw new MoveRefusedError([
        'The move was not started: the database built from this workspace would not hold everything. Nothing was changed.',
        ...problems.map((p) => `  - ${p}`), '', 'What the build found:', renderRehearsal(report).replace(/^Rehearsal only: nothing in this workspace was changed\.\n/, ''),
      ].join('\n'), report);
    }
    for (const source of sources) {
      if (await hashFile(toFs(root, source.path)) !== source.sha256) {
        throw new MoveRefusedError(`${source.path} changed while the database was being built. Nothing was changed; try again in a moment.`);
      }
    }
    const db = openQuiet(staging, false);
    try {
      const archive = `${ARCHIVE_ROOT}/pre-db-${at.replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
      const planText = exportPlanMarkdown(db);
      const dataText = exportPortableSnapshot(db);
      manifest = {
        format: 'contextspace-pre-db-archive', version: 1, id, at, by: options.by, contextspace: getGeneratorVersion(), workspace: root, archive,
        staging: `.contextspace/${stagingName}`, sources, state: { path: stateRel, existed: found.exists },
        ignore: { existed: ignoreBefore !== null, added: ignoreAdded, sha256: sha256(ignoreText) },
        exports: { plan: sha256(planText), data: sha256(dataText) }, database: { dbId: readDbId(db.sqlite), revision: readRevision(db.sqlite) },
        counts: { blocks: report.plan.blocks, items: report.plan.items, cards: report.counts.cards, links: report.counts.links, positions: report.counts.positions },
        unmapped: report.unmapped,
      };
      await writeImportRecord(db, dbRecordOf(manifest, 'moving'));
    } finally {
      db.close();
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof MoveRefusedError) throw error;
    throw new MoveRefusedError(`The move was not started: the database could not be built (${reason(error)}). Nothing was changed.`);
  }
  await options.afterStep?.('staged');

  // ── step 4: the import record, before anything is renamed
  const dir = archiveDir(root, manifest.archive);
  await refuseLinks(root, `${manifest.archive}/x`);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.mkdir(dir); // a new name: an existing folder would be an error, never reused
  await syncDirectory(path.dirname(dir));
  await mkdirSynced(dir, 'files/.contextspace'); // where the sources go, there before anything is renamed into it
  await atomicWriteFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const source of sources.filter((s) => s.action === 'copy')) {
    const copy = archivedFile(root, manifest.archive, source.path);
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.copyFile(toFs(root, source.path), copy, constants.COPYFILE_EXCL);
    await syncFile(copy);
    await syncDirectory(path.dirname(copy));
    if (await hashFile(copy) !== source.sha256) throw new Error(`the copy of ${source.path} in the archive is not the same as the file`);
  }
  await writeSwitch(root, { state: 'moving', archive: manifest.archive, id, at, by: options.by });
  await writeStateRecord(root, stateRel, stateRecordOf(manifest, 'moving'));
  await options.afterStep?.('recorded');

  return continueMove(root, manifest, options);
}

/** Steps 5 to 8. Each one looks at what is on disk first, so running it again after an interruption finishes the move. */
async function continueMove(root: string, manifest: Manifest, options: MigrateOptions): Promise<Manifest> {
  const abort = async (why: string, kept: Array<{ path: string; keptAs: string }> = []): Promise<never> => {
    const undone = await rollBack(root, manifest, { by: options.by, why });
    throw new PlanFileError(abortMessage(why, manifest.archive, [...kept, ...undone.cameBack], undone.leftAsTheyAre, undone.newerInPlace), 'conflict');
  };
  const staging = toFs(root, manifest.staging);

  // ── step 5: the database in place (and kept out of Git first)
  await ensureIgnored(root, manifest);
  const live = dbFilePath(root);
  if (existsSync(live)) {
    if (importIdAt(root) !== manifest.id) return abort(`${DB_REL} is a database that is not this move's`);
    // Stopped between linking the database into place and removing the staged name: that name is a second hard link to
    // the live database, and two names for one SQLite file in rollback-journal mode can lose a write. Remove it.
    await removeSecondName(dbFilePath(staging), live);
  } else {
    if (importIdAt(staging) !== manifest.id) return abort('the staged database is gone or is not this move\'s');
    try {
      await placeExclusive(dbFilePath(staging), live);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return abort(`a database appeared at ${DB_REL} during the move`);
      throw error;
    }
  }
  await options.afterStep?.('database');

  // The two new files come from the database that is now in place; they must be exactly what the record names.
  let planText: string;
  let dataText: string;
  {
    const db = openQuiet(root, true);
    try { planText = exportPlanMarkdown(db); dataText = exportPortableSnapshot(db); } finally { db.close(); }
  }
  if (sha256(planText) !== manifest.exports.plan || sha256(dataText) !== manifest.exports.data) return abort('the database in place does not export what the record names');

  // ── step 6: PLAN.md, then contextspace-data.json
  const planEntry = manifest.sources.find((s) => s.path === 'PLAN.md');
  const placeNew = async (rel: string, text: string): Promise<void> => {
    const target = toFs(root, rel);
    const temp = path.join(root, '.contextspace', `.${path.basename(rel)}.${manifest.id}.tmp`);
    await writeFileSynced(temp, text);
    try {
      await placeExclusive(temp, target);
    } catch (error) {
      await unlinkRetry(temp).catch(() => undefined);
      if (errorCode(error) === 'EEXIST') return abort(`${rel} was saved by someone else during the move`);
      throw error;
    }
  };
  if (await hashFile(toFs(root, 'PLAN.md')) !== manifest.exports.plan) {
    if (planEntry) await moveSourceIntoArchive(root, manifest, planEntry, abort);
    else if (await exists(toFs(root, 'PLAN.md'))) return abort('a PLAN.md appeared during the move');
    await placeNew('PLAN.md', planText);
  }
  await options.afterStep?.('plan');
  const dataHash = await hashFile(toFs(root, DATA_FILE));
  if (dataHash !== manifest.exports.data) {
    if (dataHash !== null) return abort(`${DATA_FILE} was written by someone else during the move`);
    await placeNew(DATA_FILE, dataText);
  }
  await options.afterStep?.('data');

  // ── step 7: every other source into the archive
  for (const entry of manifest.sources) {
    if (entry.action === 'move' && entry.path !== 'PLAN.md') await moveSourceIntoArchive(root, manifest, entry, abort);
  }
  await options.afterStep?.('archived');

  // ── step 8: done, in the database, in state.json, then the switch
  const finishedAt = new Date().toISOString();
  {
    const db = openQuiet(root, false);
    try { await writeImportRecord(db, { ...dbRecordOf(manifest, 'done'), finishedAt }); } finally { db.close(); }
  }
  await writeStateRecord(root, manifest.state.path, stateRecordOf(manifest, 'done', finishedAt));
  await writeSwitch(root, { state: 'on', archive: manifest.archive, id: manifest.id, at: manifest.at, by: manifest.by });
  if (await exists(staging)) await moveInto(staging, archiveDir(root, manifest.archive), 'staging').catch(() => undefined);
  await options.afterStep?.('switch');
  return manifest;
}

/** Adds the move's lines to `.contextspace/.gitignore` when they are not there yet; idempotent. */
async function ensureIgnored(root: string, manifest: Manifest): Promise<void> {
  if (!manifest.ignore.added.length) return;
  const file = toFs(root, IGNORE_REL);
  const current = await fs.readFile(file, 'utf8').catch((error: unknown) => { if (errorCode(error) === 'ENOENT') return null; throw error; });
  const lines = (current ?? '').split(/\r?\n/);
  const missing = manifest.ignore.added.filter((line) => !lines.includes(line));
  if (!missing.length) return;
  await atomicWriteFile(file, `${current ?? ''}${current && !current.endsWith('\n') ? '\n' : ''}${missing.map((line) => `${line}\n`).join('')}`);
}

/** Takes the move's lines out of `.contextspace/.gitignore` again: the file as it was when nothing else changed it since, else only those lines. */
async function restoreIgnored(root: string, manifest: Manifest, copyTrusted = true): Promise<void> {
  if (!manifest.ignore.added.length) return;
  const file = toFs(root, IGNORE_REL);
  const current = await fs.readFile(file).catch((error: unknown) => { if (errorCode(error) === 'ENOENT') return null; throw error; });
  if (current === null) return;
  if (copyTrusted && sha256(current) === manifest.ignore.sha256) {
    if (manifest.ignore.existed) await atomicWriteFile(file, await fs.readFile(archivedFile(root, manifest.archive, IGNORE_REL)));
    else await unlinkRetry(file);
    return;
  }
  const lines = current.toString('utf8').split('\n');
  const kept = lines.filter((line) => !manifest.ignore.added.includes(line.replace(/\r$/, '')));
  if (kept.length !== lines.length) await atomicWriteFile(file, kept.join('\n'));
}

/** Removes `name` when it is the same file as `live` (same device and inode): a leftover hard link, not a copy. */
async function removeSecondName(name: string, live: string): Promise<void> {
  const [a, b] = await Promise.all([fs.stat(name, { bigint: true }).catch(() => null), fs.stat(live, { bigint: true }).catch(() => null)]);
  if (!a || !b || a.dev !== b.dev || a.ino !== b.ino) return;
  await unlinkRetry(name);
  await syncDirectory(path.dirname(name));
}

/** One source into the archive, checked against its hash; idempotent. */
/**
 * What a person reads when a move had to be undone: which files are back, and where every save made during the move
 * went. Nothing is lost, and nothing is described as "back as it was" that is not.
 */
export function abortMessage(why: string, archive: string, kept: Array<{ path: string; keptAs: string }>, left: string[], newer: string[] = []): string {
  const parts = [`The move stopped and was undone: ${why}.`];
  if (newer.length) parts.push(`Saved during the move by something that does not wait for ContextSpace (an editor, a Git checkout), and back in its place in that newer version: ${newer.join(', ')}.`);
  if (kept.length) {
    parts.push(`A save made during the move is kept, not lost: ${kept.map((k) => `${k.path} is at ${k.keptAs}`).join('; ')}. The version from before the move is back in its place; compare the two and keep what you want.`);
  }
  if (left.length) parts.push(`Changed during the move and left in its place as it is (the newer version): ${left.join(', ')}.`);
  parts.push(`${kept.length || left.length || newer.length ? 'Every other file' : 'Every file'} is back as it was, and the database and the move's files are kept in ${archive}. Run \`ctxspace plan migrate\` again when nothing else is writing the workspace.`);
  return parts.join(' ');
}

async function moveSourceIntoArchive(root: string, manifest: Manifest, entry: SourceEntry, abort: (why: string, kept?: Array<{ path: string; keptAs: string }>) => Promise<never>): Promise<void> {
  const live = toFs(root, entry.path);
  const archived = archivedFile(root, manifest.archive, entry.path);
  const archivedHash = await hashFile(archived);
  if (archivedHash !== null) {
    if (archivedHash !== entry.sha256) return abort(`the archive's copy of ${entry.path} is not the file that was moved`);
    if (await exists(live)) return abort(`${entry.path} was written again during the move`);
    return;
  }
  if (await hashFile(live) !== entry.sha256) return abort(`${entry.path} changed during the move`);
  await refuseLinks(root, `${manifest.archive}/files/${entry.path}`);
  await mkdirSynced(archiveDir(root, manifest.archive), path.posix.dirname(`files/${entry.path}`));
  await renameSynced(live, archived); // the archive path is new, so nothing is replaced
  if (await hashFile(archived) !== entry.sha256) {
    // Someone saved it between the check and the rename: that newer text goes back to its place before the move is
    // undone (or, if yet another save is there already, into the archive), so the undo finds the archive as the manifest says.
    const kept: Array<{ path: string; keptAs: string }> = [];
    try {
      await placeExclusive(archived, live);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      kept.push({ path: entry.path, keptAs: relativePosix(root, await moveInto(archived, archiveDir(root, manifest.archive), `came-back/${entry.path}`)) });
    }
    return abort(`${entry.path} changed while it was being moved`, kept);
  }
}

// ─── The way back ───────────────────────────────────────────────────────────

export interface RestoreResult {
  workspace: string;
  archive: string;
  /** Files put back, byte for byte. */
  putBack: string[];
  /** Where the database (and its journal) went, inside the archive. */
  databaseKeptAs: string[];
  /** Where the move's own PLAN.md and contextspace-data.json went. */
  exportsKeptAs: string[];
  /** Files that came back, or were edited by hand, after the move: kept in the archive, never lost. */
  cameBack: Array<{ path: string; keptAs: string }>;
  /** Sources that changed after the move started and before it archived them: left as they are. */
  leftAsTheyAre: string[];
  /** Sources whose archive copy was not the file the move archived (a save that landed there during the move): that newer version is in its place now. */
  newerInPlace: string[];
  state: 'put back as it was' | 'record taken out' | 'left as it is' | 'unchanged';
  notes: string[];
}

export type RestoreStep = 'guarded' | 'database' | 'exports' | 'files' | 'state';

export interface RestoreOptions {
  by: string;
  /** Called after each step: a test seam that stands for the process stopping there. */
  afterStep?: (step: RestoreStep) => void | Promise<void>;
}

/** `ctxspace plan restore <archive>`: undoes a move, or finishes an interrupted restore. */
export async function restoreWorkspace(workspacePath: string, archiveArg: string, options: RestoreOptions, cwd = process.cwd()): Promise<RestoreResult> {
  const root = await fs.realpath(workspacePath);
  if (!isBuiltInLocalStorageProvider(getActiveStorageProvider())) {
    throw new MoveRefusedError('This workspace keeps its files through a storage adapter other than the built-in local one. Nothing was changed.');
  }
  const archive = await resolveArchive(root, archiveArg, cwd);
  return withWorkspaceLocks(root, async () => {
    const record = readSwitch(root);
    if (!record) {
      const restored = await fs.readFile(path.join(archiveDir(root, archive), 'restored.json'), 'utf8').then((t) => JSON.parse(t) as { at?: string }, () => null);
      throw new MoveRefusedError(restored
        ? `This workspace is not moved: ${archive} was already restored${restored.at ? ` on ${restored.at}` : ''}. Nothing was changed.`
        : `This workspace is not moved to the workspace database, so there is nothing to restore. Nothing was changed.`);
    }
    let finished = record.state === 'on' || record.finished === true;
    let manifest: Manifest;
    if (record.state === 'unreadable' || !record.archive) {
      // The switch file cannot say which move this is (a power cut can leave it empty). The archive the person named can:
      // it must hold a readable manifest (or a copy of it) and must not have been restored already.
      if (await exists(path.join(archiveDir(root, archive), 'restored.json'))) {
        throw new MoveRefusedError(`${SWITCH_FILE} cannot be read, and ${archive} was already restored, so it is not the move this workspace is in. Nothing was changed. \`ctxspace plan migrate --status\` names the move to undo.`);
      }
      manifest = await readManifestRepairing(root, archive);
      finished = await moveFinished(root, manifest);
    } else {
      if (record.archive !== archive) {
        throw new MoveRefusedError(`This workspace's move used ${record.archive}, not ${archive}. Nothing was changed. Restore that one: \`ctxspace plan restore ${record.archive}\`.`);
      }
      manifest = await readManifestRepairing(root, archive);
    }
    const hook = options.afterStep;
    let stopped: unknown;
    try {
      return await rollBack(root, manifest, { by: options.by, why: 'restored by request', finished, afterStep: hook && (async (step) => { try { await hook(step); } catch (error) { stopped = error; throw error; } }) });
    } catch (error) {
      if (error === stopped || error instanceof PlanFileError) throw error;
      throw new PlanFileError(`The restore stopped (${reason(error)}). Nothing is lost: every old file is in its place or in ${archive}/files/, and every old writer refuses until it is finished. Run \`ctxspace plan restore ${archive}\` again to finish it.`, 'conflict');
    }
  });
}

/** The archive the person named, as the workspace-relative path the switch keeps; refused unless it is a folder in `.contextspace/archive/`. */
async function resolveArchive(root: string, arg: string, cwd: string): Promise<string> {
  const candidates = path.isAbsolute(arg) ? [arg] : [path.join(root, arg), path.resolve(cwd, arg)];
  const archiveRoot = await fs.realpath(toFs(root, ARCHIVE_ROOT)).catch(() => null);
  for (const candidate of candidates) {
    const real = await fs.realpath(candidate).catch(() => null);
    if (!real || !archiveRoot) continue;
    const rel = path.relative(archiveRoot, real);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep)) return `${ARCHIVE_ROOT}/${rel}`;
  }
  throw new MoveRefusedError(`${arg} is not an archive of this workspace (one of the folders in ${ARCHIVE_ROOT}/). Nothing was changed. \`ctxspace plan migrate --status\` names the archive.`);
}

/**
 * Undoes a move (finished or not), for `restore` and for a move that cannot finish. Checks every archived file against
 * the manifest before anything changes; then, with the switch at `restoring`: the database and the move's two files
 * into the archive, the sources back byte for byte, the record out of state.json, and the switch cleared last.
 * Idempotent: an interrupted run is finished by running it again.
 */
async function rollBack(root: string, manifest: Manifest, options: { by: string; why: string; finished?: boolean; afterStep?: RestoreOptions['afterStep'] }): Promise<RestoreResult> {
  const dir = archiveDir(root, manifest.archive);
  const result: RestoreResult = { workspace: root, archive: manifest.archive, putBack: [], databaseKeptAs: [], exportsKeptAs: [], cameBack: [], leftAsTheyAre: [], newerInPlace: [], state: 'unchanged', notes: [] };
  await refuseLinks(root, `${manifest.archive}/x`);

  // 1. check, before anything changes
  const changed: string[] = [];
  const untrustedCopies = new Set<string>();
  for (const entry of manifest.sources) {
    await refuseLinks(root, entry.path);
    const archivedHash = await hashFile(archivedFile(root, manifest.archive, entry.path));
    // An archive copy that is not the file the move archived does not stop the restore: something that ignores
    // ContextSpace's locks (an editor, a git checkout) saved the file while the move was renaming it. That newer
    // version is put in its place, or kept in came-back/ (step 5); the version the move started from is then gone
    // already, overwritten by that save. A copied file (the state file, .gitignore) whose copy changed is not trusted
    // for an exact put-back (step 6).
    if (archivedHash !== null && archivedHash !== entry.sha256 && entry.action === 'copy') {
      untrustedCopies.add(entry.path);
      result.notes.push(`The archive's copy of ${entry.path} is not the file the move copied, so ${entry.path} was not put back byte for byte: only the move's own changes were taken out of it.`);
    }
    if (entry.action === 'move' && archivedHash === null) {
      const livePath = toFs(root, entry.path);
      const liveHash = await hashFile(livePath);
      if (liveHash === null) changed.push(`${entry.path}: it is in neither the archive nor the workspace`);
      else if (liveHash === entry.sha256) { /* already back in its place (an earlier run), or never moved */ }
      else if (options.finished) {
        // The move had finished, so it archived every file it moved: this one is missing, whatever stands in its place now.
        changed.push(`${entry.path}: the archive's copy is missing (the move had archived it); what is in its place now is not the file that was moved`);
      } else if (entry.path === 'PLAN.md' && stripExport((await fs.readFile(livePath)).toString('utf8')) !== (await fs.readFile(livePath)).toString('utf8')) {
        // Written from the database (an export, edited or not): not the PLAN.md the move started from, which the archive no longer holds.
        changed.push('PLAN.md: the archive no longer holds the PLAN.md that was moved, and the PLAN.md in its place was written from the database');
      } else result.leftAsTheyAre.push(entry.path);
    }
    if (entry.action === 'copy' && archivedHash === null) changed.push(`${entry.path}: the archive's copy is gone`);
  }
  if (changed.length) {
    throw new ArchiveIncompleteError(manifest.archive, changed);
  }

  // 2. guard every old writer while files move
  await writeSwitch(root, { state: 'restoring', archive: manifest.archive, id: manifest.id, at: manifest.at, by: manifest.by, ...(options.finished ? { finished: true } : {}) });
  await options.afterStep?.('guarded');

  // 3. the database aside (with its journal, which belongs to it), never deleted
  const live = dbFilePath(root);
  {
    try {
      let kept: string | null = null;
      if (await exists(live)) {
        kept = await moveInto(live, dir, 'database/workspace.db');
        result.databaseKeptAs.push(relativePosix(root, kept));
      }
      // The journal goes wherever its database went, also when an earlier run moved the database and stopped before
      // the journal: a journal left at the live path would be applied to whatever database comes there next.
      if (await exists(`${live}-journal`)) {
        const target = kept ?? await lastKeptDatabase(dir) ?? path.join(dir, 'database', 'workspace.db');
        result.databaseKeptAs.push(relativePosix(root, await moveIntoExact(`${live}-journal`, `${target}-journal`)));
      }
    } catch (error) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '')) {
        throw new PlanFileError(`The workspace database is open in another program, so it cannot be moved aside. Close ContextSpace and every other program using this workspace, then run \`ctxspace plan restore ${manifest.archive}\` again. Nothing was lost; the workspace stays guarded until then.`, 'conflict');
      }
      throw error;
    }
  }
  await options.afterStep?.('database');

  // 4. the move's own files aside; anything else at those names came after the move and is kept too
  for (const [rel, digest] of [['PLAN.md', manifest.exports.plan], [DATA_FILE, manifest.exports.data]] as const) {
    const file = toFs(root, rel);
    const hash = await hashFile(file);
    if (hash === null) continue;
    if (hash === digest) { result.exportsKeptAs.push(relativePosix(root, await moveInto(file, dir, `exports/${rel}`))); continue; }
    const original = manifest.sources.find((s) => s.path === rel);
    if (original && hash === original.sha256) continue; // already put back by an earlier run, or never moved
    if (original && result.leftAsTheyAre.includes(rel)) continue; // changed before the move archived it: the person's own latest text
    result.cameBack.push({ path: rel, keptAs: relativePosix(root, await moveInto(file, dir, `came-back/${rel}`)) });
  }
  await options.afterStep?.('exports');

  // 5. every archived source back, byte for byte, never over a file
  for (const entry of manifest.sources.filter((s) => s.action === 'move')) {
    const archived = archivedFile(root, manifest.archive, entry.path);
    const file = toFs(root, entry.path);
    const archivedHash = await hashFile(archived);
    if (archivedHash === null) continue;
    const liveHash = await hashFile(file);
    if (archivedHash !== entry.sha256) {
      // A save that landed in the archive during the move (see step 1): never lost, never written over.
      if (liveHash === null) { await placeExclusive(archived, file); result.newerInPlace.push(entry.path); }
      else if (liveHash === archivedHash) { await unlinkRetry(archived); await syncDirectory(path.dirname(archived)); result.newerInPlace.push(entry.path); } // the same save under a second name: one is enough
      else result.cameBack.push({ path: entry.path, keptAs: relativePosix(root, await moveInto(archived, dir, `came-back/${entry.path}`)) }); // two different saves: the one in place stays
      continue;
    }
    if (liveHash === entry.sha256) { await unlinkRetry(archived); result.putBack.push(entry.path); continue; } // an earlier run linked it back
    if (liveHash !== null) result.cameBack.push({ path: entry.path, keptAs: relativePosix(root, await moveInto(file, dir, `came-back/${entry.path}`)) });
    await placeExclusive(archived, file);
    if (await hashFile(file) !== entry.sha256) throw new Error(`${entry.path} did not come back byte for byte`);
    result.putBack.push(entry.path);
  }
  await options.afterStep?.('files');

  // 6. the record out of state.json, and the move's lines out of .contextspace/.gitignore
  result.state = await restoreState(root, manifest, result.notes, !untrustedCopies.has(manifest.state.path));
  await restoreMovedStateRecord(root, manifest, result.notes);
  await restoreIgnored(root, manifest, !untrustedCopies.has(IGNORE_REL));
  await options.afterStep?.('state');

  // 7. the staging folder into the archive, the archive marked, and the switch cleared last
  const staging = toFs(root, manifest.staging);
  const keptDb = result.databaseKeptAs.find((rel) => !rel.endsWith('-journal'));
  if (keptDb) await removeSecondName(dbFilePath(staging), toFs(root, keptDb)); // one name for the archived database, not two
  if (await exists(staging)) await moveInto(staging, dir, 'staging').catch(() => undefined);
  await atomicWriteFile(path.join(dir, 'restored.json'), `${JSON.stringify({ at: new Date().toISOString(), by: options.by, why: options.why, putBack: result.putBack, cameBack: result.cameBack }, null, 2)}\n`);
  await unlinkRetry(switchPath(root));
  await syncDirectory(path.dirname(switchPath(root)));
  return result;
}

/** The database a restore moved into the archive last (`workspace.db`, `workspace.db.2`, …) that has no journal beside it yet. */
async function lastKeptDatabase(dir: string): Promise<string | null> {
  const folder = path.join(dir, 'database');
  const names = (await fs.readdir(folder).catch(() => [] as string[])).filter((n) => /^workspace\.db(\.\d+)?$/.test(n));
  const order = (n: string) => Number(/\.(\d+)$/.exec(n)?.[1] ?? 1);
  for (const name of names.sort((a, b) => order(b) - order(a))) {
    if (!(await exists(path.join(folder, `${name}-journal`)))) return path.join(folder, name);
  }
  return null;
}

async function moveIntoExact(from: string, to: string): Promise<string> {
  if (await exists(to)) return moveInto(from, path.dirname(to), path.basename(to));
  await renameSynced(from, to);
  return to;
}

/**
 * A workspace whose state file had an older name (`.contextspace-state.json`) gets it moved to `.contextspace/state.json`
 * by the next state write after the move, record and all. The record comes out of that file too.
 */
async function restoreMovedStateRecord(root: string, manifest: Manifest, notes: string[]): Promise<void> {
  const now = await resolveWorkspaceFilePath(root, 'state');
  const rel = relativePosix(root, now.path);
  if (rel === manifest.state.path || !now.exists) return;
  try {
    const value = JSON.parse(await fs.readFile(now.path, 'utf8')) as Record<string, unknown>;
    const record = value.workspaceDb as { id?: unknown } | undefined;
    if (record?.id !== manifest.id) return;
    delete value.workspaceDb;
    await atomicWriteFile(now.path, `${JSON.stringify(value, null, 2)}\n`);
    notes.push(`The state file moved to ${rel} after the move; the move's record was taken out of it as well.`);
  } catch { /* not readable: nothing uses the record once the switch is off */ }
}

/** Takes only the move's record out of a state file, when its archived copy cannot be trusted for an exact put-back. */
async function takeRecordOut(file: string, notes: string[], rel: string): Promise<RestoreResult['state']> {
  let value: Record<string, unknown>;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>; } catch {
    notes.push(`${rel} cannot be read as JSON, so it was left as it is.`);
    return 'left as it is';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'workspaceDb')) return 'unchanged';
  delete value.workspaceDb;
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return 'record taken out';
}

/** Puts state.json back as it was when nothing else wrote it since; otherwise takes only the record out. */
async function restoreState(root: string, manifest: Manifest, notes: string[], copyTrusted = true): Promise<RestoreResult['state']> {
  const rel = manifest.state.path;
  const file = toFs(root, rel);
  const archived = archivedFile(root, manifest.archive, rel);
  if (!copyTrusted) return takeRecordOut(file, notes, rel);
  const originalBytes = manifest.state.existed ? await fs.readFile(archived) : null;
  let current: Buffer | null;
  try { current = await fs.readFile(file); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; current = null; }
  if (current === null) {
    if (!originalBytes) return 'unchanged';
    // A state write after the move renamed an older-named state file to .contextspace/state.json: that file is the state
    // now (restoreMovedStateRecord takes the record out of it). Bringing the old name back would leave two state files.
    const now = await resolveWorkspaceFilePath(root, 'state');
    if (now.exists && relativePosix(root, now.path) !== rel) return 'record taken out';
    await atomicWriteFile(file, originalBytes);
    return 'put back as it was';
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(current.toString('utf8')) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  } catch {
    notes.push(`${rel} cannot be read as JSON, so it was left as it is; it may still carry the move's record (workspaceDb), which nothing uses once the switch is off.`);
    return 'left as it is';
  }
  const had = Object.hasOwn(value, 'workspaceDb');
  delete value.workspaceDb;
  if (originalBytes) {
    if (isDeepStrictEqual(value, JSON.parse(originalBytes.toString('utf8')))) {
      if (!current.equals(originalBytes)) await atomicWriteFile(file, originalBytes);
      return current.equals(originalBytes) ? 'unchanged' : 'put back as it was';
    }
  } else if (Object.keys(value).length === 0) {
    await unlinkRetry(file);
    return 'put back as it was';
  }
  if (!had) return 'unchanged';
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
  notes.push(`${rel} was written by other parts of ContextSpace after the move, so only the move's record was taken out of it.`);
  return 'record taken out';
}

// ─── Status, and a database that went missing ───────────────────────────────

export interface MigrateStatus {
  workspace: string;
  moved: 'no' | 'moving' | 'on' | 'restoring' | 'unreadable';
  at?: string;
  by?: string;
  archive?: string;
  /** `present`, `missing` (moved, and the file is gone) or `none` (not moved, no file); `stray` is a file without a move. */
  database: 'present' | 'missing' | 'none' | 'stray';
  /** A `.replaced-*` file a backup restore left while the live path is empty: recoverable. */
  replaced?: string;
  backups: string[];
  /** Old files that came back after the move (an older ContextSpace wrote them), and PLAN.md edited by hand since. Listed, otherwise ignored. */
  cameBack: Array<{ path: string; note: string }>;
  /** Earlier moves of this workspace that were undone. */
  earlier: Array<{ archive: string; restoredAt?: string }>;
  /** What to do, in plain words, when something needs doing. */
  offers: string[];
}

const REPLACED = /^workspace\.db\.replaced-.+$/;

async function replacedCandidate(root: string): Promise<string | null> {
  const names = await fs.readdir(path.join(root, '.contextspace')).catch(() => [] as string[]);
  const found = names.filter((n) => REPLACED.test(n) && !n.endsWith('-journal')).sort();
  return found.length ? found[found.length - 1]! : null;
}

/** `ctxspace plan migrate --status`. Reads only. */
export async function migrateStatus(workspacePath: string): Promise<MigrateStatus> {
  const root = await fs.realpath(workspacePath);
  const record = readSwitch(root);
  const liveDb = existsSync(dbFilePath(root));
  const status: MigrateStatus = {
    workspace: root, moved: record ? (record.state === 'unreadable' ? 'unreadable' : record.state) : 'no',
    ...(record?.at ? { at: record.at } : {}), ...(record?.by ? { by: record.by } : {}), ...(record?.archive ? { archive: record.archive } : {}),
    database: record ? (liveDb ? 'present' : 'missing') : (liveDb ? 'stray' : 'none'),
    backups: listBackups(root), cameBack: [], earlier: [], offers: [],
  };
  // A switch that cannot be read still belongs to a move: name its archive as the current one, not as an earlier move.
  const guessed = record && (record.state === 'unreadable' || !record.archive) ? await currentArchiveGuess(root) : null;
  if (guessed) status.archive = guessed;
  const archives = await fs.readdir(toFs(root, ARCHIVE_ROOT)).catch(() => [] as string[]);
  for (const name of archives.filter((n) => n.startsWith('pre-db-')).sort()) {
    const rel = `${ARCHIVE_ROOT}/${name}`;
    if (rel === status.archive) continue;
    const restored = await fs.readFile(path.join(toFs(root, rel), 'restored.json'), 'utf8').then((t) => JSON.parse(t) as { at?: string }, () => null);
    status.earlier.push({ archive: rel, ...(restored?.at ? { restoredAt: restored.at } : {}) });
  }
  if (!record) {
    if (status.database === 'stray') status.offers.push(`${DB_REL} is there, but no move says it belongs to this workspace, so nothing uses it. \`ctxspace plan migrate\` will not start until it is moved out of .contextspace/.`);
    return status;
  }
  if (record.state === 'unreadable' || !record.archive) {
    status.offers.push(guessed
      ? `${SWITCH_FILE} cannot be read (a power cut can leave it empty), so every old writer refuses. The move it belongs to is ${guessed}: undo it with \`ctxspace plan restore ${guessed}\`, then move again with \`ctxspace plan migrate\` if you want.`
      : `${SWITCH_FILE} cannot be read, so every old writer refuses, and no archive in ${ARCHIVE_ROOT}/ has a readable manifest that was not restored already. Look at the folders there.`);
    return status;
  }
  let manifest: Manifest | null = null;
  try { manifest = await readManifest(root, record.archive); } catch (error) { status.offers.push(reason(error)); }
  if (record.state === 'moving') status.offers.push(`The move did not finish. Finish it with \`ctxspace plan migrate\`, or undo it with \`ctxspace plan restore ${record.archive}\`.`);
  if (record.state === 'restoring') status.offers.push(`A restore did not finish. Finish it with \`ctxspace plan restore ${record.archive}\`.`);
  if (manifest && record.state === 'on') {
    for (const entry of manifest.sources.filter((s) => s.action === 'move' && s.path !== 'PLAN.md')) {
      if (await exists(toFs(root, entry.path))) status.cameBack.push({ path: entry.path, note: 'came back after the move (an older ContextSpace wrote it); it is ignored, and the move\'s copy is in the archive' });
    }
    const planHash = await hashFile(toFs(root, 'PLAN.md'));
    if (planHash !== manifest.exports.plan) status.cameBack.push({ path: 'PLAN.md', note: planHash === null ? 'is gone; the database still holds the plan' : 'was edited after the move; the edit is not in the database (importing hand edits comes later)' });
  }
  if (record.state === 'on' && !liveDb) {
    const replaced = await replacedCandidate(root);
    if (replaced) {
      status.replaced = `.contextspace/${replaced}`;
      status.offers.push(`The workspace database is missing, but the one a backup restore was replacing is still here (${status.replaced}): an interrupted restore. Put it back with \`ctxspace plan migrate\`.`);
    } else {
      status.offers.push(...missingOffers(root, record, status.backups));
    }
  }
  return status;
}

function missingOffers(root: string, record: SwitchRecord, backups: string[]): string[] {
  const offers = [`The workspace database is missing. This workspace was moved${record.at ? ` on ${record.at}` : ''}, so it is not a new workspace, and ContextSpace will not start an empty one.`];
  if (backups[0]) offers.push(`Bring back the newest backup (${backups[0]}): \`ctxspace plan migrate --from-backup ${backups[0]}\`.`);
  if (existsSync(toFs(root, DATA_FILE))) offers.push(`${DATA_FILE} holds the plan, the cards and the links as the database last wrote them; rebuilding a database from it comes with the next part (DB3d).`);
  offers.push(`Or undo the move: \`ctxspace plan restore ${record.archive ?? '<archive>'}\` puts the old files back.`);
  return offers;
}

export interface RecoverResult { workspace: string; recovered: string; from: 'replaced' | 'backup'; dbId: string }

/**
 * A moved workspace whose database is missing (`ctxspace plan migrate` on it, or `--from-backup <name>`): puts back the
 * file an interrupted backup restore had moved aside (`workspace.db.replaced-*`, with its journal first), or a backup,
 * under the workspace's locks. Never starts an empty database.
 */
export async function recoverDatabase(workspacePath: string, options: { fromBackup?: string; by: string }): Promise<RecoverResult> {
  const root = await fs.realpath(workspacePath);
  return withWorkspaceLocks(root, async () => {
    const record = readSwitch(root);
    if (record?.state !== 'on') throw new MoveRefusedError('Only a workspace that was moved to the workspace database can have its database brought back. Nothing was changed.');
    const live = dbFilePath(root);
    if (existsSync(live)) throw new MoveRefusedError(`The workspace database is there (${DB_REL}); nothing needs bringing back. Nothing was changed.`);
    if (options.fromBackup) {
      if (options.fromBackup.includes('/') || options.fromBackup.includes('\\') || !listBackups(root).includes(options.fromBackup)) {
        throw new MoveRefusedError(`${options.fromBackup} is not one of this workspace's backups (${listBackups(root).join(', ') || 'there are none'}). Nothing was changed.`);
      }
      const restored = restoreBackup(root, options.fromBackup);
      return { workspace: root, recovered: `.contextspace/backups/${options.fromBackup}`, from: 'backup', dbId: restored.dbId };
    }
    const replaced = await replacedCandidate(root);
    if (!replaced) throw new MoveRefusedError(missingOffers(root, record, listBackups(root)).join('\n'));
    const from = path.join(root, '.contextspace', replaced);
    if (await exists(`${live}-journal`)) throw new MoveRefusedError(`There is a journal at ${DB_REL}-journal but no database beside it. Nothing was changed: move that journal away first (keep it), then try again.`);
    // the journal first, so the database is never openable without the journal it may need
    if (await exists(`${from}-journal`)) await renameSynced(`${from}-journal`, `${live}-journal`);
    await renameSynced(from, live);
    let dbId = '';
    try { const db = openQuiet(root, true); try { dbId = readDbId(db.sqlite); } finally { db.close(); } } catch { /* reported by the next open */ }
    return { workspace: root, recovered: `.contextspace/${replaced}`, from: 'replaced', dbId };
  });
}

// ─── The words ──────────────────────────────────────────────────────────────

export function renderMigrateResult(result: MigrateResult): string {
  const c = result.counts;
  const lines = [
    result.how === 'resumed' ? 'Finished the move that was interrupted.' : result.how === 'restarted' ? 'An earlier move had stopped before its database was in place: it was undone, and the move ran again from the start.' : 'Moved to the workspace database.',
    `Workspace: ${result.workspace}`,
    `The database (${DB_REL}) holds the plan (${plural(c.items, 'item')} in ${plural(c.blocks, 'block')}) and the Board (${plural(c.cards, 'card')}, ${plural(c.links, 'link')}, ${plural(c.positions, 'position')}).`,
    `PLAN.md is now written from it, and ${DATA_FILE} beside it is the copy for Git.`,
    `The old files are in ${result.archive}/files/, with their hashes in its manifest: ${result.moved.join(', ') || 'none'}.${result.kept.length ? ` Copies of ${result.kept.join(' and ')} are there too: those stay in place (the state file carries the move's record, and .contextspace/.gitignore keeps the database out of Git).` : ''}`,
  ];
  if (result.unmapped.length) {
    lines.push('', `Could not be mapped to the new ids (${result.unmapped.length}); each card keeps what it can:`);
    for (const u of result.unmapped) lines.push(`  - ${u.what}${u.card ? ` on card "${u.title ?? ''}"` : ''}: ${u.value}. ${u.reason}.`);
  }
  lines.push('', result.backup ? `First backup: ${result.backup}.` : `No backup was made${result.backupProblem ? ` (${result.backupProblem})` : ''}.`);
  lines.push('Until the app reads the database, ContextSpace refuses every change to the old files here, and says so.');
  lines.push(`Undo it with \`ctxspace plan restore ${result.archive}\`.`);
  return lines.join('\n');
}

export function renderRestoreResult(result: RestoreResult): string {
  const lines = [
    'Restored: the workspace is back on its old files, and the switch is off.',
    `Workspace: ${result.workspace}`,
    `Put back byte for byte: ${result.putBack.join(', ') || 'nothing needed putting back'}.`,
  ];
  if (result.databaseKeptAs.length) lines.push(`The database was moved aside, not deleted: ${result.databaseKeptAs.join(', ')}.`);
  if (result.exportsKeptAs.length) lines.push(`The move's own files were kept in the archive: ${result.exportsKeptAs.join(', ')}.`);
  for (const c of result.cameBack) lines.push(`${c.path} had been written after the move; that version is kept at ${c.keptAs}.`);
  for (const p of result.leftAsTheyAre) lines.push(`${p} changed before the move archived it, so it was left as it is.`);
  for (const p of result.newerInPlace) lines.push(`${p} was saved during the move by something that does not wait for ContextSpace; that newer version is in its place.`);
  lines.push(`state.json: ${result.state}.`, ...result.notes);
  return lines.join('\n');
}

export function renderMigrateStatus(status: MigrateStatus): string {
  const lines = [`Workspace: ${status.workspace}`];
  const when = status.at ? ` on ${status.at}${status.by ? ` by ${status.by}` : ''}` : '';
  if (status.moved === 'no') lines.push('Not moved: the plan and the Board are in their old files.');
  else if (status.moved === 'on') lines.push(`Moved to the workspace database${when}.`);
  else if (status.moved === 'moving') lines.push(`A move started${when} and did not finish.`);
  else if (status.moved === 'restoring') lines.push(`A restore started and did not finish (the move was${when}).`);
  else lines.push(`${SWITCH_FILE} is there but cannot be read.`);
  if (status.archive) lines.push(`Archive: ${status.archive}`);
  if (status.moved !== 'no') lines.push(`Database: ${status.database === 'present' ? `${DB_REL}` : 'MISSING'}.`);
  if (status.backups.length) lines.push(`Backups: ${status.backups.join(', ')}.`);
  for (const c of status.cameBack) lines.push(`  - ${c.path} ${c.note}.`);
  for (const e of status.earlier) lines.push(`Earlier move${e.restoredAt ? `, undone on ${e.restoredAt}` : ''}: ${e.archive}`);
  if (status.offers.length) lines.push('', ...status.offers);
  return lines.join('\n');
}

export function renderRecover(result: RecoverResult): string {
  return [
    result.from === 'replaced' ? `The workspace database is back: ${result.recovered} was the database an interrupted backup restore had moved aside.` : `The workspace database is back, from the backup ${result.recovered} (as a new generation: its db id changed).`,
    `Workspace: ${result.workspace}`,
  ].join('\n');
}
