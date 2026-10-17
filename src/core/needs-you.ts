/**
 * @module core/needs-you
 * What needs the user in one workspace, read the way the Overview lists it across all of them: the decisions in
 * PLAN.md that wait for their answer, checkpoints whose check failed, what an AI finished lately, and where the work
 * stands. It only reads; an older plan is shown as the PLAN.md it will become, and a missing source counts as nothing.
 */

import { latestInputRequest } from './attention.js';
import { questionTitle } from './plan-questions.js';
import { openDecisions, type PlanFile } from './plan-file.js';
import { readPlanChanges, readPlanChecks, readPlanFile, type PlanFileChange } from './plan-file-store.js';
import type { PlanEvidence } from '../types.js';

/** How far back what an AI finished is listed. */
export const AI_CLOSES_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface WorkspaceNeeds {
  workspaceId: string;
  /** The newest question the AI asked in the chat and still waits on, when the plan does not hold it already. */
  chatQuestion?: { message: string; timestamp: string; harness: string; options?: string[] };
  /**
   * The plan's decisions for the user, oldest first, each by its key. What each holds up is its open checkpoint;
   * `detail` carries why it is asked and its suggested answers; `waiting` says the AI asked it in the chat and waits
   * there for the answer.
   */
  questions: Array<{ id: string; title: string; holdsUp: string[]; detail?: string; askedBy?: string; at: string; waiting?: true }>;
  /** Kept for the app: nothing is proposed for the user's OK any more. */
  proposals: Array<{ id: string; title: string; action: string; by: string; at: string }>;
  /** Open checkpoints whose last check failed. */
  failedChecks: Array<{ id: string; title: string; at?: string }>;
  /** Checkpoints an AI ticked lately, newest first. */
  closedByAi: Array<{ id: string; title: string; action: string; by: string; at: string; note?: string }>;
  /** The checkpoint being worked on, and the one after it. */
  current?: { id: string; title: string };
  next?: { id: string; title: string; waitsFor: string[] };
}

/** Why a decision is asked, with its suggested answers and what happens without one, in the words the app reads. */
function detailOf(decision: ReturnType<typeof openDecisions>[number]): string | undefined {
  const parts = [
    decision.detail,
    decision.ifNoAnswer ? `If you don't answer: ${decision.ifNoAnswer}` : '',
    decision.suggested.length ? `Suggested answers: ${decision.suggested.join(' · ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}

function fromPlan(plan: PlanFile, checks: Record<string, PlanEvidence>, changes: PlanFileChange[], now: number): Omit<WorkspaceNeeds, 'workspaceId' | 'chatQuestion'> {
  const since = new Date(now - AI_CLOSES_WINDOW_MS).toISOString();
  const added = new Map(changes.filter((change) => change.action === 'added').map((change) => [change.key, change]));
  const open = plan.checkpoints.filter((checkpoint) => !checkpoint.done);
  return {
    questions: openDecisions(plan).map((decision) => {
      const holder = open.find((checkpoint) => checkpoint.key === decision.checkpoint);
      const asked = added.get(decision.key);
      const detail = detailOf(decision);
      return {
        id: decision.key, title: decision.question, holdsUp: holder ? [holder.title] : [],
        ...(detail ? { detail } : {}), ...(asked && asked.by !== 'file' ? { askedBy: asked.by } : {}), at: asked?.at ?? '',
      };
    }).sort((a, b) => a.at.localeCompare(b.at)),
    proposals: [],
    failedChecks: open.filter((checkpoint) => checks[checkpoint.key] && !checks[checkpoint.key]!.canProgress)
      .map((checkpoint) => ({ id: checkpoint.key, title: checkpoint.title, ...(checks[checkpoint.key]!.at ? { at: checks[checkpoint.key]!.at } : {}) })),
    closedByAi: changes
      .filter((change) => change.kind === 'checkpoint' && change.action === 'ticked' && change.by !== 'user' && change.at >= since)
      // An edit to the file names nobody; it is nearly always an AI's.
      .map((change) => ({ id: change.key, title: change.text, action: 'done', by: change.by === 'file' || change.by === 'ai' ? 'agent' : change.by, at: change.at })),
    ...(open[0] ? { current: { id: open[0].key, title: open[0].title } } : {}),
    ...(open[1] ? { next: { id: open[1].key, title: open[1].title, waitsFor: [] } } : {}),
  };
}

/** Everything that needs the user in one workspace. A source that cannot be read adds nothing. */
export async function workspaceNeeds(workspaceId: string, workspacePath: string, now = Date.now()): Promise<WorkspaceNeeds> {
  const [read, checks, changes, request] = await Promise.all([
    readPlanFile(workspacePath).catch(() => null),
    readPlanChecks(workspacePath).catch(() => ({})),
    readPlanChanges(workspacePath, 300).catch(() => []),
    latestInputRequest(workspacePath, now).catch(() => null),
  ]);
  const needs: WorkspaceNeeds = {
    workspaceId,
    ...(read && read.source !== 'none' ? fromPlan(read.plan, checks, changes, now) : { questions: [], proposals: [], failedChecks: [], closedByAi: [] }),
  };
  // The AI puts its chat question in the plan too; then it is listed once, as the plan's decision it waits on.
  const asked = request ? needs.questions.find((question) => question.title === questionTitle(request.message)) : undefined;
  if (asked) asked.waiting = true;
  else if (request) {
    needs.chatQuestion = { message: request.message, timestamp: request.timestamp, harness: request.harness, ...(request.options ? { options: request.options } : {}) };
  }
  return needs;
}

/** Whether anything in a workspace waits for the user: an answer, or a failed check. */
export function needsAnything(needs: WorkspaceNeeds): boolean {
  return Boolean(needs.chatQuestion) || needs.questions.length > 0 || needs.proposals.length > 0 || needs.failedChecks.length > 0;
}
