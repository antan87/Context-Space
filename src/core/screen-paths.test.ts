import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenPathError, resolveScreenRepo, resolveScreenTarget } from './screen-paths.js';

vi.mock('./workspace.js', () => ({ findWorkspaceRoot: vi.fn() }));
vi.mock('../utils/multi-git.js', () => ({ getWorkspaceRepoPaths: vi.fn() }));
import { getWorkspaceRepoPaths } from '../utils/multi-git.js';
import { findWorkspaceRoot } from './workspace.js';

let base: string;
let ws: string;
let external: string;
let outside: string;

async function write(file: string, content = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'screen-paths-')));
  ws = path.join(base, 'ws');
  external = path.join(base, 'projects', 'app');
  outside = path.join(base, 'outside');
  await write(path.join(ws, 'plan.md'));
  await write(path.join(ws, 'docs', 'notes.md'));
  await write(path.join(ws, 'NexusFlow', 'src', 'a.ts'));
  await write(path.join(ws, 'NexusFlow', '.git', 'config'));
  await write(path.join(external, 'src', 'b.ts'));
  await write(path.join(outside, 'secret.txt'), 'secret');
  await write(path.join(base, 'ws-evil', 'x.txt'));
  await fs.symlink(outside, path.join(ws, 'link'));
  await fs.symlink(path.join(ws, 'docs'), path.join(ws, 'docs-alias'));
  vi.mocked(findWorkspaceRoot).mockResolvedValue(ws);
  vi.mocked(getWorkspaceRepoPaths).mockResolvedValue([
    { name: 'NexusFlow', path: path.join(ws, 'NexusFlow') },
    { name: 'app', path: external },
  ]);
});
afterEach(async () => {
  vi.resetAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

const code = async (promise: Promise<unknown>) => { const e = await promise.catch((error) => error); expect(e).toBeInstanceOf(ScreenPathError); return (e as ScreenPathError).code; };

describe('resolveScreenTarget', () => {
  it('resolves a file in the workspace folder', async () => {
    expect(await resolveScreenTarget(ws, { path: 'plan.md' })).toMatchObject({ path: 'plan.md', absolute: path.join(ws, 'plan.md'), isDirectory: false });
    expect(await resolveScreenTarget(ws, { path: 'docs/notes.md' })).not.toHaveProperty('repo');
  });

  it('shows a file in a repository relative to that repository, even when named from the workspace folder', async () => {
    expect(await resolveScreenTarget(ws, { path: 'NexusFlow/src/a.ts' })).toMatchObject({ repo: 'NexusFlow', path: 'src/a.ts' });
  });

  it('finds a repository-relative path by trying each repository', async () => {
    expect(await resolveScreenTarget(ws, { path: 'src/a.ts' })).toMatchObject({ repo: 'NexusFlow', path: 'src/a.ts' });
    expect(await resolveScreenTarget(ws, { path: 'src/b.ts' })).toMatchObject({ repo: 'app', path: 'src/b.ts' });
  });

  it('honours a named repository, whatever the case', async () => {
    expect(await resolveScreenTarget(ws, { path: 'src/a.ts', repo: 'nexusflow' })).toMatchObject({ repo: 'NexusFlow' });
    expect(await code(resolveScreenTarget(ws, { path: 'src/b.ts', repo: 'NexusFlow' }))).toBe('missing');
  });

  it('accepts an absolute path inside the workspace or inside a repository that lives elsewhere (in-place)', async () => {
    expect(await resolveScreenTarget(ws, { path: path.join(ws, 'plan.md') })).toMatchObject({ path: 'plan.md' });
    expect(await resolveScreenTarget(ws, { path: path.join(external, 'src', 'b.ts') })).toMatchObject({ repo: 'app', path: 'src/b.ts' });
  });

  it('refuses an absolute path outside every root', async () => {
    expect(await code(resolveScreenTarget(ws, { path: path.join(outside, 'secret.txt') }))).toBe('outside');
    expect(await code(resolveScreenTarget(ws, { path: '/etc/passwd' }))).toBe('outside');
  });

  it('refuses a path that climbs out', async () => {
    expect(await code(resolveScreenTarget(ws, { path: '../outside/secret.txt' }))).toBe('outside');
    expect(await code(resolveScreenTarget(ws, { path: 'docs/../../outside/secret.txt' }))).toBe('outside');
  });

  it('does not mistake a sibling folder that starts with the workspace name for the workspace', async () => {
    expect(await code(resolveScreenTarget(ws, { path: path.join(base, 'ws-evil', 'x.txt') }))).toBe('outside');
  });

  it('refuses a symlink that leads out of the workspace, even though the path looks inside', async () => {
    expect(await code(resolveScreenTarget(ws, { path: 'link/secret.txt' }))).toBe('outside');
  });

  it('follows a symlink that stays inside and reports the real location', async () => {
    expect(await resolveScreenTarget(ws, { path: 'docs-alias/notes.md' })).toMatchObject({ path: 'docs/notes.md' });
  });

  it('refuses Git internals wherever they are', async () => {
    expect(await code(resolveScreenTarget(ws, { path: 'NexusFlow/.git/config' }))).toBe('invalid');
    expect(await code(resolveScreenTarget(ws, { path: '.git/config', repo: 'NexusFlow' }))).toBe('invalid');
  });

  it('reports a file that does not exist, and does not pretend it does', async () => {
    expect(await code(resolveScreenTarget(ws, { path: 'nope.md' }))).toBe('missing');
  });

  it('reports a directory as a directory', async () => {
    expect(await resolveScreenTarget(ws, { path: 'docs' })).toMatchObject({ isDirectory: true, path: 'docs' });
  });

  it.each([['an empty path', ''], ['a blank path', '   '], ['a control character', 'a\u0000b'], ['a very long path', 'a'.repeat(1001)]])('refuses %s', async (_n, value) => {
    expect(await code(resolveScreenTarget(ws, { path: value }))).toBe('invalid');
  });

  it('refuses an unknown repository', async () => {
    expect(await code(resolveScreenTarget(ws, { path: 'a.ts', repo: 'ghost' }))).toBe('unknown_repo');
  });

  it('works in a workspace with no repositories', async () => {
    vi.mocked(getWorkspaceRepoPaths).mockRejectedValue(new Error('manifest missing'));
    expect(await resolveScreenTarget(ws, { path: 'plan.md' })).toMatchObject({ path: 'plan.md' });
    expect(await code(resolveScreenTarget(ws, { path: 'src/a.ts' }))).toBe('missing');
  });

  it('starts from the workspace root when the server was started below it', async () => {
    vi.mocked(findWorkspaceRoot).mockResolvedValue(ws);
    expect(await resolveScreenTarget(path.join(ws, 'docs'), { path: 'plan.md' })).toMatchObject({ path: 'plan.md' });
  });
});

describe('resolveScreenRepo', () => {
  it('finds a repository by name, whatever the case', async () => {
    expect(await resolveScreenRepo(ws, 'NEXUSFLOW')).toEqual({ name: 'NexusFlow', absolute: path.join(ws, 'NexusFlow') });
  });
  it('refuses an unknown one', async () => {
    expect(await code(resolveScreenRepo(ws, 'ghost'))).toBe('unknown_repo');
  });
});
