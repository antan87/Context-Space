/**
 * Where a document that was opened from the Board is shown: in a large window over the board, which is the default, or
 * docked beside the canvas ("side by side"). The choice is the viewer's, kept in this browser for every workspace. Pure,
 * apart from the storage.
 */

import { useCallback, useState } from 'react';
import { bylineText, parseCommitNodeId, type ReaderTarget } from './boardActions.js';
import type { BoardArea } from './boardAreas.js';
import { cardOrder, uniqueId } from './boardLayout.js';

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
  if (a.source && b.source) {
    return a.source === b.source;
  }
  if (a.card && b.card) {
    return a.card === b.card;
  }
  return a.path === b.path;
}

/**
 * Collects all readable targets (documents, pictures, html pages, files, and commits) from an Area in stable reading order.
 */
export function collectAreaReaderTargets(area: BoardArea): ReaderTarget[] {
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
    if (card.kind === 'file') {
      add({
        path: card.path,
        title: card.title,
        card: card.id,
        ...(card.description ? { text: card.description } : {}),
        byline: bylineText(card),
      });
    }
  }

  // 3. Commits
  for (const repoEntry of area.repos) {
    repoEntry.commits.forEach((commit, index) => {
      const commitNodeId = repoEntry.cards[index]?.id ?? `commit:${repoEntry.repo.repo}:${commit.sha}`;
      const parsedCommit = parseCommitNodeId(commitNodeId);
      if (parsedCommit) {
        add({
          path: `${parsedCommit.repo} · ${parsedCommit.sha.slice(0, 7)}`,
          title: commit.subject,
          card: commitNodeId,
          commit: parsedCommit,
        });
      }
    });
  }

  return targets;
}

/**
 * Finds index of current ReaderTarget in the list of targets, matching exact commit, source, card, or path.
 */
export function findReaderTargetIndex(targets: ReaderTarget[], current: ReaderTarget): number {
  return targets.findIndex((t) => isSameReaderTarget(t, current));
}
