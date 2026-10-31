import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { execa } from 'execa';
import { registerCommitRoutes } from './commit-routes.js';
import * as commitDetail from '../core/commit-detail.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';

describe('commit routes', () => {
  let root: string;
  let repoDir: string;
  let app: Hono;
  let validSha: string;

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'commit-routes-test-')));
    repoDir = path.join(root, 'my-repo');
    await fs.mkdir(repoDir);

    const env = {
      GIT_AUTHOR_NAME: 'Alice Developer',
      GIT_AUTHOR_EMAIL: 'alice@example.com',
      GIT_AUTHOR_DATE: '2026-05-01T10:00:00Z',
      GIT_COMMITTER_NAME: 'Alice Developer',
      GIT_COMMITTER_EMAIL: 'alice@example.com',
      GIT_COMMITTER_DATE: '2026-05-01T10:00:00Z',
    };

    await execa('git', ['init', '-b', 'main'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'index.ts'), 'console.log("hello");\n');
    await execa('git', ['add', '.'], { cwd: repoDir, env });
    await execa('git', ['commit', '-m', 'feat: initial feature\n\nBody message here.'], { cwd: repoDir, env });

    const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    validSha = stdout.trim();

    await fs.writeFile(
      path.join(root, 'contextspace.json'),
      JSON.stringify({
        id: 'ws-1',
        name: 'Workspace 1',
        branchName: 'main',
        repos: [repoDir],
        assistants: [],
        workspacePath: root,
      }),
    );

    app = new Hono();
    registerCommitRoutes(app, async (id) => (id === 'ws-1' ? root : null));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns 200 with full commit detail shape for valid request', async () => {
    const res = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toMatchObject({
      repo: 'my-repo',
      sha: validSha,
      shortSha: validSha.slice(0, 7),
      author: 'Alice Developer',
      subject: 'feat: initial feature',
      body: 'Body message here.',
      parents: [],
      moreFiles: 0,
      additions: 1,
      deletions: 0,
      pushed: false,
      forge: null,
      webUrl: null,
    });
    expect(data.files).toEqual([
      {
        path: 'index.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it('returns 400 for bad sha format', async () => {
    const res = await app.request('/api/workspace/ws-1/commits/my-repo/not-a-valid-sha');
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeTruthy();
    expect(data.error).toContain('SHA');
  });

  it('returns 404 for unknown workspace', async () => {
    const res = await app.request(`/api/workspace/unknown-ws/commits/my-repo/${validSha}`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Workspace not found.');
  });

  it('returns 404 for unknown repo in workspace', async () => {
    const res = await app.request(`/api/workspace/ws-1/commits/non-existent-repo/${validSha}`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found');
  });

  it('returns 404 for unknown commit sha in valid repo', async () => {
    const fakeSha = 'b'.repeat(40);
    const res = await app.request(`/api/workspace/ws-1/commits/my-repo/${fakeSha}`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found');
  });

  it('returns 500 and generic message when unexpected error occurs', async () => {
    const spy = vi.spyOn(commitDetail, 'readCommit').mockRejectedValueOnce(new Error('/abs/path secret git stderr'));
    const res = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}`);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data).toEqual({ error: 'Could not read this commit.' });
    expect(JSON.stringify(data)).not.toContain('/abs/path');
    spy.mockRestore();
  });

  it('returns 413 when commit is too large', async () => {
    const spy = vi.spyOn(commitDetail, 'readCommit').mockRejectedValueOnce(new commitDetail.CommitTooLargeError());
    const res = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}`);
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data).toEqual({ error: 'This commit is too large to list.' });
    spy.mockRestore();
  });

  it('accepts uppercase sha and normalizes to lowercase', async () => {
    const res = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha.toUpperCase()}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sha).toBe(validSha);
  });
});
