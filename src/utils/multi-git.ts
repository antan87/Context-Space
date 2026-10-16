/**
 * @module utils/multi-git
 * Shared utility functions for multi-repo git operations.
 *
 * Provides helpers for querying repo status, rebasing, committing, pushing,
 * and generating diff summaries across all repos in a NexusFlow workspace.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';

import type { Feature, SyncStatus } from '../types.js';
import { detectDefaultBranch } from './git.js';
import { isInPlace, normalizeFeature, resolveFeatureRepoPath } from './feature.js';

export type { SyncStatus };

// ─── Types ────────────────────────────────────────────────────────────────────

/** Metadata about a single repo within a workspace. */
export interface WorkspaceRepo {
  /** Directory name of the repo (e.g. 'api-gateway'). */
  name: string;
  /** Absolute path to the repo worktree inside the workspace. */
  path: string;
  /** Feature branch name shared across the workspace. */
  branchName: string;
  /** Default branch of the repo (e.g. 'main' or 'master'). */
  defaultBranch: string;
}

/** A single changed file with its porcelain status code. */
export interface RepoStatusFile {
  /** Two-character porcelain code, e.g. ' M', 'A ', '??'. */
  code: string;
  /** Path relative to the repo root. */
  path: string;
}

/** Result of inspecting the working-tree status of a repo. */
export interface RepoStatus {
  /** Whether any tracked or untracked files have been modified. */
  hasChanges: boolean;
  /** List of changed file paths (relative to repo root). */
  changedFiles: string[];
  /** Changed files with their porcelain status codes. */
  files: RepoStatusFile[];
  /** Human-readable summary, e.g. '3 files changed'. */
  summary: string;
}

/**
 * Result of a rebase operation.
 *
 * The classified {@link SyncStatus} values mean:
 * - `up-to-date`     — branch already contained the latest base commits.
 * - `rebased`        — new base commits were applied cleanly.
 * - `conflict`       — a genuine merge conflict; the rebase was aborted.
 * - `stash-conflict` — the rebase succeeded but re-applying auto-stashed local
 *                      changes conflicted; the stash is preserved for manual merge.
 * - `error`          — an infrastructure failure (network/auth on fetch, etc.) that
 *                      is *not* a merge conflict.
 */
export interface RebaseResult {
  /**
   * Whether the rebase itself completed. True for `up-to-date`, `rebased`, and
   * `stash-conflict` (the rebase landed; only the stash pop needs attention).
   */
  success: boolean;
  /** Classified outcome. */
  status: SyncStatus;
  /** Human-readable outcome message. */
  message: string;
  /** Stderr output — populated only for `status === 'conflict'`. */
  conflict?: string;
  /** Paths that had merge conflicts — populated only for `status === 'conflict'`. */
  conflictFiles?: string[];
  /** Whether dirty working-tree changes were auto-stashed during the operation. */
  stashed?: boolean;
}

/** Result of a commit-and-push operation. */
export interface CommitResult {
  /** Whether the commit (and optional push) succeeded. */
  success: boolean;
  /**
   * Whether a commit was created. A push can fail after this is true: the
   * commit then exists locally (see `commitHash`) and only the push is retried.
   */
  committed?: boolean;
  /** Whether the branch was pushed in this call. */
  pushed?: boolean;
  /** Why the push failed after a successful commit. */
  pushError?: string;
  /** Short commit hash, e.g. 'a1b2c3d'. */
  commitHash: string;
  /** Number of files included in the commit. */
  filesChanged: number;
  /** Human-readable outcome message. */
  message: string;
  /** Sensitive files withheld from staging to prevent secret exfiltration. */
  withheldFiles?: string[];
}

/** Result of a diff summary. */
export interface DiffSummary {
  /** Combined human-readable diff stat output. */
  summary: string;
  /** Total number of added lines. */
  additions: number;
  /** Total number of deleted lines. */
  deletions: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses the shortstat line produced by `git diff --stat` to extract
 * insertions and deletions counts.
 *
 * @param statOutput - Raw stdout from `git diff --stat`.
 * @returns A tuple of [additions, deletions].
 */
function parseStatCounts(statOutput: string): [number, number] {
  let additions = 0;
  let deletions = 0;

  // The last line of --stat output looks like:
  //   3 files changed, 12 insertions(+), 4 deletions(-)
  const summaryLine = statOutput.trim().split('\n').pop() ?? '';

  const insertMatch = summaryLine.match(/(\d+)\s+insertion/);
  if (insertMatch) additions = parseInt(insertMatch[1], 10);

  const deleteMatch = summaryLine.match(/(\d+)\s+deletion/);
  if (deleteMatch) deletions = parseInt(deleteMatch[1], 10);

  return [additions, deletions];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads the `nexusflow.json` manifest from a workspace directory and returns
 * metadata for each repo contained in the workspace.
 *
 * @param workspacePath - Absolute path to the workspace directory.
 * @returns Array of repo metadata objects.
 * @throws If `nexusflow.json` cannot be read or parsed.
 */
import { PRIMARY_MANIFEST_FILE, LEGACY_MANIFEST_FILE } from '../core/constants.js';

export async function getWorkspaceRepos(
  workspacePath: string,
): Promise<WorkspaceRepo[]> {
  const feature = await readWorkspaceManifest(workspacePath);

  return Promise.all(
    feature.repos.map(async (repoPath) => {
      const name = path.basename(repoPath);
      const absolutePath = resolveFeatureRepoPath(feature, workspacePath, repoPath);
      const isolated = isInPlace(feature)
        ? Object.entries(feature.isolatedRepos ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
        : undefined;
      // An unisolated in-place repo has no feature branch — its current branch
      // is whatever the user is working on ('HEAD' when detached). An isolated
      // repo expects the branch it was prepared on, and a worktree repo its
      // own existing branch when one was chosen at creation.
      const [defaultBranch, currentBranch] = await Promise.all([
        detectDefaultBranch(absolutePath),
        isInPlace(feature) && !isolated?.branchName ? getRepoBranch(absolutePath) : Promise.resolve(null),
      ]);
      const branchName = isInPlace(feature)
        ? isolated?.branchName || (currentBranch ?? 'HEAD')
        : feature.repoBranches?.[name] ?? feature.branchName;
      return {
        name,
        path: absolutePath,
        branchName,
        defaultBranch,
      };
    })
  );
}

/**
 * Each repo's name and absolute path, from the manifest alone. Runs no git: finding the branches costs up to four
 * git processes per repo, which a caller that polls and only needs paths should not pay.
 *
 * @throws If the manifest cannot be read or parsed.
 */
export async function getWorkspaceRepoPaths(workspacePath: string): Promise<Array<Pick<WorkspaceRepo, 'name' | 'path'>>> {
  const feature = await readWorkspaceManifest(workspacePath);
  return feature.repos.map((repoPath) => ({ name: path.basename(repoPath), path: resolveFeatureRepoPath(feature, workspacePath, repoPath) }));
}

async function readWorkspaceManifest(workspacePath: string): Promise<Feature> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspacePath, PRIMARY_MANIFEST_FILE), 'utf-8');
  } catch {
    raw = await fs.readFile(path.join(workspacePath, LEGACY_MANIFEST_FILE), 'utf-8');
  }
  return normalizeFeature(JSON.parse(raw) as Feature);
}

/**
 * Parses `git status --porcelain -z` NUL-delimited output.
 * Handles renames (which emit an extra NUL-separated source path) and unquoted paths safely.
 */
export function parsePorcelainZ(stdout: string): RepoStatusFile[] {
  if (!stdout) return [];
  const entries: RepoStatusFile[] = [];
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const code = part.slice(0, 2);
    const pathStr = part.slice(3);
    if (code.includes('R') || code.includes('C')) {
      // In porcelain -z, a rename or copy record is immediately followed by the source path
      i++;
    }
    if (pathStr) {
      entries.push({ code, path: pathStr });
    }
  }
  return entries;
}

const SENSITIVE_FILE_PATTERNS = [
  /^\.env/i,
  /.*\.pem$/i,
  /.*\.key$/i,
  /.*\.pfx$/i,
  /.*\.p12$/i,
  /.*\.pkcs12$/i,
  /.*id_rsa($|\..*)/i,
  /.*id_ed25519($|\..*)/i,
  /.*id_dsa($|\..*)/i,
  /.*id_ecdsa($|\..*)/i,
  /.*credentials.*\.json$/i,
  /.*secrets?.*\.json$/i,
  /.*token.*\.json$/i,
  /.*secret.*\.ya?ml$/i,
  /.*credential.*\.ya?ml$/i,
  /.*\.kdbx$/i,
];

/**
 * Checks whether a file matches known sensitive file patterns (e.g. .env, .envrc,
 * private keys, credential files) based on its basename.
 *
 * Note: Evaluation is intentionally scoped to the file basename (not parent directory paths)
 * to prevent false positives on paths like `i18n/tokens/strings.json` or `locales/secrets/en.json`.
 *
 * @param filePath - Path to the file.
 * @returns `true` if the file basename matches sensitive patterns.
 */
export function isSensitiveFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  if (/\.example($|\.)|\.template($|\.)|\.sample($|\.)/i.test(base)) {
    return false;
  }
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Inspects the working-tree status of a git repository.
 *
 * Runs `git status --porcelain -z -uall` and parses the output to determine which
 * files have been modified, added, or deleted.
 *
 * @param repoPath - Absolute path to the repo root.
 * @returns Status information including changed file list and summary string.
 */
export async function getRepoStatus(repoPath: string, options: { readOnly?: boolean } = {}): Promise<RepoStatus> {
  try {
    // readOnly: background checks must not rewrite the index or take
    // index.lock while the user runs git.
    const args = [...(options.readOnly ? ['--no-optional-locks'] : []), 'status', '--porcelain', '-z', '-uall'];
    const { stdout } = await execa('git', args, {
      cwd: repoPath,
    });

    const files = parsePorcelainZ(stdout);
    const changedFiles = files.map((f) => f.path);

    return {
      hasChanges: changedFiles.length > 0,
      changedFiles,
      files,
      summary:
        changedFiles.length === 0
          ? 'Clean'
          : `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed`,
    };
  } catch (error) {
    return {
      hasChanges: false,
      changedFiles: [],
      files: [],
      summary: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Counts commits on the current branch that have not been pushed to
 * `origin/<branchName>` yet.
 *
 * @param repoPath   - Absolute path to the repo root.
 * @param branchName - Branch to compare against on origin.
 * @returns Number of unpushed commits, or null when the remote branch does
 *          not exist (never pushed) or git fails.
 */
export async function getUnpushedCount(
  repoPath: string,
  branchName: string,
): Promise<number | null> {
  // Detached HEAD ('HEAD' sentinel from in-place features): origin/HEAD is a
  // symref to origin's default branch, so the count would be meaningless.
  if (branchName === 'HEAD') return null;
  try {
    const { stdout } = await execa(
      'git',
      ['rev-list', '--count', `origin/${branchName}..HEAD`],
      { cwd: repoPath },
    );
    return parseInt(stdout.trim(), 10);
  } catch {
    return null;
  }
}

/**
 * Returns the name of the currently checked-out branch.
 *
 * @param repoPath - Absolute path to the repo root.
 * @returns The branch name, or `null` when the repo is in a detached-HEAD
 *          state or git fails.
 */
export async function getRepoBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
    });
    const branch = stdout.trim();
    // A detached HEAD reports the literal 'HEAD'.
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Counts how many commits the current branch is ahead of / behind
 * `origin/<branchName>`.
 *
 * @param repoPath   - Absolute path to the repo root.
 * @param branchName - Branch to compare against on origin.
 * @returns `{ ahead, behind }`. Both are `null` when the remote branch does
 *          not exist (never pushed) or git fails.
 */
export async function getAheadBehind(
  repoPath: string,
  branchName: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  // Detached HEAD ('HEAD' sentinel from in-place features): origin/HEAD is a
  // symref to origin's default branch — counts against it would be bogus.
  if (branchName === 'HEAD') return { ahead: null, behind: null };
  try {
    const { stdout } = await execa(
      'git',
      ['rev-list', '--left-right', '--count', `origin/${branchName}...HEAD`],
      { cwd: repoPath },
    );
    // Output is "<behind>\t<ahead>": left = commits only on origin, right = only on HEAD.
    const [behindStr, aheadStr] = stdout.trim().split(/\s+/);
    const behind = Number.parseInt(behindStr, 10);
    const ahead = Number.parseInt(aheadStr, 10);
    return {
      ahead: Number.isNaN(ahead) ? null : ahead,
      behind: Number.isNaN(behind) ? null : behind,
    };
  } catch {
    return { ahead: null, behind: null };
  }
}

/**
 * Returns the URL of a git remote.
 *
 * @param repoPath - Absolute path to the repo root.
 * @param remote   - Remote name (default `'origin'`).
 * @returns The remote URL, or `null` when the remote does not exist.
 */
export async function getRemoteUrl(
  repoPath: string,
  remote = 'origin',
): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['remote', 'get-url', remote], {
      cwd: repoPath,
    });
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Pushes the current branch to origin, setting the upstream on first push.
 *
 * @param repoPath   - Absolute path to the repo root.
 * @param branchName - Branch to push.
 * @returns `{ success, message }`.
 */
export async function pushRepo(
  repoPath: string,
  branchName: string,
): Promise<{ success: boolean; message: string }> {
  try {
    await execa('git', ['push', '-u', 'origin', branchName], { cwd: repoPath });
    return { success: true, message: `Pushed ${branchName} to origin` };
  } catch (error) {
    return { success: false, message: errText(error).split('\n')[0] };
  }
}

/**
 * Extracts the stderr (falling back to the message) from a thrown execa error.
 */
function errText(error: unknown): string {
  if (error instanceof Error && 'stderr' in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rebases the current branch on top of the latest upstream base branch, while
 * safely preserving any uncommitted local changes.
 *
 * Unlike a bare `git rebase`, this is safe to call from non-interactive agents
 * against a *dirty* working tree: dirty changes are stashed first and restored
 * afterwards. The outcome is classified (see {@link SyncStatus}) so that a dirty
 * tree or a network failure is never mis-reported as a merge conflict.
 *
 * Sequence: `git fetch` → (stash if dirty) → `git rebase origin/{base}` →
 * (pop the stash if one was made).
 *
 * @param repoPath   - Absolute path to the repo root.
 * @param baseBranch - The upstream branch to rebase onto (e.g. 'main').
 * @returns Classified result; `conflict` text is set only for real merge conflicts.
 */
export async function rebaseRepo(
  repoPath: string,
  baseBranch: string,
): Promise<RebaseResult> {
  // 1. Fetch latest from origin. A failure here is infrastructure (network/auth),
  //    not a conflict.
  try {
    await execa('git', ['fetch', 'origin'], { cwd: repoPath });
  } catch (error) {
    return {
      success: false,
      status: 'error',
      message: `Fetch failed: ${errText(error).split('\n')[0]}`,
    };
  }

  // 2. Stash dirty changes (including untracked) so the rebase has a clean tree.
  let stashed = false;
  const status = await getRepoStatus(repoPath);
  if (status.hasChanges) {
    try {
      await execa(
        'git',
        ['stash', 'push', '-u', '-m', 'nexusflow-autostash'],
        { cwd: repoPath },
      );
      stashed = true;
    } catch (error) {
      return {
        success: false,
        status: 'error',
        message: `Failed to stash local changes: ${errText(error).split('\n')[0]}`,
      };
    }
  }

  // 3. Attempt the rebase.
  let rebaseStatus: SyncStatus;
  let rebaseMessage: string;
  try {
    const { stdout } = await execa(
      'git',
      ['rebase', `origin/${baseBranch}`],
      { cwd: repoPath },
    );

    if (stdout.includes('up to date') || stdout.includes('up-to-date')) {
      rebaseStatus = 'up-to-date';
      rebaseMessage = 'Up to date';
    } else {
      rebaseStatus = 'rebased';
      rebaseMessage = 'Rebased onto latest base';
    }
  } catch (error) {
    // Genuine merge conflict (or other rebase failure). Capture the conflicted
    // paths while the rebase is still in progress, then abort so the repo is
    // never left mid-rebase, and restore the user's stashed work.
    let conflictFiles: string[] = [];
    try {
      const { stdout } = await execa(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: repoPath },
      );
      conflictFiles = stdout.split('\n').filter(Boolean);
    } catch {
      // Best-effort capture; the conflict text still carries the details.
    }

    try {
      await execa('git', ['rebase', '--abort'], { cwd: repoPath });
    } catch {
      // Best-effort abort; ignore if it fails.
    }

    if (stashed) {
      try {
        await execa('git', ['stash', 'pop'], { cwd: repoPath });
      } catch {
        // Stash pop after an abort should normally succeed (tree is unchanged);
        // if it doesn't, the stash is preserved for manual recovery.
      }
    }

    return {
      success: false,
      status: 'conflict',
      message: conflictFiles.length > 0
        ? `Conflict during rebase (${conflictFiles.length} file${conflictFiles.length === 1 ? '' : 's'})`
        : 'Conflict during rebase',
      conflict: errText(error),
      conflictFiles,
      stashed,
    };
  }

  // 4. Restore stashed local changes, if any.
  if (stashed) {
    try {
      await execa('git', ['stash', 'pop'], { cwd: repoPath });
    } catch (error) {
      // The rebase landed, but re-applying local changes conflicts. `git stash
      // pop` leaves the stash in place on conflict, so the work is not lost.
      return {
        success: true,
        status: 'stash-conflict',
        message: 'Rebased; local changes need manual merge — stash preserved',
        conflict: errText(error),
        stashed,
      };
    }
  }

  return { success: true, status: rebaseStatus, message: rebaseMessage, stashed };
}

export interface CommitAndPushOptions {
  /** Skip the push step. */
  noPush?: boolean;
  /**
   * Commit only these paths. Other changes, including ones the user already
   * staged, stay exactly as they were: staged, unstaged or untracked.
   */
  files?: string[];
}

/**
 * Stages changes safely, commits with the given message, and pushes to origin.
 * Excludes untracked sensitive files (e.g. .env, private keys, credential files)
 * from being staged and pushed.
 *
 * @param repoPath   - Absolute path to the repo root.
 * @param message    - Commit message.
 * @param branchName - Branch to push to on origin.
 * @param options    - Optional flags to skip the push step or specify files.
 * @returns Result with commit hash, file count, and outcome message.
 */
export async function commitAndPush(
  repoPath: string,
  message: string,
  branchName: string,
  options?: CommitAndPushOptions,
): Promise<CommitResult> {
  let committed = false;
  let commitHash = '';
  let filesChanged = 0;
  try {
    const skippedSensitive: string[] = [];
    const selected = options?.files && options.files.length > 0 ? options.files : null;

    if (selected) {
      // An explicit selection still never publishes an untracked secret.
      const status = await getRepoStatus(repoPath);
      const untracked = new Set(status.files.filter((f) => f.code === '??').map((f) => f.path));
      const paths = selected.filter((file) => {
        if (untracked.has(file) && isSensitiveFile(file)) {
          skippedSensitive.push(file);
          return false;
        }
        return true;
      });
      // Stage the selected paths in chunks to avoid argv limits. `-A` records
      // deletions of selected tracked files as well.
      const BATCH_SIZE = 50;
      for (let i = 0; i < paths.length; i += BATCH_SIZE) {
        await execa('git', ['add', '-A', '--', ...paths.slice(i, i + BATCH_SIZE)], { cwd: repoPath });
      }
      let stagedSelection = '';
      for (let i = 0; i < paths.length; i += BATCH_SIZE) {
        const { stdout } = await execa('git', ['diff', '--cached', '--name-only', '--', ...paths.slice(i, i + BATCH_SIZE)], { cwd: repoPath });
        stagedSelection += stdout;
      }
      if (!stagedSelection.trim()) {
        return {
          success: true,
          committed: false,
          pushed: false,
          commitHash: '',
          filesChanged: 0,
          message: 'Nothing to commit in the selected files',
          withheldFiles: skippedSensitive,
        };
      }
      // `--only` commits exactly these paths and leaves every other staged
      // change in the index, so unrelated work the user staged is untouched.
      const { stdout: commitOutput } = await execa(
        'git',
        ['commit', '-m', message, '--only', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { cwd: repoPath, input: paths.join('\0') },
      );
      ({ commitHash, filesChanged } = parseCommitOutput(commitOutput));
      committed = true;
    } else {
      const status = await getRepoStatus(repoPath);

      // Warn if any modified tracked files match sensitive file patterns
      const modifiedTrackedSensitive = status.files
        .filter((f) => f.code !== '??' && isSensitiveFile(f.path))
        .map((f) => f.path);
      if (modifiedTrackedSensitive.length > 0) {
        console.warn(
          `[ContextSpace] Warning: tracked sensitive file(s) modified and will be committed: ${modifiedTrackedSensitive.join(', ')}`,
        );
      }

      // 1. Stage all tracked changes
      await execa('git', ['add', '-u', '.'], { cwd: repoPath });

      // 2. Safely stage untracked files in batches, filtering out any sensitive files (.env, keys, etc.)
      const untrackedFiles = status.files
        .filter((f) => f.code === '??')
        .map((f) => f.path);

      const safeUntracked: string[] = [];

      for (const file of untrackedFiles) {
        if (isSensitiveFile(file)) {
          skippedSensitive.push(file);
        } else {
          safeUntracked.push(file);
        }
      }

      if (skippedSensitive.length > 0) {
        console.warn(
          `[ContextSpace] Excluded ${skippedSensitive.length} untracked sensitive file(s) from commit: ${skippedSensitive.join(', ')}`,
        );
      }

      // Stage untracked files in non-atomic chunks of 50 to avoid command-line argv length
      // limits on Windows. Staging is followed by a diff check before committing.
      const BATCH_SIZE = 50;
      for (let i = 0; i < safeUntracked.length; i += BATCH_SIZE) {
        const batch = safeUntracked.slice(i, i + BATCH_SIZE);
        await execa('git', ['add', '--', ...batch], { cwd: repoPath });
      }
    }

    if (!selected) {
      // Check if anything is staged to commit
      const { stdout: stagedDiff } = await execa(
        'git',
        ['diff', '--cached', '--name-only'],
        { cwd: repoPath },
      );
      if (!stagedDiff.trim()) {
        return {
          success: true,
          committed: false,
          pushed: false,
          commitHash: '',
          filesChanged: 0,
          message: skippedSensitive.length > 0
            ? `Nothing staged to commit (${skippedSensitive.length} sensitive file(s) excluded)`
            : 'Nothing staged to commit (working tree clean)',
          withheldFiles: skippedSensitive,
        };
      }

      const { stdout: commitOutput } = await execa(
        'git',
        ['commit', '-m', message],
        { cwd: repoPath },
      );
      ({ commitHash, filesChanged } = parseCommitOutput(commitOutput));
      committed = true;
    }

    // Push unless opted out. A detached HEAD ('HEAD' sentinel from in-place
    // features) has no branch to push — the commit still counts as success.
    const canPush = branchName !== 'HEAD';
    const summary = `${filesChanged} file${filesChanged === 1 ? '' : 's'} (${commitHash})`;
    if (!options?.noPush && canPush) {
      try {
        await execa('git', ['push', 'origin', branchName], { cwd: repoPath });
      } catch (error) {
        // The commit exists; report it so a retry pushes instead of re-committing.
        const pushError = errText(error).split('\n')[0] ?? 'push failed';
        return {
          success: false,
          committed: true,
          pushed: false,
          pushError,
          commitHash,
          filesChanged,
          message: `Committed ${summary}, but the push failed: ${pushError}`,
          withheldFiles: skippedSensitive,
        };
      }
    }

    const action = options?.noPush
      ? 'Committed'
      : canPush
        ? 'Committed and pushed'
        : 'Committed (detached HEAD — push skipped)';
    return {
      success: true,
      committed: true,
      pushed: !options?.noPush && canPush,
      commitHash,
      filesChanged,
      message: `${action} ${summary}`,
      withheldFiles: skippedSensitive,
    };
  } catch (error) {
    return {
      success: false,
      committed,
      pushed: false,
      commitHash,
      filesChanged,
      message: errText(error).split('\n')[0] ?? String(error),
    };
  }
}

/** Parses the short hash and file count from `git commit` output. */
function parseCommitOutput(commitOutput: string): { commitHash: string; filesChanged: number } {
  // git outputs something like "[branch abc1234] message" and "3 files changed"
  const hashMatch = commitOutput.match(/\[[\w/.-]+\s+(?:\(root-commit\)\s+)?([a-f0-9]+)\]/);
  const fileMatch = commitOutput.match(/(\d+)\s+file/);
  return {
    commitHash: hashMatch ? hashMatch[1]! : '',
    filesChanged: fileMatch ? parseInt(fileMatch[1]!, 10) : 0,
  };
}

/**
 * Generates a combined diff summary (staged + unstaged) for a repository.
 *
 * Runs `git diff --stat` for working-tree changes and
 * `git diff --cached --stat` for staged changes, then merges the results.
 *
 * @param repoPath - Absolute path to the repo root.
 * @returns Combined summary string with total additions and deletions.
 */
export async function getDiffSummary(repoPath: string): Promise<DiffSummary> {
  try {
    const { stdout: unstaged } = await execa('git', ['diff', '--stat'], {
      cwd: repoPath,
    });
    const { stdout: staged } = await execa(
      'git',
      ['diff', '--cached', '--stat'],
      { cwd: repoPath },
    );

    const [unstagedAdd, unstagedDel] = parseStatCounts(unstaged);
    const [stagedAdd, stagedDel] = parseStatCounts(staged);

    const additions = unstagedAdd + stagedAdd;
    const deletions = unstagedDel + stagedDel;

    const parts: string[] = [];
    if (unstaged.trim()) parts.push(unstaged.trim());
    if (staged.trim()) parts.push(staged.trim());

    return {
      summary: parts.join('\n') || 'No changes',
      additions,
      deletions,
    };
  } catch (error) {
    return {
      summary: `Error: ${error instanceof Error ? error.message : String(error)}`,
      additions: 0,
      deletions: 0,
    };
  }
}
