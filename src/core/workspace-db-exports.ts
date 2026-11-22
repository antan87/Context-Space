/**
 * @module core/workspace-db-exports
 * Writing `PLAN.md` and `contextspace-data.json` from the database after a change made through the app.
 *
 * The rules (design v3 point 1, v5 DB3.1, v6 point 4):
 * - **Only an export of ours is replaced.** The file on disk must be an untouched export: its header names a db_id and
 *   revision, and its digest matches its own body. A hand edit (or anything else) is never written over; it stays as it
 *   is, for DB3d's Import and Discard.
 * - **Never an older export over a newer one.** When the file is an export of this database at the same or a later
 *   revision (another app or process wrote it after this one read), it is left alone. An export of another database
 *   (another clone, a restored generation) is left alone too, unless the caller names that db_id (the restore it just made).
 * - **A drag does not touch a committed file.** A file is written only when its content digest changes: positions and
 *   revisions are not content, so a drag leaves both files exactly as they were (their header keeps its revision).
 * - **No save is overwritten, in any order of events.** The current file is renamed aside, checked to be the very bytes
 *   that were judged ours, and only then is the new export linked in with an exclusive create. A save that lands in
 *   between stays as the file (or, if two land, the other one is kept in `.contextspace/drafts/`).
 *
 * Exports of one workspace are written one after the other within this process.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { syncDirectory, writeFileSynced } from '../resources/fs-safety.js';
import {
  HEADER_LINE, exportDigest, exportPlan, exportPortableSnapshot, getMeta, readWithRetry, withSnapshot, type WorkspaceDb,
} from './workspace-db/index.js';

export const PLAN_EXPORT = 'PLAN.md';
export const DATA_EXPORT = 'contextspace-data.json';

export type ExportOutcome =
  /** Written. */
  | 'written'
  /** The file already has this content. */
  | 'unchanged'
  /** The file is not an untouched export (a hand edit): left as it is. */
  | 'kept-edit'
  /** The file is an export of this database at the same or a later revision: left as it is. */
  | 'newer'
  /** The file is an export of another database: left as it is. */
  | 'other-database'
  /** A save landed while this one was being written: that save stays. */
  | 'kept-save';

export interface ExportHeader { dbId: string; revision: number; digest: string }

/** The header of a file's text when it is an untouched export of either kind, else null. */
export function exportHeaderOf(file: string, text: string): ExportHeader | null {
  if (file === DATA_EXPORT) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const { format, version, db_id: dbId, revision, digest, ...content } = parsed;
      if (format !== 'contextspace-data' || version !== 1 || typeof dbId !== 'string' || typeof revision !== 'number' || typeof digest !== 'string') return null;
      if (createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16) !== digest) return null;
      return { dbId, revision, digest };
    } catch {
      return null;
    }
  }
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const m = HEADER_LINE.exec(first);
  if (!m) return null;
  if (exportDigest(text) !== m[3]) return null;
  return { dbId: m[1]!, revision: Number(m[2]), digest: m[3]! };
}

/** Whether `next` may replace the file now holding `current` (null: no file). */
export function judgeExport(file: string, current: string | null, next: ExportHeader, replaceDbIds: readonly string[] = []): ExportOutcome | 'replace' {
  if (current === null) return 'replace';
  const header = exportHeaderOf(file, current);
  if (!header) return 'kept-edit';
  // an export of an earlier generation of this database (before a backup was restored) is ours: it is rewritten even
  // when the content is the same, so its header names the database it now comes from
  if (header.dbId !== next.dbId) return replaceDbIds.includes(header.dbId) ? 'replace' : 'other-database';
  if (header.digest === next.digest) return 'unchanged';
  if (header.revision >= next.revision) return 'newer';
  return 'replace';
}

/** The db_ids this database had before backups were restored over it (`meta.former_db_ids`): their exports are ours. */
function formerDbIds(view: WorkspaceDb): string[] {
  try {
    const parsed: unknown = JSON.parse(getMeta(view.sqlite, 'former_db_ids') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const chains = new Map<string, Promise<unknown>>();

/** Writes both exports from the database, as one committed moment. Returns what happened to each. */
export function publishExports(root: string, db: WorkspaceDb, options: { replaceDbIds?: readonly string[] } = {}): Promise<{ plan: ExportOutcome; data: ExportOutcome }> {
  const previous = chains.get(root) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const texts = await readWithRetry(db, () => withSnapshot(db, (view) => {
      const plan = exportPlan(view);
      return { plan, data: exportPortableSnapshot(view), former: formerDbIds(view) };
    }));
    const replaceDbIds = [...texts.former, ...(options.replaceDbIds ?? [])];
    const dataHeader = exportHeaderOf(DATA_EXPORT, texts.data)!;
    const plan = await publishOne(root, PLAN_EXPORT, texts.plan.text, { dbId: texts.plan.dbId, revision: texts.plan.revision, digest: texts.plan.digest }, replaceDbIds);
    const data = await publishOne(root, DATA_EXPORT, texts.data, dataHeader, replaceDbIds);
    return { plan, data };
  });
  const settled = run.catch(() => undefined);
  chains.set(root, settled);
  void settled.then(() => { if (chains.get(root) === settled) chains.delete(root); });
  return run;
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** A link that refuses when the name is taken; a file system without hard links gets an exclusive copy. */
async function createExclusive(from: string, to: string): Promise<boolean> {
  try {
    await (exportSeams.link ?? fs.link)(from, to);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS' && code !== 'EINVAL') throw error;
  }
  try {
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Puts a renamed-aside file, link or directory back at `target` without clobbering anything that appeared there. */
async function restoreAside(aside: string, target: string, isFile: boolean): Promise<void> {
  if (isFile) {
    try {
      if (await createExclusive(aside, target)) {
        await fs.unlink(aside).catch(() => undefined);
        await syncDirectory(path.dirname(target)).catch(() => undefined);
      }
      return;
    } catch {
      // Fall through to rename when createExclusive itself failed (e.g. ENOSPC or copy failure) and target is still absent.
    }
  }
  if (!(await exists(target))) {
    await fs.rename(aside, target).catch(() => undefined);
    await syncDirectory(path.dirname(target)).catch(() => undefined);
  }
}

/** For tests: runs between the judgement and the swap, or replaces fs.link to simulate non-NTFS/disk errors. */
export const exportSeams: {
  beforeSwap?: (file: string) => Promise<void> | void;
  link?: (from: string, to: string) => Promise<void>;
} = {};

async function publishOne(root: string, file: string, text: string, next: ExportHeader, replaceDbIds: readonly string[]): Promise<ExportOutcome> {
  const target = path.join(root, file);
  const target0 = await fs.lstat(target).catch(() => null);
  if (target0 && !target0.isFile()) return 'kept-edit'; // a link or a folder: never written through
  const current = await readOrNull(target);
  const verdict = judgeExport(file, current, next, replaceDbIds);
  if (verdict !== 'replace') return verdict;

  const dot = path.join(root, '.contextspace');
  const drafts = path.join(dot, 'drafts');
  await fs.mkdir(drafts, { recursive: true });
  const tag = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const temp = path.join(dot, `.export-${tag}-${file}`);
  await writeFileSynced(temp, text);
  try {
    await exportSeams.beforeSwap?.(file);
    if (current === null) {
      // nothing was there: someone else's file that appears now wins
      const placed = await createExclusive(temp, target);
      if (placed) await syncDirectory(root);
      return placed ? 'written' : 'kept-save';
    }
    const aside = path.join(drafts, `${tag}-${file}`);
    try {
      await fs.rename(target, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const placed = await createExclusive(temp, target);
        if (placed) await syncDirectory(root);
        return placed ? 'written' : 'kept-save';
      }
      throw error;
    }
    let asideIsFile = false;
    let placed: boolean;
    try {
      asideIsFile = (await fs.lstat(aside)).isFile();
      if (!asideIsFile) {
        // a link or a folder landed between the check and the rename: put it back untouched
        await restoreAside(aside, target, false);
        return 'kept-edit';
      }
      const moved = await readOrNull(aside);
      if (moved !== current) {
        // a save landed between the judgement and the rename: it goes back as the file, or stays as a draft
        await restoreAside(aside, target, true);
        return 'kept-save';
      }
      placed = await createExclusive(temp, target);
    } catch (error) {
      await restoreAside(aside, target, asideIsFile);
      throw error;
    }
    await fs.unlink(aside).catch(() => undefined); // the old export of ours
    await syncDirectory(root);
    return placed ? 'written' : 'kept-save';
  } finally {
    if (await exists(temp)) await fs.unlink(temp).catch(() => undefined);
  }
}
