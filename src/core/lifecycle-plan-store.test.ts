import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { advanceLifecycleStep, loadWorkspaceLifecycle, planFromLifecycle, readWorkspaceLifecycle } from './lifecycle.js';
import { PLAN_STORE_FILE, readPlan } from './plan.js';
import { getStatePath, loadWorkspaceState, saveWorkspaceState } from './workspace-state.js';
import { getWorkContext } from './work-guidance.js';
import { managedWorkspaceArtifacts } from './workspace-git.js';
import type { LifecycleStep, WorkspaceLifecycle } from '../types.js';

vi.mock('./verify.js', () => ({ verifyWorkspace: vi.fn() }));

let root: string;
const storePath = () => path.join(root, PLAN_STORE_FILE);

const steps: LifecycleStep[] = [
  { id: 'query', title: 'Database query', status: 'completed', completedAt: '2026-10-07T10:00:00.000Z',
    lastVerificationSha: 'a91f2e0', lastVerificationStatus: 'pass', requiresVerification: true, verificationCommand: 'npm test' },
  { id: 'endpoint', title: 'CSV export endpoint', status: 'verified', dependsOn: ['query'], repo: 'app', branch: 'feat/csv',
    lastVerificationSha: '7c9e1f2', lastVerificationStatus: 'pass', reopenCount: 1, reopenReason: 'Rows were missing', reopenedBy: 'user', reopenedAt: '2026-10-08T10:00:00.000Z' },
  { id: 'button', title: 'Export button', status: 'blocked', dependsOn: ['endpoint'] },
  { id: 'access', title: 'Test access', status: 'blocked', blockedReason: 'Waiting for an account', blockedAt: '2026-10-08T11:00:00.000Z' },
];

async function seed(lifecycle: Partial<WorkspaceLifecycle> = {}) {
  await saveWorkspaceState({
    workspacePath: root, repos: {}, updatedAt: '',
    lifecycle: { workspaceId: 'test', flowType: 'feature', updatedAt: '2026-10-08T12:00:00.000Z', revision: 7, steps: structuredClone(steps), ...lifecycle },
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-plan-store-'));
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'test', branchName: 'test', repos: [], assistants: [] }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('moving an older lifecycle into the plan store', () => {
  it('keeps every milestone with its code, status, check, links and rework record, and the revision', async () => {
    await seed();
    const lifecycle = await loadWorkspaceLifecycle(root, { includeFleet: false });
    const plan = await readPlan(root);
    expect(plan.revision).toBe(7);
    expect(plan.items.map((item) => [item.id, item.kind, item.status])).toEqual([
      ['query', 'milestone', 'done'], ['endpoint', 'milestone', 'in_progress'], ['button', 'milestone', 'todo'], ['access', 'milestone', 'blocked'],
    ]);
    expect(plan.items[0]).toMatchObject({ gate: { required: true, command: 'npm test' }, resolution: 'Passed its check on a91f2e0', closedAt: '2026-10-07T10:00:00.000Z' });
    expect(plan.items[1]).toMatchObject({ waitsFor: ['query'], links: { repo: 'app', branch: 'feat/csv' }, reopenCount: 1, reopenReason: 'Rows were missing' });
    expect(plan.items[3]).toMatchObject({ blockedReason: 'Waiting for an account', blockedAt: '2026-10-08T11:00:00.000Z' });
    // The view shows what the lifecycle showed, with check results kept on this machine.
    expect(lifecycle.revision).toBe(7);
    expect(lifecycle.steps.map((step) => step.status)).toEqual(['completed', 'verified', 'pending', 'blocked']);
    expect(lifecycle.steps[1]).toMatchObject({ lastVerificationSha: '7c9e1f2', lastVerificationStatus: 'pass' });
    expect(lifecycle.currentStepId).toBe('endpoint');
    const state = await loadWorkspaceState(root);
    expect(state.lifecycle).toMatchObject({ steps: [], movedToPlanAt: expect.any(String), flowType: 'feature' });
    expect(state.planEvidence?.endpoint).toMatchObject({ lastVerificationSha: '7c9e1f2', canProgress: true });
  });

  it('moves once: deleting the plan file afterwards does not bring the old steps back', async () => {
    await seed();
    await loadWorkspaceLifecycle(root, { includeFleet: false });
    const first = await fs.readFile(storePath(), 'utf8');
    await loadWorkspaceLifecycle(root, { includeFleet: false });
    expect(await fs.readFile(storePath(), 'utf8')).toBe(first);
    await fs.rm(storePath());
    expect((await loadWorkspaceLifecycle(root, { includeFleet: false })).steps).toEqual([]);
  });

  it('loses nothing when it stopped between writing the plan and cleaning up the state', async () => {
    await seed();
    // The plan was written, but the state still holds the steps and their check results.
    const plan = planFromLifecycle((await loadWorkspaceState(root)).lifecycle!);
    await fs.writeFile(storePath(), `${JSON.stringify(plan, null, 2)}\n`);
    const view = await readWorkspaceLifecycle(root);
    expect(view.steps[1]).toMatchObject({ status: 'verified', lastVerificationSha: '7c9e1f2' });
    const loaded = await loadWorkspaceLifecycle(root, { includeFleet: false });
    expect(loaded.steps.map((step) => step.status)).toEqual(['completed', 'verified', 'pending', 'blocked']);
    // The store is not imported a second time over the copy that is already there.
    expect((await readPlan(root)).items).toHaveLength(4);
  });

  it('lets read-only readers see the milestones without writing anything', async () => {
    await seed();
    const before = await fs.readFile(getStatePath(root), 'utf8');
    expect((await readWorkspaceLifecycle(root)).steps).toHaveLength(4);
    expect((await getWorkContext(root)).lifecycle?.steps).toHaveLength(4);
    await expect(fs.access(storePath())).rejects.toThrow();
    expect(await fs.readFile(getStatePath(root), 'utf8')).toBe(before);
  });

  it('fails closed on a damaged plan store instead of importing over it', async () => {
    await seed();
    await fs.writeFile(storePath(), '{broken');
    await expect(loadWorkspaceLifecycle(root, { includeFleet: false })).rejects.toMatchObject({ code: 'corrupt' });
    expect(await fs.readFile(storePath(), 'utf8')).toBe('{broken');
    expect((await loadWorkspaceState(root)).lifecycle?.steps).toHaveLength(4);
  });

  it('records who started a milestone in the plan history', async () => {
    await seed();
    await advanceLifecycleStep(root, 'button', 'start', { by: 'agent', harness: 'claude' }).catch(() => undefined);
    // "Export button" waits for the endpoint, which is not done: nothing changed.
    expect((await readPlan(root)).items[2]!.status).toBe('todo');
    await advanceLifecycleStep(root, 'access', 'start', { by: 'agent', harness: 'claude' });
    const access = (await readPlan(root)).items[3]!;
    expect(access.status).toBe('in_progress');
    expect(access.history.at(-1)).toMatchObject({ by: 'claude', action: 'started' });
    expect(access).not.toHaveProperty('blockedReason');
  });

  it('is committed with the other workspace artifacts', async () => {
    await seed();
    await loadWorkspaceLifecycle(root, { includeFleet: false });
    expect(await managedWorkspaceArtifacts(root)).toContain(PLAN_STORE_FILE);
  });
});
