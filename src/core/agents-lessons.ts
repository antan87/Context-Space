/**
 * @module core/agents-lessons
 * Keeps the lessons listed in AGENTS.md current when workspace knowledge changes, without a full refresh. A refresh
 * analyses every repo; a new knowledge entry changes one section of the text, so only that section is swapped, in
 * AGENTS.md and in the views copied from it, and their hashes in the generation lock are moved with it. Nothing else
 * in them changes, and the snapshot the lock was made from is kept, so a stale banner is not made fresh by this.
 */

import * as path from 'node:path';

import { acquireLock } from './locks.js';
import { readGenerationLock, updateGeneratedViews } from './generation-lock.js';
import { BRAND_NAME, resolveWorkspaceConfigDir } from './constants.js';
import type { KnowledgeLesson } from './knowledge.js';
import { withLessonsSection } from '../generators/lessons.js';

/** The canonical context file, and the source the views copied from it name in the generation lock. */
const AGENTS_FILE = 'AGENTS.md';
/** How long to wait for a refresh in progress; it writes the lessons itself when it ends, so waiting is for the lock's sake. */
const WAIT_FOR_REFRESH_MS = 15_000;

/**
 * Puts the lessons into AGENTS.md and the views copied from it. It waits for a refresh in progress, because that holds
 * the files this changes, and does nothing for a workspace whose files were never generated. The lessons are read once
 * the files are held, so two entries added close together cannot leave the older list in place.
 *
 * @returns The views it changed.
 * @throws When a refresh holds the files longer than it waits.
 */
export async function refreshAgentsLessons(
  workspacePath: string,
  readLessons: () => Promise<readonly KnowledgeLesson[]>,
): Promise<string[]> {
  // Nothing was generated here, so there is nothing to keep true, and no reason to make a lock file.
  if (!(await readGenerationLock(workspacePath))) return [];
  // The same lock a refresh holds (core/refresh.ts), so the two never rewrite AGENTS.md at once.
  const release = await acquireLock(path.join(resolveWorkspaceConfigDir(workspacePath).path, 'generation.lock'), {
    staleMs: 5 * 60_000,
    timeoutMs: WAIT_FOR_REFRESH_MS,
    timeoutMessage: `Another ${BRAND_NAME} generation or refresh is still updating this workspace.`,
  });
  try {
    const lessons = await readLessons();
    return await updateGeneratedViews(workspacePath, AGENTS_FILE, (content) => withLessonsSection(content, lessons));
  } finally {
    await release();
  }
}
