/**
 * @module core/commit-detail
 * Reads the full details of a single git commit within a workspace repository.
 * Provides message, changed files with additions/deletions, remote push status,
 * and forge web URL.
 */

import { execa } from 'execa';
import { getWorkspaceRepoPaths } from '../utils/multi-git.js';
import { buildCommitUrl, parseRemoteUrl, type ForgeKind } from '../utils/pr.js';

/**
 * 32 MB bound for diff calls (numstat and name-status). Even massive commits
 * with tens of thousands of modified files fit well within 32 MB while still
 * providing a strict memory ceiling against runaway process allocations.
 */
export const MAX_COMMIT_DIFF_BYTES = 32 * 1024 * 1024;
export const MAX_COMMIT_FILES = 300;
// A short hex equal to a branch/tag name resolves to that ref first,
// which is acceptable because the full SHA is returned.
const SHA_REGEX = /^[0-9a-f]{7,64}$/;

export class CommitInputError extends Error {
  constructor(message = 'Invalid commit request.') {
    super(message);
    this.name = 'CommitInputError';
  }
}

export class RepoNotFoundError extends Error {
  constructor(message = 'Repository not found.') {
    super(message);
    this.name = 'RepoNotFoundError';
  }
}

export class CommitNotFoundError extends Error {
  constructor(message = 'Commit not found.') {
    super(message);
    this.name = 'CommitNotFoundError';
  }
}

export class CommitTooLargeError extends Error {
  constructor(message = 'This commit is too large to list.') {
    super(message);
    this.name = 'CommitTooLargeError';
  }
}

export type CommitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';

export interface CommitDetailFile {
  path: string;
  oldPath?: string;
  status: CommitFileStatus;
  additions: number | null;
  deletions: number | null;
}

export interface CommitDetail {
  repo: string;
  sha: string;
  shortSha: string;
  author: string;
  at: string;
  subject: string;
  body: string;
  parents: string[];
  files: CommitDetailFile[];
  moreFiles: number;
  additions: number;
  deletions: number;
  pushed: boolean;
  forge: ForgeKind | null;
  webUrl: string | null;
}

interface NumstatItem {
  path: string;
  oldPath?: string;
  additions: number | null;
  deletions: number | null;
}

interface NameStatusItem {
  path: string;
  oldPath?: string;
  status: CommitFileStatus;
}

export function parseNumstatZ(stdout: string): NumstatItem[] {
  if (!stdout) return [];
  const parts = stdout.split('\0');
  const items: NumstatItem[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const tab1 = part.indexOf('\t');
    if (tab1 === -1) continue;
    const tab2 = part.indexOf('\t', tab1 + 1);
    if (tab2 === -1) continue;

    const addStr = part.slice(0, tab1);
    const delStr = part.slice(tab1 + 1, tab2);
    const rest = part.slice(tab2 + 1);

    const addNum = parseInt(addStr, 10);
    const delNum = parseInt(delStr, 10);
    const additions = addStr === '-' ? null : Number.isNaN(addNum) ? 0 : addNum;
    const deletions = delStr === '-' ? null : Number.isNaN(delNum) ? 0 : delNum;

    if (rest === '') {
      // In numstat -z, a rename or copy has an empty path here followed by oldPath\0newPath\0
      const oldPath = parts[++i];
      const newPath = parts[++i];
      if (newPath !== undefined) {
        items.push({ path: newPath, oldPath, additions, deletions });
      }
    } else {
      items.push({ path: rest, additions, deletions });
    }
  }
  return items;
}

export function parseNameStatusZ(stdout: string): NameStatusItem[] {
  if (!stdout) return [];
  const parts = stdout.split('\0');
  const items: NameStatusItem[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const code = part.trim();
    const firstChar = code[0];
    let status: CommitFileStatus = 'other';
    if (firstChar === 'A') status = 'added';
    else if (firstChar === 'M') status = 'modified';
    else if (firstChar === 'D') status = 'deleted';
    else if (firstChar === 'R') status = 'renamed';
    else if (firstChar === 'C') status = 'copied';

    if (firstChar === 'R' || firstChar === 'C') {
      const oldPath = parts[++i];
      const newPath = parts[++i];
      if (newPath !== undefined) {
        items.push({ path: newPath, oldPath, status });
      }
    } else {
      const filePath = parts[++i];
      if (filePath !== undefined) {
        items.push({ path: filePath, status });
      }
    }
  }
  return items;
}

export interface ReadCommitOptions {
  /** Optional override for execa maxBuffer in diff calls (for testing/safety). */
  maxDiffBuffer?: number;
}

/**
 * Reads the details of a single commit from a workspace repository.
 *
 * Repository name matching is case-insensitive if an exact match is not found
 * (unlike whats-new which matches exactly). Ambiguous names throw an error.
 *
 * @throws {CommitInputError} when inputs are malformed or repo name is ambiguous.
 * @throws {RepoNotFoundError} when repository does not exist in workspace.
 * @throws {CommitNotFoundError} when commit SHA cannot be resolved.
 * @throws {CommitTooLargeError} when commit diff output exceeds max buffer limit.
 */
export async function readCommit(
  workspacePath: string,
  repoName: string,
  sha: string,
  options?: ReadCommitOptions,
): Promise<CommitDetail> {
  const trimmedRepo = (repoName ?? '').trim();
  if (!trimmedRepo) {
    throw new CommitInputError('Repository name is required.');
  }

  const rawSha = (sha ?? '').trim().toLowerCase();
  if (!SHA_REGEX.test(rawSha)) {
    throw new CommitInputError(`Invalid commit SHA "${sha}". SHA must be 7 to 64 hexadecimal characters.`);
  }

  const repos = await getWorkspaceRepoPaths(workspacePath);
  const exactMatches = repos.filter((r) => r.name === trimmedRepo);
  let targetRepo: { name: string; path: string } | undefined;

  if (exactMatches.length === 1) {
    targetRepo = exactMatches[0];
  } else if (exactMatches.length > 1) {
    throw new CommitInputError(`Repository name "${repoName}" is ambiguous.`);
  } else {
    const ciMatches = repos.filter((r) => r.name.toLowerCase() === trimmedRepo.toLowerCase());
    if (ciMatches.length === 1) {
      targetRepo = ciMatches[0];
    } else if (ciMatches.length > 1) {
      throw new CommitInputError(`Repository name "${repoName}" is ambiguous.`);
    } else {
      throw new RepoNotFoundError(`Repository "${repoName}" not found in workspace.`);
    }
  }

  const repoPath = targetRepo.path;

  // Resolve SHA to full SHA.
  // Note: a short hex equal to a branch/tag name resolves to that ref first,
  // which is acceptable because the full SHA is returned.
  let fullSha = '';
  try {
    const { stdout } = await execa('git', ['rev-parse', '--verify', '-q', `${rawSha}^{commit}`], {
      cwd: repoPath,
      maxBuffer: MAX_COMMIT_DIFF_BYTES,
    });
    fullSha = stdout.trim();
    if (!fullSha) {
      throw new CommitNotFoundError(`Commit "${rawSha}" not found.`);
    }
  } catch (error) {
    if (error instanceof CommitInputError || error instanceof RepoNotFoundError || error instanceof CommitNotFoundError) {
      throw error;
    }
    throw new CommitNotFoundError(`Commit "${rawSha}" not found.`);
  }

  // Read commit metadata (%H, %h, %an, %aI, %s, %b, %P)
  const { stdout: commitInfo } = await execa(
    'git',
    ['log', '-1', '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%b%x00%P', fullSha],
    { cwd: repoPath, maxBuffer: MAX_COMMIT_DIFF_BYTES },
  );

  const parts = commitInfo.split('\0');
  if (parts.length < 7) {
    throw new CommitNotFoundError(`Failed to read commit details for "${rawSha}".`);
  }

  const [, shortSha, author, atRaw, subject, bodyRaw, parentsRaw] = parts;
  const at = Number.isNaN(Date.parse(atRaw)) ? atRaw : new Date(atRaw).toISOString();
  const body = bodyRaw.trim();
  const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];

  // Diff against first parent, or computed empty tree for root commit
  let baseTree: string;
  if (parents.length > 0) {
    baseTree = parents[0];
  } else {
    const { stdout: emptyTreeSha } = await execa('git', ['hash-object', '-t', 'tree', '--stdin'], {
      cwd: repoPath,
      input: '',
    });
    baseTree = emptyTreeSha.trim();
  }

  const diffMaxBuffer = options?.maxDiffBuffer ?? MAX_COMMIT_DIFF_BYTES;
  let stdoutNumstat: string;
  let stdoutNameStatus: string;
  try {
    const [{ stdout: numstatOut }, { stdout: nameStatusOut }] = await Promise.all([
      execa(
        'git',
        ['-c', 'diff.renames=true', 'diff', '-z', '-M', '--no-ext-diff', '--no-color', '--numstat', baseTree, fullSha],
        { cwd: repoPath, maxBuffer: diffMaxBuffer },
      ),
      execa(
        'git',
        ['-c', 'diff.renames=true', 'diff', '-z', '-M', '--no-ext-diff', '--no-color', '--name-status', baseTree, fullSha],
        { cwd: repoPath, maxBuffer: diffMaxBuffer },
      ),
    ]);
    stdoutNumstat = numstatOut;
    stdoutNameStatus = nameStatusOut;
  } catch (error: any) {
    if (error?.isMaxBuffer) {
      throw new CommitTooLargeError();
    }
    throw error;
  }

  const numstats = parseNumstatZ(stdoutNumstat);
  const nameStatuses = parseNameStatusZ(stdoutNameStatus);

  const numstatMap = new Map<string, NumstatItem>();
  for (const item of numstats) {
    const key = `${item.oldPath ?? ''} -> ${item.path}`;
    numstatMap.set(key, item);
    if (!numstatMap.has(item.path)) {
      numstatMap.set(item.path, item);
    }
  }

  const allFiles: CommitDetailFile[] = [];
  for (let i = 0; i < nameStatuses.length; i++) {
    const ns = nameStatuses[i];
    let numItem = numstats[i]?.path === ns.path ? numstats[i] : undefined;
    if (!numItem) {
      const key = `${ns.oldPath ?? ''} -> ${ns.path}`;
      numItem = numstatMap.get(key) ?? numstatMap.get(ns.path);
    }

    const file: CommitDetailFile = {
      path: ns.path,
      status: ns.status,
      additions: numItem?.additions ?? null,
      deletions: numItem?.deletions ?? null,
    };
    if (ns.oldPath !== undefined) {
      file.oldPath = ns.oldPath;
    }
    allFiles.push(file);
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of allFiles) {
    if (file.additions !== null) totalAdditions += file.additions;
    if (file.deletions !== null) totalDeletions += file.deletions;
  }

  const files = allFiles.slice(0, MAX_COMMIT_FILES);
  const moreFiles = Math.max(0, allFiles.length - MAX_COMMIT_FILES);

  // Check remote tracking branches (pushed status)
  let pushed = false;
  let forge: ForgeKind | null = null;
  let webUrl: string | null = null;

  try {
    const { stdout: refOutput } = await execa(
      'git',
      ['for-each-ref', `--contains=${fullSha}`, '--format=%(refname)', 'refs/remotes/'],
      { cwd: repoPath, maxBuffer: MAX_COMMIT_DIFF_BYTES },
    );

    const refs = refOutput.split('\n').map((l) => l.trim()).filter(Boolean);
    if (refs.length > 0) {
      pushed = true;

      const { stdout: remotesOutput } = await execa('git', ['remote'], {
        cwd: repoPath,
        maxBuffer: MAX_COMMIT_DIFF_BYTES,
      });

      const remotes = remotesOutput
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

      const matchingRemotes = new Set<string>();
      for (const ref of refs) {
        const rel = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
        const matched = remotes.find((r) => rel.startsWith(`${r}/`));
        if (matched) {
          matchingRemotes.add(matched);
        }
      }

      if (matchingRemotes.size === 0) {
        for (const ref of refs) {
          const rel = ref.replace(/^refs\/remotes\//, '');
          const fallback = rel.split('/')[0];
          if (fallback) matchingRemotes.add(fallback);
        }
      }

      const chosenRemote = matchingRemotes.has('origin') ? 'origin' : Array.from(matchingRemotes)[0];
      if (chosenRemote) {
        try {
          const { stdout: remoteUrl } = await execa(
            'git',
            ['remote', 'get-url', chosenRemote],
            { cwd: repoPath, maxBuffer: MAX_COMMIT_DIFF_BYTES },
          );
          const parsed = parseRemoteUrl(remoteUrl.trim());
          if (parsed) {
            forge = parsed.kind;
            webUrl = buildCommitUrl(parsed, fullSha);
          }
        } catch {
          // Ignore remote lookup failure
        }
      }
    }
  } catch {
    // Ignore for-each-ref failure
  }

  return {
    repo: targetRepo.name,
    sha: fullSha,
    shortSha,
    author,
    at,
    subject,
    body,
    parents,
    files,
    moreFiles,
    additions: totalAdditions,
    deletions: totalDeletions,
    pushed,
    forge,
    webUrl,
  };
}
