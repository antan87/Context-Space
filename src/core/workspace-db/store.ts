/**
 * @module core/workspace-db/store
 * The one write layer. A batch loads the plan blocks into memory, changes them, and `flushDoc` writes back exactly the
 * rows that differ. Every changed row, in every table the history covers, is recorded before and after in the same
 * transaction (the `Recorder`), so Undo and "what touched this" have the whole truth: order, parent, the derived
 * `decisions` / `checks` rows and anything a cascade changed.
 *
 * Order in the document is `ord`, with gaps. A block that is added or moved takes a place between its neighbours and
 * no other row changes, so an unrelated change never makes a row look as if it had moved.
 */

import type { DatabaseSync } from 'node:sqlite';

import { getMeta, setMeta } from './connection.js';
import { snapshotColumns, tableDef } from './definitions.js';
import { markUsed } from './ids.js';
import { isItemKind, parseDetail, type BlockKind, type ItemKind } from './plan-text.js';

/** How far apart a fresh document puts its blocks. */
export const ORD_GAP = 2 ** 32;

export interface DocBlock {
  id: string;
  kind: BlockKind;
  parent_id: string | null;
  ord: number;
  text: string;
  name: string | null;
  detail: string;
  done: boolean;
  section_id: string | null;
  checkpoint_id: string | null;
  rev: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  /** The row as it was read (null for a new block): history's "before". */
  _before: Record<string, unknown> | null;
  _rev0: number;
  _new: boolean;
  /** Changed in content or place: gets rev + 1. */
  _dirty: boolean;
  /** Moved: takes a new place in the order. */
  _moved: boolean;
  /** An answer was given by this batch's `answer` op (so who and when are this batch's). */
  _answered?: boolean;
  /** A tick turned it from open to ticked during this batch (even if an untick came first): it needs proof. */
  _ticked?: boolean;
}

export interface Doc {
  blocks: DocBlock[];
  removed: DocBlock[];
  trailingNewline: boolean;
  /** The plan's line ending, kept apart from the stored text. */
  eol: '\n' | '\r\n';
}

export type Row = Record<string, unknown>;

export interface ChangedRow {
  table: string;
  id: string | number;
  before: Row | null;
  after: Row | null;
}

const BLOCK_SNAPSHOT = snapshotColumns('blocks');

function blockSnapshot(b: DocBlock): Row {
  const out: Row = {};
  for (const column of BLOCK_SNAPSHOT) {
    const value = (b as unknown as Row)[column];
    out[column] = typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null;
  }
  return out;
}

const sameRow = (a: Row | null, b: Row | null): boolean => JSON.stringify(a) === JSON.stringify(b);

const deletedRevKey = (id: string | number) => `deleted_row_rev_${id}`;

/** A known ID may return through Undo or a draft after its history rows have expired. */
export function deletedRowRevision(db: DatabaseSync, id: string | number): number {
  return Number(getMeta(db, deletedRevKey(id)) ?? 0);
}

export function selectRow(db: DatabaseSync, table: string, id: string | number): Row | null {
  const def = tableDef(table);
  const columns = snapshotColumns(table).join(', ');
  const row = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${def.key} = ?`).get(id) as Row | undefined;
  return row ? { ...row } : null;
}

/** Remembers what each row looked like before it was touched, and reads what it looks like at the end. */
export class Recorder {
  private readonly before = new Map<string, { table: string; id: string | number; before: Row | null }>();

  constructor(private readonly db: DatabaseSync) {}

  /** Records the row as it is now (call before changing it). Only the first call per row counts. */
  capture(table: string, id: string | number): void {
    const key = `${table}:${id}`;
    if (!this.before.has(key)) this.before.set(key, { table, id, before: selectRow(this.db, table, id) });
  }

  captureWith(table: string, id: string | number, before: Row | null): void {
    const key = `${table}:${id}`;
    if (!this.before.has(key)) this.before.set(key, { table, id, before });
  }

  /** The rows that really changed, with their final state. */
  finish(): ChangedRow[] {
    const rows: ChangedRow[] = [];
    for (const entry of this.before.values()) {
      const after = selectRow(this.db, entry.table, entry.id);
      if (sameRow(entry.before, after)) continue;
      if (!after && typeof entry.before?.rev === 'number' && (entry.table === 'blocks' || entry.table === 'cards')) {
        setMeta(this.db, deletedRevKey(entry.id), String(Math.max(entry.before.rev, deletedRowRevision(this.db, entry.id))));
      }
      rows.push({ table: entry.table, id: entry.id, before: entry.before, after });
    }
    return rows;
  }
}

// ─── Loading and writing the document ───────────────────────────────────────

export function loadDoc(db: DatabaseSync, trailingNewline?: boolean): Doc {
  const rows = db.prepare('SELECT * FROM blocks ORDER BY ord, id').all() as Row[];
  const blocks = rows.map((r) => {
    const b = {
      id: r.id as string,
      kind: r.kind as BlockKind,
      parent_id: (r.parent_id as string | null) ?? null,
      ord: Number(r.ord),
      text: r.text as string,
      name: (r.name as string | null) ?? null,
      detail: r.detail as string,
      done: r.done === 1 || r.done === 1n,
      section_id: (r.section_id as string | null) ?? null,
      checkpoint_id: (r.checkpoint_id as string | null) ?? null,
      rev: Number(r.rev),
      created_at: r.created_at as string,
      created_by: r.created_by as string,
      updated_at: r.updated_at as string,
      updated_by: r.updated_by as string,
      _before: null as Row | null,
      _rev0: Number(r.rev),
      _new: false,
      _dirty: false,
      _moved: false,
    } satisfies DocBlock;
    b._before = blockSnapshot(b);
    return b as DocBlock;
  });
  const flag = trailingNewline ?? (db.prepare("SELECT value FROM meta WHERE key = 'trailing_newline'").get() as { value: string } | undefined)?.value !== '0';
  const eol = (db.prepare("SELECT value FROM meta WHERE key = 'eol'").get() as { value: string } | undefined)?.value === 'crlf' ? '\r\n' : '\n';
  return { blocks, removed: [], trailingNewline: flag, eol };
}

/** Sets section_id and checkpoint_id from the tree. Returns true when any block's derived columns changed. */
export function recomputeDerived(blocks: DocBlock[]): void {
  let section: string | null = null;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const b of blocks) {
    if (b.kind === 'heading') { section = b.id; b.section_id = null; b.checkpoint_id = null; continue; }
    b.section_id = section;
    let checkpoint: string | null = null;
    if (b.kind !== 'prose') {
      let up: DocBlock | undefined = b;
      for (let guard = 0; up && guard < 200; guard += 1) {
        if (up.kind === 'checkpoint') { checkpoint = up.id; break; }
        up = up.parent_id ? byId.get(up.parent_id) : undefined;
      }
    }
    b.checkpoint_id = checkpoint;
  }
}

/** The smallest step between two neighbours that is left alone; a tighter gap is spread out locally. */
const MIN_STEP = 2 ** 16;

/**
 * Gives every new or moved block a place between its unmoved neighbours. When the gap is too tight, the nearest
 * neighbours are spread out too, as few as it takes: a local respread, never a renumbering of the whole document, so
 * an unrelated part of the plan is not touched by it.
 */
function placeMoved(blocks: DocBlock[]): void {
  const placed = new Set<DocBlock>();
  const isMarked = (b: DocBlock) => (b._new || b._moved) && !placed.has(b);
  let i = 0;
  while (i < blocks.length) {
    if (!isMarked(blocks[i]!)) { i += 1; continue; }
    let j = i;
    while (j < blocks.length && isMarked(blocks[j]!)) j += 1;
    let start = i;
    let end = j;
    for (;;) {
      const count = end - start;
      const low = start > 0 ? blocks[start - 1]!.ord : null;
      const high = end < blocks.length ? blocks[end]!.ord : null;
      let first: number;
      let step: number;
      if (low === null && high === null) { first = 0; step = ORD_GAP; }
      else if (high === null) { first = low!; step = ORD_GAP; }
      else if (low === null) { step = ORD_GAP; first = high - step * (count + 1); }
      else {
        const even = Math.floor((high - low) / (count + 1));
        // Lean toward the lower neighbour: appending, the commonest edit, then leaves the next block alone for longer.
        step = Math.max(MIN_STEP, Math.min(even, Math.floor((high - low) / 16)));
        first = low;
        if (even < MIN_STEP) {
          // too tight: take in the nearer neighbour on one side, then the other, and try again
          if (start > 0 && (end >= blocks.length || (i - start) <= (end - j))) start -= 1; else end += 1;
          continue;
        }
      }
      for (let k = 0; k < count; k += 1) { blocks[start + k]!.ord = first + step * (k + 1); placed.add(blocks[start + k]!); }
      break;
    }
    i = Math.max(j, end);
  }
}

const insertBlock = (db: DatabaseSync) => db.prepare(
  'INSERT INTO blocks(id, kind, parent_id, ord, text, name, detail, done, section_id, checkpoint_id, rev, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
const updateBlock = (db: DatabaseSync) => db.prepare(
  'UPDATE blocks SET kind = ?, parent_id = ?, ord = ?, text = ?, name = ?, detail = ?, done = ?, section_id = ?, checkpoint_id = ?, rev = ?, updated_at = ?, updated_by = ? WHERE id = ?',
);

/** Writes the document back. Records history through `rec`. */
export function flushDoc(db: DatabaseSync, doc: Doc, rec: Recorder, by: string, at: string): void {
  const { blocks } = doc;
  placeMoved(blocks);
  recomputeDerived(blocks);
  const ins = insertBlock(db);
  const upd = updateBlock(db);
  const derivedOnly = db.prepare('UPDATE blocks SET section_id = ?, checkpoint_id = ? WHERE id = ?');
  for (const b of blocks) {
    if (b._new) {
      rec.captureWith('blocks', b.id, null);
      b.rev = Math.max(1, deletedRowRevision(db, b.id) + 1);
      b.created_at = at; b.created_by = by; b.updated_at = at; b.updated_by = by;
      ins.run(b.id, b.kind, b.parent_id, b.ord, b.text, b.name, b.detail, b.done ? 1 : 0, b.section_id, b.checkpoint_id, b.rev, at, by, at, by);
      markUsed(db, b.id);
      continue;
    }
    if (b._dirty) { b.rev = b._rev0 + 1; b.updated_at = at; b.updated_by = by; }
    const snapshot = blockSnapshot(b);
    if (!sameRow(snapshot, b._before)) {
      rec.captureWith('blocks', b.id, b._before);
      upd.run(b.kind, b.parent_id, b.ord, b.text, b.name, b.detail, b.done ? 1 : 0, b.section_id, b.checkpoint_id, b.rev, b.updated_at, b.updated_by, b.id);
    } else {
      derivedOnly.run(b.section_id, b.checkpoint_id, b.id);
    }
  }
  for (const r of doc.removed) {
    rec.capture('decisions', r.id);
    rec.capture('decision_meta', r.id);
    rec.capture('checks', r.id);
    rec.capture('now', 1);
    rec.captureWith('blocks', r.id, r._before);
  }
  // Rows go children first so the foreign keys hold even without deferral.
  for (const r of [...doc.removed].reverse()) db.prepare('DELETE FROM blocks WHERE id = ?').run(r.id);
  for (const b of blocks) {
    if ((b._new || b._dirty) && isItemKind(b.kind)) syncDerived(db, rec, b, by, at);
  }
}

/** Rebuilds the `checks`, `decisions` and `decision_meta` rows of an item from its detail text. */
function syncDerived(db: DatabaseSync, rec: Recorder, b: DocBlock, by: string, at: string): void {
  const kind = b.kind as ItemKind;
  const fields = parseDetail(kind, b.detail);
  if (kind === 'checkpoint') {
    rec.capture('checks', b.id);
    const checkKind = !fields.hasCheck ? 'none' : fields.check === null ? 'workspace' : 'command';
    db.prepare('INSERT INTO checks(item_id, kind, command, outcome) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET kind = excluded.kind, command = excluded.command, outcome = excluded.outcome')
      .run(b.id, checkKind, fields.check, fields.outcome ?? null);
  } else if (kind === 'decision') {
    rec.capture('decisions', b.id);
    rec.capture('decision_meta', b.id);
    const prev = db.prepare('SELECT answer FROM decisions WHERE item_id = ?').get(b.id) as { answer: string | null } | undefined;
    db.prepare('INSERT INTO decisions(item_id, suggested, if_no_answer, answer) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET suggested = excluded.suggested, if_no_answer = excluded.if_no_answer, answer = excluded.answer')
      .run(b.id, JSON.stringify(fields.suggested), fields.ifNoAnswer ?? null, fields.answer ?? null);
    if (fields.answer === undefined) {
      db.prepare('DELETE FROM decision_meta WHERE item_id = ?').run(b.id);
    } else {
      const meta = db.prepare('SELECT answered_by FROM decision_meta WHERE item_id = ?').get(b.id) as { answered_by: string } | undefined;
      const unchanged = meta !== undefined && prev?.answer === fields.answer && !b._answered;
      if (!unchanged) {
        db.prepare('INSERT INTO decision_meta(item_id, answered_by, answered_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET answered_by = excluded.answered_by, answered_at = excluded.answered_at')
          .run(b.id, by, at);
      }
    }
  }
}

/** Recomputes section_id and checkpoint_id for the whole document (used after an undo). */
export function refreshDerived(db: DatabaseSync): void {
  const doc = loadDoc(db);
  recomputeDerived(doc.blocks);
  const stmt = db.prepare('UPDATE blocks SET section_id = ?, checkpoint_id = ? WHERE id = ?');
  for (const b of doc.blocks) stmt.run(b.section_id, b.checkpoint_id, b.id);
}
