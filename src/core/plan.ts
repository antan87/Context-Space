/**
 * @module core/plan
 * The workspace plan: one committed store, `contextspace-plan.json`, that holds every milestone,
 * task, question, decision and piece of existing work, and the rules for changing it.
 *
 * Every caller (the lifecycle view, the CLI, MCP and the Plan tab) changes the plan through
 * `changePlan`, one item at a time, so the rules hold whoever makes the change:
 * - closing needs a reason, and nothing is deleted;
 * - the AI closes only items it owns; for a milestone or the user's item its change becomes a
 *   proposal that the user accepts or sends back;
 * - `waitsFor` is the only dependency, and it cannot form a cycle;
 * - nothing starts by itself.
 * A write re-reads the store under a lock, applies one change and bumps the revision. A store that
 * cannot be read fails closed: nothing is written and the error says how to restore it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { acquireLock, createMutationQueue } from './locks.js';
import { readWorkspaceFile, writeWorkspaceFile } from './storage.js';
import { loadFeatureConfig } from './workspace.js';
import { assertNoLinkedPathComponents } from '../resources/fs-safety.js';
import {
  KIND_WORDS,
  PLAN_KINDS,
  PLAN_STATUSES,
  isOpenStatus,
  isSettledStatus,
  itemLabel,
  sentence,
  statusLabel,
  type PlanKind,
  type PlanStatus,
} from './plan-words.js';

export const PLAN_STORE_FILE = 'contextspace-plan.json';
export const PLAN_FORMAT_VERSION = 1;
/** How many changes each item keeps in its history. */
export const PLAN_HISTORY_LIMIT = 20;
const PLAN_ITEM_LIMIT = 500;
/** The longest a resolution, reason or note may be. */
export const NOTE_MAX = 2000;
export const TITLE_MAX = 200;
export const DETAIL_MAX = 4000;
export const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Who makes a change. On the command line a non-interactive shell is the AI. */
export type PlanActor = { by: 'user' } | { by: 'agent'; harness?: string };

/** A close the AI may not make itself, kept on the item until the user decides. */
export type ProposalAction = 'done' | 'answer' | 'drop' | 'later' | 'reopen';

export interface PlanHistoryEntry {
  at: string;
  /** `user`, `agent`, or the AI tool's name, for example `claude`. */
  by: string;
  action: string;
  note?: string;
}

export interface PlanProposal {
  action: ProposalAction;
  by: string;
  note: string;
  at: string;
}

export interface PlanLinks {
  repo?: string;
  branch?: string;
  workItem?: string;
}

/** A milestone's check: whether it must pass before the milestone counts as done, and how. */
export interface PlanGate {
  required: boolean;
  command?: string;
  timeoutSeconds?: number;
}

export interface PlanItem {
  id: string;
  kind: PlanKind;
  title: string;
  detail?: string;
  status: PlanStatus;
  /** `user`, `agent`, an AI tool's name or a person's name. */
  owner?: string;
  /** Items that must be settled first. The only dependency field: "holds up" is computed from it. */
  waitsFor: string[];
  /** Required for done and dropped: the answer, the outcome, or why it is not needed. */
  resolution?: string;
  /** Required for later: when to look at it again. */
  revisitWhen?: string;
  /** Required for blocked. */
  blockedReason?: string;
  blockedAt?: string;
  unblockCondition?: string;
  links?: PlanLinks;
  gate?: PlanGate;
  proposal?: PlanProposal;
  reopenCount?: number;
  reopenedAt?: string;
  reopenReason?: string;
  reopenedBy?: 'user' | 'agent';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  closedAt?: string;
  history: PlanHistoryEntry[];
}

/** An older planning file moved into the plan, so moving it again changes nothing. */
export interface PlanImport {
  file: string;
  /** SHA-256 of the file's content when it was read. */
  hash: string;
  at: string;
  /** Where the file was kept, if it was. */
  archivedAs?: string;
  /** The items the import added. */
  items: string[];
}

export interface PlanDocument {
  version: typeof PLAN_FORMAT_VERSION;
  revision: number;
  updatedAt: string;
  items: PlanItem[];
  imports?: PlanImport[];
}

export type PlanChange =
  | {
    type: 'add'; kind: PlanKind; title: string; id?: string; detail?: string; owner?: string;
    /** This item waits for these. */
    after?: string[];
    /** These items wait for this one. */
    before?: string[];
    links?: PlanLinks; gate?: PlanGate; unblockCondition?: string;
  }
  | { type: 'start'; id: string }
  | { type: 'done'; id: string; resolution: string; checkPassed?: boolean }
  | { type: 'answer'; id: string; answer: string }
  | { type: 'drop'; id: string; reason: string }
  | { type: 'later'; id: string; revisitWhen: string }
  | { type: 'block'; id: string; reason: string }
  | { type: 'reopen'; id: string; reason: string }
  | {
    type: 'edit'; id: string; title?: string; detail?: string | null; owner?: string | null;
    after?: string[]; notAfter?: string[]; before?: string[];
    links?: PlanLinks; gate?: PlanGate | null; unblockCondition?: string | null;
  }
  | { type: 'accept'; id: string; checkPassed?: boolean }
  | { type: 'reject'; id: string; reason: string };

export interface PlanChangeResult {
  plan: PlanDocument;
  item: PlanItem;
  /** `proposed` when the change waits for the user. */
  outcome: 'applied' | 'proposed';
  /** One sentence for the caller to show, naming the item by its label. */
  message: string;
}

export class PlanError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'invalid' | 'conflict' | 'corrupt' | 'not_allowed' | 'waiting') {
    super(message);
    this.name = 'PlanError';
  }
}

const historySchema = z.object({
  at: z.string(), by: z.string().max(100), action: z.string().max(40), note: z.string().max(NOTE_MAX).optional(),
});
const itemSchema = z.object({
  id: z.string().regex(ID_PATTERN).max(100),
  kind: z.enum(PLAN_KINDS),
  title: z.string().min(1).max(TITLE_MAX),
  detail: z.string().max(DETAIL_MAX).optional(),
  status: z.enum(PLAN_STATUSES),
  owner: z.string().max(200).optional(),
  waitsFor: z.array(z.string()).max(100),
  resolution: z.string().max(NOTE_MAX).optional(),
  revisitWhen: z.string().max(NOTE_MAX).optional(),
  blockedReason: z.string().max(NOTE_MAX).optional(),
  blockedAt: z.string().optional(),
  unblockCondition: z.string().max(NOTE_MAX).optional(),
  links: z.object({
    repo: z.string().max(200).optional(), branch: z.string().max(200).optional(), workItem: z.string().max(NOTE_MAX).optional(),
  }).optional(),
  gate: z.object({
    required: z.boolean(), command: z.string().max(NOTE_MAX).optional(), timeoutSeconds: z.number().int().positive().optional(),
  }).optional(),
  proposal: z.object({
    action: z.enum(['done', 'answer', 'drop', 'later', 'reopen']), by: z.string().max(100), note: z.string().max(NOTE_MAX), at: z.string(),
  }).optional(),
  reopenCount: z.number().int().nonnegative().optional(),
  reopenedAt: z.string().optional(),
  reopenReason: z.string().max(NOTE_MAX).optional(),
  reopenedBy: z.enum(['user', 'agent']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  closedAt: z.string().optional(),
  history: z.array(historySchema).max(PLAN_HISTORY_LIMIT),
});
const planSchema = z.object({
  version: z.literal(PLAN_FORMAT_VERSION),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  items: z.array(itemSchema).max(PLAN_ITEM_LIMIT),
  imports: z.array(z.object({
    file: z.string().max(200), hash: z.string().regex(/^[a-f0-9]{64}$/), at: z.string(),
    archivedAs: z.string().max(300).optional(), items: z.array(z.string()).max(PLAN_ITEM_LIMIT),
  })).max(100).optional(),
});

export function emptyPlan(): PlanDocument {
  return { version: PLAN_FORMAT_VERSION, revision: 0, updatedAt: new Date(0).toISOString(), items: [] };
}

function corrupt(why: string): PlanError {
  return new PlanError(
    `The plan file ${PLAN_STORE_FILE} can't be read: ${why}. Nothing was changed. ` +
    `Restore the last good copy with "git checkout -- ${PLAN_STORE_FILE}" in the workspace folder, or fix the file.`,
    'corrupt',
  );
}

/** What makes a plan inconsistent, in words, or null: duplicate codes, unknown or circular waits. */
export function planIntegrityProblem(plan: PlanDocument): string | null {
  const byId = new Map<string, PlanItem>();
  for (const item of plan.items) {
    if (byId.has(item.id)) return `two items use the code ${item.id}`;
    byId.set(item.id, item);
  }
  for (const item of plan.items) {
    for (const id of item.waitsFor) {
      if (id === item.id) return `${itemLabel(item)} waits for itself`;
      if (!byId.has(id)) return `${itemLabel(item)} waits for ${id}, which is not in the plan`;
    }
  }
  const cycle = findCycle(plan.items);
  return cycle ? `what items wait for goes in a circle: ${cycle.map((id) => itemLabel(byId.get(id)!)).join(' → ')}` : null;
}

function findCycle(items: PlanItem[]): string[] | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  const done = new Set<string>();
  const trail: string[] = [];
  const onTrail = new Set<string>();
  const visit = (id: string): string[] | null => {
    if (onTrail.has(id)) return [...trail.slice(trail.indexOf(id)), id];
    if (done.has(id)) return null;
    trail.push(id); onTrail.add(id);
    for (const next of byId.get(id)?.waitsFor ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    trail.pop(); onTrail.delete(id); done.add(id);
    return null;
  };
  for (const item of items) {
    const found = visit(item.id);
    if (found) return found;
  }
  return null;
}

/** Parses the stored text, failing closed on anything that is not a valid plan. */
export function parsePlan(raw: string): PlanDocument {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw corrupt(`it is not valid JSON (${(error as Error).message})`);
  }
  const version = (data as { version?: unknown } | null)?.version;
  if (typeof version === 'number' && version > PLAN_FORMAT_VERSION) {
    throw new PlanError(`The plan file ${PLAN_STORE_FILE} was written by a newer ContextSpace (format ${version}). Update ContextSpace to read it. Nothing was changed.`, 'corrupt');
  }
  const parsed = planSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw corrupt(`${issue?.path.join('.') || 'the file'}: ${issue?.message ?? 'not a plan'}`);
  }
  const plan = parsed.data as PlanDocument;
  const problem = planIntegrityProblem(plan);
  if (problem) throw corrupt(problem);
  return plan;
}

async function planLocation(workspacePath: string): Promise<{ root: string; featureId: string }> {
  const root = await fs.realpath(workspacePath);
  await assertNoLinkedPathComponents(root, path.join(root, PLAN_STORE_FILE));
  const feature = await loadFeatureConfig(root);
  return { root, featureId: feature?.id ?? path.basename(root) };
}

async function readRaw(root: string, featureId: string): Promise<string | null> {
  try {
    return await readWorkspaceFile(root, featureId, PLAN_STORE_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether the workspace has a plan store yet. A workspace folder that does not exist has none. */
export async function planStoreExists(workspacePath: string): Promise<boolean> {
  let location: { root: string; featureId: string };
  try {
    location = await planLocation(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return (await readRaw(location.root, location.featureId)) !== null;
}

/** Reads the plan, or null when the workspace has no store yet. */
export async function readPlanIfExists(workspacePath: string): Promise<PlanDocument | null> {
  const { root, featureId } = await planLocation(workspacePath);
  const raw = await readRaw(root, featureId);
  return raw === null ? null : parsePlan(raw);
}

/** Reads the plan. A workspace without a store has an empty plan at revision 0. */
export async function readPlan(workspacePath: string): Promise<PlanDocument> {
  return (await readPlanIfExists(workspacePath)) ?? emptyPlan();
}

const runPlanMutation = createMutationQueue();

/**
 * Changes the plan under a lock: re-reads it, runs the synchronous `mutation`, checks the result and
 * writes it with the next revision. Nothing is written when the mutation throws or changes nothing.
 * `keepRevision` is for moving existing data into the store, which is not a change to the plan;
 * `alwaysWrite` counts a save that changes nothing as a new revision, for editors that save whole plans.
 */
export async function mutatePlan<T>(
  workspacePath: string,
  mutation: (plan: PlanDocument, context: { exists: boolean }) => T,
  options: { keepRevision?: boolean; alwaysWrite?: boolean } = {},
): Promise<{ plan: PlanDocument; result: T; changed: boolean }> {
  const outcome = await savePlanMutation(workspacePath, mutation, options);
  if (outcome.changed) {
    // contextspace-plan.md follows the plan. Imported here: the summary module reads the plan.
    const { writePlanSummary } = await import('./plan-summary.js');
    await writePlanSummary(workspacePath).catch(() => undefined);
  }
  return outcome;
}

async function savePlanMutation<T>(
  workspacePath: string,
  mutation: (plan: PlanDocument, context: { exists: boolean }) => T,
  options: { keepRevision?: boolean; alwaysWrite?: boolean },
): Promise<{ plan: PlanDocument; result: T; changed: boolean }> {
  return runPlanMutation(async () => {
    const { root, featureId } = await planLocation(workspacePath);
    const release = await acquireLock(path.join(root, '.contextspace-plan.lock'), {
      staleMs: 60_000,
      timeoutMs: 10_000,
      timeoutMessage: 'The plan is busy in another session. Retry.',
    });
    try {
      const raw = await readRaw(root, featureId);
      const plan = raw === null ? emptyPlan() : parsePlan(raw);
      const before = JSON.stringify(plan);
      const result = mutation(plan, { exists: raw !== null });
      const changed = Boolean(options.alwaysWrite) || JSON.stringify(plan) !== before;
      if (changed) {
        const problem = planIntegrityProblem(plan);
        if (problem) throw new PlanError(`This change would break the plan: ${problem}.`, 'invalid');
        if (!options.keepRevision) plan.revision += 1;
        plan.updatedAt = new Date().toISOString();
        // Never write what could not be read back.
        const check = planSchema.safeParse(plan);
        if (!check.success) {
          const issue = check.error.issues[0];
          throw new PlanError(`This change would break the plan: ${issue?.path.join('.')}: ${issue?.message}.`, 'invalid');
        }
        await writeWorkspaceFile(root, featureId, PLAN_STORE_FILE, `${JSON.stringify(plan, null, 2)}\n`);
      }
      return { plan, result, changed };
    } finally {
      await release();
    }
  });
}

/**
 * Applies one change to one item, following the plan's rules. `ifRevision` fails the change when the
 * plan moved on since the caller read it; `ifItemUpdatedAt` does the same for the one item only.
 */
export async function changePlan(
  workspacePath: string,
  change: PlanChange,
  options: { actor: PlanActor; ifRevision?: number; ifItemUpdatedAt?: string },
): Promise<PlanChangeResult> {
  const { plan, result } = await mutatePlan(workspacePath, (current) => {
    if (options.ifRevision !== undefined && current.revision !== options.ifRevision) {
      throw new PlanError(`The plan changed since it was read (revision ${options.ifRevision}, now ${current.revision}). Read it again and retry.`, 'conflict');
    }
    if (options.ifItemUpdatedAt !== undefined && change.type !== 'add') {
      const item = current.items.find((candidate) => candidate.id === change.id);
      if (item && item.updatedAt !== options.ifItemUpdatedAt) {
        throw new PlanError(`${itemLabel(item)} changed since it was read. Read the plan again and retry.`, 'conflict');
      }
    }
    return applyPlanChange(current, change, options.actor);
  });
  const item = plan.items.find((candidate) => candidate.id === result.itemId)!;
  return { plan, item, outcome: result.outcome, message: result.message };
}

function actorName(actor: PlanActor): string {
  return actor.by === 'user' ? 'user' : (actor.harness?.trim().toLowerCase() || 'agent');
}

/** The AI may close an item it owns. Milestones and the user's items need the user. */
export function agentMayClose(item: PlanItem, actor: PlanActor): boolean {
  if (actor.by === 'user') return true;
  if (item.kind === 'milestone') return false;
  const owner = item.owner?.trim().toLowerCase();
  return owner === 'agent' || (Boolean(actor.harness) && owner === actor.harness!.trim().toLowerCase());
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_KEEP_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A note typed by a person or an AI, on one line, made safe to store and print. */
function cleanNote(value: unknown, emptyMessage: string, max = NOTE_MAX): string {
  const text = typeof value === 'string' ? value.replace(CONTROL_CHARACTERS, '').replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new PlanError(emptyMessage, 'invalid');
  if (text.length > max) throw new PlanError(`Keep it to ${max} characters or fewer.`, 'invalid');
  return text;
}

function cleanDetail(value: string): string | undefined {
  const text = value.replace(CONTROL_CHARACTERS_KEEP_LINES, '').replace(/\r\n?/g, '\n').trim();
  if (text.length > DETAIL_MAX) throw new PlanError(`Keep the detail to ${DETAIL_MAX} characters or fewer.`, 'invalid');
  return text || undefined;
}

function find(plan: PlanDocument, id: string): PlanItem {
  const item = plan.items.find((candidate) => candidate.id === id);
  if (!item) throw new PlanError(`There is no item "${id}" in the plan. Read the plan to see the codes.`, 'not_found');
  return item;
}

function record(item: PlanItem, actor: PlanActor, action: string, now: string, note?: string): void {
  item.history.push({ at: now, by: actorName(actor), action, ...(note ? { note } : {}) });
  if (item.history.length > PLAN_HISTORY_LIMIT) item.history.splice(0, item.history.length - PLAN_HISTORY_LIMIT);
  item.updatedAt = now;
}

/** The items this one waits for that are not settled yet. */
export function unsettledWaits(plan: PlanDocument, item: PlanItem): PlanItem[] {
  return item.waitsFor
    .map((id) => plan.items.find((candidate) => candidate.id === id))
    .filter((wait): wait is PlanItem => Boolean(wait) && !isSettledStatus(wait!.status));
}

function assertWaitsSettled(plan: PlanDocument, item: PlanItem, verb: string): void {
  const waiting = unsettledWaits(plan, item);
  if (waiting.length) {
    throw new PlanError(
      `Can't ${verb} ${itemLabel(item)} yet. It waits for: ${waiting.map((wait) => `${itemLabel(wait)} (${statusLabel(wait.status)})`).join(', ')}.`,
      'waiting',
    );
  }
}

/** The next free code for a kind: M3 after M2. */
export function nextId(plan: PlanDocument, kind: PlanKind): string {
  const prefix = KIND_WORDS[kind].prefix;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const highest = plan.items.reduce((max, item) => Math.max(max, Number(pattern.exec(item.id)?.[1] ?? 0)), 0);
  return `${prefix}${highest + 1}`;
}

function resolveIds(plan: PlanDocument, ids: string[] | undefined): PlanItem[] {
  return [...new Set(ids ?? [])].map((id) => find(plan, id));
}

const PROPOSED: Record<ProposalAction, (label: string) => string> = {
  done: (label) => `Proposed that ${label} is done`,
  answer: (label) => `Proposed an answer for ${label}`,
  drop: (label) => `Proposed dropping ${label}`,
  later: (label) => `Proposed moving ${label} to later`,
  reopen: (label) => `Proposed reopening ${label}`,
};

function proposedMessage(item: PlanItem, action: ProposalAction): string {
  const whose = item.kind === 'milestone' ? 'A milestone is the user\'s decision' : 'This item is the user\'s decision';
  return `${sentence(PROPOSED[action](itemLabel(item)))} ${whose}: they see it under Needs you and accept it or send it back. `
    + 'Your part is done: tell the user it waits for them. Do not look for another way to close it.';
}

function clearOpenNotes(item: PlanItem): void {
  delete item.blockedReason;
  delete item.blockedAt;
  delete item.revisitWhen;
}

/**
 * Applies one change in memory. Pure apart from the plan it is given, so the rules can be tested
 * without a disk; `changePlan` runs it under the lock.
 */
export function applyPlanChange(
  plan: PlanDocument,
  change: PlanChange,
  actor: PlanActor,
  now = new Date().toISOString(),
): { itemId: string; outcome: 'applied' | 'proposed'; message: string } {
  const applied = (item: PlanItem, message: string) => ({ itemId: item.id, outcome: 'applied' as const, message });

  // A close the AI may not make itself becomes a proposal on the item; the user decides.
  const closing = (item: PlanItem, action: ProposalAction, note: string, apply: () => string) => {
    if (agentMayClose(item, actor)) return applied(item, apply());
    item.proposal = { action, by: actorName(actor), note, at: now };
    record(item, actor, 'proposed', now, `${action}: ${note}`);
    return { itemId: item.id, outcome: 'proposed' as const, message: proposedMessage(item, action) };
  };

  const finish = (item: PlanItem, status: 'done' | 'dropped', resolution: string, action: string) => {
    item.status = status;
    item.resolution = resolution;
    item.closedAt = now;
    clearOpenNotes(item);
    delete item.proposal;
    if (status === 'done') {
      // Finished again: the rework is over. The count stays as history.
      delete item.reopenedAt;
      delete item.reopenReason;
      delete item.reopenedBy;
    }
    record(item, actor, action, now, resolution);
  };

  const assertGate = (item: PlanItem, checkPassed: boolean | undefined) => {
    if (item.kind === 'milestone' && item.gate?.required && !checkPassed) {
      throw new PlanError(`${itemLabel(item)} has a check. It must pass on the latest code before the milestone is done.`, 'not_allowed');
    }
  };

  switch (change.type) {
    case 'add': {
      if (!PLAN_KINDS.includes(change.kind)) throw new PlanError(`Unknown kind "${change.kind}". Use one of: ${PLAN_KINDS.join(', ')}.`, 'invalid');
      if (plan.items.length >= PLAN_ITEM_LIMIT) throw new PlanError(`The plan holds at most ${PLAN_ITEM_LIMIT} items.`, 'invalid');
      const title = cleanNote(change.title, 'Give the item a name.', TITLE_MAX);
      let id = change.id?.trim();
      if (id) {
        if (!ID_PATTERN.test(id) || id.length > 100) throw new PlanError(`"${id}" can't be a code: use letters, digits, - and _ only.`, 'invalid');
        if (plan.items.some((item) => item.id === id)) throw new PlanError(`The code ${id} is already used. Leave it out to get a new one.`, 'invalid');
      } else {
        id = nextId(plan, change.kind);
      }
      const after = resolveIds(plan, change.after);
      const before = resolveIds(plan, change.before);
      for (const later of before) {
        if (later.status === 'done') {
          throw new PlanError(`${itemLabel(later)} is done, so it can't start waiting for something new. Reopen it first.`, 'not_allowed');
        }
      }
      const owner = change.owner?.trim() || (actor.by === 'user' ? 'user' : 'agent');
      const item: PlanItem = {
        id, kind: change.kind, title, status: 'todo', owner, waitsFor: after.map((wait) => wait.id),
        createdAt: now, updatedAt: now, history: [],
      };
      if (change.detail) {
        const detail = cleanDetail(change.detail);
        if (detail) item.detail = detail;
      }
      if (change.links) item.links = { ...change.links };
      if (change.gate) item.gate = { ...change.gate };
      if (change.unblockCondition?.trim()) item.unblockCondition = change.unblockCondition.trim();
      record(item, actor, 'added', now);
      plan.items.push(item);
      for (const later of before) {
        if (!later.waitsFor.includes(id)) later.waitsFor.push(id);
        record(later, actor, 'waits', now, `now waits for ${itemLabel(item)}`);
      }
      const holds = before.length ? ` ${before.map(itemLabel).join(', ')} now ${before.length === 1 ? 'waits' : 'wait'} for it.` : '';
      return applied(item, `${sentence(`Added ${itemLabel(item)}`)}${holds}`);
    }

    case 'start': {
      const item = find(plan, change.id);
      if (item.status === 'in_progress') return applied(item, `${itemLabel(item)} is already in progress.`);
      if (item.status === 'done' || item.status === 'dropped') {
        throw new PlanError(`${itemLabel(item)} is ${statusLabel(item.status).toLowerCase()}. Reopen it, with a reason, to work on it again.`, 'not_allowed');
      }
      assertWaitsSettled(plan, item, 'start');
      item.status = 'in_progress';
      clearOpenNotes(item);
      item.startedAt ??= now;
      record(item, actor, 'started', now);
      return applied(item, sentence(`Started ${itemLabel(item)}`));
    }

    case 'done':
    case 'answer': {
      const item = find(plan, change.id);
      const isAnswer = change.type === 'answer';
      if (isAnswer && item.kind !== 'question') {
        throw new PlanError(`Only a question has an answer. ${itemLabel(item)} is a ${KIND_WORDS[item.kind].label.toLowerCase()}: mark it done with what came out of it.`, 'invalid');
      }
      const resolution = isAnswer
        ? cleanNote(change.answer, `Answering needs the answer: say what was decided for ${itemLabel(item)}.`)
        : cleanNote(change.resolution, `Closing needs a reason: say what came out of ${itemLabel(item)}.`);
      if (item.status === 'done' || item.status === 'dropped') {
        throw new PlanError(`${itemLabel(item)} is already ${statusLabel(item.status).toLowerCase()}. Reopen it first to change that.`, 'not_allowed');
      }
      assertWaitsSettled(plan, item, isAnswer ? 'answer' : 'finish');
      return closing(item, isAnswer ? 'answer' : 'done', resolution, () => {
        assertGate(item, change.type === 'done' ? change.checkPassed : undefined);
        finish(item, 'done', resolution, isAnswer ? 'answered' : 'done');
        return isAnswer ? `Answered ${itemLabel(item)}: ${resolution}` : sentence(`Done: ${itemLabel(item)}`);
      });
    }

    case 'drop': {
      const item = find(plan, change.id);
      const reason = cleanNote(change.reason, `Dropping needs a reason: say why ${itemLabel(item)} is not needed.`);
      if (item.status === 'done' || item.status === 'dropped') {
        throw new PlanError(`${itemLabel(item)} is already ${statusLabel(item.status).toLowerCase()}.`, 'not_allowed');
      }
      return closing(item, 'drop', reason, () => {
        finish(item, 'dropped', reason, 'dropped');
        return `Dropped ${itemLabel(item)}: ${reason}`;
      });
    }

    case 'later': {
      const item = find(plan, change.id);
      const revisitWhen = cleanNote(change.revisitWhen, `Moving to later needs a time: say when to look at ${itemLabel(item)} again.`);
      if (!isOpenStatus(item.status)) {
        throw new PlanError(`${itemLabel(item)} is ${statusLabel(item.status).toLowerCase()}, so it can't move to later.`, 'not_allowed');
      }
      return closing(item, 'later', revisitWhen, () => {
        item.status = 'later';
        delete item.blockedReason;
        delete item.blockedAt;
        delete item.proposal;
        item.revisitWhen = revisitWhen;
        record(item, actor, 'later', now, revisitWhen);
        return `Moved ${itemLabel(item)} to later: ${revisitWhen}`;
      });
    }

    case 'block': {
      const item = find(plan, change.id);
      const reason = cleanNote(change.reason, `Blocking needs a reason: say what ${itemLabel(item)} is stuck on.`);
      if (item.status === 'done' || item.status === 'dropped') {
        throw new PlanError(`${itemLabel(item)} is ${statusLabel(item.status).toLowerCase()}, so it can't be blocked.`, 'not_allowed');
      }
      item.status = 'blocked';
      item.blockedReason = reason;
      // Saying it again with a new reason keeps when it first became blocked.
      item.blockedAt ??= now;
      delete item.revisitWhen;
      record(item, actor, 'blocked', now, reason);
      return applied(item, `Blocked ${itemLabel(item)}: ${reason}`);
    }

    case 'reopen': {
      const item = find(plan, change.id);
      const reason = cleanNote(change.reason, `Reopening needs a reason: say what is wrong with ${itemLabel(item)}.`);
      if (item.status === 'todo' || item.status === 'blocked') {
        throw new PlanError(`${itemLabel(item)} is ${statusLabel(item.status).toLowerCase()}, so there is nothing to reopen.`, 'not_allowed');
      }
      // Reopening a milestone, or someone else's item, sends finished work back: the user decides.
      const reopenNeedsUser = actor.by === 'agent' && (item.kind === 'milestone' || !agentMayClose(item, actor));
      if (reopenNeedsUser) {
        item.proposal = { action: 'reopen', by: actorName(actor), note: reason, at: now };
        record(item, actor, 'proposed', now, `reopen: ${reason}`);
        return { itemId: item.id, outcome: 'proposed', message: proposedMessage(item, 'reopen') };
      }
      // Finished work goes back into progress; parked or dropped work goes back to the list.
      item.status = item.status === 'done' || item.status === 'in_progress' ? 'in_progress' : 'todo';
      delete item.resolution;
      delete item.closedAt;
      delete item.revisitWhen;
      delete item.proposal;
      item.reopenedAt = now;
      item.reopenReason = reason;
      item.reopenedBy = actor.by;
      item.reopenCount = (item.reopenCount ?? 0) + 1;
      record(item, actor, 'reopened', now, reason);
      return applied(item, `Reopened ${itemLabel(item)}: ${reason}`);
    }

    case 'edit': {
      const item = find(plan, change.id);
      const notes: string[] = [];
      if (change.title !== undefined) {
        const title = cleanNote(change.title, 'Give the item a name.', TITLE_MAX);
        if (title !== item.title) { notes.push(`renamed from "${item.title}"`); item.title = title; }
      }
      if (change.detail !== undefined) {
        const detail = change.detail === null ? undefined : cleanDetail(change.detail);
        if (detail !== item.detail) {
          if (detail) item.detail = detail; else delete item.detail;
          notes.push('detail changed');
        }
      }
      if (change.owner !== undefined) {
        const owner = change.owner?.trim() || undefined;
        if (owner !== item.owner) {
          if (owner) item.owner = owner; else delete item.owner;
          notes.push(owner ? `owner is now ${owner}` : 'no owner');
        }
      }
      if (change.unblockCondition !== undefined) {
        const condition = change.unblockCondition?.trim() || undefined;
        if (condition !== item.unblockCondition) {
          if (condition) item.unblockCondition = condition; else delete item.unblockCondition;
          notes.push('unblock condition changed');
        }
      }
      if (change.links !== undefined) {
        const links = Object.fromEntries(Object.entries(change.links).filter(([, value]) => value?.trim())) as PlanLinks;
        if (JSON.stringify(links) !== JSON.stringify(item.links ?? {})) {
          if (Object.keys(links).length) item.links = links; else delete item.links;
          notes.push('links changed');
        }
      }
      const waitsChange = Boolean(change.after?.length || change.notAfter?.length);
      const gateChange = change.gate !== undefined && JSON.stringify(change.gate ?? undefined) !== JSON.stringify(item.gate);
      if (item.status === 'done' && (waitsChange || gateChange)) {
        throw new PlanError(`${itemLabel(item)} is done. Reopen it before changing what it waits for or its check.`, 'not_allowed');
      }
      if (gateChange) {
        if (change.gate) item.gate = { ...change.gate }; else delete item.gate;
        notes.push('check changed');
      }
      for (const wait of resolveIds(plan, change.after)) {
        if (!item.waitsFor.includes(wait.id)) { item.waitsFor.push(wait.id); notes.push(`now waits for ${itemLabel(wait)}`); }
      }
      for (const id of new Set(change.notAfter ?? [])) {
        const index = item.waitsFor.indexOf(id);
        if (index >= 0) {
          item.waitsFor.splice(index, 1);
          const wait = plan.items.find((candidate) => candidate.id === id);
          notes.push(`no longer waits for ${wait ? itemLabel(wait) : id}`);
        }
      }
      for (const later of resolveIds(plan, change.before)) {
        if (later.status === 'done') {
          throw new PlanError(`${itemLabel(later)} is done, so it can't start waiting for something new. Reopen it first.`, 'not_allowed');
        }
        if (!later.waitsFor.includes(item.id)) {
          later.waitsFor.push(item.id);
          record(later, actor, 'waits', now, `now waits for ${itemLabel(item)}`);
          notes.push(`${itemLabel(later)} now waits for it`);
        }
      }
      if (!notes.length) return applied(item, sentence(`Nothing to change on ${itemLabel(item)}`));
      record(item, actor, 'edited', now, notes.join('; '));
      return applied(item, `Changed ${itemLabel(item)}: ${notes.join('; ')}.`);
    }

    case 'accept': {
      const item = find(plan, change.id);
      if (actor.by !== 'user') throw new PlanError(`Only the user can accept a proposal on ${itemLabel(item)}.`, 'not_allowed');
      const proposal = item.proposal;
      if (!proposal) throw new PlanError(`${itemLabel(item)} has nothing waiting to be accepted.`, 'not_allowed');
      const user: PlanActor = { by: 'user' };
      const followUp: PlanChange = proposal.action === 'done' ? { type: 'done', id: item.id, resolution: proposal.note, checkPassed: change.checkPassed }
        : proposal.action === 'answer' ? { type: 'answer', id: item.id, answer: proposal.note }
          : proposal.action === 'drop' ? { type: 'drop', id: item.id, reason: proposal.note }
            : proposal.action === 'later' ? { type: 'later', id: item.id, revisitWhen: proposal.note }
              : { type: 'reopen', id: item.id, reason: proposal.note };
      record(item, user, 'accepted', now, `${proposal.action} proposed by ${proposal.by}`);
      const result = applyPlanChange(plan, followUp, user, now);
      delete item.proposal;
      return { ...result, message: `Accepted. ${result.message}` };
    }

    case 'reject': {
      const item = find(plan, change.id);
      if (actor.by !== 'user') throw new PlanError(`Only the user can send back a proposal on ${itemLabel(item)}.`, 'not_allowed');
      const proposal = item.proposal;
      if (!proposal) throw new PlanError(`${itemLabel(item)} has nothing waiting to be accepted.`, 'not_allowed');
      const reason = cleanNote(change.reason, `Sending it back needs a reason: say what still needs doing on ${itemLabel(item)}.`);
      delete item.proposal;
      record(item, actor, 'rejected', now, `${proposal.action} sent back to ${proposal.by}: ${reason}`);
      return applied(item, `${sentence(`Sent back to ${proposal.by}: ${itemLabel(item)}`)} ${reason}`);
    }
  }
}

export interface PlanChangeEntry extends PlanHistoryEntry {
  itemId: string;
  label: string;
}

/** The plan in the sections every surface shows, in the same order and words. */
export interface PlanSections {
  counts: { needsYou: number; inProgress: number; todo: number; blocked: number; later: number; done: number; dropped: number };
  /** Proposals waiting for the user, then open questions the user owns. */
  needsYou: PlanItem[];
  /** Every milestone, in plan order. */
  milestones: PlanItem[];
  /** Open and later items that are not milestones and do not need the user. */
  otherOpen: PlanItem[];
  /** Done and dropped items, each with its reason. */
  closed: PlanItem[];
  /** Milestones and tasks to do whose waits are settled: what can start next. Nothing starts by itself. */
  ready: PlanItem[];
  /** The latest changes across all items, newest first. */
  changes: PlanChangeEntry[];
}

function needsUser(item: PlanItem): boolean {
  return Boolean(item.proposal) || (item.kind === 'question' && isOpenStatus(item.status) && item.owner?.trim().toLowerCase() === 'user');
}

export function planSections(plan: PlanDocument, options: { changes?: number } = {}): PlanSections {
  const needsYou = [
    ...plan.items.filter((item) => item.proposal),
    ...plan.items.filter((item) => !item.proposal && needsUser(item)),
  ];
  const count = (status: PlanStatus) => plan.items.filter((item) => item.status === status).length;
  // Newest first. Changes in the same millisecond keep their recorded order, newest first.
  const changes = plan.items
    .flatMap((item) => item.history.map((entry, index) => ({ entry: { ...entry, itemId: item.id, label: itemLabel(item) }, index })))
    .sort((a, b) => b.entry.at.localeCompare(a.entry.at) || b.index - a.index)
    .slice(0, options.changes ?? 10)
    .map(({ entry }) => entry);
  return {
    counts: {
      needsYou: needsYou.length, inProgress: count('in_progress'), todo: count('todo'), blocked: count('blocked'),
      later: count('later'), done: count('done'), dropped: count('dropped'),
    },
    needsYou,
    milestones: plan.items.filter((item) => item.kind === 'milestone'),
    otherOpen: plan.items.filter((item) => item.kind !== 'milestone' && !needsUser(item) && (isOpenStatus(item.status) || item.status === 'later')),
    closed: plan.items.filter((item) => item.status === 'done' || item.status === 'dropped'),
    ready: plan.items.filter((item) => (item.kind === 'milestone' || item.kind === 'task') && item.status === 'todo' && !item.proposal
      && unsettledWaits(plan, item).length === 0),
    changes,
  };
}

/** The items that wait for this one: what it holds up. */
export function heldUpBy(plan: PlanDocument, id: string): PlanItem[] {
  return plan.items.filter((item) => item.waitsFor.includes(id));
}
