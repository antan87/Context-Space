/**
 * @module core/workspace-db/undo
 * Undo of one recorded change (v5 point 2). The change's rows say each affected row before and after. Undo applies the
 * inverse only when every one of those rows is still in its "after" state; otherwise it is refused, naming what moved
 * on since. It is itself a change (revision + 1) with its own rows, so it can be undone too.
 *
 * Rows that come back keep their ids and content; their `rev` goes up (never back), so a holder of an old `rev` is
 * still refused. Imported legacy history is summaries only (`rows` is NULL) and has no Undo.
 */

import { beginImmediate, commitTransaction, readDbId, readRevision, setMeta, type WorkspaceDb } from './connection.js';
import { REFERENCES, sameIdentity, snapshotColumns, tableDef } from './definitions.js';
import { structureProblems } from './plan-text.js';
import { WorkspaceDbError, isBusyError } from './errors.js';
import { actorName, afterCommit, pruneHistory, type Issue } from './batch.js';
import { ID_PATTERN } from './ids.js';
import { Recorder, deletedRowRevision, loadDoc, recomputeDerived, selectRow, type ChangedRow, type Row } from './store.js';

export type UndoResult =
  | { ok: true; revision: number; seq: number; undid: number; summary: string }
  | { ok: false; revision: number; errors: Issue[] };


function describeRow(table: string, id: string | number, row: Row | null): string {
  if (row === null) return `${table} ${id} no longer exists`;
  const words = (row.name ?? row.title ?? row.text ?? '') as string;
  return `${table} ${id} is now ${typeof row.rev === 'number' ? `rev ${row.rev}` : 'different'}${words ? `: ${String(words).slice(0, 120)}` : ''}`;
}

/** `dbId` names the generation the `seq` was read in: change numbers repeat across a restored backup, so it is required. */
export function undo(db: WorkspaceDb, seq: number, options: { by: string; dbId: string }): Promise<UndoResult> {
  return db.serialize(() => undoLocked(db, seq, options));
}

/**
 * Rows that depend on a row the undo would DELETE (one the change added) and that the change did not itself touch: they
 * were made or changed later. Read from `REFERENCES`, so every table that names another is covered the same way: children,
 * cards, links (either end), positions, Now, decisions, decision_meta, checks and check_runs.
 */
function newerDependents(sqlite: WorkspaceDb['sqlite'], rows: readonly ChangedRow[]): string[] {
  const inChange = new Set(rows.map((r) => `${r.table}:${r.id}`));
  const found: string[] = [];
  for (const row of rows) {
    if (row.before !== null) continue; // only a row the undo deletes
    const id = String(row.id);
    for (const ref of REFERENCES.filter((r) => r.target === row.table)) {
      const sql = ref.form === 'id'
        ? `SELECT ${ref.key} AS k FROM ${ref.table} WHERE ${ref.column} = ?`
        : `SELECT ${ref.key} AS k FROM ${ref.table} WHERE ${ref.column} = ? OR ${ref.column} LIKE ?`;
      const args = ref.form === 'id' ? [id] : [`checkpoint:${id}`, `checkpoint:${id}#%`];
      for (const r of sqlite.prepare(sql).all(...args) as Array<{ k: string | number }>) {
        if (!inChange.has(`${ref.table}:${r.k}`)) found.push(`${ref.table} ${r.k} (${ref.column}) points at ${row.table} ${id}`);
      }
    }
  }
  return [...new Set(found)];
}

/** After the inverse: every reference of every row it recreated or changed must resolve in the final state. Returns what is missing. */
function missingReferences(sqlite: WorkspaceDb['sqlite'], rows: readonly ChangedRow[]): string[] {
  const missing: string[] = [];
  const exists = (table: string, key: string, id: string) => sqlite.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`).get(id) !== undefined;
  for (const row of rows) {
    if (row.before === null) continue; // a row the undo removed refers to nothing
    for (const ref of REFERENCES.filter((r) => r.table === row.table)) {
      const value = row.before[ref.column];
      if (typeof value !== 'string' || !value) continue;
      let target: string | null = null;
      if (ref.form === 'checkpoint') target = value.startsWith('checkpoint:') ? value.slice(11).replace(/#\d{1,3}$/, '') : null;
      else if (ref.target === 'cards') target = ID_PATTERN.test(value) && value.startsWith('k') ? value : null;
      else target = value;
      if (target === null) continue; // plan:own, commit: and document: nodes name nothing of ours
      if (!exists(ref.target, 'id', target)) missing.push(`${row.table} ${row.id} would point at ${ref.target} ${target} (${ref.column}), which does not exist`);
    }
  }
  return [...new Set(missing)];
}

async function undoLocked(db: WorkspaceDb, seq: number, options: { by: string; dbId: string }): Promise<UndoResult> {
  const sqlite = db.sqlite;
  const by = actorName(options.by);
  const at = new Date().toISOString();
  await beginImmediate(db);
  try {
    sqlite.exec('PRAGMA defer_foreign_keys = ON');
    const current = readRevision(sqlite);
    const fail = (message: string, extra: Record<string, unknown> = {}): UndoResult => {
      sqlite.exec('ROLLBACK');
      return { ok: false, revision: current, errors: [{ op: null, code: 'undo_refused', message, ...extra }] };
    };
    if (options.dbId !== readDbId(sqlite)) {
      return fail(`Change ${seq} belongs to another database generation (you named ${String(options.dbId)}, this is ${readDbId(sqlite)}): a backup was restored, and change numbers start again there. Read the history again and undo by its seq.`);
    }
    const change = sqlite.prepare('SELECT seq, revision, by, summary, rows, undone_by FROM changes WHERE seq = ?').get(seq) as { seq: number; revision: number; by: string; summary: string; rows: string | null; undone_by: number | null } | undefined;
    if (!change) return fail(`There is no change ${seq} (it may be older than the history that is kept). \`select seq, revision, by, summary from changes order by seq desc limit 10\` lists the recent ones.`);
    if (change.rows === null) return fail(`Change ${seq} (r${change.revision}: ${change.summary}) is a summary from the old history and has no rows to restore, so it cannot be undone.`);
    if (change.undone_by !== null) return fail(`Change ${seq} was already undone by change ${change.undone_by}.`);
    const rows = JSON.parse(change.rows) as ChangedRow[];

    const stale: string[] = [];
    for (const row of rows) {
      const now = selectRow(sqlite, row.table, row.id);
      if (!sameIdentity(row.table, now, row.after)) stale.push(`  ${describeRow(row.table, row.id, now)}`);
    }
    if (stale.length) {
      return fail(`Change ${seq} (r${change.revision} by ${change.by}: ${change.summary}) cannot be undone: ${stale.length} row${stale.length === 1 ? ' has' : 's have'} changed since.\n${stale.slice(0, 8).join('\n')}${stale.length > 8 ? `\n  ... and ${stale.length - 8} more` : ''}\nUndo the later changes first, or make the change you want by hand.`, { stale: stale.length });
    }

    const newer = newerDependents(sqlite, rows);
    if (newer.length) {
      return fail(`Change ${seq} (r${change.revision} by ${change.by}: ${change.summary}) cannot be undone: it would delete something that newer rows point at, and undoing it would cut them loose without a trace.\n${newer.slice(0, 8).map((n) => `  ${n}`).join('\n')}${newer.length > 8 ? `\n  ... and ${newer.length - 8} more` : ''}\nMove or remove those first, or undo the later changes first.`, { newer: newer.length });
    }

    const rec = new Recorder(sqlite);
    // every block is captured first: the undo's own record includes the section and checkpoint columns it re-derives
    for (const b of sqlite.prepare('SELECT id FROM blocks').all() as Array<{ id: string }>) rec.capture('blocks', b.id);
    for (const row of rows) rec.capture(row.table, row.id);
    // inverse, last row first: rows that were added go, rows that were removed come back, the rest return to "before"
    for (const row of [...rows].reverse()) applyInverse(sqlite, row, by, at);
    const doc = loadDoc(sqlite);
    recomputeDerived(doc.blocks);
    const setDerived = sqlite.prepare('UPDATE blocks SET section_id = ?, checkpoint_id = ? WHERE id = ?');
    for (const b of doc.blocks) setDerived.run(b.section_id, b.checkpoint_id, b.id);
    const dangling = missingReferences(sqlite, rows);
    if (dangling.length) {
      return fail(`Change ${seq} cannot be undone: it would bring back rows that point at something that is gone.\n${dangling.slice(0, 8).map((d) => `  ${d}`).join('\n')}\nUndo the later removals first, in reverse order.`, { dangling: dangling.length });
    }
    const problems = structureProblems(doc.blocks);
    if (problems.length) {
      return fail(`Change ${seq} cannot be undone: the plan would not read back as meant afterwards (${problems.join('; ')}). Nothing was changed.`);
    }
    const undoRows = rec.finish();
    const next = current + 1;
    setMeta(sqlite, 'revision', next);
    const summary = `undo of r${change.revision} (${change.summary})`.slice(0, 300);
    const inserted = sqlite.prepare("INSERT INTO changes(revision, kind, at, by, summary, rows, undoes) VALUES (?, 'undo', ?, ?, ?, ?, ?)").run(next, at, by, summary, JSON.stringify(undoRows), seq);
    const newSeq = Number(inserted.lastInsertRowid);
    sqlite.prepare('UPDATE changes SET undone_by = ? WHERE seq = ?').run(newSeq, seq);
    pruneHistory(db);
    await commitTransaction(db);
    afterCommit(db);
    return { ok: true, revision: next, seq: newSeq, undid: seq, summary };
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
    if (isBusyError(error)) throw new WorkspaceDbError('busy', 'The workspace database is busy: another process is writing. Nothing was changed; try again in a moment.', { cause: error });
    if (error instanceof Error && /constraint/i.test(error.message)) {
      return { ok: false, revision: readRevision(sqlite), errors: [{ op: null, code: 'undo_refused', message: `Change ${seq} cannot be undone because what it restored points at something that is gone (${error.message}). Undo the later changes first.` }] };
    }
    throw error;
  }
}

function applyInverse(sqlite: WorkspaceDb['sqlite'], row: ChangedRow, by: string, at: string): void {
  const def = tableDef(row.table);
  const key = def.key!;
  if (row.before === null) {
    sqlite.prepare(`DELETE FROM ${row.table} WHERE ${key} = ?`).run(row.id);
    return;
  }
  const values: Row = { ...row.before };
  if ('rev' in values) {
    // never take a rev back: a holder of an old one must still be refused
    const bumped = Math.max(Number(values.rev), Number(row.after?.rev ?? 0), deletedRowRevision(sqlite, row.id)) + 1;
    values.rev = bumped;
    if ('updated_at' in values) { values.updated_at = at; values.updated_by = by; }
  }
  const columns = snapshotColumns(row.table);
  const existing = sqlite.prepare(`SELECT 1 FROM ${row.table} WHERE ${key} = ?`).get(row.id);
  if (existing) {
    const sets = columns.filter((c) => c !== key);
    sqlite.prepare(`UPDATE ${row.table} SET ${sets.map((c) => `${c} = ?`).join(', ')} WHERE ${key} = ?`).run(...sets.map((c) => values[c] as string | number | null), row.id);
  } else {
    sqlite.prepare(`INSERT INTO ${row.table}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((c) => values[c] as string | number | null));
  }
}
