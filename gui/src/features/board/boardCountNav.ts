import type { LooseTab } from './boardRows.js';
import type { AreaData, BoardArea, BoardAreaRepo } from './boardAreas.js';
import { fileTypeOf, type BoardCard } from './boardLayout.js';
import { stepWorkspaceFileNodeId, type GroupedWorkspaceFile } from './workspaceFilesArea.js';
import { answerCountWords } from './questionsArea.js';

export type AreaCountKind = 'question' | 'notes' | 'pictures' | 'files' | 'documents' | 'pages' | 'commits' | 'updates' | 'parts' | 'code' | 'changed';

export interface AreaCountTarget {
  rowId: string | null;
  tab?: LooseTab;
  stepKey?: string;
  cardId?: string;
  page?: number;
}

export interface AreaCountItem {
  kind: AreaCountKind;
  count: number;
  label: string;
  actionLabel: string;
  /** Drawn in the warning colour: something wants a look (a copy that no longer matches). */
  warn?: boolean;
}

export type CountNavRepo = BoardAreaRepo | {
  laneId: string;
  commits?: unknown[];
  repo?: { repo?: string; commits?: unknown[]; more?: number; moreAtLeast?: boolean; problem?: string; count?: number };
};

export interface CountNavArea {
  cards?: BoardCard[];
  stepFiles?: Record<string, GroupedWorkspaceFile[]>;
  documents?: unknown[];
  repos?: CountNavRepo[];
  planItems?: { steps?: Array<{ key: string; done: boolean }>; decisions?: Array<{ key: string }> };
  steps?: Array<{ key: string; done: boolean }>;
  data?: Partial<AreaData>;
  answer?: BoardArea['answer'];
}

export type ResolvableArea = BoardArea | CountNavArea;

/**
 * Returns the count items for an Area card, with their kind, count, visual label, and action name.
 * e.g. "38 pictures" -> "Show the 38 pictures"
 */
export function areaCountItems(data: AreaData): AreaCountItem[] {
  const items: AreaCountItem[] = [];
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (data.kind === 'questions') {
    return answerCountWords(data.answerCounts ?? { parts: 0, code: 0, pictures: 0, changed: 0 }).map((word) => ({
      kind: word.kind, count: word.count, label: word.label, actionLabel: `Show the ${word.label}`, ...(word.kind === 'changed' ? { warn: true } : {}),
    }));
  }
  if (data.kind === 'files') {
    if (data.documentCount > 0) {
      const label = plural(data.documentCount, 'document', 'documents');
      items.push({ kind: 'documents', count: data.documentCount, label, actionLabel: `Show the ${label}` });
    }
    if ((data.pageCount ?? 0) > 0) {
      const label = plural(data.pageCount!, 'page', 'pages');
      items.push({ kind: 'pages', count: data.pageCount!, label, actionLabel: `Show the ${label}` });
    }
    if (data.pictureCount > 0) {
      const label = plural(data.pictureCount, 'picture', 'pictures');
      items.push({ kind: 'pictures', count: data.pictureCount, label, actionLabel: `Show the ${label}` });
    }
    return items;
  }
  if (data.noteCount > 0) {
    const label = plural(data.noteCount, 'note', 'notes');
    items.push({ kind: 'notes', count: data.noteCount, label, actionLabel: `Show the ${label}` });
  }
  if (data.pictureCount > 0) {
    const label = plural(data.pictureCount, 'picture', 'pictures');
    items.push({ kind: 'pictures', count: data.pictureCount, label, actionLabel: `Show the ${label}` });
  }
  if (data.fileCount > data.pictureCount) {
    const diff = data.fileCount - data.pictureCount;
    const label = plural(diff, 'file', 'files');
    items.push({ kind: 'files', count: diff, label, actionLabel: `Show the ${label}` });
  }
  if (data.documentCount > 0) {
    const label = plural(data.documentCount, 'document', 'documents');
    items.push({ kind: 'documents', count: data.documentCount, label, actionLabel: `Show the ${label}` });
  }
  if (data.commitCount > 0) {
    const label = plural(data.commitCount, 'commit', 'commits');
    items.push({ kind: 'commits', count: data.commitCount, label, actionLabel: `Show the ${label}` });
  }
  // The answers about this Area: before the updates, so that where the line is short the updates give way first
  if (data.questionItem) items.push(data.questionItem);
  if (data.updateCount && data.updateCount > 0) {
    const label = plural(data.updateCount, 'update', 'updates');
    items.push({ kind: 'updates', count: data.updateCount, label, actionLabel: `Show the ${label}` });
  }
  return items;
}

function newestCard(cards: BoardCard[] | undefined, predicate: (c: BoardCard) => boolean): BoardCard | undefined {
  if (!cards || cards.length === 0) return undefined;
  const matching = cards.filter(predicate);
  if (matching.length === 0) return undefined;
  return matching.slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
}

function newestStepFileTarget(
  area: ResolvableArea,
  predicate: (f: GroupedWorkspaceFile) => boolean,
): AreaCountTarget | undefined {
  const stepFiles = area.stepFiles;
  if (!stepFiles) return undefined;
  const candidates: Array<{ stepKey: string; file: GroupedWorkspaceFile }> = [];
  for (const [stepKey, items] of Object.entries(stepFiles)) {
    for (const file of items) {
      if (predicate(file)) candidates.push({ stepKey, file });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (Date.parse(b.file.modifiedAt) || 0) - (Date.parse(a.file.modifiedAt) || 0));
  const best = candidates[0]!;
  const steps = area.planItems?.steps ?? ('steps' in area ? area.steps : undefined) ?? [];
  const isDone = steps.find((s) => s.key === best.stepKey)?.done;
  return {
    rowId: isDone ? 'row:done' : `row:step:${best.stepKey}`,
    stepKey: best.stepKey,
    cardId: stepWorkspaceFileNodeId(best.stepKey, best.file.path),
  };
}

/**
 * Maps a count kind to the row, tab, and/or step to open when stepping into an Area.
 * - "pictures": steps into the Area with the row of loose cards open on its Media tab
 * - "notes": steps into the Area with the row of loose cards open on its Notes tab
 * - "files": steps into the Area on the documents row (or loose media if only loose files)
 * - "documents": steps into the Area on the documents row
 * - "commits": steps into the Area on the commits row
 * - "updates": steps into the Area on the step that changed
 */
export function resolveCountTarget(
  area: ResolvableArea,
  kind: AreaCountKind
): AreaCountTarget {
  if (area.data?.kind === 'questions' || ('kind' in area && area.kind === 'questions')) {
    // Each count opens the row of the first card it counts; the parts just step into the Area
    const parts = area.answer?.parts ?? [];
    const find = (match: (card: { data: { variant: string; check?: { status: string } } }) => boolean) => {
      for (const part of parts) for (const card of part.cards) if (match(card)) return { rowId: part.rowId, cardId: card.id };
      return null;
    };
    const hit = kind === 'pictures' ? find((c) => c.data.variant === 'picture')
      : kind === 'code' ? find((c) => c.data.variant === 'code')
        : kind === 'changed' ? find((c) => c.data.variant === 'code' && (c.data.check?.status === 'changed' || c.data.check?.status === 'gone'))
          : null;
    return hit ?? { rowId: null };
  }
  const isFilesArea = area.data?.kind === 'files' || ('kind' in area && area.kind === 'files');
  if (isFilesArea) {
    if (kind === 'documents') return { rowId: 'row:ws:documents' };
    if (kind === 'pages') return { rowId: 'row:ws:pages' };
    if (kind === 'pictures') return { rowId: 'row:ws:pictures' };
    return { rowId: null };
  }
  switch (kind) {
    case 'pictures': {
      const picCard = newestCard(area.cards, (c) => !c.archived && c.kind === 'file' && fileTypeOf(c.path) === 'image');
      if (picCard?.step) {
        return { rowId: `row:step:${picCard.step}`, stepKey: picCard.step, ...(picCard.id ? { cardId: picCard.id } : {}) };
      }
      if (!picCard) {
        const stepPic = newestStepFileTarget(area, (f) => f.group === 'pictures');
        if (stepPic) return stepPic;
      }
      return { rowId: 'lane:board', tab: 'media', ...(picCard?.id ? { cardId: picCard.id } : {}) };
    }
    case 'notes': {
      const noteCard = newestCard(area.cards, (c) => !c.archived && c.kind === 'note');
      if (noteCard?.step) {
        return { rowId: `row:step:${noteCard.step}`, stepKey: noteCard.step, ...(noteCard.id ? { cardId: noteCard.id } : {}) };
      }
      return { rowId: 'lane:board', tab: 'notes', ...(noteCard?.id ? { cardId: noteCard.id } : {}) };
    }
    case 'files': {
      const fileCard = newestCard(area.cards, (c) => !c.archived && c.kind === 'file' && fileTypeOf(c.path) !== 'image');
      if (fileCard?.step) {
        return { rowId: `row:step:${fileCard.step}`, stepKey: fileCard.step, ...(fileCard.id ? { cardId: fileCard.id } : {}) };
      }
      if (fileCard) {
        return { rowId: 'lane:board', tab: 'media', cardId: fileCard.id };
      }
      const stepFile = newestStepFileTarget(area, (f) => f.group !== 'pictures');
      if (stepFile) return stepFile;
      if (area.documents && area.documents.length > 0) {
        return { rowId: 'lane:documents' };
      }
      return { rowId: 'lane:board', tab: 'media' };
    }
    case 'documents':
      return { rowId: 'lane:documents' };
    case 'question':
    case 'pages':
    case 'parts':
    case 'code':
    case 'changed':
      return { rowId: null };
    case 'commits': {
      const repoWithCommits =
        area.repos?.find((r) => ((r.commits as unknown[])?.length ?? 0) > 0) ??
        area.repos?.find((r) => {
          const repoObj = r.repo;
          if (!repoObj) return false;
          if ('commits' in repoObj && Array.isArray(repoObj.commits) && repoObj.commits.length > 0) return true;
          if ('more' in repoObj && typeof repoObj.more === 'number' && repoObj.more > 0) return true;
          if ('count' in repoObj && typeof (repoObj as { count?: number }).count === 'number' && ((repoObj as { count?: number }).count ?? 0) > 0) return true;
          return false;
        }) ??
        area.repos?.[0];
      return { rowId: repoWithCommits?.laneId ?? 'lane:commits' };
    }
    case 'updates': {
      if (area.data?.freshDecisionKey) {
        return { rowId: 'row:waiting' };
      }
      if (area.data?.freshStepKey) {
        return { rowId: `row:step:${area.data.freshStepKey}`, stepKey: area.data.freshStepKey };
      }
      const allSteps: Array<{ key: string; done: boolean }> | undefined =
        area.planItems?.steps ?? ('steps' in area && Array.isArray(area.steps) ? area.steps : undefined);
      if (area.data?.freshCheckpointKey) {
        const targetStep = area.data?.focusStep ?? allSteps?.find((s) => !s.done)?.key ?? allSteps?.[0]?.key;
        if (targetStep) {
          return { rowId: `row:step:${targetStep}`, stepKey: targetStep };
        }
        return { rowId: 'row:waiting' };
      }
      const stepKey = area.data?.focusStep;
      if (stepKey) {
        return { rowId: `row:step:${stepKey}`, stepKey };
      }
      const firstOpen = allSteps?.find((s) => !s.done);
      const target = firstOpen ?? allSteps?.[0];
      if (target) {
        return {
          rowId: `row:step:${target.key}`,
          stepKey: target.key,
        };
      }
      if ((area.data?.waitingCount ?? 0) > 0 || (area.planItems?.decisions?.length ?? 0) > 0) {
        return { rowId: 'row:waiting' };
      }
      return { rowId: null };
    }
  }
}

/**
 * How a button for what is new may shrink on an Area's card. As before: every one shrinks with the line. Only where the card also has
 * "1 question" do the others keep their words, so that the updates give way first and the question is never cut.
 */
export function newsButtonFit(data: Pick<AreaData, 'questionItem'>, kind: AreaCountKind): string {
  return data.questionItem && kind !== 'updates' ? 'min-w-fit shrink-0' : 'min-w-0';
}

/**
 * The buttons for what is new that a card has room to show whole. A button that cannot show its whole words is not drawn, with its
 * separator: never a sliver, never a cut number. The updates give way first, then the others from the end; "1 question" stays, and a
 * card with no "1 question" is left exactly as it was (its buttons shrink with the line). `measure` is a label's width in px.
 */
export function fitNewsItems(items: readonly AreaCountItem[], room: number, measure: (label: string) => number): AreaCountItem[] {
  if (!items.some((item) => item.kind === 'question')) return [...items];
  const kept = [...items];
  const width = () => kept.reduce((sum, item, index) => sum + measure(item.label) + (index > 0 ? 8 : 0), 0);
  while (width() > room) {
    const at = kept.map((item) => item.kind).lastIndexOf('updates');
    const drop = at >= 0 ? at : kept.map((item) => item.kind !== 'question').lastIndexOf(true);
    if (drop < 0) break;
    kept.splice(drop, 1);
  }
  return kept;
}
