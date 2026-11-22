/**
 * @module core/workspace-db/ops
 * The operations of a batch, applied in memory to the loaded document (plan blocks) and, for the Board, straight to the
 * rows inside the batch's transaction. Nothing here commits: `applyBatch` owns the transaction, runs the footprint,
 * grammar and check-run guards over the result, and rolls everything back when any op was refused.
 *
 * Each refusal is an `OpError` that says which op, why, what the row reads now and what to do. These words are what
 * an AI recovers from, so they are written to be acted on.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { newId, markUsed } from './ids.js';
import {
  indentOf, isItemKind, itemName, parseDetail, fieldLines, wordsOf, HEADING,
  type BlockKind, type ItemKind,
} from './plan-text.js';
import type { Doc, DocBlock, Recorder } from './store.js';

export type IssueCode =
  | 'invalid' | 'not_found' | 'ambiguous' | 'rev_required' | 'rev_conflict' | 'limit'
  | 'stale_revision' | 'missing_revision' | 'bad_revision' | 'history_pruned' | 'db_changed'
  | 'bad_structure' | 'request_reused' | 'check_required' | 'undo_refused';

export class OpError extends Error {
  constructor(readonly code: IssueCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'OpError';
  }
}
const bad = (message: string, extra?: Record<string, unknown>) => new OpError('invalid', message, extra);

/** The limits the Board file keeps (`core/board.ts` BOARD_LIMITS), so the same cards fit. */
export const LIMITS = {
  cards: 500, links: 1000, positions: 2000, ops: 100,
  title: 200, body: 4000, description: 4000, label: 200, path: 1000, look: 140,
  coordinate: 1_000_000, line: 2000, textBlock: 100_000, detail: 100_000,
} as const;

export const OP_FIELDS: Record<string, readonly string[]> = {
  add: ['kind', 'text', 'under', 'after', 'before', 'in', 'first', 'detail', 'suggested', 'ifNoAnswer', 'check', 'as', 'done', 'level'],
  reword: ['id', 'text', 'rev'],
  edit: ['id', 'find', 'replace', 'in', 'rev'],
  detail: ['id', 'text', 'rev'],
  move: ['id', 'under', 'after', 'before', 'in', 'first', 'rev'],
  tick: ['id', 'rev'],
  untick: ['id', 'rev'],
  remove: ['id', 'rev', 'cascade'],
  answer: ['id', 'text', 'answer', 'rev'],
  'block.set': ['id', 'text', 'rev'],
  'card.add': ['kind', 'title', 'body', 'path', 'description', 'area', 'step', 'about', 'look', 'as', 'pinned'],
  'card.update': ['id', 'rev', 'title', 'body', 'path', 'description', 'area', 'step', 'about', 'look', 'pinned', 'archived'],
  'card.remove': ['id', 'rev'],
  link: ['from', 'to', 'label'],
  unlink: ['from', 'to', 'id'],
  place: ['node', 'x', 'y'],
  now: ['id'],
};
const FIELD_HINTS: Record<string, string> = {
  title: 'text', name: 'text', question: 'text', parent: 'under', parentId: 'under', checkpoint: 'under', position: 'after',
  answers: 'suggested', suggestedAnswers: 'suggested', step_id: 'step', cardId: 'id', block: 'id', itemId: 'id', blockId: 'id',
};
/** The fields that name a row or node, where `$name` stands for something added earlier in the same batch. */
export const REF_KEYS = ['id', 'under', 'after', 'before', 'in', 'step', 'area', 'from', 'to', 'node'] as const;

export type Op = Record<string, unknown> & { op: string };

export interface OpContext {
  db: DatabaseSync;
  doc: Doc;
  rec: Recorder;
  by: string;
  at: string;
  dbId: string;
  refs: Map<string, string>;
  taken: Set<string>;
  log: string[];
  newIds: string[];
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function oneLine(value: unknown, what = 'text', max: number = LIMITS.line): string {
  if (typeof value !== 'string') throw bad(`"${what}" must be a string.`);
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) throw bad(`"${what}" is empty. Say it in words.`);
  if (cleaned.length > max) throw bad(`"${what}" is ${cleaned.length} characters; keep it to ${max} or fewer.`);
  return cleaned;
}

// ─── Finding things ─────────────────────────────────────────────────────────

const ITEM_KINDS: readonly BlockKind[] = ['checkpoint', 'step', 'decision'];

function block(ctx: OpContext, id: unknown, kinds?: readonly BlockKind[]): DocBlock {
  if (typeof id !== 'string' || !id) throw bad('Name a block by its id, for example "s7k2q" (run `ctxspace plan` to see them).');
  const found = ctx.doc.blocks.find((b) => b.id === id);
  if (!found) {
    const card = ctx.db.prepare('SELECT 1 FROM cards WHERE id = ? OR legacy_id = ?').get(id, id);
    throw new OpError('not_found', `No plan block with id "${id}"${card ? ' (that is a card: use card.update or card.remove)' : ''}. Ids look like s7k2q; run \`ctxspace plan\` or query the blocks table.`);
  }
  if (kinds && !kinds.includes(found.kind)) throw bad(`"${id}" is a ${found.kind}; this op needs ${kinds.join(' or ')}.`);
  return found;
}

/** A card by its id, its old uuid, or a unique prefix (6 or more characters) of the old uuid. Aliases resolve here, before any check. */
export function findCard(db: DatabaseSync, id: string): { row: Record<string, unknown> } | { ambiguous: number } | null {
  let row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) row = db.prepare('SELECT * FROM cards WHERE legacy_id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row && id.length >= 6 && /^[0-9a-f-]+$/i.test(id)) {
    const matches = db.prepare("SELECT * FROM cards WHERE legacy_id LIKE ? ESCAPE '\\'").all(`${id.replace(/[%_\\]/g, '')}%`) as Array<Record<string, unknown>>;
    if (matches.length > 1) return { ambiguous: matches.length };
    row = matches[0];
  }
  return row ? { row } : null;
}

function resolveCard(ctx: OpContext, id: unknown): Record<string, unknown> {
  if (typeof id !== 'string' || !id) throw bad('Name a card by its id, for example "k3m9a" (query: select id, title from cards).');
  const found = findCard(ctx.db, id);
  if (found && 'ambiguous' in found) throw new OpError('ambiguous', `"${id}" matches ${found.ambiguous} cards; use more characters.`);
  if (!found) throw new OpError('not_found', `No card "${id}". Query: select id, title from cards.`);
  return found.row;
}

function lastChange(ctx: OpContext, id: string): string {
  const row = ctx.db.prepare('SELECT revision, by, summary FROM changes WHERE rows LIKE ? ORDER BY seq DESC LIMIT 1').get(`%"id":"${id}"%`) as { revision: number; by: string; summary: string } | undefined;
  return row ? `last changed at revision ${row.revision} by ${row.by} (${clip(row.summary, 120)})` : 'no change recorded';
}

function reads(b: DocBlock): string {
  const text = b.kind === 'prose' || b.kind === 'heading' ? b.text : (b.name ?? b.text);
  return clip(text, 300);
}

function checkRev(ctx: OpContext, op: Op, id: string, current: number, what: string): void {
  if (op.rev === undefined) return;
  if (!Number.isInteger(op.rev)) throw bad('"rev" must be the integer you read.');
  if (op.rev !== current) {
    throw new OpError('rev_conflict', `rev conflict on ${id}: you sent rev ${String(op.rev)}, it is now rev ${current}, ${lastChange(ctx, id)}. It now reads: ${what}. Read it again (\`ctxspace plan ${id}\`), decide whether your change still makes sense on top of the new text, then resend with "rev": ${current}. Nothing was applied.`, { id, currentRev: current });
  }
}

/** A row added earlier in the same batch has no rev to read: `$name` ids are exempt from the required `rev`. */
const isNewInBatch = (op: Op, b: DocBlock): boolean => b._new === true || op.__ref === true;

function needRev(ctx: OpContext, op: Op, b: DocBlock, why: string): void {
  if (isNewInBatch(op, b)) return;
  if (op.rev === undefined) {
    throw new OpError('rev_required', `${op.op} ${b.id} needs its "rev" (now ${b._rev0}; \`ctxspace plan ${b.id}\` shows it): ${why} The line now reads: ${reads(b)}`, { id: b.id, currentRev: b._rev0 });
  }
  checkRev(ctx, op, b.id, b._rev0, reads(b));
}

// ─── Tree helpers ───────────────────────────────────────────────────────────

const dirty = (b: DocBlock) => { b._dirty = true; };

function isDescendant(byId: Map<string, DocBlock>, b: DocBlock, ancestor: DocBlock): boolean {
  let up = b.parent_id ? byId.get(b.parent_id) : undefined;
  for (let guard = 0; up && guard < 200; guard += 1) {
    if (up.id === ancestor.id) return true;
    up = up.parent_id ? byId.get(up.parent_id) : undefined;
  }
  return false;
}

/** The last index of the block's range: itself and everything nested under it (prose between its children included). */
export function rangeEnd(blocks: DocBlock[], i: number): number {
  const b = blocks[i]!;
  if (!isItemKind(b.kind)) return i;
  const byId = new Map(blocks.map((x) => [x.id, x]));
  let last = i;
  for (let k = i + 1; k < blocks.length; k += 1) {
    const next = blocks[k]!;
    if (next.kind === 'heading') break;
    if (next.kind === 'prose') continue;
    if (isDescendant(byId, next, b)) last = k; else break;
  }
  return last;
}

/** Every item nested under `b`, at any depth. */
export function descendantsOf(blocks: DocBlock[], b: DocBlock): DocBlock[] {
  const i = blocks.indexOf(b);
  if (i < 0) return [];
  return blocks.slice(i + 1, rangeEnd(blocks, i) + 1).filter((x) => isItemKind(x.kind));
}

const shiftLines = (text: string, delta: number): string => text.split('\n').map((line) => {
  if (!line.trim()) return line;
  return delta >= 0 ? ' '.repeat(delta) + line : line.slice(Math.min(-delta, indentOf(line)));
}).join('\n');

interface Where { under?: unknown; after?: unknown; before?: unknown; in?: unknown; first?: unknown }
interface Spot { pos: number; parentId: string | null; indent: number }

function spot(blocks: DocBlock[], where: Where, kind: BlockKind): Spot {
  const given = (['under', 'after', 'before', 'in'] as const).filter((k) => where[k] !== undefined);
  if (given.length > 1) throw bad(`Give only one of under / after / before / in (got ${given.join(', ')}).`);
  const at = (id: unknown): number => {
    const i = blocks.findIndex((b) => b.id === id);
    if (i < 0) throw new OpError('not_found', `No block with id "${String(id)}" to place it ${given[0]}. Run \`ctxspace plan\`.`);
    return i;
  };
  if (where.under !== undefined) {
    const i = at(where.under);
    const parent = blocks[i]!;
    if (!isItemKind(parent.kind)) throw bad(`"${parent.id}" is a ${parent.kind}: only a checkpoint, step or decision can have items under it. Use "after" a heading, or "in": "<heading id>".`);
    if (!isItemKind(kind)) throw bad(`A ${kind} cannot go "under" an item. Use "after", "before" or "in".`);
    if (kind === 'checkpoint') throw bad('A checkpoint cannot be nested under another item. Use "after": "<checkpoint id>", or leave the place out to add it last.');
    const kids = blocks.filter((b) => b.parent_id === parent.id);
    return { pos: where.first ? i + 1 : rangeEnd(blocks, i) + 1, parentId: parent.id, indent: kids.length ? indentOf(kids[0]!.text) : indentOf(parent.text) + 2 };
  }
  if (where.after !== undefined || where.before !== undefined) {
    const before = where.before !== undefined;
    const i = at(before ? where.before : where.after);
    const anchor = blocks[i]!;
    if (!isItemKind(anchor.kind)) return { pos: before ? i : i + 1, parentId: null, indent: 0 };
    return { pos: before ? i : rangeEnd(blocks, i) + 1, parentId: anchor.parent_id, indent: indentOf(anchor.text) };
  }
  if (where.in !== undefined) {
    const i = at(where.in);
    if (blocks[i]!.kind !== 'heading') throw bad(`"in" takes a heading id; "${blocks[i]!.id}" is a ${blocks[i]!.kind}.`);
    let lastItem = -1;
    for (let k = i + 1; k < blocks.length; k += 1) {
      if (blocks[k]!.kind === 'heading') break;
      if (isItemKind(blocks[k]!.kind)) lastItem = k;
    }
    return { pos: lastItem >= 0 ? lastItem + 1 : i + 1, parentId: null, indent: 0 };
  }
  if (kind === 'checkpoint') {
    const indexes = blocks.map((b, i) => [b, i] as const).filter(([b]) => b.kind === 'checkpoint');
    if (indexes.length) {
      const [last, i] = indexes[indexes.length - 1]!;
      return { pos: rangeEnd(blocks, i) + 1, parentId: null, indent: indentOf(last.text) };
    }
    const h = blocks.findIndex((b) => b.kind === 'heading' && /^#{1,6}\s+(?:checkpoints|milestones)\b/i.test(b.text));
    if (h < 0) throw bad('The plan has no Checkpoints section to put a checkpoint in.');
    return { pos: h + 1, parentId: null, indent: 0 };
  }
  throw bad('Say where it goes: "under": "<item id>" (last child; add "first": true for the first), "after": "<id>", "before": "<id>" or "in": "<heading id>".');
}

function placeRange(ctx: OpContext, range: DocBlock[], where: Where, kind: BlockKind): Spot {
  const blocks = ctx.doc.blocks;
  const inRange = new Set(range);
  const rest = blocks.filter((b) => !inRange.has(b));
  for (const key of ['under', 'after', 'before'] as const) {
    if (typeof where[key] === 'string' && range.some((b) => b.id === where[key])) throw bad('Cannot place something relative to itself.');
  }
  // an anchor inside the moved range would be taken out with it
  const t = spot(rest, where, kind);
  const first = range[0]!;
  const delta = isItemKind(first.kind) ? t.indent - indentOf(first.text) : 0;
  if (delta !== 0) {
    for (const b of range) {
      b.text = shiftLines(b.text, delta);
      if (b.detail) b.detail = shiftLines(b.detail, delta);
    }
  }
  if (isItemKind(first.kind)) first.parent_id = t.parentId;
  rest.splice(t.pos, 0, ...range);
  blocks.splice(0, blocks.length, ...rest);
  return t;
}

function touchParent(ctx: OpContext, id: string | null): void {
  if (!id) return;
  const parent = ctx.doc.blocks.find((b) => b.id === id);
  if (parent && !parent._new) dirty(parent);
}

// ─── Building item text ─────────────────────────────────────────────────────

function itemLines(kind: ItemKind, text: string, indent: number, extras: { suggested?: unknown; ifNoAnswer?: unknown; check?: unknown; detail?: unknown; done: boolean }): { line: string; detail: string } {
  const pad = ' '.repeat(indent);
  const inner = `${pad}  `;
  const detail: string[] = [];
  if (kind === 'decision') {
    if (Array.isArray(extras.suggested) && extras.suggested.length) detail.push(`${inner}Suggested: ${extras.suggested.map((a) => oneLine(a, 'suggested answer')).join(' · ')}`);
    if (extras.ifNoAnswer !== undefined) detail.push(`${inner}If no answer: ${oneLine(extras.ifNoAnswer, 'ifNoAnswer')}`);
  }
  if (kind === 'checkpoint' && extras.check !== undefined) {
    const check = oneLine(extras.check, 'check');
    detail.push(`${inner}Check: ${check.includes('`') ? check : `\`${check}\``}`);
  }
  if (extras.detail !== undefined) {
    if (typeof extras.detail !== 'string') throw bad('"detail" must be a string.');
    for (const l of trimBlank(extras.detail).split('\n')) detail.push(l.trim() ? `${inner}${l.replace(/\s+$/, '')}` : '');
  }
  const plain = oneLine(text).replace(/^(?:\*\*|__)?(?:decide|decision|question)\s*:\s*(?:\*\*|__)?\s*/i, kind === 'decision' ? '' : '$&');
  const words = kind === 'decision' ? `Decide: ${plain}` : kind === 'checkpoint' ? `**${plain}**` : plain;
  return { line: `${pad}- [${extras.done ? 'x' : ' '}] ${words}`, detail: detail.join('\n') };
}

const trimBlank = (text: string): string => text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');

// ─── The ops ────────────────────────────────────────────────────────────────

function sub(ctx: OpContext, value: string): string {
  if (!value.includes('$')) return value;
  return value.replace(/\$([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const id = ctx.refs.get(name);
    if (!id) throw new OpError('not_found', `Unknown reference $${name}. A $name must be the "as" of an earlier add in this same batch (and that add must not have failed).`);
    return id;
  });
}

function cardArea(ctx: OpContext, area: unknown): string | null {
  if (area === null || area === undefined) return null;
  if (typeof area !== 'string') throw bad('"area" must be "plan:own" or "checkpoint:<checkpoint id>".');
  if (area === 'plan:own') return area;
  const m = /^checkpoint:(.+)$/.exec(area);
  if (!m) throw bad(`area must be "plan:own" or "checkpoint:<checkpoint id>", not "${area}".`);
  const cp = ctx.doc.blocks.find((b) => b.id === m[1]);
  if (!cp || cp.kind !== 'checkpoint') throw bad(`"${area}" is not a checkpoint on the plan. Ids: \`ctxspace plan\`.`);
  return area;
}

function cardStep(ctx: OpContext, step: unknown): string | null {
  if (step === null || step === undefined) return null;
  const b = ctx.doc.blocks.find((x) => x.id === step);
  if (!b || !isItemKind(b.kind)) throw bad(`step "${String(step)}" is not an item on the plan.`);
  return b.id;
}

// eslint-disable-next-line no-control-regex
const COMMIT_NODE = /^commit:[^\\/\u0000-\u001f\u007f]{1,200}:[0-9a-f]{7,64}(?:#[0-9]{1,3})?$/;
const DOCUMENT_NODE = /^document:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:#[0-9]{1,3})?$/;

/** A node of the Board: a card (by id, old uuid or prefix), a checkpoint, a document or a commit. Returns its canonical id. */
export function canonicalNode(db: DatabaseSync, doc: Doc | null, node: unknown): string {
  if (typeof node !== 'string' || !node) throw bad('A node is a card id, checkpoint:<id>, document:<uuid> or commit:<repo>:<sha>.');
  const cp = /^checkpoint:([a-z][0-9a-hjkmnp-tv-z]{5})(#[0-9]{1,3})?$/.exec(node);
  if (cp) {
    const exists = doc ? doc.blocks.some((b) => b.id === cp[1] && b.kind === 'checkpoint') : !!db.prepare("SELECT 1 FROM blocks WHERE id = ? AND kind = 'checkpoint'").get(cp[1]!);
    if (!exists) throw bad(`No checkpoint ${cp[1]} on the plan. Ids: \`ctxspace plan\`.`);
    return node;
  }
  if (COMMIT_NODE.test(node) || DOCUMENT_NODE.test(node)) return node;
  const found = findCard(db, node);
  if (found && 'ambiguous' in found) throw new OpError('ambiguous', `"${node}" matches ${found.ambiguous} cards; use more characters.`);
  if (found) return found.row.id as string;
  throw new OpError('not_found', `No card or node "${node}". A node is a card id, checkpoint:<id>, document:<uuid> or commit:<repo>:<sha>.`);
}

function tickOp(ctx: OpContext, op: Op, done: boolean): void {
  const b = block(ctx, op.id, ITEM_KINDS);
  checkRev(ctx, op, b.id, b._rev0, reads(b));
  if (b.kind === 'decision' && done) throw bad(`${b.id} is a decision: answer it with {"op":"answer","id":"${b.id}","text":"..."} (that ticks it).`);
  if (b.kind === 'decision' && !done) {
    // Reopening a decision takes its answer away with the tick: an open question with an answer line would contradict itself.
    const all = b.detail ? b.detail.split('\n') : [];
    const answers = new Set(fieldLines(b.detail).filter((f) => f.name === 'answer').map((f) => f.index));
    const lines = all.filter((_l, i) => !answers.has(i));
    if (!b.done && lines.length === all.length) { ctx.log.push(`untick ${b.id} (already open)`); return; }
    b.detail = trimBlank(lines.join('\n'));
    b.done = false;
    b.text = b.text.replace(/\[[ xX]\]/, '[ ]');
    dirty(b);
    ctx.log.push(`reopen ${b.id} "${clip(b.name ?? '', 50)}"`);
    return;
  }
  if (b.done === done) { ctx.log.push(`${done ? 'tick' : 'untick'} ${b.id} (already ${done ? 'done' : 'open'})`); return; }
  if (done) b._ticked = true; // an open checkpoint was ticked in this batch, even if an untick came first
  b.done = done;
  b.text = b.text.replace(/\[[ xX]\]/, done ? '[x]' : '[ ]');
  dirty(b);
  ctx.log.push(`${done ? 'tick' : 'untick'} ${b.id} "${clip(b.name ?? '', 50)}"`);
}

type OpFn = (ctx: OpContext, op: Op) => void;

export const OPS: Record<string, OpFn> = {
  add(ctx, op) {
    const kind = op.kind as BlockKind;
    if (!(['checkpoint', 'step', 'decision', 'prose', 'heading'] as string[]).includes(kind as string)) throw bad(`add needs "kind": checkpoint, step, decision, prose or heading (got ${JSON.stringify(op.kind)}).`);
    if (op.level !== undefined && (!Number.isInteger(op.level) || (op.level as number) < 1 || (op.level as number) > 6)) throw bad('"level" is a heading level from 1 to 6.');
    const where: Where = { under: op.under, after: op.after, before: op.before, in: op.in, first: op.first };
    let b: DocBlock;
    const base = { parent_id: null, ord: 0, section_id: null, checkpoint_id: null, rev: 0, created_at: ctx.at, created_by: ctx.by, updated_at: ctx.at, updated_by: ctx.by, _before: null, _rev0: 0, _new: true, _dirty: false, _moved: true } as const;
    const id = newId(ctx.db, kind === 'prose' || kind === 'heading' || isItemKind(kind) ? (kind as 'prose') : 'step', ctx.taken);
    if (kind === 'prose' || kind === 'heading') {
      if (typeof op.text !== 'string' || !op.text.trim()) throw bad('"text" is empty.');
      if (op.text.length > LIMITS.textBlock) throw bad(`"text" is longer than ${LIMITS.textBlock} characters.`);
      const text = kind === 'heading' ? `${'#'.repeat((op.level as number | undefined) ?? 2)} ${oneLine(op.text)}` : op.text.replace(/\n+$/, '');
      b = { ...base, id, kind, text, name: kind === 'heading' ? oneLine(op.text) : null, detail: '', done: false };
    } else {
      if (kind === 'decision' && op.done === true) throw bad('A decision is answered, not added as done: add it open, then {"op":"answer",...}.');
      const probe = spot(ctx.doc.blocks, where, kind);
      const { line, detail } = itemLines(kind, op.text as string, probe.indent, { suggested: op.suggested, ifNoAnswer: op.ifNoAnswer, check: op.check, detail: op.detail, done: op.done === true });
      b = { ...base, id, kind, text: line, name: itemName(kind, line), detail, done: op.done === true };
    }
    const t = placeRange(ctx, [b], where, kind);
    if (isItemKind(kind)) b.parent_id = t.parentId;
    touchParent(ctx, t.parentId);
    if (op.as !== undefined) {
      if (typeof op.as !== 'string' || !/^[A-Za-z0-9_]+$/.test(op.as)) throw bad('"as" is a plain name: letters, digits and _.');
      if (ctx.refs.has(op.as)) throw bad(`"as": "${op.as}" is used twice.`);
      ctx.refs.set(op.as, id);
    }
    ctx.log.push(`add ${kind} ${id} "${clip(b.name ?? b.text, 60)}"${t.parentId ? ` under ${t.parentId}` : ''}`);
    ctx.newIds.push(id);
  },

  reword(ctx, op) {
    const b = block(ctx, op.id, ['checkpoint', 'step', 'decision', 'heading']);
    if (op.rev === undefined && !isNewInBatch(op, b)) {
      throw new OpError('rev_required', `reword replaces the WHOLE line of ${b.id} and needs its "rev" (now ${b._rev0}; \`ctxspace plan ${b.id}\` shows it), so a change someone made since is not lost. To change only part of the line use {"op":"edit","id":"${b.id}","find":"old words","replace":"new words"}. The line now reads: ${reads(b)}`, { id: b.id, currentRev: b._rev0 });
    }
    checkRev(ctx, op, b.id, b._rev0, reads(b));
    const text = oneLine(op.text);
    if (b.kind === 'heading') {
      const m = /^(#{1,6})\s/.exec(b.text)!;
      b.text = `${m[1]} ${text}`;
      b.name = text;
    } else {
      const words = wordsOf(b.text);
      const head = b.text.slice(0, b.text.length - words.length);
      let next: string;
      if (b.kind === 'checkpoint') next = /^(\*\*|__).+\1$/.test(words.trim()) ? `**${text}**` : text;
      else if (b.kind === 'decision') {
        const prefix = /^(?:\*\*|__)?(?:decide|decision|question)\s*:\s*(?:\*\*|__)?\s*/i.exec(words)?.[0] ?? 'Decide: ';
        const suffix = /(\*\*|__)$/.test(words.trim()) && /^(\*\*|__)/.test(words) ? /(\*\*|__)$/.exec(words.trim())![0] : '';
        next = `${prefix}${text.replace(/^(?:decide|decision|question)\s*:\s*/i, '')}${suffix}`;
      } else next = text;
      b.text = head + next;
      b.name = itemName(b.kind as ItemKind, b.text);
    }
    dirty(b);
    ctx.log.push(`reword ${b.id} -> "${clip(b.name ?? '', 130)}"`);
  },

  edit(ctx, op) {
    const b = block(ctx, op.id);
    checkRev(ctx, op, b.id, b._rev0, reads(b));
    if (typeof op.find !== 'string' || !op.find) throw bad('edit needs "find": the exact words to change.');
    if (typeof op.replace !== 'string') throw bad('edit needs "replace": the new words (use "" to delete the found words).');
    if (op.in !== undefined && op.in !== 'line' && op.in !== 'detail') throw bad('"in" is "line" (default) or "detail".');
    const inDetail = op.in === 'detail';
    if (inDetail && !isItemKind(b.kind)) throw bad(`${b.id} is a ${b.kind}: it has no detail lines. Use block.set for its text.`);
    let hay: string;
    let head = '';
    if (inDetail) hay = b.detail;
    else if (isItemKind(b.kind)) { const w = wordsOf(b.text); head = b.text.slice(0, b.text.length - w.length); hay = w; }
    else hay = b.text;
    const parts = hay.split(op.find);
    const current = inDetail ? `detail of ${b.id}:\n${b.detail || '(empty)'}` : `line of ${b.id}: ${clip(hay, 600)}`;
    if (parts.length === 1) throw new OpError('not_found', `edit: "${clip(op.find, 80)}" is not in the ${inDetail ? 'detail' : 'line'} of ${b.id}, so nothing was changed. Current ${current} (rev ${b._rev0}).`, { id: b.id, currentRev: b._rev0 });
    if (parts.length > 2) throw bad(`edit: "${clip(op.find, 80)}" appears ${parts.length - 1} times in ${b.id}; give more of the surrounding words so it matches once. Current ${current} (rev ${b._rev0}).`);
    const replaced = hay.replace(op.find, () => op.replace as string);
    if (inDetail) b.detail = trimBlank(replaced);
    else if (isItemKind(b.kind)) {
      if (/[\r\n]/.test(replaced) || !replaced.trim()) throw bad('The line must stay one non-empty line.');
      b.text = head + replaced;
      b.name = itemName(b.kind as ItemKind, b.text);
    } else {
      b.text = replaced;
      if (b.kind === 'heading') {
        const m = HEADING.exec(b.text);
        if (!m) throw bad('A heading must read "## words".');
        b.name = m[2]!.trim();
      }
    }
    dirty(b);
    ctx.log.push(`edit ${b.id}: "${clip(op.find, 40)}" -> "${clip(op.replace, 40)}"`);
  },

  detail(ctx, op) {
    const b = block(ctx, op.id, ITEM_KINDS);
    needRev(ctx, op, b, 'detail replaces ALL the lines under the item, so a change someone made since must not be lost. To change part of it use "edit" with "in": "detail".');
    if (typeof op.text !== 'string') throw bad('"text" is the lines to put under the item (use "" to clear).');
    if (op.text.length > LIMITS.detail) throw bad(`"text" is longer than ${LIMITS.detail} characters.`);
    const inner = ' '.repeat(indentOf(b.text) + 2);
    b.detail = trimBlank(op.text).split('\n').map((l) => (l.trim() ? inner + l.replace(/\s+$/, '') : '')).join('\n').replace(/^\s*$/, '');
    dirty(b);
    ctx.log.push(`detail ${b.id} (${b.detail ? b.detail.split('\n').length : 0} lines)`);
  },

  move(ctx, op) {
    const b = block(ctx, op.id);
    checkRev(ctx, op, b.id, b._rev0, reads(b));
    const blocks = ctx.doc.blocks;
    const i = blocks.indexOf(b);
    const range = blocks.slice(i, rangeEnd(blocks, i) + 1);
    const oldParent = b.parent_id;
    const t = placeRange(ctx, range, { under: op.under, after: op.after, before: op.before, in: op.in, first: op.first }, b.kind);
    for (const x of range) { dirty(x); x._moved = true; }
    touchParent(ctx, oldParent);
    touchParent(ctx, t.parentId);
    ctx.log.push(`move ${b.id}${range.length > 1 ? ` (+${range.length - 1} nested)` : ''} ${t.parentId ? `under ${t.parentId}` : 'to the top level'}`);
  },

  tick(ctx, op) { tickOp(ctx, op, true); },
  untick(ctx, op) { tickOp(ctx, op, false); },

  remove(ctx, op) {
    const b = block(ctx, op.id);
    needRev(ctx, op, b, 'remove deletes the item and cannot see what changed since you read it.');
    const blocks = ctx.doc.blocks;
    const i = blocks.indexOf(b);
    const range = blocks.slice(i, rangeEnd(blocks, i) + 1);
    const nested = range.filter((x) => x !== b && isItemKind(x.kind));
    if (nested.length && op.cascade !== true) {
      throw bad(`${b.id} has ${nested.length} item(s) nested under it (${nested.slice(0, 3).map((x) => x.id).join(', ')}${nested.length > 3 ? ', ...' : ''}). Remove or move them first, or pass "cascade": true to remove them all.`);
    }
    for (const x of range) {
      if (x.kind === 'checkpoint') {
        for (const c of ctx.db.prepare('SELECT id FROM cards WHERE area = ?').all(`checkpoint:${x.id}`) as Array<{ id: string }>) {
          ctx.rec.capture('cards', c.id);
          ctx.db.prepare("UPDATE cards SET area = 'plan:own', rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?").run(ctx.by, ctx.at, c.id);
        }
        const node = `checkpoint:${x.id}`;
        for (const l of ctx.db.prepare('SELECT id FROM links WHERE from_node = ? OR to_node = ? OR from_node LIKE ? OR to_node LIKE ?').all(node, node, `${node}#%`, `${node}#%`) as Array<{ id: string }>) {
          ctx.rec.capture('links', l.id);
          ctx.db.prepare('DELETE FROM links WHERE id = ?').run(l.id);
        }
        for (const p of ctx.db.prepare('SELECT node_id FROM positions WHERE node_id = ? OR node_id LIKE ?').all(node, `${node}#%`) as Array<{ node_id: string }>) {
          ctx.rec.capture('positions', p.node_id);
          ctx.db.prepare('DELETE FROM positions WHERE node_id = ?').run(p.node_id);
        }
      }
      if (isItemKind(x.kind)) {
        for (const c of ctx.db.prepare('SELECT id FROM cards WHERE step_id = ?').all(x.id) as Array<{ id: string }>) {
          ctx.rec.capture('cards', c.id);
          ctx.db.prepare('UPDATE cards SET step_id = NULL, rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?').run(ctx.by, ctx.at, c.id);
        }
      }
    }
    ctx.doc.removed.push(...range.filter((x) => !x._new));
    ctx.doc.blocks.splice(0, blocks.length, ...blocks.filter((x) => !range.includes(x)));
    touchParent(ctx, b.parent_id);
    ctx.log.push(`remove ${b.id} "${clip(b.name ?? b.text, 50)}"${range.length > 1 ? ` (+${range.length - 1} blocks)` : ''}`);
  },

  answer(ctx, op) {
    const b = block(ctx, op.id, ['decision']);
    checkRev(ctx, op, b.id, b._rev0, reads(b));
    const words = oneLine(op.answer ?? op.text, 'text');
    const inner = ' '.repeat(indentOf(b.text) + 2);
    const lines = b.detail ? b.detail.split('\n') : [];
    const at = fieldLines(b.detail).find((f) => f.name === 'answer')?.index ?? -1;
    if (at >= 0) lines[at] = `${/^\s*/.exec(lines[at]!)![0]}Answer: ${words}`;
    else {
      let last = -1;
      lines.forEach((l, k) => { if (l.trim()) last = k; });
      lines.splice(last + 1, 0, `${inner}Answer: ${words}`);
    }
    b.detail = lines.join('\n');
    b.done = true;
    b.text = b.text.replace(/\[[ xX]\]/, '[x]');
    b._answered = true;
    dirty(b);
    ctx.log.push(`answer ${b.id}: "${clip(words, 50)}"`);
  },

  'block.set'(ctx, op) {
    const b = block(ctx, op.id, ['prose', 'heading']);
    needRev(ctx, op, b, 'block.set replaces the whole block.');
    if (typeof op.text !== 'string' || !op.text.trim()) throw bad('"text" is empty. To delete a block use remove.');
    if (op.text.length > LIMITS.textBlock) throw bad(`"text" is longer than ${LIMITS.textBlock} characters.`);
    if (b.kind === 'heading') b.text = op.text.replace(/\n+$/, '');
    else {
      // the blank lines around a block keep it apart from its neighbours: keep them unless the new text brings its own
      const lead = op.text.startsWith('\n') ? '' : /^\n*/.exec(b.text)![0];
      const trail = op.text.endsWith('\n') ? '' : /\n*$/.exec(b.text)![0];
      b.text = `${lead}${op.text}${trail}`;
    }
    if (b.kind === 'heading') {
      const m = HEADING.exec(b.text);
      if (!m || b.text.includes('\n')) throw bad('A heading must be one line reading "## words".');
      b.name = m[2]!.trim();
    }
    dirty(b);
    ctx.log.push(`block.set ${b.id} (${b.text.split('\n').length} lines)`);
  },

  'card.add'(ctx, op) {
    const kind = (op.kind ?? (op.path ? 'file' : 'note')) as string;
    if (kind !== 'note' && kind !== 'file') throw bad('card kind is note or file.');
    const title = oneLine(op.title, 'title', LIMITS.title);
    if (kind === 'file' && (typeof op.path !== 'string' || !op.path)) throw bad('A file card needs "path".');
    const count = (ctx.db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n;
    if (count >= LIMITS.cards) throw new OpError('limit', `The board already has ${LIMITS.cards} cards, the most it keeps. Remove or archive some first.`);
    const fields = cardFields(op);
    const step = cardStep(ctx, op.step);
    const area = cardArea(ctx, op.area);
    const id = newId(ctx.db, 'card', ctx.taken);
    ctx.rec.captureWith('cards', id, null);
    ctx.db.prepare('INSERT INTO cards(id, kind, title, body, path, description, area, step_id, about, look, look_at, pinned, archived, by, at, updated_by, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)')
      .run(id, kind, title, fields.body ?? null, fields.path ?? null, fields.description ?? null, area, step, fields.about ?? null, fields.look ?? null, fields.look ? ctx.at : null, op.pinned ? 1 : 0, ctx.by, ctx.at, ctx.by, ctx.at);
    markUsed(ctx.db, id);
    if (op.as !== undefined) {
      if (typeof op.as !== 'string' || !/^[A-Za-z0-9_]+$/.test(op.as)) throw bad('"as" is a plain name: letters, digits and _.');
      if (ctx.refs.has(op.as)) throw bad(`"as": "${op.as}" is used twice.`);
      ctx.refs.set(op.as, id);
    }
    ctx.log.push(`card.add ${id} "${clip(title, 50)}"`);
    ctx.newIds.push(id);
  },

  'card.update'(ctx, op) {
    const row = resolveCard(ctx, op.id);
    const id = row.id as string;
    checkRev(ctx, op, id, Number(row.rev), clip(String(row.title), 200));
    const sets: Record<string, unknown> = {};
    const fields = cardFields(op);
    for (const f of ['body', 'path', 'description', 'about', 'look'] as const) if (f in fields) sets[f] = fields[f] ?? null;
    if (op.title !== undefined) sets.title = oneLine(op.title, 'title', LIMITS.title);
    if (op.area !== undefined) sets.area = cardArea(ctx, op.area);
    if (op.step !== undefined) sets.step_id = cardStep(ctx, op.step);
    if ('look' in sets) sets.look_at = sets.look ? ctx.at : null;
    for (const f of ['pinned', 'archived'] as const) if (op[f] !== undefined) sets[f] = op[f] ? 1 : 0;
    const columns = Object.keys(sets);
    if (!columns.length) throw bad('Give at least one field to change.');
    ctx.rec.capture('cards', id);
    ctx.db.prepare(`UPDATE cards SET ${columns.map((c) => `${c} = ?`).join(', ')}, rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?`)
      .run(...columns.map((c) => sets[c] as string | number | null), ctx.by, ctx.at, id);
    ctx.log.push(`card.update ${id} (${columns.join(', ')})`);
  },

  'card.remove'(ctx, op) {
    const row = resolveCard(ctx, op.id);
    const id = row.id as string;
    checkRev(ctx, op, id, Number(row.rev), clip(String(row.title), 200));
    ctx.rec.capture('cards', id);
    for (const l of ctx.db.prepare('SELECT id FROM links WHERE from_node = ? OR to_node = ?').all(id, id) as Array<{ id: string }>) {
      ctx.rec.capture('links', l.id);
      ctx.db.prepare('DELETE FROM links WHERE id = ?').run(l.id);
    }
    ctx.rec.capture('positions', id);
    ctx.db.prepare('DELETE FROM positions WHERE node_id = ?').run(id);
    ctx.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    ctx.log.push(`card.remove ${id}`);
  },

  link(ctx, op) {
    const from = canonicalNode(ctx.db, ctx.doc, op.from);
    const to = canonicalNode(ctx.db, ctx.doc, op.to);
    if (from === to) throw bad('A link needs two different nodes.');
    if (ctx.db.prepare('SELECT 1 FROM links WHERE from_node = ? AND to_node = ?').get(from, to)) { ctx.log.push(`link ${from} -> ${to} (already there)`); return; }
    const count = (ctx.db.prepare('SELECT count(*) AS n FROM links').get() as { n: number }).n;
    if (count >= LIMITS.links) throw new OpError('limit', `The board already has ${LIMITS.links} links, the most it keeps.`);
    const label = op.label === undefined || op.label === null ? null : oneLine(op.label, 'label', LIMITS.label);
    const id = randomUUID();
    ctx.rec.captureWith('links', id, null);
    ctx.db.prepare('INSERT INTO links(id, from_node, to_node, label, by, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, from, to, label, ctx.by, ctx.at);
    ctx.log.push(`link ${from} -> ${to}`);
  },

  unlink(ctx, op) {
    let rows: Array<{ id: string }>;
    if (op.id !== undefined) rows = ctx.db.prepare('SELECT id FROM links WHERE id = ?').all(op.id as string) as Array<{ id: string }>;
    else {
      if (op.from === undefined || op.to === undefined) throw bad('unlink needs "from" and "to", or "id".');
      const from = canonicalNode(ctx.db, ctx.doc, op.from);
      const to = canonicalNode(ctx.db, ctx.doc, op.to);
      rows = ctx.db.prepare('SELECT id FROM links WHERE from_node = ? AND to_node = ?').all(from, to) as Array<{ id: string }>;
    }
    for (const l of rows) {
      ctx.rec.capture('links', l.id);
      ctx.db.prepare('DELETE FROM links WHERE id = ?').run(l.id);
    }
    ctx.log.push(`unlink ${String(op.id ?? `${String(op.from)} -> ${String(op.to)}`)}${rows.length ? '' : ' (none there)'}`);
  },

  place(ctx, op) {
    if (op.x === null && op.y === null) {
      // x and y of null forget where the node was put, so the places of nodes that have gone do not pile up to the limit
      let node: string;
      try { node = canonicalNode(ctx.db, ctx.doc, op.node); } catch (error) {
        if (typeof op.node !== 'string' || !op.node) throw error;
        node = op.node; // a node that is gone may still have a place to forget
      }
      ctx.rec.capture('positions', node);
      ctx.db.prepare('DELETE FROM positions WHERE node_id = ?').run(node);
      ctx.log.push(`forget the place of ${node}`);
      return;
    }
    if (typeof op.x !== 'number' || typeof op.y !== 'number' || !Number.isFinite(op.x) || !Number.isFinite(op.y)) throw bad('place needs "node" and numeric "x" and "y".');
    if (Math.abs(op.x) > LIMITS.coordinate || Math.abs(op.y) > LIMITS.coordinate) throw bad(`x and y stay between -${LIMITS.coordinate} and ${LIMITS.coordinate}.`);
    const node = canonicalNode(ctx.db, ctx.doc, op.node);
    const exists = ctx.db.prepare('SELECT 1 FROM positions WHERE node_id = ?').get(node);
    if (!exists && (ctx.db.prepare('SELECT count(*) AS n FROM positions').get() as { n: number }).n >= LIMITS.positions) {
      throw new OpError('limit', `The board already keeps ${LIMITS.positions} positions, the most it keeps.`);
    }
    ctx.rec.capture('positions', node);
    ctx.db.prepare('INSERT INTO positions(node_id, x, y) VALUES (?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET x = excluded.x, y = excluded.y').run(node, op.x, op.y);
    ctx.log.push(`place ${node} at ${op.x},${op.y}`);
  },

  now(ctx, op) {
    ctx.rec.capture('now', 1);
    if (op.id === null) {
      ctx.db.prepare('DELETE FROM now WHERE id = 1').run();
      ctx.log.push('now: no step is being worked on');
      return;
    }
    const b = block(ctx, op.id, ['step']);
    if (b.done) throw bad(`${b.id} is already done: "${clip(b.name ?? '', 80)}". Only an open step can be worked on now.`);
    const all = ctx.doc.blocks;
    const byId = new Map(all.map((x) => [x.id, x]));
    if (all.some((x) => x.kind === 'step' && !x.done && isDescendant(byId, x, b))) {
      throw bad(`${b.id} "${clip(b.name ?? '', 80)}" is a heading for open steps under it: name one of those.`);
    }
    ctx.db.prepare('INSERT INTO now(id, item_id, by, at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET item_id = excluded.item_id, by = excluded.by, at = excluded.at').run(b.id, ctx.by, ctx.at);
    ctx.log.push(`now ${b.id} "${clip(b.name ?? '', 60)}"`);
  },
};

function cardFields(op: Op): { body?: string | null; path?: string | null; description?: string | null; about?: string | null; look?: string | null } {
  const out: { body?: string | null; path?: string | null; description?: string | null; about?: string | null; look?: string | null } = {};
  const text = (name: 'body' | 'path' | 'description' | 'look', max: number) => {
    if (!(name in op)) return;
    const v = op[name];
    if (v === null) { out[name] = null; return; }
    if (typeof v !== 'string') throw bad(`"${name}" must be a string.`);
    if (v.length > max) throw bad(`"${name}" is ${v.length} characters; keep it to ${max} or fewer.`);
    out[name] = name === 'look' ? v.replace(/\s+/g, ' ').trim() || null : v;
  };
  text('body', LIMITS.body);
  text('path', LIMITS.path);
  text('description', LIMITS.description);
  text('look', LIMITS.look);
  if ('about' in op) {
    if (op.about === null) out.about = null;
    else if (typeof op.about !== 'string' || !COMMIT_NODE.test(op.about)) throw bad('"about" is a commit node: commit:<repo>:<sha>.');
    else out.about = op.about;
  }
  return out;
}

/** Runs one op against the context after validating its fields and substituting `$name` references. */
export function runOp(ctx: OpContext, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || typeof (raw as Op).op !== 'string') throw bad('Each op is an object with an "op" name, e.g. {"op":"tick","id":"s7k2q"}.');
  const op = raw as Op;
  const fn = OPS[op.op];
  const fields = OP_FIELDS[op.op];
  if (!fn || !fields) throw bad(`Unknown op "${op.op}". Ops: ${Object.keys(OP_FIELDS).join(', ')}.`);
  for (const key of Object.keys(op)) {
    if (key !== 'op' && !fields.includes(key)) throw bad(`Op "${op.op}" has no field "${key}"${FIELD_HINTS[key] ? ` (did you mean "${FIELD_HINTS[key]}"?)` : ''}. Fields: ${fields.join(', ')}.`);
  }
  const resolved: Op = { ...op };
  if (typeof op.id === 'string' && op.id.startsWith('$')) resolved.__ref = true;
  for (const key of REF_KEYS) {
    const v = resolved[key];
    if (typeof v === 'string') resolved[key] = sub(ctx, v);
  }
  fn(ctx, resolved);
}

// ─── Derived facts the guards need ──────────────────────────────────────────

/** A checkpoint's effective check, from its detail lines. */
export function effectiveCheck(detail: string): { kind: 'none' | 'workspace' | 'command'; command: string | null } {
  const fields = parseDetail('checkpoint', detail);
  if (!fields.hasCheck) return { kind: 'none', command: null };
  return fields.check === null ? { kind: 'workspace', command: null } : { kind: 'command', command: fields.check };
}

