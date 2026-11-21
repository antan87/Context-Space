/**
 * A cheap way to notice that a repository's commits changed, without running `git`: a `stat` signature of the files
 * git rewrites when a commit lands, a branch moves or HEAD switches. Used by the live feed's poll, so it never starts
 * a process and never reads more than HEAD (a few bytes, and only when HEAD itself changed).
 *
 * For a plain repository the git directory is `<repo>/.git`. For a linked worktree `<worktree>/.git` is a file that
 * names the worktree's own git directory (`<common>/worktrees/<name>`), which holds that worktree's HEAD and its
 * reflog; the branch refs and `packed-refs` live in the common directory, named by the `commondir` file.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface RepoGit {
  gitDir: string;
  commonDir: string;
  /** What HEAD looked like when `refFile` was worked out. */
  headSignature: string;
  /** The file of the branch HEAD points at, or null for a detached HEAD or an unknown layout. */
  refFile: string | null;
}

const stamp = (file: string) => fs.stat(file).then((s) => `${s.size}:${s.mtimeMs}`, () => 'none');

async function resolveGitDirs(repoPath: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const dotGit = path.join(repoPath, '.git');
  let stat;
  try { stat = await fs.stat(dotGit); } catch { return null; }
  if (stat.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  let pointer: string;
  try { pointer = await fs.readFile(dotGit, 'utf8'); } catch { return null; }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) return null;
  const gitDir = path.resolve(repoPath, match[1]!);
  let commonDir = gitDir;
  try {
    const named = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    if (named) commonDir = path.resolve(gitDir, named);
  } catch { /* An ordinary git directory has no commondir file. */ }
  return { gitDir, commonDir };
}

export interface CommitWatcher {
  /** One string for all the repositories: it differs when a commit landed or a branch moved in any of them. */
  signature(repoPaths: readonly string[]): Promise<string>;
}

export function createCommitWatcher(): CommitWatcher {
  const known = new Map<string, RepoGit | null>();

  async function one(repoPath: string): Promise<string> {
    let repo = known.get(repoPath);
    if (repo === undefined || repo === null) {
      const dirs = await resolveGitDirs(repoPath);
      repo = dirs ? { ...dirs, headSignature: '', refFile: null } : null;
      // A repository that is not there yet is looked for again at the next poll.
      if (repo) known.set(repoPath, repo); else known.delete(repoPath);
    }
    if (!repo) return 'none';
    const headFile = path.join(repo.gitDir, 'HEAD');
    const head = await stamp(headFile);
    if (head !== repo.headSignature) {
      repo.headSignature = head;
      repo.refFile = null;
      try {
        const ref = /^ref:\s*(\S+)/.exec(await fs.readFile(headFile, 'utf8'))?.[1];
        if (ref) repo.refFile = path.join(repo.commonDir, ref);
      } catch { /* HEAD is gone: the signature says so. */ }
    }
    const parts = await Promise.all([
      repo.refFile ? stamp(repo.refFile) : 'detached',
      stamp(path.join(repo.gitDir, 'logs', 'HEAD')),
      stamp(path.join(repo.commonDir, 'packed-refs')),
      // A branch made or removed changes this folder, though HEAD does not move.
      stamp(path.join(repo.commonDir, 'refs', 'heads')),
    ]);
    return [head, ...parts].join(',');
  }

  return {
    async signature(repoPaths) {
      const unique = [...new Set(repoPaths)];
      for (const gone of [...known.keys()]) if (!unique.includes(gone)) known.delete(gone);
      return (await Promise.all(unique.map(one))).join('|');
    },
  };
}
