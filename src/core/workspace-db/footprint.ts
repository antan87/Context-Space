/**
 * @module core/workspace-db/footprint
 * What a batch touches, and what earlier changes touched. A batch that was written against revision N may still be
 * applied at revision M > N only when no change in N..M touched anything in its footprint (v5 point 1).
 *
 * The footprint of a batch is, over canonical ids (aliases and prefixes resolved first):
 * - each target row;
 * - its parent before and after (a `move` or `add`);
 * - each anchor (`after`, `before`);
 * - every block in the range a `move` or `remove` operates on: the item, everything nested under it, and the prose
 *   between its children (the very range the op takes);
 * - every dependent row: cards whose `step_id` or `area` names an item of that range, and links and positions on its
 *   node. Dependents are compared as they are now AND as they were in the changes since the base (`refs`): a card that was
 *   detached or a link that was deleted since still counts;
 * - the root order, when the batch adds, moves or removes something at the top level.
 *
 * Destinations are compared too (`destinationConflicts`): where an implicit placement lands (the default "add a
 * checkpoint" target) and which card a prefix names, at the base and now. If they differ, the batch is stale.
 *
 * A row is a key `table:id`; the root order is the key `root`. Rows added by the same batch (`$ref`) are new and need
 * no key. `place`, `link` and `unlink` have no footprint on a stable node: last write wins, deliberately.
 */

import type { DatabaseSync } from 'node:sqlite';

import { sameIdentity } from './definitions.js';
import { descendantsOf, findCard, rangeEnd, type Op } from './ops.js';
import { isItemKind } from './plan-text.js';
import type { ChangedRow, Doc, DocBlock, Row } from './store.js';

export const ROOT_KEY = 'root';

export interface Footprint {
  keys: Set<string>;
  /** Item ids of the removed or moved ranges, and their `checkpoint:<id>` nodes: what a dependent row may name. */
  refs: Set<string>;
}

/** The keys a recorded change touched. A top-level block that was added, removed or moved touches the root order. A row that only changed in a derived column is not touched. */
export function touchedKeys(rows: readonly ChangedRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.before !== null && row.after !== null && sameIdentity(row.table, row.before, row.after)) continue;
    keys.add(`${row.table}:${row.id}`);
    if (row.table !== 'blocks') continue;
    const before = row.before;
    const after = row.after;
    const topBefore = before !== null && before.parent_id === null;
    const topAfter = after !== null && after.parent_id === null;
    const moved = before !== null && after !== null && (before.ord !== after.ord || before.parent_id !== after.parent_id);
    if ((before === null && topAfter) || (after === null && topBefore) || (moved && (topBefore || topAfter))) keys.add(ROOT_KEY);
  }
  return keys;
}

const stripCopy = (node: string) => node.replace(/#\d{1,3}$/, '');

/** Whether a recorded row (before or after) names one of the ids: a card by step or area, a link or position by node, Now by item. */
export function rowRefers(row: ChangedRow, refs: ReadonlySet<string>): boolean {
  if (refs.size === 0) return false;
  for (const state of [row.before, row.after]) {
    if (!state) continue;
    if (row.table === 'cards') {
      if (typeof state.step_id === 'string' && refs.has(state.step_id)) return true;
      if (typeof state.area === 'string' && refs.has(state.area)) return true;
    } else if (row.table === 'links') {
      if (refs.has(stripCopy(String(state.from_node))) || refs.has(stripCopy(String(state.to_node)))) return true;
    } else if (row.table === 'positions') {
      if (refs.has(stripCopy(String(state.node_id)))) return true;
    } else if (row.table === 'now') {
      if (refs.has(String(state.item_id))) return true;
    }
  }
  return false;
}

function dependents(db: DatabaseSync, ids: readonly string[], keys: Set<string>): void {
  for (const id of ids) {
    const node = `checkpoint:${id}`;
    for (const c of db.prepare('SELECT id FROM cards WHERE step_id = ? OR area = ?').all(id, node) as Array<{ id: string }>) keys.add(`cards:${c.id}`);
    for (const l of db.prepare('SELECT id FROM links WHERE from_node = ? OR to_node = ? OR from_node LIKE ? OR to_node LIKE ?').all(node, node, `${node}#%`, `${node}#%`) as Array<{ id: string }>) keys.add(`links:${l.id}`);
    for (const p of db.prepare('SELECT node_id FROM positions WHERE node_id = ? OR node_id LIKE ?').all(node, `${node}#%`) as Array<{ node_id: string }>) keys.add(`positions:${p.node_id}`);
    if (db.prepare('SELECT 1 FROM now WHERE item_id = ?').get(id)) keys.add('now:1');
  }
}

/** The footprint of `ops`, read against the document as it is now. */
export function footprintOf(db: DatabaseSync, doc: Doc, ops: readonly Op[]): Footprint {
  const keys = new Set<string>();
  const refs = new Set<string>();
  const byId = new Map<string, DocBlock>(doc.blocks.map((b) => [b.id, b]));
  const ref = (value: unknown): string | null => (typeof value === 'string' && !value.includes('$') ? value : null);
  const addBlock = (id: string | null) => { if (id && byId.has(id)) keys.add(`blocks:${id}`); };
  const parentOrRoot = (b: DocBlock | undefined) => {
    if (!b || b.parent_id === null) keys.add(ROOT_KEY); else addBlock(b.parent_id);
  };
  const where = (op: Op) => {
    const under = ref(op.under);
    const after = ref(op.after);
    const before = ref(op.before);
    const inside = ref(op.in);
    if (under) { addBlock(under); return; }
    const anchor = after ?? before;
    if (anchor) { addBlock(anchor); parentOrRoot(byId.get(anchor)); return; }
    if (inside) { addBlock(inside); keys.add(ROOT_KEY); return; }
    // a checkpoint added without a place goes after the last checkpoint, or under the Checkpoints heading
    const anchorId = implicitCheckpointAnchor(doc.blocks);
    if (anchorId) addBlock(anchorId);
    keys.add(ROOT_KEY);
  };
  /** The range a move or remove operates on: the item, its descendants and the prose between them. */
  const rangeOf = (b: DocBlock): DocBlock[] => doc.blocks.slice(doc.blocks.indexOf(b), rangeEnd(doc.blocks, doc.blocks.indexOf(b)) + 1);
  const subtree = (b: DocBlock) => {
    const range = rangeOf(b);
    for (const x of range) addBlock(x.id);
    const items = [b, ...descendantsOf(doc.blocks, b)].filter((x) => isItemKind(x.kind));
    for (const x of items) { refs.add(x.id); refs.add(`checkpoint:${x.id}`); }
    dependents(db, items.map((x) => x.id), keys);
  };

  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') continue;
    const id = ref(op.id);
    const target = id ? byId.get(id) : undefined;
    switch (op.op) {
      case 'add':
        where(op);
        break;
      case 'move':
        if (target) { subtree(target); parentOrRoot(target); }
        where(op);
        break;
      case 'remove':
        if (target) { subtree(target); parentOrRoot(target); }
        break;
      case 'reword': case 'edit': case 'detail': case 'block.set': case 'section.set': case 'tick': case 'untick': case 'answer':
        if (target) keys.add(`blocks:${target.id}`);
        break;
      case 'card.update': case 'card.remove': {
        const card = id ? findCard(db, id) : null;
        if (card && 'row' in card) {
          const cardId = card.row.id as string;
          keys.add(`cards:${cardId}`);
          if (op.op === 'card.remove') {
            refs.add(cardId);
            for (const l of db.prepare('SELECT id FROM links WHERE from_node = ? OR to_node = ?').all(cardId, cardId) as Array<{ id: string }>) keys.add(`links:${l.id}`);
            keys.add(`positions:${cardId}`);
          }
        }
        break;
      }
      case 'now':
        // Now is one row: last write wins, but a batch that names a step still sees a change to it
        if (target) keys.add(`blocks:${target.id}`);
        break;
      default:
        break;
    }
  }
  return { keys, refs };
}

/** Where a checkpoint added with no place goes: the last checkpoint, else the first Checkpoints heading. */
export function implicitCheckpointAnchor(blocks: ReadonlyArray<{ id: string; kind: string; text: string }>): string | null {
  const last = [...blocks].reverse().find((b) => b.kind === 'checkpoint');
  if (last) return last.id;
  return blocks.find((b) => b.kind === 'heading' && /^#{1,6}\s+(?:checkpoints|milestones)\b/i.test(b.text))?.id ?? null;
}

// ─── The state at the base ──────────────────────────────────────────────────

export interface BaseState {
  blocks: Array<{ id: string; kind: string; text: string; ord: number }>;
  cards: Row[];
}

/** The blocks and cards as they were before `changes` (newest first): their recorded `before` rows put back over the present. */
export function reconstructBase(db: DatabaseSync, changesNewestFirst: ReadonlyArray<readonly ChangedRow[]>): BaseState {
  const blocks = new Map<string, Row>((db.prepare('SELECT id, kind, text, ord FROM blocks').all() as Row[]).map((r) => [r.id as string, { ...r }]));
  const cards = new Map<string, Row>((db.prepare('SELECT * FROM cards').all() as Row[]).map((r) => [r.id as string, { ...r }]));
  for (const rows of changesNewestFirst) {
    for (const row of [...rows].reverse()) {
      const map = row.table === 'blocks' ? blocks : row.table === 'cards' ? cards : null;
      if (!map) continue;
      if (row.before === null) map.delete(String(row.id));
      else map.set(String(row.id), { ...(map.get(String(row.id)) ?? {}), ...row.before });
    }
  }
  return {
    blocks: [...blocks.values()].sort((a, b) => Number(a.ord) - Number(b.ord)) as BaseState['blocks'],
    cards: [...cards.values()],
  };
}

/** A card named by id, old uuid or a unique prefix (6+ characters) of the old uuid, in a given set of cards: its id, 'none' or 'ambiguous'. */
function resolveIn(cards: readonly Row[], value: string): string {
  const exact = cards.find((c) => c.id === value) ?? cards.find((c) => c.legacy_id === value);
  if (exact) return exact.id as string;
  if (value.length >= 6 && /^[0-9a-f-]+$/i.test(value)) {
    const found = cards.filter((c) => typeof c.legacy_id === 'string' && (c.legacy_id as string).startsWith(value));
    if (found.length === 1) return found[0]!.id as string;
    if (found.length > 1) return 'ambiguous';
  }
  return 'none';
}

/**
 * Where the batch lands at the base against where it lands now: an implicit checkpoint placement, and the card that
 * each non-canonical card reference (old uuid, prefix) names. Returns one sentence per difference.
 */
export function destinationConflicts(db: DatabaseSync, doc: Doc, ops: readonly Op[], base: BaseState): string[] {
  const out: string[] = [];
  const now = { cards: db.prepare('SELECT * FROM cards').all() as Row[] };
  const nameOf = (id: string | null) => (id ? (doc.blocks.find((b) => b.id === id)?.name ?? id) : 'nothing');
  for (const [i, op] of ops.entries()) {
    if (!op || typeof op.op !== 'string') continue;
    if (op.op === 'add' && op.kind === 'checkpoint' && op.under === undefined && op.after === undefined && op.before === undefined && op.in === undefined) {
      const was = implicitCheckpointAnchor(base.blocks);
      const is = implicitCheckpointAnchor(doc.blocks);
      if (was !== is) out.push(`op ${i} (add checkpoint): with no place it went after ${was ?? 'nothing'} at your revision, and now it would go after ${is ?? 'nothing'} ("${nameOf(is)}"). Say where it goes ("after": "<id>").`);
    }
    for (const key of ['id', 'from', 'to', 'node'] as const) {
      const value = op[key];
      if (typeof value !== 'string' || value.includes('$') || !op.op.startsWith('card.') && !['link', 'unlink', 'place'].includes(op.op)) continue;
      if (value.startsWith('checkpoint:') || value.startsWith('commit:') || value.startsWith('document:')) continue;
      const then = resolveIn(base.cards, value);
      const nowId = resolveIn(now.cards, value);
      if (then !== nowId) out.push(`op ${i} (${op.op}): "${value}" named ${then === 'none' ? 'no card' : then === 'ambiguous' ? 'several cards' : `card ${then}`} at your revision and names ${nowId === 'none' ? 'no card' : nowId === 'ambiguous' ? 'several cards' : `card ${nowId}`} now. Use the card's full id.`);
    }
  }
  return out;
}
