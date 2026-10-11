/**
 * Real-Git coverage for archive: worktrees go only when their work is safe,
 * the record stays, the user's checkouts never change, and an interrupted
 * archive resumes.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';

import { ArchivedWorkspaceError, archiveWorkspace, planArchive, unarchiveWorkspace } from './archive.js';
import { commitWorkspace } from './commit.js';
import { finishWorkspace } from './finish.js';
import { isolateWorkspaceRepo } from './isolate.js';
import { syncWorkspace } from './sync.js';
import { verifyWorkspace } from './verify.js';
import { listWorkspaces, loadFeatureConfig, saveFeatureConfig } from './workspace.js';
import { loadWorkspaceState } from './workspace-state.js';
import type { Feature } from '../types.js';

const git = async (cwd: string, ...args: string[]) => (await execa('git', args, { cwd })).stdout.trim();

/** Runs inside archive's planning fetch, to change the workspace mid-archive. */
const hooks: { duringFetch?: () => Promise<void> } = {};
vi.mock('./merge-detection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./merge-detection.js')>();
  return {
    ...actual,
    fetchDefaultBranch: async (repoPath: string, defaultBranch: string) => {
      const hook = hooks.duringFetch;
      hooks.duringFetch = undefined;
      await hook?.();
      return actual.fetchDefaultBranch(repoPath, defaultBranch);
    },
  };
});

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.name', 'Test');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
}

async function configure(repo: string): Promise<void> {
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'user.email', 'test@example.com');
}

/** A bare remote, the user's own clone of it, and a second clone that plays the forge. */
async function hostWithRemote(root: string, name: string): Promise<{ host: string; remote: string; forge: string }> {
  const remote = path.join(root, `${name}.git`);
  const seed = path.join(root, `${name}-seed`);
  await initRepo(seed);
  await git(root, 'init', '--bare', '-b', 'main', remote);
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  const host = path.join(root, name);
  await git(root, 'clone', remote, host);
  await configure(host);
  const forge = path.join(root, `${name}-forge`);
  await git(root, 'clone', remote, forge);
  await configure(forge);
  return { host, remote, forge };
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
    branchName: 'feat/archive',
    description: 'archive',
    repos,
    originalRepos: repos,
    assistants: [],
    workspacePath,
    createdAt: new Date().toISOString(),
  };
  await saveFeatureConfig(workspacePath, feature);
  await fs.writeFile(path.join(workspacePath, 'release-notes.md'), '# notes\n');
  return workspacePath;
}

/** Commit a file in a worktree and push its branch. */
async function commitAndPush(worktree: string, file: string, branch: string): Promise<string> {
  await fs.writeFile(path.join(worktree, file), `${file}\n`);
  await git(worktree, 'add', file);
  await git(worktree, 'commit', '-m', `add ${file}`);
  await git(worktree, 'push', '-u', 'origin', branch);
  return git(worktree, 'rev-parse', 'HEAD');
}

/** Merge a pushed branch into main the way a forge would (merge commit). */
async function mergeOnForge(forge: string, branch: string): Promise<void> {
  await git(forge, 'fetch', 'origin');
  await git(forge, 'checkout', 'main');
  await git(forge, 'pull', '--ff-only', 'origin', 'main');
  await git(forge, 'merge', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`);
  await git(forge, 'push', 'origin', 'main');
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

describe('archiveWorkspace (real git)', { timeout: 90_000 }, () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-archive-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('removes a merged worktree and its branch, keeps the record, and leaves the checkout otherwise unchanged', async () => {
    const { host, forge } = await hostWithRemote(root, 'api');
    const workspacePath = await inPlaceWorkspace(root, [host]);
    const { worktreePath } = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' });
    const tip = await commitAndPush(worktreePath, 'feature.txt', 'feat/archive');
    await mergeOnForge(forge, 'feat/archive');
    const before = await checkoutIdentity(host);

    const preview = await planArchive(workspacePath, { dryRun: true });
    expect(preview.ready).toBe(true);
    expect(preview.repos[0]).toMatchObject({ action: 'remove-worktree', branchState: 'merged', mergeEvidence: 'ancestor' });
    expect(preview.kept).toContain('release-notes.md');
    expect(preview.kept).not.toContain('api');
    expect(await exists(worktreePath)).toBe(true);

    const report = await archiveWorkspace(workspacePath);

    expect(report).toMatchObject({ archived: true, ready: true, errors: [] });
    expect(report.branches).toEqual([expect.objectContaining({
      repo: 'api', branch: 'feat/archive', local: 'delete', remote: 'not-requested', result: { local: 'deleted', remote: 'not-requested' },
    })]);
    expect(await exists(worktreePath)).toBe(false);
    const after = await checkoutIdentity(host);
    expect({ ...after, refs: undefined }).toEqual({ ...before, refs: undefined });
    expect(after.refs.split('\n')).toEqual(before.refs.split('\n').filter((ref) => !ref.startsWith('refs/heads/feat/archive ')));
    await expect(git(host, 'rev-parse', '--verify', 'refs/heads/feat/archive')).rejects.toThrow();
    // The remote branch stays unless deleting it was asked for.
    expect(await git(host, 'ls-remote', '--heads', 'origin', 'feat/archive')).toContain(tip);
    expect(await git(host, 'worktree', 'list', '--porcelain')).not.toContain(worktreePath);
    expect(await fs.readFile(path.join(workspacePath, 'release-notes.md'), 'utf-8')).toBe('# notes\n');

    const feature = (await loadFeatureConfig(workspacePath))!;
    expect(feature.archivedAt).toBe(report.archivedAt);
    expect(feature.mode).toBe('in-place');
    expect(feature.repos).toEqual([host]);
    expect(feature.isolatedRepos).toBeUndefined();
    expect(feature.archive?.repos[0]).toMatchObject({
      name: 'api', access: 'isolated', branch: 'feat/archive', headSha: tip, branchState: 'merged', worktreePath, branchDeleted: true,
    });
    expect(feature.createdBranches).toEqual({ api: 'feat/archive' });
    expect((await loadWorkspaceState(workspacePath)).lastArchive?.status).toBe('completed');
    const listed = await listWorkspaces(root);
    expect(listed.find((w) => w.id === 'ws')?.archivedAt).toBe(report.archivedAt);
  });

  it('blocks dirty, unpushed and never-pushed work and removes nothing', async () => {
    const a = await hostWithRemote(root, 'dirty');
    const b = await hostWithRemote(root, 'unpushed');
    const c = await hostWithRemote(root, 'local');
    const workspacePath = await inPlaceWorkspace(root, [a.host, b.host, c.host]);
    const dirty = (await isolateWorkspaceRepo(workspacePath, 'dirty', { branchName: 'feat/archive' })).worktreePath;
    const unpushed = (await isolateWorkspaceRepo(workspacePath, 'unpushed', { branchName: 'feat/archive' })).worktreePath;
    const local = (await isolateWorkspaceRepo(workspacePath, 'local', { branchName: 'feat/archive' })).worktreePath;
    await fs.writeFile(path.join(dirty, 'untracked.txt'), 'work in progress\n');
    await commitAndPush(unpushed, 'one.txt', 'feat/archive');
    await fs.writeFile(path.join(unpushed, 'two.txt'), 'two\n');
    await git(unpushed, 'add', 'two.txt');
    await git(unpushed, 'commit', '-m', 'not pushed');
    await fs.writeFile(path.join(local, 'x.txt'), 'x\n');
    await git(local, 'add', 'x.txt');
    await git(local, 'commit', '-m', 'never pushed');
    const manifest = await fs.readFile(path.join(workspacePath, 'contextspace.json'), 'utf-8');

    const report = await archiveWorkspace(workspacePath);

    expect(report.archived).toBe(false);
    expect(report.ready).toBe(false);
    expect(Object.fromEntries(report.repos.map((r) => [r.name, r.branchState]))).toEqual({
      dirty: 'dirty', unpushed: 'unpushed', local: 'unpushed',
    });
    expect(report.blockers.join(' ')).toMatch(/1 uncommitted file/);
    expect(report.blockers.join(' ')).toMatch(/1 commit\(s\) on "feat\/archive" are not pushed/);
    expect(report.blockers.join(' ')).toMatch(/never pushed/);
    for (const worktree of [dirty, unpushed, local]) expect(await exists(worktree)).toBe(true);
    expect(await fs.readFile(path.join(workspacePath, 'contextspace.json'), 'utf-8')).toBe(manifest);
    expect((await loadWorkspaceState(workspacePath)).lastArchive).toBeUndefined();
  });

  it('refuses pushed-but-unmerged work unless parked, then keeps its branch', async () => {
    const { host } = await hostWithRemote(root, 'api');
    const workspacePath = await inPlaceWorkspace(root, [host]);
    const { worktreePath } = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' });
    const tip = await commitAndPush(worktreePath, 'parked.txt', 'feat/archive');

    const refused = await archiveWorkspace(workspacePath);
    expect(refused.archived).toBe(false);
    expect(refused.repos[0]!.branchState).toBe('unmerged');
    expect(refused.blockers[0]).toMatch(/--park/);
    expect(await exists(worktreePath)).toBe(true);

    const parked = await archiveWorkspace(workspacePath, { park: true });
    expect(parked.archived).toBe(true);
    expect(await exists(worktreePath)).toBe(false);
    expect(await git(host, 'rev-parse', 'refs/heads/feat/archive')).toBe(tip);
    const feature = (await loadFeatureConfig(workspacePath))!;
    expect(feature.archive).toMatchObject({ parked: true, repos: [{ branchState: 'parked', headSha: tip }] });
  });

  it('an isolated branch with no new commits counts as merged', async () => {
    const { host } = await hostWithRemote(root, 'api');
    const workspacePath = await inPlaceWorkspace(root, [host]);
    await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' });

    const report = await archiveWorkspace(workspacePath);
    expect(report.archived).toBe(true);
    expect(report.repos[0]).toMatchObject({ branchState: 'merged', mergeEvidence: 'ancestor' });
  });

  it('a worktree-mode workspace is all-or-nothing, then archives into references over its sources', async () => {
    const a = await hostWithRemote(root, 'web');
    const b = await hostWithRemote(root, 'api');
    const workspacePath = path.join(root, 'ws');
    await fs.mkdir(workspacePath, { recursive: true });
    const worktrees = [path.join(workspacePath, 'web'), path.join(workspacePath, 'api')];
    await git(a.host, 'worktree', 'add', '-b', 'feat/x', worktrees[0]!, 'origin/main');
    await git(b.host, 'worktree', 'add', '-b', 'feat/x', worktrees[1]!, 'origin/main');
    await saveFeatureConfig(workspacePath, {
      id: 'feat/x', mode: 'worktree', branchName: 'feat/x', description: 'x',
      repos: worktrees, originalRepos: [a.host, b.host], assistants: [], workspacePath,
      createdAt: new Date().toISOString(),
    });
    await commitAndPush(worktrees[0]!, 'web.txt', 'feat/x');
    await mergeOnForge(a.forge, 'feat/x');
    await fs.writeFile(path.join(worktrees[1]!, 'dirty.txt'), 'dirty\n');
    const hosts = [await checkoutIdentity(a.host), await checkoutIdentity(b.host)];

    const blocked = await archiveWorkspace(workspacePath);
    expect(blocked.archived).toBe(false);
    expect(blocked.repos.map((r) => r.action)).toEqual(['remove-worktree', 'blocked']);
    for (const worktree of worktrees) expect(await exists(worktree)).toBe(true);

    await fs.rm(path.join(worktrees[1]!, 'dirty.txt'));
    const archived = await archiveWorkspace(workspacePath);
    expect(archived.archived).toBe(true);
    for (const worktree of worktrees) expect(await exists(worktree)).toBe(false);
    expect([await checkoutIdentity(a.host), await checkoutIdentity(b.host)]).toEqual(hosts);
    const feature = (await loadFeatureConfig(workspacePath))!;
    expect(feature).toMatchObject({ mode: 'in-place', repos: [a.host, b.host], archive: { previousMode: 'worktree' } });
    expect(feature.archive?.repos.map((r) => r.access)).toEqual(['worktree', 'worktree']);
  });

  it('an interrupted archive resumes without repeating removed worktrees', async () => {
    const a = await hostWithRemote(root, 'one');
    const b = await hostWithRemote(root, 'two');
    const workspacePath = await inPlaceWorkspace(root, [a.host, b.host]);
    const one = (await isolateWorkspaceRepo(workspacePath, 'one', { branchName: 'feat/archive' })).worktreePath;
    const two = (await isolateWorkspaceRepo(workspacePath, 'two', { branchName: 'feat/archive' })).worktreePath;
    const tipOne = await git(one, 'rev-parse', 'HEAD');
    const tipTwo = await git(two, 'rev-parse', 'HEAD');
    // A locked worktree refuses removal without --force: the run stops part-way.
    await git(b.host, 'worktree', 'lock', two);

    const partial = await archiveWorkspace(workspacePath);
    expect(partial.archived).toBe(false);
    expect(partial.errors.join(' ')).toMatch(/two: could not remove/);
    expect(await exists(one)).toBe(false);
    expect(await exists(two)).toBe(true);
    expect((await loadFeatureConfig(workspacePath))?.archivedAt).toBeUndefined();
    expect((await loadWorkspaceState(workspacePath)).lastArchive).toMatchObject({
      status: 'partial',
      repos: [{ name: 'one', removed: true, headSha: tipOne }, { name: 'two', removed: false }],
    });

    await git(b.host, 'worktree', 'unlock', two);
    const resumed = await archiveWorkspace(workspacePath);
    expect(resumed.resumedFrom).toBe('partial');
    expect(resumed.archived).toBe(true);
    expect(resumed.repos[0]).toMatchObject({ name: 'one', action: 'already-removed', headSha: tipOne });
    expect((await loadFeatureConfig(workspacePath))?.archive?.repos.map((r) => r.headSha)).toEqual([tipOne, tipTwo]);
  });

  it('refuses to remove the worktree this process is running in', async () => {
    const { host } = await hostWithRemote(root, 'api');
    const workspacePath = await inPlaceWorkspace(root, [host]);
    const { worktreePath } = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' });
    const cwd = process.cwd();
    process.chdir(worktreePath);
    try {
      const report = await archiveWorkspace(workspacePath);
      expect(report.archived).toBe(false);
      expect(report.blockers[0]).toMatch(/running inside/);
    } finally {
      process.chdir(cwd);
    }
    expect(await exists(worktreePath)).toBe(true);
  });

  it('an archived workspace refuses repository changes until it is unarchived', async () => {
    const { host } = await hostWithRemote(root, 'api');
    const workspacePath = await inPlaceWorkspace(root, [host]);
    await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' });
    expect((await archiveWorkspace(workspacePath)).archived).toBe(true);

    await expect(commitWorkspace(workspacePath, 'wip')).rejects.toBeInstanceOf(ArchivedWorkspaceError);
    await expect(isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/again' })).rejects.toBeInstanceOf(ArchivedWorkspaceError);
    await expect(syncWorkspace(workspacePath)).rejects.toBeInstanceOf(ArchivedWorkspaceError);
    await expect(verifyWorkspace(workspacePath)).rejects.toBeInstanceOf(ArchivedWorkspaceError);
    await expect(finishWorkspace(workspacePath)).rejects.toBeInstanceOf(ArchivedWorkspaceError);
    expect((await archiveWorkspace(workspacePath)).alreadyArchived).toBe(true);

    const restored = await unarchiveWorkspace(workspacePath);
    expect(restored.restored).toBe(true);
    const feature = (await loadFeatureConfig(workspacePath))!;
    expect(feature.archivedAt).toBeUndefined();
    expect(feature.archive?.unarchivedAt).toBeTruthy();
    const again = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/again' });
    expect(await exists(again.worktreePath)).toBe(true);
    expect((await unarchiveWorkspace(workspacePath)).restored).toBe(false);

    // Archiving again keeps the first delivery record as history.
    const first = feature.archive!;
    expect((await archiveWorkspace(workspacePath)).archived).toBe(true);
    const twice = (await loadFeatureConfig(workspacePath))!;
    expect(twice.archive?.repos[0]).toMatchObject({ branch: 'feat/again' });
    expect(twice.archiveHistory).toEqual([first]);
    expect(twice.archiveHistory?.[0]?.repos[0]).toMatchObject({ branch: 'feat/archive' });
  });
  describe('merged branch cleanup', () => {
    it('keeps a squash-merged branch without pull-request evidence: parking is required and the branch stays', async () => {
      const { host, forge } = await hostWithRemote(root, 'api');
      const workspacePath = await inPlaceWorkspace(root, [host]);
      const { worktreePath } = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' });
      const tip = await commitAndPush(worktreePath, 'squashed.txt', 'feat/archive');
      await git(forge, 'fetch', 'origin');
      await git(forge, 'merge', '--squash', 'origin/feat/archive');
      await git(forge, 'commit', '-m', 'squash');
      await git(forge, 'push', 'origin', 'main');

      expect((await archiveWorkspace(workspacePath)).repos[0]!.branchState).toBe('unmerged');
      const parked = await archiveWorkspace(workspacePath, { park: true });
      expect(parked.branches[0]).toMatchObject({ local: 'keep', reason: expect.stringMatching(/not merged/) });
      expect(await git(host, 'rev-parse', 'refs/heads/feat/archive')).toBe(tip);
    });

    it('never deletes a branch the workspace did not create, or one with unknown provenance', async () => {
      const a = await hostWithRemote(root, 'existing');
      await git(a.host, 'branch', 'feat/shared');
      const workspacePath = await inPlaceWorkspace(root, [a.host]);
      await isolateWorkspaceRepo(workspacePath, 'existing', { branchName: 'feat/shared' });
      expect((await loadFeatureConfig(workspacePath))?.createdBranches).toBeUndefined();

      const report = await archiveWorkspace(workspacePath);
      expect(report.archived).toBe(true);
      expect(report.branches[0]).toMatchObject({ local: 'keep', reason: expect.stringMatching(/provenance unknown/) });
      await expect(git(a.host, 'rev-parse', '--verify', 'refs/heads/feat/shared')).resolves.toMatch(/[0-9a-f]{40}/);

      const b = await hostWithRemote(root, 'other');
      const second = path.join(root, 'ws2');
      await fs.mkdir(second);
      await git(b.host, 'branch', 'feat/theirs');
      await saveFeatureConfig(second, {
        id: 'ws2', mode: 'in-place', branchName: 'feat/theirs', description: '', repos: [b.host], originalRepos: [b.host],
        assistants: [], workspacePath: second, createdAt: new Date().toISOString(), createdBranches: { unrelated: 'feat/x' },
      });
      await isolateWorkspaceRepo(second, 'other', { branchName: 'feat/theirs' });
      const other = await archiveWorkspace(second);
      expect(other.branches[0]).toMatchObject({ local: 'keep', reason: 'this workspace did not create it' });
    });

    it('keeps a branch checked out in another worktree when an interrupted archive resumes', async () => {
      const a = await hostWithRemote(root, 'one');
      const b = await hostWithRemote(root, 'two');
      const workspacePath = await inPlaceWorkspace(root, [a.host, b.host]);
      const one = (await isolateWorkspaceRepo(workspacePath, 'one', { branchName: 'feat/archive' })).worktreePath;
      const two = (await isolateWorkspaceRepo(workspacePath, 'two', { branchName: 'feat/archive' })).worktreePath;
      await git(b.host, 'worktree', 'lock', two);
      expect((await archiveWorkspace(workspacePath)).archived).toBe(false);
      expect(await exists(one)).toBe(false);
      // Meanwhile the user checks the merged branch out in their own checkout.
      await git(a.host, 'checkout', 'feat/archive');
      await git(b.host, 'worktree', 'unlock', two);

      const resumed = await archiveWorkspace(workspacePath);
      expect(resumed.archived).toBe(true);
      const byRepo = Object.fromEntries(resumed.branches.map((plan) => [plan.repo, plan]));
      expect(byRepo.one).toMatchObject({ local: 'keep', reason: `checked out in ${a.host}` });
      expect(byRepo.two).toMatchObject({ local: 'delete', result: { local: 'deleted' } });
      expect(await git(a.host, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/archive');
    });

    it('keeps every branch on request', async () => {
      const { host } = await hostWithRemote(root, 'api');
      const workspacePath = await inPlaceWorkspace(root, [host]);
      await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' });
      const report = await archiveWorkspace(workspacePath, { keepBranches: true });
      expect(report.branches[0]).toMatchObject({ local: 'keep', reason: 'kept on request' });
      await expect(git(host, 'rev-parse', '--verify', 'refs/heads/feat/archive')).resolves.toMatch(/[0-9a-f]{40}/);
    });

    it('deletes a merged remote branch only on request and only while it still points at the merged commit', async () => {
      const a = await hostWithRemote(root, 'api');
      const b = await hostWithRemote(root, 'web');
      const workspacePath = await inPlaceWorkspace(root, [a.host, b.host]);
      const api = (await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' })).worktreePath;
      const web = (await isolateWorkspaceRepo(workspacePath, 'web', { branchName: 'feat/archive' })).worktreePath;
      await commitAndPush(api, 'api.txt', 'feat/archive');
      await mergeOnForge(a.forge, 'feat/archive');
      const webTip = await commitAndPush(web, 'web.txt', 'feat/archive');
      await mergeOnForge(b.forge, 'feat/archive');
      // Someone pushed to the web branch after it was merged: its remote tip moved.
      await git(b.forge, 'checkout', '-b', 'feat/archive', 'origin/feat/archive');
      await fs.writeFile(path.join(b.forge, 'late.txt'), 'late\n');
      await git(b.forge, 'add', 'late.txt');
      await git(b.forge, 'commit', '-m', 'late');
      await git(b.forge, 'push', 'origin', 'feat/archive');

      const report = await archiveWorkspace(workspacePath, { deleteRemoteBranches: true });
      expect(report.archived).toBe(true);
      const byRepo = Object.fromEntries(report.branches.map((plan) => [plan.repo, plan]));
      expect(byRepo.api).toMatchObject({ local: 'delete', remote: 'delete', result: { local: 'deleted', remote: 'deleted' } });
      expect(byRepo.web).toMatchObject({ local: 'delete', remote: 'keep', result: { local: 'deleted', remote: 'kept' } });
      expect(await git(a.host, 'ls-remote', '--heads', 'origin', 'feat/archive')).toBe('');
      expect(await git(b.host, 'ls-remote', '--heads', 'origin', 'feat/archive')).not.toContain(webTip);
      expect((await loadFeatureConfig(workspacePath))?.archive?.repos[0]).toMatchObject({ branchDeleted: true, remoteBranchDeleted: true });
    });

    it('reports a failed remote deletion without failing the archive', async () => {
      const { host, remote } = await hostWithRemote(root, 'api');
      const workspacePath = await inPlaceWorkspace(root, [host]);
      const { worktreePath } = await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' });
      const tip = await commitAndPush(worktreePath, 'x.txt', 'feat/archive');
      await git(host, 'push', 'origin', `${tip}:refs/heads/main`);
      // The remote refuses every ref update from now on.
      const hook = path.join(remote, 'hooks', 'pre-receive');
      await fs.writeFile(hook, '#!/bin/sh\necho "protected by policy" >&2\nexit 1\n');
      await fs.chmod(hook, 0o755);

      const report = await archiveWorkspace(workspacePath, { deleteRemoteBranches: true });
      expect(report.archived).toBe(true);
      expect(report.branches[0]).toMatchObject({ remote: 'delete', result: { local: 'deleted', remote: 'failed' } });
      expect(report.notes.join(' ')).toMatch(/was not fully deleted/);
      expect(await git(host, 'ls-remote', '--heads', 'origin', 'feat/archive')).toContain(tip);
      expect((await loadFeatureConfig(workspacePath))?.archive?.repos[0]).toMatchObject({ branchDeleted: true });
      expect((await loadFeatureConfig(workspacePath))?.archive?.repos[0]?.remoteBranchDeleted).toBeUndefined();
    });
  });
  describe('review regressions', () => {
    it('re-checks a worktree that exists again after an interrupted run, instead of trusting the journal', async () => {
      const a = await hostWithRemote(root, 'one');
      const b = await hostWithRemote(root, 'two');
      const workspacePath = await inPlaceWorkspace(root, [a.host, b.host]);
      const one = (await isolateWorkspaceRepo(workspacePath, 'one', { branchName: 'feat/archive' })).worktreePath;
      const two = (await isolateWorkspaceRepo(workspacePath, 'two', { branchName: 'feat/archive' })).worktreePath;
      await git(b.host, 'worktree', 'lock', two);
      expect((await archiveWorkspace(workspacePath)).archived).toBe(false);
      expect(await exists(one)).toBe(false);
      // The worktree is recreated on its branch and work starts again.
      await git(a.host, 'worktree', 'add', one, 'feat/archive');
      await fs.writeFile(path.join(one, 'new-work.txt'), 'uncommitted\n');
      await git(b.host, 'worktree', 'unlock', two);

      const report = await archiveWorkspace(workspacePath);
      expect(report.archived).toBe(false);
      expect(report.repos[0]).toMatchObject({ name: 'one', action: 'blocked', branchState: 'dirty' });
      expect(await fs.readFile(path.join(one, 'new-work.txt'), 'utf-8')).toBe('uncommitted\n');
      await expect(git(a.host, 'rev-parse', '--verify', 'refs/heads/feat/archive')).resolves.toMatch(/[0-9a-f]{40}/);
    });

    it('stops without removing anything when a repository is prepared for editing while archive checks', async () => {
      const a = await hostWithRemote(root, 'api');
      const b = await hostWithRemote(root, 'web');
      const workspacePath = await inPlaceWorkspace(root, [a.host, b.host]);
      const api = (await isolateWorkspaceRepo(workspacePath, 'api', { branchName: 'feat/archive' })).worktreePath;
      let web = '';
      hooks.duringFetch = async () => {
        web = (await isolateWorkspaceRepo(workspacePath, 'web', { branchName: 'feat/late' })).worktreePath;
      };

      const report = await archiveWorkspace(workspacePath);

      expect(report.archived).toBe(false);
      expect(report.blockers[0]).toMatch(/changed while archive was checking it/);
      expect(await exists(api)).toBe(true);
      expect(await exists(web)).toBe(true);
      const feature = (await loadFeatureConfig(workspacePath))!;
      expect(feature.archivedAt).toBeUndefined();
      expect(Object.keys(feature.isolatedRepos ?? {}).sort()).toEqual(['api', 'web']);
    });

    it('a resumed run without --park still records that unmerged work was parked', async () => {
      const a = await hostWithRemote(root, 'parked');
      const b = await hostWithRemote(root, 'other');
      const workspacePath = await inPlaceWorkspace(root, [a.host, b.host]);
      const parked = (await isolateWorkspaceRepo(workspacePath, 'parked', { branchName: 'feat/archive' })).worktreePath;
      const other = (await isolateWorkspaceRepo(workspacePath, 'other', { branchName: 'feat/archive' })).worktreePath;
      await commitAndPush(parked, 'unmerged.txt', 'feat/archive');
      await git(b.host, 'worktree', 'lock', other);
      expect((await archiveWorkspace(workspacePath, { park: true })).archived).toBe(false);
      await git(b.host, 'worktree', 'unlock', other);

      expect((await archiveWorkspace(workspacePath)).archived).toBe(true);
      expect((await loadFeatureConfig(workspacePath))?.archive).toMatchObject({ parked: true, repos: [{ branchState: 'parked' }, { branchState: 'merged' }] });
    });
  });
});
