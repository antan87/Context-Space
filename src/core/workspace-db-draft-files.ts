import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertNoLinkedPathComponents, syncDirectory, writeFileSynced } from '../resources/fs-safety.js';
import { PlanFileError } from './plan-file.js';
import { byteDigest, DATA_EXPORT, planHeader, readDataExport, writeExportMetadata, type ExportFile } from './workspace-db/export-records.js';
import type { WorkspaceDb } from './workspace-db/index.js';

export interface DraftRecord {
  digest: string;
  file: ExportFile;
  path: string;
  at: string;
  status: 'pending' | 'imported' | 'discarded';
}

export const draftDir = (root: string) => path.join(root, '.contextspace', 'drafts');
export const FORMER_EXPORT = /^\.former-(\d+-[a-f0-9]+)-(PLAN\.md|contextspace-data\.json)-([a-f0-9]{64})-(-?\d+)-(\d+)$/;
export const fileErrorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
export const statOrNull = (file: string) => fs.lstat(file, { bigint: true }).catch((error: unknown) => {
  if (fileErrorCode(error) === 'ENOENT') return null;
  throw error;
});

/** Older moved workspaces predate the draft ignore rules. Keep their local captures out of Git, too. */
export async function keepDraftPathsLocal(root: string): Promise<void> {
  const git = path.join(root, '.git');
  if (!(await statOrNull(git))?.isDirectory()) return;
  const exclude = path.join(git, 'info', 'exclude');
  await assertNoLinkedPathComponents(root, exclude);
  const before = (await readExportBytes(exclude))?.toString('utf8') ?? '';
  const rules = ['/.contextspace/drafts/', '/.contextspace/.export-*'];
  const missing = rules.filter((rule) => !before.split(/\r?\n/).includes(rule));
  if (!missing.length) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  const handle = await fs.open(exclude, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0));
  try { await handle.appendFile(`${before && !before.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`); }
  finally { await handle.close(); }
}

/** A regular file only, read from one descriptor so a rename cannot splice together two saves. */
export async function readExportBytes(file: string): Promise<Buffer | null> {
  if (!(await statOrNull(file))?.isFile()) return null;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch((error: unknown) => {
    if (['ENOENT', 'ELOOP', 'EISDIR'].includes(fileErrorCode(error) ?? '')) return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await statOrNull(file);
    if (!opened.isFile() || !named?.isFile() || opened.ino !== named.ino || (named.dev !== 0n && opened.dev !== named.dev)) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export const draftByDigest = (db: WorkspaceDb, digest: string): DraftRecord | undefined =>
  db.sqlite.prepare('SELECT digest, file, path, at, status FROM drafts WHERE digest = ?').get(digest) as DraftRecord | undefined;

export function finishDraft(db: WorkspaceDb, digest: string, status: 'imported' | 'discarded'): void {
  db.sqlite.prepare("UPDATE drafts SET status = ? WHERE digest = ? AND status = 'pending'").run(status, digest);
}

export function pendingDrafts(db: WorkspaceDb): DraftRecord[] {
  return db.sqlite.prepare("SELECT digest, file, path, at, status FROM drafts WHERE status = 'pending' ORDER BY at, rowid").all() as unknown as DraftRecord[];
}

function register(db: WorkspaceDb, file: ExportFile, relative: string, bytes: Buffer, at: string): Promise<void> {
  const text = bytes.toString('utf8');
  const base = file === DATA_EXPORT ? readDataExport(text)?.base : planHeader(text);
  return writeExportMetadata(db, () => {
    db.sqlite.prepare('INSERT OR IGNORE INTO drafts(digest, file, path, at, base_revision) VALUES (?, ?, ?, ?, ?)')
      .run(byteDigest(bytes), file, relative, at, base?.revision ?? null);
  });
}

/** Copy original bytes before registering their digest. A crash can leave a copy to register on the next pass. */
export async function keepDraft(root: string, db: WorkspaceDb, file: ExportFile, bytes: Buffer, reopen = false): Promise<DraftRecord> {
  const digest = byteDigest(bytes);
  const existing = draftByDigest(db, digest);
  if (existing) {
    if (!reopen || existing.status === 'pending') return existing;
    return writeExportMetadata(db, () => {
      db.sqlite.prepare("UPDATE drafts SET status = 'pending', at = ? WHERE digest = ?").run(new Date().toISOString(), digest);
      return draftByDigest(db, digest)!;
    });
  }
  const dir = draftDir(root);
  await assertNoLinkedPathComponents(root, dir);
  await fs.mkdir(dir, { recursive: true });
  const time = Date.now();
  const name = `${time}-${randomUUID()}-${file}`;
  const temporary = path.join(dir, `.capture-${name}`);
  await writeFileSynced(temporary, bytes);
  await fs.rename(temporary, path.join(dir, name));
  await syncDirectory(dir);
  await register(db, file, `.contextspace/drafts/${name}`, bytes, new Date(time).toISOString());
  return draftByDigest(db, digest)!;
}

const COPY_NAME = /^(\d{13})-[a-f\d-]{36}-(PLAN\.md|contextspace-data\.json)$/;

export async function recoverDraftCopies(root: string, db: WorkspaceDb, names: string[]): Promise<void> {
  const known = new Set((db.sqlite.prepare('SELECT path FROM drafts').all() as Array<{ path: string }>).map((row) => row.path));
  for (const name of names) {
    const relative = `.contextspace/drafts/${name}`;
    const match = COPY_NAME.exec(name);
    if (!match || known.has(relative)) continue;
    const bytes = await readExportBytes(path.join(root, relative));
    if (bytes) await register(db, match[2] as ExportFile, relative, bytes, new Date(Number(match[1])).toISOString());
  }
}

export async function readDraft(root: string, draft: DraftRecord): Promise<Buffer> {
  const name = path.posix.basename(draft.path);
  if (!COPY_NAME.test(name) || draft.path !== `.contextspace/drafts/${name}`) throw new PlanFileError('The draft path is invalid.', 'invalid');
  const target = path.join(draftDir(root), name);
  await assertNoLinkedPathComponents(root, target);
  const bytes = await readExportBytes(target);
  if (!bytes || byteDigest(bytes) !== draft.digest) throw new PlanFileError('The saved draft changed or is missing. Its original digest could not be verified.', 'conflict');
  return bytes;
}
