/**
 * What people and AIs put on the board, as GET /api/workspace/:id/board sends it (core/board): note and file cards,
 * the lines between things, and where things were put. The board is drawn from this, and an AI can write to it, so
 * nothing is trusted just for arriving: the reply is rebuilt field by field and anything unusable is dropped.
 */

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';

/** The same limits as the backend, so a reply cannot make the board draw more than the board allows. */
export const BOARD_DATA_LIMITS = { cards: 500, links: 1000, positions: 2000, title: 200, text: 4000, label: 200, path: 1000, coordinate: 1_000_000 } as const;

interface CardBase {
  /** A uuid. It is also the card's node id. */
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  /** `user`, or the name of the AI tool. */
  by: string;
  at: string;
  updatedBy: string;
  updatedAt: string;
}
export interface BoardNoteCard extends CardBase { kind: 'note'; body: string }
export interface BoardFileCard extends CardBase {
  kind: 'file';
  /** A file in the workspace that the documents panel can open, relative to the workspace folder. */
  path: string;
  description: string;
}
export type BoardCard = BoardNoteCard | BoardFileCard;

export interface BoardLink {
  id: string;
  /** Node ids: a card, or a checkpoint, document or commit of the board. */
  from: string;
  to: string;
  label?: string;
  by: string;
  at: string;
}

export interface BoardPoint { x: number; y: number }

export interface BoardView {
  revision: number;
  cards: BoardCard[];
  links: BoardLink[];
  /** By node id. The file may hold a place for a checkpoint, document or commit too, but the app uses only the places of cards. */
  positions: Record<string, BoardPoint>;
}

// ─── Node ids ───────────────────────────────────────────────────────────────

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`);
// The board adds `#2` when two generated nodes would otherwise share an id.
const COPY = '(?:#[0-9]{1,3})?';
const CHECKPOINT = new RegExp(`^checkpoint:[\\p{L}\\p{N}][\\p{L}\\p{N}-]{0,89}${COPY}$`, 'u');
const DOCUMENT = new RegExp(`^document:${UUID_SOURCE}${COPY}$`);
const COMMIT = new RegExp(`^commit:[^\\\\/\\u0000-\\u001f\\u007f]{1,200}:[0-9a-f]{7,64}${COPY}$`);

/** Whether `value` is a card's id (a uuid). A card id can never read as a generated node's id, which has a prefix. */
export const isCardId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Whether `value` has the shape of a node id the board accepts: a card, or a checkpoint, document or commit. */
export function isBoardNodeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 400 && (UUID.test(value) || CHECKPOINT.test(value) || DOCUMENT.test(value) || COMMIT.test(value));
}

// ─── Rebuilding the reply ───────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
/** The name of the AI tool, or `user`: the only form the backend writes. */
const actor = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(value);

/** Text that is there and not only spaces, cut to `max`. */
function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : null;
}

/** A file card's path, or null when it is not a plain path inside the workspace: not absolute, no `.` or `..` part. */
export function cleanCardPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > BOARD_DATA_LIMITS.path) return null;
  const path = value.trim().replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return null;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') ? path : null;
}

function cleanCard(raw: unknown): BoardCard | null {
  if (!isRecord(raw) || !isCardId(raw.id) || !actor(raw.by) || !validTime(raw.at)) return null;
  const title = text(raw.title, BOARD_DATA_LIMITS.title);
  if (!title) return null;
  const base = {
    id: raw.id, title, pinned: raw.pinned === true, archived: raw.archived === true, by: raw.by, at: raw.at,
    updatedBy: actor(raw.updatedBy) ? raw.updatedBy : raw.by, updatedAt: validTime(raw.updatedAt) ? raw.updatedAt : raw.at,
  };
  if (raw.kind === 'note') return { ...base, kind: 'note', body: typeof raw.body === 'string' ? raw.body.slice(0, BOARD_DATA_LIMITS.text) : '' };
  if (raw.kind === 'file') {
    const path = cleanCardPath(raw.path);
    return path ? { ...base, kind: 'file', path, description: typeof raw.description === 'string' ? raw.description.slice(0, BOARD_DATA_LIMITS.text) : '' } : null;
  }
  return null;
}

function cleanLink(raw: unknown): BoardLink | null {
  if (!isRecord(raw) || !isCardId(raw.id) || !isBoardNodeId(raw.from) || !isBoardNodeId(raw.to) || raw.from === raw.to || !actor(raw.by) || !validTime(raw.at)) return null;
  const label = text(raw.label, BOARD_DATA_LIMITS.label);
  return { id: raw.id, from: raw.from, to: raw.to, ...(label ? { label } : {}), by: raw.by, at: raw.at };
}

function cleanPoint(raw: unknown): BoardPoint | null {
  if (!isRecord(raw)) return null;
  const { x, y } = raw;
  const inRange = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= BOARD_DATA_LIMITS.coordinate;
  return inRange(x) && inRange(y) ? { x, y } : null;
}

/**
 * The board rebuilt from a reply. A card, line or place that is not usable is dropped, as are repeats and anything
 * past the limits. A reply that is not a board at all is refused, so an older backend that answers this address with
 * something else is told apart from an empty board.
 */
export function cleanBoard(raw: unknown): BoardView {
  if (!isRecord(raw) || typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.cards)) {
    throw new Error('the board came back in a form this version of the app does not read');
  }
  const cards: BoardCard[] = [];
  const cardIds = new Set<string>();
  for (const entry of raw.cards) {
    const card = cards.length < BOARD_DATA_LIMITS.cards ? cleanCard(entry) : null;
    if (card && !cardIds.has(card.id)) { cards.push(card); cardIds.add(card.id); }
  }

  const links: BoardLink[] = [];
  const linkIds = new Set<string>();
  for (const entry of Array.isArray(raw.links) ? raw.links : []) {
    const link = links.length < BOARD_DATA_LIMITS.links ? cleanLink(entry) : null;
    if (link && !linkIds.has(link.id)) { links.push(link); linkIds.add(link.id); }
  }

  // Keys are checked for the shape of a node id, which also keeps names like `__proto__` out of the object.
  const positions: Record<string, BoardPoint> = {};
  let kept = 0;
  for (const [id, value] of isRecord(raw.positions) ? Object.entries(raw.positions) : []) {
    const point = kept < BOARD_DATA_LIMITS.positions && isBoardNodeId(id) ? cleanPoint(value) : null;
    if (point) { positions[id] = point; kept += 1; }
  }
  return { revision: raw.revision, cards, links, positions };
}

export const boardKey = (workspace: string | null) => ['board', workspace] as const;

/**
 * The board, read again when a board event arrives on the live feed and whenever the feed connects (liveFeedHub). While
 * the board is shown and the feed is not connected (the backend is not answering, or the stream has not opened yet) it
 * is also read every half minute, so it does not stand still for someone watching an AI work.
 */
export function useBoard(workspace: string | null, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: boardKey(workspace),
    queryFn: async ({ signal }) => cleanBoard(await apiFetch<unknown>(`/api/workspace/${encodeURIComponent(workspace!)}/board`, { signal })),
    enabled: Boolean(workspace),
    staleTime: 5000,
    refetchInterval: options.poll ? 30_000 : false,
  });
}
