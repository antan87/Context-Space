/**
 * The Board: the workspace's plan, documents and commits, and the cards people and AIs put on it, laid out as nodes
 * for the canvas. Pure, so the order, the grouping, the places and the caps are tested alone. Documents sit in a column
 * on the left, the plan's checkpoints follow in plan order (after a frame for the steps and decisions that sit outside
 * any checkpoint), and each repository's commits form a lane on the right. Each of those is a group, and a group is
 * either open, with its details, or folded into one small summary at the top of its column: the board reads as the big
 * picture first, with only the work that is under way open, and the rest opens where it is when it is pressed. The
 * columns keep their places either way; only what is under a group that opens or folds steps down or up. Cards that
 * were given a place stand there (drawn clear of every group, as big as it is when it is open, whether it is open or not,
 * so everyone sees a card in the same place whatever they have folded); the rest form a "From the board" band under the
 * checkpoints, in the same columns, oldest first from the first, under the tallest a frame can be when it is open, so
 * nothing that is opened, folded or ticked, and no move of the work, ever moves a card of the band, and a new card only
 * takes the next free place. Only cards have places of their own: the app puts checkpoints, documents and commits where
 * they belong, and a place saved for one of them is ignored. Nothing here is saved: the same input always gives the
 * same board.
 */

import type { Edge, Node } from '@xyflow/react';
import type { WorkDocument } from '../../types.js';
import { stepsDone, type PlanFileDecision, type PlanFileStep, type PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';
import type { BoardCard, BoardLink, BoardPoint, BoardView } from './boardData.js';
import { groupOpen, type Folds } from './boardFolds.js';

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
  /** A group that is folded: one summary, the same height for every kind of group, so the columns line up. */
  folded: 104,
  stepRow: 24,
  decisionRow: 40,
  moreRow: 22,
} as const;

const { column, pad, gap, columnGap } = BOARD_SIZE;
const CARD_WIDTH = BOARD_SIZE.card;

/** How long a card made or changed by someone else is marked as new. */
export const FRESH_MS = 60_000;

/** What a folded group says of itself: a headline, up to two lines under it, and a warning when what it shows is not the whole of it. */
export type GroupSummary = { headline: string; detail?: string; byline?: string; warning?: string };

/** A lane that can fold: whether it is open, what it says folded, and which nodes it stands for then. */
export type LaneGroup = {
  open: boolean;
  summary: GroupSummary;
  /** How tall the lane is when it is open, folded or not: the room a card with a place of its own keeps clear. */
  openHeight: number;
  /** The cards of the lane when it is folded and they are not drawn, so a line to one of them goes to the lane. */
  holds: string[];
};

export type LaneData = {
  title: string;
  caption: string;
  /** Why a lane is empty, when it could not be read. */
  note?: string;
  /** How many items the lane leaves out, and whether that is only a lower bound (the history was cut off). */
  more: number;
  moreAtLeast?: boolean;
  /** Only the lanes whose cards fold away (the documents, a repository's commits). */
  group?: LaneGroup;
};

export type BoardStep = { key: string; text: string; done: boolean };
export type BoardDecision = { key: string; question: string };

export type CheckpointData = {
  /** `plan`: the plan's own steps and decisions, which sit outside every checkpoint. It is never done. */
  kind: 'checkpoint' | 'plan';
  /** Open, with its steps, or folded into a summary of the same data. */
  open: boolean;
  /** How tall the frame is when it is open, folded or not, with every one of its decisions waiting: the room under it that stays clear. */
  openHeight: number;
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
  /** The id of the source document, to read it by. */
  sourceId: string;
  /** What it is kept as, in the workspace (a stored text document), or the link it stands for. A document has one of the two. */
  filename?: string;
  url?: string;
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
  /** What the user opened or folded against the default, by group id (boardFolds). Without it the work under way is open and the rest folded. */
  folds?: Folds;
}

/** Nothing is linked or picked, and nothing can be moved here: the cards that may be dragged are marked by `withMoves` (boardMoves). */
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
 * A lane and its cards, one under the other, or in rows of `columns` when it is wider than one column, filled from the
 * first column. The cards belong to the lane, so they stay together. A lane that folds (`group`) and is folded is one
 * summary and its cards are not drawn.
 */
function lane(id: string, x: number, data: LaneData, cards: LaneCard[], options: { y?: number; columns?: number; group?: Omit<LaneGroup, 'holds' | 'openHeight'> } = {}): BoardNode[] {
  const columns = options.columns ?? 1;
  let y = BOARD_SIZE.laneHeader + (data.note ? BOARD_SIZE.laneNote : 0);
  const children: BoardNode[] = [];
  for (let start = 0; start < cards.length; start += columns) {
    const row = cards.slice(start, start + columns);
    row.forEach((card, index) => {
      const slot = index;
      children.push({ id: card.id, type: card.type, parentId: id, position: { x: pad + slot * (column + columnGap), y }, width: CARD_WIDTH, height: card.height, data: card.data, ...FIXED } as BoardNode);
    });
    y += Math.max(...row.map((card) => card.height)) + gap;
  }
  const height = y + (data.more ? BOARD_SIZE.laneMore : 0);
  if (options.group && !options.group.open) {
    const group = { ...options.group, openHeight: height, holds: cards.map((card) => card.id) };
    return [{ id, type: 'lane', position: { x, y: options.y ?? 0 }, width: column, height: BOARD_SIZE.folded, data: { ...data, group }, ...FIXED }];
  }
  const open = options.group && { ...options.group, openHeight: height, holds: [] };
  return [{ id, type: 'lane', position: { x, y: options.y ?? 0 }, width: columns * column + (columns - 1) * columnGap, height, data: open ? { ...data, group: open } : data, ...FIXED }, ...children];
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
function commitsSince(news: WhatsNewView): { caption: string; none: (others: boolean) => string; count: (n: number, atLeast?: boolean) => string } {
  const which = (others: boolean) => (others ? 'in the other repositories' : '');
  const say = (parts: string[]) => parts.filter(Boolean).join(' ');
  const plus = (n: number, atLeast?: boolean) => `${n}${atLeast ? '+' : ''}`;
  if (news.basis === 'first-look') {
    const days = Math.max(1, Math.round((Date.parse(news.at) - Date.parse(news.from)) / 86_400_000));
    const span = `in the last ${days} ${days === 1 ? 'day' : 'days'}`;
    return { caption: `From the last ${days} ${days === 1 ? 'day' : 'days'}`, none: (others) => `${say(['No commits', which(others), span])}.`, count: (n, atLeast) => `${plus(n, atLeast)} ${span}` };
  }
  if (news.basis === 'time') return { caption: 'New since the time asked for', none: (others) => `${say(['No new commits', which(others), 'since the time asked for'])}.`, count: (n, atLeast) => `${plus(n, atLeast)} new since the time asked for` };
  return { caption: 'New since you last looked', none: (others) => `${say(['No new commits', which(others), 'since you last looked'])}.`, count: (n, atLeast) => `${plus(n, atLeast)} new since you last looked` };
}

/** What the documents column says folded: how many there are, and how many are not settled. */
function documentsSummary(documents: WorkDocument[]): GroupSummary {
  const drafts = documents.filter((document) => document.status === 'draft').length;
  const superseded = documents.filter((document) => document.status === 'superseded').length;
  const detail = [drafts > 0 ? `${drafts} ${drafts === 1 ? 'draft' : 'drafts'}` : '', superseded > 0 ? `${superseded} superseded` : ''].filter(Boolean).join(' · ');
  return { headline: `${documents.length} ${documents.length === 1 ? 'document' : 'documents'}`, ...(detail ? { detail } : {}) };
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

/** A frame of steps and the decisions that wait, for a checkpoint or for the plan's own loose items. It is drawn open; `fold` closes it. */
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
      kind, open: true, openHeight: frameHeight(items.steps.length, items.decisions.length), title, done, stepsDone: stepsComplete, stepsTotal: total,
      steps: steps.map(({ key, text, done: stepDone }) => ({ key, text, done: stepDone })), moreSteps,
      waiting: shownWaiting.map(({ key, question }) => ({ key, question })), moreWaiting,
    },
  };
}

/** Whether two rectangles share any area. */
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where a card of this size that was put at `at` stands: clear of every group as it is when open, folded or not, so a card
 * put under a summary is not under the group's steps when it opens, and everyone sees it in the same place whatever they
 * have folded. A card in the way is put just below the group, and below the band of cards too if that is then in its way.
 * A place that is clear is returned as it is, and a place that was cleared is clear, so clearing twice changes nothing.
 * `nodes` are the board's nodes (`boardLayout`).
 */
export function clearPlace(nodes: BoardNode[], at: BoardPoint, size: { width: number; height: number }): BoardPoint {
  const rects = nodeRects(nodes);
  const groups = nodes.filter(isGroup).map((node) => ({ ...rects.get(node.id)!, height: node.type === 'checkpoint' ? node.data.openHeight : node.data.group!.openHeight }));
  const band = rects.get('lane:board');
  let y = at.y;
  let moved = false;
  for (;;) {
    const here = { x: at.x, y, width: size.width, height: size.height };
    const hit = groups.filter((group) => overlaps(here, group));
    if (moved && band && overlaps(here, band)) hit.push(band);
    if (hit.length === 0) return moved ? { x: at.x, y } : at;
    y = Math.max(...hit.map((rect) => rect.y + rect.height)) + gap;
    moved = true;
  }
}

/** The cards with a place of their own, drawn where `clearPlace` puts them. Only the drawing changes: the saved place is as it was. */
function clearOfGroups(nodes: BoardNode[]): BoardNode[] {
  if (!nodes.some(isGroup)) return nodes;
  return nodes.map((node) => {
    if (node.parentId !== undefined || (node.type !== 'note' && node.type !== 'file')) return node;
    const at = clearPlace(nodes, node.position, { width: node.width ?? CARD_WIDTH, height: node.height ?? 0 });
    return at === node.position ? node : { ...node, position: at };
  });
}

/** A frame as it is when the user has folded it: the same data, in a summary of a fixed, small height. */
function fold(entry: CheckpointNode): CheckpointNode {
  return { ...entry, height: BOARD_SIZE.folded, data: { ...entry.data, open: false } };
}

/**
 * The board's nodes: a Documents lane, then a Plan frame for the plan's own steps and waiting decisions (only when it
 * has any), then one frame per checkpoint in plan order, then one lane per repository that has commits (or could not
 * be read), then the "From the board" band for the cards that were not given a place. A part with nothing to show is
 * left out, except that a board with other content and no commits says so in one placeholder card, so the missing lane
 * is not a puzzle (but not when no repository could be read, which the lanes already say). Parents come before their
 * cards, which is the order the canvas needs. Each frame and each lane with commits or documents is open or folded
 * (`folds` over the default: the frame the work is on is open); a folded one is a single summary node and its cards are
 * not drawn. A card with a saved place stands there; a document, checkpoint or commit never does.
 */
export function boardLayout({ plan, documents, news, board, showArchived = false, now = Date.now(), folds }: BoardSources): BoardNode[] {
  const nodes: BoardNode[] = [];
  const taken = new Set<string>();
  let x = 0;
  const next = () => { const at = x; x += column + columnGap; return at; };

  // First the ids of everything the board draws by itself, so a card's line can find it by prefix.
  const documentCards: LaneCard[] = (documents ?? []).map((document) => ({
    id: uniqueId(`document:${document.id}`, taken), type: 'document' as const, height: BOARD_SIZE.document,
    data: {
      title: document.title, role: document.role, status: document.status, summary: document.summary, dimmed: document.status === 'superseded',
      sourceId: document.id, ...(document.filename ? { filename: document.filename } : {}), ...(document.url ? { url: document.url } : {}),
    },
  }));
  const frames: CheckpointNode[] = [];
  if (plan) {
    const waitingKeys = new Set(plan.waiting);
    // The plan's own steps and decisions belong to no checkpoint, so they get a frame of their own, ahead of the checkpoints.
    if (plan.steps.length > 0 || plan.decisions.some((decision) => waitingKeys.has(decision.key))) {
      frames.push(frame('plan', uniqueId('plan:own', taken), 0, 'Plan', false, plan, waitingKeys));
    }
    for (const checkpoint of plan.checkpoints) {
      const entry = frame('checkpoint', uniqueId(`checkpoint:${checkpoint.key}`, taken), 0, checkpoint.title, checkpoint.done, checkpoint, waitingKeys);
      frames.push(entry);
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

  // The frame the work is on is open; every other group is folded, unless the user chose otherwise.
  const current = currentFrame(frames)?.id;
  const isOpen = (id: string) => groupOpen(id, current, folds);
  const placed = frames.map((entry) => (isOpen(entry.id) ? entry : fold(entry)));

  const documentsId = 'lane:documents';
  if (documentCards.length) {
    nodes.push(...lane(documentsId, next(), { title: 'Documents', caption: 'Source documents', more: 0 }, documentCards, {
      group: { open: isOpen(documentsId), summary: documentsSummary(documents ?? []) },
    }));
  }

  /** The frames that stand in the row of columns: the cards that have no place go under them. */
  const row: CheckpointNode[] = [];
  for (const entry of placed) {
    const at = { ...entry, position: { x: next(), y: 0 } };
    nodes.push(at);
    row.push(at);
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
      const more = repo.more + repo.commits.length - commits.length;
      // A repository with commits folds into a summary of them; one that could not be read has nothing to fold.
      const newest = commits[0];
      const group = newest && {
        open: isOpen(laneId),
        summary: {
          headline: since.count(repo.commits.length + repo.more, repo.moreAtLeast), detail: newest.subject, byline: newest.author,
          // A lane that is folded hides its note, so what could not be read is said on the summary too.
          ...(repo.problem ? { warning: 'Could not read everything' } : {}),
        },
      };
      nodes.push(...lane(laneId, next(), {
        title: repo.repo, caption: since.caption, more,
        ...(repo.moreAtLeast ? { moreAtLeast: true } : {}),
        ...(repo.problem ? { note: `Could not be read: ${repo.problem}` } : {}),
      }, cards, group ? { group } : {}));
    }
  }

  // The cards. A saved place wins over the band; the rest are in a band of their own under the checkpoints, in the same
  // columns, oldest first from the first, never over the columns beside it. A new card takes the next free place and moves
  // none, and the band stands under the tallest a frame can be, so opening or folding a group, or the work moving on, moves
  // none either. With no checkpoints in the row there is nothing to stand under, and the band is a column after the last one.
  const positions = new Map(Object.entries(board?.positions ?? {}));
  const unplaced: LaneCard[] = [];
  const free: BoardNode[] = [];
  for (const card of cardOrder((board?.cards ?? []).filter((entry) => showArchived || !entry.archived))) {
    const entry = cardPlan(card, now);
    const at = positions.get(card.id);
    if (at) free.push(freeCard(entry, at, entry.z)); else unplaced.push(entry);
  }
  nodes.push(...free);
  if (unplaced.length) {
    const data = { title: 'From the board', caption: 'Notes and files from you and the AI', more: 0 };
    nodes.push(...(row.length
      ? lane('lane:board', row[0]!.position.x, data, unplaced, { columns: row.length, y: Math.max(...row.map((entry) => entry.data.openHeight)) + columnGap })
      : lane('lane:board', next(), data, unplaced)));
  }

  return clearOfGroups(nodes);
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

/** What a node is called in words, for the line that joins it and for the keyboard. A lane that folds is called by its title. */
export function nodeTitle(node: BoardNode): string {
  switch (node.type) {
    case 'commit': return `commit ${node.data.sha}`;
    case 'lane': return node.data.group ? node.data.title : node.id;
    case 'placeholder': return node.id;
    default: return node.data.title;
  }
}

/** Whether a node is a group: a frame, or a lane whose cards fold away. */
export const isGroup = (node: BoardNode): node is CheckpointNode | LaneNode => node.type === 'checkpoint' || (node.type === 'lane' && node.data.group !== undefined);

/** Whether a node is a group that is folded into its summary. */
export const isFolded = (node: BoardNode): boolean => (node.type === 'checkpoint' ? !node.data.open : node.type === 'lane' && node.data.group?.open === false);

/**
 * The lines between the things that are on the board. A line to a thing that is not there (a commit that has left the
 * recent ones, a checkpoint that was renamed, an archived card that is hidden) is skipped, without a word: it comes back
 * with the thing. A line to a thing inside a folded group goes to the group's summary, so no line points at nothing, and
 * a line between two things of one folded group is left out. Each line leaves and enters by the sides that face each other.
 */
export function boardEdges(nodes: BoardNode[], links: BoardLink[]): Edge[] {
  if (!links.length) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rects = nodeRects(nodes);
  // What a folded lane holds is not drawn, but it can still be named by a line, and the line then goes to the lane.
  const hidden = new Map<string, string>();
  for (const node of nodes) if (node.type === 'lane' && node.data.group?.open === false) for (const id of node.data.group.holds) hidden.set(id, node.id);
  const resolve = nodeResolver([...byId.keys(), ...hidden.keys()]);
  const edges: Edge[] = [];
  for (const link of links) {
    const from = resolve(link.from);
    const to = resolve(link.to);
    if (from === undefined || to === undefined) continue;
    const source = hidden.get(from) ?? from;
    const target = hidden.get(to) ?? to;
    if (source === target) continue;
    const [fromSide, toSide] = sidesBetween(rects.get(source)!, rects.get(target)!);
    edges.push({
      id: link.id, source, target, sourceHandle: fromSide, targetHandle: toSide,
      ...(link.label ? { label: link.label } : {}),
      ariaLabel: `Link from ${nodeTitle(byId.get(source)!)} to ${nodeTitle(byId.get(target)!)}${link.label ? `: ${link.label}` : ''}`,
      focusable: false, selectable: false, deletable: false, reconnectable: false,
    });
  }
  return edges;
}
