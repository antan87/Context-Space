/**
 * @module core/screen-paths
 * Decides whether a path an AI wants to show the user is inside the workspace.
 * The AI names files and the app later opens them, so a path that escapes the
 * workspace, directly or through a symlink, must never become a reference.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getWorkspaceRepoPaths } from '../utils/multi-git.js';
import { findWorkspaceRoot } from './workspace.js';

/** Longest path accepted, in characters. */
export const SCREEN_PATH_MAX_LENGTH = 1000;

export type ScreenPathErrorCode = 'invalid' | 'outside' | 'missing' | 'unknown_repo';

export class ScreenPathError extends Error {
  constructor(message: string, readonly code: ScreenPathErrorCode) {
    super(message);
    this.name = 'ScreenPathError';
  }
}

export interface ScreenTarget {
  /** Relative to the repository when `repo` is set, otherwise to the workspace folder. Forward slashes. */
  path: string;
  repo?: string;
  absolute: string;
  isDirectory: boolean;
}

interface Root { name?: string; dir: string }

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function realpathOrNull(target: string): Promise<string | null> {
  try { return await fs.realpath(target); } catch { return null; }
}

async function rootsFor(workspacePath: string): Promise<{ workspace: Root; repos: Root[] }> {
  const workspace = (await findWorkspaceRoot(workspacePath)) ?? workspacePath;
  const repos = await getWorkspaceRepoPaths(workspace).catch(() => []);
  return { workspace: { dir: workspace }, repos: repos.map((repo) => ({ name: repo.name, dir: repo.path })) };
}

/**
 * Resolves a path the AI named to a reference inside the workspace or one of
 * its repositories. Accepts a path relative to the workspace folder or a
 * repository, or an absolute path inside either. The file must exist, and its
 * real location (after symlinks) must stay inside, so a link out cannot leak.
 * Git internals are refused.
 */
export async function resolveScreenTarget(
  workspacePath: string,
  input: { path: string; repo?: string },
): Promise<ScreenTarget> {
  const raw = typeof input.path === 'string' ? input.path.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.length > SCREEN_PATH_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ScreenPathError(`The path must be 1 to ${SCREEN_PATH_MAX_LENGTH} characters without control characters.`, 'invalid');
  }
  const { workspace, repos } = await rootsFor(workspacePath);

  let candidates: Root[];
  if (input.repo !== undefined) {
    const repo = repos.find((r) => r.name?.toLowerCase() === input.repo!.trim().toLowerCase());
    if (!repo) throw new ScreenPathError(`"${input.repo}" is not a repository of this workspace.`, 'unknown_repo');
    candidates = [repo];
  } else {
    candidates = [workspace, ...repos];
  }

  let absolute: string | undefined;
  let lexicallyInside = false;
  for (const root of candidates) {
    const attempt = path.resolve(root.dir, raw);
    // path.resolve keeps an absolute path as it is, so this check covers both forms.
    if (!isInside(root.dir, attempt)) continue;
    lexicallyInside = true;
    const real = await realpathOrNull(attempt);
    const rootReal = await realpathOrNull(root.dir);
    if (!real || !rootReal) continue;
    if (!isInside(rootReal, real)) throw new ScreenPathError('That path leads outside the workspace.', 'outside');
    absolute = real;
    break;
  }
  if (!absolute) {
    if (!lexicallyInside) throw new ScreenPathError('That path is outside the workspace.', 'outside');
    throw new ScreenPathError(`"${raw}" does not exist in the workspace.`, 'missing');
  }

  // The most specific home wins: a file in a repository is shown relative to that repository.
  const homes = await Promise.all(repos.map(async (repo) => ({ repo, real: await realpathOrNull(repo.dir) })));
  const home = homes
    .filter((entry): entry is { repo: Root; real: string } => entry.real !== null && isInside(entry.real, absolute!))
    .sort((a, b) => b.real.length - a.real.length)[0];
  const base = home?.real ?? (await realpathOrNull(workspace.dir)) ?? workspace.dir;
  const relative = path.relative(base, absolute).split(path.sep).join('/');
  if (relative.split('/').some((part) => part.toLowerCase() === '.git')) {
    throw new ScreenPathError('Git internals are not shown.', 'invalid');
  }
  const stat = await fs.stat(absolute);
  return {
    path: relative,
    ...(home ? { repo: home.repo.name } : {}),
    absolute,
    isDirectory: stat.isDirectory(),
  };
}

/** Finds one of the workspace's repositories by name, for showing its changes. */
export async function resolveScreenRepo(workspacePath: string, name: string): Promise<{ name: string; absolute: string }> {
  const { repos } = await rootsFor(workspacePath);
  const repo = repos.find((r) => r.name?.toLowerCase() === name.trim().toLowerCase());
  if (!repo) throw new ScreenPathError(`"${name}" is not a repository of this workspace.`, 'unknown_repo');
  return { name: repo.name!, absolute: repo.dir };
}
