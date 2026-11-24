/**
 * @module core/workspace-db/batch
 * `applyBatch`: the one write path. A list of ops, all or none, in one `BEGIN IMMEDIATE` transaction, under these rules:
 *
 * - `ifRevision` and `dbId` are required together: a revision number means nothing without the generation (database) it
 *   belongs to, and a restore can land on the same number. `dbId` is checked before anything else, a replayed request
 *   included. When the workspace moved on, the batch is rebased over the changes since, but only when
 *   none of them touched its footprint, their history is still kept in full and `db_id` is the same. Otherwise it is
 *   refused, naming each touching change and what its rows read now.
 * - A per-row `rev` is checked when the op carries one, and is required by `reword`, `detail`, `block.set` and `remove`.
 * - After the ops, the file grammar is checked: the blocks are exported and read back, and a placement that would read
 *   as a different kind is refused (`bad_structure`).
 * - A checkpoint with a check may only end ticked while a passing run matches it (`check_required`).
 * - A `requestId` makes a retry apply once: the same id and payload replays the first result.
 * - Every changed row, before and after, is recorded in `changes`, in the same transaction as the revision.
 */

import { createHash } from 'node:crypto';

import { getMeta, readDbId, readRevision, setMeta, beginImmediate, commitTransaction, type WorkspaceDb } from './connection.js';
import { WorkspaceDbError, isBusyError } from './errors.js';
import { ROOT_KEY, destinationConflicts, footprintOf, reconstructBase, rowRefers, touchedKeys } from './footprint.js';
import { contentHash, hasPassingRun } from './check-runs.js';
import { OpError, effectiveCheck, runOp, LIMITS, type Op, type OpContext, type IssueCode } from './ops.js';
import { structureProblems } from './plan-text.js';
import { Recorder, flushDoc, loadDoc, type ChangedRow, type DocBlock } from './store.js';
import { maybeBackup } from './backup.js';

export interface BatchInput {
  ops: Op[];
  /** The workspace revision the caller read. Required. */
  ifRevision: number;
  /** The database the revision belongs to (`db_id` from the view). Required; refused when it differs. */
  dbId: string;
  requestId?: string;
}

export interface Issue {
  /** The index of the op, or null for a problem with the batch as a whole. */
  op: number | null;
  opName?: string;
  code: IssueCode;
  message: string;
  [extra: string]: unknown;
}

export type BatchResult =
  | {
    ok: true;
    revision: number;
    /** The history row of this change (what `undo` takes). */
    seq: number;
    changed: string[];
    /** `as` names to the ids they became. */
    ids: Record<string, string>;
    newIds: string[];
    requestId?: string;
    rebased?: { from: number; to: number; changes: string[] };
    replayed?: boolean;
  }
  | { ok: false; revision: number; errors: Issue[]; note?: string };

/** The name a change is recorded under: lower case letters, digits, `.`, `_` and `-` only (as the Board does it). */
export function actorName(value: unknown): string {
  if (typeof value !== 'string') return 'user';
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 40).replace(/[-._]+$/, '') || 'user';
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

const refuse = (revision: number, issue: Issue, note?: string): BatchResult => ({ ok: false, revision, errors: [issue], ...(note ? { note } : {}) });

function payloadHash(input: BatchInput, options: BatchOptions): string {
  const payload = options.requestSource === undefined
    ? { ops: input.ops, ifRevision: options.implicitRevision ? null : input.ifRevision, dbId: input.dbId }
    : { source: options.requestSource, dbId: input.dbId };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

const requestCutoff = () => new Date(Date.now() - 7 * 86_400_000).toISOString();

/** Looks up a replay in the caller's snapshot or transaction, using the same identity as applyBatch. */
function readBatchReplay(
  db: WorkspaceDb, requestId: string, hashFor: (dbId: string) => string, revision: number, cutoff = requestCutoff(),
): BatchResult | undefined {
  const prior = db.sqlite.prepare('SELECT payload_hash, result FROM requests WHERE request_id = ? AND at >= ?')
    .get(requestId, cutoff) as { payload_hash: string; result: string } | undefined;
  if (!prior) return undefined;
  const dbId = readDbId(db.sqlite);
  if (prior.payload_hash !== hashFor(dbId)) {
    const former: unknown = JSON.parse(getMeta(db.sqlite, 'former_db_ids') ?? '[]');
    if (Array.isArray(former) && former.some((id) => typeof id === 'string' && prior.payload_hash === hashFor(id))) {
      return refuse(revision, { op: null, code: 'db_changed', dbId, message: `The workspace database was restored since requestId "${requestId}" was used. Read the workspace again before making a new request.` });
    }
    return refuse(revision, { op: null, code: 'request_reused', message: `requestId "${requestId}" was already used with a different batch. Use a new requestId for a new batch; resend the same batch to retry.` });
  }
  return { ...(JSON.parse(prior.result) as Extract<BatchResult, { ok: true }>), requestId, replayed: true };
}

export function readRequestReplay(db: WorkspaceDb, requestId: string, requestSource: string): BatchResult | undefined {
  const revision = readRevision(db.sqlite);
  return readBatchReplay(db, requestId, (dbId) => payloadHash({ ops: [], ifRevision: revision, dbId }, { by: '', requestSource }), revision);
}
/** Describes what an id reads as now, for a refusal. */
function currentOf(db: WorkspaceDb, id: string): string {
  const b = db.sqlite.prepare('SELECT name, text, kind, rev, done FROM blocks WHERE id = ?').get(id) as { name: string | null; text: string; kind: string; rev: number; done: number } | undefined;
  if (b) return `${id} is now rev ${b.rev}${b.done ? ', done' : ''}: ${clip(b.name ?? b.text, 300)}`;
  const c = db.sqlite.prepare('SELECT title, rev FROM cards WHERE id = ?').get(id) as { title: string; rev: number } | undefined;
  return c ? `${id} (card) is now rev ${c.rev}: ${clip(c.title, 200)}` : `${id} no longer exists`;
}

/** Keeps the newest `keepRows` changes plus every change newer than `keepDays`. */
export function pruneHistory(db: WorkspaceDb, options: { keepRows?: number; keepDays?: number } = {}): number {
  const keepRows = options.keepRows ?? 5000;
  const keepDays = options.keepDays ?? 30;
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  const result = db.sqlite.prepare('DELETE FROM changes WHERE seq <= (SELECT coalesce(max(seq), 0) - ? FROM changes) AND at < ?').run(keepRows, cutoff);
  return Number(result.changes);
}

/**
 * Applies a batch. Returns `{ ok: false, errors }` for every refusal (each issue names its op and says what to do),
 * and throws a {@link WorkspaceDbError} only when the database itself fails (`busy`, `read_only`, `replaced`, ...).
 */
interface BatchOptions {
  by: string;
  /** A caller supplied an exact revision precondition. */
  strictRevision?: boolean;
  /** Retries of a public batch without a revision hash the input, independent of the revision found for each attempt. */
  implicitRevision?: boolean;
  /** The Board translates defaults and aliases after receiving a request. Hash the caller's inputs for retries. */
  requestSource?: string;
  /** Internal draft imports contribute to the same transaction, validation, history and revision as ordinary ops. */
  draft?: { edit: (ctx: OpContext) => void; finish: (ctx: OpContext) => void; acceptsCompletedCheck?: (block: DocBlock) => boolean };
  /** Captures a Board response from the transaction, before a successful commit is acknowledged. */
  capture?: (result: Extract<BatchResult, { ok: true }>) => void;
}

export function applyBatch(db: WorkspaceDb, batch: BatchInput, options: BatchOptions): Promise<BatchResult> {
  return db.serialize(() => applyLocked(db, batch, options));
}

async function applyLocked(db: WorkspaceDb, batch: BatchInput, options: BatchOptions): Promise<BatchResult> {
  const sqlite = db.sqlite;
  const shape = checkShape(batch, options.draft !== undefined);
  if (shape) return { ok: false, revision: readRevisionSafe(db), errors: [shape] };
  const by = actorName(options.by);
  const at = new Date().toISOString();
  const hash = payloadHash(batch, options);

  await beginImmediate(db);
  let result: BatchResult;
  try {
    sqlite.exec('PRAGMA defer_foreign_keys = ON');
    const current = readRevision(sqlite);
    const dbId = readDbId(sqlite);

    if (batch.dbId !== dbId) {
      sqlite.exec('ROLLBACK');
      return refuse(current, { op: null, code: 'db_changed', message: `This is not the database you read: you sent dbId "${batch.dbId}", it is "${dbId}" (a backup was restored or the workspace was moved). Read the plan again (\`ctxspace plan\`) and rebuild the batch from it. Nothing was applied.`, dbId });
    }
    if (batch.requestId) {
      // a request older than 7 days is gone, whether or not a later write has pruned its row yet
      const cutoff = requestCutoff();
      sqlite.prepare('DELETE FROM requests WHERE request_id = ? AND at < ?').run(batch.requestId, cutoff);
      const prior = readBatchReplay(db, batch.requestId, (generation) => generation === dbId ? hash : payloadHash({ ...batch, dbId: generation }, options), current, cutoff);
      if (prior) {
        if (prior.ok) options.capture?.(prior);
        sqlite.exec('ROLLBACK');
        return prior;
      }
    }

    if (!Number.isInteger(batch.ifRevision) || batch.ifRevision < 0 || batch.ifRevision > current) {
      sqlite.exec('ROLLBACK');
      return refuse(current, { op: null, code: 'bad_revision', message: `ifRevision ${String(batch.ifRevision)} is not a revision of this workspace (it is at ${current}). Use the revision \`ctxspace plan\` printed.` });
    }

    if (options.strictRevision && batch.ifRevision < current) {
      sqlite.exec('ROLLBACK');
      return refuse(current, { op: null, code: 'stale_revision', currentRevision: current,
        message: `ifRevision ${batch.ifRevision} is stale (the workspace is at revision ${current}). Read the plan again and resend with the current revision. Nothing was applied.` });
    }

    const doc = loadDoc(sqlite);
    const rec = new Recorder(sqlite);

    let rebased: { from: number; to: number; changes: string[] } | undefined;
    if (batch.ifRevision < current) {
      const range = sqlite.prepare('SELECT seq, revision, by, summary, rows, kind FROM changes WHERE revision > ? AND revision <= ? ORDER BY revision').all(batch.ifRevision, current) as Array<{ seq: number; revision: number; by: string; summary: string; rows: string | null; kind: string }>;
      const complete = range.length === current - batch.ifRevision && range.every((c) => c.rows !== null);
      if (!complete) {
        const have = range.filter((c) => c.rows !== null).length;
        sqlite.exec('ROLLBACK');
        return refuse(current, {
          op: null, code: 'history_pruned',
          message: `ifRevision ${batch.ifRevision} is behind revision ${current}, and the history for r${batch.ifRevision + 1}..r${current} is not kept in full (${have} of ${current - batch.ifRevision} changes have their rows), so it cannot be checked whether they touch your ops. Read the plan again (\`ctxspace plan\`) and send the batch with ifRevision ${current}. Nothing was applied.`,
        });
      }
      const footprint = footprintOf(sqlite, doc, batch.ops);
      const touching: Array<{ revision: number; by: string; summary: string; keys: string[] }> = [];
      const parsed = range.map((c) => JSON.parse(c.rows!) as ChangedRow[]);
      range.forEach((change, i) => {
        const rows = parsed[i]!;
        const hit = [...touchedKeys(rows)].filter((k) => footprint.keys.has(k));
        // dependents as they were at the base: a card detached or a link deleted since still names the item
        for (const row of rows) if (rowRefers(row, footprint.refs)) hit.push(`${row.table}:${row.id}`);
        if (hit.length) touching.push({ revision: change.revision, by: change.by, summary: change.summary, keys: [...new Set(hit)] });
      });
      const moved = destinationConflicts(sqlite, doc, batch.ops, reconstructBase(sqlite, [...parsed].reverse()));
      if (touching.length || moved.length) {
        const ids = [...new Set(touching.flatMap((c) => c.keys.map((k) => (k === ROOT_KEY ? ROOT_KEY : k.slice(k.indexOf(':') + 1)))))];
        const lines = touching.map((c) => `  r${c.revision} by ${c.by}: ${clip(c.summary, 160)}`);
        const now = ids.filter((i) => i !== ROOT_KEY).map((i) => `  ${currentOf(db, i)}`);
        const rootNote = ids.includes(ROOT_KEY) ? '\n  (the order of the top level changed)' : '';
        const movedNote = moved.length ? `\nWhere your ops land has changed:\n${moved.map((m) => `  ${m}`).join('\n')}` : '';
        sqlite.exec('ROLLBACK');
        return refuse(current, {
          op: null, code: 'stale_revision',
          message: `ifRevision ${batch.ifRevision} is stale (the workspace is at revision ${current})${touching.length ? `, and ${touching.length} change${touching.length === 1 ? '' : 's'} since touch${touching.length === 1 ? 'es' : ''} what your batch touches:\n${lines.join('\n')}\nCurrent state:\n${now.join('\n')}${rootNote}` : ''}${movedNote}\nRead ${ids.filter((i) => i !== ROOT_KEY).map((m) => `\`ctxspace plan ${m}\``).join(', ') || '`ctxspace plan`'}, adjust your ops to the new text (use "edit" to change only part of a line), then resend with "ifRevision": ${current}. Nothing was applied.`,
          touching: touching.map((c) => ({ revision: c.revision, by: c.by, summary: c.summary })),
          currentRevision: current,
        });
      }
      rebased = { from: batch.ifRevision, to: current, changes: range.map((c) => `r${c.revision} by ${c.by}: ${clip(c.summary, 140)}`) };
    }

    const ctx: OpContext = { db: sqlite, doc, rec, by, at, dbId, observedRevision: !options.implicitRevision, revision: current, refs: new Map(), taken: new Set(), log: [], newIds: [] };
    const errors: Issue[] = [];
    batch.ops.forEach((raw, index) => {
      try {
        runOp(ctx, raw);
      } catch (error) {
        if (!(error instanceof OpError)) throw error;
        const op = raw as Op | undefined;
        errors.push({ op: index, opName: op?.op, code: error.code, message: `op ${index} (${String(op?.op)}${typeof op?.id === 'string' ? ` ${op.id}` : ''}): ${error.message}`, ...error.extra });
      }
    });

    if (options.draft) {
      try { options.draft.edit(ctx); }
      catch (error) {
        if (!(error instanceof OpError)) throw error;
        errors.push({ op: null, code: error.code, message: error.message });
      }
    }
    if (!errors.length) {
      const problems = structureProblems(doc.blocks);
      if (problems.length) {
        errors.push({ op: null, code: 'bad_structure', message: `That arrangement would not read back as meant: ${problems.join('; ')}. The file grammar decides: items at the top indent under the Checkpoints list are checkpoints, so put steps "under" a checkpoint or step. Nothing was applied.` });
      }
    }
    if (!errors.length) errors.push(...checkGuard(db, ctx, options.draft?.acceptsCompletedCheck));
    if (errors.length) {
      sqlite.exec('ROLLBACK');
      return { ok: false, revision: current, errors, note: 'All or none: no op of this batch was applied.' };
    }

    flushDoc(sqlite, doc, rec, by, at);
    options.draft?.finish(ctx);
    const rows = rec.finish();
    const next = current + 1;
    setMeta(sqlite, 'revision', next);
    const summary = clip(ctx.log.join('; '), 300);
    const inserted = sqlite.prepare("INSERT INTO changes(revision, kind, request_id, at, by, summary, rows) VALUES (?, 'batch', ?, ?, ?, ?, ?)")
      .run(next, batch.requestId ?? null, at, by, summary, JSON.stringify(rows));
    result = {
      ok: true, revision: next, seq: Number(inserted.lastInsertRowid), changed: ctx.log,
      ids: Object.fromEntries(ctx.refs), newIds: ctx.newIds, ...(batch.requestId ? { requestId: batch.requestId } : {}), ...(rebased ? { rebased } : {}),
    };
    if (batch.requestId) {
      sqlite.prepare('INSERT INTO requests(request_id, payload_hash, result, revision, at) VALUES (?, ?, ?, ?, ?)').run(batch.requestId, hash, JSON.stringify(result), next, at);
    }
    sqlite.prepare('DELETE FROM requests WHERE at < ?').run(requestCutoff());
    pruneHistory(db);
    options.capture?.(result);
    await commitTransaction(db);
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
    if (isBusyError(error)) throw new WorkspaceDbError('busy', 'The workspace database is busy: another process is writing. Nothing was changed; try again in a moment.', { cause: error });
    throw error;
  }
  afterCommit(db);
  return result;
}

/** Schedules the day's backup after a committed write, without waiting for it. */
export function afterCommit(db: WorkspaceDb): void {
  if (!db.backups || db.readOnly) return;
  const job = maybeBackup(db.workspacePath).catch((error: unknown) => {
    process.stderr.write(`workspace backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }).finally(() => { db.pending.delete(job); });
  db.pending.add(job);
}

function readRevisionSafe(db: WorkspaceDb): number {
  try { return readRevision(db.sqlite); } catch { return 0; }
}

function checkShape(batch: BatchInput, allowEmpty: boolean): Issue | null {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    return { op: null, code: 'invalid', message: 'Send {"ifRevision": <revision>, "ops": [...]}, for example {"ifRevision":12,"ops":[{"op":"tick","id":"s7k2q"}]}.' };
  }
  if (!Array.isArray(batch.ops) || (!allowEmpty && batch.ops.length === 0)) {
    return { op: null, code: 'invalid', message: '"ops" must be a non-empty list. Example: {"ifRevision":12,"ops":[{"op":"tick","id":"s7k2q"}]}' };
  }
  if (batch.ops.length > LIMITS.ops) return { op: null, code: 'limit', message: `A batch has at most ${LIMITS.ops} ops (this one has ${batch.ops.length}). Split it.` };
  if (batch.ifRevision === undefined || batch.ifRevision === null) {
    return { op: null, code: 'missing_revision', message: '"ifRevision" is required: the revision `ctxspace plan` printed when you read the plan, with its "dbId". Example: {"ifRevision":12,"dbId":"a1b2c3d4e5f60718","ops":[...]}. It is how a change made since you read is noticed.' };
  }
  if (typeof batch.dbId !== 'string' || !batch.dbId) {
    return { op: null, code: 'missing_revision', message: '"dbId" is required with "ifRevision": the db_id `ctxspace plan` printed with the revision. A revision number only means something in the database it came from. Example: {"ifRevision":12,"dbId":"a1b2c3d4e5f60718","ops":[...]}.' };
  }
  if (typeof batch.ifRevision !== 'number' || !Number.isInteger(batch.ifRevision)) {
    return { op: null, code: 'bad_revision', message: '"ifRevision" must be the integer revision `ctxspace plan` printed.' };
  }
  if (batch.requestId !== undefined && (typeof batch.requestId !== 'string' || !/^[\w.:@-]{1,100}$/.test(batch.requestId))) {
    return { op: null, code: 'invalid', message: '"requestId" is a short string of letters, digits and . _ : @ - (100 at most).' };
  }
  return null;
}

/**
 * The check-run guard, on the final state. The checkbox transition is judged apart from changes to the content:
 * - a checkpoint is COMPLETED in this batch when a tick turned it from open to ticked (an untick then a tick in one
 *   batch counts) or it is added ticked. A completion with a check needs a passing, non-legacy run of this generation
 *   whose check is the final check, whose `rev` is the rev the batch read and whose content hash is the FINAL content:
 *   a batch that rewords or edits the checkpoint and ticks it needs a run of the changed content, which cannot exist yet;
 * - a ticked checkpoint whose check is changed by the batch is refused (a tick proves the check it was made with);
 * - everything else, including a completion this batch does not touch, is exempt: a reword of a ticked checkpoint, or an
 *   imported completion nobody ran, stays as it is. Undo is outside the guard: it only restores a row to a state it was
 *   recorded in, and refuses when the row moved on.
 */
function checkGuard(db: WorkspaceDb, ctx: OpContext, acceptsCompletedCheck?: (block: DocBlock) => boolean): Issue[] {
  const issues: Issue[] = [];
  for (const b of ctx.doc.blocks) {
    if (b.kind !== 'checkpoint' || !b.done) continue;
    const final = effectiveCheck(b.detail);
    if (final.kind === 'none' || acceptsCompletedCheck?.(b)) continue;
    const describe = final.kind === 'workspace' ? 'the workspace checks' : `\`${final.command}\``;
    const beforeRow = b._new ? null : (b._before as Record<string, unknown>);
    const beforeCheck = beforeRow ? effectiveCheck(String(beforeRow.detail)) : null;
    const checkChanged = beforeCheck !== null && (beforeCheck.kind !== final.kind || beforeCheck.command !== final.command);
    const completed = b._new || b._ticked === true;
    if (!completed) {
      if (checkChanged) issues.push({ op: null, code: 'check_required', id: b.id, message: `${b.id} is ticked and this batch changes its check to ${describe}. A tick proves the check it was made with. Untick it, change the check, then run \`ctxspace plan done ${b.id}\`.` });
      continue;
    }
    if (b._new) {
      issues.push({ op: null, code: 'check_required', id: b.id, message: `New checkpoint ${b.id} has the check ${describe} and cannot be added already ticked. Add it open, then run \`ctxspace plan done ${b.id}\`.` });
      continue;
    }
    if (checkChanged) {
      issues.push({ op: null, code: 'check_required', id: b.id, message: `${b.id}: this batch changes the check to ${describe} and ticks the checkpoint in one go. A run proves one check at one rev, so this cannot pass. Change the check in one batch, run \`ctxspace plan done ${b.id}\`, and let that tick it.` });
      continue;
    }
    const finalHash = contentHash(b.text, b.detail);
    if (!hasPassingRun(db.sqlite, b.id, b._rev0, { kind: final.kind, command: final.command }, finalHash)) {
      const last = db.sqlite.prepare("SELECT id, item_rev, status, legacy, content_hash FROM check_runs WHERE item_id = ? ORDER BY id DESC LIMIT 1").get(b.id) as { id: number; item_rev: number; status: string; legacy: number; content_hash: string } | undefined;
      const why = !last ? 'it has never been run'
        : last.legacy ? 'its only runs are old imported evidence, which never counts'
          : last.item_rev !== b._rev0 ? `its last run (#${last.id}, ${last.status}) was at rev ${last.item_rev} and it is now rev ${b._rev0}`
            : last.status === 'passed' && last.content_hash !== finalHash ? `its last run (#${last.id}) proved different words: this batch changes the checkpoint's line or detail and ticks it in one go, and a run proves only the content it ran against`
              : `its last run (#${last.id}) ${last.status === 'passed' ? 'is for another check' : `is ${last.status}`}`;
      issues.push({ op: null, code: 'check_required', id: b.id, currentRev: b._rev0, message: `${b.id} cannot be ticked: it has the check ${describe}, and no passing run matches it at rev ${b._rev0} (${why}). Run \`ctxspace plan done ${b.id}\`, which runs the check and ticks it when it passes.` });
    }
  }
  return issues;
}
