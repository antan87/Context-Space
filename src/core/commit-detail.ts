/**
 * @module core/commit-detail
 * Reads the full details of a single git commit within a workspace repository.
 * Provides message, changed files with additions/deletions, remote push status,
 * and forge web URL.
 */

import * as path from 'node:path';
import { execa } from 'execa';
import { assertPathWithin } from '../resources/fs-safety.js';
import { looksBinary, MAX_VIEWABLE_FILE_BYTES, type OmittedReason } from '../services/repository-file.js';
import { extractAstSymbols, type ExtractedSymbol } from '../services/symbolService.js';
import { getWorkspaceRepoPaths } from '../utils/multi-git.js';
import { buildCommitUrl, parseRemoteUrl, type ForgeKind } from '../utils/pr.js';

/**
 * 32 MB bound for diff calls (numstat and name-status). Even massive commits
 * with tens of thousands of modified files fit well within 32 MB while still
 * providing a strict memory ceiling against runaway process allocations.
 */
export const MAX_COMMIT_DIFF_BYTES = 32 * 1024 * 1024;
export const MAX_COMMIT_FILES = 300;
export const MAX_SINGLE_FILE_DIFF_BYTES = MAX_VIEWABLE_FILE_BYTES * 4;
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

export interface CommitFileDiff {
  repo: string;
  repoPath: string;
  sha: string;
  file: string;
  oldFile?: string;
  diff: string;
  fileContent: string;
  originalContent: string;
  symbols: ExtractedSymbol[];
  contentOmitted?: OmittedReason;
  diffOmitted?: true;
}

export interface ReadCommitFileDiffOptions {
  maxCommitDiffBuffer?: number;
  maxDiffBytes?: number;
  maxFileBytes?: number;
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

interface ResolvedCommitBase {
  targetRepo: { name: string; path: string };
  repoPath: string;
  fullSha: string;
  shortSha: string;
  author: string;
  at: string;
  subject: string;
  body: string;
  parents: string[];
  baseTree: string;
}

export function normalizeCommitFilePath(repoPath: string, filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
    throw new CommitInputError('Invalid repository file path.');
  }
  for (let i = 0; i < filePath.length; i++) {
    const code = filePath.charCodeAt(i);
    if (code <= 31 || code === 127) {
      throw new CommitInputError('Invalid repository file path.');
    }
  }
  if (filePath.includes('\\') || filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) {
    throw new CommitInputError('Invalid repository file path.');
  }
  const segments = filePath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new CommitInputError('Invalid repository file path.');
    }
  }
  try {
    assertPathWithin(repoPath, path.resolve(repoPath, filePath));
  } catch {
    throw new CommitInputError('Invalid repository file path.');
  }
  return filePath;
}

async function resolveCommitBase(
  workspacePath: string,
  repoName: string,
  sha: string,
): Promise<ResolvedCommitBase> {
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

  return {
    targetRepo,
    repoPath,
    fullSha,
    shortSha,
    author,
    at,
    subject,
    body,
    parents,
    baseTree,
  };
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
  const { targetRepo, repoPath, fullSha, shortSha, author, at, subject, body, parents, baseTree } =
    await resolveCommitBase(workspacePath, repoName, sha);

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

/**
 * Reads the single-file diff and file contents for a specific changed file in a commit.
 *
 * @throws {CommitInputError} when inputs or file paths are malformed.
 * @throws {RepoNotFoundError} when repository does not exist in workspace.
 * @throws {CommitNotFoundError} when commit SHA cannot be resolved or file was not changed in commit.
 * @throws {CommitTooLargeError} when commit diff output exceeds max buffer limit.
 */
export async function readCommitFileDiff(
  workspacePath: string,
  repoName: string,
  sha: string,
  filePath: string,
  options?: ReadCommitFileDiffOptions,
): Promise<CommitFileDiff> {
  const { targetRepo, repoPath, fullSha, baseTree } = await resolveCommitBase(workspacePath, repoName, sha);
  const normalizedFile = normalizeCommitFilePath(repoPath, filePath);

  let stdoutNameStatus: string;
  try {
    const res = await execa(
      'git',
      ['-c', 'diff.renames=true', 'diff', '-z', '-M', '--no-ext-diff', '--no-color', '--name-status', baseTree, fullSha],
      { cwd: repoPath, maxBuffer: options?.maxCommitDiffBuffer ?? MAX_COMMIT_DIFF_BYTES },
    );
    stdoutNameStatus = res.stdout;
  } catch (error: any) {
    if (error?.isMaxBuffer) {
      throw new CommitTooLargeError();
    }
    throw error;
  }

  const nameStatuses = parseNameStatusZ(stdoutNameStatus);
  const matched = nameStatuses.find((ns) => ns.path === normalizedFile);
  if (!matched) {
    throw new CommitNotFoundError(`File "${normalizedFile}" was not changed in commit "${fullSha.slice(0, 7)}".`);
  }

  if (matched.oldPath !== undefined) {
    normalizeCommitFilePath(repoPath, matched.oldPath);
  }

  const maxDiffBytes = options?.maxDiffBytes ?? MAX_SINGLE_FILE_DIFF_BYTES;
  const maxFileBytes = options?.maxFileBytes ?? MAX_VIEWABLE_FILE_BYTES;
  const isRenamedOrCopied = Boolean(matched.oldPath && matched.oldPath !== normalizedFile);
  const origPath = matched.oldPath ?? normalizedFile;

  const diffArgs = isRenamedOrCopied
    ? ['diff', '--no-ext-diff', '--no-color', `${baseTree}:${origPath}`, `${fullSha}:${normalizedFile}`]
    : ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-color', baseTree, fullSha, '--', normalizedFile];

  const diffPromise = execa('git', diffArgs, {
    cwd: repoPath,
    reject: false,
    encoding: 'buffer',
    maxBuffer: maxDiffBytes,
  });

  const filePromise =
    matched.status === 'deleted'
      ? Promise.resolve(null)
      : execa('git', ['cat-file', 'blob', `${fullSha}:${normalizedFile}`], {
          cwd: repoPath,
          reject: false,
          stripFinalNewline: false,
          encoding: 'buffer',
          maxBuffer: maxFileBytes,
        });

  const origPromise =
    matched.status === 'added'
      ? Promise.resolve(null)
      : execa('git', ['cat-file', 'blob', `${baseTree}:${origPath}`], {
          cwd: repoPath,
          reject: false,
          stripFinalNewline: false,
          encoding: 'buffer',
          maxBuffer: maxFileBytes,
        });

  const [diffRes, fileRes, origRes] = await Promise.all([diffPromise, filePromise, origPromise]);

  let diff = '';
  let diffOmitted: true | undefined;
  if (diffRes.isMaxBuffer) {
    diffOmitted = true;
  } else if (diffRes.exitCode === 0 || diffRes.exitCode === 1) {
    diff = Buffer.from(diffRes.stdout).toString('utf8');
  } else {
    throw new Error(`git diff exited with code ${diffRes.exitCode}`);
  }

  function parseBlobResult(res: any): { text: string; omitted?: OmittedReason } {
    if (!res) {
      return { text: '' };
    }
    if (res.stdout && res.stdout.length > 0 && looksBinary(Buffer.from(res.stdout))) {
      return { text: '', omitted: 'binary' };
    }
    if (res.isMaxBuffer) {
      return { text: '', omitted: 'too-large' };
    }
    if (res.exitCode === 0) {
      return { text: Buffer.from(res.stdout).toString('utf8') };
    }
    return { text: '' };
  }

  const fileBlob = parseBlobResult(fileRes);
  const origBlob = parseBlobResult(origRes);

  let contentOmitted: OmittedReason | undefined;
  if (!diffOmitted && /^Binary files .* differ$/m.test(diff)) {
    contentOmitted = 'binary';
  } else if (fileBlob.omitted === 'binary' || origBlob.omitted === 'binary') {
    contentOmitted = 'binary';
  } else {
    contentOmitted = fileBlob.omitted ?? origBlob.omitted;
  }

  let fileContent = fileBlob.text;
  let originalContent = origBlob.text;

  if ((fileRes && fileRes.exitCode !== 0) || (origRes && origRes.exitCode !== 0)) {
    fileContent = '';
    originalContent = '';
  }

  if (contentOmitted) {
    fileContent = '';
    originalContent = '';
  }
  if (diffOmitted) {
    contentOmitted ??= 'too-large';
    fileContent = '';
    originalContent = '';
  }

  let symbols: ExtractedSymbol[] = [];
  if (fileContent) {
    try {
      symbols = await extractAstSymbols(normalizedFile, fileContent);
    } catch {
      symbols = [];
    }
  }

  const result: CommitFileDiff = {
    repo: targetRepo.name,
    repoPath,
    sha: fullSha,
    file: normalizedFile,
    diff: diffOmitted ? '' : diff,
    fileContent,
    originalContent,
    symbols,
  };

  if (matched.oldPath) {
    result.oldFile = matched.oldPath;
  }
  if (contentOmitted) {
    result.contentOmitted = contentOmitted;
  }
  if (diffOmitted) {
    result.diffOmitted = true;
  }

  return result;
}
