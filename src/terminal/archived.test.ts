import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { registerTerminalRoutes } from './routes.js';
import type { TerminalManager } from './manager.js';

let workspace: string;
beforeEach(async () => { workspace = await mkdtemp(path.join(tmpdir(), 'cs-archived-term-')); });
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

const writeManifest = (extra: object = {}) => writeFile(path.join(workspace, 'contextspace.json'), JSON.stringify({ id: 'workspace', workspacePath: workspace, repos: [], assistants: [], ...extra }));

async function fixture() {
  const manager = { create: vi.fn(async (input: { launchId: string; target: string }) => ({ id: input.launchId, target: input.target })), stop: vi.fn(), claimSession: vi.fn() };
  const app = new Hono();
  registerTerminalRoutes(app, vi.fn() as never, async () => workspace, manager as unknown as TerminalManager);
  const auth = await app.request('http://localhost/api/terminals/bootstrap', { method: 'POST', headers: { origin: 'http://localhost', 'x-contextspace-terminal': 'bootstrap' } });
  const { token } = await auth.json();
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
  const post = (action: string, body: object = {}) => app.request(`http://localhost/api/terminals/workspace/${action}`, {
    method: 'POST', headers: { origin: 'http://localhost', 'x-contextspace-terminal': token, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { manager, post };
}

it('does not start a terminal in an archived workspace, and says why', async () => {
  await writeManifest({ archivedAt: '2026-09-28T10:00:00.000Z' });
  const { manager, post } = await fixture();
  const response = await post('create', { target: 'shell', launchId: crypto.randomUUID() });
  expect(response.status).toBe(400);
  expect((await response.json() as { error: string }).error).toMatch(/is archived, so it cannot start assistant sessions/);
  expect(manager.create).not.toHaveBeenCalled();
});

it('still stops a terminal of an archived workspace, so leftovers can be cleaned up', async () => {
  await writeManifest({ archivedAt: '2026-09-28T10:00:00.000Z' });
  const { manager, post } = await fixture();
  const id = crypto.randomUUID();
  expect((await post(`${id}/stop`)).status).toBe(200);
  expect(manager.stop).toHaveBeenCalledWith(expect.any(String), 'workspace', id);
});

it('starts a terminal again once the workspace is restored', async () => {
  await writeManifest({ archivedAt: '2026-09-28T10:00:00.000Z' });
  const { manager, post } = await fixture();
  const body = { target: 'shell', launchId: crypto.randomUUID() };
  expect((await post('create', body)).status).toBe(400);
  await writeManifest();
  const restored = await post('create', body);
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(manager.create).toHaveBeenCalledTimes(1);
});
