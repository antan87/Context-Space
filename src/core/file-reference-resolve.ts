import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ReferenceRepo {
  repoName: string;
  /** Where the repository is checked out for this workspace (worktree or in-place source). */
  repoPath: string;
  /**
   * The checkout this one was made from, when it is a different folder. An assistant that read the repository there
   * prints paths under it, and each names the same file in this workspace's copy.
   */
  sourcePath?: string;
}

export interface ResolvedRepoFile {
  repoName: string;
  repoPath: string;
  /** Repository-relative path with forward slashes, as the change listing names it. */
  file: string;
}

export type FileReferenceResolution =
  | ({ status: 'found' } & ResolvedRepoFile)
  | { status: 'ambiguous'; candidates: ResolvedRepoFile[] }
  | { status: 'not-found'; reason: 'missing' | 'directory' | 'outside-repositories'; absolutePath?: string };

export interface ResolveFileReferenceOptions {
  repos: readonly ReferenceRepo[];
  workspacePath: string;
  /** The working directory of the session that printed the path, when known. */
  cwd?: string;
  /** Every listed file of a repository, for the last-resort suffix match. */
  listFiles?: (repo: ReferenceRepo) => Promise<readonly string[]>;
  homeDir?: string;
}

/** More than this many suffix matches is not a useful list to choose from. */
const MAX_CANDIDATES = 20;

const isWindows = process.platform === 'win32';
const comparable = (value: string) => (isWindows ? value.toLowerCase() : value);

function within(root: string, target: string): boolean {
  const relative = path.relative(comparable(root), comparable(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canonical(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

interface CanonicalRepo extends ReferenceRepo { root: string; realRoot: string; sourceRoot?: string; source: ReferenceRepo }

/**
 * Finds the repository file a path printed by a CLI (or written in a document) refers to.
 *
 * The CLI prints paths relative to the directory it runs in, which is often a repository or one
 * of its subfolders, so that directory is tried first. Then the path is read as repository
 * relative in every repository, then as `repoName/…`, then as relative to the workspace root. A
 * tier that finds one file wins; a tier that finds several reports them all, so the caller can
 * ask instead of guessing. Only when no tier matches does a unique suffix of a listed file count,
 * which covers paths printed from a folder the session has since left.
 *
 * Only files inside the workspace's repositories are ever returned, also through symlinks, so the
 * answer never names or confirms a file elsewhere on disk.
 */
export async function resolveFileReference(rawPath: string, options: ResolveFileReferenceOptions): Promise<FileReferenceResolution> {
  const home = options.homeDir ?? os.homedir();
  let target = rawPath.trim().replace(/\\/g, '/');
  if (target === '~' || target.startsWith('~/')) target = path.join(home, target.slice(1));
  if (!target) return { status: 'not-found', reason: 'missing' };

  const repos: CanonicalRepo[] = await Promise.all(options.repos.map(async (repo) => ({
    ...repo,
    source: repo,
    root: path.resolve(repo.repoPath),
    realRoot: await canonical(repo.repoPath),
    sourceRoot: repo.sourcePath && path.resolve(repo.sourcePath) !== path.resolve(repo.repoPath) ? path.resolve(repo.sourcePath) : undefined,
  })));

  const tiers: string[][] = [];
  if (path.isAbsolute(target) || /^[a-z]:\//i.test(target)) {
    const absolute = path.resolve(target);
    tiers.push([absolute]);
    // A path under the checkout a repository was copied from is the same file in the copy. It is tried second, so a
    // file that is really in the workspace is never shadowed, and it is only for a file the copy has.
    const moved = repos.flatMap((repo) => repo.sourceRoot && within(repo.sourceRoot, absolute) && !within(repo.root, absolute)
      ? [path.join(repo.root, path.relative(repo.sourceRoot, absolute))]
      : []);
    if (moved.length) tiers.push(moved);
  } else {
    if (options.cwd) tiers.push([path.resolve(options.cwd, target)]);
    tiers.push(repos.map((repo) => path.resolve(repo.root, target)));
    const [first, ...rest] = target.replace(/^\.\//, '').split('/');
    const qualified = repos.filter((repo) => comparable(repo.repoName) === comparable(first ?? '') && rest.length > 0);
    if (qualified.length) tiers.push(qualified.map((repo) => path.resolve(repo.root, rest.join('/'))));
    tiers.push([path.resolve(options.workspacePath, target)]);
  }

  let sawDirectory = false;
  let outside: string | undefined;
  for (const tier of tiers) {
    const found = new Map<string, ResolvedRepoFile>();
    for (const candidate of tier) {
      const repo = repos.find((entry) => within(entry.root, candidate));
      if (!repo) {
        outside ??= candidate;
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(candidate);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        sawDirectory = true;
        continue;
      }
      if (!stat.isFile()) continue;
      // A link inside the repository that leads out of it is not a repository file.
      if (!within(repo.realRoot, await canonical(candidate))) continue;
      const file = path.relative(repo.root, candidate).split(path.sep).join('/');
      found.set(`${repo.repoName}\0${file}`, { repoName: repo.repoName, repoPath: repo.repoPath, file });
    }
    if (found.size === 1) return { status: 'found', ...[...found.values()][0]! };
    if (found.size > 1) return { status: 'ambiguous', candidates: [...found.values()] };
  }

  const relative = !(path.isAbsolute(target) || /^[a-z]:\//i.test(target));
  const segments = target.split('/');
  if (relative && options.listFiles && !segments.includes('..')) {
    const wanted = comparable(segments.filter((segment) => segment && segment !== '.').join('/'));
    const candidates: ResolvedRepoFile[] = [];
    for (const repo of repos) {
      let files: readonly string[];
      try {
        files = await options.listFiles(repo.source);
      } catch {
        continue;
      }
      for (const file of files) {
        const name = comparable(file);
        if (name === wanted || name.endsWith(`/${wanted}`)) candidates.push({ repoName: repo.repoName, repoPath: repo.repoPath, file });
        if (candidates.length > MAX_CANDIDATES) break;
      }
    }
    if (candidates.length === 1) return { status: 'found', ...candidates[0]! };
    if (candidates.length > 1) return { status: 'ambiguous', candidates: candidates.slice(0, MAX_CANDIDATES) };
  }

  if (sawDirectory) return { status: 'not-found', reason: 'directory' };
  if (outside && tiers.length === 1) return { status: 'not-found', reason: 'outside-repositories', absolutePath: outside };
  return { status: 'not-found', reason: 'missing' };
}
