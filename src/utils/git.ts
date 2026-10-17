/**
 * @module utils/git
 * Low-level git helper functions used throughout NexusFlow.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';
import { gitStateFingerprint, reuseWhileGitStateIs } from './git-state.js';

/**
 * Checks whether the given directory is a git repository
 * by testing for the presence of a `.git` entry.
 *
 * @param dirPath - Absolute path to the directory.
 * @returns `true` if a `.git` file or directory exists.
 */
export async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const gitPath = path.join(dirPath, '.git');
    await fs.access(gitPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `git fetch origin` inside the given repository.
 *
 * @param repoPath - Absolute path to the repo root.
 */
export async function gitFetch(repoPath: string): Promise<void> {
  await execa('git', ['fetch', 'origin'], { cwd: repoPath });
}

/**
 * Detects the default branch of a repository.
 *
 * Tries several strategies in order of authority so that repos without an
 * `origin/main`/`origin/master` remote branch — including remote-less local
 * repos — resolve to a real, checkout-able branch instead of a blind `'main'`
 * (which would make {@link import('../core/worktree.js')} fail with
 * `fatal: invalid reference: main`):
 *
 * 1. `origin/HEAD` symbolic-ref — authoritative, set at clone time.
 * 2. Remote-tracking branches — prefer `origin/main`, then `origin/master`.
 * 3. Local branches named `main`/`master` (repo has no remote yet).
 * 4. The currently checked-out branch — the best base for a remote-less repo.
 * 5. Last resort — `'main'`.
 *
 * @param repoPath - Absolute path to the repo root.
 * @returns The name of the default branch.
 */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  // Up to three git processes, asked on every repository listing and status read; the answer only changes with the
  // refs, so it is reused while they are unchanged.
  return reuseWhileGitStateIs(repoPath, 'default-branch', await gitStateFingerprint(repoPath), () => findDefaultBranch(repoPath));
}

async function findDefaultBranch(repoPath: string): Promise<string> {
  // 1. origin/HEAD is what `git clone` records as the remote's default branch.
  try {
    const { stdout } = await execa(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd: repoPath },
    );
    const prefix = 'refs/remotes/origin/';
    const ref = stdout.trim();
    if (ref.startsWith(prefix)) {
      const branch = ref.slice(prefix.length);
      if (branch) {
        return branch;
      }
    }
  } catch {
    // origin/HEAD is often unset on manually-added remotes; try the next strategy.
  }

  // 2. Scan remote-tracking branches, preferring main over master.
  try {
    const { stdout } = await execa('git', ['branch', '-r'], { cwd: repoPath });
    const branches = stdout.split('\n').map((b) => b.trim());

    if (branches.some((b) => b === 'origin/main' || b.endsWith('/origin/main'))) {
      return 'main';
    }

    if (branches.some((b) => b === 'origin/master' || b.endsWith('/origin/master'))) {
      return 'master';
    }
  } catch {
    // No remote or `git branch -r` failed — fall through to local heuristics.
  }

  // 3. Local branches named main/master, for a repo that has no remote yet.
  try {
    const { stdout } = await execa('git', ['branch', '--list', 'main', 'master'], {
      cwd: repoPath,
    });
    const locals = stdout
      .split('\n')
      .map((b) => b.replace(/^[*+]?\s*/, '').trim())
      .filter(Boolean);
    if (locals.includes('main')) {
      return 'main';
    }
    if (locals.includes('master')) {
      return 'master';
    }
  } catch {
    // No local main/master — fall through.
  }

  // 4. The checked-out branch is the most sensible base for a remote-less repo.
  try {
    const { stdout } = await execa('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: repoPath,
    });
    const current = stdout.trim();
    if (current) {
      return current;
    }
  } catch {
    // Detached HEAD or not a repo — fall through to the last-resort default.
  }

  // 5. Last resort — assume main.
  return 'main';
}

/** Local and origin branches of a repository. */
export interface RepoBranches {
  /** Local branch names. */
  local: string[];
  /** Branches on origin (without the `origin/` prefix, `origin/HEAD` excluded). */
  remote: string[];
}

/**
 * Lists the local and origin branches of a repository.
 *
 * Reads the local refs only (no fetch) — callers that need fresh remote state
 * should fetch first. Returns empty lists when the path is not a git repo.
 *
 * @param repoPath - Absolute path to the repo root.
 */
export async function listBranches(repoPath: string): Promise<RepoBranches> {
  const local: string[] = [];
  const remote: string[] = [];
  try {
    const { stdout } = await execa(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'],
      { cwd: repoPath },
    );
    for (const line of stdout.split('\n')) {
      const ref = line.trim();
      if (!ref) continue;
      if (ref.startsWith('origin/')) {
        const name = ref.slice('origin/'.length);
        if (name && name !== 'HEAD') {
          remote.push(name);
        }
      } else {
        local.push(ref);
      }
    }
  } catch {
    // Not a git repo or git failed — report no branches.
  }
  return { local, remote };
}

/**
 * Checks if the given branch name matches Git branch conventions (based on git-check-ref-format):
 * - No spaces, backslashes, or control characters.
 * - At least 1 character long.
 * - Is not exactly '@'.
 * - Does not start with a dash.
 * - Does not start or end with a forward slash.
 * - Does not contain consecutive dots, consecutive slashes, or '@{'.
 * - Does not end with '.'.
 * - Does not contain forbidden characters: ~, ^, :, ?, *, [
 * - No component starts with a dot, ends with '.lock', or is exactly 'HEAD'.
 *
 * @param name - The branch name to validate.
 * @returns `true` if the branch name is valid.
 */
const WINDOWS_RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isValidBranchName(name: string): boolean {
  if (!name || name.length === 0) {
    return false;
  }
  if (name === '@') {
    return false;
  }
  if (name.startsWith('-')) {
    return false;
  }
  const forbiddenCharsOrSpaces = /[\x00-\x20\x7F~^:?*[\\]/;
  if (forbiddenCharsOrSpaces.test(name)) {
    return false;
  }
  if (name.includes('..') || name.includes('@{') || name.includes('//')) {
    return false;
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    return false;
  }
  if (name.endsWith('.')) {
    return false;
  }
  
  const components = name.split('/');
  for (const component of components) {
    if (component.startsWith('.')) {
      return false;
    }
    if (component.endsWith('.lock')) {
      return false;
    }
    if (component === 'HEAD') {
      return false;
    }
    if (WINDOWS_RESERVED_DEVICE_NAMES.test(component)) {
      return false;
    }
  }

  return true;
}

