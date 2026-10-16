/**
 * @module utils/git-state
 * What a repository's HEAD, refs and configuration say, fingerprinted from file stats alone, so a poller can reuse
 * answers that only change when they do: the branch, HEAD, how far it is from its upstream, the remotes and who the
 * user is. The working tree is not part of it; that is what `git status` reads, and it still runs every time.
 *
 * Git rewrites a ref by writing a new file and renaming it over the old one, and records branches, remotes and
 * identity in the files below, so any change to them changes a stat. A repository whose git directory cannot be
 * found has no fingerprint, and its callers ask git every time, as before.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** The longest an answer is reused even when nothing visible changed, in case a filesystem keeps an mtime. */
export const GIT_STATE_MAX_AGE_MS = 5 * 60_000;
const CACHE_LIMIT = 1_000;

interface GitDirs { gitDir: string; commonDir: string }

/** The repository's git directory and, for a linked worktree, the main one that holds its refs and config. */
async function gitDirs(repoPath: string): Promise<GitDirs | null> {
  const dotGit = path.join(repoPath, '.git');
  let gitDir = dotGit;
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));
    if (!pointer) return null;
    gitDir = path.resolve(repoPath, pointer[1]!.trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EISDIR') return null;
  }
  const common = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null);
  return { gitDir, commonDir: common ? path.resolve(gitDir, common.trim()) : gitDir };
}

const statOf = (file: string) => fs.stat(file).then((s) => `${s.size}:${s.mtimeMs}`, () => '-');

/**
 * A fingerprint of HEAD, the current branch's ref, `refs` (heads and origin), packed refs, the repository and user
 * configuration, and any `extraRefs` (for example `refs/remotes/origin/feature`). Equal fingerprints mean those
 * have not changed. Null when the repository's git directory cannot be found.
 */
export async function gitStateFingerprint(repoPath: string, extraRefs: readonly string[] = []): Promise<string | null> {
  const dirs = await gitDirs(repoPath);
  if (!dirs) return null;
  const head = await fs.readFile(path.join(dirs.gitDir, 'HEAD'), 'utf8').catch(() => null);
  if (head === null) return null;
  const current = /^ref:\s*(\S+)/.exec(head)?.[1];
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const files = [
    path.join(dirs.commonDir, 'packed-refs'),
    path.join(dirs.commonDir, 'config'),
    path.join(dirs.gitDir, 'config.worktree'),
    path.join(dirs.commonDir, 'refs', 'heads'),
    path.join(dirs.commonDir, 'refs', 'remotes', 'origin'),
    path.join(dirs.commonDir, 'refs', 'remotes', 'origin', 'HEAD'),
    path.join(dirs.commonDir, 'reftable', 'tables.list'),
    path.join(os.homedir(), '.gitconfig'),
    path.join(xdgConfig, 'git', 'config'),
    ...[current, ...extraRefs].filter((ref): ref is string => Boolean(ref)).map((ref) => path.join(dirs.commonDir, ...ref.split('/'))),
  ];
  return [head.trim(), ...(await Promise.all(files.map(statOf)))].join('|');
}

const cache = new Map<string, { fingerprint: string; at: number; value: unknown }>();

/**
 * `compute()`, or its last answer for this repository and key while `fingerprint` is unchanged and the answer is
 * younger than {@link GIT_STATE_MAX_AGE_MS}. A null fingerprint always computes.
 */
export async function reuseWhileGitStateIs<T>(repoPath: string, key: string, fingerprint: string | null, compute: () => Promise<T>): Promise<T> {
  const id = `${path.resolve(repoPath)}\0${key}`;
  const hit = fingerprint ? cache.get(id) : undefined;
  if (hit && hit.fingerprint === fingerprint && Date.now() - hit.at < GIT_STATE_MAX_AGE_MS) return hit.value as T;
  const value = await compute();
  if (fingerprint) {
    cache.delete(id);
    cache.set(id, { fingerprint, at: Date.now(), value });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return value;
}

/** Forgets every reused answer (for tests). */
export function clearGitStateCache(): void {
  cache.clear();
}
