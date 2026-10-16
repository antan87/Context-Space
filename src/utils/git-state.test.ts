import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearGitStateCache, gitStateFingerprint, reuseWhileGitStateIs } from './git-state.js';

let dir: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd });
// A ref rewritten within the same millisecond keeps its mtime on some filesystems; real edits are further apart.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  clearGitStateCache();
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-state-')));
  repo = path.join(dir, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'first');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('gitStateFingerprint', () => {
  it('stays the same while nothing changes, and ignores the working tree', async () => {
    const before = await gitStateFingerprint(repo);
    expect(before).not.toBeNull();
    await fs.writeFile(path.join(repo, 'a.txt'), 'edited\n');
    expect(await gitStateFingerprint(repo)).toBe(before);
  });

  it('changes with a commit, a branch switch, a remote and a fetched ref', async () => {
    const seen = new Set([await gitStateFingerprint(repo)]);
    const changed = async () => {
      await tick();
      const next = await gitStateFingerprint(repo);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
    };
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
    await changed();
    await git(repo, 'checkout', '-q', '-b', 'feature/x');
    await changed();
    await git(repo, 'remote', 'add', 'origin', 'https://example.com/repo.git');
    await changed();
    await git(repo, 'update-ref', 'refs/remotes/origin/feature/x', 'HEAD');
    const withUpstream = await gitStateFingerprint(repo, ['refs/remotes/origin/feature/x']);
    await tick();
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'third');
    await git(repo, 'update-ref', 'refs/remotes/origin/feature/x', 'HEAD');
    expect(await gitStateFingerprint(repo, ['refs/remotes/origin/feature/x'])).not.toBe(withUpstream);
  });

  it('finds the refs of a linked worktree in its main repository', async () => {
    const worktree = path.join(dir, 'wt');
    await git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', worktree);
    const before = await gitStateFingerprint(worktree);
    expect(before).not.toBeNull();
    await tick();
    await git(worktree, 'commit', '-q', '--allow-empty', '-m', 'in the worktree');
    expect(await gitStateFingerprint(worktree)).not.toBe(before);
  });

  it('has no fingerprint for a folder that is not a repository root', async () => {
    expect(await gitStateFingerprint(dir)).toBeNull();
    await fs.mkdir(path.join(repo, 'sub'));
    expect(await gitStateFingerprint(path.join(repo, 'sub'))).toBeNull();
  });
});

describe('reuseWhileGitStateIs', () => {
  it('reuses an answer while the refs are unchanged, and asks again after a commit', async () => {
    let computed = 0;
    const read = async () => reuseWhileGitStateIs(repo, 'head', await gitStateFingerprint(repo), async () => (++computed, (await git(repo, 'rev-parse', 'HEAD')).stdout));
    const first = await read();
    expect(await read()).toBe(first);
    expect(computed).toBe(1);
    await tick();
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
    expect(await read()).not.toBe(first);
    expect(computed).toBe(2);
  });

  it('always asks when there is no fingerprint', async () => {
    let computed = 0;
    await reuseWhileGitStateIs(dir, 'k', null, async () => ++computed);
    await reuseWhileGitStateIs(dir, 'k', null, async () => ++computed);
    expect(computed).toBe(2);
  });
});
