/**
 * The Board: the workspace's plan, documents and commits, and the cards people and AIs put on it, laid out as nodes
 * for the canvas. Pure, so the order, the grouping, the places and the caps are tested alone. Documents sit in a column
 * on the left, the plan's checkpoints follow in plan order (after a frame for the steps and decisions that sit outside
 * any checkpoint), and each repository's commits form a lane on the right. Cards that were given a place stand there;
 * the rest form a "From the board" band under the checkpoints, in the same columns, oldest first from the one the work
 * is on, so what the AI puts on the board sits by the work and never overlaps the rest, and a new card only takes the
 * next free place. A place saved for a document, checkpoint or commit moves it out of its column. Nothing here is saved: the same input
 * always gives the same board.
 */

import type { Edge, Node } from '@xyflow/react';
import type { WorkDocument } from '../../types.js';
import { stepsDone, type PlanFileDecision, type PlanFileStep, type PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import type { BoardCard, BoardLink, BoardPoint, BoardView } from './boardData.js';

/**
 * What a big workspace is cut to, so the board stays readable. The rest is counted, not drawn. The commits are the ones
 * "Since you last looked" lists, which the backend already cuts to 10 per repository (NEWS_LIMIT in core/whats-new),
 * so the cap of 12 only bites if that limit is raised. A real history of commits is a later slice.
 */
export const BOARD_LIMITS = { steps: 6, waiting: 3, commits: 12 } as const;

const COLUMN = 296;
const PAD = 12;

/**
 * Every node has a fixed size, so the layout is known before the browser measures anything and the board opens where
 * it should. The node components give their rows these same heights.
 */
export const BOARD_SIZE = {
  /** The width of a lane or a checkpoint frame. */
  column: COLUMN,
  pad: PAD,
  gap: 12,
  columnGap: 56,
  /** The width of a card, in a lane or on its own. */
  card: COLUMN - 2 * PAD,
  laneHeader: 52,
  laneNote: 40,
  laneMore: 24,
  document: 128,
  commit: 80,
  note: 160,
  file: 276,
  placeholder: 56,
  frameHeader: 92,
  stepRow: 24,
  decisionRow: 40,
  moreRow: 22,
} as const;

const { column, pad, gap, columnGap } = BOARD_SIZE;
const CARD_WIDTH = BOARD_SIZE.card;

/** How long a card made or changed by someone else is marked as new. */
export const FRESH_MS = 60_000;

export type LaneData = {
  title: string;
  caption: string;
  /** Why a lane is empty, when it could not be read. */
  note?: string;
  /** How many items the lane leaves out, and whether that is only a lower bound (the history was cut off). */
  more: number;
  moreAtLeast?: boolean;
};

export type BoardStep = { key: string; text: string; done: boolean };
export type BoardDecision = { key: string; question: string };

export type CheckpointData = {
  /** `plan`: the plan's own steps and decisions, which sit outside every checkpoint. It is never done. */
  kind: 'checkpoint' | 'plan';
  title: string;
  done: boolean;
  stepsDone: number;
  stepsTotal: number;
  /** The first steps, in plan order, up to the cap. */
  steps: BoardStep[];
  moreSteps: number;
  /** The decisions that wait for the user, up to the cap. */
  waiting: BoardDecision[];
  moreWaiting: number;
};

export type DocumentData = {
  title: string;
  role: WorkDocument['role'];
  status: WorkDocument['status'];
  summary: string;
  /** A superseded document is still there, but no longer what the work follows. */
  dimmed: boolean;
};

export type CommitData = { sha: string; subject: string; author: string; at: string };
/** What stands where a lane would be, when there is nothing to draw in it. */
export type PlaceholderData = { text: string };

/** What a file card shows of its file: a picture, or a kind of file to open. */
export type FileType = 'image' | 'html' | 'pdf' | 'markdown' | 'other';

/** What a note and a file card have in common. */
export type CardData = {
  title: string;
  /** A note's text, or a file card's description. */
  text: string;
  pinned: boolean;
  archived: boolean;
  by: string;
  at: string;
  updatedBy: string;
  updatedAt: string;
  /** Made or changed in the last minute by someone other than the user: it gets a brief highlight. */
  fresh: boolean;
};
export type NoteData = CardData;
export type FileCardData = CardData & { path: string; fileType: FileType };

export type LaneNode = Node<LaneData, 'lane'>;
export type CheckpointNode = Node<CheckpointData, 'checkpoint'>;
export type DocumentNode = Node<DocumentData, 'document'>;
export type CommitNode = Node<CommitData, 'commit'>;
export type PlaceholderNode = Node<PlaceholderData, 'placeholder'>;
export type NoteNode = Node<NoteData, 'note'>;
export type FileNode = Node<FileCardData, 'file'>;
export type BoardNode = LaneNode | CheckpointNode | DocumentNode | CommitNode | PlaceholderNode | NoteNode | FileNode;

export interface BoardSources {
  /** A source that is missing (still loading, or it failed) leaves its part of the board out. */
  plan?: PlanFileView;
  documents?: WorkDocument[];
  news?: WhatsNewView;
  /** The cards, lines and saved places. Without it only the plan, documents and commits are drawn. */
  board?: BoardView;
  /** Archived cards are left out, unless this is set; then they are drawn, dimmed. */
  showArchived?: boolean;
  /** The time "new" is measured from; now when not given. */
  now?: number;
}

/** Read-only for now: nothing can be moved, linked or picked. */
const FIXED = { draggable: false, selectable: false, connectable: false, deletable: false } as const;

/** Above the columns and the cards in them, so a card put on a column stays in front. A pinned card stays in front of the rest. */
const Z = { free: 5, card: 10, pinned: 20 } as const;

// ─── Node ids ───────────────────────────────────────────────────────────────

const COMMIT_ID = /^commit:(.+):([0-9a-f]{7,64})(#[0-9]{1,3})?$/;

/**
 * A reference to a node (the end of a line, the key of a saved place) matched against the nodes that are drawn. It is
 * the same id, or, for a commit, the same repository and a hash that begins the other one: a short hash written down
 * earlier still finds the commit when the board knows it by more digits, and the other way round.
 */
export function nodeResolver(nodeIds: Iterable<string>): (reference: string) => string | undefined {
  const known = new Set(nodeIds);
  const commits = new Map<string, Array<{ sha: string; id: string }>>();
  for (const id of known) {
    const parts = COMMIT_ID.exec(id);
    if (!parts) continue;
    const key = `${parts[1]}\n${parts[3] ?? ''}`;
    commits.set(key, [...(commits.get(key) ?? []), { sha: parts[2]!, id }]);
  }
  return (reference) => {
    if (known.has(reference)) return reference;
    const parts = COMMIT_ID.exec(reference);
    if (!parts) return undefined;
    const sha = parts[2]!;
    return commits.get(`${parts[1]}\n${parts[3] ?? ''}`)?.find((other) => other.sha.startsWith(sha) || sha.startsWith(other.sha))?.id;
  };
}

/** Two things with the same key (two checkpoints with one title) still get their own node. */
function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}#${n}`;
  taken.add(id);
  return id;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

const FILE_TYPES: ReadonlyArray<[FileType, RegExp]> = [
  ['image', /\.(?:png|jpe?g|gif|webp)$/i], ['html', /\.html?$/i], ['pdf', /\.pdf$/i], ['markdown', /\.(?:md|markdown)$/i],
];

/** What a file is shown as: pictures as themselves; the rest by a kind of file. Anything else (text, a deck) is "other". */
export function fileTypeOf(path: string): FileType {
  return FILE_TYPES.find(([, pattern]) => pattern.test(path))?.[0] ?? 'other';
}

/** "you" for a person at the app, else the name of the AI tool. */
export const authorName = (by: string) => (by === 'user' ? 'you' : by);

/** Made or changed in the last minute by someone other than the user. */
export function isFresh(card: Pick<BoardCard, 'updatedBy' | 'updatedAt'>, now: number): boolean {
  const at = Date.parse(card.updatedAt);
  return card.updatedBy !== 'user' && Number.isFinite(at) && Math.abs(now - at) < FRESH_MS;
}

/**
 * What a picture is called for someone who cannot see it: its title, unless that is only the file's name, which says
 * little; then the description does.
 */
export function imageAlt(card: { title: string; description: string; path: string }): string {
  const name = card.path.split('/').pop() ?? card.path;
  const description = card.description.trim().replace(/\s+/g, ' ');
  return card.title.trim().toLowerCase() === name.toLowerCase() && description ? description.slice(0, 160) : card.title;
}

/**
 * The oldest first, so a card that is added takes the next place and the ones already there keep theirs. The order they
 * came in decides between equals. A pinned card is not moved up for it: it shows by its mark and by standing in front.
 */
function cardOrder(cards: BoardCard[]): BoardCard[] {
  return cards.map((card, index) => ({ card, index, at: Date.parse(card.at) || 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ card }) => card);
}

type CardPlan = { id: string; type: 'note' | 'file'; height: number; data: NoteData | FileCardData; z: number };

function cardPlan(card: BoardCard, now: number): CardPlan {
  const common = {
    title: card.title, pinned: card.pinned, archived: card.archived, by: card.by, at: card.at, updatedBy: card.updatedBy, updatedAt: card.updatedAt,
    fresh: !card.archived && isFresh(card, now),
  };
  const z = card.pinned ? Z.pinned : Z.card;
  return card.kind === 'note'
    ? { id: card.id, type: 'note', height: BOARD_SIZE.note, data: { ...common, text: card.body }, z }
    : { id: card.id, type: 'file', height: BOARD_SIZE.file, data: { ...common, text: card.description, path: card.path, fileType: fileTypeOf(card.path) }, z };
}

// ─── Lanes ──────────────────────────────────────────────────────────────────

type LaneCard = { id: string; type: 'document' | 'commit' | 'placeholder' | 'note' | 'file'; height: number; data: DocumentData | CommitData | PlaceholderData | NoteData | FileCardData };

/**
 * A lane and its cards, one under the other, or in rows of `columns` when it is wider than one column, filled from column
 * `start` on and round to the first again. The cards belong to the lane, so they stay together.
 */
function lane(id: string, x: number, data: LaneData, cards: LaneCard[], options: { y?: number; columns?: number; start?: number } = {}): BoardNode[] {
  const columns = options.columns ?? 1;
  let y = BOARD_SIZE.laneHeader + (data.note ? BOARD_SIZE.laneNote : 0);
  const children: BoardNode[] = [];
  for (let start = 0; start < cards.length; start += columns) {
    const row = cards.slice(start, start + columns);
    row.forEach((card, index) => {
      const slot = (index + (options.start ?? 0)) % columns;
      children.push({ id: card.id, type: card.type, parentId: id, position: { x: pad + slot * (column + columnGap), y }, width: CARD_WIDTH, height: card.height, data: card.data, ...FIXED } as BoardNode);
    });
    y += Math.max(...row.map((card) => card.height)) + gap;
  }
  const height = y + (data.more ? BOARD_SIZE.laneMore : 0);
  return [{ id, type: 'lane', position: { x, y: options.y ?? 0 }, width: columns * column + (columns - 1) * columnGap, height, data, ...FIXED }, ...children];
}

/** A card that was put somewhere: it stands on its own at that place. */
function freeCard(card: LaneCard, at: BoardPoint, z: number = Z.free): BoardNode {
  return { id: card.id, type: card.type, position: { x: at.x, y: at.y }, width: CARD_WIDTH, height: card.height, data: card.data, zIndex: z, ...FIXED } as BoardNode;
}

/** Newest first. A commit with no readable time goes last, and the order the list came in decides between equals. */
function newestFirst<T extends { at: string }>(items: T[]): T[] {
  const time = (item: T) => { const at = Date.parse(item.at); return Number.isFinite(at) ? at : -Infinity; };
  return items.map((item, index) => ({ item, index, at: time(item) }))
    .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : a.index - b.index))
    .map(({ item }) => item);
}

/** How far back the commits reach, as the list says so itself: since the last look, or the last few days. */
function commitsSince(news: WhatsNewView): { caption: string; none: (others: boolean) => string } {
  const which = (others: boolean) => (others ? 'in the other repositories' : '');
  const say = (parts: string[]) => parts.filter(Boolean).join(' ');
  if (news.basis === 'first-look') {
    const days = Math.max(1, Math.round((Date.parse(news.at) - Date.parse(news.from)) / 86_400_000));
    const span = `in the last ${days} ${days === 1 ? 'day' : 'days'}`;
    return { caption: `From the last ${days} ${days === 1 ? 'day' : 'days'}`, none: (others) => `${say(['No commits', which(others), span])}.` };
  }
  if (news.basis === 'time') return { caption: 'New since the time asked for', none: (others) => `${say(['No new commits', which(others), 'since the time asked for'])}.` };
  return { caption: 'New since you last looked', none: (others) => `${say(['No new commits', which(others), 'since you last looked'])}.` };
}

/** What a lane says it leaves out: "+4 more", or "90+ more" when the count is only a lower bound. */
export function moreText(more: number, atLeast = false): string {
  return atLeast ? `${more}+ more` : `+${more} more`;
}

/** The frame the work is on: the first checkpoint that is not done, else the last one (all done), else the plan's own frame. */
export function currentFrame<T extends CheckpointNode>(frames: T[]): T | undefined {
  const checkpoints = frames.filter((entry) => entry.data.kind === 'checkpoint');
  return checkpoints.find((entry) => !entry.data.done) ?? checkpoints.at(-1) ?? frames[0];
}

/** How tall a frame is for this many steps and waiting decisions, each cut to its cap. A frame with no steps says so in one row. */
function frameHeight(stepCount: number, waitingCount: number): number {
  const steps = Math.min(stepCount, BOARD_LIMITS.steps);
  const waiting = Math.min(waitingCount, BOARD_LIMITS.waiting);
  return BOARD_SIZE.frameHeader
    + waiting * BOARD_SIZE.decisionRow + (waitingCount > waiting ? BOARD_SIZE.moreRow : 0)
    + Math.max(1, steps) * BOARD_SIZE.stepRow + (stepCount > steps ? BOARD_SIZE.moreRow : 0)
    + pad;
}

/** A frame of steps and the decisions that wait, for a checkpoint or for the plan's own loose items. */
function frame(kind: CheckpointData['kind'], id: string, x: number, title: string, done: boolean, items: { steps: PlanFileStep[]; decisions: PlanFileDecision[] }, waitingKeys: Set<string>): CheckpointNode {
  const { done: stepsComplete, total } = stepsDone(items);
  const waiting = items.decisions.filter((decision) => waitingKeys.has(decision.key));
  const shownWaiting = waiting.slice(0, BOARD_LIMITS.waiting);
  const steps = items.steps.slice(0, BOARD_LIMITS.steps);
  const moreSteps = items.steps.length - steps.length;
  const moreWaiting = waiting.length - shownWaiting.length;
  const height = frameHeight(items.steps.length, waiting.length);
  return {
    id, type: 'checkpoint', position: { x, y: 0 }, width: column, height, ...FIXED,
    data: {
      kind, title, done, stepsDone: stepsComplete, stepsTotal: total,
      steps: steps.map(({ key, text, done: stepDone }) => ({ key, text, done: stepDone })), moreSteps,
      waiting: shownWaiting.map(({ key, question }) => ({ key, question })), moreWaiting,
    },
  };
}

/**
 * The board's nodes: a Documents lane, then a Plan frame for the plan's own steps and waiting decisions (only when it
 * has any), then one frame per checkpoint in plan order, then one lane per repository that has commits (or could not
 * be read), then the "From the board" band for the cards that were not given a place. A part with nothing to show is
 * left out, except that a board with other content and no commits says so in one placeholder card, so the missing lane
 * is not a puzzle (but not when no repository could be read, which the lanes already say). Parents come before their
 * cards, which is the order the canvas needs. A document, checkpoint, commit or card with a saved place stands there,
 * and its column closes up around the gap.
 */
export function boardLayout({ plan, documents, news, board, showArchived = false, now = Date.now() }: BoardSources): BoardNode[] {
  const nodes: BoardNode[] = [];
  const taken = new Set<string>();
  let x = 0;
  const next = () => { const at = x; x += column + columnGap; return at; };

  // First the ids of everything the board draws by itself, so a saved place or a card's line can find it by prefix.
  const documentCards: LaneCard[] = (documents ?? []).map((document) => ({
    id: uniqueId(`document:${document.id}`, taken), type: 'document' as const, height: BOARD_SIZE.document,
    data: { title: document.title, role: document.role, status: document.status, summary: document.summary, dimmed: document.status === 'superseded' },
  }));
  const frames: CheckpointNode[] = [];
  /** How tall each frame would be with every one of its decisions waiting: the room the band under them keeps clear, so ticking a checkpoint does not move it. */
  const reserved = new Map<string, number>();
  if (plan) {
    const waitingKeys = new Set(plan.waiting);
    // The plan's own steps and decisions belong to no checkpoint, so they get a frame of their own, ahead of the checkpoints.
    if (plan.steps.length > 0 || plan.decisions.some((decision) => waitingKeys.has(decision.key))) {
      frames.push(frame('plan', uniqueId('plan:own', taken), 0, 'Plan', false, plan, waitingKeys));
      reserved.set(frames[0]!.id, frameHeight(plan.steps.length, plan.decisions.length));
    }
    for (const checkpoint of plan.checkpoints) {
      const entry = frame('checkpoint', uniqueId(`checkpoint:${checkpoint.key}`, taken), 0, checkpoint.title, checkpoint.done, checkpoint, waitingKeys);
      frames.push(entry);
      reserved.set(entry.id, frameHeight(checkpoint.steps.length, checkpoint.decisions.length));
    }
  }
  const repos = (news?.commits ?? []).filter((repo) => repo.commits.length || repo.problem).map((repo) => {
    const commits = newestFirst(repo.commits).slice(0, BOARD_LIMITS.commits);
    return {
      repo, commits, laneId: uniqueId(`lane:commits:${repo.repo}`, taken),
      cards: commits.map((commit): LaneCard => ({
        id: uniqueId(`commit:${repo.repo}:${commit.sha}`, taken), type: 'commit', height: BOARD_SIZE.commit,
        data: { sha: commit.sha.slice(0, 7), subject: commit.subject, author: commit.author, at: commit.at },
      })),
    };
  });

  // Where each of them was put, if it was: by the id it has on the board, whichever way the saved place wrote it.
  const generated = [...documentCards, ...frames.filter((entry) => entry.data.kind === 'checkpoint'), ...repos.flatMap((entry) => entry.cards)];
  const resolve = nodeResolver(generated.map((entry) => entry.id));
  const saved = new Map<string, BoardPoint>();
  for (const [key, point] of Object.entries(board?.positions ?? {})) {
    const id = resolve(key);
    if (id !== undefined && (key === id || !saved.has(id))) saved.set(id, point);
  }
  const free: BoardNode[] = [];
  /** The cards of a lane that were not put elsewhere; the others stand on their own. */
  const stay = (cards: LaneCard[]) => cards.filter((card) => {
    const at = saved.get(card.id);
    if (at) free.push(freeCard(card, at));
    return !at;
  });

  const staying = stay(documentCards);
  if (staying.length) nodes.push(...lane('lane:documents', next(), { title: 'Documents', caption: 'Source documents', more: 0 }, staying));

  /** The frames that stand in the row of columns: the cards that have no place go under them. */
  const row: CheckpointNode[] = [];
  for (const entry of frames) {
    const at = entry.data.kind === 'checkpoint' ? saved.get(entry.id) : undefined;
    const placed = { ...entry, position: at ?? { x: next(), y: 0 } };
    // A frame put elsewhere leaves no gap in the row either.
    if (at) free.push({ ...placed, zIndex: Z.free }); else { nodes.push(placed); row.push(placed); }
  }

  if (news) {
    const since = commitsSince(news);
    const problems = news.commits.filter((repo) => !repo.commits.length && repo.problem);
    // The commits are only the new ones, so an empty lane is the usual case. Say so, but never on a board with nothing
    // else, and never when no repository could be read: the lanes of the ones that could not say so already.
    const unreadable = problems.length > 0 && problems.length === news.commits.length;
    if (!news.commits.some((repo) => repo.commits.length) && (nodes.length > 0 || problems.length > 0) && !unreadable) {
      nodes.push(...lane(uniqueId('lane:commits', taken), next(), { title: 'Commits', caption: since.caption, more: 0 }, [
        { id: uniqueId('placeholder:commits', taken), type: 'placeholder' as const, height: BOARD_SIZE.placeholder, data: { text: since.none(problems.length > 0) } },
      ]));
    }
    for (const { repo, commits, laneId, cards } of repos) {
      const staying = stay(cards);
      const more = repo.more + repo.commits.length - commits.length;
      // Every commit of a repository that was put elsewhere leaves its lane empty, so the lane goes too, unless it has something to say.
      if (!staying.length && !repo.problem && !more) continue;
      nodes.push(...lane(laneId, next(), {
        title: repo.repo, caption: since.caption, more,
        ...(repo.moreAtLeast ? { moreAtLeast: true } : {}),
        ...(repo.problem ? { note: `Could not be read: ${repo.problem}` } : {}),
      }, staying));
    }
  }

  // The cards. A saved place wins over the band; the rest are in a band of their own under the checkpoints, in the same
  // columns, oldest first from the checkpoint the work is on and on to the right of it, round to the first, so what is put
  // on the board stands by the work and never over the columns beside it. A new card takes the next free place and moves
  // none; only the work moving on to the next checkpoint moves the band, as one block. With no checkpoints in the row
  // there is nothing to stand under, and the band is a column after the last one.
  const positions = new Map(Object.entries(board?.positions ?? {}));
  const unplaced: LaneCard[] = [];
  for (const card of cardOrder((board?.cards ?? []).filter((entry) => showArchived || !entry.archived))) {
    const entry = cardPlan(card, now);
    const at = positions.get(card.id);
    if (at) free.push(freeCard(entry, at, entry.z)); else unplaced.push(entry);
  }
  nodes.push(...free);
  if (unplaced.length) {
    const data = { title: 'From the board', caption: 'Notes and files from you and the AI', more: 0 };
    nodes.push(...(row.length
      ? lane('lane:board', row[0]!.position.x, data, unplaced, {
        columns: row.length, y: Math.max(...row.map((entry) => reserved.get(entry.id) ?? entry.height!)) + columnGap,
        start: Math.max(0, row.findIndex((entry) => entry.id === currentFrame(frames)?.id)),
      })
      : lane('lane:board', next(), data, unplaced)));
  }

  return nodes;
}

// ─── Where things are, and the lines between them ───────────────────────────

export interface Rect { x: number; y: number; width: number; height: number }

/** Where each node is on the canvas. A card in a lane is placed by its lane, which comes before it. */
export function nodeRects(nodes: BoardNode[]): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  for (const node of nodes) {
    const parent = node.parentId ? rects.get(node.parentId) : undefined;
    rects.set(node.id, { x: (parent?.x ?? 0) + node.position.x, y: (parent?.y ?? 0) + node.position.y, width: node.width ?? CARD_WIDTH, height: node.height ?? 0 });
  }
  return rects;
}

export type Side = 'top' | 'right' | 'bottom' | 'left';

/** The sides a line leaves one rectangle and enters the other by: the facing ones, across the larger gap. */
export function sidesBetween(from: Rect, to: Rect): [Side, Side] {
  const gapX = Math.max(to.x - (from.x + from.width), from.x - (to.x + to.width));
  const gapY = Math.max(to.y - (from.y + from.height), from.y - (to.y + to.height));
  if (gapX >= gapY) return from.x + from.width / 2 <= to.x + to.width / 2 ? ['right', 'left'] : ['left', 'right'];
  return from.y + from.height / 2 <= to.y + to.height / 2 ? ['bottom', 'top'] : ['top', 'bottom'];
}

/** What a node is called in words, for the line that joins it. */
function nodeTitle(node: BoardNode): string {
  switch (node.type) {
    case 'commit': return `commit ${node.data.sha}`;
    case 'lane': case 'placeholder': return node.id;
    default: return node.data.title;
  }
}

/**
 * The lines between the things that are on the board. A line to a thing that is not there (a commit that has left the
 * recent ones, a checkpoint that was renamed, an archived card that is hidden) is skipped, without a word: it comes back
 * with the thing. Each line leaves and enters by the sides that face each other.
 */
export function boardEdges(nodes: BoardNode[], links: BoardLink[]): Edge[] {
  if (!links.length) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rects = nodeRects(nodes);
  const resolve = nodeResolver(byId.keys());
  const edges: Edge[] = [];
  for (const link of links) {
    const source = resolve(link.from);
    const target = resolve(link.to);
    if (source === undefined || target === undefined || source === target) continue;
    const [from, to] = sidesBetween(rects.get(source)!, rects.get(target)!);
    edges.push({
      id: link.id, source, target, sourceHandle: from, targetHandle: to,
      ...(link.label ? { label: link.label } : {}),
      ariaLabel: `Link from ${nodeTitle(byId.get(source)!)} to ${nodeTitle(byId.get(target)!)}${link.label ? `: ${link.label}` : ''}`,
      focusable: false, selectable: false, deletable: false, reconnectable: false,
    });
  }
  return edges;
}
