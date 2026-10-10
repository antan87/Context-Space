/**
 * Real-Git coverage for the repository-safety contract: reference checkouts
 * are never changed, reviewed commits touch only the selected files, and the
 * finish policy follows the tested content.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';

import { commitWorkspace, pushWorkspace } from './commit.js';
import { ReferenceRepoError, describeEditBoundaries } from './edit-policy.js';
import { IsolationConflictError, isolateWorkspaceRepo, planRepoIsolation } from './isolate.js';
import { evaluateProgression } from './progression-policy.js';
import { verifyWorkspace } from './verify.js';
import { loadFeatureConfig, saveFeatureConfig } from './workspace.js';
import { commitAndPush } from '../utils/multi-git.js';
import type { Feature } from '../types.js';

const git = async (cwd: string, ...args: string[]) => (await execa('git', args, { cwd })).stdout.trim();

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.name', 'Test');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(dir, 'README.md'), '# repo\n');
  // Fails while a FAIL marker file exists, so tests can flip the outcome.
  await fs.writeFile(path.join(dir, 'test.mjs'), "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('FAIL') ? 1 : 0);\n");
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
}

/** A bare remote plus a clone of it: the user's own checkout. */
async function hostWithRemote(root: string, name: string): Promise<{ host: string; remote: string }> {
  const remote = path.join(root, `${name}.git`);
  const seed = path.join(root, `${name}-seed`);
  await initRepo(seed);
  await git(root, 'init', '--bare', '-b', 'main', remote);
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  const host = path.join(root, name);
  await git(root, 'clone', remote, host);
  await git(host, 'config', 'user.name', 'Test');
  await git(host, 'config', 'user.email', 'test@example.com');
  return { host, remote };
}

/** Everything about a checkout that "unchanged" has to cover. */
async function checkoutIdentity(repo: string) {
  return {
    head: await git(repo, 'rev-parse', 'HEAD'),
    branch: await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: await git(repo, 'status', '--porcelain'),
    refs: await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
  };
}

async function inPlaceWorkspace(root: string, repos: string[]): Promise<string> {
  const workspacePath = path.join(root, 'ws');
  await fs.mkdir(workspacePath, { recursive: true });
  const feature: Feature = {
    id: 'ws',
    mode: 'in-place',
    branchName: 'feat/safe',
    description: 'safe delivery',
    repos,
    originalRepos: repos,
    assistants: [],
    workspacePath,
    createdAt: new Date().toISOString(),
  };
  await saveFeatureConfig(workspacePath, feature);
  return workspacePath;
}

describe('repository safety contract (real git)', { timeout: 60_000 }, () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-safe-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  describe('reference checkouts', () => {
    it('commit skips an unisolated repo and refuses to target it by name', async () => {
      const { host } = await hostWithRemote(root, 'api');
      const workspacePath = await inPlaceWorkspace(root, [host]);
      await fs.writeFile(path.join(host, 'README.md'), 'user edit\n');
      const before = await checkoutIdentity(host);

      const report = await commitWorkspace(workspacePath, 'wip');
      expect(report.repos).toEqual([]);
      expect(report.skipped[0]).toMatchObject({ name: 'api' });
      expect(report.skipped[0]!.reason).toMatch(/read-only reference/);
      await expect(commitWorkspace(workspacePath, 'wip', { repos: ['api'] })).rejects.toBeInstanceOf(ReferenceRepoError);
      await expect(commitWorkspace(workspacePath, 'wip', { files: { api: ['README.md'] } })).rejects.toBeInstanceOf(ReferenceRepoError);

      expect(await checkoutIdentity(host)).toEqual(before);
    });

    it('isolation leaves the source checkout exactly as it was, even when it is behind its remote', async () => {
      const { host, remote } = await hostWithRemote(root, 'api');
      // Advance the remote so a fast-forward would have something to do.
      const other = path.join(root, 'other');
      await git(root, 'clone', remote, other);
      await git(other, 'config', 'user.name', 'Test');
      await git(other, 'config', 'user.email', 'test@example.com');
      await fs.writeFile(path.join(other, 'NEW.md'), 'upstream\n');
      await git(other, 'add', '.');
      await git(other, 'commit', '-m', 'upstream change');
      await git(other, 'push', 'origin', 'main');
      await fs.writeFile(path.join(host, 'local.txt'), 'uncommitted user work\n');
      const workspacePath = await inPlaceWorkspace(root, [host]);
      const before = await checkoutIdentity(host);

      const result = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/safe' });

      expect(result.worktreePath).toBe(path.join(workspacePath, 'api'));
      // The new branch starts from the fetched remote base...
      await expect(fs.access(path.join(result.worktreePath, 'NEW.md'))).resolves.toBeUndefined();
      // ...while the user's checkout, its branch and its local main did not move.
      const after = await checkoutIdentity(host);
      expect({ ...after, refs: undefined }).toEqual({ ...before, refs: undefined });
      expect(after.refs.split('\n').sort()).toEqual(
        [...before.refs.split('\n'), `refs/heads/feat/safe ${await git(result.worktreePath, 'rev-parse', 'HEAD')}`].sort(),
      );
      const feature = await loadFeatureConfig(workspacePath);
      expect(describeEditBoundaries(feature!, workspacePath)[0]).toMatchObject({
        access: 'isolated', editable: true, path: result.worktreePath, branch: 'feat/safe', sourcePath: host,
      });
    });

    it('a path collision is reported in the plan and refused before any git change', async () => {
      const { host } = await hostWithRemote(root, 'api');
      const workspacePath = await inPlaceWorkspace(root, [host]);
      await fs.mkdir(path.join(workspacePath, 'api'));
      await fs.writeFile(path.join(workspacePath, 'api', 'notes.txt'), 'mine\n');
      const before = await checkoutIdentity(host);

      const plan = await planRepoIsolation(workspacePath, 'api', { branchName: 'feat/safe' });
      expect(plan.conflicts.join(' ')).toMatch(/already exists/);
      await expect(isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/safe' })).rejects.toBeInstanceOf(IsolationConflictError);

      expect(await checkoutIdentity(host)).toEqual(before);
      expect(await fs.readFile(path.join(workspacePath, 'api', 'notes.txt'), 'utf-8')).toBe('mine\n');
      expect((await loadFeatureConfig(workspacePath))?.isolatedRepos).toBeUndefined();
    });

    it('a branch already checked out elsewhere is a conflict, not a half-made worktree', async () => {
      const { host } = await hostWithRemote(root, 'api');
      await git(host, 'worktree', 'add', '-b', 'feat/safe', path.join(root, 'elsewhere'));
      const workspacePath = await inPlaceWorkspace(root, [host]);
      const before = await checkoutIdentity(host);

      await expect(isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/safe' })).rejects.toThrow(/already checked out/);

      expect(await checkoutIdentity(host)).toEqual(before);
      await expect(fs.access(path.join(workspacePath, 'api'))).rejects.toThrow();
    });
  });

  describe('reviewed commits', () => {
    it('commits only the selected files and leaves unrelated staged and unstaged work in place', async () => {
      const { host } = await hostWithRemote(root, 'api');
      const workspacePath = await inPlaceWorkspace(root, [host]);
      const { worktreePath: repo } = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/safe' });
      await fs.writeFile(path.join(repo, 'selected.txt'), 'reviewed\n');
      await fs.writeFile(path.join(repo, 'README.md'), 'not selected\n');
      await fs.writeFile(path.join(repo, 'staged-by-user.txt'), 'user staged this\n');
      await git(repo, 'add', 'staged-by-user.txt');

      const report = await commitWorkspace(workspacePath, 'feat: reviewed', { noPush: true, files: { api: ['selected.txt'] } });

      expect(report.repos[0]).toMatchObject({ name: 'api', success: true, committed: true, branch: 'feat/safe' });
      expect(await git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('selected.txt');
      const status = (await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout;
      expect(status).toContain('A  staged-by-user.txt');
      expect(status).toContain(' M README.md');
    });

    it('a selection naming a file with no current change fails before committing any repo', async () => {
      const a = await hostWithRemote(root, 'a');
      const b = await hostWithRemote(root, 'b');
      const workspacePath = await inPlaceWorkspace(root, [a.host, b.host]);
      const ra = (await isolateWorkspaceRepo(workspacePath, 'a', { branchName: 'feat/safe' })).worktreePath;
      const rb = (await isolateWorkspaceRepo(workspacePath, 'b', { branchName: 'feat/safe' })).worktreePath;
      await fs.writeFile(path.join(ra, 'x.txt'), 'x\n');
      await fs.writeFile(path.join(rb, 'y.txt'), 'y\n');
      const headA = await git(ra, 'rev-parse', 'HEAD');

      await expect(commitWorkspace(workspacePath, 'wip', { noPush: true, files: { a: ['x.txt'], b: ['gone.txt'] } }))
        .rejects.toThrow(/No current change in b/);
      expect(await git(ra, 'rev-parse', 'HEAD')).toBe(headA);
    });

    it('reports a commit whose push failed as committed, with the hash, so a retry only pushes', async () => {
      const { host } = await hostWithRemote(root, 'api');
      await fs.writeFile(path.join(host, 'change.txt'), 'x\n');
      await git(host, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));

      const result = await commitAndPush(host, 'wip', 'main');

      expect(result).toMatchObject({ success: false, committed: true, pushed: false });
      expect(result.commitHash).toMatch(/^[0-9a-f]{7,}$/);
      expect(result.pushError).toBeTruthy();
      expect(await git(host, 'status', '--porcelain')).toBe('');
    });
  });

  it('push retry sends the existing commit once the remote is back, and refuses references', async () => {
    const { host, remote } = await hostWithRemote(root, 'api');
    const workspacePath = await inPlaceWorkspace(root, [host]);
    const { worktreePath: repo } = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/safe' });
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, 'remote', 'set-url', 'origin', path.join(root, 'offline.git'));
    const [failed] = (await commitWorkspace(workspacePath, 'feat: a')).repos;
    expect(failed).toMatchObject({ committed: true, pushed: false });

    await git(repo, 'remote', 'set-url', 'origin', remote);
    expect(await pushWorkspace(workspacePath, ['api'])).toEqual([{ name: 'api', pushed: true, branch: 'feat/safe', error: undefined }]);
    expect(await git(remote, 'rev-parse', 'feat/safe')).toBe(await git(repo, 'rev-parse', 'HEAD'));
    expect(await git(remote, 'rev-list', '--count', 'main..feat/safe')).toBe('1');

    const other = await hostWithRemote(root, 'other');
    const refWorkspace = await inPlaceWorkspace(path.join(root, 'second'), [other.host]).catch(async () => {
      await fs.mkdir(path.join(root, 'second'), { recursive: true });
      return inPlaceWorkspace(path.join(root, 'second'), [other.host]);
    });
    await expect(pushWorkspace(refWorkspace, ['other'])).rejects.toBeInstanceOf(ReferenceRepoError);
  });

  describe('finish policy', () => {
    async function isolatedPair() {
      const a = await hostWithRemote(root, 'a');
      const b = await hostWithRemote(root, 'b');
      const workspacePath = await inPlaceWorkspace(root, [a.host, b.host]);
      const ra = (await isolateWorkspaceRepo(workspacePath, 'a', { branchName: 'feat/safe' })).worktreePath;
      const rb = (await isolateWorkspaceRepo(workspacePath, 'b', { branchName: 'feat/safe' })).worktreePath;
      return { workspacePath, ra, rb };
    }
    const states = async (workspacePath: string) =>
      Object.fromEntries((await evaluateProgression(workspacePath)).repos.map((r) => [r.name, r.state]));

    it('missing, failed and partial evidence block; passing evidence for the tested content is ready', async () => {
      const { workspacePath, rb } = await isolatedPair();
      expect(await states(workspacePath)).toEqual({ a: 'missing', b: 'missing' });

      await verifyWorkspace(workspacePath, { repoName: 'a', command: 'node test.mjs' });
      expect(await states(workspacePath)).toEqual({ a: 'passed', b: 'missing' });

      await fs.writeFile(path.join(rb, 'FAIL'), '');
      await verifyWorkspace(workspacePath, { command: 'node test.mjs', allowDirty: true });
      const blocked = await evaluateProgression(workspacePath);
      expect(blocked.ready).toBe(false);
      expect(blocked.repos.find((r) => r.name === 'b')?.state).toBe('failed');

      await fs.rm(path.join(rb, 'FAIL'));
      await verifyWorkspace(workspacePath, { command: 'node test.mjs' });
      expect((await evaluateProgression(workspacePath)).ready).toBe(true);
    });

    it('edits after verification make it stale; committing the tested content unchanged keeps it fresh', async () => {
      const { workspacePath, ra } = await isolatedPair();
      await fs.writeFile(path.join(ra, 'feature.txt'), 'tested\n');
      await verifyWorkspace(workspacePath, { command: 'node test.mjs', allowDirty: true });
      expect(await states(workspacePath)).toEqual({ a: 'passed-dirty', b: 'passed' });

      await commitWorkspace(workspacePath, 'feat: tested', { noPush: true });
      expect(await states(workspacePath)).toEqual({ a: 'passed', b: 'passed' });

      await fs.appendFile(path.join(ra, 'feature.txt'), 'edited after the run\n');
      const decision = await evaluateProgression(workspacePath);
      expect(decision.repos[0]).toMatchObject({ name: 'a', state: 'stale', ready: false });
      expect(decision.blockers[0]).toMatch(/after it was verified/);
    });

    it('a branch switch to different content makes evidence stale', async () => {
      const { workspacePath, ra } = await isolatedPair();
      await verifyWorkspace(workspacePath, { command: 'node test.mjs' });
      await git(ra, 'checkout', '-b', 'other');
      await fs.writeFile(path.join(ra, 'other.txt'), 'other\n');
      await git(ra, 'add', '.');
      await git(ra, 'commit', '-m', 'other');

      expect((await states(workspacePath)).a).toBe('stale');
    });

    it('a timed-out run blocks', async () => {
      const { workspacePath } = await isolatedPair();
      await verifyWorkspace(workspacePath, { command: 'node -e "setTimeout(()=>{},5000)"', timeoutMs: 300 });
      expect(new Set(Object.values(await states(workspacePath)))).toEqual(new Set(['timed-out']));
    });

    it('reference repos are outside the decision', async () => {
      const a = await hostWithRemote(root, 'a');
      const workspacePath = await inPlaceWorkspace(root, [a.host]);
      expect(await evaluateProgression(workspacePath)).toEqual({ ready: true, repos: [], plan: { blocking: [], open: [] }, blockers: [], warnings: [] });
    });
  });
});
