import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LifecycleStepError,
  REOPEN_REASON_MAX_LENGTH,
  advanceLifecycleStep,
  blockLifecycleStep,
  loadWorkspaceLifecycle,
  renderLifecyclePlan,
} from './lifecycle.js';
import { deriveMilestoneFacts } from './progress-facts.js';
import { saveWorkspaceState } from './workspace-state.js';
import type { LifecycleStep } from '../types.js';

vi.mock('./workspace.js', () => ({
  loadFeatureConfig: async () => ({ id: 'test', branchName: 'test', repos: [] }),
  resolveRepoInfos: async () => [],
}));
vi.mock('./verify.js', () => ({ verifyWorkspace: vi.fn() }));

let workspacePath: string;

async function seed(steps: LifecycleStep[]) {
  await saveWorkspaceState({
    workspacePath, repos: {}, updatedAt: '',
    lifecycle: { workspaceId: 'test', flowType: 'feature', updatedAt: '', revision: 3, steps },
  });
}
// The lifecycle is a view over the plan store.
const stepsNow = async () => (await loadWorkspaceLifecycle(workspacePath, { includeFleet: false })).steps;

beforeEach(async () => { workspacePath = await mkdtemp(path.join(os.tmpdir(), 'lifecycle-block-')); });
afterEach(async () => { await rm(workspacePath, { recursive: true, force: true }); });

describe('blockLifecycleStep', () => {
  it.each(['pending', 'in_progress', 'verified'] as const)('blocks a %s milestone and records why and when', async (status) => {
    await seed([{ id: 'ship', title: 'Ship', status }]);
    const lifecycle = await blockLifecycleStep(workspacePath, 'ship', { reason: 'Waiting for the release owner' });
    expect(lifecycle.steps[0]).toMatchObject({ status: 'blocked', blockedReason: 'Waiting for the release owner' });
    expect(Date.parse(lifecycle.steps[0]!.blockedAt!)).not.toBeNaN();
    expect(lifecycle.revision).toBe(4);
    expect((await stepsNow())[0]!.status).toBe('blocked');
  });

  it('refuses finished work and leaves it untouched', async () => {
    await seed([{ id: 'plan', title: 'Plan', status: 'completed', completedAt: '2026-10-01T00:00:00.000Z' }]);
    const error = await blockLifecycleStep(workspacePath, 'plan', { reason: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(LifecycleStepError);
    expect(error.code).toBe('not_blockable');
    expect((await stepsNow())[0]).toEqual({ id: 'plan', title: 'Plan', status: 'completed', completedAt: '2026-10-01T00:00:00.000Z' });
  });

  it('reports an unknown milestone as not found', async () => {
    await seed([{ id: 'plan', title: 'Plan', status: 'pending' }]);
    const error = await blockLifecycleStep(workspacePath, 'nope', { reason: 'x' }).catch((e) => e);
    expect(error.code).toBe('not_found');
  });

  it.each([['', 'empty'], ['  \n ', 'blank'], ['\u0007', 'only control characters']])('rejects a reason that is %j (%s)', async (reason) => {
    await seed([{ id: 'ship', title: 'Ship', status: 'in_progress' }]);
    await expect(blockLifecycleStep(workspacePath, 'ship', { reason })).rejects.toThrow(/blocked on/);
    expect((await stepsNow())[0]!.status).toBe('in_progress');
  });

  it('rejects an oversized reason and accepts one exactly at the limit', async () => {
    await seed([{ id: 'ship', title: 'Ship', status: 'in_progress' }]);
    await expect(blockLifecycleStep(workspacePath, 'ship', { reason: 'x'.repeat(REOPEN_REASON_MAX_LENGTH + 1) })).rejects.toThrow(/or fewer/);
    const [step] = (await blockLifecycleStep(workspacePath, 'ship', { reason: 'x'.repeat(REOPEN_REASON_MAX_LENGTH) })).steps;
    expect(step!.blockedReason).toHaveLength(REOPEN_REASON_MAX_LENGTH);
  });

  it('cleans control characters and collapses line breaks so the reason cannot break the plan', async () => {
    await seed([{ id: 'ship', title: 'Ship', status: 'in_progress' }, { id: 'next', title: 'Next', status: 'pending' }]);
    const lifecycle = await blockLifecycleStep(workspacePath, 'ship', { reason: 'Need a key\u001b[31m\n\n2. fake milestone' });
    expect(lifecycle.steps[0]!.blockedReason).toBe('Need a key[31m 2. fake milestone');
    expect(renderLifecyclePlan(lifecycle).split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(2);
  });

  it('keeps the first blocked time when the reason is updated', async () => {
    await seed([{ id: 'ship', title: 'Ship', status: 'in_progress' }]);
    const first = (await blockLifecycleStep(workspacePath, 'ship', { reason: 'Waiting for A' })).steps[0]!;
    const second = (await blockLifecycleStep(workspacePath, 'ship', { reason: 'Now waiting for B' })).steps[0]!;
    expect(second.blockedReason).toBe('Now waiting for B');
    expect(second.blockedAt).toBe(first.blockedAt);
  });

  it('lets only one of two simultaneous blocks win without corrupting the step', async () => {
    await seed([{ id: 'ship', title: 'Ship', status: 'in_progress' }]);
    const results = await Promise.allSettled([
      blockLifecycleStep(workspacePath, 'ship', { reason: 'first' }),
      blockLifecycleStep(workspacePath, 'ship', { reason: 'second' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const [step] = await stepsNow();
    expect(step!.status).toBe('blocked');
    expect(['first', 'second']).toContain(step!.blockedReason);
  });
});

describe('ending a block', () => {
  it('starting the milestone again clears the block and its reason', async () => {
    await seed([{ id: 'ship', title: 'Ship', status: 'in_progress' }]);
    await blockLifecycleStep(workspacePath, 'ship', { reason: 'Waiting' });
    const lifecycle = await advanceLifecycleStep(workspacePath, 'ship', 'start', { by: 'user' });
    expect(lifecycle.steps[0]).toMatchObject({ status: 'in_progress' });
    expect(lifecycle.steps[0]).not.toHaveProperty('blockedReason');
    expect(lifecycle.steps[0]).not.toHaveProperty('blockedAt');
  });

  it('a milestone can be blocked, started again and completed', async () => {
    await seed([{ id: 'ship', title: 'Ship', status: 'in_progress' }]);
    await blockLifecycleStep(workspacePath, 'ship', { reason: 'Waiting' });
    await advanceLifecycleStep(workspacePath, 'ship', 'start', { by: 'user' });
    const [step] = (await advanceLifecycleStep(workspacePath, 'ship', 'complete', { by: 'user' })).steps;
    expect(step!.status).toBe('completed');
    expect(step).not.toHaveProperty('blockedReason');
  });

  it('keeps a deliberate block when another milestone completes, because only starting it again ends it', async () => {
    await seed([
      { id: 'a', title: 'A', status: 'in_progress' },
      { id: 'b', title: 'B', status: 'pending', dependsOn: ['a'] },
    ]);
    await blockLifecycleStep(workspacePath, 'b', { reason: 'Owner has not decided' });
    await advanceLifecycleStep(workspacePath, 'a', 'complete', { by: 'user' });
    const b = (await stepsNow()).find((step) => step.id === 'b')!;
    expect(b.status).toBe('blocked');
    expect(b.blockedReason).toBe('Owner has not decided');
  });

  it('still unblocks an old-style dependency block, which has no reason, when its dependency completes', async () => {
    await seed([
      { id: 'a', title: 'A', status: 'in_progress' },
      { id: 'b', title: 'B', status: 'blocked', dependsOn: ['a'] },
    ]);
    await advanceLifecycleStep(workspacePath, 'a', 'complete', { by: 'user' });
    expect((await stepsNow()).find((step) => step.id === 'b')!.status).not.toBe('blocked');
  });
});

describe('how a block is shown', () => {
  it('appears in the milestone facts with its reason, and only while blocked', () => {
    const [blocked, running] = deriveMilestoneFacts([
      { id: 'a', title: 'A', status: 'blocked', blockedReason: 'Waiting on legal' },
      { id: 'b', title: 'B', status: 'in_progress', blockedReason: 'stale leftover' },
    ]);
    expect(blocked).toMatchObject({ state: 'blocked', blockedReason: 'Waiting on legal' });
    expect(running).not.toHaveProperty('blockedReason');
  });

  it('appears in the milestone plan the AI reads', () => {
    const text = renderLifecyclePlan({
      workspaceId: 'w', flowType: 'feature', updatedAt: '',
      steps: [{ id: 'a', title: 'A', status: 'blocked', blockedReason: 'Waiting on legal' }],
    });
    expect(text).toContain('1. **A** — blocked');
    expect(text).toContain('Blocked: Waiting on legal');
  });
});
