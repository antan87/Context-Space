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

import { randomUUID } from 'node:crypto';
import { PLAN_FILE, PlanFileError, parsePlanFile, planItems, workableSteps, type PlanFile, type PlanStep } from './plan-file.js';
import { planViewOf, type PlanFileAppChange } from './plan-file-app.js';
import type { PlanFileChange, PlanItemKind, PlanNow } from './plan-file-store.js';
import { readAppDb, writeAppDb } from './workspace-db-app.js';
import { publishExports } from './workspace-db-exports.js';
import { WorkspaceMovedError } from './workspace-db-switch.js';
import { runDbWrite, type DbBatchOptions } from './workspace-db-write.js';
import {
  WorkspaceDbError, exportPlan, getRevision, parseDetail, readDbId, readRequestReplay,
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
  if (limit === 0) return out;
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
export function readPlanView(view: WorkspaceDb) {
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
}

export const planDbForApp = (root: string) => readAppDb(root, readPlanView);

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

interface Item { id: string; kind: PlanItemKind; words: string; rev: number; done: boolean; answer?: string; check?: string | null; dbId: string; revision: number }

/** For tests: runs after an item was read for a change and before the change is applied, where another writer could land. */
export const planDbSeams: { afterRead?: () => Promise<void> | void } = {};

async function itemOf(root: string, key: string, read?: PlanDbRead): Promise<Item> {
  const state = read ?? await readAppDb(root, readPlanDb);
  const item = planItems(state.plan).find((candidate) => candidate.key === key);
  if (!item) throw new PlanFileError(`Nothing in ${PLAN_FILE} matches "${key}" any more. Read the plan again.`, 'not_found');
  const kind: PlanItemKind = 'question' in item ? 'decision' : 'title' in item ? 'checkpoint' : 'step';
  await planDbSeams.afterRead?.();
  return {
    id: item.key, kind, done: item.done, rev: state.revs.get(item.key) ?? 0, dbId: state.dbId, revision: state.revision,
    words: 'question' in item ? item.question : 'title' in item ? item.title : item.text,
    ...('question' in item && item.answer !== undefined ? { answer: item.answer } : {}),
    ...('title' in item && item.check !== undefined ? { check: item.check } : {}),
  };
}

/** The words or rev the app sent must still be the item's: otherwise someone changed it since it was read. */
function sameAsRead(item: Item, sent: { expected?: string; rev?: number; dbId?: string }): void {
  if (sent.dbId !== undefined && sent.dbId !== item.dbId) {
    throw new PlanDbChangeError('The workspace database was replaced since you read the plan. Read it again before saving.', 409, 'db_changed');
  }
  const changed = (sent.rev !== undefined && sent.rev !== item.rev) || (sent.expected !== undefined && sent.expected.trim() !== item.words.trim());
  if (changed) {
    throw itemConflict(item);
  }
}

function itemConflict(item: Item): PlanDbChangeError {
  const answer = item.answer === undefined ? '' : ` The current answer is "${item.answer}".`;
  return Object.assign(
    new PlanDbChangeError(`This changed since you read it: it now reads "${item.words}" (rev ${item.rev}).${answer} Read \`ctxspace plan ${item.id}\` again and send its rev and dbId to retry.`, 409, 'rev_conflict'),
    { current: { id: item.id, rev: item.rev, done: item.done, answer: item.answer ?? null } },
  );
}

/** Applies ops as the person (or the named assistant), then writes the exports. */
export async function applyForApp(root: string, ops: Op[], options: Omit<DbBatchOptions, 'by'> & { by?: string; words?: (issue: Issue) => string } = {}): Promise<Extract<BatchResult, { ok: true }>> {
  const { words, by = 'user', ...batch } = options;
  const result = await runDbWrite(root, { type: 'batch', ops, options: { ...batch, by } });
  if (!result.ok) throw refusalOf(result, words ?? personWords);
  return result;
}

function personWords(issue: Issue): string {
  switch (issue.code) {
    case 'rev_conflict': case 'stale_revision':
      return issue.message.replace(/^op \d+ \([^)]*\): /, '');
    case 'db_changed':
      return 'The workspace database was replaced since you read it (a backup was restored). Nothing was changed; look again.';
    case 'check_required':
      return 'This checkpoint has a check that has not passed for what it says now. Run its check, then tick it.';
    default:
      return issue.message.replace(/^op \d+ \([^)]*\): /, '');
  }
}

/** Where a loose step or decision goes: the `## Steps` or `## Decisions` section, made at the end when there is none. */
export async function looseSpot(root: string, heading: 'Steps' | 'Decisions'): Promise<{ where: Record<string, unknown>; before: Op[]; dbId: string; ifRevision: number }> {
  return readAppDb(root, (view) => {
    const blocks = view.sqlite.prepare('SELECT id, kind, text, parent_id FROM blocks ORDER BY ord, id').all() as Array<{ id: string; kind: string; text: string; parent_id: string | null }>;
    const { dbId, revision: ifRevision } = getRevision(view);
    const section = blocks.find((b) => b.kind === 'heading' && new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(b.text));
    if (section) return { where: { in: section.id }, before: [], dbId, ifRevision };
    const last = [...blocks].reverse().find((b) => b.parent_id === null);
    if (!last) throw new PlanFileError(`${PLAN_FILE} is empty: add a checkpoint first.`, 'invalid');
    return { where: { in: '$section' }, before: [{ op: 'add', kind: 'heading', level: 2, text: heading, after: last.id, as: 'section' }], dbId, ifRevision };
  });
}

/** Runs a checkpoint's check and records the run in the database. Returns the run and whether it passed. */
async function runCheckDb(root: string, item: Item, by: string, expectedRev?: number, defaultCheck?: boolean): Promise<PlanEvidence> {
  const run = await runDbWrite(root, { type: 'check-start', id: item.id, options: { by, expectedRev, defaultCheck, dbId: item.dbId } }).catch((error: unknown) => {
    if (error instanceof WorkspaceDbError && error.code === 'invalid') throw new PlanFileError(error.message, 'invalid');
    throw error;
  });
  const { verifyWorkspace } = await import('./verify.js');
  let status: VerificationStatus = 'fail';
  let passed = false;
  let failedToRun = false;
  let sha: string | undefined;
  try {
    const report = await verifyWorkspace(root, { command: run.command ?? undefined, timeoutMs: 30 * 60_000 });
    status = report.overallStatus;
    passed = report.canProgress;
    sha = report.repos?.[0]?.headSha;
  } catch {
    failedToRun = true;
  }
  const finished = await runDbWrite(root, { type: 'check-finish', id: run.id,
    outcome: { exitCode: passed ? 0 : 1, error: failedToRun || status === 'timeout', dbId: run.dbId, sha },
  });
  return {
    ...(sha ? { lastVerificationSha: sha } : {}),
    lastVerificationStatus: status, canProgress: passed, at: finished.finishedAt ?? finished.startedAt,
  };
}

/** Looks up an add before resolving its destination, which may have changed since it was committed. */
export async function replayPlanAdd(root: string, requestId: string, requestSource: string, dbId?: string) {
  const checkGeneration = (view: WorkspaceDb) => {
    if (dbId !== undefined && readDbId(view.sqlite) !== dbId) {
      throw new PlanDbChangeError('The workspace database was restored since you opened Add step. Close this form and open Add step again.', 409, 'db_changed');
    }
  };
  const replay = await readAppDb(root, (view) => {
    checkGeneration(view);
    const result = readRequestReplay(view, requestId, requestSource);
    if (!result) return undefined;
    if (!result.ok) throw refusalOf(result, personWords);
    return { key: result.newIds.at(-1), plan: readPlanView(view), requestId };
  });
  if (replay) {
    // A worker may have committed and exited before publishing the exports.
    await writeAppDb(root, (db) => {
      checkGeneration(db);
      return publishExports(root, db);
    }).catch((error: unknown) => {
      if (dbId !== undefined && (error instanceof PlanDbChangeError || error instanceof WorkspaceMovedError ||
        (error instanceof WorkspaceDbError && error.code === 'replaced'))) throw error;
      process.stderr.write(`Plan request ${requestId} was saved. Could not publish its exports: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
  return replay;
}

/**
 * Applies one change the person made in the app, to the database. The same changes and sentences as
 * `changePlanFileForApp`. Ticking a checkpoint with a check runs the check first, records the run, and ticks only when it
 * passed and the checkpoint is still what was checked.
 */
export async function changePlanDbForApp(root: string, change: PlanFileAppChange & { rev?: number; dbId?: string }, options: { by?: string; read?: PlanDbRead; rerunCheck?: boolean; strictRevision?: boolean; defaultCheck?: boolean; requestId?: string; requestSource?: string } = {}): Promise<{ message: string; key?: string; evidence?: PlanEvidence; plan?: ReturnType<typeof readPlanView>; requestId?: string }> {
  const { by = 'user', read } = options;
  const { rev, dbId } = change;
  const itemFor = (key: string) => itemOf(root, key, read);
  const apply = (ops: Op[], item?: Item) => applyForApp(root, ops, {
    by, dbId: item?.dbId ?? read?.dbId, ifRevision: item?.revision ?? read?.revision, strictRevision: options.strictRevision,
    implicitRevision: read === undefined,
  });
  const requiredRev = (item: Item) => {
    const observed = rev ?? read?.revs.get(item.id);
    if (observed !== undefined) return observed;
    if (item.answer !== undefined) throw itemConflict(item);
    throw new PlanDbChangeError('Send the rev and dbId from the plan you read. Read it again before saving.', 409, 'db_changed');
  };
  switch (change.type) {
    case 'tick': {
      const item = await itemFor(change.key);
      sameAsRead(item, { expected: change.expected, rev, dbId });
      const observed = requiredRev(item);
      if (change.done && item.kind === 'checkpoint' && item.check !== undefined && (!item.done || options.rerunCheck)) {
        const run = await runCheckDb(root, item, by, item.rev);
        if (!run.canProgress) {
          throw new PlanFileError(`"${item.words}" stays open: its check ${run.lastVerificationStatus === 'timeout' ? 'took too long' : 'failed'}. Fix what fails, then tick it again.`, 'invalid');
        }
      }
      await apply([{ op: change.done ? 'tick' : 'untick', id: item.id, rev: observed }], item);
      return { message: `${change.done ? 'Ticked' : 'Unticked'} "${item.words}".` };
    }
    case 'answer': {
      const item = await itemFor(change.key);
      sameAsRead(item, { expected: change.expected, rev, dbId });
      const observed = rev ?? read?.revs.get(item.id);
      if (item.answer !== undefined && observed === undefined) throw itemConflict(item);
      try {
        await apply([{ op: 'answer', id: item.id, text: change.answer, rev: observed }], item);
      } catch (error) {
        if (error instanceof PlanDbChangeError && ['rev_conflict', 'rev_required', 'stale_revision'].includes(error.code)) {
          const current = await itemOf(root, change.key).catch(() => null);
          if (current?.dbId === item.dbId) throw itemConflict(current);
        }
        throw error;
      }
      return { message: `Answered "${item.words}".` };
    }
    case 'add':
    case 'decide': {
      const decision = change.type === 'decide' ? change.decision : undefined;
      const text = change.type === 'add' ? change.step : change.decision.question;
      const fields = {
        op: 'add', kind: decision ? 'decision' : 'step', text,
        ...(decision?.suggested?.length ? { suggested: decision.suggested } : {}),
        ...(decision?.ifNoAnswer?.trim() ? { ifNoAnswer: decision.ifNoAnswer } : {}),
        ...(decision?.detail?.trim() ? { detail: decision.detail } : {}),
      };
      const requestId = options.requestId ?? randomUUID();
      const requestSource = options.requestSource ?? JSON.stringify({ plan: change, by });
      const message = decision ? `Added the decision "${text.trim()}".` : `Added "${text.trim()}".`;
      if (dbId !== undefined || (options.requestId && options.requestSource === undefined)) {
        const replay = await replayPlanAdd(root, requestId, requestSource, dbId);
        if (replay) return { message, ...replay };
      }
      const write = async (ops: Op[], guards: { dbId: string; ifRevision: number; strictRevision?: boolean }) => {
        const { result, plan } = await runDbWrite(root, {
          type: 'plan-batch', ops, options: { ...guards, by, requestId, requestSource },
        });
        if (!result.ok) throw refusalOf(result, personWords);
        return { message, key: result.newIds.at(-1), plan, requestId };
      };
      if (change.checkpoint) {
        const cp = await itemFor(change.checkpoint);
        if (cp.kind !== 'checkpoint' && cp.kind !== 'step') throw new PlanFileError(`No checkpoint or step "${change.checkpoint}" on the plan. Ids: \`ctxspace plan\`.`, 'not_found');
        return write([{ ...fields, under: cp.id }], { dbId: dbId ?? cp.dbId, ifRevision: cp.revision, strictRevision: options.strictRevision });
      }
      const { where, before, dbId: currentDbId, ifRevision } = await looseSpot(root, decision ? 'Decisions' : 'Steps');
      return write([...before, { ...fields, ...where }], {
        dbId: dbId ?? read?.dbId ?? currentDbId, ifRevision: options.strictRevision ? read?.revision ?? ifRevision : ifRevision, strictRevision: true,
      });
    }
    case 'reopen': {
      const item = await itemFor(change.key);
      sameAsRead(item, { expected: change.expected, rev, dbId });
      await apply([{ op: 'untick', id: item.id, rev: requiredRev(item) }, { op: 'add', kind: 'step', text: `Reopened: ${change.reason}`, under: item.id }], item);
      return { message: `Reopened "${item.words}".` };
    }
    case 'now': {
      let item: Item | null;
      try {
        item = await itemFor(change.key);
      } catch (error) {
        if (error instanceof PlanFileError && error.code === 'not_found') item = null;
        else throw error;
      }
      if (!item || item.kind !== 'step') throw new PlanFileError(`Only an open step can be worked on now. Nothing in ${PLAN_FILE} is a step called "${change.key}".`, item ? 'invalid' : 'not_found');
      await apply([{ op: 'now', id: item.id }], item);
      return { message: `Working on "${item.words}" now.` };
    }
    case 'now-clear':
      await apply([{ op: 'now', id: null }]);
      return { message: 'No step is marked as being worked on.' };
    case 'check': {
      const item = await itemFor(change.key);
      if (item.kind !== 'checkpoint') throw new PlanFileError(`There is no checkpoint "${change.key}" in ${PLAN_FILE}.`, 'not_found');
      const evidence = await runCheckDb(root, item, by, read ? item.rev : rev, options.defaultCheck);
      return { evidence, message: evidence.canProgress ? 'The check passed.' : `The check ${evidence.lastVerificationStatus === 'timeout' ? 'took too long' : 'failed'}.` };
    }
  }
}
