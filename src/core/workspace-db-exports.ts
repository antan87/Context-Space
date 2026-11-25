/** Publishes the moved workspace's export pair under the workspace write fence. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertNoLinkedPathComponents, syncDirectory, writeFileSynced } from '../resources/fs-safety.js';
import { getMeta, getRevision, readImportRecord, readWithRetry, setMeta, withSnapshot, type WorkspaceDb } from './workspace-db/index.js';
import { applyDraftMerge, buildDraftMerge, liveExportText, matchesPulledPlan } from './workspace-db/draft-merge.js';
import {
  byteDigest, committedAncestorBase, committedCheckoutText, committedDataBase, committedDataExport, DATA_EXPORT, exportHeaderOf, findExport, latestExport, PLAN_EXPORT, readDataExport, recordExport, storeExport, visibleDraftKey, writeExportMetadata,
  type ExportFile, type ExportRecord, type GitReceipt,
} from './workspace-db/export-records.js';
import { draftByDigest, draftDir, fileErrorCode, finishDraft, FORMER_EXPORT, keepDraft, keepDraftPathsLocal, readExportBytes, recoverDraftCopies, statOrNull } from './workspace-db-draft-files.js';

export type ExportOutcome = 'written' | 'unchanged' | 'kept-edit' | 'newer' | 'kept-save';

const files = [PLAN_EXPORT, DATA_EXPORT] as const;
const bytesEqual = (left: Buffer | null, right: Buffer | null) => left === null ? right === null : right !== null && left.equals(right);
const entries = (dir: string) => fs.readdir(dir).catch((error: unknown) => {
  if (fileErrorCode(error) === 'ENOENT') return [];
  throw error;
});

function formerDbIds(view: WorkspaceDb): string[] {
  try {
    const parsed: unknown = JSON.parse(getMeta(view.sqlite, 'former_db_ids') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function formerExportHashes(view: WorkspaceDb): Partial<Record<ExportFile, string>> {
  try {
    const hashes = JSON.parse(getMeta(view.sqlite, 'former_export_hashes') ?? '{}');
    return Object.fromEntries(files.filter((file) => typeof hashes?.[file] === 'string').map((file) => [file, hashes[file]]));
  } catch {
    return {};
  }
}

const chains = new Map<string, Promise<unknown>>();

export function publishExports(root: string, db: WorkspaceDb, options: { replaceDbIds?: readonly string[]; gitReceipt?: GitReceipt; restore?: boolean } = {}): Promise<{ plan: ExportOutcome; data: ExportOutcome }> {
  const previous = chains.get(root) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => publishPair(root, db, options));
  chains.set(root, run);
  void run.finally(() => { if (chains.get(root) === run) chains.delete(root); }).catch(() => undefined);
  return run;
}

async function publishPair(root: string, db: WorkspaceDb, options: { replaceDbIds?: readonly string[]; gitReceipt?: GitReceipt; restore?: boolean }) {
  const dot = path.join(root, '.contextspace');
  const drafts = draftDir(root);
  await assertNoLinkedPathComponents(root, drafts);
  // A private Git rule is optional on non-Git workspaces or where Git metadata cannot be written.
  await keepDraftPathsLocal(root).catch(() => undefined);
  const names = await entries(drafts);
  await recoverDraftCopies(root, db, names);
  await recoverSwaps(root, db, await entries(dot), names);
  await observeFormerExports(root, db, names);
  let view = await readWithRetry(db, () => withSnapshot(db, (snapshot) => ({
    plan: liveExportText(snapshot, PLAN_EXPORT), data: liveExportText(snapshot, DATA_EXPORT), revision: getRevision(snapshot),
    former: [...formerDbIds(snapshot), ...(options.replaceDbIds ?? [])], formerExports: formerExportHashes(snapshot),
  })));
  const visible = await Promise.all(files.map((file) => readExportBytes(path.join(root, file))));
  const captured = await Promise.all(visible.map(async (bytes, index) => {
    if (!bytes) return null;
    const text = bytes.toString('utf8');
    const file = files[index]!;
    if (!text.includes('\r\n') || !bytes.equals(Buffer.from(text)) || latestExport(db.sqlite, file)?.text === text
      || (file === PLAN_EXPORT && exportHeaderOf(file, text))) return bytes;
    const proven = await committedCheckoutText(root, file, text);
    return proven === text ? bytes : Buffer.from(proven);
  }));
  const [plan, data] = captured as [Buffer | null, Buffer | null];
  const planText = plan?.toString('utf8');
  const dataText = data?.toString('utf8');
  const importRecord = readImportRecord(db);
  const publishedHashes = importRecord?.exports as { plan?: string; data?: string } | undefined;
  const acceptedHere = (file: ExportFile, digest: string) =>
    getMeta(db.sqlite, `accepted_git_${file}`) === `${view.revision.dbId}:${digest}`;

  // DB3c workspaces have no publication history. Seed only bytes proven by the cutover record or the live database.
  for (const [index, file] of files.entries()) {
    const current = captured[index];
    if (latestExport(db.sqlite, file)) continue;
    const canonical = index === 0 ? view.plan : view.data;
    const initialHash = index === 0 ? publishedHashes?.plan : publishedHashes?.data;
    const old = current?.toString('utf8');
    const header = old !== undefined && exportHeaderOf(file, old);
    const live = exportHeaderOf(file, canonical)!;
    if (current && header && (byteDigest(current) === initialHash
      || (header.dbId === live.dbId && header.revision <= live.revision && header.digest === live.digest))) {
      await recordExport(db, file, old!);
    } else if (byteDigest(canonical) === initialHash) {
      await recordExport(db, file, canonical);
    }
  }

  const isReplaceable = (file: ExportFile, bytes: Buffer | null) => {
    if (!bytes) return true;
    const old = bytes.toString('utf8');
    const latest = latestExport(db.sqlite, file);
    const header = exportHeaderOf(file, old);
    const digest = byteDigest(bytes);
    if (view.formerExports[file] === digest && latest?.db_id !== view.revision.dbId) return true;
    if (header && latest?.db_id !== view.revision.dbId && view.former.includes(header.dbId)) {
      // The backup's `exports` history may end earlier than the file this restore replaced.
      const previous = view.formerExports[file];
      if (previous ? previous === digest : !latest || bytes.equals(Buffer.from(latest.text))) return true;
    } else if (latest?.text === old && bytes.equals(Buffer.from(old))) return true;
    const saved = draftByDigest(db, digest);
    return saved !== undefined && saved.status !== 'pending' && getMeta(db.sqlite, visibleDraftKey(file)) === digest;
  };

  for (const [index, file] of files.entries()) {
    const current = captured[index];
    const observed = getMeta(db.sqlite, visibleDraftKey(file));
    if (observed && (!current || byteDigest(current) !== observed || current.equals(Buffer.from(latestExport(db.sqlite, file)?.text ?? '')))) {
      await writeExportMetadata(db, () => setMeta(db.sqlite, visibleDraftKey(file), ''));
    }
  }

  const incoming = data && dataText !== undefined && data.equals(Buffer.from(dataText))
    && !isReplaceable(DATA_EXPORT, data) ? readDataExport(dataText) : null;
  const pulledPair = Boolean(data && planText !== undefined && (incoming || draftByDigest(db, byteDigest(data)))
    && matchesPulledPlan(planText, dataText!));
  // A hand edit can sit beside a Git pull. Save it before any database or file change.
  if (plan && !isReplaceable(PLAN_EXPORT, plan) && !pulledPair) await observeDraft(root, db, PLAN_EXPORT, plan);
  if (data && !isReplaceable(DATA_EXPORT, data)) {
    const firstObservation = !draftByDigest(db, byteDigest(data));
    const draft = await observeDraft(root, db, DATA_EXPORT, data);
    const current = exportHeaderOf(DATA_EXPORT, view.data)!;
    const older = incoming && findExport(db.sqlite, DATA_EXPORT, incoming.header);
    if (firstObservation && !options.restore && incoming && !older) {
      const receipt = options.gitReceipt;
      const pinned = receipt && receipt.data === dataText && (receipt.plan === planText
        || (planText && receipt.plan === await committedCheckoutText(root, PLAN_EXPORT, planText))) ? receipt.base : undefined;
      const declared = findExport(db.sqlite, DATA_EXPORT, incoming.base) ?? await committedDataBase(root, dataText!, incoming.base);
      const base = [pinned, declared].find((candidate) => candidate?.digest === current.digest)
        ?? await committedAncestorBase(root, dataText!, planText, current.digest);
      // Use the same transaction as Import once the exact incoming snapshot and its base are proven.
      const merged = base && tryPulledMerge(db, draft.digest, dataText!, base);
      if (merged) {
        const result = await applyDraftMerge(db, merged, 'git', () => {
          finishDraft(db, draft.digest, 'imported');
          storeExport(db.sqlite, DATA_EXPORT, dataText!);
          setMeta(db.sqlite, `accepted_git_${DATA_EXPORT}`, `${view.revision.dbId}:${draft.digest}`);
          if (pulledPair && plan && planText && plan.equals(Buffer.from(planText))) {
            storeExport(db.sqlite, PLAN_EXPORT, planText);
            setMeta(db.sqlite, `accepted_git_${PLAN_EXPORT}`, `${view.revision.dbId}:${byteDigest(plan)}`);
          }
        }, true).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR') return null;
          throw error;
        });
        if (result?.ok) {
          view = await readWithRetry(db, () => withSnapshot(db, (snapshot) => ({
            ...view, plan: liveExportText(snapshot, PLAN_EXPORT), data: liveExportText(snapshot, DATA_EXPORT), revision: getRevision(snapshot),
          })));
        }
      }
    }
  }
  // A poll may have seen the plan before Git finished writing the data file. Its saved copy still stays on disk.
  if (pulledPair && plan) {
    const digest = byteDigest(plan);
    if (draftByDigest(db, digest)?.status === 'pending') await writeExportMetadata(db, () => finishDraft(db, digest, 'discarded'));
  }
  const replaceData = isReplaceable(DATA_EXPORT, data);
  const replacePlan = pulledPair ? replaceData : isReplaceable(PLAN_EXPORT, plan);
  const latestIsCurrent = (record: ExportRecord) =>
    record.db_id === view.revision.dbId || acceptedHere(record.file, byteDigest(record.text));
  const latestPlan = latestExport(db.sqlite, PLAN_EXPORT);
  const latestData = latestExport(db.sqlite, DATA_EXPORT);
  const sameContent = (record: ExportRecord, text: string) =>
    latestIsCurrent(record) && record.digest === exportHeaderOf(record.file, text)?.digest;
  const nextPlan = latestPlan && sameContent(latestPlan, view.plan) ? latestPlan.text : view.plan;
  let nextData = view.data;
  if (latestData && sameContent(latestData, view.data)) nextData = latestData.text;
  else if (replaceData) {
    const nextBase = (await committedDataExport(root)) ?? (latestData && latestIsCurrent(latestData) ? latestData : undefined);
    if (nextBase) nextData = addBaseHeader(nextData, nextBase);
  }

  const planResult = await publishOne(root, db, PLAN_EXPORT, nextPlan, visible[0]!, plan, view.revision, replacePlan, Boolean(plan && acceptedHere(PLAN_EXPORT, byteDigest(plan))));
  const dataResult = await publishOne(root, db, DATA_EXPORT, nextData, visible[1]!, data, view.revision, replaceData, Boolean(data && acceptedHere(DATA_EXPORT, byteDigest(data))));
  return { plan: planResult, data: dataResult };
}

function tryPulledMerge(db: WorkspaceDb, digest: string, text: string, base: ExportRecord) {
  try {
    return withSnapshot(db, (view) => buildDraftMerge(view, DATA_EXPORT, digest, text, base));
  } catch {
    // An unreadable or inconsistent snapshot keeps its pending draft and can be inspected or discarded.
    return null;
  }
}

function addBaseHeader(text: string, base: ExportRecord): string {
  const { format, version, db_id, revision, digest, ...content } = JSON.parse(text);
  return `${JSON.stringify({ format, version, db_id, revision, digest,
    base: { db_id: base.db_id, revision: base.revision, digest: base.digest }, ...content }, null, 2)}\n`;
}

/** A link refuses when the name is taken. Filesystems without hard links get an exclusive copy. */
async function createExclusive(from: string, to: string): Promise<boolean> {
  try {
    await (exportSeams.link ?? fs.link)(from, to);
    return true;
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes(code ?? '')) throw error;
  }
  try {
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (fileErrorCode(error) === 'EEXIST') return false;
    throw error;
  }
}

async function restoreAside(aside: string, target: string, isFile: boolean): Promise<boolean> {
  if (isFile) {
    try {
      if (!await createExclusive(aside, target)) return false;
    } catch {
      // If linking itself failed, restoration still needs to leave any intervening save alone.
      try { await fs.copyFile(aside, target, fs.constants.COPYFILE_EXCL); }
      catch (error) {
        if (fileErrorCode(error) === 'EEXIST') return false;
        throw error;
      }
    }
    // An exclusive copy can restore the public name without keeping the editor's inode there.
    const [moved, visible] = await Promise.all([statOrNull(aside), statOrNull(target)]);
    if (moved && visible && moved.ino !== 0n && moved.ino === visible.ino && moved.dev === visible.dev) await fs.unlink(aside);
  } else {
    if (await statOrNull(target)) return false;
    await fs.rename(aside, target);
  }
  await syncDirectory(path.dirname(target));
  return true;
}

async function observeDraft(root: string, db: WorkspaceDb, file: ExportFile, bytes: Buffer) {
  const digest = byteDigest(bytes);
  const key = visibleDraftKey(file);
  const newAppearance = getMeta(db.sqlite, key) !== digest;
  const draft = await keepDraft(root, db, file, bytes, newAppearance);
  if (newAppearance) await writeExportMetadata(db, () => setMeta(db.sqlite, key, digest));
  return draft;
}

/** An already-open editor can keep writing through a renamed inode long after publication. */
async function retainFormerExport(root: string, db: WorkspaceDb, source: string, tag: string, file: ExportFile, baseline: string) {
  const stat = await statOrNull(source);
  if (!stat?.isFile()) return;
  const bytes = await readExportBytes(source);
  if (!bytes) return;
  const digest = byteDigest(bytes);
  if (digest !== baseline) await keepDraft(root, db, file, bytes, true);
  const retained = path.join(draftDir(root), `.former-${tag}-${file}-${digest}-${stat.mtimeNs}-${stat.size}`);
  if (source !== retained) {
    await fs.rename(source, retained);
    await syncDirectory(draftDir(root));
  }
}

async function observeFormerExports(root: string, db: WorkspaceDb, names: string[]) {
  for (const name of names) {
    const former = FORMER_EXPORT.exec(name);
    if (!former) continue;
    const source = path.join(draftDir(root), name);
    const stat = await statOrNull(source);
    if (stat?.isFile() && (String(stat.mtimeNs) !== former[4] || String(stat.size) !== former[5])) {
      await retainFormerExport(root, db, source, former[1]!, former[2] as ExportFile, former[3]!);
    }
  }
}

/** A staged file that is already at the public name was linked before its SQLite record could be saved. */
async function recoverSwaps(root: string, db: WorkspaceDb, dotNames: string[], draftNames: string[]): Promise<void> {
  const dot = path.join(root, '.contextspace');
  const drafts = draftDir(root);
  for (const name of dotNames) {
    const match = /^\.export-(\d+-[0-9a-f]+)-(PLAN\.md|contextspace-data\.json)(?:-([a-f0-9]{64}))?(?:-([a-f0-9]{64}))?$/.exec(name);
    if (!match) continue;
    const file = match[2] as ExportFile;
    const target = path.join(root, file);
    const temp = path.join(dot, name);
    const aside = path.join(drafts, `.swap-${match[1]}-${file}`);
    const [next, visible, moved] = await Promise.all([readExportBytes(temp), readExportBytes(target), readExportBytes(aside)]);
    const latest = latestExport(db.sqlite, file);
    const staged = next && (match[3] ? byteDigest(next) === match[3] : Boolean(exportHeaderOf(file, next.toString('utf8'))));
    const wasPlaced = staged && visible?.equals(next!);
    const former = moved && wasPlaced && findExport(db.sqlite, file, exportHeaderOf(file, moved.toString('utf8')));
    if (moved && !moved.equals(Buffer.from(latest?.text ?? '')) && (former || undefined)?.text !== moved.toString('utf8')
      && !draftByDigest(db, byteDigest(moved))) {
      // Keep the editor's bytes even if a second save already took the public name.
      await keepDraft(root, db, file, moved);
    }
    if (wasPlaced && next) {
      await syncDirectory(root);
      await recordExport(db, file, next.toString('utf8'));
    }
    const asideStat = await statOrNull(aside);
    if (asideStat && !await statOrNull(target)) await restoreAside(aside, target, asideStat.isFile());
    if (moved && await statOrNull(aside)) {
      await retainFormerExport(root, db, aside, match[1]!, file, match[4] ?? byteDigest(moved));
    }
    if (asideStat && !moved && await statOrNull(aside)) continue; // Keep a non-file that has nowhere to return to.
    await fs.unlink(temp);
  }
  // DB3b could leave a renamed-aside save when a second save took its place.
  for (const name of draftNames) {
    const match = /^\d+-[a-f0-9]{8}-(PLAN\.md|contextspace-data\.json)$/.exec(name);
    if (!match) continue;
    const file = match[1] as ExportFile;
    const bytes = await readExportBytes(path.join(drafts, name));
    if (bytes && !bytes.equals(Buffer.from(latestExport(db.sqlite, file)?.text ?? ''))) await keepDraft(root, db, file, bytes);
  }
}

/** Seams between judging and swapping, and when placing the new export. */
export const exportSeams: {
  beforeSwap?: (file: string) => Promise<void> | void;
  link?: (from: string, to: string) => Promise<void>;
} = {};

async function publishOne(
  root: string, db: WorkspaceDb, file: ExportFile, text: string, current: Buffer | null, canonical: Buffer | null,
  revision: { dbId: string; revision: number }, replace: boolean, accepted: boolean,
): Promise<ExportOutcome> {
  const target = path.join(root, file);
  const targetStat = await statOrNull(target);
  const keepVisible = async () => {
    const visible = await readExportBytes(target);
    if (visible && !visible.equals(current ?? Buffer.from(latestExport(db.sqlite, file)?.text ?? ''))) await observeDraft(root, db, file, visible);
    return 'kept-save' as const;
  };
  if (!replace || (targetStat && !targetStat.isFile())) return 'kept-edit';
  if (canonical && canonical.equals(Buffer.from(latestExport(db.sqlite, file)?.text ?? ''))) {
    const currentHeader = exportHeaderOf(file, canonical.toString('utf8'))!;
    const nextHeader = exportHeaderOf(file, text)!;
    if ((accepted || currentHeader.dbId === nextHeader.dbId) && currentHeader.digest === nextHeader.digest) return 'unchanged';
    if (!accepted && currentHeader.dbId === nextHeader.dbId && currentHeader.revision >= nextHeader.revision) return 'newer';
  }

  const dot = path.join(root, '.contextspace');
  const drafts = draftDir(root);
  await fs.mkdir(drafts, { recursive: true });
  const tag = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const baseline = current ? byteDigest(current) : '';
  const temp = path.join(dot, `.export-${tag}-${file}-${byteDigest(text)}${baseline ? `-${baseline}` : ''}`);
  const aside = path.join(drafts, `.swap-${tag}-${file}`);
  await writeFileSynced(temp, text);
  await syncDirectory(dot);
  let placed = false;
  let recorded = false;
  let moved = false;
  let asideIsFile = false;
  const place = async (): Promise<ExportOutcome> => {
    const live = await readWithRetry(db, () => getRevision(db));
    if (live.dbId !== revision.dbId || live.revision !== revision.revision) {
      if (moved) await restoreAside(aside, target, asideIsFile);
      return 'newer';
    }
    placed = await createExclusive(temp, target);
    if (!placed) return keepVisible();
    await syncDirectory(root);
    const visible = await readExportBytes(target);
    await recordExport(db, file, text);
    if (visible && !visible.equals(Buffer.from(text))) await observeDraft(root, db, file, visible);
    recorded = true;
    return 'written';
  };
  try {
    await exportSeams.beforeSwap?.(file);
    if (current === null) return await place();
    try {
      await fs.rename(target, aside);
      moved = true;
      await syncDirectory(drafts);
      await syncDirectory(root);
    } catch (error) {
      if (!moved && fileErrorCode(error) === 'ENOENT') return await place();
      throw error;
    }
    asideIsFile = (await statOrNull(aside))?.isFile() ?? false;
    const asideBytes = asideIsFile ? await readExportBytes(aside) : null;
    if (!bytesEqual(asideBytes, current)) {
      const restored = await restoreAside(aside, target, asideIsFile);
      if (restored && asideBytes) await observeDraft(root, db, file, asideBytes);
      if (asideBytes) await retainFormerExport(root, db, aside, tag, file, restored ? byteDigest(asideBytes) : baseline);
      return keepVisible();
    }
    const result = await place();
    if (result !== 'newer') {
      await retainFormerExport(root, db, aside, tag, file, baseline);
    }
    return result;
  } catch (error) {
    if (moved && !placed && await statOrNull(aside)) {
      await restoreAside(aside, target, asideIsFile);
      if (asideIsFile) await retainFormerExport(root, db, aside, tag, file, baseline);
    }
    throw error;
  } finally {
    // Keep the durable staging file if a crash or write failure left the swap unfinished.
    if ((!placed || recorded) && !await statOrNull(aside)) await fs.unlink(temp).catch(() => undefined);
  }
}
