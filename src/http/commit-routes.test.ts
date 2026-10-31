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

  describe('commit file diff endpoint', () => {
    it('returns 200 with valid diff response shape', async () => {
      const res = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff?file=index.ts`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({
        repo: 'my-repo',
        repoPath: repoDir,
        sha: validSha,
        file: 'index.ts',
        fileContent: 'console.log("hello");\n',
        originalContent: '',
      });
      expect(data.diff).toContain('+console.log("hello");');
      expect(Array.isArray(data.symbols)).toBe(true);
    });

    it('returns 400 when file query param is missing or invalid', async () => {
      // Missing ?file=
      const resNoFile = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff`);
      expect(resNoFile.status).toBe(400);
      expect((await resNoFile.json()).error).toContain('File query parameter is required');

      // Empty ?file=
      const resEmptyFile = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff?file=`);
      expect(resEmptyFile.status).toBe(400);

      // Traversal ../secret.txt
      const resTraversal = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff?file=../secret.txt`);
      expect(resTraversal.status).toBe(400);
      expect((await resTraversal.json()).error).toContain('Invalid repository file path');

      // Absolute /etc/passwd
      const resAbsolute = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff?file=/etc/passwd`);
      expect(resAbsolute.status).toBe(400);
      expect((await resAbsolute.json()).error).toContain('Invalid repository file path');

      // Bad sha format
      const resBadSha = await app.request('/api/workspace/ws-1/commits/my-repo/not-hex/diff?file=index.ts');
      expect(resBadSha.status).toBe(400);
      expect((await resBadSha.json()).error).toContain('SHA');
    });

    it('returns 404 when workspace, repo, commit, or file is not found', async () => {
      // Unknown workspace
      const resWs = await app.request(`/api/workspace/unknown-ws/commits/my-repo/${validSha}/diff?file=index.ts`);
      expect(resWs.status).toBe(404);
      expect((await resWs.json()).error).toBe('Workspace not found.');

      // Unknown repo
      const resRepo = await app.request(`/api/workspace/ws-1/commits/non-existent-repo/${validSha}/diff?file=index.ts`);
      expect(resRepo.status).toBe(404);
      expect((await resRepo.json()).error).toContain('not found');

      // Unknown commit
      const fakeSha = 'c'.repeat(40);
      const resSha = await app.request(`/api/workspace/ws-1/commits/my-repo/${fakeSha}/diff?file=index.ts`);
      expect(resSha.status).toBe(404);
      expect((await resSha.json()).error).toContain('not found');

      // File not changed in commit
      const resFile = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff?file=non-existent.txt`);
      expect(resFile.status).toBe(404);
      expect((await resFile.json()).error).toContain('was not changed');
    });

    it('returns 200 with contentOmitted: too-large, diffOmitted: true, and contentOmitted: binary', async () => {
      const spy = vi.spyOn(commitDetail, 'readCommitFileDiff');

      // 1. contentOmitted: too-large
      spy.mockResolvedValueOnce({
        repo: 'my-repo',
        repoPath: repoDir,
        sha: validSha,
        file: 'index.ts',
        diff: 'some diff',
        fileContent: '',
        originalContent: '',
        symbols: [],
        contentOmitted: 'too-large',
      });
      const resTooLarge = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff?file=index.ts`);
      expect(resTooLarge.status).toBe(200);
      const dataTooLarge = await resTooLarge.json();
      expect(dataTooLarge.contentOmitted).toBe('too-large');
      expect(dataTooLarge.diff).toBe('some diff');

      // 2. diffOmitted: true
      spy.mockResolvedValueOnce({
        repo: 'my-repo',
        repoPath: repoDir,
        sha: validSha,
        file: 'index.ts',
        diff: '',
        fileContent: '',
        originalContent: '',
        symbols: [],
        contentOmitted: 'too-large',
        diffOmitted: true,
      });
      const resDiffOmitted = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff?file=index.ts`);
      expect(resDiffOmitted.status).toBe(200);
      const dataDiffOmitted = await resDiffOmitted.json();
      expect(dataDiffOmitted.diffOmitted).toBe(true);
      expect(dataDiffOmitted.contentOmitted).toBe('too-large');

      // 3. contentOmitted: binary
      spy.mockResolvedValueOnce({
        repo: 'my-repo',
        repoPath: repoDir,
        sha: validSha,
        file: 'image.png',
        diff: 'Binary files differ\n',
        fileContent: '',
        originalContent: '',
        symbols: [],
        contentOmitted: 'binary',
      });
      const resBinary = await app.request(`/api/workspace/ws-1/commits/my-repo/${validSha}/diff?file=image.png`);
      expect(resBinary.status).toBe(200);
      const dataBinary = await resBinary.json();
      expect(dataBinary.contentOmitted).toBe('binary');
      expect(dataBinary.diff).toBe('Binary files differ\n');

      spy.mockRestore();
    });
  });
});
