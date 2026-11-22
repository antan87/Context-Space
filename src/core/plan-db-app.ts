/**
 * @module core/plan-db-app
 * The Plan tab, the Board's plan and Now for a workspace that was moved to its database: the same answer as
 * `plan-file-app` gives for PLAN.md, read from the database, and the person's changes written to it as ops.
 *
 * Every item's `key` is its database id (`s7k2q`), which never changes when the words do, so a card's area and step
 * (`checkpoint:<id>`, `<id>`) keep pointing at their item through a reword. Each item also carries `id` and `rev`, and
 * the answer carries the workspace `revision` and `dbId` (the poll token is `dbId:revision`).
 *
 * A change names the item and either the `rev` it read or, as the app has always sent, the words it showed (`expected`).
 * The words are checked against the item as it is now, and the op then carries the item's current `rev`, so a change
 * made by someone else meanwhile (an AI rewording, ticking or answering it) is refused in the same transaction, never
 * silently overwritten.
 */

import { PLAN_FILE, PlanFileError, parsePlanFile, planItems, workableSteps, type PlanFile, type PlanStep } from './plan-file.js';
import { planViewOf, type PlanFileAppChange } from './plan-file-app.js';
import type { PlanFileChange, PlanItemKind, PlanNow } from './plan-file-store.js';
import { readAppDb, writeAppDb } from './workspace-db-app.js';
import { publishExports } from './workspace-db-exports.js';
import {
  WorkspaceDbError, applyBatch, exportPlan, finishCheckRun, getRevision, parseDetail, readWithRetry, startCheckRun,
  type BatchResult, type Issue, type Op, type WorkspaceDb,
} from './workspace-db/index.js';
import type { PlanEvidence, VerificationStatus } from '../types.js';

const ID_COMMENT = / <!-- ([a-z][0-9a-hjkmnp-tv-z]{5}) -->$/;

/** The plan as the export reads it, with every key replaced by the item's id. */
export interface PlanDbRead {
  text: string;
  plan: PlanFile;
  revs: Map<string, number>;
  revision: number;
  dbId: string;
}

/** Reads the plan inside a read view: the export text parsed the way PLAN.md is, keyed by id. */
export function readPlanDb(view: WorkspaceDb): PlanDbRead {
  const exported = exportPlan(view);
  const lines = exported.body.replace(/\r\n/g, '\n').split('\n');
  const idAt = new Map<number, string>();
  const text = lines.map((line, index) => {
    const m = ID_COMMENT.exec(line);
    if (!m) return line;
    idAt.set(index, m[1]!);
    return line.slice(0, m.index);
  }).join('\n');
  const parsed = parsePlanFile(text);
  const rows = view.sqlite.prepare('SELECT id, kind, parent_id, rev FROM blocks').all() as Array<{ id: string; kind: string; parent_id: string | null; rev: number }>;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const revs = new Map(rows.map((r) => [r.id, Number(r.rev)]));
  const keyAt = (line: number, fallback: string) => idAt.get(line) ?? fallback;
  // Walk up parent_id in blocks to the nearest enclosing step, matching parsePlanFile (steps indented under a decision
  // do not take the decision as their step parent) without ever mapping through text slugs.
  const parentStepOf = (id: string): string | undefined => {
    const seen = new Set<string>([id]);
    let cur = byId.get(id)?.parent_id ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const block = byId.get(cur);
      if (!block) return undefined;
      if (block.kind === 'step') return block.id;
      cur = block.parent_id;
    }
    return undefined;
  };
  const mapStep = (s: PlanStep): PlanStep => {
    const k = keyAt(s.line, s.key);
    const parent = idAt.has(s.line) ? parentStepOf(k) : s.parent;
    const { parent: _old, ...rest } = s;
    return parent ? { ...rest, key: k, parent } : { ...rest, key: k };
  };
  const plan: PlanFile = {
    title: parsed.title,
    checkpoints: parsed.checkpoints.map((cp) => {
      const cpKey = keyAt(cp.line, cp.key);
      return {
        ...cp,
        key: cpKey,
        steps: cp.steps.map(mapStep),
        decisions: cp.decisions.map((d) => ({ ...d, key: keyAt(d.line, d.key), checkpoint: cpKey })),
      };
    }),
    steps: parsed.steps.map(mapStep),
    decisions: parsed.decisions.map((d) => ({ ...d, key: keyAt(d.line, d.key) })),
  };
  return { text, plan, revs, revision: exported.revision, dbId: exported.dbId };
}

const STATUS: Record<string, VerificationStatus> = { passed: 'pass', failed: 'fail', error: 'timeout' };

/** Each checkpoint's last finished check run, as the proof the Plan tab shows. Old imported results count as proof too. */
function checksOf(view: WorkspaceDb, plan: PlanFile): Record<string, PlanEvidence> {
  const out: Record<string, PlanEvidence> = {};
  const last = view.sqlite.prepare("SELECT status, sha, started_at, finished_at FROM check_runs WHERE item_id = ? AND status != 'running' ORDER BY id DESC LIMIT 1");
  for (const cp of plan.checkpoints) {
    const run = last.get(cp.key) as { status: string; sha: string | null; started_at: string; finished_at: string | null } | undefined;
    if (!run) continue;
    out[cp.key] = {
      ...(run.sha ? { lastVerificationSha: run.sha } : {}),
      lastVerificationStatus: STATUS[run.status] ?? 'fail',
      canProgress: run.status === 'passed',
      at: run.finished_at ?? run.started_at,
    };
  }
  return out;
}

type Row = Record<string, unknown> | null;

/**
 * What changed in the plan, newest first, read from the recorded rows of each change: an item added, removed, ticked,
 * unticked or answered. Changes kept only as summaries (old history imported by the move) have no rows and are left out.
 */
export function planChangesOf(view: WorkspaceDb, limit: number): PlanFileChange[] {
  const out: PlanFileChange[] = [];
  const rows = view.sqlite.prepare('SELECT at, by, rows FROM changes WHERE rows IS NOT NULL ORDER BY seq DESC LIMIT 1000').all() as Array<{ at: string; by: string; rows: string }>;
  for (const change of rows) {
    let parsed: Array<{ table: string; id: string; before: Row; after: Row }>;
    try { parsed = JSON.parse(change.rows); } catch { continue; }
    const found: PlanFileChange[] = [];
    for (const row of parsed) {
      if (row.table !== 'blocks') continue;
      const state = row.after ?? row.before;
      const kind = state?.kind as string | undefined;
      if (kind !== 'checkpoint' && kind !== 'step' && kind !== 'decision') continue;
      const text = String(state?.name ?? '');
      const answerOf = (r: Row) => (r ? parseDetail('decision', String(r.detail ?? '')).answer : undefined);
      const entry = (action: PlanFileChange['action'], note?: string) => found.push({ at: change.at, by: change.by, action, kind: kind as PlanItemKind, key: row.id, text, ...(note ? { note } : {}) });
      const was = Number(row.before?.done ?? 0) === 1;
      const is = Number(row.after?.done ?? 0) === 1;
      if (!row.before) entry(is && kind === 'decision' && answerOf(row.after) ? 'answered' : 'added', answerOf(row.after));
      else if (!row.after) entry('removed');
      else if (!was && is) entry(kind === 'decision' ? 'answered' : 'ticked', answerOf(row.after));
      else if (was && !is) entry('unticked');
      else if (kind === 'decision' && answerOf(row.after) && answerOf(row.after) !== answerOf(row.before)) entry('answered', answerOf(row.after));
    }
    out.push(...found);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** Now, when it names an open step that is not a heading for other steps. */
function nowOf(view: WorkspaceDb, plan: PlanFile): PlanNow | null {
  const row = view.sqlite.prepare('SELECT item_id, by, at FROM now WHERE id = 1').get() as { item_id: string; by: string; at: string } | undefined;
  if (!row) return null;
  return workableSteps(plan).some((step) => step.key === row.item_id) ? { key: row.item_id, by: row.by, at: row.at } : null;
}

function withRevs<T extends { key: string }>(item: T, revs: Map<string, number>): T & { id: string; rev?: number } {
  const rev = revs.get(item.key);
  return { ...item, id: item.key, ...(rev !== undefined ? { rev } : {}) };
}

/** Everything the Plan tab shows, from the database: the shape of `planFileForApp`, plus ids, revs and the poll token. */
export async function planDbForApp(root: string) {
  return readAppDb(root, (view) => {
    const read = readPlanDb(view);
    const base = planViewOf({ text: read.text, plan: read.plan, source: 'file' }, checksOf(view, read.plan), planChangesOf(view, 15), nowOf(view, read.plan));
    return {
      ...base,
      store: 'database' as const,
      revision: read.revision,
      dbId: read.dbId,
      checkpoints: base.checkpoints.map((cp) => ({
        ...withRevs(cp, read.revs),
        steps: cp.steps.map((s) => withRevs(s, read.revs)),
        decisions: cp.decisions.map((d) => withRevs(d, read.revs)),
      })),
      steps: base.steps.map((s) => withRevs(s, read.revs)),
      decisions: base.decisions.map((d) => withRevs(d, read.revs)),
    };
  });
}

/** The plan with ids as keys, its checks, Now and changes: for readers that build their own view (Needs you, News). */
export async function planDbParts(root: string, changesLimit = 300) {
  return readAppDb(root, (view) => {
    const read = readPlanDb(view);
    return { read, checks: checksOf(view, read.plan), changes: planChangesOf(view, changesLimit), now: nowOf(view, read.plan) };
  });
}

// ─── Changes ────────────────────────────────────────────────────────────────

/** A change the database refused, with what the person is told. `status` is the HTTP answer. */
export class PlanDbChangeError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly code: string, readonly detail?: string) {
    super(message);
    this.name = 'PlanDbChangeError';
  }
}

const CONFLICT_CODES = new Set(['rev_conflict', 'stale_revision', 'db_changed', 'history_pruned', 'check_required']);

/** Turns a refused batch into what the person is told. */
export function refusalOf(result: Extract<BatchResult, { ok: false }>, words: (issue: Issue) => string): PlanDbChangeError {
  const issue = result.errors[0]!;
  const status = CONFLICT_CODES.has(issue.code) ? 409 : issue.code === 'not_found' ? 404 : 400;
  return new PlanDbChangeError(words(issue), status, issue.code, issue.message);
}

interface Item { id: string; kind: PlanItemKind; words: string; rev: number; done: boolean; check?: string | null }

/** For tests: runs after an item was read for a change and before the change is applied, where another writer could land. */
export const planDbSeams: { afterRead?: () => Promise<void> | void } = {};

async function itemOf(root: string, key: string): Promise<Item> {
  const found = await readAppDb(root, (view) => {
    const read = readPlanDb(view);
    const item = planItems(read.plan).find((candidate) => candidate.key === key);
    if (!item) return null;
    const kind: PlanItemKind = 'question' in item ? 'decision' : 'title' in item ? 'checkpoint' : 'step';
    return {
      id: item.key, kind, done: item.done, rev: read.revs.get(item.key) ?? 0,
      words: 'question' in item ? item.question : 'title' in item ? item.title : item.text,
      ...('title' in item && item.check !== undefined ? { check: item.check } : {}),
    };
  });
  if (!found) throw new PlanFileError(`Nothing in ${PLAN_FILE} matches "${key}" any more. Read the plan again.`, 'not_found');
  await planDbSeams.afterRead?.();
  return found;
}

/** The words or rev the app sent must still be the item's: otherwise someone changed it since it was read. */
function sameAsRead(item: Item, sent: { expected?: string; rev?: number }): void {
  const changed = (sent.rev !== undefined && sent.rev !== item.rev) || (sent.expected !== undefined && sent.expected.trim() !== item.words.trim());
  if (changed) {
    throw new PlanDbChangeError(`This changed since you read it: it now reads "${item.words}". Nothing was changed; look at it again.`, 409, 'rev_conflict');
  }
}

/** Applies ops as the person (`user`), then writes the exports. Refusals become {@link PlanDbChangeError}. */
export async function applyForApp(root: string, ops: Op[], options: { by?: string; words?: (issue: Issue) => string; ifRevision?: number; dbId?: string } = {}): Promise<Extract<BatchResult, { ok: true }>> {
  return writeAppDb(root, async (db) => {
    // Without a revision the caller read, the batch is made against the database as it is now; each op then carries the
    // rev it needs (a card's, an item's), which is what refuses a change someone made since.
    const live = options.ifRevision === undefined || options.dbId === undefined
      ? await readWithRetry(db, () => getRevision(db))
      : null;
    const at = { revision: options.ifRevision ?? live!.revision, dbId: options.dbId ?? live!.dbId };
    const result = await applyBatch(db, { ops, ifRevision: at.revision, dbId: at.dbId }, { by: options.by ?? 'user' });
    if (!result.ok) throw refusalOf(result, options.words ?? personWords);
    await publishExports(root, db).catch((error: unknown) => {
      // the change is made; a file that could not be written is written by the next change
      process.stderr.write(`PLAN.md and contextspace-data.json were not written: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    return result;
  });
}

function personWords(issue: Issue): string {
  switch (issue.code) {
    case 'rev_conflict': case 'stale_revision':
      return 'This changed since you read it (someone else changed it meanwhile). Nothing was changed; look at it again.';
    case 'db_changed':
      return 'The workspace database was replaced since you read it (a backup was restored). Nothing was changed; look again.';
    case 'check_required':
      return 'This checkpoint has a check that has not passed for what it says now. Run its check, then tick it.';
    default:
      return issue.message.replace(/^op \d+ \([^)]*\): /, '');
  }
}

/** Where a loose step or decision goes: the `## Steps` or `## Decisions` section, made at the end when there is none. */
async function looseSpot(root: string, heading: 'Steps' | 'Decisions'): Promise<{ where: Record<string, unknown>; before: Op[] }> {
  return readAppDb(root, (view) => {
    const blocks = view.sqlite.prepare('SELECT id, kind, text, parent_id FROM blocks ORDER BY ord, id').all() as Array<{ id: string; kind: string; text: string; parent_id: string | null }>;
    const section = blocks.find((b) => b.kind === 'heading' && new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(b.text));
    if (section) return { where: { in: section.id }, before: [] };
    const last = [...blocks].reverse().find((b) => b.parent_id === null);
    if (!last) throw new PlanFileError(`${PLAN_FILE} is empty: add a checkpoint first.`, 'invalid');
    return { where: { in: '$section' }, before: [{ op: 'add', kind: 'heading', level: 2, text: heading, after: last.id, as: 'section' }] };
  });
}

/** Runs a checkpoint's check and records the run in the database. Returns the run and whether it passed. */
async function runCheckDb(root: string, item: Item, options: { expectedRev?: number } = {}): Promise<{ passed: boolean; status: VerificationStatus; itemRev: number }> {
  const run = await writeAppDb(root, (db) => startCheckRun(db, item.id, {
    by: 'user',
    ...(options.expectedRev !== undefined ? { expectedRev: options.expectedRev } : {}),
  }), { retry: false }).catch((error: unknown) => {
    if (error instanceof WorkspaceDbError && error.code === 'invalid') {
      throw new PlanFileError(error.message, 'invalid');
    }
    throw error;
  });
  const { verifyWorkspace } = await import('./verify.js');
  let status: VerificationStatus = 'fail';
  let passed = false;
  let failedToRun = false;
  try {
    const report = await verifyWorkspace(root, { command: run.command ?? undefined, timeoutMs: 30 * 60_000 });
    status = report.overallStatus;
    passed = report.canProgress;
  } catch {
    failedToRun = true;
  }
  await writeAppDb(root, (db) => finishCheckRun(db, run.id, { exitCode: passed ? 0 : 1, error: failedToRun || status === 'timeout', dbId: run.dbId }), { retry: false });
  return { passed, status, itemRev: run.itemRev };
}

/**
 * Applies one change the person made in the app, to the database. The same changes and sentences as
 * `changePlanFileForApp`. Ticking a checkpoint with a check runs the check first, records the run, and ticks only when it
 * passed and the checkpoint is still what was checked.
 */
export async function changePlanDbForApp(root: string, change: PlanFileAppChange & { rev?: number }): Promise<{ message: string }> {
  const rev = (change as { rev?: number }).rev;
  switch (change.type) {
    case 'tick': {
      const item = await itemOf(root, change.key);
      sameAsRead(item, { expected: change.expected, rev });
      if (change.done && item.kind === 'checkpoint' && item.check !== undefined && !item.done) {
        const run = await runCheckDb(root, item, { expectedRev: item.rev });
        if (!run.passed) {
          throw new PlanFileError(`"${item.words}" stays open: its check ${run.status === 'timeout' ? 'took too long' : 'failed'}. Fix what fails, then tick it again.`, 'invalid');
        }
      }
      await applyForApp(root, [{ op: change.done ? 'tick' : 'untick', id: item.id, rev: item.rev }]);
      return { message: `${change.done ? 'Ticked' : 'Unticked'} "${item.words}".` };
    }
    case 'answer': {
      const item = await itemOf(root, change.key);
      sameAsRead(item, { expected: change.expected, rev });
      await applyForApp(root, [{ op: 'answer', id: item.id, text: change.answer, rev: item.rev }]);
      return { message: `Answered "${item.words}".` };
    }
    case 'add': {
      if (change.checkpoint) {
        const cp = await itemOf(root, change.checkpoint);
        if (cp.kind !== 'checkpoint') throw new PlanFileError(`There is no checkpoint "${change.checkpoint}" in ${PLAN_FILE}.`, 'not_found');
        await applyForApp(root, [{ op: 'add', kind: 'step', text: change.step, under: cp.id }]);
      } else {
        const spot = await looseSpot(root, 'Steps');
        await applyForApp(root, [...spot.before, { op: 'add', kind: 'step', text: change.step, ...spot.where }]);
      }
      return { message: `Added "${change.step.trim()}".` };
    }
    case 'decide': {
      const d = change.decision;
      const fields = { kind: 'decision', text: d.question, ...(d.suggested?.length ? { suggested: d.suggested } : {}), ...(d.ifNoAnswer?.trim() ? { ifNoAnswer: d.ifNoAnswer } : {}), ...(d.detail?.trim() ? { detail: d.detail } : {}) };
      if (change.checkpoint) {
        const cp = await itemOf(root, change.checkpoint);
        if (cp.kind !== 'checkpoint') throw new PlanFileError(`There is no checkpoint "${change.checkpoint}" in ${PLAN_FILE}.`, 'not_found');
        await applyForApp(root, [{ op: 'add', ...fields, under: cp.id }]);
      } else {
        const spot = await looseSpot(root, 'Decisions');
        await applyForApp(root, [...spot.before, { op: 'add', ...fields, ...spot.where }]);
      }
      return { message: `Added the decision "${d.question.trim()}".` };
    }
    case 'reopen': {
      const item = await itemOf(root, change.key);
      sameAsRead(item, { expected: change.expected, rev });
      await applyForApp(root, [{ op: 'untick', id: item.id, rev: item.rev }, { op: 'add', kind: 'step', text: `Reopened: ${change.reason}`, under: item.id }]);
      return { message: `Reopened "${item.words}".` };
    }
    case 'now': {
      let item: Item | null;
      try {
        item = await itemOf(root, change.key);
      } catch (error) {
        if (error instanceof PlanFileError && error.code === 'not_found') item = null;
        else throw error;
      }
      if (!item || item.kind !== 'step') throw new PlanFileError(`Only an open step can be worked on now. Nothing in ${PLAN_FILE} is a step called "${change.key}".`, item ? 'invalid' : 'not_found');
      await applyForApp(root, [{ op: 'now', id: item.id }], { words: (issue) => issue.message.replace(/^op \d+ \([^)]*\): /, '') });
      return { message: `Working on "${item.words}" now.` };
    }
    case 'now-clear':
      await applyForApp(root, [{ op: 'now', id: null }]);
      return { message: 'No step is marked as being worked on.' };
    case 'check': {
      const item = await itemOf(root, change.key);
      if (item.kind !== 'checkpoint') throw new PlanFileError(`There is no checkpoint "${change.key}" in ${PLAN_FILE}.`, 'not_found');
      const run = await runCheckDb(root, item);
      return { message: run.passed ? 'The check passed.' : `The check ${run.status === 'timeout' ? 'took too long' : 'failed'}.` };
    }
  }
}
