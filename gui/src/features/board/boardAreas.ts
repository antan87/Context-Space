/**
 * Areas: the logical grouping of the board at Level 0 ("Board") and Level 1 (inside an Area).
 *
 * Level 0 presents work grouped into Areas — one area per checkpoint, `plan:own` for loose steps
 * and waiting decisions outside checkpoints, or a fallback `area:work` ('Current work') when there
 * is workspace content but no plan checkpoints.
 *
 * Each area partitions its related steps, waiting decisions, source documents, commits, and cards.
 * Level 0 and Level 1 are both proportioned and fitted to the screen without scrolling or panning.
 */

import type { Edge, Node } from '@xyflow/react';
import type { WorkDocument } from '../../types.js';
import { stepsDone, type PlanFileDecision, type PlanFileStep, type PlanFileView } from '../plan/planFile.js';
import type { NewsCommit, WhatsNewView } from '../plan/whatsNew.js';
import type { BoardCard, BoardLink, BoardPoint, BoardView } from './boardData.js';
import {
  BOARD_LIMITS,
  BOARD_SIZE,
  cardOrder,
  cardPlan,
  clearOfGroups,
  commitsSince,
  documentsSummary,
  fileTypeOf,
  frame,
  freeCard,
  imageAlt,
  isFresh,
  lane,
  newestFirst,
  nodeResolver,
  sidesBetween,
  uniqueId,
  type BoardNode,
  type LaneCard,
  type Rect,
} from './boardLayout.js';

export const AREA_SIZE = { width: 320, height: 224, gapX: 32, gapY: 28 } as const;

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

  type AreaDraft = {
    id: string;
    kind: 'checkpoint' | 'plan' | 'work';
    title: string;
    done: boolean;
    checkpointKey?: string;
    planItems?: { steps: PlanFileStep[]; decisions: PlanFileDecision[]; waitingKeys?: string[] };
  };

  const drafts: AreaDraft[] = [];

  if (plan && (plan.steps.length > 0 || plan.decisions.some((decision) => waitingKeys.has(decision.key)))) {
    const areaWaitingKeys = plan.decisions.filter((d) => waitingKeys.has(d.key)).map((d) => d.key);
    drafts.push({
      id: uniqueId('plan:own', taken),
      kind: 'plan',
      title: 'Plan',
      done: false,
      planItems: { steps: plan.steps, decisions: plan.decisions, waitingKeys: areaWaitingKeys },
    });
  }

  for (const cp of plan?.checkpoints ?? []) {
    const areaWaitingKeys = cp.decisions.filter((d) => waitingKeys.has(d.key)).map((d) => d.key);
    drafts.push({
      id: uniqueId(`checkpoint:${cp.key}`, taken),
      kind: 'checkpoint',
      title: cp.title,
      done: cp.done,
      checkpointKey: cp.key,
      planItems: { steps: cp.steps, decisions: cp.decisions, waitingKeys: areaWaitingKeys },
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
      const cards: LaneCard[] = r.commits.map((commit, index) => ({
        id: r.commitNodeIds[index] ?? uniqueId(`commit:${repoName}:${commit.sha}`, commitTaken),
        type: 'commit',
        height: BOARD_SIZE.commit,
        data: { sha: commit.sha.slice(0, 7), subject: commit.subject, author: commit.author, at: commit.at },
      }));
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

/**
 * Calculates optimal grid columns for Level 0 overview matching available container aspect ratio.
 */
export function chooseGridColumns(count: number, size: Size): number {
  if (count <= 1) return 1;
  if (size.width <= 0 || size.height <= 0) return Math.min(count, 3);

  const availW = Math.max(1, size.width * 0.88);
  const availH = Math.max(1, size.height * 0.84);
  const targetRatio = availW / availH;

  let bestCols = 1;
  let bestZoom = -1;
  let bestDiff = Infinity;

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const w = cols * AREA_SIZE.width + (cols - 1) * AREA_SIZE.gapX;
    const h = rows * AREA_SIZE.height + (rows - 1) * AREA_SIZE.gapY;
    const fit = Math.min(availW / w, availH / h);
    const zoom = Math.min(1, fit);
    const ratio = w / h;
    const diff = Math.abs(ratio - targetRatio);

    if (count <= 3 && cols === count && availW >= w && zoom >= 0.999) {
      bestCols = cols;
      break;
    }

    if (zoom > bestZoom + 1e-5) {
      bestZoom = zoom;
      bestCols = cols;
      bestDiff = diff;
    } else if (Math.abs(zoom - bestZoom) <= 1e-5) {
      if (diff < bestDiff) {
        bestDiff = diff;
        bestCols = cols;
      }
    }
  }

  return bestCols;
}

/**
 * Lays out Level 0 Area nodes in a 2D screen-proportioned grid.
 */
export function overviewLayout(areas: BoardArea[], size: Size): AreaNode[] {
  if (areas.length === 0) return [];
  const cols = chooseGridColumns(areas.length, size);
  return areas.map((area, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * (AREA_SIZE.width + AREA_SIZE.gapX);
    const y = row * (AREA_SIZE.height + AREA_SIZE.gapY);
    return {
      id: area.id,
      type: 'area',
      position: { x, y },
      width: AREA_SIZE.width,
      height: AREA_SIZE.height,
      measured: { width: AREA_SIZE.width, height: AREA_SIZE.height },
      data: area.data,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
    };
  });
}

/**
 * Connects cross-area links at Level 0, deduplicating multiple lines between the same areas.
 */
export function overviewEdges(areas: BoardArea[], nodes: AreaNode[], links: BoardLink[]): Edge[] {
  if (!links.length || !areas.length || !nodes.length) return [];
  const ownerMap = new Map<string, string>();
  const titleMap = new Map<string, string>();
  for (const area of areas) {
    titleMap.set(area.id, area.data.title);
    for (const id of area.allMemberNodeIds) {
      ownerMap.set(id, area.id);
    }
  }

  const rects = new Map<string, Rect>();
  for (const n of nodes) {
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

export interface AreaBoardLayoutOptions {
  news?: WhatsNewView;
  positions?: Record<string, BoardPoint>;
  now?: number;
}

/**
 * Pure 2D layout for Level 1 (inside an Area). Coordinates are deterministic from the area and options alone.
 */
export function areaBoardLayout(
  area: BoardArea,
  options: AreaBoardLayoutOptions = {},
): BoardNode[] {
  const nodes: BoardNode[] = [];
  const taken = new Set<string>();
  const MAX_COLS = 3;

  type StructuredGroup = {
    colSpan: number;
    height: number;
    render: (x: number, y: number) => BoardNode[];
  };

  const topGroups: StructuredGroup[] = [];

  // Checkpoint or plan frame
  if (area.kind === 'checkpoint' || area.kind === 'plan') {
    const planItems = area.planItems ?? { steps: [], decisions: [] };
    const frameWaitingKeys = new Set(planItems.waitingKeys ?? []);
    const frameNode = frame(
      area.kind,
      area.id,
      0,
      area.data.title,
      area.data.done,
      planItems,
      frameWaitingKeys,
      false, // collapsible: false
    );
    topGroups.push({
      colSpan: 1,
      height: frameNode.height ?? BOARD_SIZE.folded,
      render: (x, y) => [{ ...frameNode, position: { x, y } }],
    });
  }

  // Documents lane
  if (area.documents.length > 0) {
    const docCols = area.documents.length >= 4 ? 2 : 1;
    const docCards: LaneCard[] = area.documents.map((doc) => ({
      id: uniqueId(`document:${doc.id}`, taken),
      type: 'document' as const,
      height: BOARD_SIZE.document,
      data: {
        title: doc.title,
        role: doc.role,
        status: doc.status,
        summary: doc.summary,
        dimmed: doc.status === 'superseded',
        sourceId: doc.id,
        ...(doc.filename ? { filename: doc.filename } : {}),
        ...(doc.url ? { url: doc.url } : {}),
      },
    }));
    const docsId = 'lane:documents';
    const sample = lane(
      docsId,
      0,
      { title: 'Documents', caption: 'Source documents', more: 0 },
      docCards,
      {
        columns: docCols,
        group: { open: true, collapsible: false, summary: documentsSummary(area.documents) },
      },
    );
    const height = sample[0]?.height ?? BOARD_SIZE.folded;
    topGroups.push({
      colSpan: docCols,
      height,
      render: (x, y) =>
        lane(
          docsId,
          x,
          { title: 'Documents', caption: 'Source documents', more: 0 },
          docCards,
          {
            y,
            columns: docCols,
            group: { open: true, collapsible: false, summary: documentsSummary(area.documents) },
          },
        ),
    });
  }

  // Commits lanes
  const news = options.news;
  const since = news ? commitsSince(news) : { caption: 'New since you last looked', none: () => 'No new commits.', count: (n: number) => `${n} commits` };

  if (area.repos.length > 0) {
    for (const r of area.repos) {
      const repoCols = r.cards.length >= 5 ? 2 : 1;
      const more = r.repo.more;
      const moreAtLeast = r.repo.moreAtLeast;
      const totalAreaCommits = r.commits.length + more;
      const newest = r.commits[0];
      const summary = newest
        ? {
            headline: since.count(totalAreaCommits, moreAtLeast),
            detail: newest.subject,
            byline: newest.author,
            ...(r.repo.problem ? { warning: 'Could not read everything' } : {}),
          }
        : {
            headline: totalAreaCommits > 0 ? since.count(totalAreaCommits, moreAtLeast) : '0 commits',
            ...(r.repo.problem ? { warning: 'Could not read everything' } : {}),
          };

      const sample = lane(
        r.laneId,
        0,
        {
          title: r.repo.repo,
          caption: since.caption,
          more,
          ...(moreAtLeast ? { moreAtLeast: true } : {}),
          ...(r.repo.problem ? { note: `Could not be read: ${r.repo.problem}` } : {}),
        },
        r.cards,
        {
          columns: repoCols,
          group: { open: true, collapsible: false, summary },
        },
      );
      const height = sample[0]?.height ?? BOARD_SIZE.folded;

      topGroups.push({
        colSpan: repoCols,
        height,
        render: (x, y) =>
          lane(
            r.laneId,
            x,
            {
              title: r.repo.repo,
              caption: since.caption,
              more,
              ...(moreAtLeast ? { moreAtLeast: true } : {}),
              ...(r.repo.problem ? { note: `Could not be read: ${r.repo.problem}` } : {}),
            },
            r.cards,
            {
              y,
              columns: repoCols,
              group: { open: true, collapsible: false, summary },
            },
          ),
      });
    }
  }

  // Commit placeholder rule (only on current area when news is present, no commits across news, other content exists, and not all unreadable)
  if (news && area.data.current) {
    const problems = news.commits.filter((repo) => !repo.commits.length && repo.problem);
    const unreadable = problems.length > 0 && problems.length === news.commits.length;
    if (!news.commits.some((repo) => repo.commits.length) && (topGroups.length > 0 || problems.length > 0) && !unreadable) {
      const placeholderLaneId = uniqueId('lane:commits', taken);
      const placeholderCardId = uniqueId('placeholder:commits', taken);
      const sample = lane(
        placeholderLaneId,
        0,
        { title: 'Commits', caption: since.caption, more: 0 },
        [{ id: placeholderCardId, type: 'placeholder', height: BOARD_SIZE.placeholder, data: { text: since.none(problems.length > 0) } }],
      );
      const height = sample[0]?.height ?? BOARD_SIZE.folded;
      topGroups.push({
        colSpan: 1,
        height,
        render: (x, y) =>
          lane(
            placeholderLaneId,
            x,
            { title: 'Commits', caption: since.caption, more: 0 },
            [{ id: placeholderCardId, type: 'placeholder', height: BOARD_SIZE.placeholder, data: { text: since.none(problems.length > 0) } }],
            { y },
          ),
      });
    }
  }

  // Layout structured top groups in wrapped rows
  let rowCols = 0;
  let rowY = 0;
  let maxRowHeight = 0;
  let maxTopHeight = 0;
  let totalTopColumns = 0;

  for (const group of topGroups) {
    if (rowCols + group.colSpan > MAX_COLS && rowCols > 0) {
      rowY += maxRowHeight + BOARD_SIZE.columnGap;
      rowCols = 0;
      maxRowHeight = 0;
    }
    const x = rowCols * (BOARD_SIZE.column + BOARD_SIZE.columnGap);
    nodes.push(...group.render(x, rowY));
    rowCols += group.colSpan;
    maxRowHeight = Math.max(maxRowHeight, group.height);
    maxTopHeight = Math.max(maxTopHeight, rowY + group.height);
    totalTopColumns = Math.max(totalTopColumns, rowCols);
  }

  // Cards layout
  const positions = new Map(Object.entries(options.positions ?? {}));
  const unplaced: LaneCard[] = [];
  const free: BoardNode[] = [];
  const now = options.now ?? Date.now();

  for (const card of cardOrder(area.cards)) {
    const entry = cardPlan(card, now);
    const at = positions.get(card.id);
    if (at) {
      free.push(freeCard(entry, at, entry.z));
    } else {
      unplaced.push(entry);
    }
  }

  nodes.push(...free);

  if (unplaced.length > 0) {
    const bandCols = Math.max(2, Math.min(4, totalTopColumns || Math.ceil(Math.sqrt(unplaced.length))));
    const bandY = maxTopHeight > 0 ? maxTopHeight + BOARD_SIZE.columnGap : 0;
    const bandNodes = lane(
      'lane:board',
      0,
      { title: 'From the board', caption: 'Notes and files from you and the AI', more: 0 },
      unplaced,
      { columns: bandCols, y: bandY },
    );
    nodes.push(...bandNodes);
  }

  return clearOfGroups(nodes);
}

/**
 * Computes a viewport such that all bounded nodes fit whole inside the container screen with no scrolling.
 */
export function fitBoundsView(
  nodes: Array<{ id: string; parentId?: string; position: { x: number; y: number }; width?: number; height?: number }>,
  size: Size,
  options?: { topInset?: number; bottomInset?: number; margin?: number; minAutoZoom?: number },
): Viewport | null {
  if (nodes.length === 0 || size.width <= 0 || size.height <= 0) return null;

  const topNodes = nodes.filter((n) => !n.parentId);
  if (topNodes.length === 0) return null;

  const calcBounds = (list: typeof topNodes) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of list) {
      const w = node.width ?? BOARD_SIZE.card;
      const h = node.height ?? 0;
      if (node.position.x < minX) minX = node.position.x;
      if (node.position.y < minY) minY = node.position.y;
      if (node.position.x + w > maxX) maxX = node.position.x + w;
      if (node.position.y + h > maxY) maxY = node.position.y + h;
    }
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  };

  const padX = Math.max(24, size.width * (options?.margin ?? 0.05));
  const padTop = options?.topInset ?? 44;
  const padBottom = options?.bottomInset ?? 48;
  const availW = Math.max(40, size.width - 2 * padX);
  const availH = Math.max(40, size.height - padTop - padBottom);

  let bounds = calcBounds(topNodes);
  let zoom = Math.min(1, availW / bounds.width, availH / bounds.height);

  if (options?.minAutoZoom !== undefined && zoom < options.minAutoZoom) {
    const structured = topNodes.filter((n) => n.id.startsWith('lane:') || n.id.startsWith('checkpoint:') || n.id.startsWith('plan:'));
    if (structured.length > 0) {
      const sBounds = calcBounds(structured);
      const sZoom = Math.min(1, availW / sBounds.width, availH / sBounds.height);
      if (sZoom >= options.minAutoZoom) {
        bounds = sBounds;
        zoom = sZoom;
      }
    }
  }

  const x = size.width / 2 - (bounds.x + bounds.width / 2) * zoom;
  const y = padTop + availH / 2 - (bounds.y + bounds.height / 2) * zoom;

  return { x, y, zoom };
}
