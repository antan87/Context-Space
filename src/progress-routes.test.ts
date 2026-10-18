import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from './server.js';
import * as configModule from './core/config.js';
import { PRIMARY_MANIFEST_FILE } from './core/constants.js';
import { loadWorkspaceState, saveWorkspaceState } from './core/workspace-state.js';
import { loadWorkspaceLifecycle } from './core/lifecycle.js';
import { parsePlanFile } from './core/plan-file.js';
import { readPlanChanges } from './core/plan-file-store.js';
import { ANSWERED_IN_CHAT } from './core/plan-questions.js';
import type { LifecycleStep } from './types.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-progress-route-'));
  vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
    version: '1.0', devDir: '/dev', workspacesDir: root, defaultAssistant: null, scanDepth: 2,
  } as any);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

/** A workspace with a manifest (so repositories can be listed), a lifecycle, and optionally a chat ledger. */
async function makeWorkspace(id: string, steps: LifecycleStep[], ledger: Array<Record<string, unknown>> = []) {
  const dir = path.join(root, id);
  await fs.mkdir(path.join(dir, '.contextspace'), { recursive: true });
  await fs.writeFile(path.join(dir, PRIMARY_MANIFEST_FILE), JSON.stringify({
    id, branchName: id, description: 'x', mode: 'worktree', repos: [], assistants: [], workspacePath: dir, createdAt: new Date().toISOString(),
  }), 'utf8');
  await saveWorkspaceState({
    workspacePath: dir, repos: {}, updatedAt: '',
    lifecycle: { workspaceId: id, flowType: 'feature', updatedAt: '', revision: 1, steps },
  });
  if (ledger.length) await fs.writeFile(path.join(dir, '.contextspace', 'chat.jsonl'), ledger.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return dir;
}

const done = (id: string): LifecycleStep => ({ id, title: id.toUpperCase(), status: 'completed', completedAt: '2026-10-01T10:00:00.000Z' });
const request = (over: Record<string, unknown> = {}) => ({
  id: 'q1', timestamp: new Date(Date.now() - 60_000).toISOString(), harness: 'claude', author: 'agent', kind: 'input_request', message: 'Which branch?', ...over,
});

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('GET /api/workspace/:id/progress-facts', () => {
  it('returns milestones, open questions and counts for a workspace', async () => {
    await makeWorkspace('ws', [done('plan'), { id: 'build', title: 'Build', status: 'in_progress', dependsOn: ['plan'] }, { id: 'ship', title: 'Ship', status: 'pending' }], [request()]);
    const { status, body } = await call('GET', '/api/workspace/ws/progress-facts');
    expect(status).toBe(200);
    expect(body.facts).toMatchObject({
      workspaceId: 'ws',
      counts: { total: 3, done: 1, inProgress: 1, upcoming: 1 },
      openQuestions: [{ id: 'q1', message: 'Which branch?' }],
      changes: { files: 0 },
      verification: { status: 'never' },
      unavailable: [],
    });
    expect(body.facts.milestones.map((m: any) => m.state)).toEqual(['done', 'in_progress', 'upcoming']);
  });

  it('reports a reopened milestone with its reason', async () => {
    await makeWorkspace('ws', [done('plan')]);
    await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'plan', reason: 'Review found a gap' });
    const { body } = await call('GET', '/api/workspace/ws/progress-facts');
    expect(body.facts.counts).toMatchObject({ done: 0, reopened: 1 });
    expect(body.facts.milestones[0]).toMatchObject({ state: 'reopened', reopen: { reason: 'Review found a gap', by: 'user' } });
  });

  it('still answers, with the unreadable part listed, when a workspace has no manifest', async () => {
    const dir = path.join(root, 'bare');
    await fs.mkdir(dir, { recursive: true });
    const { status, body } = await call('GET', '/api/workspace/bare/progress-facts');
    expect(status).toBe(200);
    expect(body.facts.milestones).toEqual([]);
    expect(body.facts.unavailable.map((u: any) => u.source)).toContain('changes');
  });

  it('refuses a workspace id that points outside the workspaces directory', async () => {
    const { status } = await call('GET', `/api/workspace/${encodeURIComponent('../outside')}/progress-facts`);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});

describe('POST /api/workspace/:id/lifecycle/reopen', () => {
  it('reopens a finished milestone and returns the lifecycle', async () => {
    const dir = await makeWorkspace('ws', [done('plan')]);
    const { status, body } = await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'plan', reason: 'Gap in step 2' });
    expect(status).toBe(200);
    expect(body.lifecycle.steps[0]).toMatchObject({ status: 'in_progress', reopenReason: 'Gap in step 2', reopenCount: 1 });
    expect((await loadWorkspaceLifecycle(dir, { includeFleet: false })).steps[0]!.reopenedBy).toBe('user');
  });

  it('records the reopen as the user\'s own even if the caller claims to be an agent', async () => {
    const dir = await makeWorkspace('ws', [done('plan')]);
    await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'plan', reason: 'x', by: 'agent' });
    expect((await loadWorkspaceLifecycle(dir, { includeFleet: false })).steps[0]!.reopenedBy).toBe('user');
  });

  it.each([
    [{}, 'nothing'],
    [{ stepId: 'plan' }, 'no reason'],
    [{ reason: 'why' }, 'no step'],
    [{ stepId: 7, reason: 'why' }, 'a numeric step'],
    [{ stepId: 'plan', reason: ['a'] }, 'a list as the reason'],
  ])('answers 400 for a request with %j (%s)', async (payload) => {
    await makeWorkspace('ws', [done('plan')]);
    const { status, body } = await call('POST', '/api/workspace/ws/lifecycle/reopen', payload);
    expect(status).toBe(400);
    expect(body.error).toMatch(/required/);
  });

  it('answers 400, not 500, for an empty or oversized reason, and changes nothing', async () => {
    const dir = await makeWorkspace('ws', [done('plan')]);
    const blank = await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'plan', reason: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/Say why/);
    const long = await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'plan', reason: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/or fewer/);
    expect((await loadWorkspaceState(dir)).lifecycle!.steps[0]!.status).toBe('completed');
  });

  it('answers 404 for a milestone that does not exist', async () => {
    await makeWorkspace('ws', [done('plan')]);
    const { status, body } = await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'nope', reason: 'x' });
    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
  });

  it('answers 409 for a milestone that is not finished, and again for one already reopened', async () => {
    await makeWorkspace('ws', [{ id: 'build', title: 'Build', status: 'in_progress' }, done('plan')]);
    const unfinished = await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'build', reason: 'x' });
    expect(unfinished.status).toBe(409);
    expect(unfinished.body.code).toBe('not_reopenable');
    expect((await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'plan', reason: 'x' })).status).toBe(200);
    const again = await call('POST', '/api/workspace/ws/lifecycle/reopen', { stepId: 'plan', reason: 'x' });
    expect(again.status).toBe(409);
  });
});

describe('POST /api/workspace/:id/input-requests/acknowledge', () => {
  it('marks open questions answered, so the alert and the open-question count both clear', async () => {
    await makeWorkspace('ws', [], [request({ id: 'a' }), request({ id: 'b', message: 'And the tests?' })]);
    expect((await call('GET', '/api/attention?workspaces=ws')).body.requests).toHaveLength(1);
    expect((await call('GET', '/api/workspace/ws/progress-facts')).body.facts.openQuestions).toHaveLength(2);

    const { status, body } = await call('POST', '/api/workspace/ws/input-requests/acknowledge');
    expect(status).toBe(200);
    expect(body.acknowledged).toBe(2);

    expect((await call('GET', '/api/attention?workspaces=ws')).body.requests).toEqual([]);
    expect((await call('GET', '/api/workspace/ws/progress-facts')).body.facts.openQuestions).toEqual([]);
  });

  it('answers the same questions in the plan too, as the developer, so nothing asks them twice', async () => {
    const dir = await makeWorkspace('ws', [], [request({ id: 'a', message: 'Which branch?' })]);
    await fs.writeFile(path.join(dir, 'PLAN.md'), '# Plan\n\n## Decisions\n\n- [ ] Decide: Which branch?\n- [ ] Decide: Something else?\n');

    const { status, body } = await call('POST', '/api/workspace/ws/input-requests/acknowledge');
    expect(status).toBe(200);
    expect(body).toMatchObject({ acknowledged: 1, planAnswered: ['Which branch?'] });
    const [answered, other] = parsePlanFile(await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')).decisions;
    expect(answered).toMatchObject({ done: true, answer: ANSWERED_IN_CHAT });
    expect((await readPlanChanges(dir))[0]).toMatchObject({ by: 'user', action: 'answered', text: 'Which branch?' });
    expect(other).toMatchObject({ done: false });
  });

  it('still marks the questions answered when the plan cannot be changed', async () => {
    const dir = await makeWorkspace('ws', [], [request()]);
    await fs.mkdir(path.join(dir, 'PLAN.md'));
    const { status, body } = await call('POST', '/api/workspace/ws/input-requests/acknowledge');
    expect(status).toBe(200);
    expect(body).toMatchObject({ acknowledged: 1, planAnswered: [] });
    expect((await call('GET', '/api/workspace/ws/progress-facts')).body.facts.openQuestions).toEqual([]);
  });

  it('answers 200 with nothing acknowledged when no question is open', async () => {
    await makeWorkspace('ws', []);
    const { status, body } = await call('POST', '/api/workspace/ws/input-requests/acknowledge');
    expect(status).toBe(200);
    expect(body.acknowledged).toBe(0);
  });

  it('refuses a workspace id that points outside the workspaces directory', async () => {
    const { status } = await call('POST', `/api/workspace/${encodeURIComponent('../outside')}/input-requests/acknowledge`);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});
