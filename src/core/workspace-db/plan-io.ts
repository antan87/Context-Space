/**
 * @module core/workspace-db/plan-io
 * The plan as markdown text, both ways.
 *
 * `exportPlanMarkdown` returns the header line and then the blocks verbatim, with `<!-- id -->` at the end of each item
 * and heading line. It only returns text; publishing it to `PLAN.md` is a later slice.
 *
 * `importPlanText` fills an EMPTY database from plan text (what the migration and the tests start from). It is not a
 * hand-edit import: that merges three ways and lives with publication.
 */

import { createHash } from 'node:crypto';

import { beginImmediate, commitTransaction, getMeta, readDbId, readRevision, setMeta, withSnapshot, type WorkspaceDb } from './connection.js';
import { WorkspaceDbError } from './errors.js';
import { newId, ID_PATTERN, type IdKind } from './ids.js';
import { bodyOf, headerLine, parsePlanText, renderBody } from './plan-text.js';
import { Recorder, flushDoc, loadDoc, ORD_GAP, type Doc, type DocBlock } from './store.js';
import { afterCommit } from './batch.js';

const digestOf = (body: string): string => createHash('sha256').update(body).digest('hex').slice(0, 16);

export interface PlanExport {
  text: string;
  body: string;
  digest: string;
  revision: number;
  dbId: string;
}

/** The export in full: the plan file text, with its header line. */
export function exportPlan(db: WorkspaceDb): PlanExport {
  // blocks, line ending and revision come from one snapshot, so the header never names a revision the text is not
  return withSnapshot(db, (v) => {
    const doc = loadDoc(v.sqlite);
    const body = renderBody(doc.blocks, doc.trailingNewline, true, doc.eol);
    const revision = readRevision(v.sqlite);
    const dbId = readDbId(v.sqlite);
    const digest = digestOf(body);
    return { text: `${headerLine(dbId, revision, digest)}${doc.eol}${body}`, body, digest, revision, dbId };
  });
}

/** The header line, then the blocks verbatim with `<!-- id -->` on item and heading lines. */
export function exportPlanMarkdown(db: WorkspaceDb): string {
  return exportPlan(db).text;
}

/** The hash an export's header carries for its body (the text without the header line). */
export const exportDigest = (text: string): string => digestOf(bodyOf(text));

export interface ImportResult {
  revision: number;
  blocks: number;
  items: number;
}

/**
 * Loads plan text into an empty database as revision 1. Ids found in trailing id comments are kept (a duplicated id is
 * refused); every other block gets a fresh one. Throws when the database already holds a plan.
 */
export function importPlanText(db: WorkspaceDb, source: string, options: { by: string }): Promise<ImportResult> {
  return db.serialize(() => importLocked(db, source, options));
}

async function importLocked(db: WorkspaceDb, source: string, options: { by: string }): Promise<ImportResult> {
  const parsed = parsePlanText(source);
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const b of parsed.blocks) {
    if (!b.id) continue;
    if (seen.has(b.id)) duplicated.add(b.id);
    seen.add(b.id);
  }
  if (duplicated.size) throw new WorkspaceDbError('invalid', `The plan text uses the same id more than once: ${[...duplicated].join(', ')}. Every id names one line.`);

  await beginImmediate(db);
  try {
    sqliteDeferForeignKeys(db);
    // pristine: nothing was ever written (no revision, no history, no id ever issued, no block, no card)
    const count = (sql: string) => (db.sqlite.prepare(sql).get() as { n: number }).n;
    if (readRevision(db.sqlite) !== 0 || count('SELECT count(*) AS n FROM blocks') > 0 || count('SELECT count(*) AS n FROM cards') > 0
      || count('SELECT count(*) AS n FROM changes') > 0 || count('SELECT count(*) AS n FROM ids_used') > 0) {
      throw new WorkspaceDbError('invalid', 'The database is not pristine (a plan was loaded or changed here before); importPlanText only starts a new one. Use `plan import` to bring in an edit.');
    }
    for (const b of parsed.blocks) {
      if (b.id && db.sqlite.prepare('SELECT 1 FROM ids_used WHERE id = ? UNION SELECT 1 FROM blocks WHERE id = ? UNION SELECT 1 FROM cards WHERE id = ? OR legacy_id = ?').get(b.id, b.id, b.id, b.id)) {
        throw new WorkspaceDbError('invalid', `The id ${b.id} was already issued in this database, so it cannot name different text now.`);
      }
    }
    const at = new Date().toISOString();
    const by = options.by;
    const taken = new Set<string>();
    for (const b of parsed.blocks) if (b.id) { if (!ID_PATTERN.test(b.id)) throw new WorkspaceDbError('invalid', `"${b.id}" is not an id.`); taken.add(b.id); }
    const blocks: DocBlock[] = parsed.blocks.map((p, index) => ({
      id: p.id ?? newId(db.sqlite, p.kind as IdKind, taken),
      kind: p.kind,
      parent_id: null,
      ord: (index + 1) * ORD_GAP,
      text: p.text,
      name: p.name,
      detail: p.detail,
      done: p.done,
      section_id: null, checkpoint_id: null,
      rev: 1, created_at: at, created_by: by, updated_at: at, updated_by: by,
      _before: null, _rev0: 0, _new: true, _dirty: false, _moved: false,
    }));
    parsed.blocks.forEach((p, index) => { if (p.parentIdx >= 0) blocks[index]!.parent_id = blocks[p.parentIdx]!.id; });
    const doc: Doc = { blocks, removed: [], trailingNewline: parsed.trailingNewline, eol: parsed.eol };
    const rec = new Recorder(db.sqlite);
    flushDoc(db.sqlite, doc, rec, by, at);
    setMeta(db.sqlite, 'trailing_newline', parsed.trailingNewline ? '1' : '0');
    setMeta(db.sqlite, 'eol', parsed.eol === '\r\n' ? 'crlf' : 'lf');
    const next = readRevision(db.sqlite) + 1;
    setMeta(db.sqlite, 'revision', next);
    const items = blocks.filter((b) => b.kind !== 'heading' && b.kind !== 'prose').length;
    // The rows are not kept: an import is the starting point, and undoing it would empty the plan.
    db.sqlite.prepare("INSERT INTO changes(revision, kind, at, by, summary, rows) VALUES (?, 'import', ?, ?, ?, NULL)").run(next, at, by, `imported the plan: ${blocks.length} blocks, ${items} items`);
    await commitTransaction(db);
    afterCommit(db);
    return { revision: next, blocks: blocks.length, items };
  } catch (error) {
    try { db.sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
    throw error;
  }
}

function sqliteDeferForeignKeys(db: WorkspaceDb): void {
  db.sqlite.exec('PRAGMA defer_foreign_keys = ON');
}

export const planTrailingNewline = (db: WorkspaceDb): boolean => getMeta(db.sqlite, 'trailing_newline') !== '0';
