/**
 * @module core/needs-you
 * What needs the user in one workspace, read the way the Overview lists it across all of them: the
 * questions that wait for their answer, what the AI closed lately, checks that failed, and where the
 * work stands. It only reads: an old plan file is not moved here, and a missing source counts as nothing.
 */

import { latestInputRequest } from './attention.js';
import { questionTitle } from './plan-questions.js';
import { heldUpBy, planFocus, readPlanIfExists, type PlanDocument } from './plan.js';
import { isOpenStatus } from './plan-words.js';
import { loadWorkspaceState } from './workspace-state.js';

/** How far back what the AI closed is listed. */
export const AI_CLOSES_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const AI_CLOSES = new Set(['done', 'dropped', 'later', 'reopened']);

export interface WorkspaceNeeds {
  workspaceId: string;
  /** The newest question the AI asked in the chat and still waits on, when the plan does not hold it already. */
  chatQuestion?: { message: string; timestamp: string; harness: string; options?: string[] };
  /** The plan's questions for the user, oldest first. */
  questions: Array<{ id: string; title: string; holdsUp: string[]; askedBy?: string; at: string }>;
  /** Closes an AI proposed under the earlier rule, still waiting for the user. */
  proposals: Array<{ id: string; title: string; action: string; by: string; at: string }>;
  /** Open milestones whose last check here failed. */
  failedChecks: Array<{ id: string; title: string; at?: string }>;
  /** Milestones an AI finished, dropped, put off or reopened lately, newest first. */
  closedByAi: Array<{ id: string; title: string; action: string; by: string; at: string; note?: string }>;
  /** What is being worked on, and what is next with what it waits for. */
  current?: { id: string; title: string };
  next?: { id: string; title: string; waitsFor: string[] };
}

function fromPlan(plan: PlanDocument, failed: ReadonlySet<string>, now: number): Omit<WorkspaceNeeds, 'workspaceId' | 'chatQuestion'> {
  const since = new Date(now - AI_CLOSES_WINDOW_MS).toISOString();
  const milestones = plan.items.filter((item) => item.kind === 'milestone');
  const focus = planFocus(plan);
  return {
    questions: plan.items
      .filter((item) => item.kind === 'question' && !item.proposal && isOpenStatus(item.status) && item.owner?.trim().toLowerCase() === 'user')
      .map((item) => {
        const added = item.history.find((entry) => entry.action === 'added');
        return { id: item.id, title: item.title, holdsUp: heldUpBy(plan, item.id).map((other) => other.title), ...(added ? { askedBy: added.by } : {}), at: item.createdAt };
      }),
    proposals: plan.items.filter((item) => item.proposal)
      .map((item) => ({ id: item.id, title: item.title, action: item.proposal!.action, by: item.proposal!.by, at: item.proposal!.at })),
    failedChecks: milestones.filter((item) => isOpenStatus(item.status) && failed.has(item.id)).map((item) => ({ id: item.id, title: item.title })),
    closedByAi: milestones
      .flatMap((item) => item.history
        .filter((entry) => AI_CLOSES.has(entry.action) && !/^(user|contextspace)$/i.test(entry.by) && entry.at >= since)
        .map((entry) => ({ id: item.id, title: item.title, action: entry.action, by: entry.by, at: entry.at, ...(entry.note ? { note: entry.note } : {}) })))
      .sort((a, b) => b.at.localeCompare(a.at)),
    ...(focus.current ? { current: { id: focus.current.id, title: focus.current.title } } : {}),
    ...(focus.next ? { next: { id: focus.next.id, title: focus.next.title, waitsFor: focus.nextWaitsFor.map((wait) => wait.title) } } : {}),
  };
}

/** Everything that needs the user in one workspace. A source that cannot be read adds nothing. */
export async function workspaceNeeds(workspaceId: string, workspacePath: string, now = Date.now()): Promise<WorkspaceNeeds> {
  const [plan, state, request] = await Promise.all([
    readPlanIfExists(workspacePath).catch(() => null),
    loadWorkspaceState(workspacePath).catch(() => null),
    latestInputRequest(workspacePath, now).catch(() => null),
  ]);
  const failed = new Set(Object.entries(state?.planEvidence ?? {}).filter(([, evidence]) => !evidence.canProgress).map(([id]) => id));
  const needs: WorkspaceNeeds = {
    workspaceId,
    ...(plan ? fromPlan(plan, failed, now) : { questions: [], proposals: [], failedChecks: [], closedByAi: [] }),
  };
  // The AI puts its chat question in the plan too; then it is listed once, as the plan's question.
  if (request && !needs.questions.some((question) => question.title === questionTitle(request.message))) {
    needs.chatQuestion = { message: request.message, timestamp: request.timestamp, harness: request.harness, ...(request.options ? { options: request.options } : {}) };
  }
  return needs;
}

/** Whether anything in a workspace waits for the user: an answer, an OK, or a failed check. */
export function needsAnything(needs: WorkspaceNeeds): boolean {
  return Boolean(needs.chatQuestion) || needs.questions.length > 0 || needs.proposals.length > 0 || needs.failedChecks.length > 0;
}
