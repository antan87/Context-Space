import type { LooseTab } from './boardRows.js';
import type { AreaData, BoardArea, BoardAreaRepo } from './boardAreas.js';
import { fileTypeOf, type BoardCard } from './boardLayout.js';

export type AreaCountKind = 'notes' | 'pictures' | 'files' | 'documents' | 'commits' | 'updates';

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
}

export type CountNavRepo = BoardAreaRepo | {
  laneId: string;
  commits?: unknown[];
  repo?: { repo?: string; commits?: unknown[]; more?: number; moreAtLeast?: boolean; problem?: string; count?: number };
};

export interface CountNavArea {
  cards?: BoardCard[];
  documents?: unknown[];
  repos?: CountNavRepo[];
  planItems?: { steps?: Array<{ key: string; done: boolean }>; decisions?: Array<{ key: string }> };
  steps?: Array<{ key: string; done: boolean }>;
  data?: Partial<AreaData>;
}

export type ResolvableArea = BoardArea | CountNavArea;

/**
 * Returns the count items for an Area card, with their kind, count, visual label, and action name.
 * e.g. "38 pictures" -> "Show the 38 pictures"
 */
export function areaCountItems(data: AreaData): AreaCountItem[] {
  const items: AreaCountItem[] = [];
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
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
  switch (kind) {
    case 'pictures': {
      const picCard = newestCard(area.cards, (c) => !c.archived && c.kind === 'file' && fileTypeOf(c.path) === 'image');
      if (picCard?.step) {
        return { rowId: `row:step:${picCard.step}`, stepKey: picCard.step, ...(picCard.id ? { cardId: picCard.id } : {}) };
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
      if (area.documents && area.documents.length > 0) {
        return { rowId: 'lane:documents' };
      }
      return { rowId: 'lane:board', tab: 'media' };
    }
    case 'documents':
      return { rowId: 'lane:documents' };
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
