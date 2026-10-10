import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireLock, createMutationQueue } from './locks.js';
import { readWorkspaceFile, writeWorkspaceFile } from './storage.js';
import { loadFeatureConfig } from './workspace.js';
import { assertNoLinkedPathComponents } from '../resources/fs-safety.js';

/**
 * The old hand-written planning notes. Retired: refresh and `ctxspace plan` move them into the plan
 * (core/plan-import) and archive the file. The deprecated MCP tools still read and write it for one
 * release; whatever they write is moved into the plan the same way.
 */
export const PLANNING_NOTES_FILE = 'contextspace-milestones.md';
export const PLANNING_NOTES_TEMPLATE = `# Delivery plan and open questions

This is an authored planning document. Refresh preserves it. Use the lifecycle
editor for executable milestone gates; record the rationale and release sequence here.

## Outcomes and release order

| Milestone ID | Outcome / acceptance criteria | Repo / work item / PR | Depends on | Release / publish / consumer bump order |
| --- | --- | --- | --- | --- |

## Open questions

| ID | Question | Owner | Status (open / resolved) | Blocks | Resolution / evidence |
| --- | --- | --- | --- | --- | --- |

## Existing work — verify before replanning

| Outcome | Repo / branch / PR / commit | Status (merged / on branch / no change needed) | Evidence checked | Remaining work |
| --- | --- | --- | --- | --- |

## Flagged defects and deferred decisions

| Item | Decision (flag only / defer / implement) | Reason | Owner | Follow-up |
| --- | --- | --- | --- | --- |

## Draft work items

Use applicable enabled skill templates for the requested planning output. Store
each resulting PBI/spec as a draft source document and link it to its milestone.
Enabling a skill makes instructions available; it does not execute generation automatically.
`;
const revision = (content: string) => createHash('sha256').update(content).digest('hex');
const queue = createMutationQueue();

export async function readPlanningNotes(root: string) {
  const feature = await loadFeatureConfig(root);
  if (!feature) throw new Error('Workspace not found.');
  await assertNoLinkedPathComponents(root, path.join(root, PLANNING_NOTES_FILE));
  let content: string;
  try { content = await readWorkspaceFile(root, feature.id, PLANNING_NOTES_FILE); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; content = PLANNING_NOTES_TEMPLATE; }
  return { content, revision: revision(content) };
}

/** Runs an operation while nobody else writes the notes file. */
export async function withPlanningNotesLock<T>(root: string, operation: () => Promise<T>) {
  return mutate(root, operation);
}

async function mutate<T>(root: string, operation: () => Promise<T>) {
  return queue(async () => {
    root = await fs.realpath(root);
    await assertNoLinkedPathComponents(root, path.join(root, PLANNING_NOTES_FILE));
    const release = await acquireLock(path.join(root, '.contextspace-planning.lock'), { staleMs: 60_000, timeoutMs: 10_000, timeoutMessage: 'Planning notes are busy. Retry.' });
    try { return await operation(); } finally { await release(); }
  });
}

export async function savePlanningNotes(root: string, expectedRevision: string, content: string) {
  return mutate(root, async () => {
    const current = await readPlanningNotes(root);
    if (current.revision !== expectedRevision) throw new Error('Planning notes changed in another session. Reload before saving.');
    const feature = await loadFeatureConfig(root);
    if (!feature) throw new Error('Workspace not found.');
    await writeWorkspaceFile(root, feature.id, PLANNING_NOTES_FILE, content);
    return { content, revision: revision(content) };
  });
}

/**
 * Whether planning notes hold anything beyond the empty template tables: at least one table row
 * that is neither a header (the row above a `| --- |` separator) nor a separator. Prose alone
 * does not count, since the template carries its own.
 */
export function hasAuthoredPlanningRows(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const isRow = (line: string) => line.trimStart().startsWith('|');
  const isSeparator = (line: string) => isRow(line) && /^[\s|:-]+$/.test(line);
  return lines.some((line, index) => isRow(line) && !isSeparator(line) && !isSeparator(lines[index + 1] ?? ''));
}

/** Whether this workspace's planning notes have been written beyond the template. Never throws. */
export async function planningNotesAreAuthored(root: string): Promise<boolean> {
  try {
    return hasAuthoredPlanningRows((await readPlanningNotes(root)).content);
  } catch {
    return false;
  }
}
