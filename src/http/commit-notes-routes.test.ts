import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { addCommitNote } from '../core/commit-notes.js';
import { registerCommitNotesRoutes } from './commit-notes-routes.js';

let tempDir: string;
let workspaceDir: string;
let app: Hono;
let c1: string;
let c2: string;

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
};

async function initRepo(repoPath: string): Promise<[string, string]> {
  await fs.mkdir(repoPath, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: repoPath, env: { ...process.env, ...gitEnv } });
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'a\n');
  await execa('git', ['add', 'a.txt'], { cwd: repoPath, env: { ...process.env, ...gitEnv } });
  await execa('git', ['commit', '-m', 'First'], { cwd: repoPath, env: { ...process.env, ...gitEnv } });
  const first = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim();

  await fs.writeFile(path.join(repoPath, 'b.txt'), 'b\n');
  await execa('git', ['add', 'b.txt'], { cwd: repoPath, env: { ...process.env, ...gitEnv } });
  await execa('git', ['commit', '-m', 'Second'], {
    cwd: repoPath,
    env: { ...process.env, ...gitEnv, GIT_AUTHOR_DATE: '2026-10-01T11:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T11:00:00Z' },
  });
  const second = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim();
  return [first, second];
}

async function get(query = '', workspaceId = 'ws-1') {
  const res = await app.request(`/api/workspace/${encodeURIComponent(workspaceId)}/commit-notes${query}`);
  return { status: res.status, body: await res.json() as Record<string, any> };
}

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'commit-notes-route-')));
  workspaceDir = path.join(tempDir, 'ws');
  [c1, c2] = await initRepo(path.join(workspaceDir, 'NexusFlow'));
  await fs.writeFile(
    path.join(workspaceDir, 'contextspace.json'),
    JSON.stringify({
      id: 'ws-1',
      name: 'ws-1',
      branchName: 'main',
      repos: ['NexusFlow'],
      assistants: [],
      workspacePath: workspaceDir,
    }),
  );

  app = new Hono();
  registerCommitNotesRoutes(app, async (id) => (id === 'ws-1' ? workspaceDir : null));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('GET /api/workspace/:id/commit-notes', () => {
  it('returns 404 when workspace is unknown and exposes no POST write route', async () => {
    expect(await get('', 'missing')).toEqual({ status: 404, body: { error: 'Workspace not found.' } });

    const writeAttempt = await app.request('/api/workspace/ws-1/commit-notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commit: 'HEAD', text: 'GUI write forbidden' }),
    });
    expect(writeAttempt.status).toBe(404);
  });

  it('lists all notes newest first when repo and sha are omitted or empty, and filters by repo and sha', async () => {
    expect(await get('?repo=&sha=')).toEqual({ status: 200, body: { notes: [] } });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T09:00:00.000Z'));
    const first = await addCommitNote(workspaceDir, {
      commit: c1,
      text: 'Conflict decision\nKept both imports.',
      by: 'claude',
    });

    vi.setSystemTime(new Date('2026-10-12T09:05:00.000Z'));
    const second = await addCommitNote(workspaceDir, {
      commit: c2.slice(0, 7),
      text: 'Second note',
    });

    const all = await get('?repo=&sha=');
    expect(all.status).toBe(200);
    expect(all.body.notes.map((n: { id: string }) => n.id)).toEqual([second.note.id, first.note.id]);
    expect(all.body.notes[1]).toMatchObject({
      repo: 'NexusFlow',
      sha: c1,
      shortSha: c1.slice(0, 7),
      title: 'Conflict decision',
      body: 'Conflict decision\nKept both imports.',
      by: 'claude',
      at: '2026-10-12T09:00:00.000Z',
    });

    const filtered = await get(`?repo=NexusFlow&sha=${c1.slice(0, 7)}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.notes.map((n: { id: string }) => n.id)).toEqual([first.note.id]);

    expect((await get('?repo=NexusFlow&sha=0000000'))).toEqual({ status: 200, body: { notes: [] } });
    expect((await get('?sha=bad')).status).toBe(400);
  });
});
