/**
 * @module core/board-db-app
 * The Board for a workspace that was moved to its database: the same answer as `readBoard` and `changeBoard` give for
 * `contextspace-board.json`, read from and written to the database.
 *
 * - Cards keep their database ids (`k3m9a`); a card moved from the old file also answers to its old uuid in a change.
 *   Each card carries its `rev`, and the board its `revision` (the workspace's) and `dbId`.
 * - Areas and steps name plan items by id (`checkpoint:c3m9a`, `s7k2q`), which is what the plan answer uses as keys.
 * - The same changes as the file board (`add_card`, `update_card`, `remove_card`, `move`, `link`, `unlink`), turned into
 *   ops of one batch, all or none. `update_card` and `remove_card` may carry the card's `rev`: when the card changed
 *   since (an AI edited the note meanwhile), the change is refused with 409, `code: 'rev_conflict'` and the card as it is
 *   now (`current`), never written over. A drag (`move`) is last-write-wins by design.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  BOARD_LIMITS, BoardChangeError, BoardInputError, boardFields, checkCardFile, isBoardId, isBoardNodeId,
  type BoardCard, type BoardChangeResult, type BoardPoint,
} from './board.js';
import { assertWorkspaceActive } from './archive-guard.js';
import { appendScreenEvent } from './screen-events.js';
import { PlanDbChangeError, refusalOf } from './plan-db-app.js';
import { publishExports } from './workspace-db-exports.js';
import { readAppDb, writeAppDb } from './workspace-db-app.js';
import { runDbWrite } from './workspace-db-write.js';
import { loadFeatureConfig } from './workspace.js';
import { cardFromRow, getCard, listCards, listLinks, listPositions, readRequestReplay, readDbId, readRevision, type BatchResult, type Card, type Issue, type Op, type WorkspaceDb } from './workspace-db/index.js';

/** A card id of the database: `k` and five base-32 characters. */
export const DB_CARD_ID = /^k[0-9a-hjkmnp-tv-z]{5}$/;

export type BoardDbCard = BoardCard & { rev: number };

export interface BoardDbView {
  version: 1;
  store: 'database';
  revision: number;
  dbId: string;
  cards: BoardDbCard[];
  links: Array<{ id: string; from: string; to: string; label?: string; by: string; at: string }>;
  positions: Record<string, BoardPoint>;
}

export function cardView(card: Card): BoardDbCard {
  const base = {
    id: card.id, title: card.title,
    pinned: card.pinned, archived: card.archived, by: card.by, at: card.at, updatedBy: card.updatedBy, updatedAt: card.updatedAt,
    ...(card.area ? { area: card.area } : {}),
    ...(card.stepId ? { step: card.stepId } : {}),
    ...(card.about ? { about: card.about } : {}),
    ...(card.look ? { look: card.look, ...(card.lookAt ? { lookAt: card.lookAt } : {}) } : {}),
    rev: card.rev,
  };
  return card.kind === 'note' ? { ...base, kind: 'note', body: card.body ?? '' }
    : { ...base, kind: 'file', path: card.path ?? '', description: card.description ?? '' };
}

/** The board inside a read view. */
export function readBoardDb(view: WorkspaceDb): BoardDbView {
  const positions: Record<string, BoardPoint> = {};
  for (const p of listPositions(view)) positions[p.nodeId] = { x: p.x, y: p.y };
  return {
    version: 1, store: 'database',
    revision: readRevision(view.sqlite), dbId: readDbId(view.sqlite),
    cards: listCards(view, { includeArchived: true }).map(cardView),
    links: listLinks(view).map((l) => ({ id: l.id, from: l.from, to: l.to, ...(l.label ? { label: l.label } : {}), by: l.by, at: l.at })),
    positions,
  };
}

export const boardDbForApp = (root: string): Promise<BoardDbView> => readAppDb(root, readBoardDb);

export interface BoardBatchView { board: BoardDbView; savedCards: BoardDbCard[] }

export function readBoardBatch(view: WorkspaceDb, result: Extract<BatchResult, { ok: true }>): BoardBatchView {
  const entry = view.sqlite.prepare('SELECT rows FROM changes WHERE seq = ?').get(result.seq) as { rows: string | null } | undefined;
  const rows: Array<{ table: string; after: Record<string, unknown> | null }> = JSON.parse(entry?.rows ?? '[]');
  return { board: readBoardDb(view), savedCards: rows.flatMap((row) => row.table === 'cards' && row.after ? [cardView(cardFromRow(row.after))] : []) };
}

export const boardRequestId = z.string().regex(/^[\w.:@-]{1,100}$/).describe('A unique id for this Board request. Retry with the same id and inputs.');

function assertBoardGeneration(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new PlanDbChangeError('The workspace database was replaced since the board was read (a backup was restored). Nothing was changed; look again.', 409, 'db_changed');
  }
}

/** A retry can be answered even when the step or file named by the original add is gone. */
export async function replayBoardAdd(root: string, requestId: string, requestSource: string, dbId?: string) {
  const replay = await readAppDb(root, (view) => {
    assertBoardGeneration(dbId, readDbId(view.sqlite));
    const result = readRequestReplay(view, requestId, requestSource);
    if (!result) return undefined;
    if (!result.ok) throw refusalOf(result, (issue) => issue.message);
    const { board, savedCards } = readBoardBatch(view, result);
    const id = result.ids.card0;
    return { board, savedCards, revision: result.revision, requestId, results: [{ op: 'add_card' as const, id }] };
  });
  if (replay) {
    // An earlier writer may have committed and exited before publishing its exports.
    await writeAppDb(root, async (db) => publishExports(root, db)).catch((error: unknown) => {
      process.stderr.write(`Board request ${requestId} was saved. Could not publish its exports: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
  return replay;
}

// ─── Changes ────────────────────────────────────────────────────────────────

const cardRef = z.string().refine((v) => DB_CARD_ID.test(v) || isBoardId(v), 'A card id is the id the board shows (such as k3m9a).');
const nodeRef = z.string().max(400).refine((v) => DB_CARD_ID.test(v) || isBoardNodeId(v), 'That is not a board node id: a card id, checkpoint:<id>, document:<id> or commit:<repo>:<sha>.');
const rev = z.number().int().positive();
const coordinate = z.number().min(-BOARD_LIMITS.coordinate).max(BOARD_LIMITS.coordinate);

const SCHEMAS = {
  add_card: z.object({
    op: z.literal('add_card'), kind: z.enum(['note', 'file']), id: z.string().refine(isBoardId, 'An id is a uuid.').optional(),
    title: boardFields.title.optional(), body: boardFields.body.optional(), path: boardFields.path.optional(), description: boardFields.description.optional(),
    pinned: z.boolean().optional(), area: boardFields.area.optional(), step: boardFields.step.optional(), look: boardFields.look.optional(), about: boardFields.about.optional(),
    position: z.object({ x: coordinate, y: coordinate }).strict().optional(),
  }).strict().superRefine((card, context) => {
    const refuse = (field: string, message: string) => context.addIssue({ code: 'custom', path: [field], message });
    if (card.kind === 'note') {
      if (!card.title) refuse('title', 'A note needs a title.');
      if (card.path !== undefined) refuse('path', 'A note has no path. Use kind "file" to show a file.');
      if (card.description !== undefined) refuse('description', 'A note has a body, not a description.');
    } else {
      if (!card.path) refuse('path', 'A file card needs the path of a file inside the workspace.');
      if (card.body !== undefined) refuse('body', 'A file card has a description, not a body.');
    }
  }),
  update_card: z.object({
    op: z.literal('update_card'), id: cardRef, rev: rev.optional(),
    title: boardFields.title.optional(), body: boardFields.body.optional(), description: boardFields.description.optional(),
    pinned: z.boolean().optional(), archived: z.boolean().optional(),
    area: boardFields.area.nullable().optional(), step: boardFields.step.nullable().optional(), look: boardFields.look.nullable().optional(),
  }).strict().refine((change) => ['title', 'body', 'description', 'pinned', 'archived', 'area', 'step', 'look'].some((field) => (change as Record<string, unknown>)[field] !== undefined), 'Give at least one thing to change.'),
  remove_card: z.object({ op: z.literal('remove_card'), id: cardRef, rev: rev.optional() }).strict(),
  move: z.object({
    op: z.literal('move'),
    nodes: z.array(z.object({ id: nodeRef, x: coordinate.nullable(), y: coordinate.nullable() }).strict()
      .refine((node) => (node.x === null) === (node.y === null), 'Give x and y as numbers to place the node, or both as null to forget its place.'))
      .min(1).max(BOARD_LIMITS.nodes),
  }).strict(),
  link: z.object({ op: z.literal('link'), from: nodeRef, to: nodeRef, label: boardFields.label.optional() }).strict(),
  unlink: z.object({ op: z.literal('unlink'), id: z.string().refine(isBoardId, 'A link id is a uuid.').optional(), from: nodeRef.optional(), to: nodeRef.optional() }).strict()
    .refine((change) => (change.id !== undefined && change.from === undefined && change.to === undefined)
      || (change.id === undefined && change.from !== undefined && change.to !== undefined), 'Name the link by its id, or by both of its ends (from and to).'),
} as const;

type Change = { [K in keyof typeof SCHEMAS]: z.output<(typeof SCHEMAS)[K]> }[keyof typeof SCHEMAS];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseBoardDbChanges(input: unknown, allowCommitAbout = false): Change[] {
  if (!Array.isArray(input) || input.length === 0) throw new BoardInputError('Give at least one change.');
  if (input.length > BOARD_LIMITS.changes) throw new BoardInputError(`At most ${BOARD_LIMITS.changes} changes can be made at once.`);
  return input.map((raw, index) => {
    const where = `Change ${index + 1}`;
    const op = isRecord(raw) && typeof raw.op === 'string' && Object.hasOwn(SCHEMAS, raw.op) ? raw.op as keyof typeof SCHEMAS : null;
    if (!op) throw new BoardInputError(`${where}: "op" must be one of ${Object.keys(SCHEMAS).join(', ')}.`);
    if (!allowCommitAbout && isRecord(raw) && raw.about !== undefined) throw new BoardInputError(`${where}, about: Commit notes can only be added through addCommitNote / ctxspace note.`);
    const result = SCHEMAS[op].safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0]!;
      const field = issue.path.join('.');
      throw new BoardInputError(`${where}${field ? `, ${field}` : ''}: ${issue.message}`);
    }
    return result.data as Change;
  });
}

/** A card refused because it changed since it was read, with the card as it is now, so what was typed can be kept. */
export class BoardDbConflictError extends PlanDbChangeError {
  constructor(message: string, readonly current: BoardDbCard | null, detail?: string) {
    super(message, 409, 'rev_conflict', detail);
    this.name = 'BoardDbConflictError';
  }
}

/** The area of a step (`checkpoint:<id>`, or `plan:own` outside the Checkpoints list), or undefined when it is no step on the plan. */
function areaOfStep(view: WorkspaceDb, step: string): string | undefined {
  const row = view.sqlite.prepare("SELECT kind, checkpoint_id FROM blocks WHERE id = ?").get(step) as { kind: string; checkpoint_id: string | null } | undefined;
  if (!row || row.kind === 'heading' || row.kind === 'prose') return undefined;
  return row.checkpoint_id ? `checkpoint:${row.checkpoint_id}` : 'plan:own';
}

/**
 * Applies changes to the board as `by` (the app: `user`), all or none, and returns the board as it is after them.
 * `revision` (the workspace revision the caller read) and `dbId` are optional: when given, a change since that touches
 * the same rows, or another database, refuses the whole request.
 */
export async function changeBoardDb(root: string, input: unknown, options: {
  by: string; revision?: number; dbId?: string; strictRevision?: boolean; allowCommitAbout?: boolean;
  requestId?: string; requestSource?: string;
}): Promise<BoardBatchView & { revision: number; requestId: string; results: BoardChangeResult[] }> {
  const changes = parseBoardDbChanges(input, options.allowCommitAbout);
  const feature = await loadFeatureConfig(root);
  if (feature) assertWorkspaceActive(feature, 'change the board');
  if (options.dbId === undefined && (options.revision !== undefined || changes.some((change) => 'rev' in change && change.rev !== undefined))) {
    throw new PlanDbChangeError('Send the dbId from the same Board read as the revision or rev. Read the board again.', 409, 'db_changed');
  }
  const requestId = options.requestId ?? randomUUID();
  const requestSource = options.requestSource ?? JSON.stringify({ board: changes, by: options.by, revision: options.revision, dbId: options.dbId });
  if (options.requestId && options.requestSource === undefined && changes.length === 1 && changes[0]?.op === 'add_card') {
    const replay = await replayBoardAdd(root, requestId, requestSource, options.dbId);
    if (replay) return replay;
  }

  const filePaths = new Map<number, string>();
  for (const [index, change] of changes.entries()) {
    if (change.op === 'add_card' && change.kind === 'file') filePaths.set(index, await checkCardFile(root, change.path!));
  }

  // What the changes need to know of the board as it is: each card's kind, step and area, and where each step sits.
  const known = await readAppDb(root, (view) => {
    const cards = new Map<string, Card>();
    const stepAreas = new Map<string, string | undefined>();
    const nodes = new Map<string, string>();
    for (const change of changes) {
      if (change.op === 'update_card' || change.op === 'remove_card') {
        const card = getCard(view, change.id);
        if (card) { cards.set(change.id, card); if (card.stepId) stepAreas.set(card.stepId, areaOfStep(view, card.stepId)); }
      }
      if (change.op === 'link' || (change.op === 'unlink' && change.from && change.to)) {
        for (const node of [change.from!, change.to!]) {
          const card = getCard(view, node);
          if (card) nodes.set(node, card.id);
        }
      }
      if ((change.op === 'add_card' || change.op === 'update_card') && typeof change.step === 'string') stepAreas.set(change.step, areaOfStep(view, change.step));
    }
    const links = changes.some((change) => change.op === 'unlink') ? listLinks(view) : [];
    return { cards, stepAreas, nodes, links, dbId: readDbId(view.sqlite), revision: readRevision(view.sqlite) };
  });
  assertBoardGeneration(options.dbId, known.dbId);

  const ops: Op[] = [];
  const aliasOf = new Map<string, string>();
  const ref = (id: string) => aliasOf.get(id) ?? id;
  const resultsPlan: Array<(ids: Record<string, string>, board: BoardDbView) => BoardChangeResult> = [];
  const conflictCard = new Map<number, string>(); // op index → card id, for a rev conflict
  const cardUpdates = new Map<string, { count: number; stepId: string | null }>();
  const expectedCardRev = (card: Card, observed?: number): number | undefined => {
    if (observed === undefined && options.revision !== undefined) return undefined;
    const earlier = cardUpdates.get(card.id)?.count ?? 0;
    if (earlier > 0 && observed !== undefined && observed !== card.rev) {
      throw new BoardDbConflictError(`This note changed since you read rev ${observed}. It is at rev ${card.rev}.`, cardView(card));
    }
    return (observed ?? card.rev) + earlier;
  };
  for (const [index, change] of changes.entries()) {
    switch (change.op) {
      case 'add_card': {
        const alias = `card${index}`;
        if (change.id) aliasOf.set(change.id, `$${alias}`);
        let area = change.area;
        if (change.step) {
          const own = known.stepAreas.get(change.step);
          if (own && area && area !== own) throw new BoardChangeError(`The step "${change.step}" is in ${own}, not ${area}. Leave the area out or use ${own}.`);
          area = own ?? area;
        }
        const filePath = filePaths.get(index);
        ops.push({
          op: 'card.add', kind: change.kind, as: alias,
          title: change.title ?? filePath!.split('/').pop()!,
          ...(change.kind === 'note' ? { body: change.body ?? '' } : { path: filePath!, description: change.description ?? '' }),
          ...(area ? { area } : {}), ...(change.step ? { step: change.step } : {}),
          ...(change.about ? { about: change.about } : {}),
          ...(change.look ? { look: change.look } : {}), ...(change.pinned !== undefined ? { pinned: change.pinned } : {}),
        });
        if (change.position) ops.push({ op: 'place', node: `$${alias}`, x: change.position.x, y: change.position.y });
        resultsPlan.push((ids) => ({ op: 'add_card', ...(ids[alias] ? { id: ids[alias] } : {}) }));
        break;
      }
      case 'update_card': {
        const card = known.cards.get(change.id);
        if (!card) throw new BoardChangeError(`There is no card with id ${change.id} on the board. Read the board again.`);
        if (change.rev === undefined && options.revision === undefined
          && (change.title !== undefined || change.body !== undefined || change.description !== undefined)) {
          const current = change.body !== undefined ? card.body ?? '' : change.description !== undefined ? card.description ?? '' : undefined;
          const text = current === undefined ? '' : ` Current text: ${JSON.stringify(current.slice(0, 200))}.`;
          throw new BoardDbConflictError(`"${card.title}" is now at rev ${card.rev}.${text} Read \`ctxspace plan ${card.id}\` or the Board again and send the rev or Board revision you read, along with dbId.`, cardView(card));
        }
        if (change.body !== undefined && card.kind !== 'note') throw new BoardChangeError('A file card has a description, not a body.');
        if (change.description !== undefined && card.kind !== 'file') throw new BoardChangeError('A note has a body, not a description.');
        if (card.about && (change.area !== undefined || change.step !== undefined)) throw new BoardChangeError('A commit note stays on its commit and cannot be placed in an area or step.');
        const set: Record<string, unknown> = {};
        for (const field of ['title', 'body', 'description', 'pinned', 'archived', 'look'] as const) if (change[field] !== undefined) set[field] = change[field];
        // The step decides the area, as on the file board: setting a step moves the card to the step's area, and moving the
        // card to another area drops a step that is not in it. Clearing the area (null) leaves the step as a hint.
        let area = change.area;
        if (change.step) {
          const own = known.stepAreas.get(change.step);
          if (own && area && area !== own) throw new BoardChangeError(`The step "${change.step}" is in ${own}, not ${area}. Leave the area out or use ${own}.`);
          area = own ?? area;
        }
        if (area !== undefined) set.area = area;
        const earlier = cardUpdates.get(card.id);
        const stepId = earlier ? earlier.stepId : card.stepId;
        if (change.step !== undefined) set.step = change.step;
        else if (change.area && stepId && known.stepAreas.get(stepId) && known.stepAreas.get(stepId) !== change.area) set.step = null;
        conflictCard.set(ops.length, card.id);
        ops.push({ op: 'card.update', id: card.id, rev: expectedCardRev(card, change.rev), ...set });
        cardUpdates.set(card.id, { count: (earlier?.count ?? 0) + 1, stepId: set.step === undefined ? stepId : set.step as string | null });
        resultsPlan.push(() => ({ op: 'update_card', id: card.id }));
        break;
      }
      case 'remove_card': {
        const card = known.cards.get(change.id);
        if (!card) throw new BoardChangeError(`There is no card with id ${change.id} on the board. Read the board again.`);
        conflictCard.set(ops.length, card.id);
        if (options.revision === undefined) {
          throw new BoardDbConflictError(`Removing "${card.title}" also removes its links. Read the Board again and send its revision and dbId. The Board is now at revision ${known.revision}.`, cardView(card));
        }
        ops.push({ op: 'card.remove', id: card.id, rev: expectedCardRev(card, change.rev) });
        resultsPlan.push(() => ({ op: 'remove_card', id: card.id }));
        break;
      }
      case 'move':
        for (const node of change.nodes) ops.push({ op: 'place', node: ref(node.id), x: node.x, y: node.y });
        resultsPlan.push(() => ({ op: 'move', count: change.nodes.length }));
        break;
      case 'link': {
        const from = ref(change.from);
        const to = ref(change.to);
        ops.push({ op: 'link', from, to, ...(change.label?.trim() ? { label: change.label } : {}) });
        resultsPlan.push((ids, board) => {
          const canonical = (node: string) => node.startsWith('$') ? ids[node.slice(1)] : known.nodes.get(node) ?? node;
          const id = board.links.find((l) => l.from === canonical(from) && l.to === canonical(to))?.id;
          return { op: 'link', ...(id ? { id } : {}) };
        });
        break;
      }
      case 'unlink': {
        ops.push(change.id !== undefined ? { op: 'unlink', id: change.id } : { op: 'unlink', from: ref(change.from!), to: ref(change.to!) });
        const id = change.id ?? known.links.find((link) =>
          link.from === (known.nodes.get(change.from!) ?? change.from) && link.to === (known.nodes.get(change.to!) ?? change.to))?.id;
        resultsPlan.push(() => ({ op: 'unlink', ...(id ? { id } : {}) }));
        break;
      }
    }
  }

  let conflictAt: number | null = null;
  const words = (issue: Issue): string => {
    if (issue.code === 'rev_conflict' && issue.op !== null && conflictCard.has(issue.op)) {
      conflictAt = issue.op;
      return 'This note was changed by someone else while you were editing it, so it was not saved. What you typed is still here.';
    }
    if (issue.code === 'rev_conflict' || issue.code === 'stale_revision') return 'The board changed since you read it. Nothing was changed; look again.';
    if (issue.code === 'db_changed') return 'The workspace database was replaced since the board was read (a backup was restored). Nothing was changed; look again.';
    if (issue.code === 'invalid' && /is not a checkpoint on the plan/.test(issue.message)) {
      return 'That area is no longer on the plan. Pick another area, then save again.';
    }
    if (issue.code === 'invalid' && /is not an item on the plan/.test(issue.message)) {
      return 'That step is no longer on the plan. Clear the step or pick another, then save again.';
    }
    return issue.message.replace(/^op \d+ \([^)]*\): /, '');
  };
  const { result, view } = await runDbWrite(root, {
    type: 'board-batch', ops, options: {
      by: options.by, ifRevision: options.revision ?? known.revision, strictRevision: options.strictRevision,
      implicitRevision: options.revision === undefined,
      dbId: options.dbId ?? known.dbId, requestId, requestSource,
    },
  });
  if (!result.ok) {
    const error = refusalOf(result, words);
    if (conflictAt !== null) {
      const id = conflictCard.get(conflictAt)!;
      const current = await readAppDb(root, (view) => getCard(view, id)).catch(() => null);
      throw new BoardDbConflictError(error.message, current ? cardView(current) : null, error.detail);
    }
    throw error;
  }
  const { board, savedCards } = view!;
  if (!result.replayed) {
    await appendScreenEvent(root, { harness: options.by, author: options.by === 'user' ? 'human' : 'agent', event: 'board', payload: { revision: board.revision, changes: changes.length } }).catch(() => undefined);
  }
  return { board, savedCards, revision: result.revision, requestId, results: resultsPlan.map((make) => make(result.ids, board)) };
}
