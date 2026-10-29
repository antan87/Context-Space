/**
 * @module core/board
 * The workspace board: the things people and AIs put on it (notes, and files they made to show), the lines drawn
 * between things, and where things were moved to. It is one file, `contextspace-board.json`, read and written through
 * the storage port. The Board tab draws the plan's checkpoints, the source documents and the new commits by itself;
 * what is kept here is only what someone added or arranged, so those generated things can come and go.
 *
 * Changes are small operations (add, update or remove a card, move, link, unlink) applied under a lock to the file as
 * it is at that moment, so two writers who change different things both keep their change. A caller that wants its
 * change refused when the board moved on passes the `revision` it read. A list of changes is applied all or none.
 *
 * Nothing in the file is trusted on read: it is rebuilt field by field, and an entry that is not usable is dropped. A
 * file that is not a board at all (not JSON, or from a newer version) is reported and never overwritten.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertNoLinkedPathComponents } from '../resources/fs-safety.js';
import { assertWorkspaceActive } from './archive-guard.js';
import { acquireLock, createMutationQueue } from './locks.js';
import { readPlanFile } from './plan-file-store.js';
import { openableDocumentName } from './root-documents.js';
import { cleanScreenBlock, cleanScreenText } from './screen-clean.js';
import { appendScreenEvent } from './screen-events.js';
import { readWorkspaceFile, writeWorkspaceFile } from './storage.js';
import { loadFeatureConfig } from './workspace.js';

export const BOARD_FILE = 'contextspace-board.json';
const CHANGES_FILE = '.contextspace/board-changes.jsonl';
/** How many changes the log keeps. */
export const BOARD_CHANGES_KEPT = 300;

export const BOARD_LIMITS = {
  cards: 500,
  links: 1000,
  positions: 2000,
  /** Changes in one request, and nodes in one move. */
  changes: 100,
  nodes: 100,
  title: 200,
  body: 4000,
  description: 4000,
  label: 200,
  path: 1000,
  /** A position is a number between minus and plus this much. */
  coordinate: 1_000_000,
  /** The reason to look at a card. */
  look: 140,
  stepKey: 120,
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

interface CardBase {
  /** A uuid. It is also the card's node id. */
  id: string;
  pinned: boolean;
  archived: boolean;
  /** `user`, or the name of the AI tool that made it. */
  by: string;
  at: string;
  updatedBy: string;
  updatedAt: string;
  title: string;
  /** The board area (`checkpoint:<plan key>` or `plan:own`) the card belongs to. Cards without one go to a linked area or the current checkpoint. */
  area?: string;
  /** The key of the plan step (a `PlanLine.key` in PLAN.md) the card is about. */
  step?: string;
  /** One line on why a person should look at the card, and when it was set (set by the board, never by the caller). */
  look?: string;
  lookAt?: string;
}
export interface BoardNote extends CardBase { kind: 'note'; body: string }
export interface BoardFile extends CardBase {
  kind: 'file';
  /** A file inside the workspace that the documents panel can open, relative to the workspace folder, with `/`. */
  path: string;
  description: string;
}
export type BoardCard = BoardNote | BoardFile;

export interface BoardLink {
  id: string;
  /** Node ids: a card, or a generated node (see {@link isBoardNodeId}). */
  from: string;
  to: string;
  label?: string;
  by: string;
  at: string;
}

export interface BoardPoint { x: number; y: number }

export interface Board {
  version: 1;
  /** Counts the change requests applied to this board; a request of several changes counts once. */
  revision: number;
  cards: BoardCard[];
  links: BoardLink[];
  /** By node id, for cards and generated nodes alike. */
  positions: Record<string, BoardPoint>;
}

/** One change as the log keeps it. */
export interface BoardLogEntry {
  at: string;
  by: string;
  /** The revision the change made. */
  revision: number;
  action: BoardChange['op'];
  /** The card, link or (for a move) first node it was about. */
  id: string;
  text: string;
}

/** What one applied change made or touched. */
export interface BoardChangeResult {
  op: BoardChange['op'];
  /** The card or link, when the change was about one. */
  id?: string;
  /** For a move, how many nodes it placed. */
  count?: number;
}

/** The board file is not a usable board. Nothing was changed. */
export class BoardFileError extends Error {
  readonly code = 'BOARD_FILE';
  constructor(message: string) { super(message); this.name = 'BoardFileError'; }
}

/** The change cannot be made on the board as it is now: it moved on, or another session holds it. Read it again. */
export class BoardConflictError extends Error {
  readonly code = 'BOARD_CONFLICT';
  constructor(message: string) { super(message); this.name = 'BoardConflictError'; }
}

/** The request is not a valid change. */
export class BoardInputError extends Error {
  readonly code = 'BOARD_INPUT';
  constructor(message: string) { super(message); this.name = 'BoardInputError'; }
}

/** A valid-looking change that cannot be made on this board: no such card, a limit reached, a file that is not there. */
export class BoardChangeError extends Error {
  readonly code = 'BOARD_CHANGE';
  constructor(message: string) { super(message); this.name = 'BoardChangeError'; }
}

/** The workspace is gone, or was never one. */
export class BoardWorkspaceError extends Error {
  readonly code = 'BOARD_WORKSPACE';
  constructor(message = 'Workspace not found.') { super(message); this.name = 'BoardWorkspaceError'; }
}

// ─── Node ids ───────────────────────────────────────────────────────────────

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`);
// The Board tab adds `#2` when two generated nodes would otherwise share an id.
const COPY = '(?:#[0-9]{1,3})?';
const CHECKPOINT = new RegExp(`^checkpoint:[\\p{L}\\p{N}][\\p{L}\\p{N}-]{0,89}${COPY}$`, 'u');
const DOCUMENT = new RegExp(`^document:${UUID_SOURCE}${COPY}$`);
// The repository comes first and may hold anything but separators; the hash after the last colon ends it.
// eslint-disable-next-line no-control-regex
const COMMIT = new RegExp(`^commit:[^\\\\/\\u0000-\\u001f\\u007f]{1,200}:[0-9a-f]{7,64}${COPY}$`);

/** The ways a node on the board is named, for messages and tool descriptions. */
export const BOARD_NODE_ID_FORMATS = {
  card: 'the id of a card on the board (a uuid)',
  checkpoint: 'checkpoint:<plan key>, the key PLAN.md gives the checkpoint (its title in lower case with dashes)',
  document: 'document:<source document id>',
  commit: 'commit:<repository folder name>:<commit hash>',
} as const;

/** Cards and links are told apart by where they are kept, not by their id: both are uuids. */
export const isBoardId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/**
 * Whether `value` has the shape of a node id: a card id, or a generated node's. Only the shape is checked, because
 * generated nodes come and go (a commit leaves the recent ones, a checkpoint is renamed).
 */
export function isBoardNodeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 400
    && (UUID.test(value) || CHECKPOINT.test(value) || DOCUMENT.test(value) || COMMIT.test(value));
}

/** Whether `value` has the shape of a plan step key: the words of the step in lower case joined with dashes, which the plan may cut at a dash or number (`-2`). */
export function isBoardStepKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= BOARD_LIMITS.stepKey && /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u.test(value);
}

/** Whether `value` has the shape of an area id on the board: `checkpoint:<plan key>` or `plan:own`. */
export function isBoardAreaId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 400 && (CHECKPOINT.test(value) || value === 'plan:own');
}

const NOT_A_NODE = `That is not a board node id. Use ${BOARD_NODE_ID_FORMATS.card}, ${BOARD_NODE_ID_FORMATS.checkpoint}, ${BOARD_NODE_ID_FORMATS.document}, or ${BOARD_NODE_ID_FORMATS.commit}.`;

// ─── Cleaning what is read ──────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
/**
 * The name a change is recorded under, from the name of the AI tool or `user`: lower case letters, digits, `.`, `_` and
 * `-` only. Anything else (a look-alike letter, a zero-width or direction-changing character) becomes a dash, so no
 * name can read as another one. Undefined when nothing is left.
 */
export function boardActorName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 40).replace(/[-._]+$/, '') || undefined;
}
const actor = boardActorName;

/** A file card's path, or null when it is not a relative path the documents panel could open. Looks at the text only. */
function cleanCardPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > BOARD_LIMITS.path) return null;
  const raw = value.trim().replace(/\\/g, '/');
  // The panel reads a leading slash as the workspace folder; a card must name its file relative to it.
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  try {
    return openableDocumentName(raw);
  } catch {
    return null;
  }
}

function cleanPoint(value: unknown): BoardPoint | null {
  if (!isRecord(value)) return null;
  const { x, y } = value;
  const within = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= BOARD_LIMITS.coordinate;
  return within(x) && within(y) ? { x, y } : null;
}

function cleanCard(raw: unknown): BoardCard | null {
  if (!isRecord(raw) || !isBoardId(raw.id)) return null;
  const title = cleanScreenText(raw.title, BOARD_LIMITS.title);
  const by = actor(raw.by);
  if (!title || !by || !validTime(raw.at)) return null;
  const area = isBoardAreaId(raw.area) ? raw.area : undefined;
  const step = isBoardStepKey(raw.step) ? raw.step : undefined;
  const look = typeof raw.look === 'string' && raw.look.length <= BOARD_LIMITS.look ? cleanScreenText(raw.look, BOARD_LIMITS.look) : undefined;
  const base = {
    id: raw.id, title, pinned: raw.pinned === true, archived: raw.archived === true, by, at: raw.at,
    updatedBy: actor(raw.updatedBy) ?? by, updatedAt: validTime(raw.updatedAt) ? raw.updatedAt : raw.at,
    ...(area ? { area } : {}),
    ...(step ? { step } : {}),
    ...(look ? { look, lookAt: validTime(raw.lookAt) ? raw.lookAt : validTime(raw.updatedAt) ? raw.updatedAt : raw.at } : {}),
  };
  if (raw.kind === 'note') return { ...base, kind: 'note', body: cleanScreenBlock(raw.body, BOARD_LIMITS.body) ?? '' };
  if (raw.kind === 'file') {
    const filePath = cleanCardPath(raw.path);
    return filePath ? { ...base, kind: 'file', path: filePath, description: cleanScreenBlock(raw.description, BOARD_LIMITS.description) ?? '' } : null;
  }
  return null;
}

/** Whether an end of a link or a position that is a card id belongs to a card that is on the board. */
const onBoard = (id: string, cards: ReadonlySet<string>) => !isBoardId(id) || cards.has(id);

/** Rebuilds a board from parsed JSON. Throws {@link BoardFileError} when it is not a board; drops what is not usable. */
function rebuild(raw: unknown): Board {
  if (!isRecord(raw)) throw new BoardFileError(`${BOARD_FILE} is not a board. It was left as it is: fix or remove it, then try again.`);
  if (typeof raw.version === 'number' && raw.version > 1) {
    throw new BoardFileError(`${BOARD_FILE} was saved by a newer version of this app (board version ${raw.version}). It was left as it is: update the app to use this board.`);
  }
  if (raw.version !== 1 || typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0) {
    throw new BoardFileError(`${BOARD_FILE} is not a board this app can read (it needs "version": 1 and a "revision" number). It was left as it is: fix or remove it, then try again.`);
  }
  for (const field of ['cards', 'links'] as const) {
    if (raw[field] !== undefined && !Array.isArray(raw[field])) throw new BoardFileError(`${BOARD_FILE} has "${field}" that is not a list. It was left as it is: fix or remove it, then try again.`);
  }
  if (raw.positions !== undefined && !isRecord(raw.positions)) throw new BoardFileError(`${BOARD_FILE} has "positions" that is not an object. It was left as it is: fix or remove it, then try again.`);

  const cards: BoardCard[] = [];
  const cardIds = new Set<string>();
  for (const entry of (raw.cards as unknown[] | undefined) ?? []) {
    const card = cleanCard(entry);
    if (card && !cardIds.has(card.id) && cards.length < BOARD_LIMITS.cards) { cards.push(card); cardIds.add(card.id); }
  }

  const links: BoardLink[] = [];
  const linkIds = new Set<string>();
  const pairs = new Set<string>();
  for (const entry of (raw.links as unknown[] | undefined) ?? []) {
    if (!isRecord(entry) || links.length >= BOARD_LIMITS.links) continue;
    const { id, from, to } = entry;
    const by = actor(entry.by);
    if (!isBoardId(id) || linkIds.has(id) || !isBoardNodeId(from) || !isBoardNodeId(to) || from === to || !by || !validTime(entry.at)) continue;
    if (!onBoard(from, cardIds) || !onBoard(to, cardIds) || pairs.has(`${from}\n${to}`)) continue;
    const label = cleanScreenText(entry.label, BOARD_LIMITS.label);
    links.push({ id, from, to, ...(label ? { label } : {}), by, at: entry.at });
    linkIds.add(id);
    pairs.add(`${from}\n${to}`);
  }

  const positions: Record<string, BoardPoint> = {};
  let kept = 0;
  for (const [id, value] of Object.entries((raw.positions as Record<string, unknown> | undefined) ?? {})) {
    const point = cleanPoint(value);
    if (point && isBoardNodeId(id) && onBoard(id, cardIds) && kept < BOARD_LIMITS.positions) { positions[id] = point; kept++; }
  }
  return { version: 1, revision: raw.revision, cards, links, positions };
}

const emptyBoard = (): Board => ({ version: 1, revision: 0, cards: [], links: [], positions: {} });

// ─── The file ───────────────────────────────────────────────────────────────

interface Location { root: string; featureId: string }

async function locate(workspacePath: string): Promise<Location> {
  const root = await fs.realpath(workspacePath).catch((error) => {
    // A workspace folder that has gone is a missing workspace; any other failure is not ours to name.
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new BoardWorkspaceError() : error;
  });
  return { root, featureId: (await loadFeatureConfig(root))?.id ?? path.basename(root) };
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The board as stored. A workspace with no board file has an empty one; a file that cannot be read as a board is an error. */
async function readAt(location: Location): Promise<Board> {
  try {
    await assertNoLinkedPathComponents(location.root, path.join(location.root, BOARD_FILE));
  } catch (error) {
    throw new BoardFileError(/Linked path components/.test(reason(error))
      ? `${BOARD_FILE} is, or sits inside, a link, which the board will not follow. It was left as it is: replace it with a real file or remove it.`
      : `${BOARD_FILE} could not be reached (${reason(error)}). It was left as it is.`);
  }
  let text: string;
  try {
    text = await readWorkspaceFile(location.root, location.featureId, BOARD_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyBoard();
    // A folder in its place, no permission, a failing disk: the board may well be fine, so nothing may write over it.
    throw new BoardFileError(`${BOARD_FILE} could not be read (${reason(error)}). It was left as it is.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BoardFileError(`${BOARD_FILE} is not valid JSON (${reason(error)}). It was left as it is: fix or remove it, then try again.`);
  }
  return rebuild(parsed);
}

/** Reads the board. */
export async function readBoard(workspacePath: string): Promise<Board> {
  return readAt(await locate(workspacePath));
}

const LOG_ACTIONS: readonly string[] = ['add_card', 'update_card', 'remove_card', 'move', 'link', 'unlink'];

/** The latest changes to the board, newest first. A line that cannot be read is skipped. */
export async function readBoardChanges(workspacePath: string, limit = 50): Promise<BoardLogEntry[]> {
  const location = await locate(workspacePath);
  const text = await readWorkspaceFile(location.root, location.featureId, CHANGES_FILE).catch(() => '');
  return text.split('\n').filter(Boolean).flatMap((line): BoardLogEntry[] => {
    try {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry) || !validTime(entry.at) || typeof entry.action !== 'string' || !LOG_ACTIONS.includes(entry.action)) return [];
      const by = actor(entry.by);
      const id = cleanScreenText(entry.id, 100);
      if (!by || !id || typeof entry.revision !== 'number' || !Number.isSafeInteger(entry.revision)) return [];
      return [{ at: entry.at, by, revision: entry.revision, action: entry.action as BoardLogEntry['action'], id, text: cleanScreenText(entry.text, 500) ?? '' }];
    } catch { return []; }
  }).reverse().slice(0, limit);
}

async function appendLog(location: Location, entries: BoardLogEntry[]): Promise<void> {
  const old = await readWorkspaceFile(location.root, location.featureId, CHANGES_FILE).catch(() => '');
  const lines = [...old.split('\n').filter(Boolean), ...entries.map((entry) => JSON.stringify(entry))].slice(-BOARD_CHANGES_KEPT);
  await writeWorkspaceFile(location.root, location.featureId, CHANGES_FILE, `${lines.join('\n')}\n`);
}

// ─── Changes ────────────────────────────────────────────────────────────────

const point = z.object({ x: z.number().min(-BOARD_LIMITS.coordinate).max(BOARD_LIMITS.coordinate), y: z.number().min(-BOARD_LIMITS.coordinate).max(BOARD_LIMITS.coordinate) }).strict();
const uuid = z.string().refine(isBoardId, 'An id is a uuid, as board_read shows it.');
const nodeId = z.string().refine(isBoardNodeId, NOT_A_NODE);
const NOT_AN_AREA = `That is not a board area id. Use ${BOARD_NODE_ID_FORMATS.checkpoint} or plan:own, as board_read shows them.`;
const areaId = z.string().refine(isBoardAreaId, NOT_AN_AREA);
const stepKey = z.string().refine(isBoardStepKey, 'That is not a plan step key.');
const look = z.string().trim().min(1).max(BOARD_LIMITS.look).refine((text) => !/[\r\n\u0085\u2028\u2029]/.test(text), 'The reason to look is one line.');

/** The fields a change is made of, so another surface (the MCP tools) can offer the same limits. */
export const boardFields = {
  title: z.string().trim().min(1).max(BOARD_LIMITS.title),
  body: z.string().max(BOARD_LIMITS.body),
  path: z.string().trim().min(1).max(BOARD_LIMITS.path),
  description: z.string().max(BOARD_LIMITS.description),
  label: z.string().trim().max(BOARD_LIMITS.label),
  uuid,
  nodeId,
  area: areaId,
  step: stepKey,
  look,
};

const addCardSchema = z.object({
  op: z.literal('add_card'),
  kind: z.enum(['note', 'file']),
  /** Lets one request add a card and then link or move it. Made when left out. */
  id: uuid.optional(),
  title: boardFields.title.optional(),
  body: boardFields.body.optional(),
  path: boardFields.path.optional(),
  description: boardFields.description.optional(),
  pinned: z.boolean().optional(),
  area: boardFields.area.optional(),
  step: boardFields.step.optional(),
  look: boardFields.look.optional(),
  position: point.optional(),
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
});

const updateCardSchema = z.object({
  op: z.literal('update_card'),
  id: uuid,
  title: boardFields.title.optional(),
  body: boardFields.body.optional(),
  description: boardFields.description.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  area: boardFields.area.nullable().optional(),
  step: boardFields.step.nullable().optional(),
  look: boardFields.look.nullable().optional(),
}).strict().refine((change) => ['title', 'body', 'description', 'pinned', 'archived', 'area', 'step', 'look'].some((field) => (change as Record<string, unknown>)[field] !== undefined), 'Give at least one thing to change.');

const removeCardSchema = z.object({ op: z.literal('remove_card'), id: uuid }).strict();

// A node given `x` and `y` of null is forgotten: its place is dropped, so the places of generated nodes that have gone
// do not pile up to the limit.
const moveSchema = z.object({
  op: z.literal('move'),
  nodes: z.array(z.object({ id: nodeId, x: point.shape.x.nullable(), y: point.shape.y.nullable() }).strict()
    .refine((node) => (node.x === null) === (node.y === null), 'Give x and y as numbers to place the node, or both as null to forget its place.'))
    .min(1).max(BOARD_LIMITS.nodes),
}).strict();

const linkSchema = z.object({ op: z.literal('link'), from: nodeId, to: nodeId, label: boardFields.label.optional() }).strict();

const unlinkSchema = z.object({ op: z.literal('unlink'), id: uuid.optional(), from: nodeId.optional(), to: nodeId.optional() }).strict()
  .refine((change) => (change.id !== undefined && change.from === undefined && change.to === undefined)
    || (change.id === undefined && change.from !== undefined && change.to !== undefined), 'Name the link by its id, or by both of its ends (from and to).');

const SCHEMAS = {
  add_card: addCardSchema,
  update_card: updateCardSchema,
  remove_card: removeCardSchema,
  move: moveSchema,
  link: linkSchema,
  unlink: unlinkSchema,
} as const;

export type BoardChange = z.output<typeof addCardSchema> | z.output<typeof updateCardSchema> | z.output<typeof removeCardSchema>
  | z.output<typeof moveSchema> | z.output<typeof linkSchema> | z.output<typeof unlinkSchema>;

function describeIssue(issue: z.core.$ZodIssue, where: string): string {
  const field = issue.path.join('.');
  return `${where}${field ? `, ${field}` : ''}: ${issue.message}`;
}

/** Checks a list of changes against the schemas. Throws {@link BoardInputError} saying which change and field is wrong. */
export function parseBoardChanges(input: unknown): BoardChange[] {
  if (!Array.isArray(input) || input.length === 0) throw new BoardInputError('Give at least one change.');
  if (input.length > BOARD_LIMITS.changes) throw new BoardInputError(`At most ${BOARD_LIMITS.changes} changes can be made at once.`);
  return input.map((raw, index) => {
    const where = `Change ${index + 1}`;
    const op = isRecord(raw) && typeof raw.op === 'string' && Object.hasOwn(SCHEMAS, raw.op) ? raw.op as keyof typeof SCHEMAS : null;
    if (!op) throw new BoardInputError(`${where}: "op" must be one of ${Object.keys(SCHEMAS).join(', ')}.`);
    const result = SCHEMAS[op].safeParse(raw);
    if (!result.success) throw new BoardInputError(describeIssue(result.error.issues[0]!, where));
    return result.data as BoardChange;
  });
}

/** A change after the checks that need the disk, so the work under the lock is only the board itself. */
type Prepared = { change: BoardChange; filePath?: string; stepAreas?: Map<string, string> };

/** A file card names a file that exists inside the workspace and that the documents panel can open. */
async function checkCardFile(root: string, given: string): Promise<string> {
  const raw = given.trim().replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new BoardChangeError(`"${given}" is not inside the workspace. Give the path relative to the workspace folder, such as docs/overview.html.`);
  let name: string;
  try {
    name = openableDocumentName(raw);
  } catch (error) {
    throw new BoardChangeError(reason(error));
  }
  const absolute = path.join(root, ...name.split('/'));
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    await assertNoLinkedPathComponents(root, absolute);
    stat = await fs.lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new BoardChangeError(`There is no file "${name}" in the workspace. Write the file first, then add its card.`);
    if (/Linked path components|outside the allowed root/.test(reason(error))) throw new BoardChangeError(`"${name}" is, or sits inside, a link, which cannot be shown. Point at the real file inside the workspace.`);
    // Anything else (no permission, a failing disk) is not a fault in the request.
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BoardChangeError(stat.isDirectory() ? `"${name}" is a folder. Name a file.` : `"${name}" is not a regular file.`);
  return name;
}

/** The area each plan step is in (`checkpoint:<key>`, or `plan:own` for a loose step), by step key. Empty when the plan cannot be read. */
async function stepAreasOf(root: string): Promise<Map<string, string>> {
  const areas = new Map<string, string>();
  const { plan } = await readPlanFile(root).catch(() => ({ plan: undefined }));
  for (const step of plan?.steps ?? []) areas.set(step.key, 'plan:own');
  for (const checkpoint of plan?.checkpoints ?? []) for (const step of checkpoint.steps) areas.set(step.key, `checkpoint:${checkpoint.key}`);
  return areas;
}

async function prepare(root: string, changes: BoardChange[]): Promise<Prepared[]> {
  const prepared: Prepared[] = [];
  // The plan is read once, and only when a card's step or area is being set.
  let stepAreas: Map<string, string> | undefined;
  for (const change of changes) {
    const touchesStep = (change.op === 'add_card' && change.step !== undefined) || (change.op === 'update_card' && (change.step != null || typeof change.area === 'string'));
    if (touchesStep) stepAreas ??= await stepAreasOf(root);
    prepared.push({ change, ...(change.op === 'add_card' && change.kind === 'file' ? { filePath: await checkCardFile(root, change.path!) } : {}), ...(touchesStep ? { stepAreas } : {}) });
  }
  return prepared;
}

interface Applying { board: Board; by: string; now: string; log: BoardLogEntry[]; stepIsHint: boolean }

function findCard(board: Board, id: string): BoardCard {
  const card = board.cards.find((candidate) => candidate.id === id);
  if (!card) throw new BoardChangeError(`There is no card with id ${id} on the board. Read the board again.`);
  return card;
}

function setPosition(board: Board, id: string, at: BoardPoint): void {
  if (!(id in board.positions) && Object.keys(board.positions).length >= BOARD_LIMITS.positions) {
    throw new BoardChangeError(`The board already remembers ${BOARD_LIMITS.positions} positions, which is as many as it keeps.`);
  }
  board.positions[id] = { x: at.x, y: at.y };
}

/** The reason to look at a card as it is stored: on one line, cleaned like a title. */
function cleanLook(value: string): string {
  const look = cleanScreenText(value, BOARD_LIMITS.look);
  if (!look) throw new BoardChangeError('The reason to look cannot be empty.');
  return look;
}

/** The area for a card with `step`, when the plan knows the step: its area, unless the caller named another. */
function areaOfStep(stepAreas: Map<string, string> | undefined, step: string, given: string | undefined): string | undefined {
  const own = stepAreas?.get(step);
  if (own && given && given !== own) throw new BoardChangeError(`The step "${step}" is in ${own}, not ${given}. Leave the area out or use ${own}.`);
  return own ?? given;
}

function cleanTitle(value: string): string {
  const title = cleanScreenText(value, BOARD_LIMITS.title);
  if (!title) throw new BoardChangeError('A title cannot be empty.');
  return title;
}

/** Changes the working copy of the board. Throws, leaving the stored board as it was, when a change cannot be made. */
function apply({ board, by, now, log, stepIsHint }: Applying, { change, filePath, stepAreas }: Prepared): BoardChangeResult {
  const record = (id: string, text: string) => log.push({ at: now, by, revision: board.revision + 1, action: change.op, id, text });
  switch (change.op) {
    case 'add_card': {
      if (board.cards.length >= BOARD_LIMITS.cards) throw new BoardChangeError(`The board is full: it holds at most ${BOARD_LIMITS.cards} cards. Remove some first.`);
      const id = change.id ?? randomUUID();
      if (board.cards.some((card) => card.id === id)) throw new BoardChangeError(`A card with id ${id} is already on the board.`);
      const area = change.step && !stepIsHint ? areaOfStep(stepAreas, change.step, change.area) : change.area;
      const base = {
        id, pinned: change.pinned === true, archived: false, by, at: now, updatedBy: by, updatedAt: now,
        ...(area ? { area } : {}),
        ...(change.step ? { step: change.step } : {}),
        ...(change.look ? { look: cleanLook(change.look), lookAt: now } : {}),
      };
      const card: BoardCard = change.kind === 'note'
        ? { ...base, kind: 'note', title: cleanTitle(change.title!), body: cleanScreenBlock(change.body, BOARD_LIMITS.body) ?? '' }
        : { ...base, kind: 'file', path: filePath!, title: cleanTitle(change.title ?? filePath!.split('/').pop()!), description: cleanScreenBlock(change.description, BOARD_LIMITS.description) ?? '' };
      board.cards.push(card);
      if (change.position) setPosition(board, id, change.position);
      record(id, card.title);
      return { op: change.op, id };
    }
    case 'update_card': {
      const card = findCard(board, change.id);
      if (change.body !== undefined && card.kind !== 'note') throw new BoardChangeError('A file card has a description, not a body.');
      if (change.description !== undefined && card.kind !== 'file') throw new BoardChangeError('A note has a body, not a description.');
      if (change.title !== undefined) card.title = cleanTitle(change.title);
      if (change.body !== undefined && card.kind === 'note') card.body = cleanScreenBlock(change.body, BOARD_LIMITS.body) ?? '';
      if (change.description !== undefined && card.kind === 'file') card.description = cleanScreenBlock(change.description, BOARD_LIMITS.description) ?? '';
      if (change.pinned !== undefined) card.pinned = change.pinned;
      if (change.archived !== undefined) card.archived = change.archived;
      // The step decides the area: setting a step moves the card to the step's area, and moving the card out of it drops the step.
      // A step you give pins the card to its area. Clearing the area (null) of a card that has a step leaves the step as a hint.
      const area = change.step ? (areaOfStep(stepAreas, change.step, change.area ?? undefined) ?? change.area) : change.area;
      if (area === null) delete card.area;
      else if (area !== undefined) card.area = area;
      if (change.step === null) delete card.step;
      else if (change.step !== undefined) card.step = change.step;
      else if (change.area && card.step && stepAreas?.has(card.step) && stepAreas.get(card.step) !== change.area) delete card.step;
      if (change.look === null) { delete card.look; delete card.lookAt; }
      else if (change.look !== undefined) {
        const look = cleanLook(change.look);
        if (card.look !== look) card.lookAt = now;
        card.look = look;
      }
      card.updatedBy = by;
      card.updatedAt = now;
      record(card.id, card.title);
      return { op: change.op, id: card.id };
    }
    case 'remove_card': {
      const card = findCard(board, change.id);
      board.cards = board.cards.filter((candidate) => candidate.id !== card.id);
      board.links = board.links.filter((link) => link.from !== card.id && link.to !== card.id);
      delete board.positions[card.id];
      record(card.id, card.title);
      return { op: change.op, id: card.id };
    }
    case 'move': {
      const cardIds = new Set(board.cards.map((card) => card.id));
      let forgotten = 0;
      for (const node of change.nodes) {
        if (node.x === null || node.y === null) {
          delete board.positions[node.id];
          forgotten++;
          continue;
        }
        if (!onBoard(node.id, cardIds)) throw new BoardChangeError(`There is no card with id ${node.id} on the board to move. Read the board again.`);
        setPosition(board, node.id, { x: node.x, y: node.y });
      }
      const placed = change.nodes.length - forgotten;
      record(change.nodes[0]!.id, [placed ? `moved ${placed} ${placed === 1 ? 'node' : 'nodes'}` : '', forgotten ? `forgot ${forgotten} ${forgotten === 1 ? 'place' : 'places'}` : ''].filter(Boolean).join(', '));
      return { op: change.op, count: change.nodes.length };
    }
    case 'link': {
      if (change.from === change.to) throw new BoardChangeError('A link needs two different ends.');
      for (const end of [change.from, change.to]) if (isBoardId(end)) findCard(board, end);
      if (board.links.some((link) => link.from === change.from && link.to === change.to)) throw new BoardChangeError('Those two are already linked that way. Unlink them first to link them again.');
      if (board.links.length >= BOARD_LIMITS.links) throw new BoardChangeError(`The board already has ${BOARD_LIMITS.links} links, which is as many as it holds. Remove some first.`);
      const label = cleanScreenText(change.label, BOARD_LIMITS.label);
      const link: BoardLink = { id: randomUUID(), from: change.from, to: change.to, ...(label ? { label } : {}), by, at: now };
      board.links.push(link);
      record(link.id, `${link.from} → ${link.to}`);
      return { op: change.op, id: link.id };
    }
    case 'unlink': {
      const link = board.links.find((candidate) => (change.id !== undefined ? candidate.id === change.id : candidate.from === change.from && candidate.to === change.to));
      if (!link) throw new BoardChangeError('There is no such link on the board. Read the board again.');
      board.links = board.links.filter((candidate) => candidate !== link);
      record(link.id, `${link.from} → ${link.to}`);
      return { op: change.op, id: link.id };
    }
  }
}

// One queue for each workspace, so boards of different workspaces do not wait for each other.
const queues = new Map<string, ReturnType<typeof createMutationQueue>>();
function runMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  let queue = queues.get(root);
  if (!queue) queues.set(root, queue = createMutationQueue());
  return queue(operation);
}

const BUSY = 'The board is busy in another session. Retry.';

async function lockBoard(root: string) {
  try {
    return await acquireLock(path.join(root, '.contextspace', 'board.lock'), { staleMs: 60_000, timeoutMs: 10_000, timeoutMessage: BUSY });
  } catch (error) {
    throw error instanceof Error && error.message === BUSY ? new BoardConflictError(BUSY) : error;
  }
}

export interface BoardChangeOptions {
  /** Who makes the change: `user` from the app, or the name of the AI tool. */
  by: string;
  /** The revision the caller read. When given and no longer the board's, nothing is changed. */
  revision?: number;
  /** The step of an added card was filled in by the caller, not asked for: it is kept as a hint and does not pin the card to the step's area. Not part of any change a caller can send. */
  stepIsHint?: boolean;
}

/**
 * Applies changes to the board, all or none, under the lock and to the board as it is now. Returns the new board and,
 * for each change, what it made. The change is logged as made by `by`, and open screens are told to read the board again.
 * @throws {@link BoardInputError} when a change is not valid, {@link BoardChangeError} when a valid-looking change cannot
 * be made on this board (no such card, a limit reached, a file that is not there), {@link BoardConflictError} when
 * `revision` is stale or the board is busy, {@link BoardWorkspaceError} when the workspace is gone, an
 * `ArchivedWorkspaceError` when it is archived, and {@link BoardFileError} when the board file is not a board.
 */
export async function changeBoard(workspacePath: string, changes: unknown, options: BoardChangeOptions): Promise<{ board: Board; results: BoardChangeResult[] }> {
  const valid = parseBoardChanges(changes);
  const by = actor(options.by) ?? 'ai';
  const location = await locate(workspacePath);
  const prepared = await prepare(location.root, valid);

  const outcome = await runMutation(location.root, async () => {
    const release = await lockBoard(location.root);
    try {
      const feature = await loadFeatureConfig(location.root);
      if (!feature) throw new BoardWorkspaceError();
      assertWorkspaceActive(feature, 'change the board');
      const board = await readAt(location);
      if (options.revision !== undefined && options.revision !== board.revision) {
        throw new BoardConflictError(`The board changed in another session: it is at revision ${board.revision}, not ${options.revision}. Read it again, then repeat the change.`);
      }
      const log: BoardLogEntry[] = [];
      const now = new Date().toISOString();
      const results = prepared.map((item) => apply({ board, by, now, log, stepIsHint: options.stepIsHint === true }, item));
      board.revision += 1;
      await writeWorkspaceFile(location.root, location.featureId, BOARD_FILE, `${JSON.stringify(board, null, 2)}\n`);
      // The board is saved; a log that cannot be written must not make the caller repeat a change that was made.
      await appendLog(location, log).catch(() => undefined);
      return { board, results };
    } finally {
      await release();
    }
  });

  // Best effort, and after the lock: the change is made whether or not a screen hears of it.
  await appendScreenEvent(location.root, { harness: by, author: by === 'user' ? 'human' : 'agent', event: 'board', payload: { revision: outcome.board.revision, changes: valid.length } }).catch(() => undefined);
  return outcome;
}
