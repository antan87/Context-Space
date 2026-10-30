/**
 * Plan payloads for the app, as GET /api/workspace/:id/plan sends them (core/plan-file-app): PLAN.md's free text and
 * its checkpoints, steps and decisions. And the board, as GET /api/workspace/:id/board sends it (core/board).
 */
import type { PlanFileCheckpoint, PlanFileDecision, PlanFileStep, PlanFileView } from '../src/features/plan/planFile.ts';
import type { WhatsNewView } from '../src/features/plan/whatsNew.ts';

const keyOf = (words: string) => words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function step(text: string, done = false): PlanFileStep {
  return { key: keyOf(text), text, done };
}

export function decision(question: string, fields: Partial<PlanFileDecision> = {}): PlanFileDecision {
  return { key: keyOf(question), question, done: false, suggested: [], ...fields };
}

export function checkpoint(title: string, fields: Partial<PlanFileCheckpoint> = {}): PlanFileCheckpoint {
  const decisions = (fields.decisions ?? []).map((entry) => ({ ...entry, checkpoint: keyOf(title) }));
  return { key: keyOf(title), title, done: false, steps: [], ...fields, decisions };
}

/** A plan as the app reads it; the decisions that wait are worked out the way core/plan-file does. */
export function planFile(fields: Partial<PlanFileView> = {}): PlanFileView {
  const checkpoints = fields.checkpoints ?? [];
  const decisions = fields.decisions ?? [];
  const waiting = [...checkpoints.filter((entry) => !entry.done).flatMap((entry) => entry.decisions), ...decisions].filter((entry) => !entry.done).map((entry) => entry.key);
  return {
    file: 'PLAN.md', source: fields.source ?? (checkpoints.length || decisions.length || fields.steps?.length || fields.intro ? 'file' : 'none'),
    title: 'Plan', intro: '', sections: [], steps: [], changes: [], ...fields, checkpoints, decisions, waiting: fields.waiting ?? waiting,
  };
}

/** What changed since the user last looked, as GET /api/workspace/:id/news sends it; nothing changed by default. */
export function whatsNew(fields: Partial<WhatsNewView> = {}): WhatsNewView {
  const now = Date.now();
  const empty = { items: [], more: 0 };
  const report: WhatsNewView = {
    reader: 'user', at: new Date(now).toISOString(), from: new Date(now - 2 * 3_600_000).toISOString(), basis: 'last-look',
    plan: empty, documents: empty, knowledge: empty, commits: [], problems: [], empty: true, ...fields,
  };
  const nothing = [report.plan, report.documents, report.knowledge].every((section) => section.items.length === 0) && report.commits.every((repo) => repo.commits.length === 0);
  return { ...report, empty: fields.empty ?? nothing };
}

/** A uuid for the nth card or line of a test board. */
export const boardId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The first open step of the checkpoint 'Reports export to CSV' in the specs: the current step, where a card with no step of its own goes. */
export const CURRENT_STEP = 'background-job-queue-for-large-exports';

/** A note card as the board file keeps it. Made by claude a few minutes ago, on the current step, unless the fields say otherwise. */
export function boardNote(n: number, fields: Record<string, unknown> = {}) {
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  return { id: boardId(n), kind: 'note', title: `Note ${n}`, body: `About note ${n}.`, pinned: false, archived: false, by: 'claude', at, updatedBy: 'claude', updatedAt: at, step: CURRENT_STEP, ...fields };
}

/** A file card as the board file keeps it. */
export function boardFileCard(n: number, path: string, fields: Record<string, unknown> = {}) {
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  return { id: boardId(n), kind: 'file', title: `File ${n}`, path, description: `The file ${n}.`, pinned: false, archived: false, by: 'claude', at, updatedBy: 'claude', updatedAt: at, step: CURRENT_STEP, ...fields };
}

export function boardLink(n: number, from: string, to: string, label?: string) {
  return { id: boardId(900 + n), from, to, ...(label ? { label } : {}), by: 'claude', at: new Date(Date.now() - 5 * 60_000).toISOString() };
}

/** The board as the app reads it; empty by default, as for a workspace with no board file. */
export function boardFile(fields: Record<string, unknown> = {}) {
  return { version: 1, revision: 1, cards: [], links: [], positions: {}, ...fields };
}
