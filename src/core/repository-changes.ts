import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { inspectListedRepositoryFiles, UNTRACKED_COUNT_LIMIT } from './listed-file-inspection.js';
import * as path from 'node:path';
import { execa } from 'execa';

export interface ChangedFile {
  file: string;
  type: string;
  rawStatus: string;
  additions: number;
  deletions: number;
  /** Size and mtime of a changed file on disk, so a viewer can tell when its diff changed. */
  size?: number;
  mtimeMs?: number;
}

export function parseGitStatus(output: string): ChangedFile[] {
  const records = output.split('\0');
  const files: ChangedFile[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const rawStatus = record.slice(0, 2);
    // With -z, renamed/copied paths are destination NUL source NUL.
    const file = record.slice(3);
    if (/[RC]/.test(rawStatus)) index++;
    const type = rawStatus === '??' || rawStatus.includes('A') ? 'added'
      : rawStatus.includes('D') ? 'deleted' : rawStatus.includes('R') ? 'renamed' : 'modified';
    files.push({ file, rawStatus: rawStatus.trim(), type, additions: 0, deletions: 0 });
  }
  return files;
}

export interface RepositoryListing {
  files: ChangedFile[];
  /** Changes whenever anything the listing depends on changes. */
  fingerprint: string;
}

// A code view refreshes every few seconds, and listing a repository costs a
// status, a numstat and (for the full tree) an ls-files. Only the status runs
// every time; the rest is reused while nothing it depends on has changed: the
// status output, the index (rewritten by commit, checkout, pull and add) and
// the size and mtime of every changed file.
const LISTING_CACHE_LIMIT = 64;
const listingCache = new Map<string, RepositoryListing>();

export function clearRepositoryListingCache(): void {
  listingCache.clear();
}

export async function listRepositoryChanges(repoPath: string, includeAll = false): Promise<ChangedFile[]> {
  return (await listRepositoryChangesWithFingerprint(repoPath, includeAll)).files;
}

export async function listRepositoryChangesWithFingerprint(repoPath: string, includeAll = false): Promise<RepositoryListing> {
  // --no-optional-locks: a poller must not rewrite the index (that would change
  // the signature below) or take index.lock while the user runs git.
  const { stdout } = await execa('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoPath, stripFinalNewline: false });
  const files = parseGitStatus(stdout);
  const byPath = new Map(files.map(file => [file.file, file]));
  for (const inspected of await inspectListedRepositoryFiles(repoPath, files.map(file => file.file), 'metadata')) {
    const file = byPath.get(inspected.file);
    if (file) { file.size = inspected.size; file.mtimeMs = inspected.mtimeMs; }
  }
  const index = await indexSignature(repoPath);
  const fingerprint = createHash('sha1')
    .update(JSON.stringify([includeAll, index, stdout, files.map((f) => [f.size, f.mtimeMs])]))
    .digest('hex');
  const key = `${path.resolve(repoPath)}\0${includeAll}`;
  const cached = listingCache.get(key);
  // Without an index signature (not a repository root) there is nothing safe to compare.
  if (index && cached?.fingerprint === fingerprint) {
    return { fingerprint, files: cached.files.map((file) => ({ ...file })) };
  }

  // Disable rename folding only for line counts; status retains rename identity.
  try {
    const stats = await execa('git', ['diff', 'HEAD', '--numstat', '-z', '--no-renames'], { cwd: repoPath, reject: false, stripFinalNewline: false });
    for (const record of stats.stdout.split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
      if (!match) continue;
      const file = byPath.get(match[3]!);
      if (file) { file.additions = Number(match[1]) || 0; file.deletions = Number(match[2]) || 0; }
    }
  } catch {
    // A repository without HEAD still has useful status and untracked files.
  }
  // git has no numstat for a file it does not track yet: its lines are its additions. Small text files only, so a listing stays cheap.
  const countable = files.filter(file => file.rawStatus === '??' && file.additions === 0 && (file.size ?? 0) > 0 && (file.size ?? 0) <= UNTRACKED_COUNT_LIMIT);
  for (const inspected of await inspectListedRepositoryFiles(repoPath, countable.map(file => file.file), 'counts')) {
    const file = byPath.get(inspected.file);
    if (file && inspected.additions !== undefined) file.additions = inspected.additions;
  }
  if (includeAll) {
    const listed = await execa('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoPath, stripFinalNewline: false });
    for (const file of listed.stdout.split('\0').filter(Boolean)) {
      if (!byPath.has(file)) byPath.set(file, { file, type: 'unchanged', rawStatus: '', additions: 0, deletions: 0 });
    }
  }
  const listing = { fingerprint, files: [...byPath.values()] };
  if (index) {
    listingCache.delete(key);
    listingCache.set(key, { fingerprint, files: listing.files.map((file) => ({ ...file })) });
    if (listingCache.size > LISTING_CACHE_LIMIT) listingCache.delete(listingCache.keys().next().value!);
  }
  return listing;
}

/** Size and mtime of the repository's index, found through `.git` (a directory, or a file for worktrees). */
async function indexSignature(repoPath: string): Promise<string | null> {
  try {
    const dotGit = path.join(repoPath, '.git');
    let gitDir = dotGit;
    try {
      // A linked worktree's .git is a file naming its git directory.
      const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));
      if (!pointer) return null;
      gitDir = path.resolve(repoPath, pointer[1]!.trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
    }
    const index = await fs.stat(path.join(gitDir, 'index'));
    return `${index.size}:${index.mtimeMs}`;
  } catch {
    return null;
  }
}
