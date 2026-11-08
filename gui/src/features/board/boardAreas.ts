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

import type { RepoChangeSummary } from '../changes/changeSummary.js';
import type { Edge, Node } from '@xyflow/react';
import type { WorkDocument } from '../../types.js';
import { focusOf, headingKeysOf } from '../plan/focus.js';
import { stepsDone, type PlanFileDecision, type PlanFileStep, type PlanFileView, type PlanProof } from '../plan/planFile.js';
import type { NewsCommit, WhatsNewView } from '../plan/whatsNew.js';
import type { BoardCard, BoardLink, BoardView } from './boardData.js';
import { resolveCommitContext } from './commitContext.js';
import {
  areaCountItems,
  resolveCountTarget,
  type AreaCountItem,
  type AreaCountKind,
  type AreaCountTarget,
} from './boardCountNav.js';
export {
  areaCountItems,
  resolveCountTarget,
  type AreaCountItem,
  type AreaCountKind,
  type AreaCountTarget,
};
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

/** An Area card at Level 0. `height` is the least one (a title, its steps and nothing else): `areaCardHeight` is what the content needs. */
export const AREA_SIZE = { width: 320, height: 100, gapX: 32, gapY: 24 } as const;

/** The overview as one-line rows: the width a row is drawn at least and at most, its height, and the space between rows and between columns of them. */
export const AREA_ROW = { minWidth: 320, maxWidth: 560, height: 40, gap: 4, gapX: 16 } as const;

/** The overview as small cards, two columns or more: least and most width, least, comfortable and most height, and the space between. Text never scales. */
export const AREA_MINI = { minWidth: 208, maxWidth: 360, minHeight: 76, comfyHeight: 100, maxHeight: 124, gap: 12 } as const;

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
export type AreaOpenStep = { key: string; text: string; done: boolean };

export type AreaData = {
  kind: 'checkpoint' | 'plan' | 'work';
  title: string;
  done: boolean;
  /** The focus Area: the one the work is on (the step someone said they work on, else the plan's first open checkpoint). It is Now only when `nowSet`. */
  current: boolean;
  /** Someone said which step is being worked on and it is in this Area: only then is it called Now. A guess from the plan's order is "Next up". */
  nowSet: boolean;
  /** The key of the focus step, in the focus Area. */
  focusStep?: string;
  /** Up to 3 open workable steps (skipping headings) for the focus Area in Tier 1. */
  openSteps?: AreaOpenStep[];
  /** The next open step text that is not a heading (for Tier 4). */
  nextOpenStep?: string;
  /** The first waiting question's text for Tier 2. */
  waitingQuestion?: string;
  /** Summary of news items for this area (e.g. "2 commits, 1 picture") for Tier 3. */
  newsSummary?: string;
  /** Timestamp of the newest fresh change in this area. */
  newestChangeTime?: number;
  /** Flags deciding what the hero card draws whole so nothing is ever cut mid-line. */
  heroShowPreview?: boolean;
  heroShowPictures?: boolean;
  heroShowFooter?: boolean;
  heroOpenStepLimit?: number;
  /** The tier of this Area in the overview (1..5). */
  tier?: 1 | 2 | 3 | 4 | 5;
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
  /** The key of the step that changed, when there are fresh plan changes. */
  freshStepKey?: string;
  /** The key of the decision that changed, when there are fresh decision updates. */
  freshDecisionKey?: string;
  /** The key of the checkpoint that changed, when there are fresh checkpoint updates. */
  freshCheckpointKey?: string;
  /** Number of fresh updates in this area. */
  updateCount?: number;
  /** Items of fresh updates and changes for Tier 3, each an interactive count. */
  newsItems?: AreaCountItem[];
};

export type AreaNode = Node<AreaData, 'area'>;
/** The same Area as one line of the overview. */
export type AreaRowNode = Node<AreaData, 'areaRow'>;
export type AreaFoldData = {
  /** How many Areas it holds: the finished ones (`done`), or the finished ones and others that did not fit (`more`). */
  count: number;
  kind: 'done' | 'more';
  /** How many Areas holding a question did not fit, when questions are folded. */
  waitingCount?: number;
  /** How many open Areas did not fit, when both open and finished ones are folded. */
  moreCount?: number;
  /** How many finished Areas are folded, when both open and finished ones are folded. */
  doneCount?: number;
  /** Whether they are shown: the row is then the one that folds them again. */
  expanded: boolean;
  /** What a press on the row does. The layout leaves it out: the board puts it in. */
  onToggle?: () => void;
};
/** What the fold row calls itself: "N done", "N more", or "M more · N done" when it holds both, or "K question(s) · ..." when questions fold. */
export function foldLabel(data: AreaFoldData): string {
  if (data.expanded) return 'Show fewer';
  const parts: string[] = [];
  if (data.waitingCount) {
    parts.push(`${data.waitingCount} ${data.waitingCount === 1 ? 'question' : 'questions'}`);
  }
  if (data.moreCount) {
    parts.push(`${data.moreCount} more`);
  }
  if (data.doneCount) {
    parts.push(`${data.doneCount} done`);
  }
  if (parts.length > 0) {
    return parts.join(' · ');
  }
  return `${data.count} ${data.kind}`;
}
/** The one last row of the overview that holds the Areas that did not fit. */
export type AreaFoldNode = Node<AreaFoldData, 'areaFold'>;
/** The same Area as a small card of the overview. */
export type AreaMiniNode = Node<AreaData, 'areaMini'>;
export type OverviewNode = AreaNode | AreaRowNode | AreaMiniNode | AreaFoldNode;

export interface BoardAreaRepo {
  repo: { repo: string; commits: NewsCommit[]; more: number; moreAtLeast?: boolean; problem?: string };
  commits: NewsCommit[];
  laneId: string;
  cards: LaneCard[];
}

export interface BoardArea {
  /** The work not committed yet, per repository, with the files it touches. Added by the Board from the change listing; only the current Area draws it. */
  uncommitted?: RepoChangeSummary[];
  id: string;
  kind: 'checkpoint' | 'plan' | 'work';
  checkpointKey?: string;
  check?: string | null;
  proof?: PlanProof;
  data: AreaData;
  planItems?: { steps: PlanFileStep[]; decisions: PlanFileDecision[]; waitingKeys?: string[]; check?: string | null; proof?: PlanProof };
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
  /** When the Areas are built, for what changed within the last minute (`isFresh`). Default: the time of the call. */
  now?: number;
  /** The time the focus is worked out at (a set step runs out after a day). Default: `now`. The Board holds it still between focus changes. */
  focusNow?: number;
}

/**
 * Resolves sets of fresh document names and commit SHAs from workspace news,
 * so changed cards glow until seen.
 */
export function extractFreshSets(news?: WhatsNewView) {
  const freshShas = new Set<string>();
  const freshDocNames = new Set<string>();

  if (news && !news.empty) {
    for (const repo of news.unseenCommits ?? news.commits ?? []) {
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
  focusNow = now,
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
    check?: string | null;
    proof?: PlanProof;
    planItems?: { steps: PlanFileStep[]; decisions: PlanFileDecision[]; waitingKeys?: string[]; check?: string | null; proof?: PlanProof };
  };

  const drafts: AreaDraft[] = [];

  if (plan && ((plan.steps?.length ?? 0) > 0 || (plan.decisions ?? []).some((decision) => waitingKeys.has(decision.key)))) {
    const areaWaitingKeys = (plan.decisions ?? []).filter((d) => waitingKeys.has(d.key)).map((d) => d.key);
    const steps = plan.steps ?? [];
    const isPlanDone = steps.length > 0 ? steps.every((s) => s.done) && areaWaitingKeys.length === 0 : false;
    drafts.push({
      id: uniqueId('plan:own', taken),
      kind: 'plan',
      title: 'Plan',
      done: isPlanDone,
      planItems: { steps, decisions: plan.decisions ?? [], waitingKeys: areaWaitingKeys },
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
      check: cp.check,
      proof: cp.proof,
      planItems: { steps: cp.steps ?? [], decisions: cp.decisions ?? [], waitingKeys: areaWaitingKeys, check: cp.check, proof: cp.proof },
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
  // Where a card or document tied to nothing lives. It stays on the plan's own rule, so that it does not jump between Areas when the focus moves.
  const openCheckpoints = checkpoints.filter((a) => !a.done);
  const openDrafts = drafts.filter((a) => !a.done);
  const placementAreaId = openCheckpoints[0]?.id ?? openDrafts[0]?.id ?? checkpoints.at(-1)?.id ?? drafts[0]!.id;
  // Where the work is now: the Area of the focus step. The commits tied to nothing and the work not committed yet follow it.
  const focus = focusOf(plan, undefined, focusNow);
  const focusAreaId = (focus && (focus.checkpoint ? drafts.find((a) => a.checkpointKey === focus.checkpoint!.key && !a.done) : drafts.find((a) => a.kind === 'plan' && !a.done)))?.id ?? (openDrafts.length > 0 ? placementAreaId : (checkpoints.at(-1)?.id ?? drafts[0]!.id));
  const nowSet = focus?.source === 'set';

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

  // Map commit SHAs mentioned in steps, checks, proofs, or notes to their owning draft
  const shaToDraftId = new Map<string, string>();
  for (const draft of drafts) {
    const texts: string[] = [draft.title];
    if (draft.checkpointKey) texts.push(draft.checkpointKey);
    for (const step of draft.planItems?.steps ?? []) {
      texts.push(step.text);
    }
    for (const text of texts) {
      const matches = text.match(/\b[0-9a-f]{7,40}\b/gi);
      if (matches) {
        for (const m of matches) {
          shaToDraftId.set(m.toLowerCase().slice(0, 7), draft.id);
        }
      }
    }
  }

  for (const repo of news?.commits ?? []) {
    for (const commit of repo.commits ?? []) {
      const shortSha = commit.sha.toLowerCase().slice(0, 7);
      const matchedDraftId = shaToDraftId.get(shortSha);
      if (matchedDraftId) {
        ownerOf.set(`commit:${repo.repo}:${commit.sha}`, matchedDraftId);
        const commitNodeId = commitNodeMap.get(commit);
        if (commitNodeId) ownerOf.set(commitNodeId, matchedDraftId);
      }
    }
  }

  for (const repo of news?.commits ?? []) {
    for (const commit of repo.commits ?? []) {
      if (ownerOf.has(`commit:${repo.repo}:${commit.sha}`)) continue;
      const subject = commit.subject.toLowerCase();
      for (const draft of drafts) {
        if (draft.id === focusAreaId) continue;
        const key = draft.checkpointKey?.toLowerCase();
        if (key && (subject.includes(`(${key})`) || subject.includes(`: ${key}`) || subject.includes(` ${key} `))) {
          ownerOf.set(`commit:${repo.repo}:${commit.sha}`, draft.id);
          const commitNodeId = commitNodeMap.get(commit);
          if (commitNodeId) ownerOf.set(commitNodeId, draft.id);
          break;
        }
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
    freshStepKey?: string;
    freshDecisionKey?: string;
    freshCheckpointKey?: string;
    newestChangeTime?: number;
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
    const targetId = ownerOf.get(card.id) ?? placementAreaId;
    const partition = partitions.get(targetId) ?? partitions.get(placementAreaId)!;
    if (card.archived) {
      partition.archivedCount += 1;
    }
    if (showArchived || !card.archived) {
      partition.cards.push(card);
      if (!card.archived && isFresh(card, now)) {
        partition.fresh = true;
        partition.freshKey = card.updatedAt;
        const cardTime = card.updatedAt ? Date.parse(card.updatedAt) : 0;
        if (cardTime) partition.newestChangeTime = Math.max(partition.newestChangeTime ?? 0, cardTime);
      }
    }
  }

  // 2. Documents routing
  for (const doc of documents ?? []) {
    const docNodeId = docNodeMap.get(doc)!;
    const targetId = ownerOf.get(docNodeId) ?? ownerOf.get(`document:${doc.id}`) ?? placementAreaId;
    const partition = partitions.get(targetId) ?? partitions.get(placementAreaId)!;
    partition.documents.push(doc);
    partition.docNodeIds.push(docNodeId);
    if (isDocFresh(doc)) {
      partition.fresh = true;
      partition.freshKey = doc.updatedAt ?? doc.id;
      const docTime = doc.updatedAt ? Date.parse(doc.updatedAt) : 0;
      if (docTime) partition.newestChangeTime = Math.max(partition.newestChangeTime ?? 0, docTime);
    }
  }

  // 3. Commits routing
  for (const repo of news?.commits ?? []) {
    const visibleCommits = newestFirst(repo.commits).slice(0, BOARD_LIMITS.commits);
    const overflow = repo.more + (repo.commits.length - visibleCommits.length);
    const commitsByArea = new Map<string, { commits: NewsCommit[]; nodeIds: string[] }>();

    for (const commit of visibleCommits) {
      const commitNodeId = commitNodeMap.get(commit)!;
      const targetId = ownerOf.get(commitNodeId) ?? ownerOf.get(`commit:${repo.repo}:${commit.sha}`) ?? focusAreaId;
      if (!commitsByArea.has(targetId)) {
        commitsByArea.set(targetId, { commits: [], nodeIds: [] });
      }
      const group = commitsByArea.get(targetId)!;
      group.commits.push(commit);
      group.nodeIds.push(commitNodeId);
      if (isCommitFresh(commit.sha)) {
        const partition = partitions.get(targetId) ?? partitions.get(focusAreaId)!;
        partition.fresh = true;
        partition.freshKey = commit.sha;
        const commitTime = commit.at ? Date.parse(commit.at) : 0;
        if (commitTime) partition.newestChangeTime = Math.max(partition.newestChangeTime ?? 0, commitTime);
      }
    }

    for (const [targetId, { commits: areaCommits, nodeIds }] of commitsByArea.entries()) {
      const partition = partitions.get(targetId) ?? partitions.get(focusAreaId)!;
      const repoMore = targetId === focusAreaId ? overflow : 0;
      const repoMoreAtLeast = targetId === focusAreaId && overflow > 0 ? repo.moreAtLeast : undefined;
      partition.repos.set(repo.repo, {
        repo: { ...repo, more: repoMore, moreAtLeast: repoMoreAtLeast },
        commits: areaCommits,
        commitNodeIds: nodeIds,
      });
      if (repo.problem) {
        partition.warning = 'Could not read everything';
      }
    }

    if (!partitions.get(focusAreaId)!.repos.has(repo.repo)) {
      if ((commitsByArea.size === 0 && Boolean(repo.problem)) || overflow > 0) {
        const currentPartition = partitions.get(focusAreaId)!;
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

  // 4. Plan changes routing
  const planKeyType = new Map<string, { draftId: string; kind: 'step' | 'decision' | 'checkpoint' }>();
  for (const draft of drafts) {
    if (draft.checkpointKey) planKeyType.set(draft.checkpointKey, { draftId: draft.id, kind: 'checkpoint' });
    for (const step of draft.planItems?.steps ?? []) {
      planKeyType.set(step.key, { draftId: draft.id, kind: 'step' });
    }
    for (const dec of draft.planItems?.decisions ?? []) {
      planKeyType.set(dec.key, { draftId: draft.id, kind: 'decision' });
    }
  }

  const freshPlanChangesByArea = new Map<string, number>();
  if (news && !news.empty) {
    for (const change of news.plan?.items ?? []) {
      const match = planKeyType.get(change.key);
      if (match) {
        const { draftId, kind } = match;
        freshPlanChangesByArea.set(draftId, (freshPlanChangesByArea.get(draftId) ?? 0) + 1);
        const partition = partitions.get(draftId);
        if (partition) {
          partition.fresh = true;
          partition.freshKey = change.at ?? change.key;
          const changeTime = change.at ? Date.parse(change.at) : 0;
          const isNewer = !partition.newestChangeTime || changeTime >= partition.newestChangeTime;
          if (changeTime) partition.newestChangeTime = Math.max(partition.newestChangeTime ?? 0, changeTime);
          if (isNewer) {
            if (kind === 'decision') {
              partition.freshDecisionKey = change.key;
              partition.freshStepKey = undefined;
              partition.freshCheckpointKey = undefined;
            } else if (kind === 'step') {
              partition.freshStepKey = change.key;
              partition.freshDecisionKey = undefined;
              partition.freshCheckpointKey = undefined;
            } else if (kind === 'checkpoint') {
              partition.freshCheckpointKey = change.key;
              partition.freshStepKey = undefined;
              partition.freshDecisionKey = undefined;
            }
          }
        }
      }
    }
  }

  // Assemble final BoardAreas
  const result: BoardArea[] = [];

  for (const draft of drafts) {
    const laneTaken = new Set<string>();
    const p = partitions.get(draft.id)!;
    const isCurrent = draft.id === focusAreaId;

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
    const waitingQuestion = firstWaiting?.question;
    const newestCommit = newestFirst(repoEntries.flatMap((r) => r.commits))[0];
    const firstNote = p.cards.find((c) => c.kind === 'note');
    const preview = firstWaiting?.question ?? newestCommit?.subject ?? firstNote?.title;

    // Steps for Tier 1 and Tier 4 (skipping headings)
    const areaStepsList = draft.planItems?.steps ?? [];
    const headings = headingKeysOf(areaStepsList);
    const workableSteps = areaStepsList.filter((s) => !s.done && !headings.has(s.key));
    const nextOpenStep = workableSteps[0]?.text;

    const openSteps: AreaOpenStep[] = (isCurrent && focus?.step && !focus.step.done && !headings.has(focus.step.key))
      ? [focus.step, ...workableSteps.filter((s) => s.key !== focus.step!.key)]
          .slice(0, 3)
          .map((s) => ({ key: s.key, text: s.text, done: s.done }))
      : workableSteps.slice(0, 3).map((s) => ({ key: s.key, text: s.text, done: s.done }));

    // News summary for Tier 3 ("2 commits, 1 picture")
    let freshCommits = 0;
    for (const r of repoEntries) {
      freshCommits += r.commits.filter((c) => isCommitFresh(c.sha)).length;
    }
    const freshDocs = p.documents.filter((doc) => isDocFresh(doc));
    const freshDocPictures = freshDocs.filter((d) => fileTypeOf(d.filename ?? d.title) === 'image').length;
    const freshOtherDocs = freshDocs.length - freshDocPictures;
    const freshCards = p.cards.filter((c) => !c.archived && isFresh(c, now));
    const freshPictureCards = freshCards.filter((c) => c.kind === 'file' && fileTypeOf(c.path) === 'image').length;
    const freshNotes = freshCards.filter((c) => c.kind === 'note').length;
    const freshPictures = freshDocPictures + freshPictureCards;

    const freshPlanChanges = freshPlanChangesByArea.get(draft.id) ?? 0;
    const newsItems: AreaCountItem[] = [];
    if (freshCommits > 0) {
      const label = `${freshCommits} ${freshCommits === 1 ? 'commit' : 'commits'}`;
      newsItems.push({ kind: 'commits', count: freshCommits, label, actionLabel: `Show the ${label}` });
    }
    if (freshPictures > 0) {
      const label = `${freshPictures} ${freshPictures === 1 ? 'picture' : 'pictures'}`;
      newsItems.push({ kind: 'pictures', count: freshPictures, label, actionLabel: `Show the ${label}` });
    }
    if (freshOtherDocs > 0) {
      const label = `${freshOtherDocs} ${freshOtherDocs === 1 ? 'document' : 'documents'}`;
      newsItems.push({ kind: 'documents', count: freshOtherDocs, label, actionLabel: `Show the ${label}` });
    }
    if (freshNotes > 0) {
      const label = `${freshNotes} ${freshNotes === 1 ? 'note' : 'notes'}`;
      newsItems.push({ kind: 'notes', count: freshNotes, label, actionLabel: `Show the ${label}` });
    }
    if (freshPlanChanges > 0) {
      const label = `${freshPlanChanges} ${freshPlanChanges === 1 ? 'update' : 'updates'}`;
      newsItems.push({ kind: 'updates', count: freshPlanChanges, label, actionLabel: `Show the ${label}` });
    }
    if (newsItems.length === 0 && p.fresh) {
      newsItems.push({ kind: 'updates', count: 1, label: '1 update', actionLabel: 'Show the 1 update' });
    }
    const newsSummary = newsItems.length > 0 ? newsItems.map((item) => item.label).join(', ') : undefined;

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
      nowSet: isCurrent && nowSet,
      ...(isCurrent && focus?.step ? { focusStep: focus.step.key } : {}),
      ...(openSteps.length > 0 ? { openSteps } : {}),
      ...(nextOpenStep ? { nextOpenStep } : {}),
      ...(waitingQuestion ? { waitingQuestion } : {}),
      ...(newsSummary ? { newsSummary } : {}),
      ...(newsItems.length > 0 ? { newsItems } : {}),
      ...(p.newestChangeTime ? { newestChangeTime: p.newestChangeTime } : {}),
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
      ...(p.freshStepKey ? { freshStepKey: p.freshStepKey } : {}),
      ...(p.freshDecisionKey ? { freshDecisionKey: p.freshDecisionKey } : {}),
      ...(p.freshCheckpointKey ? { freshCheckpointKey: p.freshCheckpointKey } : {}),
      ...(freshPlanChanges > 0 ? { updateCount: freshPlanChanges } : {}),
    };

    result.push({
      id: draft.id,
      kind: draft.kind,
      checkpointKey: draft.checkpointKey,
      check: draft.check,
      proof: draft.proof,
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
  return areaCountItems(data).map((item) => item.label);
}

/**
 * How many lines a text takes in a card, 1 or 2 (a card cuts it at two): the width of its letters at that size, against the width of the
 * card less a tenth, since a line breaks at a word. It is a guess made without the browser; a text that is a little long takes the room
 * of a second line, and one that is a little short of the width stays on its one.
 */
function cardTextLines(text: string, size: number, weight = 1, width = CARD_TEXT_WIDTH): 1 | 2 {
  return textEm(text) * size * weight > width * 0.92 ? 2 : 1;
}

/** The width of a text in ems, guessed without the browser from the width of each kind of letter (`EM`): times the font size, it is px. */
export function textEm(text: string): number {
  let em = 0;
  for (const letter of text) {
    em += /[WMm@]/.test(letter) ? EM.wide : /[A-Z]/.test(letter) ? EM.capital : /[ijl.,;:!'|tfrI ]/.test(letter) ? EM.narrow : EM.other;
  }
  return em;
}

/** How high the interactive footer needs to be: each count is at least 24px tall, with spacing, wrapping cleanly if there are many counts. */
export function cardFooterHeight(data: AreaData, width: number = AREA_SIZE.width): number {
  const items = areaCountItems(data);
  if (items.length === 0 && !data.warning) return 0;
  const availableWidth = Math.max(100, width - 2 * CARD.pad - 2);
  let currentLineWidth = 0;
  let lines = 1;
  for (let i = 0; i < items.length; i++) {
    const itemWidth = textEm(items[i]!.label) * 12 + 16;
    if (currentLineWidth > 0 && currentLineWidth + itemWidth + 12 > availableWidth) {
      lines += 1;
      currentLineWidth = itemWidth;
    } else {
      currentLineWidth += itemWidth + (i > 0 ? 12 : 0);
    }
  }
  if (data.warning) {
    const warningWidth = textEm(data.warning) * 12 + 8;
    if (currentLineWidth > 0 && currentLineWidth + warningWidth + 12 > availableWidth) {
      lines += 1;
    }
  }
  return 8 + 8 + 1 + lines * 24 + (lines - 1) * 2 + 2;
}

/** How high an Area card needs to be for what it shows: its pictures or its preview, and its counts, only when it has them. */
export function areaCardHeight(data: AreaData): number {
  const title = cardTextLines(data.title, 14);
  const middle = data.pictures.length > 0
    ? CARD.pictures
    : data.preview ? CARD.more + cardTextLines(data.preview, 13.5, 0.93) * CARD.text : 0;
  const footer = cardFooterHeight(data, AREA_SIZE.width);
  return 2 * CARD.pad + CARD.head + CARD.gap + title * CARD.line + (data.kind === 'work' ? 0 : CARD.steps) + middle + footer;
}

export interface HeroCardOptions {
  width?: number;
  showPictures?: boolean;
  showPreview?: boolean;
  showFooter?: boolean;
  openStepLimit?: number;
}

/** How high the Tier 1 focus Area card needs to be for what it shows: title, open steps, pictures, counts. */
export function heroCardHeight(data: AreaData, options: HeroCardOptions | number = AREA_SIZE.width): number {
  const opts: HeroCardOptions = typeof options === 'number' ? { width: options } : options;
  const width = opts.width ?? AREA_SIZE.width;
  const textWidth = Math.max(100, width - 2 * CARD.pad - 2);
  const title = cardTextLines(data.title, 14, 1.05, textWidth);

  const stepLimit = opts.openStepLimit ?? 3;
  const openSteps = (data.openSteps ?? []).slice(0, stepLimit);
  const openStepsHeight = openSteps.length > 0 ? (openSteps.length * 28 + 8) : 0;
  const progressHeight = data.kind !== 'work' ? CARD.steps : 0;
  const stepsHeight = progressHeight + openStepsHeight;

  const showPics = opts.showPictures ?? true;
  const showPrev = opts.showPreview ?? true;
  const middle = (showPics && data.pictures.length > 0)
    ? CARD.pictures
    : (showPrev && data.preview) ? CARD.more + cardTextLines(data.preview, 13.5, 0.93, textWidth) * CARD.text : 0;

  const showFoot = opts.showFooter ?? true;
  const footer = showFoot ? cardFooterHeight(data, width) : 0;

  return 2 * CARD.pad + CARD.head + CARD.gap + title * CARD.line + stepsHeight + middle + footer + 2;
}

/** Computes what fits in the hero card whole without mid-line clipping. */
export function fitHeroCard(data: AreaData, width: number, maxAvailableHeight: number): {
  height: number;
  config: { heroShowPictures: boolean; heroShowPreview: boolean; heroShowFooter: boolean; heroOpenStepLimit: number };
} {
  let config = { heroShowPictures: true, heroShowPreview: true, heroShowFooter: true, heroOpenStepLimit: 3 };
  let height = heroCardHeight(data, { width, showPictures: config.heroShowPictures, showPreview: config.heroShowPreview, showFooter: config.heroShowFooter, openStepLimit: config.heroOpenStepLimit });
  if (height <= maxAvailableHeight) {
    return { height, config };
  }

  // 1. Drop preview or pictures whole
  config = { ...config, heroShowPictures: false, heroShowPreview: false };
  height = heroCardHeight(data, { width, showPictures: config.heroShowPictures, showPreview: config.heroShowPreview, showFooter: config.heroShowFooter, openStepLimit: config.heroOpenStepLimit });
  if (height <= maxAvailableHeight) {
    return { height, config };
  }

  // 2. Drop footer whole
  config = { ...config, heroShowFooter: false };
  height = heroCardHeight(data, { width, showPictures: config.heroShowPictures, showPreview: config.heroShowPreview, showFooter: config.heroShowFooter, openStepLimit: config.heroOpenStepLimit });
  if (height <= maxAvailableHeight) {
    return { height, config };
  }

  // 3. Drop open steps: 2 steps, then 1 step (never drop below 1 if open steps exist)
  const minLimit = (data.openSteps && data.openSteps.length > 0) ? 1 : 0;
  for (const limit of [2, 1]) {
    if (limit < minLimit) break;
    config = { ...config, heroOpenStepLimit: limit };
    height = heroCardHeight(data, { width, showPictures: config.heroShowPictures, showPreview: config.heroShowPreview, showFooter: config.heroShowFooter, openStepLimit: config.heroOpenStepLimit });
    if (height <= maxAvailableHeight || limit === minLimit) {
      return { height, config };
    }
  }

  return { height, config };
}

export interface OverviewTiers {
  tier1: BoardArea[];
  tier2: BoardArea[];
  tier3: BoardArea[];
  tier4: BoardArea[];
  tier5: BoardArea[];
}

/**
 * Pure function partitioning the Areas into the 5 tiers of Level 0:
 * 1. The focus Area, large (the one under way or first open checkpoint)
 * 2. Waits for you: Areas holding a question
 * 3. Moved since you looked: Areas with something new from news data
 * 4. Everything else still open, in plan order
 * 5. Done: finished Areas
 *
 * Rules: each Area appears once, in the first tier that fits it. Tier 4 preserves plan order.
 */
export function partitionOverviewTiers(areas: BoardArea[]): OverviewTiers {
  if (areas.length === 0) {
    return { tier1: [], tier2: [], tier3: [], tier4: [], tier5: [] };
  }
  const allDone = areas.every((a) => a.data.done && (a.data.waitingCount ?? 0) === 0);
  if (allDone) {
    return { tier1: [], tier2: [], tier3: [], tier4: [], tier5: [...areas] };
  }
  const focusArea = areas.find((a) => a.data.current && !a.data.done) ?? areas.find((a) => !a.data.done);
  if (!focusArea) {
    const tier2 = areas.filter((a) => (a.data.waitingCount ?? 0) > 0);
    const tier5 = areas.filter((a) => (a.data.waitingCount ?? 0) === 0);
    return { tier1: [], tier2, tier3: [], tier4: [], tier5 };
  }
  const tier1 = [focusArea];
  let remaining = areas.filter((a) => a.id !== focusArea.id);

  const tier2 = remaining.filter((a) => a.data.waitingCount > 0);
  remaining = remaining.filter((a) => a.data.waitingCount === 0);

  // Tier 3: Moved since you looked: Areas with something new from news data.
  // Capped to at most 3 Areas with the newest changes so the tier still means something.
  // Any areas beyond the cap stay in Tier 4 in plan order.
  const tier3Candidates = remaining.filter((a) => Boolean(a.data.newsSummary));
  const sortedTier3 = [...tier3Candidates].sort((a, b) => (b.data.newestChangeTime ?? 0) - (a.data.newestChangeTime ?? 0));
  const MAX_TIER3 = 3;
  const tier3 = sortedTier3.slice(0, MAX_TIER3);
  const tier3Set = new Set(tier3.map((a) => a.id));
  remaining = remaining.filter((a) => !tier3Set.has(a.id));

  const tier5 = remaining.filter((a) => a.data.done);
  const tier4 = remaining.filter((a) => !a.data.done);

  return { tier1, tier2, tier3, tier4, tier5 };
}

/** The room the overview's Areas have, in px of the stage: the stage less its insets. */
function overviewRoom(size: Size) {
  return { x: OVERVIEW_INSET.side, width: Math.max(1, size.width - 2 * OVERVIEW_INSET.side), top: OVERVIEW_INSET.top, height: Math.max(1, size.height - OVERVIEW_INSET.top - OVERVIEW_INSET.bottom) };
}

export interface OverviewPlan {
  form: 'cards' | 'minis' | 'rows';
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

/** The id of the overview's one last row of folded Areas. */
export const OVERVIEW_FOLD = 'overview:fold';

/** The smallest a small card is for a picture to sit beside its text. */
export const MINI_PICTURE = { minWidth: 240, minHeight: 92 } as const;
/** From this height on, "Now" and "Waiting" get a line under the title; below it they share the line of the steps. */
export const MINI_STATUS_LINE = 96;

/**
 * Whether a small card of this size shows its picture. Not where "Now" and "Waiting" share the line of the steps (under
 * MINI_STATUS_LINE): that line and the picture would not both fit beside each other.
 */
export function miniShowsPicture(width: number, height: number, hasStatus: boolean): boolean {
  if (width < MINI_PICTURE.minWidth || height < MINI_PICTURE.minHeight) return false;
  return !hasStatus || height >= MINI_STATUS_LINE;
}

/**
 * Lays out Level 0: clear tiers top to bottom, all on one screen with no scrolling or panning:
 * 1. The focus Area, large (hero card: title, Now/Next up step, next two open steps, pictures, counts, question count)
 * 2. Waits for you: Areas holding a question, with the question's first words
 * 3. Moved since you looked: Areas with something new from news data ("2 commits, 1 picture")
 * 4. Everything else still open: small quiet rows or small cards in plan order, each with title, next open step, and 0 of 4
 * 5. Done: folded into one line ("1 done"), which opens in place
 *
 * Rules: each Area appears once, in the first tier that fits it. Tier 4 preserves plan order.
 * Pure: the form and layout follow from the stage's size and the Areas.
 */
export function overviewPlan(areas: BoardArea[], size: Size, options: { expanded?: boolean } = {}): OverviewPlan {
  if (areas.length === 0) return { form: 'cards', nodes: [], viewport: null };
  if (size.width <= 0 || size.height <= 0) {
    const cols = Math.min(areas.length, 3);
    const lines = cardLines(areas, cols);
    const nodes = areas.map((area, index): AreaNode => {
      const line = Math.floor(index / cols);
      const height = lines[line]!;
      return {
        id: area.id,
        type: 'area',
        position: { x: (index % cols) * (AREA_SIZE.width + AREA_SIZE.gapX), y: lines.slice(0, line).reduce((sum, above) => sum + above + AREA_SIZE.gapY, 0) },
        width: AREA_SIZE.width,
        height,
        measured: { width: AREA_SIZE.width, height },
        data: area.data,
        ...FIXED,
      };
    });
    return { form: 'cards', nodes, viewport: null };
  }

  const room = overviewRoom(size);

  if (areas.length === 1) {
    const area = areas[0]!;
    const heroWidth = Math.min(room.width, AREA_SIZE.width);
    const { height, config } = fitHeroCard(area.data, heroWidth, room.height);
    const x = room.x + Math.floor((room.width - heroWidth) / 2);
    const y = room.top + Math.floor((room.height - height) / 2);
    const node: AreaNode = {
      id: area.id,
      type: 'area',
      position: { x, y },
      width: heroWidth,
      height,
      measured: { width: heroWidth, height },
      data: { ...area.data, ...config, tier: 1 },
      ...FIXED,
    };
    return { form: 'cards', nodes: [node], viewport: { x: 0, y: 0, zoom: 1 } };
  }

  const tiers = partitionOverviewTiers(areas);
  const miniMaxCols = Math.floor((room.width + AREA_MINI.gap) / (AREA_MINI.minWidth + AREA_MINI.gap));

  // If the stage is too narrow for 2 columns of small cards, or too short for a hero card, or no active focus Area with waiting questions, use rows
  if (miniMaxCols < 2 || room.height < 150 || (tiers.tier1.length === 0 && tiers.tier2.length > 0)) {
    const step = AREA_ROW.height + AREA_ROW.gap;

    // If stage is too short (< 150) or there's no active focus Area (all done), draw all rows
    if (room.height < 150 || tiers.tier1.length === 0) {
      const perCol = Math.max(1, Math.floor((room.height + AREA_ROW.gap) / step));
      const maxCols = Math.max(1, Math.floor((room.width + AREA_ROW.gapX) / (AREA_ROW.minWidth + AREA_ROW.gapX)));
      const totalSlots = perCol * maxCols;
      const hasDone = tiers.tier5.length > 0;

      const totalOpen = (tiers.tier1[0] ? 1 : 0) + tiers.tier2.length + tiers.tier3.length + tiers.tier4.length;
      const needFold = hasDone || totalOpen > totalSlots;
      const maxRowSlots = needFold ? Math.max(0, totalSlots - 1) : totalSlots;

      let rem = maxRowSlots;
      const shutTier1 = tiers.tier1[0] && rem > 0 ? (rem--, [tiers.tier1[0]]) : [];
      const shutTier2 = tiers.tier2.slice(0, rem); rem = Math.max(0, rem - shutTier2.length);
      const shutTier3 = tiers.tier3.slice(0, rem); rem = Math.max(0, rem - shutTier3.length);
      const shutTier4 = tiers.tier4.slice(0, rem);

      const overflowWaiting = tiers.tier2.length - shutTier2.length;
      const overflowTier3 = tiers.tier3.length - shutTier3.length;
      const overflowTier4 = tiers.tier4.length - shutTier4.length;
      const overflowTier1 = tiers.tier1[0] && shutTier1.length === 0 ? 1 : 0;
      const overflowOtherOpen = overflowTier1 + overflowTier3 + overflowTier4;
      const overflowOpen = overflowWaiting + overflowOtherOpen;
      const overflowDone = hasDone ? tiers.tier5.length : 0;
      const hasFold = overflowOpen + overflowDone > 0;
      const foldKind: 'done' | 'more' = (overflowOpen === 0 && hasDone) ? 'done' : 'more';
      const moreCount = overflowOtherOpen;
      const doneCount = overflowDone;
      const foldDisplayCount = overflowOpen + overflowDone;

      const rowItems: { area: BoardArea; tier: 1 | 2 | 3 | 4 | 5 }[] = options.expanded
        ? [
            ...tiers.tier1.map((area) => ({ area, tier: 1 as const })),
            ...tiers.tier2.map((area) => ({ area, tier: 2 as const })),
            ...tiers.tier3.map((area) => ({ area, tier: 3 as const })),
            ...tiers.tier4.map((area) => ({ area, tier: 4 as const })),
            ...tiers.tier5.map((area) => ({ area, tier: 5 as const })),
          ]
        : [
            ...shutTier1.map((area) => ({ area, tier: 1 as const })),
            ...shutTier2.map((area) => ({ area, tier: 2 as const })),
            ...shutTier3.map((area) => ({ area, tier: 3 as const })),
            ...shutTier4.map((area) => ({ area, tier: 4 as const })),
          ];

      const shutCount = shutTier1.length + shutTier2.length + shutTier3.length + shutTier4.length + (hasFold ? 1 : 0);
      const actualCols = Math.min(maxCols, Math.max(1, Math.ceil(shutCount / perCol)));
      const colWidth = Math.min(AREA_ROW.maxWidth, Math.floor((room.width - (actualCols - 1) * AREA_ROW.gapX) / actualCols));
      const totalWidth = actualCols * colWidth + (actualCols - 1) * AREA_ROW.gapX;
      const startX = room.x + Math.floor((room.width - totalWidth) / 2);

      const nodes: OverviewNode[] = [];
      rowItems.forEach(({ area, tier }, index) => {
        const c = index % actualCols;
        const r = Math.floor(index / actualCols);
        nodes.push({
          id: area.id,
          type: 'areaRow',
          position: { x: startX + c * (colWidth + AREA_ROW.gapX), y: r * step },
          width: colWidth,
          height: AREA_ROW.height,
          measured: { width: colWidth, height: AREA_ROW.height },
          data: { ...area.data, tier },
          ...FIXED,
        });
      });

      if (hasFold) {
        const foldIndex = rowItems.length;
        const c = foldIndex % actualCols;
        const r = Math.floor(foldIndex / actualCols);
        nodes.push({
          id: OVERVIEW_FOLD,
          type: 'areaFold',
          position: { x: startX + c * (colWidth + AREA_ROW.gapX), y: r * step },
          width: colWidth,
          height: AREA_ROW.height,
          measured: { width: colWidth, height: AREA_ROW.height },
          data: {
            count: foldDisplayCount,
            kind: foldKind,
            ...(overflowWaiting > 0
              ? {
                  waitingCount: overflowWaiting,
                  ...(moreCount > 0 ? { moreCount } : {}),
                  ...(doneCount > 0 ? { doneCount } : {}),
                }
              : (moreCount > 0 && doneCount > 0 ? { moreCount, doneCount } : {})),
            expanded: options.expanded ?? false,
          },
          ...FIXED,
        });
      }

      return { form: 'rows', nodes, viewport: { x: 0, y: room.top, zoom: 1 } };
    }

    // Narrow stage (e.g. 420 pane or phone) with sufficient height: Tier 1 is hero card (with Now step alone), lower tiers are rows
    const focusArea = tiers.tier1[0]!;
    const heroWidth = Math.min(room.width, 560);
    const hasDone = tiers.tier5.length > 0;

    // In 420 pane or very short window: focus Area drops to Now step alone
    const minLowerSpace = 8 + step + (hasDone || tiers.tier4.length > 0 ? step : 0);
    const maxAvailableForHero = Math.max(100, room.height - minLowerSpace);
    const { config: heroConfig } = fitHeroCard(focusArea.data, heroWidth, maxAvailableForHero);
    const narrowStepLimit = (focusArea.data.openSteps && focusArea.data.openSteps.length > 0) ? 1 : 0;
    const finalHeroConfig = {
      ...heroConfig,
      heroOpenStepLimit: Math.min(narrowStepLimit, heroConfig.heroOpenStepLimit),
      heroShowPictures: false,
      heroShowPreview: false,
    };
    const finalHeroHeight = heroCardHeight(focusArea.data, {
      width: heroWidth,
      showPictures: false,
      showPreview: false,
      showFooter: finalHeroConfig.heroShowFooter,
      openStepLimit: finalHeroConfig.heroOpenStepLimit,
    });

    const heroX = room.x + Math.floor((room.width - heroWidth) / 2);
    const heroY = 0;
    const heroNode: AreaNode = {
      id: focusArea.id,
      type: 'area',
      position: { x: heroX, y: heroY },
      width: heroWidth,
      height: finalHeroHeight,
      measured: { width: heroWidth, height: finalHeroHeight },
      data: { ...focusArea.data, ...finalHeroConfig, tier: 1 },
      ...FIXED,
    };

    const tierGapY = 8;
    const startY = heroY + finalHeroHeight + tierGapY;
    const availableHeight = Math.max(1, room.height - startY);
    const perCol = Math.max(1, Math.floor((availableHeight + AREA_ROW.gap) / step));
    const totalSlots = perCol;

    const totalOpenLower = tiers.tier2.length + tiers.tier3.length + tiers.tier4.length;
    const needFold = hasDone || totalOpenLower > totalSlots;
    const maxRowSlots = needFold ? Math.max(0, totalSlots - 1) : totalSlots;

    let rem = maxRowSlots;
    const shutTier2 = tiers.tier2.slice(0, rem); rem = Math.max(0, rem - shutTier2.length);
    const shutTier3 = tiers.tier3.slice(0, rem); rem = Math.max(0, rem - shutTier3.length);
    const shutTier4 = tiers.tier4.slice(0, rem);

    const overflowWaiting = tiers.tier2.length - shutTier2.length;
    const overflowTier3 = tiers.tier3.length - shutTier3.length;
    const overflowTier4 = tiers.tier4.length - shutTier4.length;
    const overflowOtherOpen = overflowTier3 + overflowTier4;
    const overflowOpen = overflowWaiting + overflowOtherOpen;
    const overflowDone = hasDone ? tiers.tier5.length : 0;
    const hasFold = overflowOpen + overflowDone > 0;
    const foldKind: 'done' | 'more' = (overflowOpen === 0 && hasDone) ? 'done' : 'more';
    const moreCount = overflowOtherOpen;
    const doneCount = overflowDone;
    const foldDisplayCount = overflowOpen + overflowDone;

    const colWidth = Math.min(AREA_ROW.maxWidth, room.width);
    const startX = room.x + Math.floor((room.width - colWidth) / 2);

    const rowItems: { area: BoardArea; tier: 2 | 3 | 4 | 5 }[] = options.expanded
      ? [
          ...tiers.tier2.map((area) => ({ area, tier: 2 as const })),
          ...tiers.tier3.map((area) => ({ area, tier: 3 as const })),
          ...tiers.tier4.map((area) => ({ area, tier: 4 as const })),
          ...tiers.tier5.map((area) => ({ area, tier: 5 as const })),
        ]
      : [
          ...shutTier2.map((area) => ({ area, tier: 2 as const })),
          ...shutTier3.map((area) => ({ area, tier: 3 as const })),
          ...shutTier4.map((area) => ({ area, tier: 4 as const })),
        ];

    const nodes: OverviewNode[] = [heroNode];
    rowItems.forEach(({ area, tier }, index) => {
      nodes.push({
        id: area.id,
        type: 'areaRow',
        position: { x: startX, y: startY + index * step },
        width: colWidth,
        height: AREA_ROW.height,
        measured: { width: colWidth, height: AREA_ROW.height },
        data: { ...area.data, tier },
        ...FIXED,
      });
    });

    if (hasFold) {
      nodes.push({
        id: OVERVIEW_FOLD,
        type: 'areaFold',
        position: { x: startX, y: startY + rowItems.length * step },
        width: colWidth,
        height: AREA_ROW.height,
        measured: { width: colWidth, height: AREA_ROW.height },
        data: {
          count: foldDisplayCount,
          kind: foldKind,
          ...(overflowWaiting > 0
            ? {
                waitingCount: overflowWaiting,
                ...(moreCount > 0 ? { moreCount } : {}),
                ...(doneCount > 0 ? { doneCount } : {}),
              }
            : (moreCount > 0 && doneCount > 0 ? { moreCount, doneCount } : {})),
          expanded: options.expanded ?? false,
        },
        ...FIXED,
      });
    }

    return { form: 'rows', nodes, viewport: { x: 0, y: room.top, zoom: 1 } };
  }

  // Case: All areas are Done (tier1 is empty)
  if (tiers.tier1.length === 0) {
    const doneAreas = tiers.tier5;
    const totalCount = doneAreas.length;
    if (!options.expanded) {
      const foldWidth = Math.min(room.width, 560);
      const foldX = room.x + Math.floor((room.width - foldWidth) / 2);
      const foldY = Math.floor((room.height - 36) / 2);
      const foldNode: AreaFoldNode = {
        id: OVERVIEW_FOLD,
        type: 'areaFold',
        position: { x: foldX, y: foldY },
        width: foldWidth,
        height: 36,
        measured: { width: foldWidth, height: 36 },
        data: { count: totalCount, kind: 'done', expanded: false },
        ...FIXED,
      };
      return { form: 'minis', nodes: [foldNode], viewport: { x: 0, y: room.top, zoom: 1 } };
    }

    const miniMaxCols = Math.floor((room.width + AREA_MINI.gap) / (AREA_MINI.minWidth + AREA_MINI.gap));
    const foldHeight = 36;
    const foldGap = 8;
    const cardAreaHeight = room.height - (foldHeight + foldGap);

    let bestGrid: { cols: number; width: number; height: number } | null = null;
    for (let cols = 2; cols <= miniMaxCols; cols++) {
      const width = Math.min(AREA_MINI.maxWidth, Math.floor((room.width - (cols - 1) * AREA_MINI.gap) / cols));
      const lines = Math.ceil(totalCount / cols);
      const height = Math.min(AREA_MINI.maxHeight, Math.floor((cardAreaHeight - (lines - 1) * AREA_MINI.gap) / lines));
      if (height < AREA_MINI.minHeight) continue;
      if (height >= AREA_MINI.comfyHeight) { bestGrid = { cols, width, height }; break; }
      if (!bestGrid || height > bestGrid.height) bestGrid = { cols, width, height };
    }

    if (bestGrid) {
      const { cols, width, height } = bestGrid;
      const gap = AREA_MINI.gap;
      const totalWidth = cols * width + (cols - 1) * gap;
      const startX = room.x + Math.floor((room.width - totalWidth) / 2);
      const tierY = 0;
      const nodes: OverviewNode[] = [];
      doneAreas.forEach((area, index) => {
        const c = index % cols;
        const r = Math.floor(index / cols);
        nodes.push({
          id: area.id,
          type: 'areaMini',
          position: { x: startX + c * (width + gap), y: tierY + r * (height + gap) },
          width,
          height,
          measured: { width, height },
          data: { ...area.data, tier: 5 },
          ...FIXED,
        });
      });
      const lines = Math.ceil(totalCount / cols);
      const foldY = lines > 0 ? (lines - 1) * (height + gap) + height + foldGap : 0;
      nodes.push({
        id: OVERVIEW_FOLD,
        type: 'areaFold',
        position: { x: startX, y: foldY },
        width: totalWidth,
        height: foldHeight,
        measured: { width: totalWidth, height: foldHeight },
        data: { count: totalCount, kind: 'done', expanded: true },
        ...FIXED,
      });
      return { form: 'minis', nodes, viewport: { x: 0, y: room.top, zoom: 1 } };
    }

    // Fallback to rows when expanded
    const step = AREA_ROW.height + AREA_ROW.gap;
    const maxCols = Math.max(1, Math.floor((room.width + AREA_ROW.gapX) / (AREA_ROW.minWidth + AREA_ROW.gapX)));
    const actualCols = Math.min(maxCols, Math.max(1, Math.ceil(totalCount / 6)));
    const colWidth = Math.min(AREA_ROW.maxWidth, Math.floor((room.width - (actualCols - 1) * AREA_ROW.gapX) / actualCols));
    const totalWidth = actualCols * colWidth + (actualCols - 1) * AREA_ROW.gapX;
    const startX = room.x + Math.floor((room.width - totalWidth) / 2);
    let tierY = 0;
    const nodes: OverviewNode[] = [];
    doneAreas.forEach((area, index) => {
      const c = index % actualCols;
      const r = Math.floor(index / actualCols);
      nodes.push({
        id: area.id,
        type: 'areaRow',
        position: { x: startX + c * (colWidth + AREA_ROW.gapX), y: tierY + r * step },
        width: colWidth,
        height: AREA_ROW.height,
        measured: { width: colWidth, height: AREA_ROW.height },
        data: { ...area.data, tier: 5 },
        ...FIXED,
      });
    });
    tierY += Math.ceil(totalCount / actualCols) * step;
    nodes.push({
      id: OVERVIEW_FOLD,
      type: 'areaFold',
      position: { x: startX, y: tierY },
      width: totalWidth,
      height: AREA_ROW.height,
      measured: { width: totalWidth, height: AREA_ROW.height },
      data: { count: totalCount, kind: 'done', expanded: true },
      ...FIXED,
    });
    return { form: 'rows', nodes, viewport: { x: 0, y: room.top, zoom: 1 } };
  }

  // Multi-area workspace with an active focus Area
  const focusArea = tiers.tier1[0]!;
  const heroWidth = Math.min(room.width, 560);
  const hasDone = tiers.tier5.length > 0;
  const foldHeight = 36;
  const foldGap = 6;

  const tierGapY = 8;
  const tier2Lines = tiers.tier2.length > 0 ? Math.ceil(tiers.tier2.length / 2) : 0;
  const tier3Lines = tiers.tier3.length > 0 ? Math.ceil(tiers.tier3.length / 2) : 0;
  const tier4Lines = tiers.tier4.length > 0 ? Math.ceil(tiers.tier4.length / 2) : 0;
  const totalLowerLines = tier2Lines + tier3Lines + tier4Lines;
  const foldReserved = (hasDone || tiers.tier4.length > 0) ? (foldHeight + foldGap) : 0;

  const allComfySpace = tierGapY + totalLowerLines * (AREA_MINI.comfyHeight + AREA_MINI.gap) + foldReserved;
  const allMinSpace = tierGapY + totalLowerLines * (AREA_MINI.minHeight + AREA_MINI.gap) + foldReserved;

  const hero3Steps = heroCardHeight(focusArea.data, { width: heroWidth, showPictures: false, showPreview: false, showFooter: false, openStepLimit: 3 });
  const hero3StepsWithFooter = heroCardHeight(focusArea.data, { width: heroWidth, showPictures: false, showPreview: false, showFooter: true, openStepLimit: 3 });
  const heroFull = heroCardHeight(focusArea.data, { width: heroWidth, showPictures: true, showPreview: true, showFooter: true, openStepLimit: 3 });

  let maxAvailableForHero: number;
  if (room.height - allComfySpace >= heroFull) {
    maxAvailableForHero = room.height - allComfySpace;
  } else if (room.height - allComfySpace >= hero3StepsWithFooter) {
    maxAvailableForHero = room.height - allComfySpace;
  } else if (room.height - allMinSpace >= heroFull) {
    maxAvailableForHero = room.height - allMinSpace;
  } else if (room.height - allMinSpace >= hero3StepsWithFooter) {
    maxAvailableForHero = room.height - allMinSpace;
  } else if (room.height - allMinSpace >= hero3Steps) {
    maxAvailableForHero = room.height - allMinSpace;
  } else {
    // When lower tiers cannot all fit, Tier 4 folds into "N more" to make room for focus card's steps
    const fixedLines = tier2Lines + tier3Lines;
    const minLowerLines = Math.max(1, fixedLines + (fixedLines === 0 && tiers.tier4.length > 0 ? 1 : 0));
    const minLowerSpace = tierGapY + minLowerLines * (AREA_MINI.minHeight + AREA_MINI.gap) + foldReserved;
    const available = room.height - minLowerSpace;
    if (available >= hero3StepsWithFooter) {
      maxAvailableForHero = available;
    } else {
      maxAvailableForHero = Math.max(hero3Steps, available);
    }
  }

  const { height: heroHeight, config: heroConfig } = fitHeroCard(focusArea.data, heroWidth, maxAvailableForHero);
  const heroX = room.x + Math.floor((room.width - heroWidth) / 2);
  const heroY = 0;

  const heroNode: AreaNode = {
    id: focusArea.id,
    type: 'area',
    position: { x: heroX, y: heroY },
    width: heroWidth,
    height: heroHeight,
    measured: { width: heroWidth, height: heroHeight },
    data: { ...focusArea.data, ...heroConfig, tier: 1 },
    ...FIXED,
  };

  let startY = heroY + heroHeight + tierGapY;
  let availableHeight = Math.max(1, room.height - startY);

  // Try small cards ('minis')
  if (miniMaxCols >= 2) {
    let bestGrid: {
      cols: number;
      width: number;
      height: number;
      shownTier4: BoardArea[];
      overflowTier4: BoardArea[];
    } | null = null;

    for (let cols = 2; cols <= miniMaxCols; cols++) {
      const width = Math.min(AREA_MINI.maxWidth, Math.floor((room.width - (cols - 1) * AREA_MINI.gap) / cols));
      const tier2Lines = tiers.tier2.length > 0 ? Math.ceil(tiers.tier2.length / cols) : 0;
      const tier3Lines = tiers.tier3.length > 0 ? Math.ceil(tiers.tier3.length / cols) : 0;
      const fixedLines = tier2Lines + tier3Lines;

      let reservedBottom = hasDone ? (foldHeight + foldGap) : 0;
      let cardAreaHeight = availableHeight - reservedBottom;
      let maxCardLines = Math.max(0, Math.floor((cardAreaHeight + AREA_MINI.gap + 0.001) / (AREA_MINI.minHeight + AREA_MINI.gap)));

      if (maxCardLines < fixedLines) continue;

      let availableLinesForTier4 = maxCardLines - fixedLines;
      const tier4NeededLines = tiers.tier4.length > 0 ? Math.ceil(tiers.tier4.length / cols) : 0;

      let shownTier4 = tiers.tier4;
      let overflowTier4: BoardArea[] = [];

      if (tier4NeededLines > availableLinesForTier4) {
        if (!hasDone) {
          reservedBottom = foldHeight + foldGap;
          cardAreaHeight = availableHeight - reservedBottom;
          maxCardLines = Math.max(0, Math.floor((cardAreaHeight + AREA_MINI.gap + 0.001) / (AREA_MINI.minHeight + AREA_MINI.gap)));
          availableLinesForTier4 = Math.max(0, maxCardLines - fixedLines);
        }
        const shownLines = availableLinesForTier4;
        const shownCount = Math.min(tiers.tier4.length, shownLines * cols);
        shownTier4 = tiers.tier4.slice(0, shownCount);
        overflowTier4 = tiers.tier4.slice(shownCount);
      }

      const shownTier4Lines = shownTier4.length > 0 ? Math.ceil(shownTier4.length / cols) : 0;
      const linesForSizing = fixedLines + shownTier4Lines;
      const effectiveCardHeight = availableHeight - ((hasDone || overflowTier4.length > 0) ? (foldHeight + foldGap) : 0);

      const height = linesForSizing > 0
        ? Math.min(AREA_MINI.maxHeight, Math.floor((effectiveCardHeight - (linesForSizing - 1) * AREA_MINI.gap) / linesForSizing))
        : AREA_MINI.comfyHeight;

      if (height < AREA_MINI.minHeight) continue;

      const isComfy = height >= AREA_MINI.comfyHeight;
      const bestIsComfy = bestGrid && bestGrid.height >= AREA_MINI.comfyHeight;

      let isBetter = false;
      if (!bestGrid) {
        isBetter = true;
      } else if (isComfy && !bestIsComfy) {
        isBetter = true;
      } else if (isComfy && bestIsComfy) {
        isBetter = overflowTier4.length < bestGrid.overflowTier4.length ||
          (overflowTier4.length === bestGrid.overflowTier4.length && cols < bestGrid.cols);
      } else if (!isComfy && !bestIsComfy) {
        isBetter = overflowTier4.length < bestGrid.overflowTier4.length ||
          (overflowTier4.length === bestGrid.overflowTier4.length && height > bestGrid.height);
      }

      if (isBetter) {
        bestGrid = { cols, width, height, shownTier4, overflowTier4 };
      }
    }

    if (bestGrid) {
      const { cols, width, height, shownTier4, overflowTier4 } = bestGrid;
      const gap = AREA_MINI.gap;
      const totalWidth = cols * width + (cols - 1) * gap;
      const startX = room.x + Math.floor((room.width - totalWidth) / 2);

      const hasFold = hasDone || overflowTier4.length > 0;
      const foldKind: 'done' | 'more' = (overflowTier4.length === 0 && hasDone) ? 'done' : 'more';
      const foldCount = overflowTier4.length + (hasDone ? tiers.tier5.length : 0);
      const moreCount = overflowTier4.length;
      const doneCount = hasDone ? tiers.tier5.length : 0;

      const nodes: OverviewNode[] = [heroNode];
      let tierY = startY;

      // Tier 2: Waits for you (starts own line)
      if (tiers.tier2.length > 0) {
        tiers.tier2.forEach((area, index) => {
          const c = index % cols;
          const r = Math.floor(index / cols);
          nodes.push({
            id: area.id,
            type: 'areaMini',
            position: { x: startX + c * (width + gap), y: tierY + r * (height + gap) },
            width,
            height,
            measured: { width, height },
            data: { ...area.data, tier: 2 },
            ...FIXED,
          });
        });
        tierY += Math.ceil(tiers.tier2.length / cols) * (height + gap);
      }

      // Tier 3: Moved since you looked (starts own line)
      if (tiers.tier3.length > 0) {
        tiers.tier3.forEach((area, index) => {
          const c = index % cols;
          const r = Math.floor(index / cols);
          nodes.push({
            id: area.id,
            type: 'areaMini',
            position: { x: startX + c * (width + gap), y: tierY + r * (height + gap) },
            width,
            height,
            measured: { width, height },
            data: { ...area.data, tier: 3 },
            ...FIXED,
          });
        });
        tierY += Math.ceil(tiers.tier3.length / cols) * (height + gap);
      }

      // Tier 4: Everything else still open (starts own line)
      const tier4List = options.expanded ? tiers.tier4 : shownTier4;
      if (tier4List.length > 0) {
        tier4List.forEach((area, index) => {
          const c = index % cols;
          const r = Math.floor(index / cols);
          nodes.push({
            id: area.id,
            type: 'areaMini',
            position: { x: startX + c * (width + gap), y: tierY + r * (height + gap) },
            width,
            height,
            measured: { width, height },
            data: { ...area.data, tier: 4 },
            ...FIXED,
          });
        });
        tierY += Math.ceil(tier4List.length / cols) * (height + gap);
      }

      // Tier 5: Done areas (when expanded)
      if (options.expanded && hasDone) {
        tiers.tier5.forEach((area, index) => {
          const c = index % cols;
          const r = Math.floor(index / cols);
          nodes.push({
            id: area.id,
            type: 'areaMini',
            position: { x: startX + c * (width + gap), y: tierY + r * (height + gap) },
            width,
            height,
            measured: { width, height },
            data: { ...area.data, tier: 5 },
            ...FIXED,
          });
        });
        tierY += Math.ceil(tiers.tier5.length / cols) * (height + gap);
      }

      // Full-width fold line at bottom
      if (hasFold) {
        const foldTop = (nodes.length > 1) ? (tierY - gap + foldGap) : tierY;
        nodes.push({
          id: OVERVIEW_FOLD,
          type: 'areaFold',
          position: { x: startX, y: foldTop },
          width: totalWidth,
          height: foldHeight,
          measured: { width: totalWidth, height: foldHeight },
          data: {
            count: foldCount,
            kind: foldKind,
            ...(moreCount > 0 && doneCount > 0 ? { moreCount, doneCount } : {}),
            expanded: options.expanded ?? false,
          },
          ...FIXED,
        });
      }

      return { form: 'minis', nodes, viewport: { x: 0, y: room.top, zoom: 1 } };
    }
  }

  // Fallback to rows ('rows')
  const step = AREA_ROW.height + AREA_ROW.gap;
  const maxCols = Math.max(1, Math.floor((room.width + AREA_ROW.gapX) / (AREA_ROW.minWidth + AREA_ROW.gapX)));

  let currentHeroHeight = heroHeight;
  let currentHeroNode = heroNode;

  const actualCols = maxCols >= 2 ? 2 : 1;
  const colWidth = Math.min(AREA_ROW.maxWidth, Math.floor((room.width - (actualCols - 1) * AREA_ROW.gapX) / actualCols));
  const totalWidth = actualCols * colWidth + (actualCols - 1) * AREA_ROW.gapX;
  const startX = room.x + Math.floor((room.width - totalWidth) / 2);

  startY = heroY + currentHeroHeight + tierGapY;
  availableHeight = Math.max(1, room.height - startY);
  let perCol = Math.max(1, Math.floor((availableHeight + AREA_ROW.gap) / step));
  let totalSlots = perCol * actualCols;

  const totalOpenLower = tiers.tier2.length + tiers.tier3.length + tiers.tier4.length;
  let needFold = hasDone || totalOpenLower > totalSlots;
  let maxRowSlots = needFold ? Math.max(0, totalSlots - 1) : totalSlots;

  // When lower tiers cannot all fit, tier 3 gives way first (taking no slots ahead of tier 2).
  // If tier 2 alone still exceeds maxRowSlots, the focus card drops to fewer steps.
  if (tiers.tier2.length > maxRowSlots) {
    const tier2NeededLines = Math.ceil(tiers.tier2.length / actualCols);
    const needFoldForTier2 = hasDone || totalOpenLower > tiers.tier2.length || tiers.tier2.length > maxRowSlots;
    const neededLines = tier2NeededLines + (needFoldForTier2 ? 1 : 0);
    const neededLowerSpace = tierGapY + neededLines * step;
    const maxAvailableForHeroInRows = Math.max(100, room.height - neededLowerSpace);
    const { height: newHeroHeight, config: newHeroConfig } = fitHeroCard(focusArea.data, heroWidth, maxAvailableForHeroInRows);
    if (newHeroHeight < currentHeroHeight) {
      currentHeroHeight = newHeroHeight;
      currentHeroNode = {
        ...currentHeroNode,
        height: currentHeroHeight,
        measured: { width: heroWidth, height: currentHeroHeight },
        data: { ...focusArea.data, ...newHeroConfig, tier: 1 },
      };
      startY = heroY + currentHeroHeight + tierGapY;
      availableHeight = Math.max(1, room.height - startY);
      perCol = Math.max(1, Math.floor((availableHeight + AREA_ROW.gap) / step));
      totalSlots = perCol * actualCols;
      needFold = hasDone || totalOpenLower > totalSlots;
      maxRowSlots = needFold ? Math.max(0, totalSlots - 1) : totalSlots;
    }
  }

  let rem = maxRowSlots;
  const shutTier2 = tiers.tier2.slice(0, rem); rem = Math.max(0, rem - shutTier2.length);
  const shutTier3 = tiers.tier3.slice(0, rem); rem = Math.max(0, rem - shutTier3.length);
  const shutTier4 = tiers.tier4.slice(0, rem);

  const overflowWaiting = tiers.tier2.length - shutTier2.length;
  const overflowTier3 = tiers.tier3.length - shutTier3.length;
  const overflowTier4 = tiers.tier4.length - shutTier4.length;
  const overflowOtherOpen = overflowTier3 + overflowTier4;
  const overflowOpen = overflowWaiting + overflowOtherOpen;
  const overflowDone = hasDone ? tiers.tier5.length : 0;
  const hasFold = overflowOpen + overflowDone > 0;
  const foldKind: 'done' | 'more' = (overflowOpen === 0 && hasDone) ? 'done' : 'more';
  const moreCount = overflowOtherOpen;
  const doneCount = overflowDone;
  const foldDisplayCount = overflowOpen + overflowDone;

  const rowItems: { area: BoardArea; tier: 2 | 3 | 4 | 5 }[] = options.expanded
    ? [
        ...tiers.tier2.map((area) => ({ area, tier: 2 as const })),
        ...tiers.tier3.map((area) => ({ area, tier: 3 as const })),
        ...tiers.tier4.map((area) => ({ area, tier: 4 as const })),
        ...tiers.tier5.map((area) => ({ area, tier: 5 as const })),
      ]
    : [
        ...shutTier2.map((area) => ({ area, tier: 2 as const })),
        ...shutTier3.map((area) => ({ area, tier: 3 as const })),
        ...shutTier4.map((area) => ({ area, tier: 4 as const })),
      ];

  const nodes: OverviewNode[] = [currentHeroNode];
  rowItems.forEach(({ area, tier }, index) => {
    const c = index % actualCols;
    const r = Math.floor(index / actualCols);
    nodes.push({
      id: area.id,
      type: 'areaRow',
      position: { x: startX + c * (colWidth + AREA_ROW.gapX), y: startY + r * step },
      width: colWidth,
      height: AREA_ROW.height,
      measured: { width: colWidth, height: AREA_ROW.height },
      data: { ...area.data, tier },
      ...FIXED,
    });
  });

  if (hasFold) {
    const foldIndex = rowItems.length;
    const c = foldIndex % actualCols;
    const r = Math.floor(foldIndex / actualCols);
    nodes.push({
      id: OVERVIEW_FOLD,
      type: 'areaFold',
      position: { x: startX + c * (colWidth + AREA_ROW.gapX), y: startY + r * step },
      width: colWidth,
      height: AREA_ROW.height,
      measured: { width: colWidth, height: AREA_ROW.height },
      data: {
        count: foldDisplayCount,
        kind: foldKind,
        ...(overflowWaiting > 0
          ? {
              waitingCount: overflowWaiting,
              ...(moreCount > 0 ? { moreCount } : {}),
              ...(doneCount > 0 ? { doneCount } : {}),
            }
          : (moreCount > 0 && doneCount > 0 ? { moreCount, doneCount } : {})),
        expanded: options.expanded ?? false,
      },
      ...FIXED,
    });
  }

  return { form: 'rows', nodes, viewport: { x: 0, y: room.top, zoom: 1 } };
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
  const nodeTypeMap = new Map<string, string>();
  for (const n of nodes) {
    if (n.type === 'areaFold') continue;
    nodeTypeMap.set(n.id, n.type);
    rects.set(n.id, {
      x: n.position.x,
      y: n.position.y,
      width: n.width ?? (n.type === 'areaRow' ? AREA_ROW.minWidth : AREA_SIZE.width),
      height: n.height ?? (n.type === 'areaRow' ? AREA_ROW.height : AREA_SIZE.height),
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

    // Only draw lines to/from full cards: no lines between two small cards or two rows
    const sourceType = nodeTypeMap.get(sourceArea);
    const targetType = nodeTypeMap.get(targetArea);
    if (sourceType !== 'area' && targetType !== 'area') continue;

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
export type { AreaBoardLayoutOptions, AreaRow, AreaStage, LooseTab } from './boardRows.js';
