import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockLifecycleStep,
  LifecycleStepError,
  REOPEN_REASON_MAX_LENGTH,
  advanceLifecycleStep,
  loadWorkspaceLifecycle,
  renderLifecyclePlan,
  reopenLifecycleStep,
  updateLifecyclePlan,
} from './lifecycle.js';
import { saveWorkspaceState } from './workspace-state.js';
import { readPlan } from './plan.js';
import type { LifecycleStep } from '../types.js';

vi.mock('./workspace.js', () => ({
  loadFeatureConfig: async () => ({ id: 'test', branchName: 'test', repos: [] }),
  resolveRepoInfos: async () => [],
}));
vi.mock('./verify.js', () => ({ verifyWorkspace: vi.fn() }));

let workspacePath: string;

async function seed(steps: LifecycleStep[], extra: { revision?: number; currentStepId?: string } = {}) {
  await saveWorkspaceState({
    workspacePath, repos: {}, updatedAt: '',
    lifecycle: { workspaceId: 'test', flowType: 'feature', updatedAt: '', steps, ...extra },
  });
}

const finished = (id: string, over: Partial<LifecycleStep> = {}): LifecycleStep => ({
  id, title: id.toUpperCase(), status: 'completed', completedAt: '2026-10-01T10:00:00.000Z',
  lastVerificationStatus: 'pass', lastVerificationSha: 'abc123', ...over,
});

/** The steps as stored: the lifecycle is a view over the plan store. */
async function stepsNow() {
  return (await loadWorkspaceLifecycle(workspacePath, { includeFleet: false })).steps;
}

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'lifecycle-reopen-'));
});
afterEach(async () => { await rm(workspacePath, { recursive: true, force: true }); });

describe('reopenLifecycleStep', () => {
  it('sends a completed milestone back to in progress and records when, why, by whom and how often', async () => {
    await seed([finished('plan'), { id: 'build', title: 'Build', status: 'in_progress', dependsOn: ['plan'] }], { revision: 4, currentStepId: 'build' });
    const lifecycle = await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Review found a gap in step 2', by: 'user' });

    const plan = lifecycle.steps.find((step) => step.id === 'plan')!;
    expect(plan).toMatchObject({ status: 'in_progress', reopenReason: 'Review found a gap in step 2', reopenedBy: 'user', reopenCount: 1 });
    expect(Date.parse(plan.reopenedAt!)).not.toBeNaN();
    expect(lifecycle.currentStepId).toBe('plan');
    expect(lifecycle.revision).toBe(5);
    // Persisted, not just returned.
    expect((await stepsNow()).find((step) => step.id === 'plan')?.reopenCount).toBe(1);
  });

  it('clears the old completion and its verification proof, because they no longer describe the work', async () => {
    await seed([finished('plan')]);
    const [plan] = (await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Redo it', by: 'user' })).steps;
    expect(plan).not.toHaveProperty('completedAt');
    expect(plan).not.toHaveProperty('lastVerificationSha');
    expect(plan).not.toHaveProperty('lastVerificationStatus');
    expect(plan!.reopenedBy).toBe('user');
  });

  it('from the AI side only proposes it: nothing changes until the user decides', async () => {
    await seed([finished('plan')], { revision: 3 });
    const lifecycle = await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Tests were too narrow', by: 'agent' });
    expect(lifecycle.steps[0]).toMatchObject({ status: 'completed', lastVerificationSha: 'abc123' });
    expect(lifecycle.steps[0]).not.toHaveProperty('reopenedAt');
    const item = (await readPlan(workspacePath)).items[0]!;
    expect(item.proposal).toMatchObject({ action: 'reopen', by: 'agent', note: 'Tests were too narrow' });
    expect(item.status).toBe('done');
  });

  it('reopens a verified milestone as well', async () => {
    await seed([{ id: 'plan', title: 'Plan', status: 'verified', lastVerificationStatus: 'pass' }]);
    const [plan] = (await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Verification was too narrow', by: 'user' })).steps;
    expect(plan!.status).toBe('in_progress');
  });

  it.each<LifecycleStep>([
    { id: 'plan', title: 'Plan', status: 'pending' },
    { id: 'plan', title: 'Plan', status: 'in_progress' },
    { id: 'plan', title: 'Plan', status: 'blocked', blockedReason: 'Keys', blockedAt: '2026-10-01T10:00:00.000Z' },
  ])('refuses a $status milestone and leaves it untouched', async (step) => {
    await seed([step], { revision: 2 });
    const error = await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Why not', by: 'user' }).catch((e) => e);
    expect(error).toBeInstanceOf(LifecycleStepError);
    expect(error.code).toBe('not_reopenable');
    expect(error.message).toContain('nothing to reopen');
    const lifecycle = await loadWorkspaceLifecycle(workspacePath, { includeFleet: false });
    expect(lifecycle.steps[0]).toEqual(step);
    expect(lifecycle.revision).toBe(2);
  });

  it('reports an unknown milestone as not found', async () => {
    await seed([finished('plan')]);
    const error = await reopenLifecycleStep(workspacePath, 'missing', { reason: 'x', by: 'user' }).catch((e) => e);
    expect(error).toBeInstanceOf(LifecycleStepError);
    expect(error.code).toBe('not_found');
  });

  it.each([['', 'empty'], ['   \n\t ', 'blank'], ['\u0007\u001b', 'only control characters']])('rejects a reason that is %j (%s) and changes nothing', async (reason) => {
    await seed([finished('plan')]);
    await expect(reopenLifecycleStep(workspacePath, 'plan', { reason, by: 'user' })).rejects.toThrow(/Say why/);
    expect((await stepsNow())[0]!.status).toBe('completed');
  });

  it('rejects a reason longer than the limit but accepts one exactly at it', async () => {
    await seed([finished('plan')]);
    await expect(reopenLifecycleStep(workspacePath, 'plan', { reason: 'x'.repeat(REOPEN_REASON_MAX_LENGTH + 1), by: 'user' })).rejects.toThrow(/or fewer/);
    const [plan] = (await reopenLifecycleStep(workspacePath, 'plan', { reason: 'x'.repeat(REOPEN_REASON_MAX_LENGTH), by: 'user' })).steps;
    expect(plan!.reopenReason).toHaveLength(REOPEN_REASON_MAX_LENGTH);
  });

  it('removes control characters from the reason so a terminal or toast cannot be reshaped', async () => {
    await seed([finished('plan')]);
    const [plan] = (await reopenLifecycleStep(workspacePath, 'plan', { reason: '  Gap\u001b[31m in\u0000 step 2\u0007  ', by: 'user' })).steps;
    expect(plan!.reopenReason).toBe('Gap[31m in step 2');
  });

  it('rejects an unknown reopener', async () => {
    await seed([finished('plan')]);
    await expect(reopenLifecycleStep(workspacePath, 'plan', { reason: 'x', by: 'robot' as any })).rejects.toThrow();
  });

  it('lets only one of two simultaneous reopens win, and counts the reopen once', async () => {
    await seed([finished('plan')]);
    const results = await Promise.allSettled([
      reopenLifecycleStep(workspacePath, 'plan', { reason: 'first', by: 'user' }),
      reopenLifecycleStep(workspacePath, 'plan', { reason: 'second', by: 'user' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(LifecycleStepError);
    expect((await stepsNow())[0]!.reopenCount).toBe(1);
  });

  it('can be reopened again after the rework finishes, and the count adds up', async () => {
    await seed([finished('plan')]);
    await reopenLifecycleStep(workspacePath, 'plan', { reason: 'first rework', by: 'user' });
    await advanceLifecycleStep(workspacePath, 'plan', 'complete');
    const [plan] = (await reopenLifecycleStep(workspacePath, 'plan', { reason: 'second rework', by: 'user' })).steps;
    expect(plan).toMatchObject({ status: 'in_progress', reopenReason: 'second rework', reopenedBy: 'user', reopenCount: 2 });
  });

  it('gives the loser of a simultaneous reopen a clear way to recover: reload and see it already reopened', async () => {
    await seed([finished('plan')]);
    await Promise.allSettled([
      reopenLifecycleStep(workspacePath, 'plan', { reason: 'first', by: 'user' }),
      reopenLifecycleStep(workspacePath, 'plan', { reason: 'second', by: 'user' }),
    ]);
    // After the dust settles a reopen is refused with an explanation, not a crash, and nothing is double counted.
    const error = await reopenLifecycleStep(workspacePath, 'plan', { reason: 'third', by: 'user' }).catch((e) => e);
    expect(error).toBeInstanceOf(LifecycleStepError);
    expect(error.code).toBe('not_reopenable');
    expect((await stepsNow())[0]!.reopenCount).toBe(1);
  });
});

describe('finishing reopened work', () => {
  it('clears the reopened marker when the milestone completes again, and keeps the count as history', async () => {
    await seed([finished('plan')]);
    await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Rework', by: 'user' });
    const [reopened] = await stepsNow();
    expect(reopened).toMatchObject({ status: 'in_progress', reopenCount: 1 });

    // The step has no gate, so completing it needs no verification run.
    const lifecycle = await advanceLifecycleStep(workspacePath, 'plan', 'complete');
    const [done] = lifecycle.steps;
    expect(done!.status).toBe('completed');
    expect(done).not.toHaveProperty('reopenedAt');
    expect(done).not.toHaveProperty('reopenReason');
    expect(done).not.toHaveProperty('reopenedBy');
    expect(done!.reopenCount).toBe(1);
  });
});

describe('plan updates keep reopened state', () => {
  it('retains the reopen record when the plan is edited', async () => {
    await seed([finished('plan'), { id: 'build', title: 'Build', status: 'pending', dependsOn: ['plan'] }], { revision: 1 });
    const lifecycle = await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Gap', by: 'user' });
    const updated = await updateLifecyclePlan(workspacePath, {
      revision: lifecycle.revision,
      steps: [
        { id: 'plan', title: 'Plan, renamed' },
        { id: 'build', title: 'Build', dependsOn: ['plan'] },
      ],
    });
    expect(updated.steps[0]).toMatchObject({ title: 'Plan, renamed', status: 'in_progress', reopenReason: 'Gap', reopenCount: 1 });
  });
});

describe('loadWorkspaceLifecycle without the branch fleet', () => {
  it('returns the stored lifecycle and skips the remote queries when asked', async () => {
    await seed([finished('plan')]);
    const lifecycle = await loadWorkspaceLifecycle(workspacePath, { includeFleet: false });
    expect(lifecycle.steps).toHaveLength(1);
    expect(lifecycle.fleet).toBeUndefined();
  });
});

describe('the milestone plan the AI reads', () => {
  it('says a milestone was reopened, by whom and why, so the AI knows work was sent back', async () => {
    await seed([finished('plan'), { id: 'build', title: 'Build', status: 'pending' }]);
    const lifecycle = await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Review found a gap in step 2', by: 'user' });
    const text = renderLifecyclePlan(lifecycle);
    expect(text).toContain('1. **PLAN** — reopened, in progress');
    expect(text).toContain('Reopened by the user: Review found a gap in step 2');
    expect(text).toContain('2. **Build** — pending');
  });

  it('names an agent when an agent reopened it, and does not mention reopening in the definitions-only view', async () => {
    // Reopened by an agent before reopening became a proposal; the record moves into the plan as it was.
    await seed([{
      id: 'plan', title: 'PLAN', status: 'in_progress', reopenedAt: '2026-10-02T10:00:00.000Z',
      reopenReason: 'Tests were too narrow', reopenedBy: 'agent', reopenCount: 1,
    }]);
    const lifecycle = await loadWorkspaceLifecycle(workspacePath, { includeFleet: false });
    expect(renderLifecyclePlan(lifecycle)).toContain('Reopened by an agent: Tests were too narrow');
    expect(renderLifecyclePlan(lifecycle, false)).not.toContain('Reopened');
  });

  it('says a reopened milestone that is then blocked is blocked, with why, and still says it was reopened', async () => {
    await seed([finished('plan')]);
    await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Rework', by: 'user' });
    const text = renderLifecyclePlan(await blockLifecycleStep(workspacePath, 'plan', { reason: 'Waiting on keys' }));
    expect(text).toContain('1. **PLAN** — blocked');
    expect(text).not.toContain('reopened, in progress');
    expect(text).toContain('Blocked: Waiting on keys');
    expect(text).toContain('Reopened by the user: Rework');
  });

  it('shows plain "completed" again once the rework is finished', async () => {
    await seed([finished('plan')]);
    await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Rework', by: 'user' });
    const lifecycle = await advanceLifecycleStep(workspacePath, 'plan', 'complete');
    const text = renderLifecyclePlan(lifecycle);
    expect(text).toContain('1. **PLAN** — completed');
    expect(text).not.toContain('Reopened');
  });

  it('keeps a multi-line reason on one line so it cannot break the list', async () => {
    await seed([finished('plan')]);
    const lifecycle = await reopenLifecycleStep(workspacePath, 'plan', { reason: 'Line one\n\n2. fake milestone\r\n- injected', by: 'user' });
    expect(lifecycle.steps[0]!.reopenReason).toBe('Line one 2. fake milestone - injected');
    expect(renderLifecyclePlan(lifecycle).split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(1);
  });
});
