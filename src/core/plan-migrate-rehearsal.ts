/**
 * @module core/plan-migrate-rehearsal
 * `ctxspace plan migrate --dry-run`: builds a workspace database from today's files, in a folder of its own, and says
 * exactly what it found. It changes nothing in the workspace: every source is read through the storage adapter, read
 * only (no change log is kept, nothing is moved), and the output goes to a temp folder or `--out`, never into the
 * workspace.
 *
 * What it reads: PLAN.md (or the older contextspace-plan.json as the PLAN.md it would become), the Board file, both
 * change logs, Now, both seen files and the plan checks in state.json. What it reports: counts, every reference it could
 * not map, every input it had to skip, duplicate plan keys, the PLAN.md round trip and the portable snapshot.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import { readBoard, readBoardChanges, BoardFileError, BOARD_FILE } from './board.js';
import { PLAN_FILE, PLAN_NOW_FILE, PlanFileError, parsePlanFile, planItems, planKey } from './plan-file.js';
import { readPlanTextReadOnly } from './plan-file-store.js';
import { readWorkspaceFile, workspaceFileExists } from './storage.js';
import { loadFeatureConfig } from './workspace.js';
import { resolveBrandHomeDir, resolveWorkspaceFilePath } from './brand-config.js';
import { loadWorkspaceState } from './workspace-state.js';
import {
  applyBatch, createWorkspaceDb, dbFilePath, exportPlanMarkdown, exportPortableSnapshot, getRevision, importLegacyData, importPlanText, listBlocks, openWorkspaceDb, stripExport,
  type LegacyCard, type LegacyCheck, type LegacyData, type Resolved, type Unmapped, type WorkspaceDb,
} from './workspace-db/index.js';

const PLAN_CHANGES_FILE = '.contextspace/plan-changes.jsonl';
const BOARD_CHANGES_FILE = '.contextspace/board-changes.jsonl';
const PLAN_SEEN_FILE = '.contextspace/plan-seen.json';
const SEEN_FILE = '.contextspace/seen.json';
const OLD_STORE = 'contextspace-plan.json';
/** What the rehearsal reads from `.contextspace/` (the state file is added by the name it was found under). */
const READ_FROM_DOT = new Set([PLAN_CHANGES_FILE, BOARD_CHANGES_FILE, PLAN_NOW_FILE, PLAN_SEEN_FILE, SEEN_FILE]);
const SNAPSHOT_FILE = 'contextspace-data.json';
const KNOWN_CARD_FIELDS = new Set(['id', 'kind', 'title', 'body', 'path', 'description', 'area', 'step', 'about', 'look', 'lookAt', 'pinned', 'archived', 'by', 'at', 'updatedBy', 'updatedAt']);

export interface Skipped { input: string; problem: string; skipped: string }

export interface DuplicateKey {
  /** The key the words make; the later items carry `-2`, `-3`. */
  key: string;
  items: Array<{ key: string; id: string; kind: string; text: string }>;
  /** Every reference that used one of these keys, and the item it went to. */
  references: Array<{ what: string; card?: string; title?: string; value: string; wentTo: string; ambiguous?: boolean }>;
}

export interface RehearsalReport {
  workspace: string;
  /** Where the database, the PLAN.md export and the snapshot were written. */
  folder: string;
  plan: { source: 'file' | 'store' | 'none'; bytes: number; blocks: number; items: number };
  counts: {
    blocksByKind: Record<string, number>;
    cards: number; notes: number; files: number; links: number; positions: number;
    history: { plan: number; board: number; total: number };
    checkRuns: number; now: number; seenReaders: number; planSeenItems: number;
  };
  remapped: { cardAreas: number; cardSteps: number; linkEnds: number; positions: number; now: number; checks: number; planSeenItems: number };
  unmapped: Unmapped[];
  skipped: Skipped[];
  duplicateKeys: DuplicateKey[];
  /** Rows the database's unique rules turned away, named. */
  collisions: string[];
  /** A plan item the plan reader and the database read differently (should be empty). */
  keyProblems: string[];
  /** Files in `.contextspace/` the rehearsal did not read. */
  notRead: string[];
  roundTrip: { identical: boolean; sourceBytes: number; exportBytes: number; differences: Array<{ line: number; source: string | null; export: string | null }>; moreDifferences: number };
  snapshot: { file: string; bytes: number; lines: number; tick: { step: string | null; changedLines: number; totalLines: number; note?: string } };
  elapsedMs: number;
  result: 'ok' | 'listed' | 'failed';
  exitCode: 0 | 3 | 1;
}

export interface RehearsalOptions {
  /** A folder for the output. Never inside the workspace. */
  out?: string;
  /** A test seam: changes the exported text before it is compared with the source. */
  exportHook?: (text: string) => string;
}

export function rehearsalExitCode(report: Pick<RehearsalReport, 'roundTrip' | 'unmapped' | 'skipped' | 'duplicateKeys' | 'collisions' | 'keyProblems'>): 0 | 3 | 1 {
  if (!report.roundTrip.identical || report.keyProblems.length) return 1;
  return report.unmapped.length || report.skipped.length || report.duplicateKeys.length || report.collisions.length ? 3 : 0;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** A workspace-relative path as the report writes it: with `/` on every platform (a Windows `\\` never reaches the report). */
export function relativePosix(from: string, to: string, flavour: Pick<typeof path, 'relative' | 'sep'> = path): string {
  return flavour.relative(from, to).split(flavour.sep).join('/');
}
const closeQuietly = (db: WorkspaceDb) => { try { db.close(); } catch { /* already closed */ } };

/** The deepest folder of `target` that exists, resolved through links, with the rest put back: where a path really is. */
async function realLocation(target: string): Promise<string> {
  const rest: string[] = [];
  let at = path.resolve(target);
  for (;;) {
    try {
      return path.join(await fs.realpath(at), ...rest.reverse());
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return path.join(at, ...rest.reverse());
      rest.push(path.basename(at));
      at = parent;
    }
  }
}

const inside = (child: string, parent: string) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

const MANIFESTS = ['contextspace.json', 'nexusflow.json', 'PLAN.md', 'contextspace-plan.json'];

/** Every place the brand's global home can be: the folders the app would use, whether or not they exist yet. */
async function brandHomes(): Promise<string[]> {
  const homes = [process.env.CONTEXTSPACE_HOME, process.env.NEXUSFLOW_HOME, resolveBrandHomeDir(), path.join(os.homedir(), '.contextspace'), path.join(os.homedir(), '.nexusflow')]
    .filter((h): h is string => Boolean(h?.trim())).map((h) => path.resolve(h.trim()));
  return Promise.all([...new Set(homes)].map(realLocation));
}

async function chooseFolder(root: string, out?: string): Promise<{ folder: string; made: boolean }> {
  const wanted = out ? path.resolve(out) : await fs.mkdtemp(path.join(os.tmpdir(), 'contextspace-rehearsal-'));
  const made = !out;
  const refuse = async (message: string): Promise<never> => {
    if (made) await fs.rm(wanted, { recursive: true, force: true });
    throw new PlanFileError(message, 'invalid');
  };
  const real = await realLocation(wanted);
  if (inside(real, root)) await refuse(`The output folder ${wanted} is inside the workspace (${root}). The rehearsal writes only outside it, so nothing in the workspace changes. Pick a folder elsewhere with --out.`);
  for (const home of await brandHomes()) {
    if (inside(real, home)) await refuse(`The output folder ${wanted} is the brand home or inside it (${home}), where ContextSpace keeps its own data. Pick a folder elsewhere with --out.`);
  }
  // a folder that exists must be empty: the rehearsal never writes into something that is already someone's
  const existing = await fs.stat(real).then((stat) => stat, () => null);
  if (existing) {
    if (!existing.isDirectory()) await refuse(`The output ${wanted} is not a folder. Pick an empty folder, or omit --out for a new temp folder.`);
    if ((await fs.readdir(real)).length > 0) await refuse(`The output folder ${wanted} is not empty. Pick an empty or new folder, or omit --out for a new temp folder.`);
  }
  // nor inside another workspace, however deep: a manifest or a plan in any folder above it
  for (let dir = real; ; dir = path.dirname(dir)) {
    for (const marker of MANIFESTS) {
      if (dir !== real && await fs.access(path.join(dir, marker)).then(() => true, () => false)) await refuse(`The output folder ${wanted} is inside another workspace (${dir} holds ${marker}). Pick a folder outside every workspace with --out.`);
    }
    if (path.dirname(dir) === dir) break;
  }
  await fs.mkdir(real, { recursive: true });
  return { folder: real, made };
}

/** Plan items matched to the database's blocks by place, then checked by words. Several items with one key make it ambiguous. */
export function matchPlanItems(items: ReturnType<typeof planItems>, itemBlocks: ReadonlyArray<{ id: string; kind: string; name: string | null }>): {
  keys: Map<string, string>; ambiguous: Map<string, string[]>; problems: string[]; itemInfo: Array<{ key: string; kind: string; text: string; id: string }>;
} {
  const problems: string[] = [];
  if (items.length !== itemBlocks.length) problems.push(`the plan reader found ${items.length} items and the database ${itemBlocks.length}`);
  const idsByKey = new Map<string, string[]>();
  const itemInfo = items.map((item, index) => {
    const kind = 'question' in item ? 'decision' : 'title' in item ? 'checkpoint' : 'step';
    const text = 'question' in item ? item.question : 'title' in item ? item.title : item.text;
    const block = itemBlocks[index];
    if (block) {
      if (block.kind !== kind) problems.push(`item ${index + 1} "${text}" (key ${item.key}) is a ${kind} to the plan reader and a ${block.kind} in the database`);
      else if (planKey(text) !== planKey(block.name ?? '')) problems.push(`item ${index + 1} "${text}" (key ${item.key}) is "${block.name ?? ''}" in the database at the same place`);
      else idsByKey.set(item.key, [...(idsByKey.get(item.key) ?? []), block.id]);
    }
    return { key: item.key, kind, text, id: block?.id ?? '' };
  });
  const keys = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const [key, ids] of idsByKey) { if (ids.length === 1) keys.set(key, ids[0]!); else ambiguous.set(key, ids); }
  return { keys, ambiguous, problems, itemInfo };
}

/** Runs the rehearsal. Throws only when it cannot start (a bad `--out`); everything it finds goes in the report. */
export async function rehearseMigration(workspacePath: string, options: RehearsalOptions = {}): Promise<RehearsalReport> {
  const started = performance.now();
  const root = await fs.realpath(workspacePath);
  const { folder, made } = await chooseFolder(root, options.out);
  try {
    return await rehearse(root, folder, options, started);
  } catch (error) {
    if (made) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    throw error instanceof PlanFileError ? error : new PlanFileError(`The rehearsal could not be built: ${reason(error)}`, 'invalid');
  }
}

/**
 * Builds the database the real move puts in place, in `folder` (which the move makes inside the workspace's
 * `.contextspace/`, beside the live path): the same build and the same report as the rehearsal. `root` is the
 * workspace's real path. The caller holds the workspace's locks and checks the report before using anything.
 */
export async function buildMigrationDatabase(root: string, folder: string): Promise<RehearsalReport> {
  return rehearse(root, folder, {}, performance.now());
}

async function rehearse(root: string, folder: string, options: RehearsalOptions, started: number): Promise<RehearsalReport> {
  const featureId = (await loadFeatureConfig(root))?.id ?? path.basename(root);
  const skipped: Skipped[] = [];
  const skip = (input: string, problem: string, what: string) => { skipped.push({ input, problem, skipped: what }); };

  /** The text of a workspace file through the adapter: null when it is not there, or cannot be read (then it is named). */
  const readInput = async (name: string, what: string): Promise<string | null> => {
    try {
      return await readWorkspaceFile(root, featureId, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skip(name, `could not be read (${reason(error)})`, what);
      return null;
    }
  };

  // ── the plan
  let read: Awaited<ReturnType<typeof readPlanTextReadOnly>>;
  try {
    read = await readPlanTextReadOnly(root);
  } catch (error) {
    const hasFile = await workspaceFileExists(root, featureId, PLAN_FILE).catch(() => false);
    skip(hasFile ? PLAN_FILE : OLD_STORE, `could not be read (${reason(error)})`, 'the plan: the database starts with no plan');
    read = { text: '', plan: parsePlanFile(''), source: 'none' };
  }
  if (read.source === 'none' && !skipped.length) {
    const oldStore = await workspaceFileExists(root, featureId, OLD_STORE).catch(() => false);
    if (oldStore) skip(OLD_STORE, 'is there but holds no plan items, and there is no PLAN.md', 'the plan: the database starts with no plan');
    else skip(PLAN_FILE, `there is no ${PLAN_FILE} and no ${OLD_STORE}`, 'the plan: the database starts with no plan');
  }
  const planText = read.text;
  // The plan reader splits on \n only, so a PLAN.md saved with CRLF line endings would read as no items at all. The
  // database keeps the file's own line ending (and the round trip below compares the text as it is); only the reader
  // that makes the old keys sees it normalised.
  const parsed = parsePlanFile(planText.replace(/\r\n/g, '\n'));
  const items = planItems(parsed);

  let db: WorkspaceDb | null = null;
  try {
    db = createWorkspaceDb(folder, { busy: 'cli', backups: false });
    await importPlanText(db, planText, { by: 'import' });
    const blocks = listBlocks(db);
    const itemBlocks = blocks.filter((b) => b.kind === 'checkpoint' || b.kind === 'step' || b.kind === 'decision');

    // ── keys: the plan reader's key for each item, matched to the database's block by place and checked by words
    const matched = matchPlanItems(items, itemBlocks);
    const { keys, ambiguous, itemInfo } = matched;
    const keyProblems = matched.problems;

    // ── the Board
    let cards: LegacyCard[] = [];
    let links: LegacyData['links'] = [];
    let positions: LegacyData['positions'] = {};
    try {
      const board = await readBoard(root);
      cards = board.cards as LegacyCard[];
      links = board.links;
      positions = board.positions;
      const rawText = await readInput(BOARD_FILE, 'the board');
      if (rawText !== null) noteDroppedFromBoard(rawText, board, skip);
    } catch (error) {
      if (!(error instanceof BoardFileError)) throw error;
      skip(BOARD_FILE, error.message, 'the whole board: its cards, links and positions');
    }

    // ── the logs, as summaries
    const planLog = parsePlanLog(await readInput(PLAN_CHANGES_FILE, 'the plan history'), PLAN_CHANGES_FILE, skip);
    const boardRaw = await readInput(BOARD_CHANGES_FILE, 'the board history');
    let boardLog: Array<{ at: string; by: string; summary: string }> = [];
    if (boardRaw !== null) {
      const lines = boardRaw.split('\n').filter((line) => line.trim());
      const entries = await readBoardChanges(root, Math.max(lines.length, 1)).catch(() => []);
      boardLog = entries.reverse().map((e) => ({ at: e.at, by: e.by, summary: `${e.action.replace(/_/g, ' ')}: ${e.text || e.id}` }));
      if (boardLog.length < lines.length) skip(BOARD_CHANGES_FILE, 'some lines could not be read', `${lines.length - boardLog.length} line${lines.length - boardLog.length === 1 ? '' : 's'} of the board history`);
    }
    const history = [...planLog, ...boardLog].map((entry, order) => ({ entry, order }))
      .sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at) || a.order - b.order).map(({ entry }) => entry);

    // ── Now, seen, checks
    const nowRaw = await readInput(PLAN_NOW_FILE, 'what is being worked on now');
    let now: LegacyData['now'] = null;
    if (nowRaw !== null && nowRaw.trim()) {
      const record = tryParse(nowRaw);
      if (isObject(record) && Object.keys(record).length === 0) now = null; // `{}` is how a cleared Now is kept
      else if (isObject(record) && typeof record.key === 'string' && typeof record.by === 'string' && validTime(record.at)) now = { key: record.key, by: record.by, at: record.at };
      else skip(PLAN_NOW_FILE, 'does not hold a step record', 'what is being worked on now');
    }
    const planSeenRaw = await readInput(PLAN_SEEN_FILE, 'what the plan file had seen');
    let planSeen: NonNullable<LegacyData['seen']['plan']> | null = null;
    if (planSeenRaw !== null) {
      const record = tryParse(planSeenRaw);
      if (isObject(record) && isObject(record.items)) planSeen = { hash: typeof record.hash === 'string' ? record.hash : undefined, items: record.items };
      else skip(PLAN_SEEN_FILE, 'is not a seen record', 'what the plan file had seen');
    }
    const seenRaw = await readInput(SEEN_FILE, 'what each reader has seen');
    const seen: LegacyData['seen'] = { readers: {}, pending: {}, plan: planSeen };
    if (seenRaw !== null) {
      const record = tryParse(seenRaw);
      if (!isObject(record)) skip(SEEN_FILE, 'is not a seen file', 'what each reader has seen');
      else {
        let bad = 0;
        for (const field of ['readers', 'pending'] as const) {
          for (const [reader, value] of Object.entries(isObject(record[field]) ? record[field] : {})) {
            if (isObject(value) && validTime(value.at)) seen[field][reader] = value; else bad += 1;
          }
        }
        if (bad) skip(SEEN_FILE, 'some records are not usable', `${bad} reader record${bad === 1 ? '' : 's'}`);
      }
    }
    const checks: Record<string, LegacyCheck> = {};
    const evidenceUnmapped: Unmapped[] = [];
    let stateName: string | null = null;
    {
      // the state file the way the app finds it (`.contextspace/state.json`, then the older names), read only
      const found = await resolveWorkspaceFilePath(root, 'state');
      if (found.exists) {
        stateName = relativePosix(root, found.path);
        try {
          const state = await loadWorkspaceState(root, { strict: true });
          for (const [key, value] of Object.entries(isObject(state.planChecks) ? state.planChecks : {})) if (isObject(value)) checks[key] = value as LegacyCheck;
          if (read.source === 'store') evidenceUnmapped.push(...await carryOldEvidence(root, state as unknown as Record<string, unknown>, parsed, checks));
        } catch (error) {
          skip(stateName, `could not be read (${reason(error)})`, 'the plan checks (planChecks, planEvidence)');
        }
      }
    }

    const legacy = await importLegacyData(db, { cards, links, positions, history, now, seen, checks }, keys, { by: 'import', ambiguous });
    legacy.unmapped.push(...evidenceUnmapped);

    // ── the round trip
    const exported = options.exportHook ? options.exportHook(exportPlanMarkdown(db)) : exportPlanMarkdown(db);
    const roundTrip = compare(planText, stripExport(exported));
    await fs.writeFile(path.join(folder, PLAN_FILE), exported);

    // ── the snapshot, and what one tick changes in it
    const snapshotText = exportPortableSnapshot(db);
    const snapshotFile = path.join(folder, SNAPSHOT_FILE);
    await fs.writeFile(snapshotFile, snapshotText);
    const tick = await simulateTick(db, snapshotText, folder);

    const byKind: Record<string, number> = {};
    for (const b of blocks) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
    const duplicateKeys = findDuplicates(itemInfo, legacy.resolved, legacy.unmapped);
    const report: RehearsalReport = {
      workspace: root, folder,
      plan: { source: read.source, bytes: Buffer.byteLength(planText), blocks: blocks.length, items: itemBlocks.length },
      counts: {
        blocksByKind: byKind, cards: legacy.counts.cards, notes: legacy.counts.notes, files: legacy.counts.files, links: legacy.counts.links, positions: legacy.counts.positions,
        history: { plan: planLog.length, board: boardLog.length, total: history.length },
        checkRuns: legacy.counts.checkRuns, now: legacy.counts.now, seenReaders: legacy.counts.seenReaders, planSeenItems: legacy.counts.planSeenItems,
      },
      remapped: legacy.remapped, unmapped: legacy.unmapped, skipped, duplicateKeys, collisions: legacy.duplicates, keyProblems, notRead: await listNotRead(root, stateName), roundTrip,
      snapshot: { file: snapshotFile, bytes: Buffer.byteLength(snapshotText), lines: snapshotText.split('\n').length - 1, tick },
      elapsedMs: Math.round(performance.now() - started), result: 'ok', exitCode: 0,
    };
    report.exitCode = rehearsalExitCode(report);
    report.result = report.exitCode === 0 ? 'ok' : report.exitCode === 3 ? 'listed' : 'failed';
    return report;
  } finally {
    if (db) closeQuietly(db);
  }
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** What the Board's own loader dropped, found by counting the raw file against what loaded. */
function noteDroppedFromBoard(rawText: string, board: { cards: unknown[]; links: unknown[]; positions: Record<string, unknown> }, skip: (input: string, problem: string, what: string) => void): void {
  const raw = tryParse(rawText);
  if (!isObject(raw)) return;
  const rawCards = Array.isArray(raw.cards) ? raw.cards : [];
  const rawLinks = Array.isArray(raw.links) ? raw.links : [];
  const rawPositions = isObject(raw.positions) ? Object.keys(raw.positions).length : 0;
  const lost = (what: string, total: number, kept: number) => {
    if (total > kept) skip(BOARD_FILE, 'some entries are not usable (a bad id, a missing title, a path outside the workspace, or a node that is not on the board)', `${total - kept} of ${total} ${what} would not load and are left out`);
  };
  lost('cards', rawCards.length, board.cards.length);
  lost('links', rawLinks.length, board.links.length);
  lost('positions', rawPositions, Object.keys(board.positions).length);
  const unknown = new Set<string>();
  for (const card of rawCards) if (isObject(card)) for (const field of Object.keys(card)) if (!KNOWN_CARD_FIELDS.has(field)) unknown.add(field);
  if (unknown.size) skip(BOARD_FILE, 'cards carry fields the board does not keep', `the fields ${[...unknown].sort().join(', ')}`);
}

function parsePlanLog(text: string | null, input: string, skip: (input: string, problem: string, what: string) => void): Array<{ at: string; by: string; summary: string }> {
  if (text === null) return [];
  const lines = text.split('\n').filter((line) => line.trim());
  const out: Array<{ at: string; by: string; summary: string }> = [];
  for (const line of lines) {
    const entry = tryParse(line);
    if (!isObject(entry) || !validTime(entry.at) || typeof entry.by !== 'string' || typeof entry.action !== 'string' || typeof entry.text !== 'string') continue;
    const kind = typeof entry.kind === 'string' ? `${entry.kind} ` : '';
    out.push({ at: entry.at, by: entry.by, summary: `${entry.action} ${kind}"${entry.text}"${typeof entry.note === 'string' && entry.note ? `: ${entry.note}` : ''}` });
  }
  if (out.length < lines.length) skip(input, 'some lines could not be read', `${lines.length - out.length} line${lines.length - out.length === 1 ? '' : 's'} of the plan history`);
  return out;
}

/** The older plan store kept checks by milestone id; they carry over under the checkpoint key, as moving the store does. Returns the ones that have no checkpoint. */
async function carryOldEvidence(root: string, state: Record<string, unknown>, parsed: ReturnType<typeof parsePlanFile>, checks: Record<string, LegacyCheck>): Promise<Unmapped[]> {
  if (!isObject(state.planEvidence)) return [];
  const { readPlanReadOnly } = await import('./lifecycle.js');
  const plan = await readPlanReadOnly(root);
  const placed = new Set<string>();
  for (const item of plan.items.filter((candidate) => candidate.kind === 'milestone')) {
    const evidence = (state.planEvidence as Record<string, unknown>)[item.id];
    const key = parsed.checkpoints.find((checkpoint) => checkpoint.title === item.title)?.key;
    if (key && isObject(evidence)) { placed.add(item.id); if (!checks[key]) checks[key] = evidence as LegacyCheck; }
  }
  return Object.keys(state.planEvidence).filter((id) => !placed.has(id)).map((id) => ({ what: 'check' as const, value: id, reason: 'an old milestone check with no checkpoint of that milestone in the plan' }));
}

/** What is in `.contextspace/` that the rehearsal did not read, so nothing there is overlooked. */
async function listNotRead(root: string, stateName: string | null): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, '.contextspace'), { withFileTypes: true }).catch(() => []);
  return entries.map((e) => `.contextspace/${e.name}${e.isDirectory() ? '/' : ''}`)
    .filter((name) => !READ_FROM_DOT.has(name) && name !== stateName).sort();
}

function compare(source: string, back: string): RehearsalReport['roundTrip'] {
  const base = { sourceBytes: Buffer.byteLength(source), exportBytes: Buffer.byteLength(back) };
  if (source === back) return { identical: true, ...base, differences: [], moreDifferences: 0 };
  const a = source.split('\n');
  const b = back.split('\n');
  const differences: RehearsalReport['roundTrip']['differences'] = [];
  let more = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    if (differences.length < 20) differences.push({ line: i + 1, source: a[i] ?? null, export: b[i] ?? null }); else more += 1;
  }
  return { identical: false, ...base, differences, moreDifferences: more };
}

function findDuplicates(items: Array<{ key: string; kind: string; text: string; id: string }>, resolved: Resolved[], unmapped: Unmapped[]): DuplicateKey[] {
  // items that share the words (Foo, Foo) or the key the reader made (a second Foo and a Foo-2 both get foo-2) belong together
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const seenToken = new Map<string, number>();
  items.forEach((item, i) => {
    for (const token of [`w:${planKey(item.text)}`, `k:${item.key}`]) {
      const first = seenToken.get(token);
      if (first === undefined) seenToken.set(token, i); else parent[find(i)] = find(first);
    }
  });
  const groups = new Map<number, number[]>();
  items.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const refKey = (value: string) => value.replace(/^checkpoint:/, '').replace(/#[0-9]{1,3}$/, '');
  const out: DuplicateKey[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const group = members.map((i) => items[i]!);
    const keySet = new Set(group.map((item) => item.key));
    out.push({
      key: planKey(group[0]!.text),
      items: group.map(({ key, id, kind, text }) => ({ key, id, kind, text })),
      references: [
        ...resolved.filter((r) => keySet.has(refKey(r.value))).map((r) => ({ what: r.what, ...(r.card ? { card: r.card } : {}), ...(r.title ? { title: r.title } : {}), value: r.value, wentTo: r.id })),
        ...unmapped.filter((u) => u.candidates && keySet.has(refKey(u.value))).map((u) => ({ what: u.what, ...(u.card ? { card: u.card } : {}), ...(u.title ? { title: u.title } : {}), value: u.value, wentTo: u.candidates!.join(' or '), ambiguous: true })),
      ],
    });
  }
  return out;
}

/** Ticks the first open step in a throwaway copy of the database, to show how much of the snapshot one tick changes. */
async function simulateTick(db: WorkspaceDb, before: string, folder: string): Promise<RehearsalReport['snapshot']['tick']> {
  const totalLines = before.split('\n').length - 1;
  const step = listBlocks(db).find((b) => b.kind === 'step' && !b.done);
  if (!step) return { step: null, changedLines: 0, totalLines, note: 'no open step to tick' };
  const dir = await fs.mkdtemp(path.join(folder, 'tick-copy-'));
  let copy: WorkspaceDb | null = null;
  try {
    await fs.mkdir(path.join(dir, '.contextspace'));
    const target = dbFilePath(dir);
    db.sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    copy = openWorkspaceDb(dir, { busy: 'cli', backups: false });
    const position = getRevision(copy);
    const result = await applyBatch(copy, { ifRevision: position.revision, dbId: position.dbId, ops: [{ op: 'tick', id: step.id, rev: step.rev }] }, { by: 'import' });
    if (!result.ok) return { step: step.name, changedLines: 0, totalLines, note: `the tick was refused: ${result.errors.map((e) => e.message).join(' ')}` };
    const after = exportPortableSnapshot(copy);
    const counts = new Map<string, number>();
    for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    let changed = 0;
    for (const line of after.split('\n')) {
      const n = counts.get(line) ?? 0;
      if (n > 0) counts.set(line, n - 1); else changed += 1;
    }
    return { step: step.name, changedLines: changed, totalLines };
  } catch (error) {
    return { step: step.name, changedLines: 0, totalLines, note: `could not simulate the tick (${reason(error)})` };
  } finally {
    if (copy) closeQuietly(copy);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── The words ──────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The report in plain words: what a person reads before agreeing to the move. */
export function renderRehearsal(report: RehearsalReport): string {
  const lines: string[] = [];
  const c = report.counts;
  lines.push('Rehearsal only: nothing in this workspace was changed.');
  lines.push(`Workspace: ${report.workspace}`);
  lines.push(`Built in: ${report.folder} (workspace database, PLAN.md export, ${SNAPSHOT_FILE})`);
  lines.push('');
  const kinds = Object.entries(c.blocksByKind).map(([kind, n]) => plural(n, kind)).join(', ');
  lines.push(`The plan (${report.plan.source === 'file' ? PLAN_FILE : report.plan.source === 'store' ? 'the older contextspace-plan.json, as the PLAN.md it would become' : 'none found'}): ${plural(report.plan.blocks, 'block')} (${kinds || 'none'}), ${plural(report.plan.items, 'plan item')}.`);
  lines.push(`The Board: ${plural(c.cards, 'card')} (${c.notes} notes, ${c.files} files), ${plural(c.links, 'link')}, ${plural(c.positions, 'position')}.`);
  lines.push(`History kept as summaries, without Undo: ${c.history.plan} from the plan log, ${c.history.board} from the board log.`);
  lines.push(`Now: ${c.now ? 'one step' : 'none'}. Seen: ${plural(c.seenReaders, 'reader')}${c.planSeenItems ? `, ${plural(c.planSeenItems, 'plan item')} in the plan file's own record` : ''}. Old check results: ${c.checkRuns} (evidence only; they never let a checkpoint be ticked).`);
  const r = report.remapped;
  lines.push(`References mapped to the new ids: ${plural(r.cardAreas, 'card area')}, ${plural(r.cardSteps, 'card step')}, ${plural(r.linkEnds, 'link end')}, ${plural(r.positions, 'position')}, ${r.now} Now, ${plural(r.checks, 'check')}.`);
  if (report.unmapped.length) {
    lines.push('', `Could not be mapped (${report.unmapped.length}). Each card keeps what it can; nothing is hidden:`);
    for (const u of report.unmapped) lines.push(`  - ${u.what}${u.card ? ` on card "${u.title ?? ''}" (${u.card})` : ''}: ${u.value}. ${u.reason}.`);
  }
  if (report.skipped.length) {
    lines.push('', `Inputs skipped or only partly read (${report.skipped.length}):`);
    for (const s of report.skipped) lines.push(`  - ${s.input}: ${s.problem}. Skipped: ${s.skipped}.`);
  }
  if (report.duplicateKeys.length) {
    lines.push('', `Duplicate plan keys (${report.duplicateKeys.length}). Words that repeat get -2, -3 in file order, and each reference went to the item with its exact key:`);
    for (const d of report.duplicateKeys) {
      lines.push(`  - "${d.key}": ${d.items.map((i) => `${i.key} (${i.kind}, ${i.id})`).join(', ')}`);
      for (const ref of d.references) lines.push(`      ${ref.what}${ref.card ? ` of card "${ref.title ?? ''}"` : ''} said ${ref.value}: ${ref.ambiguous ? `ambiguous, it could be ${ref.wentTo}; it was not mapped` : `went to ${ref.wentTo}`}`);
      if (!d.references.length) lines.push('      no card, link, position or Now used these keys');
    }
  }
  if (report.collisions.length) {
    lines.push('', `Left out because the database allows one of each (${report.collisions.length}):`);
    for (const x of report.collisions) lines.push(`  - ${x}`);
  }
  if (report.keyProblems.length) {
    lines.push('', 'The plan reader and the database disagree about the items (this should not happen):');
    for (const p of report.keyProblems) lines.push(`  - ${p}`);
  }
  if (report.notRead.length) lines.push('', `Not read: ${report.notRead.join(', ')} (in .contextspace/; the rehearsal does not use them).`);
  lines.push('');
  const rt = report.roundTrip;
  if (rt.identical) lines.push(`PLAN.md round trip: identical (${rt.sourceBytes} bytes, apart from the header and the id comments).`);
  else {
    lines.push(`PLAN.md round trip: DIFFERENT. The export is ${rt.exportBytes} bytes, the source ${rt.sourceBytes}. The rehearsal fails. First differences:`);
    for (const d of rt.differences) lines.push(`  line ${d.line}: source ${JSON.stringify(d.source)}`, `  line ${d.line}: export ${JSON.stringify(d.export)}`);
    if (rt.moreDifferences) lines.push(`  and ${rt.moreDifferences} more lines.`);
  }
  const s = report.snapshot;
  lines.push(`${SNAPSHOT_FILE}: ${s.bytes} bytes, ${s.lines} lines. ${s.tick.step ? `Ticking "${s.tick.step}" changes ${s.tick.changedLines} of its lines${s.tick.note ? ` (${s.tick.note})` : ''}.` : (s.tick.note ?? '')}`);
  lines.push(`Took ${report.elapsedMs} ms.`);
  lines.push('');
  const listed = report.unmapped.length + report.skipped.length + report.duplicateKeys.length + report.collisions.length;
  if (report.exitCode === 0) lines.push('Everything maps and the plan round-trips. Exit code 0.');
  else if (report.exitCode === 3) lines.push(`It worked, but ${plural(listed, 'thing')} ${listed === 1 ? 'is' : 'are'} listed above. Exit code 3.`);
  else lines.push('The rehearsal failed: see above. Exit code 1.');
  return lines.join('\n');
}
