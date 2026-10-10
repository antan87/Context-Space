/**
 * @module core/progression-policy
 * One decision for "may this workspace be finished?", shared by the CLI, the
 * GUI server and MCP so the same tested content always gets the same answer.
 *
 * Evidence is the latest verification of each editable repository, bound to
 * the content that was tested (HEAD plus a fingerprint of the working tree).
 * Missing, failed, timed-out, unreadable and stale evidence all block. So does
 * the plan's sixth rule: an open item that a milestone waits for blocks, and
 * other open items only warn. A caller may still proceed with an explicit
 * override that states a reason; the override is recorded and returned, never
 * implied by a generic "yes".
 * Checkpoint commits are not gated by this policy — only finish/release is.
 */

import type { RepoVerificationReport, VerificationOverrideRecord } from '../types.js';
import { loadFeatureConfig } from './workspace.js';
import { describeEditBoundaries } from './edit-policy.js';
import { loadWorkspaceState, mutateWorkspaceState } from './workspace-state.js';
import { captureRepositorySnapshot } from './verify.js';

/** The standing of one repository's verification evidence. */
export type EvidenceState =
  | 'passed'
  /** Passed on uncommitted content that is still exactly what was tested. */
  | 'passed-dirty'
  /** No test command was found for content that is unchanged since. */
  | 'no-tests'
  | 'missing'
  | 'failed'
  | 'timed-out'
  /** The content changed after it was verified (edits, commits, branch switch). */
  | 'stale'
  /** The current repository state could not be read. */
  | 'unreadable';

/** Evidence for one repository. */
export interface RepoEvidence {
  name: string;
  state: EvidenceState;
  ready: boolean;
  /** One sentence a person can act on. */
  detail: string;
  verifiedAt?: string;
  command?: string;
}

/** A plan item named in the decision. */
export interface PlanFinishItem {
  id: string;
  /** Code and name: "Q1 Which time zone?". */
  label: string;
  status: string;
  /** Labels of the milestones and items that wait for it. */
  heldUpBy: string[];
}

/** The policy decision for a workspace. */
export interface ProgressionDecision {
  /** True when every editable repository has fresh, acceptable evidence and nothing a milestone waits for is open. */
  ready: boolean;
  repos: RepoEvidence[];
  /** What the plan still has open: what stops finishing, and what only warns. */
  plan: { blocking: PlanFinishItem[]; open: PlanFinishItem[] };
  /** Human-readable reasons the decision is not ready; empty when ready. */
  blockers: string[];
  /** Open plan items that do not stop finishing, in words. */
  warnings: string[];
}

/** An explicit override supplied by a caller. */
export interface VerificationOverride {
  reason: string;
}

/** Shortest override reason accepted; a reason must say something. */
export const MIN_OVERRIDE_REASON_LENGTH = 8;

/** Returns an error message when an override reason is not acceptable. */
export function validateOverrideReason(reason: string | undefined): string | null {
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < MIN_OVERRIDE_REASON_LENGTH) {
    return `An override needs a reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters explaining why the workspace may be finished anyway.`;
  }
  return null;
}

async function judgeRepo(
  name: string,
  repoPath: string,
  evidence: RepoVerificationReport | undefined,
): Promise<RepoEvidence> {
  if (!evidence) {
    return { name, state: 'missing', ready: false, detail: `${name} has not been verified. Run verification first.` };
  }
  const base = { name, verifiedAt: evidence.verifiedAt, command: evidence.command };
  if (evidence.status === 'fail') {
    return { ...base, state: 'failed', ready: false, detail: `${name} failed verification${evidence.error ? `: ${evidence.error}` : ` (exit ${evidence.exitCode ?? 'unknown'})`}.` };
  }
  if (evidence.status === 'timeout') {
    return { ...base, state: 'timed-out', ready: false, detail: `${name} verification timed out before it finished.` };
  }

  let current;
  try {
    current = await captureRepositorySnapshot(repoPath);
  } catch (error) {
    return { ...base, state: 'unreadable', ready: false, detail: `${name}: cannot read the current repository state (${error instanceof Error ? error.message : String(error)}).` };
  }
  const samePath = evidence.repoPath === repoPath;
  const sameContent = evidence.contentTree
    // The tested tree, whether it was since committed unchanged or not.
    ? current.contentTree === evidence.contentTree
    : evidence.fingerprint
      ? current.headSha === evidence.headSha && current.fingerprint === evidence.fingerprint
      // Evidence recorded before fingerprints existed only proves a clean HEAD.
      : evidence.clean && current.clean && current.headSha === evidence.headSha;
  if (!samePath || !sameContent) {
    const why = !samePath
      ? `was verified at ${evidence.repoPath}, not ${repoPath}`
      : !current.clean || current.headSha === evidence.headSha
        ? 'has changes that were made after it was verified'
        : `moved from ${evidence.headSha.slice(0, 7)} to ${current.headSha.slice(0, 7)} with different content since it was verified`;
    return { ...base, state: 'stale', ready: false, detail: `${name} ${why}. Verify again.` };
  }

  if (evidence.status === 'no-tests') {
    return { ...base, state: 'no-tests', ready: true, detail: `${name} has no test command; nothing changed since that was checked.` };
  }
  if (evidence.status === 'pass_dirty' && !current.clean) {
    return { ...base, state: 'passed-dirty', ready: true, detail: `${name} passed on uncommitted changes that are still exactly what was tested.` };
  }
  if (evidence.status === 'pass_dirty') {
    return { ...base, state: 'passed', ready: true, detail: `${name} passed; the tested changes are now committed unchanged.` };
  }
  return { ...base, state: 'passed', ready: true, detail: `${name} passed on the current content.` };
}

/**
 * Evaluates whether a workspace may be finished. Read-only reference repos
 * are outside the decision: finish never changes them.
 *
 * @param workspacePath - Absolute path to the workspace directory.
 * @param options.repos - Limit the decision to these repositories.
 */
export async function evaluateProgression(
  workspacePath: string,
  options: { repos?: string[] } = {},
): Promise<ProgressionDecision> {
  const feature = await loadFeatureConfig(workspacePath);
  if (!feature) throw new Error(`Workspace configuration not found at ${workspacePath}`);
  const state = await loadWorkspaceState(workspacePath);
  const targets = describeEditBoundaries(feature, workspacePath)
    .filter((boundary) => boundary.editable)
    .filter((boundary) => !options.repos || options.repos.includes(boundary.name));

  const repos = await Promise.all(
    targets.map((target) => judgeRepo(target.name, target.path, state.repos[target.name]?.lastVerification)),
  );
  const blockers = repos.filter((repo) => !repo.ready).map((repo) => repo.detail);
  const plan = await judgePlan(workspacePath);
  blockers.push(...plan.problems);
  for (const item of plan.blocking) {
    blockers.push(`${item.heldUpBy.join(' and ')} ${item.heldUpBy.length === 1 ? 'waits' : 'wait'} for ${item.label}, which is ${item.status}. Finish, answer or drop it in the plan.`);
  }
  const warnings = plan.open.map((item) => `${item.label} is still ${item.status}.`);
  return { ready: blockers.length === 0, repos, plan: { blocking: plan.blocking, open: plan.open }, blockers, warnings };
}

/**
 * The plan's part of the decision, read without writing anything. A plan that cannot be read stops finishing:
 * nobody can tell what it still waits for.
 */
async function judgePlan(workspacePath: string): Promise<{ blocking: PlanFinishItem[]; open: PlanFinishItem[]; problems: string[] }> {
  // Imported here: the plan modules lead back to verification, which this module also uses.
  const [{ readPlanReadOnly }, { planFinishCheck }, { heldUpBy }, { itemLabel, STATUS_WORDS }] = await Promise.all([
    import('./lifecycle.js'), import('./plan-app.js'), import('./plan.js'), import('./plan-words.js'),
  ]);
  let plan;
  try {
    plan = await readPlanReadOnly(workspacePath);
  } catch (error) {
    return { blocking: [], open: [], problems: [`The plan cannot be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const check = planFinishCheck(plan);
  const describe = (item: typeof plan.items[number]): PlanFinishItem => ({
    id: item.id,
    label: itemLabel(item),
    status: item.proposal ? "waiting for the user's OK" : STATUS_WORDS[item.status].label.toLowerCase(),
    heldUpBy: heldUpBy(plan, item.id).map(itemLabel),
  });
  return { blocking: check.blocks.map(describe), open: check.warns.map(describe), problems: [] };
}

/** Keeps the override log bounded; the latest finish record also carries its override. */
const MAX_OVERRIDE_RECORDS = 50;

/**
 * Records an explicit override so it stays auditable after the operation.
 *
 * @returns The persisted record.
 */
export async function recordVerificationOverride(
  workspacePath: string,
  override: VerificationOverride,
  decision: ProgressionDecision,
): Promise<VerificationOverrideRecord> {
  const record: VerificationOverrideRecord = {
    at: new Date().toISOString(),
    operation: 'finish',
    reason: override.reason.trim(),
    blockers: decision.blockers,
  };
  await mutateWorkspaceState(workspacePath, (state) => {
    state.verificationOverrides = [...(state.verificationOverrides ?? []), record].slice(-MAX_OVERRIDE_RECORDS);
  });
  return record;
}
