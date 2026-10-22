/**
 * The Board: the workspace's plan, documents and commits laid out as nodes for the canvas. Pure, so the order, the
 * grouping and the caps are tested alone. Documents sit in a column on the left, the plan's checkpoints follow in plan
 * order (after a frame for the steps and decisions that sit outside any checkpoint), and each repository's commits form
 * a lane on the right. Nothing here is saved: the same input always gives the same board.
 */

import type { Node } from '@xyflow/react';
import type { WorkDocument } from '../../types.js';
import { stepsDone, type PlanFileDecision, type PlanFileStep, type PlanFileView } from '../plan/planFile.js';
import type { WhatsNewView } from '../plan/whatsNew.js';

/**
 * What a big workspace is cut to, so the board stays readable. The rest is counted, not drawn. The commits are the ones
 * "Since you last looked" lists, which the backend already cuts to 10 per repository (NEWS_LIMIT in core/whats-new),
 * so the cap of 12 only bites if that limit is raised. A real history of commits is a later slice.
 */
export const BOARD_LIMITS = { steps: 6, waiting: 3, commits: 12 } as const;

/**
 * Every node has a fixed size, so the layout is known before the browser measures anything and the board opens fitted.
 * The node components give their rows these same heights.
 */
export const BOARD_SIZE = {
  /** The width of a lane or a checkpoint frame. */
  column: 296,
  pad: 12,
  gap: 12,
  columnGap: 56,
  laneHeader: 52,
  laneNote: 40,
  laneMore: 24,
  document: 128,
  commit: 80,
  placeholder: 56,
  frameHeader: 92,
  stepRow: 24,
  decisionRow: 40,
  moreRow: 22,
} as const;

const { column, pad, gap, columnGap } = BOARD_SIZE;
const CARD_WIDTH = column - 2 * pad;

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

export type LaneNode = Node<LaneData, 'lane'>;
export type CheckpointNode = Node<CheckpointData, 'checkpoint'>;
export type DocumentNode = Node<DocumentData, 'document'>;
export type CommitNode = Node<CommitData, 'commit'>;
export type PlaceholderNode = Node<PlaceholderData, 'placeholder'>;
export type BoardNode = LaneNode | CheckpointNode | DocumentNode | CommitNode | PlaceholderNode;

export interface BoardSources {
  /** A source that is missing (still loading, or it failed) leaves its part of the board out. */
  plan?: PlanFileView;
  documents?: WorkDocument[];
  news?: WhatsNewView;
}

/** Read-only for now: nothing can be moved, linked or picked. */
const FIXED = { draggable: false, selectable: false, connectable: false, deletable: false } as const;

/** Two things with the same key (two checkpoints with one title) still get their own node. */
function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}#${n}`;
  taken.add(id);
  return id;
}

/** Newest first. A commit with no readable time goes last, and the order the list came in decides between equals. */
function newestFirst<T extends { at: string }>(items: T[]): T[] {
  const time = (item: T) => { const at = Date.parse(item.at); return Number.isFinite(at) ? at : -Infinity; };
  return items.map((item, index) => ({ item, index, at: time(item) }))
    .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : a.index - b.index))
    .map(({ item }) => item);
}

/** A lane and its cards, one under the other. The cards belong to the lane, so they stay together. */
function lane(id: string, x: number, data: LaneData, cards: Array<{ id: string; type: 'document' | 'commit' | 'placeholder'; height: number; data: DocumentData | CommitData | PlaceholderData }>): BoardNode[] {
  let y = BOARD_SIZE.laneHeader + (data.note ? BOARD_SIZE.laneNote : 0);
  const children = cards.map((card) => {
    const node = { id: card.id, type: card.type, parentId: id, position: { x: pad, y }, width: CARD_WIDTH, height: card.height, data: card.data, ...FIXED } as BoardNode;
    y += card.height + gap;
    return node;
  });
  const height = y + (data.more ? BOARD_SIZE.laneMore : 0);
  return [{ id, type: 'lane', position: { x, y: 0 }, width: column, height, data, ...FIXED }, ...children];
}

/** How far back the commits reach, as the list says so itself: since the last look, or the last few days. */
function commitsSince(news: WhatsNewView): { caption: string; none: string } {
  if (news.basis === 'first-look') {
    const days = Math.max(1, Math.round((Date.parse(news.at) - Date.parse(news.from)) / 86_400_000));
    return { caption: `From the last ${days} ${days === 1 ? 'day' : 'days'}`, none: `No commits in the last ${days} ${days === 1 ? 'day' : 'days'}.` };
  }
  if (news.basis === 'time') return { caption: 'New since the time asked for', none: 'No new commits since the time asked for.' };
  return { caption: 'New since you last looked', none: 'No new commits since you last looked.' };
}

/** What a lane says it leaves out: "+4 more", or "90+ more" when the count is only a lower bound. */
export function moreText(more: number, atLeast = false): string {
  return atLeast ? `${more}+ more` : `+${more} more`;
}

/** A frame of steps and the decisions that wait, for a checkpoint or for the plan's own loose items. */
function frame(kind: CheckpointData['kind'], id: string, x: number, title: string, done: boolean, items: { steps: PlanFileStep[]; decisions: PlanFileDecision[] }, waitingKeys: Set<string>): CheckpointNode {
  const { done: stepsComplete, total } = stepsDone(items);
  const waiting = items.decisions.filter((decision) => waitingKeys.has(decision.key));
  const shownWaiting = waiting.slice(0, BOARD_LIMITS.waiting);
  const steps = items.steps.slice(0, BOARD_LIMITS.steps);
  const moreSteps = items.steps.length - steps.length;
  const moreWaiting = waiting.length - shownWaiting.length;
  // A frame with no steps says so in one row, so it is not an empty box.
  const height = BOARD_SIZE.frameHeader
    + shownWaiting.length * BOARD_SIZE.decisionRow + (moreWaiting ? BOARD_SIZE.moreRow : 0)
    + Math.max(1, steps.length) * BOARD_SIZE.stepRow + (moreSteps ? BOARD_SIZE.moreRow : 0)
    + pad;
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
 * be read). A part with nothing to show is left out, except that a board with other content and no commits says so in
 * one placeholder card, so the missing lane is not a puzzle. Parents come before their cards, which is the order the
 * canvas needs.
 */
export function boardLayout({ plan, documents, news }: BoardSources): BoardNode[] {
  const nodes: BoardNode[] = [];
  const taken = new Set<string>();
  let x = 0;
  const next = () => { const at = x; x += column + columnGap; return at; };

  if (documents?.length) {
    nodes.push(...lane('lane:documents', next(), { title: 'Documents', caption: 'Source documents', more: 0 }, documents.map((document) => ({
      id: uniqueId(`document:${document.id}`, taken), type: 'document' as const, height: BOARD_SIZE.document,
      data: { title: document.title, role: document.role, status: document.status, summary: document.summary, dimmed: document.status === 'superseded' },
    }))));
  }

  if (plan) {
    const waitingKeys = new Set(plan.waiting);
    // The plan's own steps and decisions belong to no checkpoint, so they get a frame of their own, ahead of the checkpoints.
    if (plan.steps.length > 0 || plan.decisions.some((decision) => waitingKeys.has(decision.key))) {
      nodes.push(frame('plan', uniqueId('plan:own', taken), next(), 'Plan', false, plan, waitingKeys));
    }
    for (const checkpoint of plan.checkpoints) nodes.push(frame('checkpoint', uniqueId(`checkpoint:${checkpoint.key}`, taken), next(), checkpoint.title, checkpoint.done, checkpoint, waitingKeys));
  }

  if (news) {
    const since = commitsSince(news);
    const problems = news.commits.filter((repo) => !repo.commits.length && repo.problem);
    // The commits are only the new ones, so an empty lane is the usual case. Say so, but never on a board with nothing else.
    if (!news.commits.some((repo) => repo.commits.length) && (nodes.length > 0 || problems.length > 0)) {
      nodes.push(...lane(uniqueId('lane:commits', taken), next(), { title: 'Commits', caption: since.caption, more: 0 }, [
        { id: uniqueId('placeholder:commits', taken), type: 'placeholder' as const, height: BOARD_SIZE.placeholder, data: { text: since.none } },
      ]));
    }
    for (const repo of news.commits) {
      if (!repo.commits.length && !repo.problem) continue;
      const commits = newestFirst(repo.commits).slice(0, BOARD_LIMITS.commits);
      const laneId = uniqueId(`lane:commits:${repo.repo}`, taken);
      nodes.push(...lane(laneId, next(), {
        title: repo.repo, caption: since.caption, more: repo.more + repo.commits.length - commits.length,
        ...(repo.moreAtLeast ? { moreAtLeast: true } : {}),
        ...(repo.problem ? { note: `Could not be read: ${repo.problem}` } : {}),
      }, commits.map((commit) => ({
        id: uniqueId(`commit:${repo.repo}:${commit.sha}`, taken), type: 'commit' as const, height: BOARD_SIZE.commit,
        data: { sha: commit.sha.slice(0, 7), subject: commit.subject, author: commit.author, at: commit.at },
      }))));
    }
  }

  return nodes;
}
