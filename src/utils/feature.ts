/**
 * @module utils/feature
 * Helpers for working with {@link Feature} manifests.
 */

import * as path from 'node:path';

import type { Feature, WorkspaceMode, IsolatedRepoInfo } from '../types.js';

/** The mode assumed for manifests written before {@link WorkspaceMode} existed. */
export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'worktree';

/**
 * Normalizes a freshly-parsed `nexusflow.json` manifest so downstream code can
 * rely on `mode` being concrete. Manifests created before modes existed lack
 * the field and are always worktree-based.
 *
 * @param feature - The parsed manifest.
 * @returns The same feature with `mode` guaranteed to be set.
 */
export function normalizeFeature(feature: Feature): Feature {
  return { ...feature, mode: feature.mode ?? DEFAULT_WORKSPACE_MODE };
}

/**
 * Whether a feature works directly in the source repositories (no worktrees).
 */
export function isInPlace(feature: Feature): boolean {
  return feature.mode === 'in-place';
}

function getIsolatedRepo(feature: Feature, repoNameOrPath: string): IsolatedRepoInfo | undefined {
  if (!feature.isolatedRepos) return undefined;
  const direct = feature.isolatedRepos[repoNameOrPath] ?? feature.isolatedRepos[path.basename(repoNameOrPath)];
  if (direct) return direct;
  const target = repoNameOrPath.toLowerCase();
  const baseTarget = path.basename(repoNameOrPath).toLowerCase();
  const key = Object.keys(feature.isolatedRepos).find((k) => {
    const lk = k.toLowerCase();
    return lk === target || lk === baseTarget;
  });
  return key ? feature.isolatedRepos[key] : undefined;
}

/**
 * Resolves where one of a feature's repos actually lives on disk — THE single
 * source of truth for the mode rule. Worktree repos live inside the workspace
 * dir (re-derived from the basename so a relocated workspace still resolves);
 * in-place repos are the source repositories at their stored absolute paths,
 * unless dynamically isolated into a dedicated worktree on-demand.
 *
 * @param feature       - The feature the repo belongs to.
 * @param workspacePath - The workspace directory's CURRENT location (callers
 *                        may know a fresher path than the manifest records).
 * @param repoPath      - The repo entry as stored in `feature.repos`.
 */
export function resolveFeatureRepoPath(
  feature: Feature,
  workspacePath: string,
  repoPath: string,
): string {
  if (isInPlace(feature)) {
    const isolated = getIsolatedRepo(feature, repoPath);
    if (isolated?.worktreePath) {
      return path.resolve(isolated.worktreePath);
    }
    return repoPath;
  }
  return path.resolve(workspacePath, path.basename(repoPath));
}

/**
 * Whether a specific repository in a feature is currently isolated in a
 * dedicated worktree.
 *
 * @param feature        - The feature manifest.
 * @param repoNameOrPath - Directory name or path of the repository.
 */
export function isRepoIsolated(feature: Feature, repoNameOrPath: string): boolean {
  if (!isInPlace(feature)) return true;
  return Boolean(getIsolatedRepo(feature, repoNameOrPath));
}

/**
 * The directory an agent session should run in for a feature: always the
 * workspace dir. The generated context files (CLAUDE.md, AGENTS.md,
 * knowledge) live there and are invisible from anywhere else —
 * for in-place features those files direct the agent to the source repos'
 * absolute paths. Kept as the single authority so every launcher (CLI, GUI,
 * resume endpoint) agrees and session discovery stays consistent.
 */
export function getSessionCwd(feature: Feature): string {
  return feature.workspacePath;
}

