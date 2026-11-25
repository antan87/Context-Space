import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { execa } from 'execa';
import { beginImmediate, commitTransaction, setMeta, type WorkspaceDb } from './connection.js';
import { DATA_EXPORT, PLAN_EXPORT, visibleDraftKey, type ExportFile } from './export-paths.js';
import { HEADER_LINE } from './plan-text.js';
import { exportDigest } from './plan-io.js';

export { DATA_EXPORT, fetchedDraftBaseKey, PLAN_EXPORT, visibleDraftKey, type ExportFile } from './export-paths.js';
export interface ExportHeader { dbId: string; revision: number; digest: string }
export interface ExportRecord { file: ExportFile; db_id: string; revision: number; digest: string; text: string }
export interface GitReceipt { data: string; plan?: string; base: ExportRecord }

export const byteDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export function planHeader(text: string): ExportHeader | null {
  const match = HEADER_LINE.exec(text.split(/\r?\n/, 1)[0] ?? '');
  return match ? { dbId: match[1]!, revision: Number(match[2]), digest: match[3]! } : null;
}

export function dataHeader(value: unknown): ExportHeader | null {
  if (!value || typeof value !== 'object') return null;
  const { db_id, revision, digest } = value as Record<string, unknown>;
  return typeof db_id === 'string' && Number.isSafeInteger(revision) && Number(revision) >= 0
    && typeof digest === 'string' && /^[a-f0-9]{16}$/.test(digest)
    ? { dbId: db_id, revision: Number(revision), digest } : null;
}

export function readDataExport(text: string) {
  try {
    const { format, version, db_id, revision, digest, base, ...content } = JSON.parse(text) as Record<string, unknown>;
    const header = dataHeader({ db_id, revision, digest });
    if (format !== 'contextspace-data' || version !== 1 || !header) return null;
    if (byteDigest(JSON.stringify(content)).slice(0, 16) !== digest) return null;
    return { header, base: dataHeader(base), content };
  } catch {
    return null;
  }
}

/** A self-consistent header. Provenance still requires a matching local export record. */
export function exportHeaderOf(file: string, text: string): ExportHeader | null {
  if (file === DATA_EXPORT) return readDataExport(text)?.header ?? null;
  const header = planHeader(text);
  return header && exportDigest(text) === header.digest ? header : null;
}

export function latestExport(db: DatabaseSync, file: ExportFile): ExportRecord | undefined {
  return db.prepare('SELECT * FROM exports WHERE file = ? ORDER BY rowid DESC LIMIT 1').get(file) as ExportRecord | undefined;
}

export function findExport(db: DatabaseSync, file: ExportFile, header: ExportHeader | null): ExportRecord | undefined {
  if (!header) return undefined;
  return db.prepare('SELECT * FROM exports WHERE file = ? AND db_id = ? AND revision = ? AND digest = ?')
    .get(file, header.dbId, header.revision, header.digest) as ExportRecord | undefined;
}

async function localArtifactGit(root: string) {
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  const options = { cwd: root, env, extendEnv: false, reject: false, encoding: 'buffer' as const, stripFinalNewline: false, timeout: 2000 };
  const read = async (...args: string[]) => {
    const result = await execa('git', ['--no-optional-locks', ...args], options).catch(() => null);
    if (result?.exitCode !== 0) return;
    const bytes = Buffer.from(result.stdout);
    const text = bytes.toString('utf8');
    return bytes.equals(Buffer.from(text)) ? text : undefined;
  };
  try {
    const top = await read('rev-parse', '--show-toplevel');
    if (top && await fs.realpath(top.trimEnd()) === await fs.realpath(path.resolve(root))) return read;
  } catch {
    // A workspace can publish without a repository or without Git installed.
    return;
  }
}

export const gitCommitId = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
type ArtifactGit = NonNullable<Awaited<ReturnType<typeof localArtifactGit>>>;

async function dataAt(read: ArtifactGit, ref: string): Promise<ExportRecord | undefined> {
  const text = await read('cat-file', 'blob', `${ref}:${DATA_EXPORT}`);
  const header = text && readDataExport(text)?.header;
  if (text && header) return { file: DATA_EXPORT, db_id: header.dbId, revision: header.revision, digest: header.digest, text };
}

/** Read a committed artifact only from the workspace's own repository. */
export async function committedDataExport(root: string, ref = 'HEAD'): Promise<ExportRecord | undefined> {
  if (!['HEAD', 'HEAD^', 'ORIG_HEAD'].includes(ref) && !gitCommitId(ref)) return;
  const read = await localArtifactGit(root);
  return read ? dataAt(read, ref) : undefined;
}

export async function committedPlanExport(root: string, ref: string): Promise<string | undefined> {
  if (ref !== 'HEAD' && !gitCommitId(ref)) return;
  const read = await localArtifactGit(root);
  return read?.('cat-file', 'blob', `${ref}:${PLAN_EXPORT}`);
}

/** Recognize only Git's configured built-in line-ending conversion of the bytes committed at HEAD. */
export async function committedCheckoutText(root: string, file: ExportFile, text: string): Promise<string> {
  if (!text.includes('\r\n')) return text;
  const read = await localArtifactGit(root);
  if (!read) return text;
  const blob = await read('cat-file', 'blob', `HEAD:${file}`);
  if (!blob || blob === text || blob.includes('\r') || blob.replace(/\n/g, '\r\n') !== text) return text;
  const attr = (await read('check-attr', '-z', 'text', 'eol', 'filter', 'working-tree-encoding', '--', file))?.split('\0');
  if (!attr || attr.length < 12) return text;
  const [, , textMode, , , eol, , , filter, , , encoding] = attr;
  const inactive = (value: string | undefined) => value === 'unspecified' || value === 'unset';
  if (textMode === 'unset' || eol === 'lf' || !inactive(filter) || !inactive(encoding)) return text;
  if (eol === 'crlf' || (await read('config', '--bool', '--get', 'core.autocrlf'))?.trim() === 'true') return blob;
  return text;
}

/** A direct Git pull can skip past the declared base. Only an ancestor of the exact checked out pair is proof. */
export async function committedAncestorBase(root: string, data: string, plan: string | undefined, digest: string): Promise<ExportRecord | undefined> {
  const read = await localArtifactGit(root);
  if (!read) return;
  const head = await read('rev-parse', '--verify', 'HEAD^{commit}');
  const commit = head?.trim();
  if (!commit || !gitCommitId(commit)) return;
  const [current, planBlob] = await Promise.all([dataAt(read, commit), read('cat-file', 'blob', `${commit}:${PLAN_EXPORT}`)]);
  if (current?.text !== data || (planBlob !== plan && (!plan || planBlob !== await committedCheckoutText(root, PLAN_EXPORT, plan)))) return;
  const before = (await read('rev-parse', '--verify', 'ORIG_HEAD^{commit}'))?.trim();
  if (before && before !== commit && gitCommitId(before) && await read('merge-base', '--is-ancestor', before, commit) !== undefined) {
    const record = await dataAt(read, before);
    if (record?.digest === digest) return record;
  }
  const recent = await read('rev-list', '--first-parent', '--max-count=12', commit, '--', DATA_EXPORT);
  for (const ancestor of recent?.trim().split('\n') ?? []) {
    if (ancestor === commit || ancestor === before || !gitCommitId(ancestor)) continue;
    if (await read('merge-base', '--is-ancestor', ancestor, commit) === undefined) continue;
    const record = await dataAt(read, ancestor);
    if (record?.digest === digest) return record;
  }
}

/** A plain Git pull advances HEAD before the app can look. Only trust its parent for HEAD's own snapshot. */
export async function committedDataBase(root: string, text: string, header: ExportHeader | null): Promise<ExportRecord | undefined> {
  if (!header) return;
  const matches = (record: ExportRecord | undefined): boolean =>
    record?.db_id === header.dbId && record.revision === header.revision && record.digest === header.digest;
  const head = await committedDataExport(root);
  if (matches(head)) return head;
  if (head?.text === text) {
    const parent = await committedDataExport(root, 'HEAD^');
    if (matches(parent)) return parent;
  }
}

/** Record a publication and prune history inside the caller's SQLite transaction. */
export function storeExport(db: DatabaseSync, file: ExportFile, text: string): void {
  const header = exportHeaderOf(file, text);
  if (!header) throw new Error(`Cannot record an invalid ${file} export.`);
  db.prepare('INSERT OR REPLACE INTO exports(file, revision, db_id, digest, text) VALUES (?, ?, ?, ?, ?)')
    .run(file, header.revision, header.dbId, header.digest, text);
  db.prepare('DELETE FROM exports WHERE file = ? AND rowid NOT IN (SELECT rowid FROM exports WHERE file = ? ORDER BY rowid DESC LIMIT 5)').run(file, file);
  setMeta(db, visibleDraftKey(file), '');
}

/** Caller owns the workspace write fence. Each recorded export and its retention update commit together. */
export async function recordExport(db: WorkspaceDb, file: ExportFile, text: string): Promise<void> {
  await writeExportMetadata(db, () => {
    if (latestExport(db.sqlite, file)?.text === text) setMeta(db.sqlite, visibleDraftKey(file), '');
    else storeExport(db.sqlite, file, text);
  });
}

/** Short metadata writes share the bounded commit retry used by full database batches. */
export function writeExportMetadata<T>(db: WorkspaceDb, write: () => T): Promise<T> {
  return db.serialize(async () => {
    await beginImmediate(db);
    try {
      const result = write();
      await commitTransaction(db);
      return result;
    } catch (error) {
      try { db.sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
      throw error;
    }
  });
}
