/**
 * Normalizes legacy Feature workspaces into RepoWorktreeGroups with Bifocal Metadata.
 * File: gui/src/features/worktrees/normalizeWorktrees.ts
 *
 * Live repository state (branch, HEAD, changed files) wins over the manifest,
 * which only records what was true at creation. Without live state, fields
 * stay unknown rather than being inferred.
 */
import type { Feature, WorkspaceRepository, WorkspaceStatus } from '../../types.js';
import type { RepoWorktreeGroup, WorktreeDescriptor } from './types.js';

export function normalizeWorktreeGroups(
  feature: Feature,
  status?: WorkspaceStatus,
  repositories?: WorkspaceRepository[],
): RepoWorktreeGroup[] {
  if (!feature || typeof feature !== 'object') return [];

  const groups: RepoWorktreeGroup[] = [];

  const repos = Array.isArray(feature.repos) ? feature.repos : [];
  for (const repoPath of repos) {
    if (!repoPath || typeof repoPath !== 'string') continue;
    const repoName = repoPath.split(/[/\\]/).filter(Boolean).pop() || repoPath;
    const sanitizedRepoPath = repoPath.replace(/[^a-zA-Z0-9]/g, '_');
    const isolated = feature.isolatedRepos?.[repoName];
    const inPlace = feature.mode === 'in-place';
    const live = repositories?.find((r) => r.name === repoName);
    // An in-place repo that has not been prepared for editing is the user's own checkout.
    const reference = live ? !live.editable : inPlace && !isolated;
    const sourcePath = live?.sourcePath
      || feature.originalRepos?.find((r) => r.split(/[/\\]/).filter(Boolean).pop() === repoName)
      || repoPath;
    const worktreePath = live?.path || isolated?.worktreePath || repoPath;
    const branch = live
      ? live.branch ?? 'detached HEAD'
      : isolated?.branchName || (inPlace ? feature.repoBranches?.[repoName] : feature.branchName) || 'unknown';
    // Workspace status is aggregate; it cannot establish a per-repo count in a multi-repo workspace.
    const dirtyFilesCount = live
      ? live.changedFiles.length
      : status && (repos.length === 1 || status.changedFiles === 0)
        ? Math.max(0, status.changedFiles) : null;
    // IDs key saved custom titles, so they stay on the manifest branch even
    // when the live branch differs.
    const idBranch = isolated?.branchName || (inPlace ? feature.repoBranches?.[repoName] : feature.branchName) || 'unknown';
    const worktrees: WorktreeDescriptor[] = [{
      id: `wt-${repoName}-${idBranch}-${sanitizedRepoPath}`,
      workspaceId: feature.branchName || '',
      repoName,
      repoPath,
      sourcePath,
      worktreePath,
      branchName: branch,
      baseBranch: live?.baseBranch ?? isolated?.baseBranch,
      title: reference
        ? `${repoName} (read-only reference)`
        : feature.description && feature.description.length > 3 && feature.description.length < 55
          ? feature.description : formatBranchTitle(branch),
      intent: reference
        ? `Your own checkout at ${sourcePath}. Prepare it for editing to change it in this workspace.`
        : `Editable at ${worktreePath} on ${branch}`,
      status: reference ? 'host_readonly' : dirtyFilesCount === null ? 'unknown' : dirtyFilesCount > 0 ? 'dirty' : 'clean',
      isPinned: false,
      isHostReadOnly: reference,
      commitSha: live?.headSha ?? '',
      dirtyFilesCount,
      // The server decides what the expected branch is (the same answer the commit screen uses), so the two
      // cannot disagree. A read-only reference is not edited here, so it has none.
      ...(live?.editable && live.expectedBranch ? { expectedBranch: live.expectedBranch, onExpectedBranch: live.onExpectedBranch } : {}),
      isolatedAt: isolated?.isolatedAt || feature.createdAt,
    }];

    // A source reference is distinct from the working checkout and has no live telemetry here.
    if (sourcePath !== worktreePath) {
      worktrees.push({
        id: `wt-${repoName}-host-${sanitizedRepoPath}`,
        workspaceId: feature.branchName || '',
        repoName,
        repoPath: sourcePath,
        sourcePath,
        worktreePath: sourcePath,
        branchName: live?.baseBranch || isolated?.baseBranch || 'unknown',
        title: `${repoName} Host Baseline`,
        intent: 'Source repository reference',
        status: 'host_readonly',
        isPinned: false,
        isHostReadOnly: true,
        commitSha: '',
        dirtyFilesCount: null,
      });
    }
    groups.push({ repoName, repoPath, isHostRepo: reference, sourcePath, worktrees });
  }

  return groups;
}

export function formatBranchTitle(branchName?: string): string {
  if (!branchName || typeof branchName !== 'string') return 'Untitled Worktree';
  const clean = branchName.replace(/^(feat|fix|bug|refactor|epic|chore)\//i, '');
  return clean
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Whether any repository in the workspace is still the user's own checkout and has to be prepared before it can
 * be edited. The read-only baseline that sits beside an editable copy does not count: that repository is prepared.
 */
export function hasUnpreparedRepo(groups: readonly RepoWorktreeGroup[]): boolean {
  return groups.some((group) => group.isHostRepo);
}
