/**
 * @module core/lifecycle
 * Active lifecycle state machine and multi-branch fleet radar for ContextSpace.
 *
 * The lifecycle is a view over the plan store (`core/plan`): its steps are the plan's milestones,
 * and every change goes through the plan's rules. Check results stay machine-local in the state
 * file. Manages dependency gating, non-destructive origin branch fleet tracking, and test gates.
 */

import { z } from 'zod';
import { loadWorkGuidance, lockWorkGuidance } from './work-guidance.js';
import { isUnusedLegacyPlan } from './legacy-lifecycle.js';
import { execa } from 'execa';
import type {
  BranchFleetMember,
  LifecycleStep,
  PlanEvidence,
  WorkspaceLifecycle,
  WorkspaceState,
} from '../types.js';
import {
  PLAN_HISTORY_LIMIT,
  PlanError,
  changePlan,
  emptyPlan,
  mutatePlan,
  readPlanIfExists,
  readPlan,
  unsettledWaits,
  type PlanActor,
  type PlanDocument,
  type PlanItem,
} from './plan.js';
import { itemLabel } from './plan-words.js';
import { loadFeatureConfig, resolveRepoInfos } from './workspace.js';
import { resolveFeatureRepoPath } from '../utils/feature.js';
import { getRepoBranch, getAheadBehind } from '../utils/multi-git.js';
import { loadWorkspaceState, mutateWorkspaceState } from './workspace-state.js';
import { verifyWorkspace } from './verify.js';

/**
 * Non-destructively inspects local and remote tracking branches for repositories in the workspace.
 */
export async function getBranchFleet(workspacePath: string): Promise<BranchFleetMember[]> {
  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) return [];

  const resolvedPaths = feature.repos.map((r) => resolveFeatureRepoPath(feature, workspacePath, r));
  const repoInfos = await resolveRepoInfos(resolvedPaths);
  const fleet: BranchFleetMember[] = [];

  for (const repo of repoInfos) {
    const currentBranch = await getRepoBranch(repo.path);
    const aheadBehind = await getAheadBehind(repo.path, currentBranch ?? repo.defaultBranch);

    let currentSha = 'unknown';
    let currentMessage = '';
    let currentAuthor = '';
    let currentDate = '';

    try {
      const { stdout } = await execa(
        'git',
        ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%cI'],
        { cwd: repo.path },
      );
      const [sha, msg, author, date] = stdout.trim().split('\x1f');
      currentSha = sha ?? 'unknown';
      currentMessage = msg ?? '';
      currentAuthor = author ?? '';
      currentDate = date ?? '';
    } catch {
      // Ignore
    }

    // 1. Add current active branch
    fleet.push({
      branch: currentBranch ?? 'detached',
      repoName: repo.name,
      isCurrent: true,
      headSha: currentSha,
      ahead: aheadBehind.ahead ?? 0,
      behind: aheadBehind.behind ?? 0,
      lastCommitMessage: currentMessage,
      lastCommitAuthor: currentAuthor,
      lastCommitDate: currentDate,
      remoteTracked: aheadBehind.ahead !== null,
    });

    // 2. Inspect origin remote tracking branches (non-destructive)
    try {
      const { stdout: refOut } = await execa(
        'git',
        [
          'for-each-ref',
          '--sort=-committerdate',
          '--count=100',
          '--format=%(refname:short)\x1f%(objectname:short)\x1f%(subject)\x1f%(authorname)\x1f%(committerdate:iso-strict)\x1f%(symref)',
          'refs/remotes/origin/',
        ],
        { cwd: repo.path },
      );

      const lines = refOut.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const [refShort, sha, subject, author, relDate, symref] = line.split('\x1f');
        if (!refShort) continue;
        const branchName = refShort.replace(/^origin\//, '');
        if (/^(?:renovate|dependabot)\//i.test(branchName)) continue;
        if (fleet.filter((member) => member.repoName === repo.name && !member.isCurrent).length >= 6) break;
        if (symref || refShort === 'origin' || refShort === 'origin/HEAD' || branchName === 'HEAD' || branchName === currentBranch) continue;

        fleet.push({
          branch: refShort,
          repoName: repo.name,
          isCurrent: false,
          headSha: sha,
          ahead: 0,
          behind: 0,
          lastCommitMessage: subject,
          lastCommitAuthor: author,
          lastCommitDate: relDate,
          remoteTracked: true,
        });
      }
    } catch {
      // Ignore remote queries if remote not reachable
    }
  }

  return fleet;
}

/**
 * The milestones of a lifecycle saved before the plan store, as plan items. Their codes stay the
 * same, so assignments, documents and links that name a milestone keep working.
 */
export function planFromLifecycle(lifecycle: WorkspaceLifecycle, now = new Date().toISOString()): PlanDocument {
  const plan = emptyPlan();
  plan.revision = lifecycle.revision ?? 0;
  plan.updatedAt = now;
  const ids = new Set(lifecycle.steps.map((step) => step.id));
  for (const step of lifecycle.steps) {
    // A block with a reason, or with a condition to wait for, stays a block. A bare block only meant
    // "waits for its dependencies", which waitsFor now says.
    const blockedOn = step.blockedReason ?? (step.unblockCondition ? `Waiting until ${step.unblockCondition}` : undefined);
    const status: PlanItem['status'] = step.status === 'completed' ? 'done'
      : step.status === 'in_progress' || step.status === 'verified' ? 'in_progress'
        : step.status === 'blocked' && blockedOn ? 'blocked' : 'todo';
    const item: PlanItem = {
      id: step.id,
      kind: 'milestone',
      title: step.title.trim().slice(0, 200) || step.id,
      status,
      waitsFor: [...new Set(step.dependsOn ?? [])].filter((id) => ids.has(id) && id !== step.id),
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, by: 'contextspace', action: 'imported', note: 'Moved from the milestone plan' }],
    };
    if (step.description) item.detail = step.description.slice(0, 4000);
    if (step.owner) item.owner = step.owner;
    const links = { repo: step.repo, branch: step.branch, workItem: step.workItem };
    if (links.repo || links.branch || links.workItem) {
      item.links = Object.fromEntries(Object.entries(links).filter(([, value]) => value)) as PlanItem['links'];
    }
    if (step.unblockCondition) item.unblockCondition = step.unblockCondition;
    if (step.requiresVerification !== undefined || step.verificationCommand || step.verificationTimeoutSeconds) {
      item.gate = { required: Boolean(step.requiresVerification) };
      if (step.verificationCommand) item.gate.command = step.verificationCommand;
      if (step.verificationTimeoutSeconds) item.gate.timeoutSeconds = step.verificationTimeoutSeconds;
    }
    if (status === 'done') {
      item.resolution = step.lastVerificationSha ? `Passed its check on ${step.lastVerificationSha}` : 'Completed before the plan moved to its own file';
      if (step.completedAt) item.closedAt = step.completedAt;
    }
    if (status === 'blocked') {
      item.blockedReason = blockedOn;
      item.blockedAt = step.blockedAt ?? now;
    }
    if (step.reopenCount) item.reopenCount = step.reopenCount;
    if (step.reopenedAt) item.reopenedAt = step.reopenedAt;
    if (step.reopenReason) item.reopenReason = step.reopenReason;
    if (step.reopenedBy) item.reopenedBy = step.reopenedBy;
    plan.items.push(item);
  }
  return plan;
}

function evidenceFromStep(step: LifecycleStep | undefined): PlanEvidence | undefined {
  if (!step || (!step.lastVerificationSha && !step.lastVerificationStatus && step.status !== 'verified')) return undefined;
  return {
    ...(step.lastVerificationSha ? { lastVerificationSha: step.lastVerificationSha } : {}),
    ...(step.lastVerificationStatus ? { lastVerificationStatus: step.lastVerificationStatus } : {}),
    // A verified or completed step got there by passing its check.
    canProgress: step.status === 'verified' || step.status === 'completed',
    at: step.completedAt ?? new Date(0).toISOString(),
  };
}

/**
 * Moves a lifecycle saved in the state file into the plan store, once. The plan is written first;
 * until the state is cleaned up, the view reads check results from either place, so a crash in
 * between loses nothing. A second caller finds the store and leaves it alone.
 */
async function moveLifecycleToPlan(workspacePath: string): Promise<PlanDocument> {
  const state = await loadWorkspaceState(workspacePath, { strict: true });
  const legacy = state.lifecycle;
  if (!legacy?.steps.length || legacy.movedToPlanAt) return readPlan(workspacePath);
  const { plan } = await mutatePlan(workspacePath, (current, { exists }) => {
    if (exists) return;
    const imported = planFromLifecycle(legacy);
    current.revision = imported.revision;
    current.items = imported.items;
  }, { keepRevision: true });
  await mutateWorkspaceState(workspacePath, (current) => {
    const lifecycle = current.lifecycle;
    if (!lifecycle || lifecycle.movedToPlanAt) return;
    const evidence: Record<string, PlanEvidence> = {};
    for (const step of lifecycle.steps) {
      const found = evidenceFromStep(step);
      if (found) evidence[step.id] = found;
    }
    current.planEvidence = { ...evidence, ...current.planEvidence };
    lifecycle.steps = [];
    lifecycle.currentStepId = undefined;
    lifecycle.movedToPlanAt = new Date().toISOString();
  });
  return plan;
}

/**
 * The plan, after moving an older lifecycle into it if needed. An untouched template plan from an
 * older release is dropped instead, unless the brief or a document still names one of its steps.
 * Everything that changes the plan calls this first, so milestones saved by an older release are
 * never missing from it.
 */
export async function ensurePlanStore(workspacePath: string): Promise<PlanDocument> {
  const stored = await readPlanIfExists(workspacePath);
  if (stored) return stored;
  const legacy = (await loadWorkspaceState(workspacePath)).lifecycle;
  if (!legacy?.steps.length || legacy.movedToPlanAt) return emptyPlan();
  if (isUnusedLegacyPlan(legacy)) {
    const release = await lockWorkGuidance(workspacePath);
    try {
      const guidance = await loadWorkGuidance(workspacePath);
      const referenced = Boolean(guidance.assignment.milestoneId || guidance.documents.some((doc) => doc.scope.milestoneId));
      if (!referenced) {
        await mutateWorkspaceState(workspacePath, (current) => {
          if (current.lifecycle && isUnusedLegacyPlan(current.lifecycle)) {
            current.lifecycle.steps = [];
            current.lifecycle.currentStepId = undefined;
            current.lifecycle.movedToPlanAt = new Date().toISOString();
            current.lifecycle.updatedAt = new Date().toISOString();
          }
        });
        return readPlan(workspacePath);
      }
    } finally { await release(); }
  }
  return moveLifecycleToPlan(workspacePath);
}

/**
 * The plan as a read-only consumer sees it: an older lifecycle that has not been moved yet is shown
 * as it will be moved, and nothing is written.
 */
async function readPlanForView(workspacePath: string, state: WorkspaceState): Promise<PlanDocument> {
  const stored = await readPlanIfExists(workspacePath);
  if (stored) return stored;
  const legacy = state.lifecycle;
  if (!legacy?.steps.length || legacy.movedToPlanAt) return emptyPlan();
  if (isUnusedLegacyPlan(legacy)) {
    // Obsolete template steps are only kept when the brief or a document still names one.
    const guidance = await loadWorkGuidance(workspacePath).catch(() => null);
    if (!guidance?.assignment.milestoneId && !guidance?.documents.some((doc) => doc.scope.milestoneId)) return emptyPlan();
  }
  return planFromLifecycle(legacy, legacy.updatedAt || new Date(0).toISOString());
}

function detectFlowType(feature: Awaited<ReturnType<typeof loadFeatureConfig>>): WorkspaceLifecycle['flowType'] {
  if (feature?.flowType) return feature.flowType;
  if (feature?.branchName.startsWith('fix/') || feature?.branchName.startsWith('quick/')) return 'quick';
  if ((feature?.repos.length ?? 0) > 2 || feature?.branchName.startsWith('epic/') || feature?.branchName.startsWith('flow/')) return 'epic';
  return 'feature';
}

/** The milestones shown as lifecycle steps: dropped and parked ones are not part of the active flow. */
function shownInLifecycle(item: PlanItem): boolean {
  return item.kind === 'milestone' && item.status !== 'dropped' && item.status !== 'later';
}

function stepFromItem(plan: PlanDocument, item: PlanItem, evidence: PlanEvidence | undefined): LifecycleStep {
  const status: LifecycleStep['status'] = item.status === 'done' ? 'completed'
    : item.status === 'blocked' ? 'blocked'
      : item.status === 'in_progress' ? (evidence?.canProgress ? 'verified' : 'in_progress')
        : 'pending';
  const step: LifecycleStep = { id: item.id, title: item.title, status };
  if (item.detail) step.description = item.detail;
  if (item.owner) step.owner = item.owner;
  if (item.links?.branch) step.branch = item.links.branch;
  if (item.links?.repo) step.repo = item.links.repo;
  if (item.links?.workItem) step.workItem = item.links.workItem;
  if (item.unblockCondition) step.unblockCondition = item.unblockCondition;
  // What it waits for, except work that was dropped: that no longer holds anything up.
  const dependsOn = item.waitsFor.filter((id) => plan.items.find((candidate) => candidate.id === id)?.status !== 'dropped');
  if (dependsOn.length) step.dependsOn = dependsOn;
  if (item.gate?.required) step.requiresVerification = true;
  else if (item.gate && !item.gate.command && !item.gate.timeoutSeconds) step.requiresVerification = false;
  if (item.gate?.command) step.verificationCommand = item.gate.command;
  if (item.gate?.timeoutSeconds) step.verificationTimeoutSeconds = item.gate.timeoutSeconds;
  if (evidence?.lastVerificationSha) step.lastVerificationSha = evidence.lastVerificationSha;
  if (evidence?.lastVerificationStatus) step.lastVerificationStatus = evidence.lastVerificationStatus;
  if (item.status === 'done' && item.closedAt) step.completedAt = item.closedAt;
  if (item.reopenedAt) step.reopenedAt = item.reopenedAt;
  if (item.reopenReason) step.reopenReason = item.reopenReason;
  if (item.reopenedBy) step.reopenedBy = item.reopenedBy;
  if (item.reopenCount) step.reopenCount = item.reopenCount;
  if (item.status === 'blocked' && item.blockedReason) step.blockedReason = item.blockedReason;
  if (item.status === 'blocked' && item.blockedAt) step.blockedAt = item.blockedAt;
  return step;
}

/** The lifecycle as a view over the plan store plus this machine's check results. */
export function lifecycleView(
  plan: PlanDocument,
  state: WorkspaceState,
  base: { workspaceId: string; flowType: WorkspaceLifecycle['flowType'] },
): WorkspaceLifecycle {
  const legacy = new Map((state.lifecycle?.steps ?? []).map((step) => [step.id, step]));
  const steps = plan.items.filter(shownInLifecycle)
    .map((item) => stepFromItem(plan, item, state.planEvidence?.[item.id] ?? evidenceFromStep(legacy.get(item.id))));
  const lifecycle: WorkspaceLifecycle = {
    workspaceId: base.workspaceId,
    flowType: base.flowType,
    steps,
    updatedAt: plan.updatedAt,
    revision: plan.revision,
  };
  // Nothing starts by itself, so the current step is simply the one being worked on, if any.
  const current = steps.find((step) => step.status === 'in_progress' || step.status === 'verified');
  if (current) lifecycle.currentStepId = current.id;
  return lifecycle;
}

async function loadView(workspacePath: string, options: { write: boolean }): Promise<{ plan: PlanDocument; lifecycle: WorkspaceLifecycle }> {
  const plan = options.write ? await ensurePlanStore(workspacePath) : undefined;
  let state = await loadWorkspaceState(workspacePath);
  const feature = await loadFeatureConfig(workspacePath);
  if (options.write && !state.lifecycle) {
    // The flow type is recorded once, as before, so later readers agree on it.
    const created: WorkspaceLifecycle = {
      workspaceId: feature?.id ?? 'workspace', flowType: detectFlowType(feature), steps: [],
      updatedAt: new Date().toISOString(), movedToPlanAt: new Date().toISOString(),
    };
    await mutateWorkspaceState(workspacePath, (current) => { current.lifecycle ??= created; });
    state = await loadWorkspaceState(workspacePath);
  }
  const resolvedPlan = plan ?? await readPlanForView(workspacePath, state);
  const flowType = feature?.flowType ?? state.lifecycle?.flowType ?? detectFlowType(feature);
  return { plan: resolvedPlan, lifecycle: lifecycleView(resolvedPlan, state, { workspaceId: feature?.id ?? state.lifecycle?.workspaceId ?? 'workspace', flowType }) };
}

/**
 * Loads the workspace lifecycle: a view over the plan store. A lifecycle saved by an older release
 * is moved into the store on first load.
 */
export async function loadWorkspaceLifecycle(
  workspacePath: string,
  options: { includeFleet?: boolean } = {},
): Promise<WorkspaceLifecycle> {
  const includeFleet = options.includeFleet ?? true;
  const { lifecycle } = await loadView(workspacePath, { write: true });
  // Refresh the branch fleet. It can query remotes, so a caller that polls skips it.
  if (includeFleet) {
    try {
      lifecycle.fleet = await getBranchFleet(workspacePath);
    } catch {
      // Best-effort
    }
  }
  return lifecycle;
}

/** The lifecycle for read-only consumers: never writes, even to move an older lifecycle. */
export async function readWorkspaceLifecycle(workspacePath: string): Promise<WorkspaceLifecycle> {
  return (await loadView(workspacePath, { write: false })).lifecycle;
}

async function recordEvidence(workspacePath: string, stepId: string, evidence: PlanEvidence | null): Promise<void> {
  await mutateWorkspaceState(workspacePath, (state) => {
    if (evidence) {
      state.planEvidence = { ...state.planEvidence, [stepId]: evidence };
    } else if (state.planEvidence) {
      delete state.planEvidence[stepId];
    }
    // A copy left in an older lifecycle record must not come back.
    const legacy = state.lifecycle?.steps.find((step) => step.id === stepId);
    if (legacy) {
      delete legacy.lastVerificationSha;
      delete legacy.lastVerificationStatus;
    }
  });
}

function stepChanged(stepId: string): Error {
  return new Error(`Step "${stepId}" changed during this operation. Reload the flow and retry.`);
}

/**
 * Advances or transitions a step in the workspace lifecycle. Finishing a milestone does not start
 * the next one: the plan suggests what is ready, and a person or an AI starts it.
 */
export async function advanceLifecycleStep(
  workspacePath: string,
  stepId: string,
  action: 'start' | 'verify' | 'complete',
  actor: PlanActor = { by: 'user' },
): Promise<WorkspaceLifecycle> {
  const { plan, lifecycle } = await loadView(workspacePath, { write: true });
  const step = lifecycle.steps.find((s) => s.id === stepId);
  const item = plan.items.find((candidate) => candidate.id === stepId);

  if (!step || !item) {
    throw new Error(`Step "${stepId}" not found in workspace lifecycle.`);
  }
  if (!['start', 'verify', 'complete'].includes(action)) {
    throw new Error(`Unknown lifecycle action "${action}".`);
  }
  if (unsettledWaits(plan, item).length) {
    throw new Error(`Complete dependencies before advancing step "${stepId}".`);
  }
  if (step.status === 'completed') {
    throw new Error(`Step "${stepId}" is already completed.`);
  }
  if (action !== 'start' && step.status !== 'in_progress' && step.status !== 'verified') {
    throw new Error(`Start step "${stepId}" before ${action}.`);
  }

  // Recognize gates in lifecycles saved before requiresVerification existed.
  const requiresVerification = Boolean(item.gate?.required) || Boolean(item.gate?.command) || Boolean(step.lastVerificationStatus) ||
    ['verify_and_ship', 'step_verification', 'epic_slice_4'].includes(step.id);
  const timeoutSeconds = item.gate?.timeoutSeconds ?? DEFAULT_GATE_TIMEOUT_SECONDS;
  let gateFailed = false;
  let checkedSha: string | undefined;
  let checkStatus: PlanEvidence['lastVerificationStatus'];
  if (action === 'verify' || (action === 'complete' && requiresVerification)) {
    const report = await verifyWorkspace(workspacePath, { command: item.gate?.command, timeoutMs: timeoutSeconds * 1000 });
    checkedSha = report.repos[0]?.headSha;
    checkStatus = report.overallStatus;
    gateFailed = !report.canProgress;
    // A result for a milestone that moved on meanwhile describes nothing.
    const now = (await readPlan(workspacePath)).items.find((candidate) => candidate.id === stepId);
    if (!now || now.updatedAt !== item.updatedAt) throw stepChanged(stepId);
    await recordEvidence(workspacePath, stepId, {
      ...(checkedSha ? { lastVerificationSha: checkedSha } : {}),
      lastVerificationStatus: checkStatus,
      canProgress: report.canProgress,
      at: new Date().toISOString(),
    });
  }

  try {
    if (action === 'start') {
      await changePlan(workspacePath, { type: 'start', id: stepId }, { actor, ifItemUpdatedAt: item.updatedAt });
    } else if (action === 'complete' && !gateFailed) {
      const resolution = requiresVerification ? `Passed its check on ${checkedSha ?? 'the latest code'}` : 'Marked done';
      await changePlan(workspacePath, { type: 'done', id: stepId, resolution, checkPassed: true }, { actor, ifItemUpdatedAt: item.updatedAt });
    }
  } catch (error) {
    if (error instanceof PlanError && error.code === 'conflict') throw stepChanged(stepId);
    if (error instanceof PlanError && error.code === 'waiting') throw new Error(`Dependencies changed for step "${stepId}". Reload the flow and retry.`);
    throw error;
  }
  if (gateFailed && action === 'complete') {
    const hint = checkStatus === 'timeout'
      ? ` The gate stopped after ${Math.round(timeoutSeconds / 60)} minutes; raise this milestone's verification time limit (verificationTimeoutSeconds) if the command needs longer.`
      : '';
    throw new Error(`Verification did not permit progress for step "${stepId}" (${checkStatus}).${hint}`);
  }

  return loadWorkspaceLifecycle(workspacePath, { includeFleet: false });
}

/** A reopen request that cannot be carried out, with a code the server maps to an HTTP status. */
export class LifecycleStepError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'not_reopenable' | 'not_blockable' | 'conflict') {
    super(message);
    this.name = 'LifecycleStepError';
  }
}

/** Longest reason kept with a reopened milestone. */
export const REOPEN_REASON_MAX_LENGTH = 500;

/**
 * A reason typed by a person or an agent, made safe to store and to print in the plan: control characters
 * (which could reshape a terminal or a toast) are removed and whitespace is collapsed (so a reason cannot
 * break the milestone plan's list formatting) before the length check.
 */
function reasonText(emptyMessage: string) {
  return z.string()
    // eslint-disable-next-line no-control-regex
    .transform((value) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, emptyMessage).max(REOPEN_REASON_MAX_LENGTH, `Keep the reason to ${REOPEN_REASON_MAX_LENGTH} characters or fewer.`));
}

const reopenSchema = z.object({
  reason: reasonText('Say why the milestone is being reopened.'),
  by: z.enum(['user', 'agent']),
});
const blockSchema = z.object({ reason: reasonText('Say what the milestone is blocked on.') });

/**
 * Sends a finished milestone back for rework and records why. Work loops back,
 * so this is a first-class, checkable fact on the step (when, why, by whom, how
 * many times) and not a silent status flip. Only a completed or verified
 * milestone can be reopened. The earlier completion and its verification proof
 * no longer describe the work, so both are cleared. From the AI side this is a
 * proposal: the user decides.
 */
export async function reopenLifecycleStep(
  workspacePath: string,
  stepId: string,
  input: { reason: string; by: 'user' | 'agent' },
): Promise<WorkspaceLifecycle> {
  const { reason, by } = reopenSchema.parse(input);
  const { plan, lifecycle } = await loadView(workspacePath, { write: true });
  const step = lifecycle.steps.find((candidate) => candidate.id === stepId);
  const item = plan.items.find((candidate) => candidate.id === stepId);
  if (!step || !item) throw new LifecycleStepError(`Step "${stepId}" not found in workspace lifecycle.`, 'not_found');
  if (step.status !== 'completed' && step.status !== 'verified') {
    throw new LifecycleStepError(`Step "${stepId}" is ${step.status.replace('_', ' ')}, so there is nothing to reopen. Only a finished milestone can be reopened.`, 'not_reopenable');
  }
  let outcome: 'applied' | 'proposed';
  try {
    ({ outcome } = await changePlan(workspacePath, { type: 'reopen', id: stepId, reason },
      { actor: by === 'user' ? { by: 'user' } : { by: 'agent' }, ifItemUpdatedAt: item.updatedAt }));
  } catch (error) {
    // Another session may have changed or reopened it while this call was waiting.
    if (error instanceof PlanError && error.code === 'conflict') {
      throw new LifecycleStepError(`Step "${stepId}" changed during this operation. Reload the flow and retry.`, 'conflict');
    }
    throw error;
  }
  if (outcome === 'applied') await recordEvidence(workspacePath, stepId, null);
  return loadWorkspaceLifecycle(workspacePath, { includeFleet: false });
}

/**
 * Marks a milestone as blocked on something outside the work itself, with the reason. Anyone may say so,
 * including the AI: it only changes what is shown, never what is finished. Finished work cannot be blocked.
 * Starting the milestone again ends the block.
 */
export async function blockLifecycleStep(
  workspacePath: string,
  stepId: string,
  input: { reason: string },
  actor: PlanActor = { by: 'user' },
): Promise<WorkspaceLifecycle> {
  const { reason } = blockSchema.parse(input);
  const { plan, lifecycle } = await loadView(workspacePath, { write: true });
  const step = lifecycle.steps.find((candidate) => candidate.id === stepId);
  const item = plan.items.find((candidate) => candidate.id === stepId);
  if (!step || !item) throw new LifecycleStepError(`Step "${stepId}" not found in workspace lifecycle.`, 'not_found');
  if (step.status === 'completed') {
    throw new LifecycleStepError(`Step "${stepId}" is already completed, so it cannot be blocked.`, 'not_blockable');
  }
  try {
    await changePlan(workspacePath, { type: 'block', id: stepId, reason }, { actor, ifItemUpdatedAt: item.updatedAt });
  } catch (error) {
    if (error instanceof PlanError && error.code === 'conflict') {
      throw new LifecycleStepError(`Step "${stepId}" changed during this operation. Reload the flow and retry.`, 'conflict');
    }
    throw error;
  }
  return loadWorkspaceLifecycle(workspacePath, { includeFleet: false });
}

/**
 * Milestone gates run deliberately configured commands, often a full test
 * suite, a build and browser tests, so they get far longer than the ad-hoc
 * verify default. A per-milestone limit can raise or lower it.
 */
export const DEFAULT_GATE_TIMEOUT_SECONDS = 30 * 60;
export const MIN_GATE_TIMEOUT_SECONDS = 30;
export const MAX_GATE_TIMEOUT_SECONDS = 2 * 60 * 60;

const planStepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100),
  title: z.string().trim().min(1).max(200), description: z.string().max(4000).optional(),
  owner: z.string().max(200).optional(), branch: z.string().max(200).optional(),
  repo: z.string().max(200).optional(), workItem: z.string().max(2000).optional(),
  unblockCondition: z.string().max(2000).optional(),
  dependsOn: z.array(z.string()).max(100).optional(),
  requiresVerification: z.boolean().optional(), verificationCommand: z.string().max(2000).optional(),
  verificationTimeoutSeconds: z.number().int().min(MIN_GATE_TIMEOUT_SECONDS).max(MAX_GATE_TIMEOUT_SECONDS).optional(),
});
export const lifecyclePlanSchema = z.object({ revision: z.number().int().nonnegative(), steps: z.array(planStepSchema).max(100) });

/**
 * Updates the milestone definitions in the plan store while retaining their progress and proofs.
 * A milestone left out is dropped, not deleted: it keeps its history and leaves the active flow.
 */
export async function updateLifecyclePlan(
  workspacePath: string,
  input: unknown,
  actor: PlanActor = { by: 'user' },
): Promise<WorkspaceLifecycle> {
  const update = lifecyclePlanSchema.parse(input);
  await ensurePlanStore(workspacePath);
  const release = await lockWorkGuidance(workspacePath);
  try {
    const guidance = await loadWorkGuidance(workspacePath);
    const gateChanged: string[] = [];
    await mutatePlan(workspacePath, (plan) => {
      if (plan.revision !== update.revision) throw new Error('The plan changed in another session. Reload before saving.');
      const now = new Date().toISOString();
      const who = actor.by === 'user' ? 'user' : (actor.harness?.trim().toLowerCase() || 'agent');
      const note = (item: PlanItem, action: string, text?: string) => {
        item.history.push({ at: now, by: who, action, ...(text ? { note: text } : {}) });
        if (item.history.length > PLAN_HISTORY_LIMIT) item.history.splice(0, item.history.length - PLAN_HISTORY_LIMIT);
        item.updatedAt = now;
      };
      const byId = new Map(update.steps.map((step) => [step.id, step]));
      if (byId.size !== update.steps.length) throw new Error('Milestone IDs must be unique.');
      for (const definition of update.steps) {
        const taken = plan.items.find((item) => item.id === definition.id && item.kind !== 'milestone');
        if (taken) throw new Error(`"${definition.id}" is already the code of ${itemLabel(taken)}. Choose another milestone ID.`);
      }
      const removed = plan.items.filter((item) => shownInLifecycle(item) && !byId.has(item.id));
      const removedIds = new Set(removed.map((item) => item.id));
      if ((guidance.assignment.milestoneId && removedIds.has(guidance.assignment.milestoneId)) ||
        guidance.documents.some((doc) => doc.scope.milestoneId && removedIds.has(doc.scope.milestoneId))) {
        throw new Error('Move the assignment and document scopes to the workspace or another milestone before removing their milestone.');
      }

      // The merged definitions: omitted optional fields retain their saved values.
      const merged = update.steps.map((definition) => {
        const existing = plan.items.find((item) => item.id === definition.id);
        const required = definition.requiresVerification ?? existing?.gate?.required;
        const command = definition.verificationCommand === '' ? undefined : definition.verificationCommand ?? existing?.gate?.command;
        const timeoutSeconds = definition.verificationTimeoutSeconds ?? existing?.gate?.timeoutSeconds;
        const visibleWaits = existing ? existing.waitsFor.filter((id) => plan.items.find((item) => item.id === id)?.status !== 'dropped') : [];
        const waitsFor = [...new Set(definition.dependsOn ?? visibleWaits)];
        return { definition, existing, required, command, timeoutSeconds, waitsFor, visibleWaits };
      });

      // Validate the dependency graph the save would produce.
      const graph = new Map(plan.items.map((item) => [item.id, item.waitsFor]));
      for (const { definition, waitsFor } of merged) graph.set(definition.id, waitsFor);
      // A milestone this save removes cannot be waited for; other items, and milestones already out of the flow, can.
      const waitable = (id: string) => byId.has(id) || (graph.has(id) && !removedIds.has(id));
      for (const { waitsFor } of merged) {
        for (const id of waitsFor) if (!waitable(id)) throw new Error(`Dependency "${id}" does not name a milestone.`);
      }
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visiting.has(id)) throw new Error('Milestone dependencies contain a cycle.');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of graph.get(id) ?? []) visit(dependency);
        visiting.delete(id); visited.add(id);
      };
      for (const { definition } of merged) visit(definition.id);

      const settled = (id: string) => {
        const status = plan.items.find((item) => item.id === id)?.status;
        return status === 'done' || status === 'dropped';
      };
      const ordered: PlanItem[] = [];
      for (const { definition, existing, required, command, timeoutSeconds, waitsFor, visibleWaits } of merged) {
        const item: PlanItem = existing ?? {
          id: definition.id, kind: 'milestone', title: definition.title, status: 'todo', waitsFor: [],
          createdAt: now, updatedAt: now, history: [],
        };
        const changedGate = Boolean(existing?.gate?.required) !== Boolean(required) || existing?.gate?.command !== command;
        const changedWaits = JSON.stringify(visibleWaits) !== JSON.stringify(waitsFor);
        if (existing?.status === 'done' && (changedGate || changedWaits)) {
          throw new Error(`Completed milestone "${existing.title}" cannot change its gate or dependencies.`);
        }
        if (existing?.status === 'in_progress' && waitsFor.some((id) => !settled(id))) {
          throw new Error(`Active milestone "${existing.title}" cannot depend on unfinished work.`);
        }
        const before = JSON.stringify(item);
        item.title = definition.title;
        const set = <K extends keyof PlanItem>(key: K, value: PlanItem[K] | undefined) => {
          if (value === undefined || value === '') delete item[key]; else item[key] = value;
        };
        set('detail', definition.description ?? existing?.detail);
        set('owner', definition.owner ?? existing?.owner);
        set('unblockCondition', definition.unblockCondition ?? existing?.unblockCondition);
        const links = {
          repo: definition.repo ?? existing?.links?.repo, branch: definition.branch ?? existing?.links?.branch,
          workItem: definition.workItem ?? existing?.links?.workItem,
        };
        set('links', links.repo || links.branch || links.workItem
          ? Object.fromEntries(Object.entries(links).filter(([, value]) => value)) as PlanItem['links'] : undefined);
        set('gate', required !== undefined || command || timeoutSeconds ? {
          required: Boolean(required), ...(command ? { command } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}),
        } : undefined);
        // Dropped work it waited for stays in its history but holds nothing up any more.
        const droppedWaits = item.waitsFor.filter((id) => plan.items.find((candidate) => candidate.id === id)?.status === 'dropped');
        item.waitsFor = [...new Set([...waitsFor, ...(definition.dependsOn ? [] : droppedWaits)])];
        if (!existing) {
          note(item, 'added');
        } else if (!shownInLifecycle(existing)) {
          // Back in the milestone plan: it is work to do again.
          item.status = 'todo';
          delete item.resolution;
          delete item.closedAt;
          delete item.revisitWhen;
          note(item, 'reopened', 'Added back to the milestone plan');
        } else if (JSON.stringify(item) !== before) {
          note(item, 'edited', 'Milestone plan changed');
        }
        if (existing && changedGate) gateChanged.push(item.id);
        ordered.push(item);
      }
      for (const item of removed) {
        item.status = 'dropped';
        item.resolution = 'Removed from the milestone plan';
        item.closedAt = now;
        delete item.proposal;
        note(item, 'dropped', 'Removed from the milestone plan');
      }
      const placed = new Set(ordered.map((item) => item.id));
      plan.items = [
        ...ordered,
        ...plan.items.filter((item) => item.kind === 'milestone' && !placed.has(item.id)),
        ...plan.items.filter((item) => item.kind !== 'milestone'),
      ];
    }, { alwaysWrite: true });
    // A changed gate makes earlier check results meaningless.
    for (const id of gateChanged) await recordEvidence(workspacePath, id, null);
    return await loadWorkspaceLifecycle(workspacePath);
  } finally { await release(); }
}


export function renderLifecyclePlan(lifecycle: WorkspaceLifecycle, live = true): string {
  if (!lifecycle.steps.length) return '';
  const lines = ['<!-- CONTEXTSPACE:MILESTONES:START -->', '## Milestone plan', '',
    live ? 'Current progress from the workspace lifecycle.' : 'Milestone definitions from the workspace lifecycle. Run `ctxspace flow` for current progress.', ''];
  for (const [index, step] of lifecycle.steps.entries()) {
    const reopened = live && Boolean(step.reopenedAt) && step.status !== 'completed';
    lines.push(`${index + 1}. **${step.title}**${live ? ` — ${reopened && step.status !== 'blocked' ? 'reopened, in progress' : step.status.replaceAll('_', ' ')}` : ''}`);
    if (live && step.status === 'blocked' && step.blockedReason) lines.push(`   Blocked: ${step.blockedReason}`);
    if (reopened) lines.push(`   Reopened${step.reopenedBy ? ` by ${step.reopenedBy === 'user' ? 'the user' : 'an agent'}` : ''}: ${step.reopenReason ?? 'no reason recorded'}`);
    if (step.description) lines.push(`   ${step.description}`);
    if (step.dependsOn?.length) lines.push(`   Depends on: ${step.dependsOn.map((id) => lifecycle.steps.find((item) => item.id === id)?.title ?? id).join(', ')}`);
    if (step.repo) lines.push(`   Repository: ${step.repo}`);
    if (step.workItem) lines.push(`   Work item / PR: ${step.workItem}`);
    if (step.unblockCondition) lines.push(`   Unblock condition: ${step.unblockCondition}`);
    if (step.branch) lines.push(`   Branch: ${step.branch}`);
    if (step.requiresVerification || step.verificationCommand) lines.push('   Requires verification before completion.');
  }
  lines.push('', '<!-- CONTEXTSPACE:MILESTONES:END -->');
  return lines.join('\n');
}
