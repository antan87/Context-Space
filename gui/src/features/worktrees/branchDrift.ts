/**
 * A workspace's folder can end up on a different branch than the one the workspace edits on: someone
 * switches it in a terminal or an editor, or two branches of one repository share a folder. The files
 * on screen then belong to another branch and nothing said so. These helpers pick out those folders.
 *
 * The expected branch comes from the server (`WorkspaceRepository.expectedBranch` / `onExpectedBranch`),
 * the same answer the commit screen already uses, so this can never disagree with it.
 */
import type { WorkspaceRepository } from '../../types.js';
import type { RepoWorktreeGroup, WorktreeDescriptor } from './types.js';

export interface BranchDrift {
  repoName: string;
  /** The folder the workspace edits in. */
  path: string;
  /** The branch it is on now, or null when detached. */
  actual: string | null;
  /** The branch this workspace edits on. */
  expected: string;
}

/** Editable repositories that are not on the branch this workspace edits on. A read-only reference never counts. */
export function branchDrifts(repositories: readonly WorkspaceRepository[] | undefined): BranchDrift[] {
  return (repositories ?? [])
    .filter((repo) => repo.editable && !repo.onExpectedBranch && Boolean(repo.expectedBranch))
    .map((repo) => ({ repoName: repo.name, path: repo.path, actual: repo.branch, expected: repo.expectedBranch as string }));
}

/** Whether this working folder is known to be on the wrong branch. Unknown (no live state yet) is not wrong. */
export function isOffBranch(worktree: Pick<WorktreeDescriptor, 'expectedBranch' | 'onExpectedBranch'> | undefined): boolean {
  return Boolean(worktree?.expectedBranch) && worktree?.onExpectedBranch === false;
}

export function hasBranchDrift(groups: readonly RepoWorktreeGroup[]): boolean {
  return groups.some((group) => !group.isHostRepo && isOffBranch(group.worktrees[0]));
}

/** The command that puts the folder back on the right branch. The app shows it for copying and never runs it. */
export function switchBackCommand(drift: Pick<BranchDrift, 'path' | 'expected'>): string {
  return `git -C "${drift.path}" switch ${drift.expected}`;
}
