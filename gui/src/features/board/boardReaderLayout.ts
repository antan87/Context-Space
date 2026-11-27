/**
 * Where a document that was opened from the Board is shown: in a large window over the board, which is the default, or
 * docked beside the canvas ("side by side"). The choice is the viewer's, kept in this browser for every workspace. Pure,
 * apart from the storage.
 */

import { useCallback, useState } from 'react';
import { bylineText, type ReaderTarget } from './boardActions.js';
import type { BoardArea } from './boardAreas.js';
import type { BoardCard } from './boardData.js';
import { cardOrder, isFolderFallback, isPicturePath, pictureName, shortStepTitle, shownOrder, uniqueId } from './boardLayout.js';
import { stepWorkspaceFileNodeId, workspaceFileNodeId } from './workspaceFilesArea.js';

export type ReaderLayout = 'large' | 'side';

/** The large window takes about this share of the Board section's width and height, centred: the board stays in sight all round it. */
export const LARGE_WINDOW = { width: 0.92, height: 0.88 } as const;

export const LAYOUT_KEY = 'contextspace_board_reader_layout_v1';

/** The layout from what storage held: anything but the dock is the large window. */
export const cleanLayout = (raw: unknown): ReaderLayout => (raw === 'side' ? 'side' : 'large');

/** What this browser remembers. Storage can be unavailable or hold anything: then the large window shows. */
export function readLayout(): ReaderLayout {
  try {
    return cleanLayout(window.localStorage.getItem(LAYOUT_KEY));
  } catch {
    return 'large';
  }
}

export function writeLayout(layout: ReaderLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout);
  } catch { /* The choice holds for this visit only. */ }
}

/** The layout of the reader, and the way to change it. A change is kept in storage at once. */
export function useReaderLayout(): [ReaderLayout, (layout: ReaderLayout) => void] {
  const [layout, setLayout] = useState(readLayout);
  const choose = useCallback((next: ReaderLayout) => {
    setLayout(next);
    writeLayout(next);
  }, []);
  return [layout, choose];
}

/** Checks whether two ReaderTarget references describe the exact same item. */
export function isSameReaderTarget(a: ReaderTarget, b: ReaderTarget): boolean {
  if (a.commit && b.commit) {
    return a.commit.repo === b.commit.repo && a.commit.sha === b.commit.sha;
  }
  if (a.commit || b.commit) {
    return false;
  }
  if (a.repo?.name !== b.repo?.name) return false;
  if (Boolean(a.source) !== Boolean(b.source)) {
    return false;
  }
  if (a.source && b.source) {
    return a.source === b.source;
  }
  if (Boolean(a.card) !== Boolean(b.card)) {
    return false;
  }
  if (a.card && b.card) {
    return a.card === b.card;
  }
  if (Boolean(a.path) !== Boolean(b.path)) {
    return false;
  }
  if (a.path && b.path) {
    return a.path === b.path;
  }
  return false;
}

/**
 * Collects all readable targets (documents, pictures, html pages and files) from an Area. Commits are not among them: they open in the Code window in stable reading order.
 */
export function collectAreaReaderTargets(area: BoardArea, stepKey?: string): ReaderTarget[] {
  const targets: ReaderTarget[] = [];
  const seen = new Set<string>();

  const add = (target: ReaderTarget) => {
    const key = target.commit
      ? `commit:${target.commit.repo}:${target.commit.sha}`
      : target.source
        ? `source:${target.source}`
        : target.card
          ? `card:${target.card}`
          : `path:${target.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  };

  const steps = area.kind === 'work' ? [] : (area.planItems?.steps ?? []);
  const stepTitleByKey = new Map(steps.map((s) => [s.key, shortStepTitle(s.text)]));

  const addFileCard = (card: Extract<BoardCard, { kind: 'file' }>) => {
    const isPic = isPicturePath(card.path);
    const validStepKey = card.step && stepTitleByKey.has(card.step) ? card.step : undefined;
    const stepTitle = validStepKey ? stepTitleByKey.get(validStepKey) : undefined;
    const trimmedDesc = card.description?.trim() ?? '';
    const usableDesc = trimmedDesc && !(isPic && isFolderFallback(trimmedDesc, card.path)) ? trimmedDesc : '';
    const rawFileName = card.path.split(/[\\/]/).pop() ?? '';
    const title = isPic && rawFileName && card.title.trim().toLowerCase() === rawFileName.toLowerCase()
      ? pictureName(card.path)
      : card.title;
    const text = usableDesc || (stepTitle ? `In step: ${stepTitle}` : isPic ? area.data.title : undefined);
    add({
      path: card.path,
      title,
      card: card.id,
      ...(validStepKey ? { stepKey: validStepKey } : {}),
      ...(text ? { text } : {}),
      byline: bylineText(card),
    });
  };

  const addStepFiles = (targetStepKey: string, picturesOnly = false) => {
    const stepTitle = stepTitleByKey.get(targetStepKey);
    for (const file of area.stepFiles?.[targetStepKey] ?? []) {
      if (picturesOnly && !isPicturePath(file.path)) continue;
      const isPicture = file.group === 'pictures';
      const text = isPicture ? (stepTitle ? `In step: ${stepTitle}` : area.data.title) : (file.folder || undefined);
      add({
        path: file.path,
        title: isPicture ? pictureName(file.path) : file.name,
        card: stepWorkspaceFileNodeId(targetStepKey, file.path),
        stepKey: targetStepKey,
        ...(text ? { text } : {}),
      });
    }
  };

  if (stepKey !== undefined) {
    if (stepTitleByKey.has(stepKey)) {
      for (const card of shownOrder(area.cards)) {
        if (card.kind === 'file' && card.step === stepKey && isPicturePath(card.path)) {
          addFileCard(card);
        }
      }
    }
    addStepFiles(stepKey, true);
    return targets;
  }

  // 1. Source documents
  const docTaken = new Set<string>();
  for (const doc of area.documents) {
    const docNodeId = uniqueId(`document:${doc.id}`, docTaken);
    if (doc.filename) {
      add({
        path: doc.filename,
        title: doc.title,
        card: docNodeId,
        source: doc.id,
      });
    }
  }

  // 2. Board Cards (files, pictures, HTML)
  for (const card of cardOrder(area.cards)) {
    if (card.kind === 'file') addFileCard(card);
  }

  // 2a. Step-named workspace files inside plan Areas
  if (area.stepFiles) {
    const visitedSteps = new Set<string>();
    for (const step of steps) {
      visitedSteps.add(step.key);
      addStepFiles(step.key);
    }
    for (const orphanStepKey of Object.keys(area.stepFiles)) {
      if (!visitedSteps.has(orphanStepKey)) addStepFiles(orphanStepKey);
    }
  }

  // 2b. Read-only workspace files inside the Workspace files Area
  if (area.workspaceFiles) {
    for (const file of [
      ...area.workspaceFiles.documents,
      ...area.workspaceFiles.pages,
      ...area.workspaceFiles.pictures,
    ]) {
      const isPicture = file.group === 'pictures';
      const text = isPicture
        ? (file.folder ? `In folder: ${file.folder}` : 'Workspace root')
        : (file.folder || undefined);
      add({
        path: file.path,
        title: isPicture ? pictureName(file.path) : file.name,
        card: workspaceFileNodeId(file.path),
        ...(text ? { text } : {}),
      });
    }
  }

  // 2c. The text, picture and diagram cards of an answer open its file (a picture opens itself), at the part's heading
  for (const part of area.answer?.parts ?? []) {
    for (const card of part.cards) {
      const data = card.data;
      if (data.variant === 'picture') {
        if (data.src) add({ path: data.src, title: data.title, card: card.id });
      } else if (data.variant === 'text' || data.variant === 'diagram') {
        add({ path: data.path, title: data.question, card: card.id, ...(data.heading ? { heading: data.heading } : {}) });
      }
    }
  }

  return targets;
}

/**
 * Finds index of current ReaderTarget in the list of targets, matching exact commit, source, card, or path.
 */
export function findReaderTargetIndex(targets: ReaderTarget[], current: ReaderTarget): number {
  return targets.findIndex((t) => isSameReaderTarget(t, current));
}

export function pictureFallback(path: string, repo?: { name: string }): { title: string; text: string } {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  const folder = slash > 0 ? normalized.slice(0, slash) : '';
  return {
    title: pictureName(normalized),
    text: repo ? (folder ? `In folder: ${folder}` : repo.name) : (folder ? `In folder: ${folder}` : 'Workspace root'),
  };
}
