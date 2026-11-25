import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertWorkspaceActive, isArchived } from './archive-guard.js';
import { PlanFileError } from './plan-file.js';
import { loadFeatureConfig } from './workspace.js';
import { storeOf } from './workspace-db-app.js';
import { draftByDigest, draftDir, fileErrorCode, finishDraft, FORMER_EXPORT, keepDraft, pendingDrafts, readDraft, statOrNull } from './workspace-db-draft-files.js';
import { publishExports } from './workspace-db-exports.js';
import { getMeta, readWithRetry, setMeta, withSnapshot, type WorkspaceDb } from './workspace-db/index.js';
import { applyDraftMerge, buildDraftMerge, type DraftPreview } from './workspace-db/draft-merge.js';
import { committedDataBase, committedDataExport, DATA_EXPORT, fetchedDraftBaseKey, findExport, gitCommitId, PLAN_EXPORT, planHeader, readDataExport, writeExportMetadata, type GitReceipt } from './workspace-db/export-records.js';
import { bodyOf } from './workspace-db/plan-text.js';

export type { DraftPreview };
export const DRAFT_DIGEST = /^[a-f0-9]{64}$/;

export type DraftAction =
  | { type: 'draft-refresh'; gitReceipt?: GitReceipt }
  | { type: 'draft-capture-git'; data: string; mergeBase: string }
  | { type: 'draft-list' }
  | { type: 'draft-preview'; digest: string }
  | { type: 'draft-import'; digest: string; token: string; by: string }
  | { type: 'draft-discard'; digest: string };

export type DraftSummary = { digest: string; file: typeof PLAN_EXPORT | typeof DATA_EXPORT; path: string; at: string; bytes: number; added: number; removed: number };
export type DraftImport = { ok: true; revision: number } | { ok: false; preview?: DraftPreview; error: string };

export interface DraftResults {
  'draft-refresh': boolean;
  'draft-capture-git': { digest: string; status: 'pending' | 'imported' | 'discarded' };
  'draft-list': { drafts: DraftSummary[] };
  'draft-preview': DraftPreview;
  'draft-import': DraftImport;
  'draft-discard': { ok: true };
}

export function pendingDraftInfo(db: WorkspaceDb) {
  const drafts = pendingDrafts(db);
  return { pendingDrafts: drafts.length, pendingDraftDigest: drafts.at(-1)?.digest };
}

/** A cheap poll check includes both export names, their in-place writes, and newly created draft copies. */
export async function exportDiskSignature(root: string): Promise<string> {
  const drafts = draftDir(root);
  const names = await fs.readdir(drafts).catch((error: unknown) => {
    if (fileErrorCode(error) === 'ENOENT') return [];
    throw error;
  });
  const pendingInodes = names.filter((name) => FORMER_EXPORT.test(name)).sort();
  const paths = [path.join(root, PLAN_EXPORT), path.join(root, DATA_EXPORT), drafts, ...pendingInodes.map((name) => path.join(drafts, name))];
  const stats = await Promise.all(paths.map(statOrNull));
  return stats.map((stat) => stat ? [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : '').join('/');
}

export async function doDraftAction(root: string, db: WorkspaceDb, action: DraftAction): Promise<DraftResults[DraftAction['type']]> {
  const feature = await loadFeatureConfig(root);
  if (action.type === 'draft-capture-git') {
    assertWorkspaceActive(feature, 'capture a Git draft');
    if (!gitCommitId(action.mergeBase) || !readDataExport(action.data)) throw new PlanFileError('The fetched snapshot could not be verified.', 'invalid');
    const draft = await keepDraft(root, db, DATA_EXPORT, Buffer.from(action.data));
    await writeExportMetadata(db, () => setMeta(db.sqlite, fetchedDraftBaseKey(draft.digest), action.mergeBase));
    return { digest: draft.digest, status: draft.status };
  }
  if (action.type === 'draft-import' || action.type === 'draft-discard') assertWorkspaceActive(feature, 'handle plan drafts');
  const active = !isArchived(feature);
  if (active) await publishExports(root, db, action.type === 'draft-refresh' ? { gitReceipt: action.gitReceipt } : {});
  if (action.type === 'draft-refresh') return active;
  if (action.type === 'draft-list') {
    const drafts = await readWithRetry(db, () => withSnapshot(db, pendingDrafts));
    return { drafts: await Promise.all(drafts.map(async (draft) => {
      try {
        const bytes = await readDraft(root, draft);
        const text = bytes.toString('utf8');
        const header = draft.file === PLAN_EXPORT ? planHeader(text) : readDataExport(text)?.base;
        const [base, fetchedBase] = await readWithRetry(db, () => withSnapshot(db, (view) =>
          [findExport(view.sqlite, draft.file, header ?? null), getMeta(view.sqlite, fetchedDraftBaseKey(draft.digest))] as const));
        const origin = fetchedBase ? await committedDataExport(root, fetchedBase) : undefined;
        const body = (value: string) => draft.file === PLAN_EXPORT ? bodyOf(value) : value;
        return { digest: draft.digest, file: draft.file, path: draft.path, at: draft.at, bytes: bytes.length, ...lineCounts(body(origin?.text ?? base?.text ?? ''), body(text)) };
      } catch (error) {
        if (!(error instanceof PlanFileError)) throw error;
        // An unreadable copy still appears in the notice and can be handled by digest.
        return { digest: draft.digest, file: draft.file, path: draft.path, at: draft.at, bytes: 0, added: 0, removed: 0 };
      }
    })) };
  }
  if (!DRAFT_DIGEST.test(action.digest)) throw new PlanFileError('Use the full draft digest from ctxspace plan drafts.', 'invalid');
  const draft = await readWithRetry(db, () => withSnapshot(db, (view) => draftByDigest(view, action.digest)));
  if (!draft || draft.status !== 'pending') {
    if ((action.type === 'draft-discard' && draft?.status === 'discarded') || (action.type === 'draft-import' && draft?.status === 'imported')) {
      return action.type === 'draft-discard' ? { ok: true } : {
        ok: true, revision: Number(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'revision'").get()?.value),
      };
    }
    throw new PlanFileError('That draft is no longer pending. Read the draft list again.', 'not_found');
  }
  if (action.type === 'draft-discard') {
    // Validate that the original bytes still exist before making the file eligible for replacement.
    await readDraft(root, draft);
    await writeExportMetadata(db, () => finishDraft(db, draft.digest, 'discarded'));
    await publishExports(root, db);
    return { ok: true };
  }
  const bytes = await readDraft(root, draft);
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text))) throw new PlanFileError('The draft is not valid UTF-8. The original bytes are still saved.', 'invalid');
  const header = draft.file === DATA_EXPORT ? readDataExport(text)?.base : null;
  const known = header && await readWithRetry(db, () => withSnapshot(db, (view) => findExport(view.sqlite, DATA_EXPORT, header)));
  const fetchedBase = draft.file === DATA_EXPORT ? await readWithRetry(db, () => getMeta(db.sqlite, fetchedDraftBaseKey(draft.digest))) : undefined;
  const gitBase = (fetchedBase ? await committedDataExport(root, fetchedBase) : undefined)
    ?? (header && !known ? await committedDataBase(root, text, header) : undefined);
  const merge = await readWithRetry(db, () => withSnapshot(db, (view) => buildDraftMerge(view, draft.file, draft.digest, text, gitBase)));
  if (action.type === 'draft-preview') return merge.preview;
  const moved = (preview: DraftPreview): DraftImport => ({ ok: false, error: 'The workspace changed. Review this preview and confirm again.', preview });
  if (merge.preview.token !== action.token) return moved(merge.preview);
  await readDraft(root, draft);
  const result = await applyDraftMerge(db, merge, action.by, () => finishDraft(db, draft.digest, 'imported'), false, draft.file === DATA_EXPORT && merge.preview.baseKnown);
  if (!result.ok) {
    if (result.errors.some(({ code }) => ['db_changed', 'stale_revision', 'bad_revision'].includes(code))) {
      return moved(await readWithRetry(db, () => withSnapshot(db, (view) => buildDraftMerge(view, draft.file, draft.digest, text, gitBase).preview)));
    }
    return { ok: false, error: result.errors.map(({ message }) => message).join('\n') };
  }
  await publishExports(root, db);
  return { ok: true, revision: result.revision };
}

function lineCounts(base: string, edited: string): { added: number; removed: number } {
  const lines = (text: string) => text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const original = lines(base);
  const draft = lines(edited);
  const counts = new Map<string, number>();
  for (const line of original) counts.set(line, (counts.get(line) ?? 0) + 1);
  let shared = 0;
  for (const line of draft) {
    const count = counts.get(line) ?? 0;
    if (!count) continue;
    counts.set(line, count - 1);
    shared++;
  }
  return { added: draft.length - shared, removed: original.length - shared };
}

export function requireDraftDatabase(root: string): void {
  if (storeOf(root) === 'files') throw new PlanFileError('Plan drafts are available after this workspace moves to its database.', 'invalid');
}
