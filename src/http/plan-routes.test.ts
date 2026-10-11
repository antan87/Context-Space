import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { registerPlanRoutes } from './plan-routes.js';
import { changePlan, readPlan } from '../core/plan.js';
import { planFinishCheck } from '../core/plan-app.js';
import { PLAN_RULES, STATUS_WORDS } from '../core/plan-words.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';

vi.mock('../core/verify.js', () => ({
  verifyWorkspace: vi.fn(async () => ({ overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234' }] })),
}));

const agent = { actor: { by: 'agent', harness: 'claude' } } as const;
const user = { actor: { by: 'user' } } as const;

describe('plan routes', () => {
  let root: string;
  let app: Hono;
  const get = async () => (await app.request('/api/workspace/reports/plan/items')).json();
  const post = async (body: unknown) => {
    const response = await app.request('/api/workspace/reports/plan/items', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-routes-'));
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', branchName: 'reports', description: 'Reports', repos: [], assistants: [], workspacePath: root }));
    app = new Hono();
    registerPlanRoutes(app, async (id) => (id === 'reports' ? root : null));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('reads the plan in the tab\'s sections, with history, the words and what stops finishing', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export endpoint' }, user);
    await changePlan(root, { type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user', before: ['M1'] }, agent);
    await changePlan(root, { type: 'add', kind: 'task', title: 'Rate limit', owner: 'agent' }, agent);

    const plan = await get();
    expect(plan.counts).toMatchObject({ needsYou: 1, todo: 3 });
    expect(plan.needsYou.map((item: { label: string }) => item.label)).toEqual(['Q1 Which time zone?']);
    expect(plan.milestones[0]).toMatchObject({ label: 'M1 CSV export endpoint', waitsFor: [{ id: 'Q1', label: 'Q1 Which time zone?', status: 'todo' }] });
    expect(plan.milestones[0].history).toEqual([expect.objectContaining({ by: 'user', action: 'added' }), expect.objectContaining({ by: 'claude', action: 'waits' })]);
    expect(plan.otherOpen.map((item: { label: string }) => item.label)).toEqual(['T1 Rate limit']);
    expect(plan.finish.blocks.map((item: { label: string }) => item.label)).toEqual(['Q1 Which time zone?']);
    expect(plan.finish.warns.map((item: { label: string }) => item.label)).toEqual(['M1 CSV export endpoint', 'T1 Rate limit']);
    expect(plan.words.rules).toEqual([...PLAN_RULES]);
    expect(plan.words.statuses.blocked).toEqual(STATUS_WORDS.blocked);
  });

  it('answers the user\'s question as the user, and accepts or sends back the AI\'s proposals', async () => {
    await changePlan(root, { type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user' }, agent);
    await changePlan(root, { type: 'add', kind: 'task', title: 'Rate limit', owner: 'user' }, agent);
    await changePlan(root, { type: 'add', kind: 'task', title: 'Docs', owner: 'user' }, agent);
    await changePlan(root, { type: 'done', id: 'T1', resolution: 'Five tries a minute' }, agent);
    await changePlan(root, { type: 'done', id: 'T2', resolution: 'Written' }, agent);

    expect((await post({ change: { type: 'answer', id: 'Q1', answer: 'UTC' } })).status).toBe(200);
    const accepted = await post({ change: { type: 'accept', id: 'T1' } });
    expect(accepted.status).toBe(200);
    const rejected = await post({ change: { type: 'reject', id: 'T2', reason: 'Add the API page too' } });
    expect(rejected.body.plan.counts.needsYou).toBe(0);

    const plan = await readPlan(root);
    const item = (id: string) => plan.items.find((candidate) => candidate.id === id)!;
    expect(item('Q1')).toMatchObject({ status: 'done', resolution: 'UTC' });
    expect(item('Q1').history.at(-1)).toMatchObject({ by: 'user', action: 'answered' });
    expect(item('T1')).toMatchObject({ status: 'done', resolution: 'Five tries a minute' });
    expect(item('T2').proposal).toBeUndefined();
    expect(item('T2').status).not.toBe('done');
  });

  it('adds and edits items, and refuses a change made on a plan that moved on', async () => {
    const added = await post({ change: { type: 'add', kind: 'milestone', title: 'CSV export endpoint', detail: 'Download as CSV', gate: { required: true, command: 'npm test' } } });
    expect(added.status).toBe(200);
    expect(added.body.message).toMatch(/M1 CSV export endpoint/);
    const revision = added.body.plan.revision;

    expect((await post({ change: { type: 'edit', id: 'M1', title: 'CSV export' }, ifRevision: revision })).status).toBe(200);
    const stale = await post({ change: { type: 'edit', id: 'M1', title: 'Other' }, ifRevision: revision });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed in another session/);
    expect((await readPlan(root)).items[0]!.title).toBe('CSV export');
  });

  it('marks a milestone done only through its check, keeping the reason given', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export endpoint', gate: { required: true, command: 'npm test' } }, user);
    await changePlan(root, { type: 'start', id: 'M1' }, agent);
    await changePlan(root, { type: 'done', id: 'M1', resolution: 'Endpoint works' }, agent);
    expect((await readPlan(root)).items[0]!.proposal).toMatchObject({ action: 'done' });

    const accepted = await post({ change: { type: 'accept', id: 'M1' } });
    expect(accepted.status).toBe(200);
    const [milestone] = (await readPlan(root)).items;
    expect(milestone).toMatchObject({ status: 'done', resolution: 'Endpoint works. Passed its check on abc1234' });
    expect(accepted.body.plan.evidence.M1).toMatchObject({ canProgress: true, lastVerificationSha: 'abc1234' });
  });

  it('refuses invalid changes, unknown items and unknown workspaces with clear errors', async () => {
    expect((await post({ change: { type: 'done', id: 'T9', resolution: 'x' } })).status).toBe(404);
    expect((await post({ change: { type: 'done', id: 'T9' } })).status).toBe(400);
    expect((await post({ change: { type: 'delete', id: 'T9' } })).status).toBe(400);
    expect((await post({ change: { type: 'start', id: 'T1', extra: true } })).status).toBe(400);
    expect((await app.request('/api/workspace/other/plan/items')).status).toBe(404);
  });
});

describe('planFinishCheck', () => {
  it('blocks on what milestones wait for, through what that waits for, and only warns about the rest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-finish-'));
    try {
      await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'f', branchName: 'f', repos: [], assistants: [], workspacePath: root }));
      await changePlan(root, { type: 'add', kind: 'milestone', title: 'Endpoint' }, user);
      await changePlan(root, { type: 'add', kind: 'task', title: 'Queue', before: ['M1'] }, user);
      await changePlan(root, { type: 'add', kind: 'question', title: 'Which zone?', owner: 'user', before: ['T1'] }, user);
      await changePlan(root, { type: 'add', kind: 'decision', title: 'Excel', }, user);
      await changePlan(root, { type: 'later', id: 'D1', revisitWhen: 'after release' }, user);
      await changePlan(root, { type: 'add', kind: 'task', title: 'Docs' }, user);
      await changePlan(root, { type: 'add', kind: 'milestone', title: 'Old idea' }, user);
      await changePlan(root, { type: 'add', kind: 'task', title: 'Only for the old idea', before: ['M2'] }, user);
      await changePlan(root, { type: 'drop', id: 'M2', reason: 'Not needed' }, user);

      const check = planFinishCheck(await readPlan(root));
      expect(check.blocks.map((item) => item.id)).toEqual(['T1', 'Q1']);
      expect(check.warns.map((item) => item.id)).toEqual(['M1', 'T2', 'T3']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
