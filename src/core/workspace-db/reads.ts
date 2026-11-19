/**
 * @module core/workspace-db/reads
 * Typed reads: the plan as ordered blocks, an item with its children, cards, links, positions, Now, history, and the
 * workspace `revision` and `db_id`. They take any connection, read-only included, and never write.
 */

import { readDbId, readRevision, withSnapshot, type WorkspaceDb } from './connection.js';
import type { BlockKind } from './plan-text.js';

export interface PlanBlock {
  id: string;
  kind: BlockKind;
  parentId: string | null;
  ord: number;
  text: string;
  name: string | null;
  detail: string;
  done: boolean;
  sectionId: string | null;
  checkpointId: string | null;
  rev: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

type Raw = Record<string, unknown>;

const toBlock = (r: Raw): PlanBlock => ({
  id: r.id as string, kind: r.kind as BlockKind, parentId: (r.parent_id as string | null) ?? null, ord: Number(r.ord),
  text: r.text as string, name: (r.name as string | null) ?? null, detail: r.detail as string, done: Number(r.done) === 1,
  sectionId: (r.section_id as string | null) ?? null, checkpointId: (r.checkpoint_id as string | null) ?? null, rev: Number(r.rev),
  createdAt: r.created_at as string, createdBy: r.created_by as string, updatedAt: r.updated_at as string, updatedBy: r.updated_by as string,
});

/** The connection a read uses: the read view's own, otherwise the separate read-only one, never the writer's (which may hold uncommitted rows). */
const conn = (db: WorkspaceDb) => (db.snapshot ? db.sqlite : db.readerConnection());

export interface Position { revision: number; dbId: string }

/** The committed revision and the database identity: the poll token is `dbId:revision`. */
export function getRevision(db: WorkspaceDb): Position {
  return withSnapshot(db, (v) => ({ revision: readRevision(v.sqlite), dbId: readDbId(v.sqlite) }));
}

/** The plan as ordered blocks: headings, prose and items, in document order. */
export function listBlocks(db: WorkspaceDb): PlanBlock[] {
  return (conn(db).prepare('SELECT * FROM blocks ORDER BY ord, id').all() as Raw[]).map(toBlock);
}

export function getBlock(db: WorkspaceDb, id: string): PlanBlock | null {
  const row = conn(db).prepare('SELECT * FROM blocks WHERE id = ?').get(id) as Raw | undefined;
  return row ? toBlock(row) : null;
}

export interface ItemView {
  item: PlanBlock;
  /** Direct children, in order. */
  children: PlanBlock[];
  decision: { suggested: string[]; ifNoAnswer: string | null; answer: string | null; answeredBy: string | null; answeredAt: string | null } | null;
  check: { kind: 'none' | 'workspace' | 'command'; command: string | null; outcome: string | null } | null;
  cardIds: string[];
}

/** An item (checkpoint, step or decision) with its children, its decision or check, and the cards that name it. */
export function getItem(db: WorkspaceDb, id: string): ItemView | null {
  return withSnapshot(db, (v) => readItem(v, id));
}

function readItem(db: WorkspaceDb, id: string): ItemView | null {
  const item = getBlock(db, id);
  if (!item || (item.kind !== 'checkpoint' && item.kind !== 'step' && item.kind !== 'decision')) return null;
  const children = (conn(db).prepare('SELECT * FROM blocks WHERE parent_id = ? ORDER BY ord, id').all(id) as Raw[]).map(toBlock);
  const d = conn(db).prepare('SELECT d.suggested, d.if_no_answer, d.answer, m.answered_by, m.answered_at FROM decisions d LEFT JOIN decision_meta m ON m.item_id = d.item_id WHERE d.item_id = ?').get(id) as Raw | undefined;
  const c = conn(db).prepare('SELECT kind, command, outcome FROM checks WHERE item_id = ?').get(id) as Raw | undefined;
  const cardIds = (conn(db).prepare('SELECT id FROM cards WHERE step_id = ? OR area = ? ORDER BY at, id').all(id, `checkpoint:${id}`) as Array<{ id: string }>).map((r) => r.id);
  return {
    item, children,
    decision: d ? { suggested: JSON.parse(d.suggested as string) as string[], ifNoAnswer: (d.if_no_answer as string | null) ?? null, answer: (d.answer as string | null) ?? null, answeredBy: (d.answered_by as string | null) ?? null, answeredAt: (d.answered_at as string | null) ?? null } : null,
    check: c ? { kind: c.kind as 'none' | 'workspace' | 'command', command: (c.command as string | null) ?? null, outcome: (c.outcome as string | null) ?? null } : null,
    cardIds,
  };
}

export interface Card {
  id: string; legacyId: string | null; kind: 'note' | 'file'; title: string; body: string | null; path: string | null; description: string | null;
  area: string | null; stepId: string | null; about: string | null; look: string | null; lookAt: string | null; pinned: boolean; archived: boolean;
  by: string; at: string; updatedBy: string; updatedAt: string; rev: number;
}

const toCard = (r: Raw): Card => ({
  id: r.id as string, legacyId: (r.legacy_id as string | null) ?? null, kind: r.kind as 'note' | 'file', title: r.title as string,
  body: (r.body as string | null) ?? null, path: (r.path as string | null) ?? null, description: (r.description as string | null) ?? null,
  area: (r.area as string | null) ?? null, stepId: (r.step_id as string | null) ?? null, about: (r.about as string | null) ?? null,
  look: (r.look as string | null) ?? null, lookAt: (r.look_at as string | null) ?? null, pinned: Number(r.pinned) === 1, archived: Number(r.archived) === 1,
  by: r.by as string, at: r.at as string, updatedBy: r.updated_by as string, updatedAt: r.updated_at as string, rev: Number(r.rev),
});

export function listCards(db: WorkspaceDb, options: { includeArchived?: boolean } = {}): Card[] {
  const where = options.includeArchived ? '' : 'WHERE archived = 0';
  return (conn(db).prepare(`SELECT * FROM cards ${where} ORDER BY at, id`).all() as Raw[]).map(toCard);
}

export function getCard(db: WorkspaceDb, id: string): Card | null {
  const row = (conn(db).prepare('SELECT * FROM cards WHERE id = ?').get(id) ?? conn(db).prepare('SELECT * FROM cards WHERE legacy_id = ?').get(id)) as Raw | undefined;
  return row ? toCard(row) : null;
}

export interface Link { id: string; from: string; to: string; label: string | null; by: string; at: string }

export function listLinks(db: WorkspaceDb): Link[] {
  return (conn(db).prepare('SELECT * FROM links ORDER BY at, id').all() as Raw[]).map((r) => ({
    id: r.id as string, from: r.from_node as string, to: r.to_node as string, label: (r.label as string | null) ?? null, by: r.by as string, at: r.at as string,
  }));
}

export function listPositions(db: WorkspaceDb): Array<{ nodeId: string; x: number; y: number }> {
  return (conn(db).prepare('SELECT * FROM positions ORDER BY node_id').all() as Raw[]).map((r) => ({ nodeId: r.node_id as string, x: Number(r.x), y: Number(r.y) }));
}

/** The item someone said they work on, or null. */
export function getNow(db: WorkspaceDb): { itemId: string; by: string; at: string } | null {
  const r = conn(db).prepare('SELECT item_id, by, at FROM now WHERE id = 1').get() as Raw | undefined;
  return r ? { itemId: r.item_id as string, by: r.by as string, at: r.at as string } : null;
}

export interface ChangeEntry { seq: number; revision: number; kind: string; requestId: string | null; at: string; by: string; summary: string; undoes: number | null; undoneBy: number | null }

/** Recent changes, newest first (summaries only; `select rows from changes` has the rows). */
export function listChanges(db: WorkspaceDb, options: { limit?: number; sinceRevision?: number } = {}): ChangeEntry[] {
  return (conn(db).prepare('SELECT seq, revision, kind, request_id, at, by, summary, undoes, undone_by FROM changes WHERE revision > ? ORDER BY seq DESC LIMIT ?').all(options.sinceRevision ?? 0, options.limit ?? 50) as Raw[]).map((r) => ({
    seq: Number(r.seq), revision: Number(r.revision), kind: r.kind as string, requestId: (r.request_id as string | null) ?? null, at: r.at as string, by: r.by as string,
    summary: r.summary as string, undoes: r.undoes === null ? null : Number(r.undoes), undoneBy: r.undone_by === null ? null : Number(r.undone_by),
  }));
}
