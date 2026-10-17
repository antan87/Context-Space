import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { changePlan, findItem, mutatePlan, readPlan } from './plan.js';
import { freshenAllPlans } from './plan-freshness-pass.js';

let dir: string;
const user = { by: 'user' } as const;

/** A workspace whose question holds up a milestone an older tool closed without withdrawing it. */
async function workspaceWithStaleQuestion(id: string, extra: object = {}): Promise<string> {
  const root = path.join(dir, id);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id, branchName: id, repos: [], assistants: [], workspacePath: root, ...extra }));
  await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export' }, { actor: user });
  await changePlan(root, { type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user', before: ['M1'] }, { actor: user });
  await mutatePlan(root, (plan) => { Object.assign(findItem(plan, 'M1')!, { status: 'done', resolution: 'Shipped' }); });
  return root;
}

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'freshness-pass-')));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

it('withdraws stale questions in active workspaces and leaves archived ones as their record', async () => {
  const active = await workspaceWithStaleQuestion('active');
  const archived = await workspaceWithStaleQuestion('archived', { archivedAt: '2026-10-15T00:00:00.000Z' });
  await fs.mkdir(path.join(dir, 'not-a-workspace'));

  expect(await freshenAllPlans(dir)).toBe(1);
  expect(findItem(await readPlan(active), 'Q1')!.status).toBe('dropped');
  expect(findItem(await readPlan(archived), 'Q1')!.status).toBe('todo');
  expect(await freshenAllPlans(dir)).toBe(0);
});
