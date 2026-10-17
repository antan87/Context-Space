/**
 * @module core/plan-file-app
 * The plan as the app shows it, and the changes the user makes there. The app shows PLAN.md's free text as written
 * and its checkpoints, steps and decisions as things to tick and answer, with each checkpoint's proof and what
 * changed lately. Every change re-reads the file and touches only its own lines (core/plan-file-store).
 */

import { PLAN_FILE, PlanFileError, addToPlan, answerDecision, openDecisions, planText, setDone, type NewDecision, type PlanDecision } from './plan-file.js';
import { changePlanFile, readPlanChanges, readPlanChecks, readPlanFile, runPlanCheck, type PlanFileRead } from './plan-file-store.js';
import type { PlanEvidence } from '../types.js';

const decisionView = (decision: PlanDecision) => ({
  key: decision.key, question: decision.question, done: decision.done,
  ...(decision.answer ? { answer: decision.answer } : {}),
  suggested: decision.suggested,
  ...(decision.ifNoAnswer ? { ifNoAnswer: decision.ifNoAnswer } : {}),
  ...(decision.detail ? { detail: decision.detail } : {}),
  ...(decision.checkpoint ? { checkpoint: decision.checkpoint } : {}),
});

function view(read: PlanFileRead, checks: Record<string, PlanEvidence>, changes: Awaited<ReturnType<typeof readPlanChanges>>) {
  const { plan } = read;
  const free = planText(read.text);
  return {
    file: PLAN_FILE,
    source: read.source,
    title: plan.title,
    intro: free.intro,
    /** Sections of free text after the plan's own lists, as written. */
    sections: free.sections,
    checkpoints: plan.checkpoints.map((checkpoint) => ({
      key: checkpoint.key, title: checkpoint.title, done: checkpoint.done,
      /** The command that proves it; `null` for the workspace's own checks; missing without a check. */
      ...(checkpoint.check !== undefined ? { check: checkpoint.check } : {}),
      ...(checks[checkpoint.key] ? { proof: checks[checkpoint.key] } : {}),
      ...(checkpoint.outcome ? { outcome: checkpoint.outcome } : {}),
      ...(checkpoint.detail ? { detail: checkpoint.detail } : {}),
      steps: checkpoint.steps.map((step) => ({ key: step.key, text: step.text, done: step.done })),
      decisions: checkpoint.decisions.map(decisionView),
    })),
    steps: plan.steps.map((step) => ({ key: step.key, text: step.text, done: step.done })),
    decisions: plan.decisions.map(decisionView),
    /** The decisions that wait for the user's answer. */
    waiting: openDecisions(plan).map((decision) => decision.key),
    changes,
  };
}

/** Everything the Plan tab shows. */
export async function planFileForApp(workspacePath: string) {
  const read = await readPlanFile(workspacePath);
  return view(read, await readPlanChecks(workspacePath), await readPlanChanges(workspacePath, 15));
}

export type PlanFileForApp = Awaited<ReturnType<typeof planFileForApp>>;

/** A change the user makes in the app. `expected` is the item's words as the app showed them. */
export type PlanFileAppChange =
  | { type: 'tick'; key: string; done: boolean; expected: string }
  | { type: 'answer'; key: string; answer: string; expected: string }
  | { type: 'add'; step: string; checkpoint?: string }
  | { type: 'decide'; decision: NewDecision; checkpoint?: string }
  | { type: 'check'; key: string };

/**
 * Applies one change as the user and returns a sentence saying what happened. Ticking a checkpoint with a check runs
 * the check first: it is ticked only when the check passes.
 */
export async function changePlanFileForApp(workspacePath: string, change: PlanFileAppChange): Promise<{ message: string }> {
  const by = 'user';
  switch (change.type) {
    case 'tick': {
      const { plan } = await readPlanFile(workspacePath);
      const checkpoint = plan.checkpoints.find((candidate) => candidate.key === change.key);
      if (change.done && checkpoint?.check !== undefined) {
        const evidence = await runPlanCheck(workspacePath, change.key);
        if (!evidence.canProgress) {
          throw new PlanFileError(`"${checkpoint!.title}" stays open: its check ${evidence.lastVerificationStatus === 'timeout' ? 'took too long' : 'failed'}. Fix what fails, then tick it again.`, 'invalid');
        }
      }
      await changePlanFile(workspacePath, (text) => setDone(text, change.key, change.done, change.expected), { by });
      return { message: `${change.done ? 'Ticked' : 'Unticked'} "${change.expected}".` };
    }
    case 'answer':
      await changePlanFile(workspacePath, (text) => answerDecision(text, change.key, change.answer, change.expected), { by });
      return { message: `Answered "${change.expected}".` };
    case 'add':
      await changePlanFile(workspacePath, (text) => addToPlan(text, { step: change.step }, { checkpoint: change.checkpoint }).text, { by });
      return { message: `Added "${change.step.trim()}".` };
    case 'decide':
      await changePlanFile(workspacePath, (text) => addToPlan(text, { decision: change.decision }, { checkpoint: change.checkpoint }).text, { by });
      return { message: `Added the decision "${change.decision.question.trim()}".` };
    case 'check': {
      const evidence = await runPlanCheck(workspacePath, change.key);
      return { message: evidence.canProgress ? 'The check passed.' : `The check ${evidence.lastVerificationStatus === 'timeout' ? 'took too long' : 'failed'}.` };
    }
  }
}
