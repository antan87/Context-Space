import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveWorkspaceReference } from './workspace-reference-resolve.js';

vi.mock('node:fs/promises', { spy: true });

// Every path and special file belongs to this disposable fixture; no Git commands or external reads.
describe('explicit workspace reference origins', () => {
  let temp: string, root: string, api: string, web: string;
  const put = async (base: string, name: string, contents: string | Buffer = 'hello') => {
    await fs.mkdir(path.dirname(path.join(base, name)), { recursive: true });
    await fs.writeFile(path.join(base, name), contents);
  };
  const manifest = async (extra: object = {}) => put(root, 'contextspace.json', JSON.stringify({ mode: 'worktree', repos: [api, web], ...extra }));
  const resolve = (name: string, cwd?: string) => resolveWorkspaceReference(root, name, { cwd });
  const workspace = (file: string, viewer = 'code') => ({ status: 'found', target: { origin: { kind: 'workspace', workspacePath: root }, file, viewer } });
  const repository = (repoPath: string, file: string, viewer = 'code') => ({ status: 'found', target: { origin: { kind: 'repository', repoName: path.basename(repoPath), repoPath }, file, viewer } });
  beforeEach(async () => {
    temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-reference-')));
    root = path.join(temp, 'workspace'); api = path.join(root, 'api'); web = path.join(root, 'web');
    await fs.mkdir(api, { recursive: true }); await fs.mkdir(web);
    await manifest();
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });

  it('classifies workspace code/config/extensionless, documents, media and HTML without loading contents', async () => {
    for (const name of ['local.ts', 'config.json', 'config.yaml', 'Makefile', 'docs/guide.md', 'photo.png', 'page.html', 'deck.pptx', 'huge.md', 'binary.dat']) await put(root, name);
    await put(root, 'huge.md', 'x'.repeat(1024 * 1024 + 1));
    await put(root, 'binary.dat', Buffer.from([0, 1, 2]));
    const read = vi.mocked(fs.readFile); read.mockClear();
    for (const name of ['local.ts', 'config.json', 'config.yaml', 'Makefile', 'binary.dat']) expect(await resolve(name)).toEqual(workspace(name));
    for (const name of ['docs/guide.md', 'photo.png', 'page.html', 'deck.pptx', 'huge.md']) expect(await resolve(name)).toEqual(workspace(name, 'reader'));
    expect(read.mock.calls.every(([name]) => String(name).endsWith('contextspace.json') || String(name).endsWith('nexusflow.json'))).toBe(true);
  });

  it('preserves mixed exact ambiguity while absolute paths, qualified paths and cwd identify the actual origin', async () => {
    for (const base of [root, api, web]) await put(base, 'src/shared.ts');
    const result = await resolve('src/shared.ts');
    expect(result).toEqual({ status: 'ambiguous', candidates: [workspace('src/shared.ts').target, repository(api, 'src/shared.ts').target, repository(web, 'src/shared.ts').target], truncated: false });
    expect(await resolve(path.join(root, 'src/shared.ts'))).toEqual(workspace('src/shared.ts'));
    expect(await resolve(path.join(api, 'src/shared.ts'))).toEqual(repository(api, 'src/shared.ts'));
    expect(await resolve('api/src/shared.ts')).toEqual(repository(api, 'src/shared.ts'));
    expect(await resolve('src/shared.ts', api)).toEqual(repository(api, 'src/shared.ts'));
    expect(await resolve('../shared.ts', path.join(web, 'src/nested'))).toEqual(repository(web, 'src/shared.ts'));
    await fs.rm(path.join(api, 'src/shared.ts'));
    expect(await resolve('src/shared.ts', api)).toEqual({ status: 'not-found', reason: 'missing' });
    expect(await resolve('src/shared.ts', temp)).toEqual({ status: 'not-found', reason: 'outside-roots' });
  });

  it('maps normal-worktree stored and original-source absolute and cwd aliases to the selected checkout', async () => {
    const source = path.join(root, 'source/api');
    await put(source, 'src/guide.md', 'source'); await put(api, 'src/guide.md', 'worktree');
    await manifest({ originalRepos: [source] });
    expect(await resolve(path.join(source, 'src/guide.md'))).toEqual(repository(api, 'src/guide.md', 'reader'));
    expect(await resolve('../guide.md', path.join(source, 'src/nested'))).toEqual(repository(api, 'src/guide.md', 'reader'));
    await fs.rm(path.join(api, 'src/guide.md'));
    expect(await resolve(path.join(source, 'src/guide.md'))).toEqual({ status: 'not-found', reason: 'missing' });
    await manifest({ repos: [source], originalRepos: [source] });
    await put(api, 'src/guide.md');
    expect(await resolve(path.join(source, 'src/guide.md'))).toEqual(repository(api, 'src/guide.md', 'reader'));
  });

  it('maps in-place isolation aliases and external reference repositories without inventing workspace ownership', async () => {
    const source = path.join(temp, 'external/api');
    const isolated = path.join(root, 'isolated-api');
    await put(source, 'config.json'); await put(isolated, 'config.json');
    await manifest({ mode: 'in-place', repos: [source], isolatedRepos: { api: { worktreePath: isolated } } });
    const isolatedResult = { status: 'found', target: { origin: { kind: 'repository', repoName: 'api', repoPath: isolated }, file: 'config.json', viewer: 'code' } };
    expect(await resolve(path.join(source, 'config.json'))).toEqual(isolatedResult);
    expect(await resolve('config.json', source)).toEqual(isolatedResult);
    expect(await resolve('api/config.json')).toEqual(isolatedResult);
    await manifest({ mode: 'in-place', repos: [source] });
    expect(await resolve(path.join(source, 'config.json'))).toEqual(repository(source, 'config.json'));
    await manifest({ mode: 'in-place', repos: [root] });
    await put(root, 'local.ts');
    expect(await resolve('local.ts')).toEqual(repository(root, 'local.ts'));
  });

  it('never leaks original source roots into Workspace, including unmatched roots and root equality', async () => {
    await put(root, 'original/not-mapped.ts');
    await manifest({ repos: [], originalRepos: [path.join(root, 'original')] });
    expect((await resolve('original/not-mapped.ts')).status).toBe('not-found');
    await manifest({ repos: [], originalRepos: [root] });
    expect((await resolve('contextspace.json')).status).toBe('not-found');
  });

  it('fails closed on missing, malformed and duplicate repository names or overlapping aliases', async () => {
    for (const content of ['{', '{"repos":[],"mode":"invalid"}', '{"repos":[17],"mode":"worktree"}', '{"repos":["relative"],"mode":"worktree"}', '{"repos":[],"mode":"in-place","isolatedRepos":{"api":{}}}']) {
      await put(root, 'contextspace.json', content);
      await expect(resolve('local.ts')).rejects.toThrow();
    }
    await fs.rm(path.join(root, 'contextspace.json'));
    await expect(resolve('local.ts')).rejects.toThrow();
    await manifest({ repos: [path.join(temp, 'one/api'), path.join(temp, 'two/api')] });
    await expect(resolve('local.ts')).rejects.toThrow('Ambiguous');
    await manifest({ originalRepos: [path.join(temp, 'one/api'), path.join(temp, 'two/api')] });
    await expect(resolve('local.ts')).rejects.toThrow('Ambiguous');
    await manifest({ isolatedRepos: [] });
    await expect(resolve('local.ts')).rejects.toThrow();
    await manifest({ repos: [api, web], originalRepos: [path.join(temp, 'source/api'), path.join(temp, 'source/api/web')] });
    await expect(resolve(path.join(temp, 'source/api/web/file.ts'))).rejects.toThrow('Ambiguous');
  });

  it('does not return a parent-repository reader target that its serving scope excludes', async () => {
    const nested = path.join(api, 'web');
    await put(nested, 'guide.md');
    await manifest({ mode: 'in-place', repos: [api, nested] });
    expect(await resolve(path.join(nested, 'guide.md'))).toEqual(repository(nested, 'guide.md', 'reader'));
    expect((await resolve('api/web/guide.md')).status).toBe('not-found');
  });

  it('rejects missing, directories, workspace hidden/ignored, linked, special and unsafe paths', async () => {
    await put(root, 'src/local.ts'); await put(root, '.private/secret.md'); await put(root, 'node_modules/dependency.ts');
    await fs.symlink(path.join(root, 'src'), path.join(root, 'linked'));
    await fs.symlink(path.join(root, 'src/local.ts'), path.join(root, 'link.ts'));
    await fs.symlink(path.join(root, 'src/local.ts'), path.join(api, 'link.ts'));
    await put(api, 'src/local.ts'); await fs.symlink(path.join(api, 'src'), path.join(api, 'linked'));
    await put(api, '.private/guide.md');
    for (const name of ['missing.ts', '.private/secret.md', 'node_modules/dependency.ts', 'linked/local.ts', 'link.ts', 'api/link.ts', 'api/linked/local.ts', 'api/.private/guide.md', '../src/local.ts', 'file:stream', 'C:relative.ts', 'C:/file:stream', 'C:/file', 'bad\0name', 'src/local.ts\n']) expect((await resolve(name)).status, name).toBe('not-found');
    for (const cwd of ['C:relative', 'C:/folder:stream', `${root}:stream`, `${root}\n`]) expect((await resolve('src/local.ts', cwd)).status, cwd).toBe('not-found');
    expect(await resolve(path.join(root, 'src/local.ts'))).toEqual(workspace('src/local.ts'));
    expect(await resolve('src/local.ts', root)).toEqual(workspace('src/local.ts'));
    if (process.platform === 'win32') {
      // Native drive absolute/cwd references also accept slash-normalized CLI output.
      expect(await resolve(path.join(root, 'src/local.ts').replace(/\\/g, '/'))).toEqual(workspace('src/local.ts'));
      expect(await resolve('src/local.ts', root.replace(/\\/g, '/'))).toEqual(workspace('src/local.ts'));
    }
    expect(await resolve('src')).toEqual({ status: 'not-found', reason: 'directory' });
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [path.join(root, 'pipe')]);
      execFileSync('mkfifo', [path.join(api, 'pipe')]);
      expect((await resolve('pipe')).status).toBe('not-found');
    }
  });

  it('does not probe arbitrary external files or cwd and does not leak their existence', async () => {
    const secret = path.join(temp, 'outside/secret.ts'); await put(temp, 'outside/secret.ts');
    const stat = vi.mocked(fs.lstat); stat.mockClear();
    const real = vi.mocked(fs.realpath); real.mockClear();
    expect(await resolve(secret)).toEqual({ status: 'not-found', reason: 'outside-roots' });
    expect(await resolve(path.join(temp, 'outside/missing.ts'))).toEqual({ status: 'not-found', reason: 'outside-roots' });
    expect(await resolve('secret.ts', path.dirname(secret))).toEqual({ status: 'not-found', reason: 'outside-roots' });
    expect(stat.mock.calls.some(([name]) => String(name).startsWith(path.join(temp, 'outside')))).toBe(false);
    expect(real.mock.calls.some(([name]) => String(name).startsWith(path.join(temp, 'outside')))).toBe(false);
  });

  it('validates suffix candidates, preserves unique fallback and caps mixed and suffix ambiguity at 20', async () => {
    await put(api, 'nested/unique.ts');
    await put(api, 'nested/ignored.ts'); await fs.symlink(path.join(api, 'nested/ignored.ts'), path.join(api, 'nested/link.ts'));
    expect(await resolveWorkspaceReference(root, 'unique.ts', { listFiles: async () => ['nested/unique.ts'] })).toEqual(repository(api, 'nested/unique.ts'));
    expect((await resolveWorkspaceReference(root, 'link.ts', { listFiles: async () => ['nested/link.ts'] })).status).toBe('not-found');
    const files = Array.from({ length: 25 }, (_, i) => `nested/${i}/shared.ts`);
    for (const file of files) await put(api, file);
    const result = await resolveWorkspaceReference(root, 'shared.ts', { listFiles: async () => files });
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') { expect(result.candidates).toHaveLength(20); expect(result.truncated).toBe(true); }
    const many = Array.from({ length: 23 }, (_, i) => path.join(root, `repo-${i}`));
    for (const repo of many) await put(repo, 'same.ts');
    await manifest({ repos: many });
    const exact = await resolve('same.ts');
    if (exact.status !== 'ambiguous') throw new Error('Expected ambiguity');
    expect(exact.candidates).toHaveLength(20); expect(exact.truncated).toBe(true);
  });

  it('does not claim a unique suffix when another repository enumeration is unavailable', async () => {
    await put(api, 'nested/unique.ts');
    await expect(resolveWorkspaceReference(root, 'unique.ts', {
      listFiles: async (repo) => {
        if (repo.repoPath === api) return ['nested/unique.ts'];
        throw new Error('Listing exceeded its bound or became unavailable.');
      },
    })).rejects.toThrow('unavailable');
  });
});
