/**
 * @module core/workspace-db/check-runs
 * Runs of a checkpoint's check, and the guard that keeps a checkpoint with a check from being ticked without one.
 *
 * A run row is written BEFORE the check runs and captures the database, the checkpoint, its `rev` and the effective
 * check (kind and command). It is finished with the exit code; `passed` means exit 0. The guard (in `applyBatch`, on the
 * final state of a batch) lets a checkpoint end ticked only when a passing, non-legacy run matches the checkpoint's
 * rev as the batch read it and its check as the batch leaves it. A run never changes the plan or its revision.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { beginImmediate, commitTransaction, readDbId, type WorkspaceDb } from './connection.js';
import { WorkspaceDbError } from './errors.js';
import { effectiveCheck } from './ops.js';

/** What a run proves: the checkpoint's words and detail, not its checkbox (which a tick changes). */
export function contentHash(text: string, detail: string): string {
  return createHash('sha256').update(`${text.replace(/\[[ xX]\]/, '[ ]')}\u0000${detail}`).digest('hex').slice(0, 32);
}

export interface CheckRun {
  id: number;
  itemId: string;
  itemRev: number;
  contentHash: string;
  dbId: string;
  checkKind: 'workspace' | 'command';
  command: string | null;
  status: 'running' | 'passed' | 'failed' | 'error';
  exitCode: number | null;
  sha: string | null;
  startedAt: string;
  finishedAt: string | null;
  by: string;
  legacy: boolean;
}

const toRun = (r: Record<string, unknown>): CheckRun => ({
  id: Number(r.id), itemId: r.item_id as string, itemRev: Number(r.item_rev), contentHash: r.content_hash as string, dbId: r.db_id as string,
  checkKind: r.check_kind as CheckRun['checkKind'], command: (r.command as string | null) ?? null,
  status: r.status as CheckRun['status'], exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
  sha: (r.sha as string | null) ?? null, startedAt: r.started_at as string, finishedAt: (r.finished_at as string | null) ?? null,
  by: r.by as string, legacy: Number(r.legacy) === 1,
});

/**
 * Writes the run row for a checkpoint, before its check runs. Throws when the item is not a checkpoint with a check
 * (nothing to run). The caller runs the check, then calls {@link finishCheckRun}.
 */
export function startCheckRun(db: WorkspaceDb, itemId: string, options: { by: string; sha?: string }): Promise<CheckRun> {
  return db.serialize(() => startLocked(db, itemId, options));
}

async function startLocked(db: WorkspaceDb, itemId: string, options: { by: string; sha?: string }): Promise<CheckRun> {
  await beginImmediate(db);
  try {
    const item = db.sqlite.prepare("SELECT id, kind, rev, text, detail FROM blocks WHERE id = ?").get(itemId) as { id: string; kind: string; rev: number; text: string; detail: string } | undefined;
    if (!item) throw new WorkspaceDbError('invalid', `No plan item ${itemId}.`);
    if (item.kind !== 'checkpoint') throw new WorkspaceDbError('invalid', `${itemId} is a ${item.kind}; only a checkpoint has a check to run.`);
    const check = effectiveCheck(item.detail);
    if (check.kind === 'none') throw new WorkspaceDbError('invalid', `${itemId} has no Check: line, so there is nothing to run. Tick it directly.`);
    const hash = contentHash(item.text, item.detail);
    const dbId = readDbId(db.sqlite);
    // A retry of a start whose answer was lost finds the run it already made, not a second one: the same checkpoint at the
    // same rev, content and check, by the same caller, still running.
    const again = db.sqlite.prepare("SELECT id FROM check_runs WHERE item_id = ? AND item_rev = ? AND content_hash = ? AND db_id = ? AND check_kind = ? AND command IS ? AND by = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
      .get(itemId, item.rev, hash, dbId, check.kind, check.command, options.by) as { id: number } | undefined;
    let id = again?.id;
    if (id === undefined) {
      const now = new Date().toISOString();
      id = Number(db.sqlite.prepare("INSERT INTO check_runs(item_id, item_rev, content_hash, db_id, check_kind, command, status, sha, started_at, by) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)")
        .run(itemId, item.rev, hash, dbId, check.kind, check.command, options.sha ?? null, now, options.by).lastInsertRowid);
    }
    // read the answer inside the transaction: once the commit has succeeded nothing can make this call fail
    const run = readRun(db.sqlite, id);
    await commitTransaction(db);
    return run;
  } catch (error) {
    try { db.sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
    throw error;
  }
}

/** Records how the check ended. `passed` means exit code 0. Finishing twice is refused. */
export function finishCheckRun(db: WorkspaceDb, runId: number, outcome: { exitCode: number; error?: boolean; dbId: string }): Promise<CheckRun> {
  return db.serialize(() => finishLocked(db, runId, outcome));
}

async function finishLocked(db: WorkspaceDb, runId: number, outcome: { exitCode: number; error?: boolean; dbId: string }): Promise<CheckRun> {
  await beginImmediate(db);
  try {
    const run = db.sqlite.prepare('SELECT status, legacy, db_id FROM check_runs WHERE id = ?').get(runId) as { status: string; legacy: number; db_id: string } | undefined;
    if (!run) throw new WorkspaceDbError('invalid', `No check run ${runId}.`);
    // run numbers repeat across generations (a restored backup), so the run is named together with its generation
    if (outcome.dbId !== run.db_id || outcome.dbId !== readDbId(db.sqlite)) {
      throw new WorkspaceDbError('invalid', `Check run ${runId} belongs to another database generation (it was started in ${run.db_id}, you named ${String(outcome.dbId)}, this is ${readDbId(db.sqlite)}). Start the run again.`);
    }
    if (run.status !== 'running') throw new WorkspaceDbError('invalid', `Check run ${runId} already finished (${run.status}).`);
    const status = outcome.error ? 'error' : outcome.exitCode === 0 ? 'passed' : 'failed';
    db.sqlite.prepare('UPDATE check_runs SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?').run(status, outcome.exitCode, new Date().toISOString(), runId);
    const finished = readRun(db.sqlite, runId);
    await commitTransaction(db);
    return finished;
  } catch (error) {
    try { db.sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
    throw error;
  }
}

function readRun(sqlite: DatabaseSync, id: number): CheckRun {
  return toRun(sqlite.prepare('SELECT * FROM check_runs WHERE id = ?').get(id) as Record<string, unknown>);
}

export function listCheckRuns(db: WorkspaceDb, itemId: string, limit = 20): CheckRun[] {
  return ((db.snapshot ? db.sqlite : db.readerConnection()).prepare('SELECT * FROM check_runs WHERE item_id = ? ORDER BY id DESC LIMIT ?').all(itemId, limit) as Array<Record<string, unknown>>).map(toRun);
}

/** Whether a passing, current, non-legacy run exists for this exact check at this rev. */
export function hasPassingRun(sqlite: DatabaseSync, itemId: string, rev: number, check: { kind: 'workspace' | 'command'; command: string | null }, hash: string): boolean {
  const row = sqlite.prepare("SELECT 1 FROM check_runs WHERE item_id = ? AND item_rev = ? AND content_hash = ? AND db_id = ? AND status = 'passed' AND legacy = 0 AND check_kind = ? AND command IS ?")
    .get(itemId, rev, hash, readDbId(sqlite), check.kind, check.command);
  return row !== undefined;
}
