import { test } from 'vitest';
import assert from 'node:assert/strict';
import { branchDrifts, hasBranchDrift, isOffBranch, switchBackCommand } from './branchDrift.ts';
import { normalizeWorktreeGroups } from './normalizeWorktrees.ts';
import type { Feature, WorkspaceRepository } from '../../types.ts';

/** A live repository as the server reports it; each test changes only what it is about. */
function live(over: Partial<WorkspaceRepository> = {}): WorkspaceRepository {
  return {
    name: 'api', access: 'worktree', editable: true, path: '/ws/demo/api', sourcePath: '/src/api',
    branch: 'feature_a', expectedBranch: 'feature_a', onExpectedBranch: true, baseBranch: 'main',
    headSha: 'abc1234', dirty: false, changedFiles: [], ahead: 0, behind: 0, remoteUrl: null,
    ...over,
  };
}

test('a folder on the branch the workspace edits on is not flagged', () => {
  assert.deepEqual(branchDrifts([live()]), []);
});

test('a folder switched to another branch is flagged with both branches and its path', () => {
  assert.deepEqual(
    branchDrifts([live({ branch: 'feature_b', onExpectedBranch: false })]),
    [{ repoName: 'api', path: '/ws/demo/api', actual: 'feature_b', expected: 'feature_a' }],
  );
});

test('a detached HEAD is flagged, with no branch name', () => {
  const [drift] = branchDrifts([live({ branch: null, onExpectedBranch: false })]);
  assert.equal(drift?.actual, null);
  assert.equal(drift?.expected, 'feature_a');
});

test('a read-only reference is never flagged, since nothing is edited there', () => {
  assert.deepEqual(branchDrifts([live({ editable: false, access: 'reference', branch: 'develop', onExpectedBranch: false })]), []);
});

test('nothing is flagged when the server names no expected branch, or has not answered yet', () => {
  assert.deepEqual(branchDrifts([live({ expectedBranch: null, onExpectedBranch: false })]), []);
  assert.deepEqual(branchDrifts(undefined), []);
  assert.deepEqual(branchDrifts([]), []);
});

test('only the repositories that moved are flagged', () => {
  const drifts = branchDrifts([live({ name: 'web', path: '/ws/demo/web' }), live({ branch: 'oops', onExpectedBranch: false })]);
  assert.deepEqual(drifts.map((d) => d.repoName), ['api']);
});

test('the fixing command is quoted so a path with spaces still works, and it names the right branch', () => {
  assert.equal(switchBackCommand({ path: '/home/me/My Work/api', expected: 'feature_a' }), 'git -C "/home/me/My Work/api" switch feature_a');
});

test('"unknown" is not "wrong": a folder with no live state is not off its branch', () => {
  assert.equal(isOffBranch(undefined), false);
  assert.equal(isOffBranch({}), false);
  assert.equal(isOffBranch({ expectedBranch: 'feature_a' }), false);
  assert.equal(isOffBranch({ expectedBranch: 'feature_a', onExpectedBranch: true }), false);
  assert.equal(isOffBranch({ expectedBranch: 'feature_a', onExpectedBranch: false }), true);
});

const feature = { mode: 'worktree', branchName: 'feature_a', repos: ['/ws/demo/api'], originalRepos: ['/src/api'] } as Feature;

test('the app model carries the server\'s expected branch for an editable folder', () => {
  const groups = normalizeWorktreeGroups(feature, undefined, [live({ branch: 'feature_b', onExpectedBranch: false })]);
  const working = groups[0]!.worktrees[0]!;
  assert.equal(working.expectedBranch, 'feature_a');
  assert.equal(working.onExpectedBranch, false);
  assert.equal(working.branchName, 'feature_b');
  assert.equal(isOffBranch(working), true);
  assert.equal(hasBranchDrift(groups), true);
});

test('an aligned folder is not flagged by the app model', () => {
  const groups = normalizeWorktreeGroups(feature, undefined, [live()]);
  assert.equal(hasBranchDrift(groups), false);
});

test('the app model has no expected branch for a read-only reference, so it cannot be flagged', () => {
  const groups = normalizeWorktreeGroups(feature, undefined, [live({ editable: false, access: 'reference', branch: 'develop', onExpectedBranch: false })]);
  const working = groups[0]!.worktrees[0]!;
  assert.equal(working.expectedBranch, undefined);
  assert.equal(hasBranchDrift(groups), false);
});

test('before live state loads nothing is flagged, even if the manifest names another branch', () => {
  const withOverride = { ...feature, repoBranches: { api: 'existing-branch' } } as Feature;
  const groups = normalizeWorktreeGroups(withOverride);
  assert.equal(groups[0]!.worktrees[0]!.expectedBranch, undefined);
  assert.equal(hasBranchDrift(groups), false);
});
