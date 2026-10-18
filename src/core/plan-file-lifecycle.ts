/**
 * @module core/plan-file-lifecycle
 * The workspace lifecycle (the milestone list the strip above the chat, the brief and the checks still read) as a
 * view over PLAN.md's checkpoints, and its actions carried out on the file: finishing a checkpoint runs its check
 * and ticks it, reopening unticks it with what is wrong as a step under it.
 */

import { PlanFileError, addToPlan, setDone, type PlanFile } from './plan-file.js';
import { changePlanFile, readPlanChecks, readPlanFile, runPlanCheck } from './plan-file-store.js';
import type { LifecycleStep, PlanEvidence, WorkspaceLifecycle } from '../types.js';

/**
 * The checkpoints as lifecycle steps, in order. The first one still open is current; the next open one is next.
 * Ticked is completed; the current one is in progress, and verified once its check passed.
 */
export function lifecycleFromPlanFile(
  plan: PlanFile,
  checks: Record<string, PlanEvidence>,
  base: { workspaceId: string; flowType: WorkspaceLifecycle['flowType'] },
): WorkspaceLifecycle {
  const open = plan.checkpoints.filter((checkpoint) => !checkpoint.done);
  const steps = plan.checkpoints.map((checkpoint): LifecycleStep => {
    const evidence = checks[checkpoint.key];
    const working = checkpoint === open[0] || (!checkpoint.done && checkpoint.steps.some((step) => step.done));
    const status: LifecycleStep['status'] = checkpoint.done ? 'completed' : working ? (evidence?.canProgress ? 'verified' : 'in_progress') : 'pending';
    return {
      id: checkpoint.key, title: checkpoint.title, status,
      ...(checkpoint.detail ? { description: checkpoint.detail } : {}),
      ...(checkpoint.check !== undefined ? { requiresVerification: true } : {}),
      ...(checkpoint.check ? { verificationCommand: checkpoint.check } : {}),
      ...(evidence?.lastVerificationSha ? { lastVerificationSha: evidence.lastVerificationSha } : {}),
      ...(evidence?.lastVerificationStatus ? { lastVerificationStatus: evidence.lastVerificationStatus } : {}),
    };
  });
  return {
    workspaceId: base.workspaceId, flowType: base.flowType, steps, updatedAt: new Date(0).toISOString(),
    ...(open[0] ? { currentStepId: open[0].key } : {}),
    ...(open[1] ? { nextStepId: open[1].key } : {}),
  };
}

/** The plan file, when the workspace has one; null while it still has an older plan or none. */
export async function planFileIfAny(workspacePath: string): Promise<{ plan: PlanFile; checks: Record<string, PlanEvidence> } | null> {
  const read = await readPlanFile(workspacePath);
  return read.source === 'file' ? { plan: read.plan, checks: await readPlanChecks(workspacePath) } : null;
}

function checkpointOf(plan: PlanFile, key: string) {
  const checkpoint = plan.checkpoints.find((candidate) => candidate.key === key);
  if (!checkpoint) throw new PlanFileError(`There is no checkpoint "${key}" in PLAN.md any more. Read the plan again.`, 'not_found');
  return checkpoint;
}

/**
 * Starts, checks or finishes a checkpoint. Starting changes nothing in the file: anyone works on any step. Finishing
 * runs the checkpoint's check first, and ticks it only when it passes.
 */
export async function advanceCheckpoint(workspacePath: string, plan: PlanFile, key: string, action: 'start' | 'verify' | 'complete', by: string): Promise<void> {
  const checkpoint = checkpointOf(plan, key);
  if (action === 'start') return;
  if (action === 'verify' || checkpoint.check !== undefined) {
    const evidence = await runPlanCheck(workspacePath, key);
    if (action === 'verify') return;
    if (!evidence.canProgress) throw new Error(`Verification did not permit progress for step "${key}" (${evidence.lastVerificationStatus}).`);
  }
  await changePlanFile(workspacePath, (text) => setDone(text, key, true, checkpoint.title), { by });
}

/** Unticks a finished checkpoint, with what is wrong as a step under it, where the AI reads it. */
export async function reopenCheckpoint(workspacePath: string, plan: PlanFile, key: string, reason: string, by: string): Promise<void> {
  const checkpoint = checkpointOf(plan, key);
  if (!checkpoint.done) throw new PlanFileError(`"${checkpoint.title}" is not finished, so there is nothing to reopen.`, 'invalid');
  await changePlanFile(workspacePath, (text) => addToPlan(setDone(text, key, false, checkpoint.title), { step: `Reopened: ${reason}` }, { checkpoint: key }).text, { by });
}
