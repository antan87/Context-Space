import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { advanceLifecycleStep, loadWorkspaceLifecycle } from './lifecycle.js';
import { loadWorkspaceState, saveWorkspaceState, recordRepoSync, getStatePath } from './workspace-state.js';
import { verifyWorkspace } from './verify.js';

vi.mock('./workspace.js', () => ({
  loadFeatureConfig: async () => ({ id: 'test', branchName: 'test', repos: [] }),
  resolveRepoInfos: async () => [],
}));
vi.mock('./verify.js', () => ({ verifyWorkspace: vi.fn() }));

let workspacePath: string;
beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), 'lifecycle-race-'));
  await saveWorkspaceState({ workspacePath, repos: {}, updatedAt: '', lifecycle: {
    workspaceId: 'test', flowType: 'feature', updatedAt: '', steps: [
      { id: 'a', title: 'A', status: 'in_progress' },
      { id: 'b', title: 'B', status: 'in_progress' },
    ],
  } });
});
afterEach(async () => { await rm(workspacePath, { recursive: true, force: true }); });

it('preserves both concurrent completions and independent sync state', async () => {
  await Promise.all([
    advanceLifecycleStep(workspacePath, 'a', 'complete'),
    advanceLifecycleStep(workspacePath, 'b', 'complete'),
    recordRepoSync(workspacePath, 'repo', { status: 'rebased', message: 'synced' }),
  ]);
  const state = await loadWorkspaceState(workspacePath);
  const lifecycle = await loadWorkspaceLifecycle(workspacePath, { includeFleet: false });
  expect(lifecycle.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
  expect(state.repos.repo.pendingValidation).toBe(true);
  expect(lifecycle.currentStepId).toBeUndefined();
});

it('preserves progress made while another step is being verified', async () => {
  let finish!: (report: any) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(verifyWorkspace).mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => { finish = resolve; });
  });
  const verification = advanceLifecycleStep(workspacePath, 'a', 'verify');
  await running;
  await advanceLifecycleStep(workspacePath, 'b', 'complete');
  finish({ overallStatus: 'pass', canProgress: true, repos: [] });
  await verification;
  expect((await loadWorkspaceLifecycle(workspacePath, { includeFleet: false })).steps.map((s) => s.status)).toEqual(['verified', 'completed']);
});

it('rejects a stale verification of a step completed by another caller and permits recovery', async () => {
  let finish!: (report: any) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(verifyWorkspace).mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => { finish = resolve; });
  });
  const verification = advanceLifecycleStep(workspacePath, 'a', 'verify');
  const rejected = expect(verification).rejects.toThrow('changed during this operation');
  await running;
  await advanceLifecycleStep(workspacePath, 'a', 'complete');
  finish({ overallStatus: 'pass', canProgress: true, repos: [] });
  await rejected;
  await advanceLifecycleStep(workspacePath, 'b', 'complete');
  expect((await loadWorkspaceLifecycle(workspacePath, { includeFleet: false })).steps.every((s) => s.status === 'completed')).toBe(true);
});

it('initializes a lifecycle once for concurrent first readers', async () => {
  await saveWorkspaceState({ workspacePath, repos: {}, updatedAt: '' });
  const lifecycles = await Promise.all([loadWorkspaceLifecycle(workspacePath), loadWorkspaceLifecycle(workspacePath)]);
  expect(lifecycles[0]).toEqual(lifecycles[1]);
  // The flow type is recorded once; the milestones themselves live in the plan store.
  expect((await loadWorkspaceState(workspacePath)).lifecycle).toMatchObject({ workspaceId: 'test', flowType: lifecycles[0]!.flowType, steps: [] });
});

it('preserves corrupt state instead of silently replacing it', async () => {
  await writeFile(getStatePath(workspacePath), '{broken');
  await expect(advanceLifecycleStep(workspacePath, 'step_discovery', 'complete')).rejects.toThrow();
  expect(await readFile(getStatePath(workspacePath), 'utf8')).toBe('{broken');
  // The failed mutation must release its lock and queue.
  await saveWorkspaceState({ workspacePath, repos: {}, updatedAt: '' });
  await recordRepoSync(workspacePath, 'repo', { status: 'rebased', message: 'recovered' });
  expect((await loadWorkspaceState(workspacePath)).repos.repo.lastSyncMessage).toBe('recovered');
});
