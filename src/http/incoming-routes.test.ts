import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { execa } from 'execa';
import { registerIncomingRoutes } from './incoming-routes.js';
import { resetIncomingCommitsState, waitForIncomingFetches } from '../core/incoming-commits.js';

const git = async (cwd: string, ...args: string[]) => {
  const { stdout } = await execa('git', args, { cwd });
  return stdout;
};

describe('incoming routes', { timeout: 60_000 }, () => {
  let root: string;
  let ws: string;
  let bare: string;
  let repo: string;
  let maria: string;
  let fakeNow: number;
  let app: Hono;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    resetIncomingCommitsState();
    fakeNow = Date.parse('2026-11-14T12:00:00.000Z');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'incoming-routes-')));
    const testHome = path.join(root, 'home');
    await fs.mkdir(testHome);
    savedEnv = {
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
      GIT_SSH: process.env.GIT_SSH,
    };
    process.env.HOME = testHome;
    process.env.GIT_CONFIG_GLOBAL = path.join(testHome, '.gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;

    ws = path.join(root, 'ws');
    bare = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    repo = path.join(ws, 'app');
    maria = path.join(root, 'maria');

    await fs.mkdir(ws);
    await execa('git', ['init', '--bare', '-b', 'main', bare]);
    await execa('git', ['clone', bare, seed]);
    await git(seed, 'config', 'user.name', 'Seed');
    await git(seed, 'config', 'user.email', 'seed@example.com');
    await fs.writeFile(path.join(seed, 'init.txt'), 'init\n');
    await git(seed, 'add', 'init.txt');
    await git(seed, 'commit', '-m', 'Initial commit');
    await git(seed, 'push', '-u', 'origin', 'main');

    await execa('git', ['clone', '-b', 'main', bare, repo]);
    await execa('git', ['clone', '-b', 'main', bare, maria]);
    await git(maria, 'config', 'user.name', 'Maria');
    await git(maria, 'config', 'user.email', 'maria@example.com');

    await fs.writeFile(
      path.join(ws, 'contextspace.json'),
      JSON.stringify({
        id: 'canvas',
        name: 'Canvas',
        branchName: 'main',
        repos: [repo],
        assistants: [],
        workspacePath: ws,
      }),
    );

    app = new Hono();
    registerIncomingRoutes(app, async (id) => (id === 'canvas' ? ws : null), {
      now: () => fakeNow,
    });
  });

  afterEach(async () => {
    await waitForIncomingFetches();
    resetIncomingCommitsState();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const pushAsMaria = async (subject: string, file: string) => {
    await fs.writeFile(path.join(maria, file), `${subject}\n`);
    await git(maria, 'add', file);
    await git(maria, 'commit', '-m', subject);
    await git(maria, 'push', 'origin', 'HEAD');
  };

  it('returns 404 for an unknown workspace and 400 when workspace resolution rejects unsafe ids', async () => {
    const res = await app.request('/api/workspace/missing/incoming');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Workspace not found.' });

    const guarded = new Hono();
    registerIncomingRoutes(guarded, async (id) => {
      if (id.includes('..')) throw new Error('Invalid workspace path');
      return null;
    });
    const bad = await guarded.request(`/api/workspace/${encodeURIComponent('../outside')}/incoming`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid workspace path' });
  });

  it('returns the expected shape and updates on ?refresh=1 while throttling within 30s', async () => {
    const first = await app.request('/api/workspace/canvas/incoming');
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({
      at: '2026-11-14T12:00:00.000Z',
      repos: [
        {
          repo: 'app',
          remote: 'origin',
          branch: 'main',
          host: { kind: 'unknown', name: 'local' },
          fetching: true,
          state: 'ok',
          message: null,
          behind: 0,
          commits: [],
          more: 0,
        },
      ],
    });
    await waitForIncomingFetches();

    // Push from second clone, advance 15s, call ?refresh=1 -> throttled (< 30s)
    await pushAsMaria('Maria commit 1', 'one.txt');
    fakeNow += 15_000;
    const throttled = await app.request('/api/workspace/canvas/incoming?refresh=1');
    expect(throttled.status).toBe(200);
    const throttledBody = await throttled.json();
    expect(throttledBody.repos[0]).toMatchObject({
      fetching: false,
      state: 'ok',
      behind: 0,
      commits: [],
      more: 0,
    });

    // Advance another 15s (total 30s), call ?refresh=1 -> fetches and shows Maria commit 1
    fakeNow += 15_000;
    const refreshed = await app.request('/api/workspace/canvas/incoming?refresh=1');
    expect(refreshed.status).toBe(200);
    const refreshedBody = await refreshed.json();
    expect(refreshedBody.repos[0]).toMatchObject({
      fetching: false,
      state: 'ok',
      behind: 1,
      more: 0,
      lastFetchAt: '2026-11-14T12:00:30.000Z',
    });
    expect(refreshedBody.repos[0].commits).toHaveLength(1);
    expect(refreshedBody.repos[0].commits[0]).toMatchObject({
      author: 'Maria',
      subject: 'Maria commit 1',
      fileCount: 1,
      incoming: true,
    });

    // Pulling empties incoming commits again
    await git(repo, 'pull', '--ff-only', 'origin', 'main');
    const afterPull = await app.request('/api/workspace/canvas/incoming');
    expect(afterPull.status).toBe(200);
    expect((await afterPull.json()).repos[0]).toMatchObject({
      behind: 0,
      commits: [],
      more: 0,
    });
  });
});
