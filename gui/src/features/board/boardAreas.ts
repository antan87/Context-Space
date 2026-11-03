/**
 * Areas: the logical grouping of the board at Level 0 ("Board") and Level 1 (inside an Area).
 *
 * Level 0 presents work grouped into Areas — one area per checkpoint, `plan:own` for loose steps
 * and waiting decisions outside checkpoints, or a fallback `area:work` ('Current work') when there
 * is workspace content but no plan checkpoints.
 *
 * Each area partitions its related steps, waiting decisions, source documents, commits, and cards.
 * Level 0 and Level 1 are both fitted to the screen without scrolling or panning, and nothing is shrunk below a readable
 * size: Level 0 is cards when they fit at that size, and one-line rows when they do not.
 */

import type { Edge, Node } from '@xyflow/react';
import type { WorkDocument } from '../../types.js';
import { stepsDone, type PlanFileDecision, type PlanFileStep, type PlanFileView } from '../plan/planFile.js';
import type { NewsCommit, WhatsNewView } from '../plan/whatsNew.js';
import type { BoardCard, BoardLink, BoardView } from './boardData.js';
import { resolveCommitContext } from './commitContext.js';
import {
  BOARD_LIMITS,
  BOARD_SIZE,
  cardOrder,
  fileTypeOf,
  imageAlt,
  isFresh,
  newestFirst,
  nodeResolver,
  sidesBetween,
  uniqueId,
  type LaneCard,
  type Rect,
} from './boardLayout.js';
import { READABLE_ZOOM } from './boardRows.js';

/** An Area card at Level 0. `height` is the least one (a title, its steps and nothing else): `areaCardHeight` is what the content needs. */
export const AREA_SIZE = { width: 320, height: 100, gapX: 32, gapY: 24 } as const;

/** The overview as one-line rows: the width a row is drawn at least and at most, its height, and the space between rows and between columns of them. */
export const AREA_ROW = { minWidth: 320, maxWidth: 560, height: 40, gap: 4, gapX: 16 } as const;

/** What the overview leaves free of its stage: a corner above for the pane's icons, the library's credit below, and room at the sides. */
export const OVERVIEW_INSET = { top: 44, bottom: 32, side: 20 } as const;

/** What an Area card is made of, in px at life size, for its height (`areaCardHeight`): the header line, a line of title, a line of text, and the bar of steps. */
const CARD = { pad: 12, head: 20, gap: 6, line: 20, text: 16, steps: 30, pictures: 72, more: 8, footer: 33 } as const;
/** The width of the text of a card, and how wide Inter draws a letter in em: narrow ones, wide ones, the rest. */
const CARD_TEXT_WIDTH = AREA_SIZE.width - 2 * CARD.pad - 2;
const EM = { narrow: 0.3, wide: 0.9, capital: 0.68, other: 0.54 } as const;

export const stepsText = (data: { stepsDone: number; stepsTotal: number }) =>
  data.stepsTotal ? `${data.stepsDone} of ${data.stepsTotal} ${data.stepsTotal === 1 ? 'step' : 'steps'}` : 'No steps';

export const waitingText = (waiting: number) =>
  waiting === 1 ? 'Waits for you' : `${waiting} wait for you`;

export type AreaPicture = { path: string; alt: string };

export type AreaData = {
  kind: 'checkpoint' | 'plan' | 'work';
  title: string;
  done: boolean;
  current: boolean;
  stepsDone: number;
  stepsTotal: number;
  waitingCount: number;
  noteCount: number;
  fileCount: number;
  pictureCount: number;
  documentCount: number;
  commitCount: number;
  archivedCount: number;
  /** Up to 3 image file paths from visible picture file cards in this area, for miniature previews. */
  pictures: AreaPicture[];
  /** A short line shown when there are no pictures: e.g. the first waiting question, newest commit subject, or first note title. */
  preview?: string;
  /** Warning when a repository in this area had a read problem. */
  warning?: string;
  /** True when any visible card in this area was made/updated in the last minute by an AI (`isFresh`). */
  fresh: boolean;
  freshKey?: string;
};

export type AreaNode = Node<AreaData, 'area'>;
/** The same Area as one line of the overview. */
export type AreaRowNode = Node<AreaData, 'areaRow'>;
export type AreaFoldData = {
  /** How many Areas it holds: the finished ones (`done`), or the finished ones and others that did not fit (`more`). */
  count: number;
  kind: 'done' | 'more';
  /** Whether they are shown: the row is then the one that folds them again. */
  expanded: boolean;
  /** What a press on the row does. The layout leaves it out: the board puts it in. */
  onToggle?: () => void;
};
/** The one last row of the overview that holds the Areas that did not fit. */
export type AreaFoldNode = Node<AreaFoldData, 'areaFold'>;
export type OverviewNode = AreaNode | AreaRowNode | AreaFoldNode;

export interface BoardAreaRepo {
  repo: { repo: string; commits: NewsCommit[]; more: number; moreAtLeast?: boolean; problem?: string };
  commits: NewsCommit[];
  laneId: string;
  cards: LaneCard[];
}

export interface BoardArea {
  id: string;
  kind: 'checkpoint' | 'plan' | 'work';
  checkpointKey?: string;
  data: AreaData;
  planItems?: { steps: PlanFileStep[]; decisions: PlanFileDecision[]; waitingKeys?: string[] };
  documents: WorkDocument[];
  repos: BoardAreaRepo[];
  cards: BoardCard[];
  archivedCount: number;
  allMemberNodeIds: string[];
}

export type Size = { width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };

export interface BuildBoardAreasSources {
  plan?: PlanFileView;
  documents?: WorkDocument[];
  news?: WhatsNewView;
  board?: BoardView;
  showArchived?: boolean;
  now?: number;
}

/**
 * Resolves sets of fresh document names and commit SHAs from workspace news,
 * so changed cards glow until seen.
 */
export function extractFreshSets(news?: WhatsNewView) {
  const freshShas = new Set<string>();
  const freshDocNames = new Set<string>();

  if (news && !news.empty) {
    for (const repo of news.commits ?? []) {
      for (const commit of repo.commits ?? []) {
        if (commit.sha) {
          freshShas.add(commit.sha);
          freshShas.add(commit.sha.slice(0, 7));
        }
      }
    }
    for (const doc of news.documents?.items ?? []) {
      if (doc.name) {
        freshDocNames.add(doc.name);
        freshDocNames.add(doc.name.toLowerCase());
      }
    }
  }

  const isDocFresh = (doc: WorkDocument) => {
    if (doc.filename && (freshDocNames.has(doc.filename) || freshDocNames.has(doc.filename.toLowerCase()))) return true;
    if (doc.title && (freshDocNames.has(doc.title) || freshDocNames.has(doc.title.toLowerCase()))) return true;
    return false;
  };

  const isCommitFresh = (sha?: string) => {
    if (!sha) return false;
    return freshShas.has(sha) || freshShas.has(sha.slice(0, 7));
  };

  return { freshShas, freshDocNames, isDocFresh, isCommitFresh };
}

/**
 * Builds the logical areas from workspace sources and partitions items (steps, documents, commits, cards)
 * to their owning area.
 */
export function buildBoardAreas({
  plan,
  documents,
  news,
  board,
  showArchived = false,
  now = Date.now(),
}: BuildBoardAreasSources): BoardArea[] {
  const taken = new Set<string>();
  const waitingKeys = new Set(plan?.waiting ?? []);
  const { isDocFresh, isCommitFresh } = extractFreshSets(news);

  type AreaDraft = {
    id: string;
    kind: 'checkpoint' | 'plan' | 'work';
    title: string;
    done: boolean;
    checkpointKey?: string;
    planItems?: { steps: PlanFileStep[]; decisions: PlanFileDecision[]; waitingKeys?: string[] };
  };

  const drafts: AreaDraft[] = [];

  if (plan && ((plan.steps?.length ?? 0) > 0 || (plan.decisions ?? []).some((decision) => waitingKeys.has(decision.key)))) {
    const areaWaitingKeys = (plan.decisions ?? []).filter((d) => waitingKeys.has(d.key)).map((d) => d.key);
    drafts.push({
      id: uniqueId('plan:own', taken),
      kind: 'plan',
      title: 'Plan',
      done: false,
      planItems: { steps: plan.steps ?? [], decisions: plan.decisions ?? [], waitingKeys: areaWaitingKeys },
    });
  }

  for (const cp of plan?.checkpoints ?? []) {
    const areaWaitingKeys = (cp.decisions ?? []).filter((d) => waitingKeys.has(d.key)).map((d) => d.key);
    drafts.push({
      id: uniqueId(`checkpoint:${cp.key}`, taken),
      kind: 'checkpoint',
      title: cp.title,
      done: cp.done,
      checkpointKey: cp.key,
      planItems: { steps: cp.steps ?? [], decisions: cp.decisions ?? [], waitingKeys: areaWaitingKeys },
    });
  }

  if (drafts.length === 0) {
    const hasCards = (board?.cards.length ?? 0) > 0;
    const hasDocs = (documents?.length ?? 0) > 0;
    const hasNews = Boolean(news?.commits.some((r) => r.commits.length > 0 || Boolean(r.problem) || r.more > 0));
    if (!hasCards && !hasDocs && !hasNews) {
      return [];
    }
    drafts.push({
      id: 'area:work',
      kind: 'work',
      title: 'Current work',
      done: false,
    });
  }

  const checkpoints = drafts.filter((a) => a.kind === 'checkpoint');
  const currentAreaId = checkpoints.find((a) => !a.done)?.id ?? checkpoints.at(-1)?.id ?? drafts[0]!.id;

  const areaIds = new Set(drafts.map((a) => a.id));
  const links = board?.links ?? [];

  // Pre-assign item IDs & transitive link ownership
  const allCandidateIds = new Set<string>(areaIds);
  const cardList = cardOrder(board?.cards ?? []);
  for (const card of cardList) {
    allCandidateIds.add(card.id);
  }

  const docTaken = new Set<string>();
  const docNodeMap = new Map<WorkDocument, string>();
  for (const doc of documents ?? []) {
    const docNodeId = uniqueId(`document:${doc.id}`, docTaken);
    docNodeMap.set(doc, docNodeId);
    allCandidateIds.add(docNodeId);
    allCandidateIds.add(`document:${doc.id}`);
  }

  const commitTaken = new Set<string>();
  const commitNodeMap = new Map<NewsCommit, string>();
  for (const repo of news?.commits ?? []) {
    const visible = newestFirst(repo.commits).slice(0, BOARD_LIMITS.commits);
    for (const commit of visible) {
      const commitNodeId = uniqueId(`commit:${repo.repo}:${commit.sha}`, commitTaken);
      commitNodeMap.set(commit, commitNodeId);
      allCandidateIds.add(commitNodeId);
      allCandidateIds.add(`commit:${repo.repo}:${commit.sha}`);
    }
  }

  const resolve = nodeResolver(allCandidateIds);
  const ownerOf = new Map<string, string>();

  // Seed ownerOf
  for (const areaId of areaIds) {
    ownerOf.set(areaId, areaId);
  }

  for (const card of cardList) {
    if (card.area && areaIds.has(card.area)) {
      ownerOf.set(card.id, card.area);
    }
  }

  for (const doc of documents ?? []) {
    const docNodeId = docNodeMap.get(doc)!;
    if (doc.scope?.milestoneId) {
      const milestone = doc.scope.milestoneId;
      let matchedAreaId: string | undefined;
      if (areaIds.has(milestone)) {
        matchedAreaId = milestone;
      } else if (areaIds.has(`checkpoint:${milestone}`)) {
        matchedAreaId = `checkpoint:${milestone}`;
      } else {
        const matched = drafts.find((d) => d.checkpointKey === milestone);
        if (matched) matchedAreaId = matched.id;
      }
      if (matchedAreaId) {
        ownerOf.set(docNodeId, matchedAreaId);
        ownerOf.set(`document:${doc.id}`, matchedAreaId);
      }
    }
  }

  // Fixed-point transitive ownership propagation
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      const from = resolve(link.from);
      const to = resolve(link.to);
      if (!from || !to) continue;
      const fromOwner = ownerOf.get(from);
      const toOwner = ownerOf.get(to);
      if (fromOwner && !toOwner) {
        ownerOf.set(to, fromOwner);
        changed = true;
      } else if (toOwner && !fromOwner) {
        ownerOf.set(from, toOwner);
        changed = true;
      }
    }
  }

  type AreaPartition = {
    draft: AreaDraft;
    cards: BoardCard[];
    documents: WorkDocument[];
    docNodeIds: string[];
    repos: Map<string, { repo: { repo: string; commits: NewsCommit[]; more: number; moreAtLeast?: boolean; problem?: string }; commits: NewsCommit[]; commitNodeIds: string[] }>;
    archivedCount: number;
    warning?: string;
    fresh: boolean;
    freshKey?: string;
  };

  const partitions = new Map<string, AreaPartition>();
  for (const draft of drafts) {
    partitions.set(draft.id, {
      draft,
      cards: [],
      documents: [],
      docNodeIds: [],
      repos: new Map(),
      archivedCount: 0,
      fresh: false,
    });
  }

  // 1. Cards routing
  for (const card of cardList) {
    const targetId = ownerOf.get(card.id) ?? currentAreaId;
    const partition = partitions.get(targetId) ?? partitions.get(currentAreaId)!;
    if (card.archived) {
      partition.archivedCount += 1;
    }
    if (showArchived || !card.archived) {
      partition.cards.push(card);
      if (!card.archived && isFresh(card, now)) {
        partition.fresh = true;
        partition.freshKey = card.updatedAt;
      }
    }
  }

  // 2. Documents routing
  for (const doc of documents ?? []) {
    const docNodeId = docNodeMap.get(doc)!;
    const targetId = ownerOf.get(docNodeId) ?? ownerOf.get(`document:${doc.id}`) ?? currentAreaId;
    const partition = partitions.get(targetId) ?? partitions.get(currentAreaId)!;
    partition.documents.push(doc);
    partition.docNodeIds.push(docNodeId);
    if (isDocFresh(doc)) {
      partition.fresh = true;
      partition.freshKey = doc.updatedAt ?? doc.id;
    }
  }

  // 3. Commits routing
  for (const repo of news?.commits ?? []) {
    const visibleCommits = newestFirst(repo.commits).slice(0, BOARD_LIMITS.commits);
    const overflow = repo.more + (repo.commits.length - visibleCommits.length);
    const commitsByArea = new Map<string, { commits: NewsCommit[]; nodeIds: string[] }>();

    for (const commit of visibleCommits) {
      const commitNodeId = commitNodeMap.get(commit)!;
      const targetId = ownerOf.get(commitNodeId) ?? ownerOf.get(`commit:${repo.repo}:${commit.sha}`) ?? currentAreaId;
      if (!commitsByArea.has(targetId)) {
        commitsByArea.set(targetId, { commits: [], nodeIds: [] });
      }
      const group = commitsByArea.get(targetId)!;
      group.commits.push(commit);
      group.nodeIds.push(commitNodeId);
      if (isCommitFresh(commit.sha)) {
        const partition = partitions.get(targetId) ?? partitions.get(currentAreaId)!;
        partition.fresh = true;
        partition.freshKey = commit.sha;
      }
    }

    for (const [targetId, { commits: areaCommits, nodeIds }] of commitsByArea.entries()) {
      const partition = partitions.get(targetId) ?? partitions.get(currentAreaId)!;
      const repoMore = targetId === currentAreaId ? overflow : 0;
      const repoMoreAtLeast = targetId === currentAreaId && overflow > 0 ? repo.moreAtLeast : undefined;
      partition.repos.set(repo.repo, {
        repo: { ...repo, more: repoMore, moreAtLeast: repoMoreAtLeast },
        commits: areaCommits,
        commitNodeIds: nodeIds,
      });
      if (repo.problem) {
        partition.warning = 'Could not read everything';
      }
    }

    if (!partitions.get(currentAreaId)!.repos.has(repo.repo)) {
      if ((commitsByArea.size === 0 && Boolean(repo.problem)) || overflow > 0) {
        const currentPartition = partitions.get(currentAreaId)!;
        currentPartition.repos.set(repo.repo, {
          repo: {
            ...repo,
            more: overflow,
            moreAtLeast: overflow > 0 ? repo.moreAtLeast : undefined,
          },
          commits: [],
          commitNodeIds: [],
        });
        if (repo.problem) {
          currentPartition.warning = 'Could not read everything';
        }
      }
    }
  }

  // Assemble final BoardAreas
  const result: BoardArea[] = [];

  for (const draft of drafts) {
    const laneTaken = new Set<string>();
    const p = partitions.get(draft.id)!;
    const isCurrent = draft.id === currentAreaId;

    let stepsDoneCount = 0;
    let stepsTotalCount = 0;
    let waitingCount = 0;

    if (draft.kind !== 'work') {
      const { done, total } = stepsDone(draft.planItems ?? { steps: [], decisions: [] });
      stepsDoneCount = done;
      stepsTotalCount = total;
      waitingCount = draft.planItems?.decisions.filter((d) => waitingKeys.has(d.key)).length ?? 0;
    }

    const noteCount = p.cards.filter((c) => c.kind === 'note').length;
    const fileCards = p.cards.filter((c) => c.kind === 'file');
    const fileCount = fileCards.length;
    const pictureCards = fileCards.filter((c) => fileTypeOf(c.path) === 'image');
    const pictureCount = pictureCards.length;
    const pictures: AreaPicture[] = pictureCards.slice(0, 3).map((c) => ({
      path: c.path,
      alt: imageAlt({ title: c.title, description: (c as { description?: string }).description ?? '', path: c.path ?? '' }),
    }));

    const documentCount = p.documents.length;
    let commitCount = 0;
    const repoEntries: BoardAreaRepo[] = [];
    const commitMemberIds: string[] = [];

    for (const [repoName, r] of p.repos.entries()) {
      commitCount += r.commits.length;
      commitMemberIds.push(...r.commitNodeIds);
      const laneId = uniqueId(`lane:commits:${repoName}`, laneTaken);
      const cards: LaneCard[] = r.commits.map((commit, index) => {
        const commitCtx = resolveCommitContext({
          repo: repoName,
          sha: commit.sha,
          plan,
          board,
        });
        const pictures = commitCtx.pictures.slice(0, 3).map((pic) => ({
          path: pic.path,
          title: pic.title,
        }));
        return {
          id: r.commitNodeIds[index] ?? uniqueId(`commit:${repoName}:${commit.sha}`, commitTaken),
          type: 'commit',
          height: BOARD_SIZE.commit,
          data: {
            sha: commit.sha.slice(0, 7),
            subject: commit.subject,
            author: commit.author,
            at: commit.at,
            fresh: isCommitFresh(commit.sha),
            pictures: pictures.length > 0 ? pictures : undefined,
          },
        };
      });
      repoEntries.push({ repo: r.repo, commits: r.commits, laneId, cards });
    }

    const firstWaiting = draft.planItems?.decisions.find((d) => waitingKeys.has(d.key));
    const newestCommit = newestFirst(repoEntries.flatMap((r) => r.commits))[0];
    const firstNote = p.cards.find((c) => c.kind === 'note');
    const preview = firstWaiting?.question ?? newestCommit?.subject ?? firstNote?.title;

    const allMemberNodeIds = [
      draft.id,
      ...p.cards.map((c) => c.id),
      ...p.docNodeIds,
      ...commitMemberIds,
    ];

    const data: AreaData = {
      kind: draft.kind,
      title: draft.title,
      done: draft.done,
      current: isCurrent,
      stepsDone: stepsDoneCount,
      stepsTotal: stepsTotalCount,
      waitingCount,
      noteCount,
      fileCount,
      pictureCount,
      documentCount,
      commitCount,
      archivedCount: p.archivedCount,
      pictures,
      preview,
      warning: p.warning,
      fresh: p.fresh,
      ...(p.freshKey ? { freshKey: p.freshKey } : {}),
    };

    result.push({
      id: draft.id,
      kind: draft.kind,
      checkpointKey: draft.checkpointKey,
      data,
      planItems: draft.planItems,
      documents: p.documents,
      repos: repoEntries,
      cards: p.cards,
      archivedCount: p.archivedCount,
      allMemberNodeIds,
    });
  }

  return result;
}

/** What an Area card counts, as words: "2 notes", "1 commit". Nothing that is zero. */
export function areaCounts(data: AreaData): string[] {
  const items: string[] = [];
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (data.noteCount > 0) items.push(plural(data.noteCount, 'note', 'notes'));
  if (data.pictureCount > 0) items.push(plural(data.pictureCount, 'picture', 'pictures'));
  if (data.fileCount > data.pictureCount) items.push(plural(data.fileCount - data.pictureCount, 'file', 'files'));
  if (data.documentCount > 0) items.push(plural(data.documentCount, 'document', 'documents'));
  if (data.commitCount > 0) items.push(plural(data.commitCount, 'commit', 'commits'));
  return items;
}

/**
 * How many lines a text takes in a card, 1 or 2 (a card cuts it at two): the width of its letters at that size, against the width of the
 * card less a tenth, since a line breaks at a word. It is a guess made without the browser; a text that is a little long takes the room
 * of a second line, and one that is a little short of the width stays on its one.
 */
function cardTextLines(text: string, size: number, weight = 1): 1 | 2 {
  let em = 0;
  for (const letter of text) {
    em += /[WMm@]/.test(letter) ? EM.wide : /[A-Z]/.test(letter) ? EM.capital : /[ijl.,;:!'|tfrI ]/.test(letter) ? EM.narrow : EM.other;
  }
  return em * size * weight > CARD_TEXT_WIDTH * 0.92 ? 2 : 1;
}

/** How high an Area card needs to be for what it shows: its pictures or its preview, and its counts, only when it has them. */
export function areaCardHeight(data: AreaData): number {
  const title = cardTextLines(data.title, 14);
  const middle = data.pictures.length > 0
    ? CARD.pictures
    : data.preview ? CARD.more + cardTextLines(data.preview, 13.5, 0.93) * CARD.text : 0;
  const footer = areaCounts(data).length > 0 || data.warning ? CARD.footer : 0;
  return 2 * CARD.pad + CARD.head + CARD.gap + title * CARD.line + (data.kind === 'work' ? 0 : CARD.steps) + middle + footer;
}

/** The room the overview's Areas have, in px of the stage: the stage less its insets. */
function overviewRoom(size: Size) {
  return { x: OVERVIEW_INSET.side, width: Math.max(1, size.width - 2 * OVERVIEW_INSET.side), top: OVERVIEW_INSET.top, height: Math.max(1, size.height - OVERVIEW_INSET.top - OVERVIEW_INSET.bottom) };
}

export interface OverviewPlan {
  form: 'cards' | 'rows';
  nodes: OverviewNode[];
  /** Where the view stands to show every node whole, or null while the stage has no size. */
  viewport: Viewport | null;
}

const FIXED = { draggable: false, selectable: false, connectable: false, deletable: false } as const;

/** How high each line of cards is: as high as the highest card in it, so the cards of a line stand level and no line has blank space. */
function cardLines(areas: BoardArea[], cols: number): number[] {
  const heights: number[] = [];
  areas.forEach((area, index) => {
    const line = Math.floor(index / cols);
    heights[line] = Math.max(heights[line] ?? AREA_SIZE.height, areaCardHeight(area.data));
  });
  return heights;
}

/**
 * The cards of the overview in the columns that show them all whole at a readable zoom (never below `READABLE_ZOOM`, never
 * above life size), or null when no number of columns does. The one that is shown largest wins; the one closest to the stage's
 * proportions when they are as large.
 */
function cardsPlan(areas: BoardArea[], size: Size): OverviewPlan | null {
  const room = overviewRoom(size);
  const targetRatio = room.width / room.height;
  const extent = (cols: number) => {
    const lines = cardLines(areas, cols);
    return { lines, w: cols * AREA_SIZE.width + (cols - 1) * AREA_SIZE.gapX, h: lines.reduce((sum, line) => sum + line, 0) + (lines.length - 1) * AREA_SIZE.gapY };
  };
  let best: { cols: number; zoom: number; diff: number } | null = null;
  for (let cols = 1; cols <= areas.length; cols++) {
    const { w, h } = extent(cols);
    const zoom = Math.min(1, room.width / w, room.height / h);
    if (zoom < READABLE_ZOOM - 1e-9) continue;
    const diff = Math.abs(w / h - targetRatio);
    if (!best || zoom > best.zoom + 1e-5 || (Math.abs(zoom - best.zoom) <= 1e-5 && diff < best.diff)) best = { cols, zoom, diff };
    // A few Areas that fit side by side at life size stand in one line
    if (areas.length <= 3 && cols === areas.length && zoom >= 0.999) { best = { cols, zoom, diff }; break; }
  }
  if (!best) return null;
  const { cols, zoom } = best;
  const { lines, w, h } = extent(cols);
  const tops = lines.map((_, line) => lines.slice(0, line).reduce((sum, above) => sum + above + AREA_SIZE.gapY, 0));
  return {
    form: 'cards',
    nodes: areas.map((area, index): AreaNode => {
      const line = Math.floor(index / cols);
      return {
        id: area.id,
        type: 'area',
        position: { x: (index % cols) * (AREA_SIZE.width + AREA_SIZE.gapX), y: tops[line]! },
        width: AREA_SIZE.width,
        height: lines[line]!,
        measured: { width: AREA_SIZE.width, height: lines[line]! },
        data: area.data,
        ...FIXED,
      };
    }),
    viewport: { x: (size.width - w * zoom) / 2, y: room.top + (room.height - h * zoom) / 2, zoom },
  };
}

/** The id of the overview's one last row of folded Areas. */
export const OVERVIEW_FOLD = 'overview:fold';

/**
 * One line to an Area at life size, in as few columns as show them all. When they are too many for the stage the finished ones
 * fold into one last row ("N done"), and when that is not enough the ones at the end fold with them ("N more"), the one under way
 * never. `expanded` shows them all, and the rows then go on below the stage: the view is for the person to move.
 */
function rowsPlan(areas: BoardArea[], size: Size, expanded: boolean): OverviewPlan {
  const room = overviewRoom(size);
  const step = AREA_ROW.height + AREA_ROW.gap;
  const perColumn = Math.max(1, Math.floor((room.height + AREA_ROW.gap) / step));
  const maxCols = Math.max(1, Math.floor((room.width + AREA_ROW.gapX) / (AREA_ROW.minWidth + AREA_ROW.gapX)));
  const slots = perColumn * maxCols;

  let shown = areas;
  let folded: BoardArea[] = [];
  if (areas.length > slots) {
    const kept = new Set(areas.filter((area) => !area.data.done || area.data.current).map((area) => area.id));
    // The last row takes one slot, so the Areas that stay are one fewer than the slots
    const trailing = areas.filter((area) => kept.has(area.id) && !area.data.current).reverse();
    for (const area of trailing) {
      if (kept.size <= slots - 1) break;
      kept.delete(area.id);
    }
    shown = areas.filter((area) => kept.has(area.id));
    folded = areas.filter((area) => !kept.has(area.id));
  }
  const fold: AreaFoldData | null = folded.length > 0 ? { count: folded.length, kind: folded.every((area) => area.data.done) ? 'done' : 'more', expanded } : null;
  const list = expanded ? areas : shown;
  const lines = list.length + (fold ? 1 : 0);
  const cols = Math.min(maxCols, Math.ceil(lines / perColumn));
  const rows = Math.ceil(lines / cols);
  const width = Math.min(AREA_ROW.maxWidth, Math.floor((room.width - (cols - 1) * AREA_ROW.gapX) / cols));
  const place = (index: number) => ({ x: Math.floor(index / rows) * (width + AREA_ROW.gapX), y: (index % rows) * step });

  const nodes: OverviewNode[] = list.map((area, index): AreaRowNode => ({
    id: area.id,
    type: 'areaRow',
    position: place(index),
    width,
    height: AREA_ROW.height,
    measured: { width, height: AREA_ROW.height },
    data: area.data,
    ...FIXED,
  }));
  if (fold) {
    nodes.push({
      id: OVERVIEW_FOLD,
      type: 'areaFold',
      position: place(list.length),
      width,
      height: AREA_ROW.height,
      measured: { width, height: AREA_ROW.height },
      data: fold,
      ...FIXED,
    } satisfies AreaFoldNode);
  }
  const total = cols * width + (cols - 1) * AREA_ROW.gapX;
  return { form: 'rows', nodes, viewport: { x: room.x + (room.width - total) / 2, y: room.top, zoom: 1 } };
}

/**
 * Lays out Level 0: the Areas as cards, as many columns as fit the stage at a readable size, and when they do not fit that
 * way, as one-line rows (the narrow pane, the phone, many Areas). Pure: the form follows from the stage's size and the Areas.
 */
export function overviewPlan(areas: BoardArea[], size: Size, options: { expanded?: boolean } = {}): OverviewPlan {
  if (areas.length === 0) return { form: 'cards', nodes: [], viewport: null };
  if (size.width <= 0 || size.height <= 0) {
    // Not measured yet: a guess, drawn when the size is known
    const cols = Math.min(areas.length, 3);
    const lines = cardLines(areas, cols);
    const nodes = areas.map((area, index): AreaNode => {
      const line = Math.floor(index / cols);
      const height = lines[line]!;
      return {
        id: area.id, type: 'area', position: { x: (index % cols) * (AREA_SIZE.width + AREA_SIZE.gapX), y: lines.slice(0, line).reduce((sum, above) => sum + above + AREA_SIZE.gapY, 0) },
        width: AREA_SIZE.width, height, measured: { width: AREA_SIZE.width, height }, data: area.data, ...FIXED,
      };
    });
    return { form: 'cards', nodes, viewport: null };
  }
  return cardsPlan(areas, size) ?? rowsPlan(areas, size, options.expanded ?? false);
}

/** The nodes of the overview (`overviewPlan`). */
export function overviewLayout(areas: BoardArea[], size: Size, options: { expanded?: boolean } = {}): OverviewNode[] {
  return overviewPlan(areas, size, options).nodes;
}

/**
 * Connects cross-area links at Level 0, deduplicating multiple lines between the same areas.
 */
export function overviewEdges(areas: BoardArea[], nodes: OverviewNode[], links: BoardLink[]): Edge[] {
  if (!links.length || !areas.length || !nodes.length) return [];
  const ownerMap = new Map<string, string>();
  const titleMap = new Map<string, string>();
  for (const area of areas) {
    titleMap.set(area.id, area.data.title);
    for (const id of area.allMemberNodeIds) {
      ownerMap.set(id, area.id);
    }
  }

  // Only cards are linked by lines: one-line rows have none between them
  const rects = new Map<string, Rect>();
  for (const n of nodes) {
    if (n.type !== 'area') continue;
    rects.set(n.id, {
      x: n.position.x,
      y: n.position.y,
      width: n.width ?? AREA_SIZE.width,
      height: n.height ?? AREA_SIZE.height,
    });
  }

  const resolve = nodeResolver(ownerMap.keys());
  const edges: Edge[] = [];
  const seenPairs = new Map<string, { count: number; edgeIndex: number; hasLabel: boolean }>();

  for (const link of links) {
    const from = resolve(link.from);
    const to = resolve(link.to);
    if (!from || !to) continue;
    const sourceArea = ownerMap.get(from);
    const targetArea = ownerMap.get(to);
    if (!sourceArea || !targetArea || sourceArea === targetArea) continue;

    const sourceRect = rects.get(sourceArea);
    const targetRect = rects.get(targetArea);
    if (!sourceRect || !targetRect) continue;

    const pairKey = `${sourceArea}\n${targetArea}`;
    const existing = seenPairs.get(pairKey);
    const sourceTitle = titleMap.get(sourceArea) ?? sourceArea;
    const targetTitle = titleMap.get(targetArea) ?? targetArea;

    if (existing) {
      existing.count += 1;
      const targetEdge = edges[existing.edgeIndex]!;
      targetEdge.label = `${existing.count} links`;
      targetEdge.ariaLabel = `Link from ${sourceTitle} to ${targetTitle}: ${existing.count} links`;
      continue;
    }

    const [fromSide, toSide] = sidesBetween(sourceRect, targetRect);
    const edgeIndex = edges.length;
    seenPairs.set(pairKey, { count: 1, edgeIndex, hasLabel: Boolean(link.label) });
    edges.push({
      id: link.id,
      source: sourceArea,
      target: targetArea,
      sourceHandle: fromSide,
      targetHandle: toSide,
      ...(link.label ? { label: link.label } : {}),
      ariaLabel: `Link from ${sourceTitle} to ${targetTitle}${link.label ? `: ${link.label}` : ''}`,
      focusable: false,
      selectable: false,
      deletable: false,
      reconnectable: false,
    });
  }

  return edges;
}

export { READABLE_ZOOM, ROW_SIZE, WAITING_ROW, areaBoardLayout, areaLayout, areaOpenInfo, areaPlace, areaRowIds, areaRowOf, areaRows, areaStage, areaView } from './boardRows.js';
export type { AreaBoardLayoutOptions, AreaRow, AreaStage } from './boardRows.js';
