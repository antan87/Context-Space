import type { SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { PlanFileError } from '../plan-file.js';
import { setMeta, type WorkspaceDb } from './connection.js';
import { applyBatch } from './batch.js';
import { byteDigest, DATA_EXPORT, findExport, PLAN_EXPORT, planHeader, readDataExport, type ExportFile, type ExportRecord } from './export-records.js';
import { ID_PATTERN, markUsed, newId } from './ids.js';
import { LIMITS, OpError, type OpContext } from './ops.js';
import { exportPlan } from './plan-io.js';
import { isItemKind, parseDetail, parsePlanText, renderBody, structureProblems, TASK, type BlockKind, type ParsedPlan } from './plan-text.js';
import { exportPortableSnapshot } from './snapshot.js';
import { getRevision } from './reads.js';
import { deletedRowRevision, type DocBlock } from './store.js';

const nullable = z.string().nullable();
const id = z.string().regex(ID_PATTERN);
const blockSchema = z.object({
  id, kind: z.enum(['checkpoint', 'step', 'decision', 'heading', 'prose']),
  parent_id: id.nullable(), text: z.string(), name: nullable, detail: z.string(), done: z.boolean(),
});
const cardSchema = z.object({
  id: id.regex(/^k/), legacy_id: nullable, kind: z.enum(['note', 'file']), title: z.string(), body: nullable, path: nullable,
  description: nullable, area: nullable, step_id: id.nullable(), about: nullable, look: nullable, look_at: nullable,
  pinned: z.boolean(), archived: z.boolean(), by: z.string(), at: z.string(), updated_by: z.string(), updated_at: z.string(),
});
const linkSchema = z.object({
  id: z.string().min(1), from_node: z.string().min(1), to_node: z.string().min(1), label: nullable, by: z.string(), at: z.string(),
});
const decisionSchema = z.object({
  item_id: id, suggested: z.array(z.string()), if_no_answer: nullable, answer: nullable, answered_by: nullable, answered_at: nullable,
});
const snapshotSchema = z.object({
  plan: z.object({ eol: z.enum(['lf', 'crlf']), trailing_newline: z.boolean() }),
  blocks: z.array(blockSchema), cards: z.array(cardSchema).max(LIMITS.cards), links: z.array(linkSchema).max(LIMITS.links),
  decisions: z.array(decisionSchema),
  checks: z.array(z.object({ item_id: id, kind: z.enum(['none', 'workspace', 'command']), command: nullable, outcome: nullable })),
}).strict();

type Snapshot = z.output<typeof snapshotSchema>;
type Block = z.output<typeof blockSchema>;
type PlanFormat = Snapshot['plan'];
type BlockFields = Pick<Block, 'id' | 'kind' | 'parent_id' | 'text' | 'detail'> & { mark: string };
type Card = Snapshot['cards'][number];
type Link = Snapshot['links'][number];
type Answer = Pick<Snapshot['decisions'][number], 'answer' | 'answered_by' | 'answered_at'> & { id: string };

export interface DraftChange {
  kind: 'add' | 'remove' | 'reword' | 'edit' | 'move';
  label: string;
  before?: string;
  after?: string;
  conflict: boolean;
  confirm: boolean;
}
export interface DraftPreview {
  digest: string;
  revision: number;
  dbId: string;
  token: string;
  baseKnown: boolean;
  changes: DraftChange[];
  matched: string[];
}
interface MergePlan {
  preview: DraftPreview;
  blocks: BlockFields[];
  format: PlanFormat;
  cards?: Card[];
  links?: Link[];
  answers?: Answer[];
  incomingChecks?: Map<string, { hasCheck: boolean; check: string | null }>;
  reusable: ReadonlySet<string>;
}

const invalid = (message: string) => new PlanFileError(message, 'invalid');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const words = (text: string) => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
const labelOf = (b: BlockFields) => b.text.trim() || 'Blank lines';
const markOf = (text: string) => TASK.exec(text)?.[2] ?? '';
const neutral = (text: string) => text.replace(/^(\s*[-*+]\s+\[)[ xX]\]/, '$1 ]');
const taskText = (b: BlockFields) => b.mark ? b.text.replace(/^(\s*[-*+]\s+\[) \]/, `$1${b.mark}]`) : b.text;
const fieldsOf = ({ id, kind, parent_id, text, detail }: Block): BlockFields => ({
  id, kind, parent_id, text: isItemKind(kind) ? neutral(text) : text, detail, mark: isItemKind(kind) ? markOf(text) : '',
});

function unique<T extends { id: string }>(rows: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (result.has(row.id)) throw invalid(`The draft uses the same id more than once: ${row.id}. Every id names one entry.`);
    result.set(row.id, row);
  }
  return result;
}

function markdownBlocks(parsed: ParsedPlan, source: BlockFields[], matched?: string[]): BlockFields[] {
  const used = new Set<string>();
  for (const block of parsed.blocks) {
    if (!block.id) continue;
    if (used.has(block.id)) throw invalid(`The plan text uses the same id more than once: ${block.id}. Every id names one line.`);
    used.add(block.id);
  }
  const result = parsed.blocks.map((block, index) => {
    let id = block.id;
    if (!id) {
      const line = isItemKind(block.kind) ? neutral(block.text) : block.text;
      const key = block.kind === 'prose' ? line : words(line);
      const match = source.filter((row) => row.kind === block.kind && !used.has(row.id)
        && (block.kind === 'prose' ? row.text === key : words(row.text) === key));
      const occurrences = parsed.blocks.filter((b) => !b.id && b.kind === block.kind
        && (b.kind === 'prose' ? b.text === key : words(isItemKind(b.kind) ? neutral(b.text) : b.text) === key));
      if (match.length === 1 && occurrences.length === 1) {
        id = match[0]!.id;
        if (block.kind !== 'prose') matched?.push(`${block.name ?? block.text} (${id})`);
      }
    }
    id ??= `new-${index}`;
    used.add(id);
    return fieldsOf({ ...block, id, parent_id: null });
  });
  // Prose cannot carry ids. Match an edited prose block inside the same gap between named blocks.
  const gaps = (rows: BlockFields[]) => {
    const groups = new Map<string, BlockFields[]>();
    let previous = '';
    for (const row of rows) {
      if (row.kind !== 'prose') { previous = row.id; continue; }
      const group = groups.get(previous) ?? [];
      group.push(row);
      groups.set(previous, group);
    }
    return groups;
  };
  const sourceGaps = gaps(source);
  for (const [anchor, group] of gaps(result)) {
    const missing = group.filter((row) => row.id.startsWith('new-'));
    const candidates = (sourceGaps.get(anchor) ?? []).filter((row) => !used.has(row.id));
    if (missing.length !== candidates.length) continue;
    missing.forEach((row, index) => { row.id = candidates[index]!.id; used.add(row.id); });
  }
  result.forEach((row, index) => { row.parent_id = result[parsed.blocks[index]!.parentIdx]?.id ?? null; });
  return result;
}

function dataOf(text: string) {
  const data = readDataExport(text);
  const parsed = snapshotSchema.safeParse(data?.content);
  if (!data || !parsed.success) throw invalid('The saved Git snapshot could not be read. Its original file is kept with the draft.');
  const snapshot = parsed.data;
  for (const rows of [snapshot.blocks, snapshot.cards, snapshot.links]) unique(rows as Array<{ id: string }>);
  unique(snapshot.decisions.map((row) => ({ id: row.item_id })));
  unique(snapshot.checks.map((row) => ({ id: row.item_id })));
  return { ...data, snapshot };
}

function snapshotPlan(snapshot: Snapshot) {
  const eol = snapshot.plan.eol === 'crlf' ? '\r\n' : '\n';
  return renderBody(snapshot.blocks, snapshot.plan.trailing_newline, true, eol);
}

/** Suppress a PLAN.md only when it is the untouched plan accompanying this exact data export. */
export function matchesPulledPlan(plan: string, dataText: string): boolean {
  try {
    const data = dataOf(dataText);
    const header = planHeader(plan);
    if (!header || header.dbId !== data.header.dbId || header.revision > data.header.revision) return false;
    const body = snapshotPlan(data.snapshot);
    return header.digest === byteDigest(body).slice(0, 16) && plan.slice(plan.indexOf('\n') + 1) === body;
  } catch {
    return false;
  }
}

function mergeRows<T extends { id: string }>(
  base: T[], ours: T[], theirs: T[], changes: DraftChange[], baseKnown: boolean,
  describe: (row: T) => string, reworded: (before: T, after: T) => boolean = () => false,
): Map<string, T> {
  const baseById = unique(base);
  const live = unique(ours);
  const draft = unique(theirs);
  const merged = new Map(live);
  for (const id of new Set([...baseById.keys(), ...draft.keys()])) {
    const original = baseById.get(id);
    const edited = draft.get(id);
    const current = live.get(id);
    if (same(original, edited) || (baseKnown && same(current, edited))) continue;
    let conflict = !baseKnown;
    let next = edited;
    if (original && edited && current) {
      next = { ...current };
      for (const field of Object.keys(edited) as Array<keyof T>) {
        if (same(edited[field], original[field])) continue;
        if (!same(current[field], original[field]) && !same(current[field], edited[field])) conflict = true;
        next[field] = edited[field];
      }
    } else if (!same(current, original)) {
      conflict = true;
    }
    if (next) merged.set(id, next);
    else merged.delete(id);
    const kind = !next ? 'remove' : !current ? 'add' : reworded(current, next) ? 'reword' : 'edit';
    changes.push({
      kind, label: describe((next ?? current ?? original)!),
      before: current && describe(current), after: next && describe(next),
      conflict, confirm: conflict || kind === 'remove' || kind === 'reword',
    });
  }
  return merged;
}

function mergeOrder(base: BlockFields[], ours: BlockFields[], theirs: BlockFields[], merged: Map<string, BlockFields>, changes: DraftChange[], baseKnown: boolean): BlockFields[] {
  const ids = (rows: BlockFields[]) => rows.map((b) => b.id);
  const liveIds = new Set(ids(ours));
  const theirIds = new Set(ids(theirs));
  const shared = new Set(ids(base).filter((id) => theirIds.has(id) && liveIds.has(id) && merged.has(id)));
  const common = (rows: BlockFields[]) => ids(rows).filter((id) => shared.has(id));
  const [before, current, edited] = [common(base), common(ours), common(theirs)];
  const reorder = !same(before, edited) && !same(current, edited);
  if (reorder) {
    const conflict = !baseKnown || !same(before, current);
    const titles = (order: string[]) => order.map((id) => labelOf(merged.get(id)!)).join('\n');
    changes.push({ kind: 'move', label: 'Plan order', before: titles(current), after: titles(edited), conflict, confirm: conflict });
  }
  const survivesHere = (row: BlockFields) => merged.has(row.id) && merged.get(row.id)!.parent_id === row.parent_id;
  const primary = (reorder ? theirs : ours).filter(survivesHere);
  const secondary = reorder ? ours : theirs;
  const order = ids(primary);
  const placed = new Set(order);
  const belongsTo = (id: string, ancestor: string) => {
    let parent = merged.get(id)?.parent_id;
    for (let hops = 0; parent && hops < merged.size; hops += 1) {
      if (parent === ancestor) return true;
      parent = merged.get(parent)?.parent_id;
    }
    return false;
  };
  for (const [index, row] of secondary.entries()) {
    if (placed.has(row.id) || !survivesHere(row)) continue;
    const sibling = (candidate: BlockFields) => candidate.parent_id === row.parent_id
      && placed.has(candidate.id) && survivesHere(candidate);
    const before = secondary.slice(0, index).reverse().find(sibling);
    const after = secondary.slice(index + 1).find(sibling);
    // Keep the document flat. Free prose can sit between two logical siblings.
    let at: number;
    if (after && (!before || secondary[index + 1] === after)) at = order.indexOf(after.id);
    else if (before) {
      at = order.indexOf(before.id) + 1;
      while (at < order.length && belongsTo(order[at]!, before.id)) at += 1;
    } else if (row.parent_id && placed.has(row.parent_id)) at = order.indexOf(row.parent_id) + 1;
    else at = order.length;
    order.splice(at, 0, row.id);
    placed.add(row.id);
  }
  if (order.length !== merged.size) throw invalid('The merged plan has a missing parent. Its original text is still saved.');
  return order.map((id) => merged.get(id)!);
}

const blockDescription = (row: BlockFields) =>
  [taskText(row), row.detail, row.parent_id ? `Under ${row.parent_id}` : ''].filter(Boolean).join('\n');
const shown = (prefix: string, row: object) => `${prefix}\n${JSON.stringify(row, null, 2)}`;

export function buildDraftMerge(db: WorkspaceDb, file: ExportFile, digest: string, text: string, gitBase?: ExportRecord): MergePlan {
  const { revision, dbId } = getRevision(db);
  const current = dataOf(exportPortableSnapshot(db)).snapshot;
  const live = current.blocks.map(fieldsOf);
  const theirs = file === DATA_EXPORT ? dataOf(text) : undefined;
  const baseRecord = gitBase ?? findExport(db.sqlite, file, theirs ? theirs.base : planHeader(text));
  const baseKnown = Boolean(baseRecord);
  const baseData = theirs && baseRecord ? dataOf(baseRecord.text).snapshot : current;
  const matched: string[] = [];
  const baseMarkdown = !theirs && baseRecord ? parsePlanText(baseRecord.text) : undefined;
  const draftMarkdown = !theirs ? parsePlanText(text) : undefined;
  const base = baseMarkdown ? markdownBlocks(baseMarkdown, live) : baseData.blocks.map(fieldsOf);
  const incoming = theirs ? theirs.snapshot.blocks.map(fieldsOf) : markdownBlocks(draftMarkdown!, base, matched);
  const changes: DraftChange[] = [];
  const merged = mergeRows(base, live, incoming, changes, baseKnown, blockDescription, (a, b) => a.text !== b.text);
  const blocks = mergeOrder(base, live, incoming, merged, changes, baseKnown);
  const taken = new Set(blocks.map((row) => row.id));
  const newIds = new Map(blocks.filter((row) => row.id.startsWith('new-')).map((row) => [row.id, newId(db.sqlite, row.kind, taken)]));
  const structure = structureProblems(blocks.map((row) => ({
    ...row, id: newIds.get(row.id) ?? row.id, parent_id: row.parent_id ? newIds.get(row.parent_id) ?? row.parent_id : null,
    text: taskText(row), done: row.mark.toLowerCase() === 'x',
  })));
  if (structure.length) throw invalid(`The merged plan would not read back as intended: ${structure.join('; ')}. Its original text is still saved.`);
  const formatOf = (parsed: ParsedPlan): PlanFormat => ({
    eol: parsed.eol === '\r\n' ? 'crlf' : 'lf', trailing_newline: parsed.trailingNewline,
  });
  const formatRow = (format: PlanFormat) => [{ id: 'format', ...format }];
  const format = mergeRows(
    formatRow(baseMarkdown ? formatOf(baseMarkdown) : baseData.plan), formatRow(current.plan),
    formatRow(draftMarkdown ? formatOf(draftMarkdown) : theirs!.snapshot.plan), changes, baseKnown,
    (row) => `Line endings ${row.eol.toUpperCase()}, ${row.trailing_newline ? 'with' : 'without'} a final newline`,
  ).get('format')!;
  const preview = { digest, revision, dbId, baseKnown, changes, matched, token: '' };
  const result: MergePlan = { preview, blocks, format, reusable: new Set(baseKnown ? [...base, ...baseData.cards].map((row) => row.id) : []) };
  if (theirs) {
    result.incomingChecks = new Map(theirs.snapshot.blocks.filter((row) => row.kind === 'checkpoint' && row.done)
      .map((row) => [row.id, parseDetail('checkpoint', row.detail)]));
    result.cards = [...mergeRows(baseData.cards, current.cards, theirs.snapshot.cards, changes, baseKnown, (row) => shown(row.title, row), (a, b) => a.title !== b.title).values()];
    result.links = [...mergeRows(baseData.links, current.links, theirs.snapshot.links, changes, baseKnown, (row) => shown('Board link', row)).values()];
    const answers = (snap: Snapshot) => snap.decisions.filter((row) => row.answer !== null).map(({ item_id, answer, answered_by, answered_at }) => ({ id: item_id, answer, answered_by, answered_at }));
    result.answers = [...mergeRows(answers(baseData), answers(current), answers(theirs.snapshot), changes, baseKnown, (row) => shown('Decision answer', row)).values()];
  }
  preview.token = byteDigest(JSON.stringify({ digest, revision, dbId, base: baseRecord?.digest, changes, matched }));
  return result;
}

function editPlan(ctx: OpContext, merged: MergePlan): void {
  const { doc, db, at, by } = ctx;
  const current = unique(doc.blocks);
  const ids = new Map<string, string>();
  for (const row of merged.blocks) {
    if (row.id.startsWith('new-')) continue;
    if (!current.has(row.id) && (db.prepare('SELECT 1 FROM cards WHERE id = ? OR legacy_id = ?').get(row.id, row.id)
      || (!merged.reusable.has(row.id) && db.prepare('SELECT 1 FROM ids_used WHERE id = ?').get(row.id)))) {
      throw new OpError('invalid', `The draft uses id ${row.id} for a different entry. Remove that id comment and preview again.`);
    }
    ids.set(row.id, row.id);
    ctx.taken.add(row.id);
  }
  for (const row of merged.blocks) {
    if (!ids.has(row.id)) ids.set(row.id, newId(db, row.kind, ctx.taken));
  }

  const pending = merged.blocks.map((row): DocBlock => {
    const id = ids.get(row.id)!;
    const old = current.get(id);
    const parent_id = row.parent_id ? ids.get(row.parent_id) : null;
    if (parent_id === undefined || (old && old.kind !== row.kind)) {
      throw new OpError('bad_structure', `The draft changes the kind of ${id} or leaves it under a missing parent. Its original text is still saved.`);
    }
    const text = taskText(row);
    return {
      ...row, id, text, parent_id, done: row.mark.toLowerCase() === 'x',
      name: null, section_id: null, checkpoint_id: null, ord: old?.ord ?? 0,
      rev: old?.rev ?? 1, created_at: old?.created_at ?? at, created_by: old?.created_by ?? by,
      updated_at: old?.updated_at ?? at, updated_by: old?.updated_by ?? by,
      _before: old?._before ?? null, _rev0: old?._rev0 ?? 0, _new: !old, _moved: false, _dirty: false,
    };
  });
  const parsed = parsePlanText(renderBody(pending, merged.format.trailing_newline, true));
  const named = new Map(parsed.blocks.filter((row) => row.id).map((row) => [row.id!, row.name]));
  let last = -Infinity;
  for (const block of pending) {
    const old = current.get(block.id);
    block.name = named.get(block.id) ?? null;
    if (!old) { ctx.newIds.push(block.id); continue; }
    block._moved = old.ord <= last;
    if (!block._moved) last = old.ord;
    block._ticked = !old.done && block.done;
    block._dirty = block._moved || !same(fieldsOf(block), fieldsOf(old)) || block.name !== old.name;
  }
  const keep = new Set(ids.values());
  const removed = doc.blocks.filter((row) => !keep.has(row.id));
  detachRemoved(ctx, removed, merged.cards !== undefined);
  doc.blocks = pending;
  doc.removed = removed;
  setMeta(db, 'eol', merged.format.eol);
  setMeta(db, 'trailing_newline', merged.format.trailing_newline ? '1' : '0');
}

function detachRemoved(ctx: OpContext, removed: DocBlock[], importingData: boolean): void {
  const { db, rec, at, by } = ctx;
  for (const row of removed) {
    const area = `checkpoint:${row.id}`;
    const isCheckpoint = row.kind === 'checkpoint';
    const cards = db.prepare('SELECT id FROM cards WHERE step_id = ? OR area = ?').all(row.id, isCheckpoint ? area : null);
    for (const card of cards) rec.capture('cards', String(card.id));
    if (!importingData) {
      db.prepare("UPDATE cards SET area = CASE WHEN area = ? THEN 'plan:own' ELSE area END, step_id = CASE WHEN step_id = ? THEN NULL ELSE step_id END, rev = rev + 1, updated_by = ?, updated_at = ? WHERE area = ? OR step_id = ?")
        .run(isCheckpoint ? area : null, row.id, by, at, isCheckpoint ? area : null, row.id);
    }
    if (!isCheckpoint) continue;
    for (const p of db.prepare('SELECT node_id FROM positions WHERE node_id = ? OR node_id LIKE ?').all(area, `${area}#%`)) {
      rec.capture('positions', String(p.node_id));
      db.prepare('DELETE FROM positions WHERE node_id = ?').run(p.node_id!);
    }
    if (importingData) continue;
    for (const l of db.prepare('SELECT id FROM links WHERE from_node = ? OR to_node = ? OR from_node LIKE ? OR to_node LIKE ?').all(area, area, `${area}#%`, `${area}#%`)) {
      rec.capture('links', String(l.id));
      db.prepare('DELETE FROM links WHERE id = ?').run(l.id!);
    }
  }
}

function writeRows<T extends { id: string }>(ctx: OpContext, table: 'cards' | 'links', original: T[], target: T[]): void {
  const before = unique(original);
  const after = unique(target);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((id) => !same(before.get(id), after.get(id)));
  // Temporarily remove changed rows so link endpoints and legacy card ids can exchange unique values.
  const revisions = new Map<string, number>();
  for (const id of changed) {
    ctx.rec.capture(table, id);
    if (table === 'cards') {
      const row = ctx.db.prepare('SELECT rev FROM cards WHERE id = ?').get(id);
      revisions.set(id, Math.max(Number(row?.rev ?? 0), deletedRowRevision(ctx.db, id)));
    }
    ctx.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }
  for (const id of changed) {
    const row = after.get(id);
    if (!row) continue;
    const values = { ...row, ...(table === 'cards' ? { rev: (revisions.get(id) ?? 0) + 1 } : {}) };
    const columns = Object.keys(values);
    const bound = Object.values(values).map((value) => typeof value === 'boolean' ? Number(value) : value as SQLInputValue);
    ctx.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...bound);
    if (table === 'cards') markUsed(ctx.db, id);
  }
}

export function applyDraftMerge(db: WorkspaceDb, merged: MergePlan, by: string, handled: () => void, pulled = false, snapshotCompletion = pulled) {
  const { revision, dbId, changes } = merged.preview;
  const snapshot = merged.cards ? dataOf(exportPortableSnapshot(db)).snapshot : undefined;
  return applyBatch(db, { ops: [], ifRevision: revision, dbId }, {
    by, strictRevision: true, draft: {
      acceptsCompletedCheck: snapshotCompletion ? (block) => {
        const incoming = merged.incomingChecks?.get(block.id);
        const final = parseDetail('checkpoint', block.detail);
        return incoming?.hasCheck === true && final.hasCheck && incoming.check === final.check;
      } : undefined,
      edit(ctx) {
        editPlan(ctx, merged);
        if (snapshot) {
          const blocks = unique(ctx.doc.blocks);
          for (const card of merged.cards!) {
            if (blocks.has(card.id) || (!snapshot.cards.some((row) => row.id === card.id) && !merged.reusable.has(card.id)
              && ctx.db.prepare('SELECT 1 FROM ids_used WHERE id = ?').get(card.id))) throw new OpError('invalid', `Card id ${card.id} was already used.`);
          }
          const cards = merged.cards!.map((card) => {
            const step = card.step_id && blocks.get(card.step_id);
            const checkpoint = card.area?.startsWith('checkpoint:') && !blocks.has(card.area.slice('checkpoint:'.length));
            return { ...card, step_id: step ? card.step_id : null, area: checkpoint ? 'plan:own' : card.area };
          });
          writeRows(ctx, 'cards', snapshot.cards, cards);
          writeRows(ctx, 'links', snapshot.links, merged.links!);
        }
        if (pulled) ctx.log.push('Took the plan and Board snapshot from Git');
        else ctx.log.push(...changes.map(({ kind, label }) => `${kind} ${label.split('\n', 1)[0]}`));
      },
      finish(ctx) {
        for (const answer of merged.answers ?? []) {
          const actual = ctx.db.prepare('SELECT answer FROM decisions WHERE item_id = ?').get(answer.id);
          if (!answer.answered_by || !answer.answered_at || actual?.answer !== answer.answer) continue;
          ctx.rec.capture('decision_meta', answer.id);
          ctx.db.prepare('INSERT OR REPLACE INTO decision_meta(item_id, answered_by, answered_at) VALUES (?, ?, ?)')
            .run(answer.id, answer.answered_by, answer.answered_at);
        }
        handled();
      },
    },
  });
}

export function liveExportText(db: WorkspaceDb, file: ExportFile): string {
  return file === PLAN_EXPORT ? exportPlan(db).text : exportPortableSnapshot(db);
}
