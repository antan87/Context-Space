import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { registerWorkspaceReferenceRoutes } from './workspace-reference-routes.js';

vi.mock('node:fs/promises', { spy: true });

describe('read-only workspace reference route', () => {
  let temp: string, root: string, app: Hono;
  const request = (query = '?path=local.ts', id = 'exact') => app.request(`/api/workspace/${id}/files/reference${query}`);
  beforeEach(async () => {
    temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reference-route-')));
    root = path.join(temp, 'workspace'); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ repos: [], mode: 'worktree' }));
    await fs.writeFile(path.join(root, 'local.ts'), 'private content');
    app = new Hono();
    registerWorkspaceReferenceRoutes(app, async (id) => id === 'exact' ? root : null);
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });
  it('returns origin metadata and no contents/tokens through an exact workspace lookup', async () => {
    const response = await request();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'found', target: { origin: { kind: 'workspace', workspacePath: root }, file: 'local.ts', viewer: 'code' } });
    for (const id of ['unknown', 'exac', 'root']) expect((await request('?path=local.ts', id)).status).toBe(404);
    expect((await request('')).status).toBe(400);
    expect((await app.request('/api/workspace/exact/files/reference?path=local.ts', { method: 'POST' })).status).toBe(404);
  });
  it('reports directory/missing/outside without external absolute path echo', async () => {
    await fs.mkdir(path.join(root, 'folder'));
    for (const [name, reason] of [['folder', 'directory'], ['missing.ts', 'missing'], [path.join(root, '..', 'secret.ts'), 'outside-roots']]) {
      expect(await (await request(`?path=${encodeURIComponent(name!)}`)).json()).toEqual({ status: 'not-found', reason });
    }
  });
  it('fails closed for malformed and missing manifests', async () => {
    await fs.writeFile(path.join(root, 'contextspace.json'), '{');
    expect((await request()).status).toBe(400);
    await fs.rm(path.join(root, 'contextspace.json'));
    expect((await request()).status).toBe(400);
  });
  it('forwards cwd and suffix listing to the resolver', async () => {
    const repo = path.join(root, 'api'); await fs.mkdir(path.join(repo, 'nested'), { recursive: true });
    await fs.writeFile(path.join(repo, 'nested/only.ts'), 'code');
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ repos: [repo], mode: 'worktree' }));
    app = new Hono(); registerWorkspaceReferenceRoutes(app, async () => root, async () => ['nested/only.ts']);
    for (const query of ['?path=only.ts', `?path=only.ts&cwd=${encodeURIComponent(path.join(repo, 'nested'))}`]) {
      expect((await (await request(query)).json()).target.origin).toEqual({ kind: 'repository', repoName: 'api', repoPath: repo });
    }
  });
  it('uses the production filename-only enumeration without reading unrelated external symlink content', async () => {
    const repo = path.join(root, 'api');
    const outside = path.join(temp, 'outside.txt');
    await fs.mkdir(path.join(repo, 'nested'), { recursive: true });
    await fs.writeFile(outside, 'EXTERNAL-SENTINEL');
    await fs.writeFile(path.join(repo, 'nested/unique.ts'), 'code');
    await fs.symlink(outside, path.join(repo, 'unrelated.txt'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    expect(execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('.git');
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ repos: [repo], mode: 'worktree' }));
    // The default dependency is also what server.ts registers in production.
    app = new Hono(); registerWorkspaceReferenceRoutes(app, async () => root);
    const stat = vi.mocked(fs.stat); stat.mockClear();
    const read = vi.mocked(fs.readFile); read.mockClear();
    expect((await (await request('?path=missing.ts')).json()).status).toBe('not-found');
    expect(await (await request('?path=unique.ts')).json()).toEqual({ status: 'found', target: {
      origin: { kind: 'repository', repoName: 'api', repoPath: repo }, file: 'nested/unique.ts', viewer: 'code',
    } });
    expect({
      stat: stat.mock.calls.filter(([name]) => String(name) === outside || String(name) === path.join(repo, 'unrelated.txt')),
      read: read.mock.calls.filter(([name]) => String(name) !== path.join(root, 'contextspace.json')),
    }).toEqual({ stat: [], read: [] });
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [path.join(repo, 'unrelated-pipe')]);
      expect((await (await request('?path=missing.ts')).json()).status).toBe('not-found');
      expect((await (await request('?path=unrelated-pipe')).json()).status).toBe('not-found');
    }
  });

});
