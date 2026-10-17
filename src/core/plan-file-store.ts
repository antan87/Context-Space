/**
 * @module core/plan-file-store
 * PLAN.md on disk. Every screen, the command line and the AI instructions read the plan here, and ContextSpace's
 * own changes (the user ticking a step or answering a decision in the app, a check passing) go through
 * `changePlanFile`, which re-reads the file under a lock and changes only the lines it means.
 *
 * AIs edit the file themselves, so nothing else needs to go through here. What changed is found by comparing the
 * file with the last version ContextSpace saw, whoever changed it, and kept in a short log for "What changed" and
 * "Finished lately".
 *
 * A workspace that still has the older store (`contextspace-plan.json`) reads as the PLAN.md it will become; the
 * first change, or the backend's pass at startup, moves it over and keeps the old file in the archive.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { acquireLock } from './locks.js';
import { PLAN_FILE, parsePlanFile, planItems, type PlanCheckpoint, type PlanDecision, type PlanFile, type PlanStep } from './plan-file.js';
import { planFileFromStore } from './plan-file-convert.js';
import { deleteWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from './storage.js';
import { loadFeatureConfig } from './workspace.js';
import { loadWorkspaceState, mutateWorkspaceState } from './workspace-state.js';
import type { PlanEvidence } from '../types.js';

/** Where the older store is kept once the plan moved to PLAN.md, and the files ContextSpace keeps beside it. */
const ARCHIVE_DIR = '.contextspace/archive';
const OLD_STORE = 'contextspace-plan.json';
const OLD_SUMMARY = 'contextspace-plan.md';
const CHANGES_FILE = '.contextspace/plan-changes.jsonl';
const SEEN_FILE = '.contextspace/plan-seen.json';
/** How many changes the log keeps. */
export const CHANGES_KEPT = 300;

export type PlanItemKind = 'checkpoint' | 'step' | 'decision';

/** One thing that changed in the plan, as the log keeps it. */
export interface PlanFileChange {
  at: string;
  /** `user`, an AI tool's name, `contextspace`, or `file` when someone edited PLAN.md itself. */
  by: string;
  action: 'added' | 'removed' | 'ticked' | 'unticked' | 'answered';
  kind: PlanItemKind;
  key: string;
  text: string;
  note?: string;
}

export interface PlanFileRead {
  text: string;
  plan: PlanFile;
  /** `file`: PLAN.md. `store`: the older store, shown as the PLAN.md it will become. `none`: no plan yet. */
  source: 'file' | 'store' | 'none';
}

interface Location { root: string; featureId: string }

async function locate(workspacePath: string): Promise<Location> {
  const root = await fs.realpath(workspacePath);
  return { root, featureId: (await loadFeatureConfig(root))?.id ?? path.basename(root) };
}

async function readOptional(location: Location, file: string): Promise<string | null> {
  try {
    return await readWorkspaceFile(location.root, location.featureId, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The older store as PLAN.md text, or null when it holds nothing. Older lifecycles and notes files are read too. */
async function textFromOldStore(location: Location): Promise<string | null> {
  const { readPlanReadOnly } = await import('./lifecycle.js');
  const plan = await readPlanReadOnly(location.root);
  if (!plan.items.length) return null;
  const feature = await loadFeatureConfig(location.root);
  const { loadWorkGuidance } = await import('./work-guidance.js');
  const objective = (await loadWorkGuidance(location.root).catch(() => null))?.assignment.objective;
  return planFileFromStore(plan, { title: feature?.name || feature?.branchName || 'Plan', goal: objective || feature?.description });
}

async function readAt(location: Location): Promise<PlanFileRead> {
  const text = await readOptional(location, PLAN_FILE);
  if (text !== null) return { text, plan: parsePlanFile(text), source: 'file' };
  const converted = await textFromOldStore(location);
  if (converted !== null) return { text: converted, plan: parsePlanFile(converted), source: 'store' };
  return { text: '', plan: parsePlanFile(''), source: 'none' };
}

/** Reads the plan, and notes what changed in the file since ContextSpace last looked. */
export async function readPlanFile(workspacePath: string): Promise<PlanFileRead> {
  const location = await locate(workspacePath);
  const read = await readAt(location);
  if (read.source === 'file') await noticeChanges(location, read, 'file').catch(() => undefined);
  return read;
}

const lockOf = (location: Location) => acquireLock(path.join(location.root, '.contextspace-plan.lock'), {
  staleMs: 60_000, timeoutMs: 10_000, timeoutMessage: 'The plan is busy in another session. Retry.',
});

/**
 * Changes PLAN.md under the lock: `change` gets the text as it is now and returns the new text. The older store moves
 * over first. What changed is logged as made by `by`.
 */
export async function changePlanFile(
  workspacePath: string,
  change: (text: string, plan: PlanFile) => string,
  options: { by: string },
): Promise<PlanFileRead> {
  const location = await locate(workspacePath);
  const release = await lockOf(location);
  try {
    await moveOldStore(location);
    const current = await readAt(location);
    // Whatever changed in the file before this change is someone else's.
    if (current.source === 'file') await noticeChanges(location, current, 'file', { locked: true });
    const text = change(current.text, current.plan);
    if (text === current.text) return current;
    await writeWorkspaceFile(location.root, location.featureId, PLAN_FILE, text.endsWith('\n') ? text : `${text}\n`);
    const next = await readAt(location);
    await noticeChanges(location, next, options.by, { locked: true });
    return next;
  } finally {
    await release();
  }
}

/** Moves the older store to PLAN.md, when there is one and no PLAN.md yet. True when it moved. */
export async function movePlanToFile(workspacePath: string): Promise<boolean> {
  const location = await locate(workspacePath);
  const release = await lockOf(location);
  try {
    return await moveOldStore(location);
  } finally {
    await release();
  }
}

/** Runs under the lock. Writes PLAN.md from the older store, carries the checks over and archives the old files. */
async function moveOldStore(location: Location): Promise<boolean> {
  if ((await readOptional(location, PLAN_FILE)) !== null) return false;
  const { preparePlan } = await import('./plan-import.js');
  const { PLANNING_NOTES_FILE } = await import('./planning-notes.js');
  const hasOld = (await readOptional(location, OLD_STORE)) !== null || (await readOptional(location, PLANNING_NOTES_FILE)) !== null;
  // Older lifecycles and notes files go into the store first, the way they always moved.
  const plan = hasOld || (await loadWorkspaceState(location.root)).lifecycle?.steps.length ? await preparePlan(location.root) : null;
  if (!plan) return false;
  const text = await textFromOldStore(location);
  if (text !== null) {
    await writeWorkspaceFile(location.root, location.featureId, PLAN_FILE, text);
    const parsed = parsePlanFile(text);
    const keyOf = new Map(plan.items.filter((item) => item.kind === 'milestone')
      .map((item) => [item.id, parsed.checkpoints.find((checkpoint) => checkpoint.title === item.title)?.key]));
    await mutateWorkspaceState(location.root, (state) => {
      for (const [id, evidence] of Object.entries(state.planEvidence ?? {})) {
        const key = keyOf.get(id);
        if (key && !state.planChecks?.[key]) state.planChecks = { ...state.planChecks, [key]: evidence };
      }
    });
    await saveSeen(location, parsed, hash(text));
  }
  const old = await readOptional(location, OLD_STORE);
  if (old !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeWorkspaceFile(location.root, location.featureId, `${ARCHIVE_DIR}/contextspace-plan-${stamp}.json`, old);
    await deleteWorkspaceFile(location.root, location.featureId, OLD_STORE);
  }
  await deleteWorkspaceFile(location.root, location.featureId, OLD_SUMMARY).catch(() => false);
  return text !== null;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

interface SeenItem { kind: PlanItemKind; text: string; done: boolean; answer?: string }
interface Seen { hash: string; items: Record<string, SeenItem> }

function seenItems(plan: PlanFile): Record<string, SeenItem> {
  const kindOf = (item: PlanCheckpoint | PlanStep | PlanDecision): PlanItemKind => ('question' in item ? 'decision' : 'title' in item ? 'checkpoint' : 'step');
  return Object.fromEntries(planItems(plan).map((item) => [item.key, {
    kind: kindOf(item),
    text: 'question' in item ? item.question : 'title' in item ? item.title : item.text,
    done: item.done,
    ...('question' in item && item.answer ? { answer: item.answer } : {}),
  }]));
}

async function saveSeen(location: Location, plan: PlanFile, fileHash: string): Promise<void> {
  const seen: Seen = { hash: fileHash, items: seenItems(plan) };
  await writeWorkspaceFile(location.root, location.featureId, SEEN_FILE, `${JSON.stringify(seen)}\n`);
}

/** What changed between two versions of the plan, as log entries. */
export function planChanges(before: Record<string, SeenItem>, after: PlanFile, by: string, at: string): PlanFileChange[] {
  const now = seenItems(after);
  const changes: PlanFileChange[] = [];
  for (const [key, item] of Object.entries(now)) {
    const was = before[key];
    const entry = (action: PlanFileChange['action'], note?: string) => changes.push({ at, by, action, kind: item.kind, key, text: item.text, ...(note ? { note } : {}) });
    if (!was) entry(item.done && item.kind === 'decision' && item.answer ? 'answered' : 'added', item.answer);
    else if (!was.done && item.done) entry(item.kind === 'decision' ? 'answered' : 'ticked', item.answer);
    else if (was.done && !item.done) entry('unticked');
    else if (item.kind === 'decision' && item.answer && item.answer !== was.answer) entry('answered', item.answer);
  }
  for (const [key, item] of Object.entries(before)) {
    if (!now[key]) changes.push({ at, by, action: 'removed', kind: item.kind, key, text: item.text });
  }
  return changes;
}

/**
 * Compares the file with the last version seen and logs what changed as made by `by`. The first time, it only
 * remembers the file. Outside the lock, it gives way to a change in progress rather than wait.
 */
async function noticeChanges(location: Location, read: PlanFileRead, by: string, options: { locked?: boolean } = {}): Promise<void> {
  const fileHash = hash(read.text);
  const seenText = await readOptional(location, SEEN_FILE);
  const seen = seenText ? (JSON.parse(seenText) as Seen) : null;
  if (seen?.hash === fileHash) return;
  const release = options.locked ? null : await lockOf(location).catch(() => null);
  if (!options.locked && !release) return;
  try {
    if (seen) {
      const changes = planChanges(seen.items, read.plan, by, new Date().toISOString());
      if (changes.length) await appendChanges(location, changes);
    }
    await saveSeen(location, read.plan, fileHash);
  } finally {
    await release?.();
  }
}

async function appendChanges(location: Location, changes: PlanFileChange[]): Promise<void> {
  const old = (await readOptional(location, CHANGES_FILE)) ?? '';
  const lines = [...old.split('\n').filter(Boolean), ...changes.map((change) => JSON.stringify(change))].slice(-CHANGES_KEPT);
  await writeWorkspaceFile(location.root, location.featureId, CHANGES_FILE, `${lines.join('\n')}\n`);
}

/** The latest changes to the plan, newest first. A line that cannot be read is skipped. */
export async function readPlanChanges(workspacePath: string, limit = 50): Promise<PlanFileChange[]> {
  const text = await readOptional(await locate(workspacePath), CHANGES_FILE).catch(() => null);
  return (text ?? '').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as PlanFileChange]; } catch { return []; }
  }).reverse().slice(0, limit);
}

/** The last check of each checkpoint, by its key. */
export async function readPlanChecks(workspacePath: string): Promise<Record<string, PlanEvidence>> {
  return (await loadWorkspaceState(workspacePath)).planChecks ?? {};
}

/**
 * Runs a checkpoint's check (its `Check:` command, or the workspace's own checks) on the code as it is now, and
 * keeps the result as its proof. It does not tick the checkpoint: whoever ran it does, once it passed.
 */
export async function runPlanCheck(workspacePath: string, key: string, options: { timeoutMs?: number } = {}): Promise<PlanEvidence> {
  const { plan } = await readPlanFile(workspacePath);
  const checkpoint = plan.checkpoints.find((candidate) => candidate.key === key);
  if (!checkpoint) throw new Error(`There is no checkpoint "${key}" in ${PLAN_FILE}.`);
  const { verifyWorkspace } = await import('./verify.js');
  const report = await verifyWorkspace(workspacePath, { command: checkpoint.check ?? undefined, timeoutMs: options.timeoutMs ?? 30 * 60_000 });
  const evidence: PlanEvidence = {
    ...(report.repos[0]?.headSha ? { lastVerificationSha: report.repos[0].headSha } : {}),
    lastVerificationStatus: report.overallStatus,
    canProgress: report.canProgress,
    at: new Date().toISOString(),
  };
  await mutateWorkspaceState(workspacePath, (state) => { state.planChecks = { ...state.planChecks, [key]: evidence }; });
  return evidence;
}
