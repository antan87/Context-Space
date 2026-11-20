/**
 * @module core/workspace-db/legacy-import
 * Brings today's Board data into a database that already holds the plan (`importPlanText`): cards, links and positions,
 * the old histories as summaries, Now, what each reader has seen, and the old check results as legacy runs.
 *
 * Everything that named a plan item by its key (`checkpoint:<key>` areas, step keys, link and position nodes, Now, the
 * old checks) is mapped to the item's id through `keys`. What cannot be mapped is returned in `unmapped`, never dropped
 * quietly: a card keeps its place with an empty step, and a link or position keeps the old node text.
 *
 * Cards get short ids; the old uuid stays in `legacy_id`. Old history is imported as summaries only (no Undo, v5), and
 * check results as `legacy` runs, which never satisfy the guard. The rows are not recorded for Undo: this is a starting
 * point, like the plan import.
 */

import { beginImmediate, commitTransaction, readDbId, readRevision, setMeta, type WorkspaceDb } from './connection.js';
import { contentHash } from './check-runs.js';
import { markUsed, newId } from './ids.js';
import { effectiveCheck } from './ops.js';
import { afterCommit } from './batch.js';

export interface LegacyCard {
  id: string;
  kind: 'note' | 'file';
  title: string;
  body?: string;
  path?: string;
  description?: string;
  area?: string;
  step?: string;
  about?: string;
  look?: string;
  lookAt?: string;
  pinned: boolean;
  archived: boolean;
  by: string;
  at: string;
  updatedBy: string;
  updatedAt: string;
}

export interface LegacyLink { id: string; from: string; to: string; label?: string; by: string; at: string }

export interface LegacyCheck { lastVerificationSha?: string; lastVerificationStatus?: string; canProgress?: boolean; at?: string }

export interface LegacyData {
  cards: LegacyCard[];
  links: LegacyLink[];
  positions: Record<string, { x: number; y: number }>;
  /** Old history entries, oldest first. */
  history: Array<{ at: string; by: string; summary: string }>;
  now: { key: string; by: string; at: string } | null;
  seen: {
    readers: Record<string, unknown>;
    pending: Record<string, unknown>;
    /** The plan file's own record of what it had seen (`plan-seen.json`). */
    plan: { hash?: string; items: Record<string, unknown> } | null;
  };
  /** The last check of each checkpoint, by its key. */
  checks: Record<string, LegacyCheck>;
}

export type UnmappedWhat = 'card.area' | 'card.step' | 'link.from' | 'link.to' | 'position' | 'now' | 'check';

export interface Unmapped {
  what: UnmappedWhat;
  /** The card's old uuid, when the reference sits on a card. */
  card?: string;
  title?: string;
  /** The old key or node text. */
  value: string;
  reason: string;
  /** For an ambiguous key: every item that carries it. */
  candidates?: string[];
}

/** A reference that was mapped to an item (what the duplicate-key report needs). */
export interface Resolved { what: UnmappedWhat; card?: string; title?: string; value: string; id: string }

export interface LegacyImportResult {
  counts: { cards: number; notes: number; files: number; links: number; positions: number; history: number; checkRuns: number; now: number; seenReaders: number; planSeenItems: number };
  remapped: { cardAreas: number; cardSteps: number; linkEnds: number; positions: number; now: number; checks: number; planSeenItems: number };
  unmapped: Unmapped[];
  resolved: Resolved[];
  /** Rows the unique indexes turned away (a second link between the same two nodes after renaming), named. */
  duplicates: string[];
  revision: number;
}

const COPY = /#[0-9]{1,3}$/;
const CHECKPOINT_NODE = /^checkpoint:(.+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function importLegacyData(db: WorkspaceDb, data: LegacyData, keys: ReadonlyMap<string, string>, options: { by: string; ambiguous?: ReadonlyMap<string, string[]> }): Promise<LegacyImportResult> {
  return db.serialize(() => importLocked(db, data, keys, options));
}

async function importLocked(db: WorkspaceDb, data: LegacyData, keys: ReadonlyMap<string, string>, options: { by: string; ambiguous?: ReadonlyMap<string, string[]> }): Promise<LegacyImportResult> {
  await beginImmediate(db);
  try {
    const sqlite = db.sqlite;
    const at = new Date().toISOString();
    const unmapped: Unmapped[] = [];
    const resolved: Resolved[] = [];
    const duplicates: string[] = [];
    const remapped = { cardAreas: 0, cardSteps: 0, linkEnds: 0, positions: 0, now: 0, checks: 0, planSeenItems: 0 };
    const kindOf = (id: string): string | undefined => (sqlite.prepare('SELECT kind FROM blocks WHERE id = ?').get(id) as { kind: string } | undefined)?.kind;

    const ambiguous = options.ambiguous ?? new Map<string, string[]>();
    /** An unmapped reference; a key that several items share is said to be ambiguous, with every candidate. */
    const miss = (what: UnmappedWhat, key: string, base: Omit<Unmapped, 'what' | 'reason' | 'candidates'>, plain: string): Unmapped => {
      const candidates = ambiguous.get(key);
      return candidates
        ? { what, ...base, reason: `ambiguous: ${candidates.length} plan items share the key "${key}" (${candidates.join(', ')}), so it is not mapped to any of them`, candidates }
        : { what, ...base, reason: plain };
    };
    const taken = new Set<string>();
    const cardIdOf = new Map<string, string>();
    for (const c of data.cards) cardIdOf.set(c.id, newId(sqlite, 'card', taken));

    // ── cards
    const insertCard = sqlite.prepare('INSERT INTO cards(id, legacy_id, kind, title, body, path, description, area, step_id, about, look, look_at, pinned, archived, by, at, updated_by, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)');
    let notes = 0;
    let files = 0;
    for (const c of data.cards) {
      let area: string | null = null;
      if (c.area === 'plan:own') area = 'plan:own';
      else if (c.area) {
        const key = CHECKPOINT_NODE.exec(c.area)?.[1] ?? '';
        const id = keys.get(key);
        if (id && kindOf(id) === 'checkpoint') { area = `checkpoint:${id}`; remapped.cardAreas += 1; resolved.push({ what: 'card.area', card: c.id, title: c.title, value: c.area, id }); }
        else unmapped.push(miss('card.area', key, { card: c.id, title: c.title, value: c.area }, id ? 'that key names a step or decision, not a checkpoint' : 'no checkpoint has that key any more (reworded or removed); the card keeps no area'));
      }
      let stepId: string | null = null;
      if (c.step) {
        const id = keys.get(c.step);
        if (id && kindOf(id) === 'step') { stepId = id; remapped.cardSteps += 1; resolved.push({ what: 'card.step', card: c.id, title: c.title, value: c.step, id }); }
        else unmapped.push(miss('card.step', c.step, { card: c.id, title: c.title, value: c.step }, id ? `that key names a ${kindOf(id)}, not a step; the card keeps its area with an empty step` : 'no plan item has that key any more (reworded or removed); the card keeps its area with an empty step'));
      }
      insertCard.run(cardIdOf.get(c.id)!, c.id, c.kind, c.title, c.kind === 'note' ? (c.body ?? '') : null, c.kind === 'file' ? (c.path ?? null) : null, c.kind === 'file' ? (c.description ?? '') : null,
        area, stepId, c.about ?? null, c.look ?? null, c.look ? (c.lookAt ?? c.updatedAt) : null, c.pinned ? 1 : 0, c.archived ? 1 : 0, c.by, c.at, c.updatedBy, c.updatedAt);
      markUsed(sqlite, cardIdOf.get(c.id)!);
      if (c.kind === 'note') notes += 1; else files += 1;
    }

    // ── nodes (link ends and positions)
    const node = (value: string, what: UnmappedWhat): string => {
      if (UUID.test(value)) { const id = cardIdOf.get(value); return id ?? value; }
      const m = CHECKPOINT_NODE.exec(value);
      if (!m) return value;
      const copy = COPY.exec(m[1]!)?.[0] ?? '';
      const key = copy ? m[1]!.slice(0, -copy.length) : m[1]!;
      const id = keys.get(key);
      if (id && kindOf(id) === 'checkpoint') { resolved.push({ what, value, id }); return `checkpoint:${id}${copy}`; }
      unmapped.push(miss(what, key, { value }, id ? 'that key names a step or decision, not a checkpoint; the node text stays as it was' : 'no checkpoint has that key any more (reworded or removed); the node text stays as it was'));
      return value;
    };

    // ── links
    const insertLink = sqlite.prepare('INSERT OR IGNORE INTO links(id, from_node, to_node, label, by, at) VALUES (?, ?, ?, ?, ?, ?)');
    let links = 0;
    for (const l of data.links) {
      const from = node(l.from, 'link.from');
      const to = node(l.to, 'link.to');
      if (from !== l.from) remapped.linkEnds += 1;
      if (to !== l.to) remapped.linkEnds += 1;
      const run = insertLink.run(l.id, from, to, l.label ?? null, l.by, l.at);
      if (Number(run.changes) === 1) links += 1; else duplicates.push(`link ${l.id} (${l.from} to ${l.to}) joins the same two nodes as another link after renaming`);
    }

    // ── positions
    const insertPosition = sqlite.prepare('INSERT OR IGNORE INTO positions(node_id, x, y) VALUES (?, ?, ?)');
    let positions = 0;
    for (const [nodeId, p] of Object.entries(data.positions)) {
      const mapped = node(nodeId, 'position');
      if (mapped !== nodeId) remapped.positions += 1;
      if (Number(insertPosition.run(mapped, p.x, p.y).changes) === 1) positions += 1; else duplicates.push(`position of ${nodeId} lands on a node that already has one`);
    }

    // ── Now
    let nowCount = 0;
    if (data.now) {
      const id = keys.get(data.now.key);
      const row = id ? sqlite.prepare('SELECT kind, done FROM blocks WHERE id = ?').get(id) as { kind: string; done: number } | undefined : undefined;
      if (!row) unmapped.push(miss('now', data.now.key, { value: data.now.key }, 'no plan item has that key any more'));
      else if (row.kind !== 'step') unmapped.push({ what: 'now', value: data.now.key, reason: `that key names a ${row.kind}, not a step` });
      else if (row.done) unmapped.push({ what: 'now', value: data.now.key, reason: 'that step is done, so it is no longer being worked on' });
      else {
        sqlite.prepare('INSERT INTO now(id, item_id, by, at) VALUES (1, ?, ?, ?)').run(id!, data.now.by, data.now.at);
        resolved.push({ what: 'now', value: data.now.key, id: id! });
        remapped.now += 1; nowCount = 1;
      }
    }

    // ── seen
    const insertSeen = sqlite.prepare('INSERT INTO seen(reader, at, seen, pending) VALUES (?, ?, ?, ?)');
    const readers = new Set([...Object.keys(data.seen.readers), ...Object.keys(data.seen.pending)]);
    let seenReaders = 0;
    for (const reader of [...readers].sort()) {
      const own = data.seen.readers[reader] as { at?: string } | undefined;
      const waiting = data.seen.pending[reader] as { at?: string } | undefined;
      insertSeen.run(reader, own?.at ?? waiting?.at ?? at, JSON.stringify(own ?? {}), waiting ? JSON.stringify(waiting) : '[]');
      seenReaders += 1;
    }
    let planSeenItems = 0;
    if (data.seen.plan) {
      const items: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data.seen.plan.items)) {
        const id = keys.get(key);
        if (id) { items[id] = value; remapped.planSeenItems += 1; } else items[key] = value; // an item that is gone keeps its old key
        planSeenItems += 1;
      }
      insertSeen.run('#plan-file', at, JSON.stringify({ hash: data.seen.plan.hash ?? null, items }), '[]');
    }

    // ── old check results as legacy runs
    const dbId = readDbId(sqlite);
    let checkRuns = 0;
    for (const [key, evidence] of Object.entries(data.checks).sort(([a], [b]) => a.localeCompare(b))) {
      const id = keys.get(key);
      const block = id ? sqlite.prepare('SELECT id, kind, rev, text, detail FROM blocks WHERE id = ?').get(id) as { id: string; kind: string; rev: number; text: string; detail: string } | undefined : undefined;
      if (!block || block.kind !== 'checkpoint') {
        unmapped.push(miss('check', key, { value: key }, block ? `that key names a ${block.kind}, not a checkpoint` : 'no checkpoint has that key any more'));
        continue;
      }
      const check = effectiveCheck(block.detail);
      const status = evidence.lastVerificationStatus === 'pass' || evidence.lastVerificationStatus === 'pass_dirty' ? 'passed' : evidence.lastVerificationStatus === 'fail' ? 'failed' : 'error';
      const when = evidence.at ?? at;
      sqlite.prepare('INSERT INTO check_runs(item_id, item_rev, content_hash, db_id, check_kind, command, status, exit_code, sha, started_at, finished_at, by, legacy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(block.id, block.rev, contentHash(block.text, block.detail), dbId, check.kind === 'none' ? 'workspace' : check.kind, check.command, status, status === 'passed' ? 0 : status === 'failed' ? 1 : null, evidence.lastVerificationSha ?? null, when, when, 'import');
      resolved.push({ what: 'check', value: key, id: block.id });
      remapped.checks += 1; checkRuns += 1;
    }

    // ── history: one row for this import, then the old entries as summaries (each needs a revision of its own)
    let revision = readRevision(sqlite);
    const insertChange = sqlite.prepare('INSERT INTO changes(revision, kind, at, by, summary, rows) VALUES (?, ?, ?, ?, ?, NULL)');
    revision += 1;
    insertChange.run(revision, 'import', at, options.by, `imported the board and the old data: ${data.cards.length} cards, ${links} links, ${positions} positions, ${checkRuns} old check results`);
    for (const h of data.history) {
      revision += 1;
      insertChange.run(revision, 'legacy', h.at, h.by, h.summary);
    }
    setMeta(sqlite, 'revision', revision);
    await commitTransaction(db);
    afterCommit(db);
    return {
      counts: { cards: data.cards.length, notes, files, links, positions, history: data.history.length, checkRuns, now: nowCount, seenReaders, planSeenItems },
      remapped, unmapped, resolved, duplicates, revision,
    };
  } catch (error) {
    try { db.sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
    throw error;
  }
}
