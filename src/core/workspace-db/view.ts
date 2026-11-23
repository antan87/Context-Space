/**
 * @module core/workspace-db/view
 * `planView`: the compact text an AI reads first (`ctxspace plan`). Ids first, so every line can be named in an op.
 *
 * The default is short (about 6 KB or less on a plan of this workspace's size):
 * - the first line of "Where we stopped";
 * - each checkpoint that is in progress (it has an open item, or Now is inside it) with its open items, in full up to
 *   300 characters, done ones folded into a count, for as long as the `budget` of characters lasts: Now's checkpoint
 *   first, then the others in plan order. A checkpoint that does not fit is one line with its counts. (v4 point 11
 *   says "in progress" and "about 6 KB" together; on this workspace's plan 12 of 16 checkpoints have an open item, so
 *   the rule alone gives 20 KB. The budget is what keeps the aim; see the DB1 report.)
 * - every other checkpoint as one line with its counts;
 * - items outside the Checkpoints list that are still open, with what is left of the budget, then a count of the rest.
 *
 * `{ id }` expands one item or block; `{ all: true }` shows everything.
 */

import { getRevision, getCard, getItem, getNow } from './reads.js';
import { withSnapshot, type WorkspaceDb } from './connection.js';
import { listCheckRuns } from './check-runs.js';

export interface PlanViewOptions {
  id?: string;
  all?: boolean;
  /** How many characters of open items the default view spends before it folds the rest to one line each. */
  budget?: number;
}

/** About 4 KB of open items, so the whole default view stays near 6 KB. */
export const DEFAULT_VIEW_BUDGET = 4000;

interface Row { id: string; kind: string; parent_id: string | null; ord: number; text: string; name: string | null; detail: string; done: number; rev: number; checkpoint_id: string | null }

const clip = (text: string, n = 300) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function planView(db: WorkspaceDb, options: PlanViewOptions = {}): string {
  return withSnapshot(db, (v) => buildView(v, options));
}

function buildView(db: WorkspaceDb, options: PlanViewOptions): string {
  const sqlite = db.sqlite;
  const { revision, dbId } = getRevision(db);
  const rows = sqlite.prepare('SELECT id, kind, parent_id, ord, text, name, detail, done, rev, checkpoint_id FROM blocks ORDER BY ord, id').all() as unknown as Row[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<string | null, Row[]>();
  for (const r of rows) {
    if (r.kind === 'heading' || r.kind === 'prose') continue;
    const list = kids.get(r.parent_id) ?? [];
    list.push(r);
    kids.set(r.parent_id, list);
  }
  const now = getNow(db);
  const cardsByStep = new Map((sqlite.prepare('SELECT step_id AS id, count(*) AS n FROM cards WHERE step_id IS NOT NULL AND archived = 0 GROUP BY step_id').all() as Array<{ id: string; n: number }>).map((r) => [r.id, r.n]));
  const cardsByArea = new Map((sqlite.prepare("SELECT substr(area, 12) AS id, count(*) AS n FROM cards WHERE area LIKE 'checkpoint:%' AND archived = 0 GROUP BY area").all() as Array<{ id: string; n: number }>).map((r) => [r.id, r.n]));
  const suggested = new Map((sqlite.prepare('SELECT item_id AS id, suggested FROM decisions').all() as Array<{ id: string; suggested: string }>).map((r) => [r.id, JSON.parse(r.suggested) as string[]]));

  const openBelow = new Map<string, boolean>();
  const hasOpen = (r: Row): boolean => {
    const known = openBelow.get(r.id);
    if (known !== undefined) return known;
    const value = r.done === 0 || (kids.get(r.id) ?? []).some(hasOpen);
    openBelow.set(r.id, value);
    return value;
  };
  const nowInside = (r: Row): boolean => {
    if (!now) return false;
    for (let up = byId.get(now.itemId); up; up = up.parent_id ? byId.get(up.parent_id) : undefined) if (up.id === r.id) return true;
    return false;
  };
  const cardNote = (r: Row) => {
    const n = r.kind === 'checkpoint' ? cardsByArea.get(r.id) : cardsByStep.get(r.id);
    return n ? ` · ${n}c` : '';
  };
  const markOf = (r: Row) => (r.done ? '[x]' : '[ ]');
  const count = (r: Row): { total: number; open: number } => {
    let total = 0; let open = 0;
    const walk = (x: Row) => { for (const k of kids.get(x.id) ?? []) { total += 1; if (!k.done) open += 1; walk(k); } };
    walk(r);
    return { total, open };
  };

  if (options.id) return itemText(db, options.id);

  const out: string[] = [];
  const items = rows.filter((r) => r.kind !== 'heading' && r.kind !== 'prose');
  const title = rows.find((r) => r.kind === 'heading')?.name ?? 'plan';
  out.push(`${title} · revision ${revision} · db ${dbId} · ${items.filter((r) => !r.done).length} open of ${items.length} items`);
  const stopped = whereWeStopped(rows);
  if (stopped && !options.all) out.push(`Where we stopped: ${clip(stopped, 200)}`);
  out.push(options.all
    ? 'id [ ] open · [x] done · ? decision · Nc = N cards. Everything, in order. One item: `ctxspace plan <id>`.'
    : 'id [ ] open · [x] done · ? decision · Nc = N cards. Open work in full while it fits, other checkpoints one line with counts. One item or checkpoint: `ctxspace plan <id>`; everything: `ctxspace plan --all`.');

  const render = (r: Row, depth: number, into: string[]) => {
    const pad = '  '.repeat(depth);
    const list = kids.get(r.id) ?? [];
    const shown = options.all ? list : list.filter(hasOpen);
    const folded = list.length - shown.length;
    if (r.kind === 'decision') {
      into.push(`${pad}${r.id} ${markOf(r)} ? ${clip(r.name ?? '')}${cardNote(r)}`);
      const s = suggested.get(r.id) ?? [];
      if ((!r.done || options.all) && s.length) into.push(`${pad}    suggested: ${s.map((a) => clip(a, 60)).join(' · ')}`);
    } else {
      into.push(`${pad}${r.id} ${markOf(r)} ${clip(r.name ?? '')}${cardNote(r)}${now?.itemId === r.id ? ' · NOW' : ''}${folded ? ` (+${folded} done)` : ''}`);
    }
    for (const k of shown) render(k, depth + 1, into);
  };

  // Which in-progress checkpoints get their open items in full: Now's first, then the others in plan order, while the budget lasts.
  const budget = options.budget ?? DEFAULT_VIEW_BUDGET;
  const inFull = new Set<string>();
  const sizeOf = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
  let spent = 0;
  if (!options.all) {
    const candidates = rows.filter((r) => r.kind === 'checkpoint' && !r.parent_id && (hasOpen(r) || nowInside(r)));
    const take = (r: Row) => {
      const lines: string[] = [];
      render(r, 1, lines);
      const size = sizeOf(lines);
      if (nowInside(r) || spent + size <= budget) { inFull.add(r.id); spent += size; }
    };
    for (const r of candidates.filter(nowInside)) take(r);
    for (const r of candidates.filter((x) => !nowInside(x))) take(r);
  }

  let looseFolded = 0;
  for (const r of rows) {
    if (r.kind === 'heading') {
      if (options.all) out.push(`${r.id} ${r.text}`);
      continue;
    }
    if (r.kind === 'prose' || r.parent_id) continue;
    if (r.kind === 'checkpoint') {
      if (options.all || inFull.has(r.id)) render(r, 1, out);
      else {
        const c = count(r);
        out.push(`  ${r.id} ${markOf(r)} ${clip(r.name ?? '', 120)}${c.total ? ` (${c.open ? `${c.open} open, ` : ''}${c.total - c.open} done)` : ''}${cardNote(r)}`);
      }
    } else if (options.all) {
      render(r, 1, out);
    } else if (hasOpen(r)) {
      const lines: string[] = [];
      render(r, 1, lines);
      if (spent + sizeOf(lines) <= budget) { out.push(...lines); spent += sizeOf(lines); } else looseFolded += 1;
    }
  }
  if (looseFolded) out.push(`  (+${looseFolded} more open items outside the Checkpoints list: \`ctxspace plan --all\`)`);
  return `${out.join('\n')}\n`;
}

function whereWeStopped(rows: Row[]): string | null {
  const h = rows.findIndex((r) => r.kind === 'heading' && /where we stopped/i.test(r.name ?? ''));
  if (h < 0) return null;
  for (let i = h + 1; i < rows.length && rows[i]!.kind !== 'heading'; i += 1) {
    if (rows[i]!.kind !== 'prose') continue;
    const line = rows[i]!.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('<!--'));
    if (line) return line.replace(/^[-*+]\s+/, '');
  }
  return null;
}

function itemText(db: WorkspaceDb, id: string): string {
  const row = db.sqlite.prepare('SELECT id, kind, rev, text, name, detail, done FROM blocks WHERE id = ?').get(id) as { id: string; kind: string; rev: number; text: string; name: string | null; detail: string; done: number } | undefined;
  if (!row) {
    const card = getCard(db, id);
    if (card) return [`${card.id} ${card.kind} card rev ${card.rev}`, card.title, card.body ?? card.description ?? '', ''].join('\n');
    return `No plan block ${id}. Ids look like s7k2q; run \`ctxspace plan\`.\n`;
  }
  if (row.kind === 'heading' || row.kind === 'prose') return `${row.id} ${row.kind} rev ${row.rev}\n${row.text}\n`;
  const view = getItem(db, id)!;
  const lines = [`${row.id} ${row.kind} rev ${row.rev} ${row.done ? 'done' : 'open'}`, row.text.trim().replace(/^[-*+] \[[ xX]\] /, '')];
  if (row.detail) lines.push(row.detail);
  if (view.check && view.check.kind !== 'none') {
    const runs = listCheckRuns(db, id, 1);
    const last = runs[0];
    lines.push(`check: ${view.check.kind === 'workspace' ? 'the workspace checks' : view.check.command}${last ? ` · last run #${last.id} ${last.status} at rev ${last.itemRev}${last.legacy ? ' (old, imported)' : ''}` : ' · never run'}`);
  }
  if (view.decision) lines.push(`decision: ${view.decision.answer ? `answered "${view.decision.answer}" by ${view.decision.answeredBy ?? '?'}` : 'waiting'}`);
  if (view.cardIds.length) lines.push(`cards: ${view.cardIds.join(' ')}`);
  if (view.children.length) {
    lines.push('', 'items under it:');
    for (const c of view.children) lines.push(`  ${c.id} ${c.done ? '[x]' : '[ ]'} rev ${c.rev} ${clip(c.name ?? '', 200)}`);
  }
  return `${lines.join('\n')}\n`;
}
