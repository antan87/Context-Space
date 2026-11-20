/**
 * @module core/workspace-db/snapshot
 * The portable snapshot (`contextspace-data.json`): the part of the database that travels in Git and rebuilds a workspace
 * that has no database. It holds the plan (its blocks in document order), the decisions and checks read out of them, and the
 * Board's cards and links. History, who has seen what, drafts, check runs and every row's `rev` stay local.
 *
 * Positions are left out by default (v6 point 4 of the design): a drag must not change a committed file. `positions: true`
 * adds them, for a backup or a trial.
 *
 * The text is deterministic: fixed key order, lists sorted by document order or id, two-space indent, one trailing newline.
 * The header carries `db_id`, `revision` and a digest of everything after it.
 */

import { createHash } from 'node:crypto';

import { readDbId, readRevision, getMeta, withSnapshot, type WorkspaceDb } from './connection.js';

type Raw = Record<string, unknown>;

export interface SnapshotOptions {
  /** Include where nodes were dragged to (default false). */
  positions?: boolean;
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function exportPortableSnapshot(db: WorkspaceDb, options: SnapshotOptions = {}): string {
  return withSnapshot(db, (v) => {
    const q = (sql: string): Raw[] => v.sqlite.prepare(sql).all() as Raw[];
    const blocks = q('SELECT id, kind, parent_id, text, name, detail, done FROM blocks ORDER BY ord, id');
    const position = new Map(blocks.map((b, i) => [b.id as string, i]));
    const byBlock = (a: Raw, b: Raw) => (position.get(a.item_id as string) ?? 0) - (position.get(b.item_id as string) ?? 0);

    const meta = new Map((q('SELECT item_id, answered_by, answered_at FROM decision_meta')).map((r) => [r.item_id as string, r]));
    const decisions = q('SELECT item_id, suggested, if_no_answer, answer FROM decisions').sort(byBlock).map((r) => ({
      item_id: r.item_id as string,
      suggested: JSON.parse(String(r.suggested ?? '[]')) as unknown,
      if_no_answer: text(r.if_no_answer),
      answer: text(r.answer),
      answered_by: text(meta.get(r.item_id as string)?.answered_by),
      answered_at: text(meta.get(r.item_id as string)?.answered_at),
    }));
    const checks = q('SELECT item_id, kind, command, outcome FROM checks').sort(byBlock).map((r) => ({
      item_id: r.item_id as string, kind: r.kind as string, command: text(r.command), outcome: text(r.outcome),
    }));
    const cards = q('SELECT * FROM cards ORDER BY id').map((r) => ({
      id: r.id as string, legacy_id: text(r.legacy_id), kind: r.kind as string, title: r.title as string, body: text(r.body), path: text(r.path),
      description: text(r.description), area: text(r.area), step_id: text(r.step_id), about: text(r.about), look: text(r.look), look_at: text(r.look_at),
      pinned: Number(r.pinned) === 1, archived: Number(r.archived) === 1, by: r.by as string, at: r.at as string,
      updated_by: r.updated_by as string, updated_at: r.updated_at as string,
    }));
    const links = q('SELECT * FROM links ORDER BY id').map((r) => ({
      id: r.id as string, from_node: r.from_node as string, to_node: r.to_node as string, label: text(r.label), by: r.by as string, at: r.at as string,
    }));

    const content: Record<string, unknown> = {
      plan: { eol: getMeta(v.sqlite, 'eol') === 'crlf' ? 'crlf' : 'lf', trailing_newline: getMeta(v.sqlite, 'trailing_newline') !== '0' },
      blocks: blocks.map((b) => ({
        id: b.id as string, kind: b.kind as string, parent_id: text(b.parent_id), text: b.text as string, name: text(b.name), detail: b.detail as string, done: Number(b.done) === 1,
      })),
      decisions, checks, cards, links,
    };
    if (options.positions) {
      content.positions = q('SELECT node_id, x, y FROM positions ORDER BY node_id').map((r) => ({ node_id: r.node_id as string, x: Number(r.x), y: Number(r.y) }));
    }
    const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
    const whole = { format: 'contextspace-data', version: 1, db_id: readDbId(v.sqlite), revision: readRevision(v.sqlite), digest, ...content };
    return `${JSON.stringify(whole, null, 2)}\n`;
  });
}
