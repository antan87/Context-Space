import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Hono } from 'hono';
import { registerWorkspaceFileRoutes } from './workspace-file-routes.js';
import { listWorkspaceFiles } from '../core/workspace-files.js';

describe('workspace-owned file routes', () => {
  let root: string;
  let app: Hono;
  const manifest = async (extra: object = {}) => fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ repos: [], mode: 'worktree', ...extra }));
  const put = async (name: string, content: string | Buffer = 'hello') => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), content); };
  const get = (name?: string, id = 'demo') => app.request(`/api/workspace/${id}/files${name === undefined ? '' : `/read?file=${encodeURIComponent(name)}`}`);
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-files-')));
    await manifest();
    app = new Hono();
    registerWorkspaceFileRoutes(app, async (id) => id === 'demo' ? root : null);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('lists sorted workspace code/config/extensionless files and reads without Git', async () => {
    await put('src/local.ts', 'export const local = true;');
    await put('Makefile'); await put('config.yaml'); await put('.agents/helper.ts');
    const listing = await (await get()).json();
    expect(listing.files.map((file: { path: string }) => file.path)).toEqual(['.agents/helper.ts', 'config.yaml', 'contextspace.json', 'Makefile', 'src/local.ts']);
    expect(listing.truncated).toBe(false);
    expect(await (await get('src/local.ts')).json()).toEqual({ content: 'export const local = true;' });
    expect((await get(undefined, 'unknown')).status).toBe(404);
  });

  it('fails closed for missing, malformed and invalid configuration', async () => {
    for (const content of ['', '{', '{"repos":{}}', '{"repos":[17]}', '{"repos":["relative"]}', '{"repos":[],"isolatedRepos":{"api":{}}}', '{"repos":[],"originalRepos":{}}', '{"repos":[],"originalRepos":[17]}', '{"repos":[],"originalRepos":["relative"]}']) {
      await fs.writeFile(path.join(root, 'contextspace.json'), content);
      expect((await get()).status).toBe(400);
      expect((await get('contextspace.json')).status).toBe(400);
    }
    await fs.rm(path.join(root, 'contextspace.json'));
    expect((await get()).status).toBe(400);
  });

  it('excludes configured source and resolved isolated roots, including equal workspace root', async () => {
    await put('source/src/shared.ts'); await put('isolated-api/src/shared.ts'); await put('src/shared.ts', 'workspace');
    await manifest({ mode: 'in-place', repos: [path.join(root, 'source')], isolatedRepos: { source: { worktreePath: path.join(root, 'isolated-api') } } });
    const files = (await (await get()).json()).files;
    expect(files).toContainEqual(expect.objectContaining({ path: 'src/shared.ts' }));
    expect(files.some((file: { path: string }) => /^(source|isolated-api)\//.test(file.path))).toBe(false);
    for (const name of ['source/src/shared.ts', 'isolated-api/src/shared.ts']) expect((await get(name)).status).toBe(400);
    await manifest({ repos: ['/external/api'] });
    await put('api/local.ts');
    expect((await (await get()).json()).files).not.toContainEqual(expect.objectContaining({ path: 'api/local.ts' }));
    await manifest({ mode: 'in-place', repos: [root] });
    expect((await (await get()).json()).files).toEqual([]);
    expect((await get('src/shared.ts')).status).toBe(400);
  });

  it('excludes original checkout roots in worktree manifests without hiding workspace-owned files', async () => {
    await put('source/api/src/shared.ts', 'original checkout');
    await put('api/src/shared.ts', 'resolved worktree');
    await put('src/shared.ts', 'workspace');
    await manifest({ repos: [path.join(root, 'api')], originalRepos: [path.join(root, 'source/api')] });
    const listing = await (await get()).json();
    expect(listing.files).toContainEqual(expect.objectContaining({ path: 'src/shared.ts' }));
    expect(listing.files).not.toContainEqual(expect.objectContaining({ path: 'source/api/src/shared.ts' }));
    expect(listing.files).not.toContainEqual(expect.objectContaining({ path: 'api/src/shared.ts' }));
    expect((await get('source/api/src/shared.ts')).status).toBe(400);
    expect((await get('api/src/shared.ts')).status).toBe(400);
    expect(await (await get('src/shared.ts')).json()).toEqual({ content: 'workspace' });

    await manifest({ repos: [path.join(root, 'api')], originalRepos: [root] });
    expect((await (await get()).json()).files).toEqual([]);
    expect((await get('src/shared.ts')).status).toBe(400);
  });

  it('rejects traversal, drive/stream/control and linked or nonregular files before open', async () => {
    await put('src/local.ts'); await put('.private/secret.ts'); await put('node_modules/dependency.ts');
    await fs.symlink(path.join(root, 'src'), path.join(root, 'linked'));
    await fs.symlink(path.join(root, 'src/local.ts'), path.join(root, 'linked.ts'));
    for (const name of ['../outside', '/etc/passwd', 'C:/file', 'file:stream', 'src\\local.ts', 'src/../src/local.ts', 'src//local.ts', 'src/./local.ts', 'bad\0name', '.private/secret.ts', 'node_modules/dependency.ts', 'linked/local.ts', 'linked.ts', 'missing.ts', 'src']) {
      expect((await get(name)).status, name).toBe(400);
    }
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [path.join(root, 'pipe')]);
      expect((await get('pipe')).status).toBe(400);
    }
    const listed = (await (await get()).json()).files.map((file: { path: string }) => file.path);
    expect(listed).toEqual(['contextspace.json', 'src/local.ts']);
  });

  it('omits binary and files over 1 MiB and accepts exactly 1 MiB', async () => {
    await put('binary.dat', Buffer.from([1, 0, 2]));
    await put('large.ts', 'x'.repeat(1024 * 1024 + 1));
    await put('limit.ts', 'x'.repeat(1024 * 1024));
    expect(await (await get('binary.dat')).json()).toEqual({ content: '', omitted: 'binary' });
    expect(await (await get('large.ts')).json()).toEqual({ content: '', omitted: 'too-large' });
    expect((await (await get('limit.ts')).json()).content.length).toBe(1024 * 1024);
  });

  it('reports bounded depth and entry coverage rather than claiming completeness', async () => {
    await put('a/b/c/d/e/visible.ts');
    await put('a/b/c/d/e/f/hidden-by-depth.ts');
    let result = await listWorkspaceFiles(root);
    expect(result.files).toContainEqual(expect.objectContaining({ path: 'a/b/c/d/e/visible.ts' }));
    expect(result.files).not.toContainEqual(expect.objectContaining({ path: 'a/b/c/d/e/f/hidden-by-depth.ts' }));
    expect(result.truncated).toBe(true);
    // Hidden entries count too, so a directory of ignored names cannot evade the work cap.
    for (let batch = 0; batch < 101; batch++) await Promise.all(Array.from({ length: 100 }, (_, i) => put(`.ignored-${batch * 100 + i}`)));
    result = await listWorkspaceFiles(root);
    expect(result.truncated).toBe(true);
    expect(result.limits).toEqual({ depth: 5, entries: 10_000 });
  });

  it('includes modifiedAt ISO string and byte size for each file while keeping exclusions', async () => {
    const sample = 'hello workspace files\n';
    await put('PLAN.md', sample);
    await put('.hidden/secret.md', 'no');
    await put('node_modules/pkg/index.js', 'no');

    const stat = await fs.lstat(path.join(root, 'PLAN.md'));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    const planEntry = body.files.find((f: { path: string }) => f.path === 'PLAN.md');
    expect(planEntry).toEqual({
      path: 'PLAN.md',
      modifiedAt: stat.mtime.toISOString(),
      size: Buffer.byteLength(sample, 'utf8'),
    });
    expect(body.files.some((f: { path: string }) => f.path.includes('secret.md') || f.path.includes('node_modules'))).toBe(false);
  });
});
