import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import {
  CommitInputError,
  CommitNotFoundError,
  CommitTooLargeError,
  RepoNotFoundError,
  readCommit,
  parseNumstatZ,
  parseNameStatusZ,
} from './commit-detail.js';

describe('commit-detail parser unit helpers', () => {
  it('parses numstat -z and name-status -z for various file states', () => {
    const rawNumstat = '10\t5\tfile1.txt\x00-\t-\timage.png\x000\t0\t\x00old.txt\x00renamed.txt\x00';
    const numItems = parseNumstatZ(rawNumstat);
    expect(numItems).toEqual([
      { path: 'file1.txt', additions: 10, deletions: 5 },
      { path: 'image.png', additions: null, deletions: null },
      { path: 'renamed.txt', oldPath: 'old.txt', additions: 0, deletions: 0 },
    ]);

    const rawNameStatus = 'M\x00file1.txt\x00A\x00image.png\x00R100\x00old.txt\x00renamed.txt\x00D\x00deleted.txt\x00';
    const nsItems = parseNameStatusZ(rawNameStatus);
    expect(nsItems).toEqual([
      { path: 'file1.txt', status: 'modified' },
      { path: 'image.png', status: 'added' },
      { path: 'renamed.txt', oldPath: 'old.txt', status: 'renamed' },
      { path: 'deleted.txt', status: 'deleted' },
    ]);
  });
});

describe('readCommit', () => {
  let root: string;
  let repoDir: string;

  const runGit = (args: string[], cwd = repoDir, env?: Record<string, string>) =>
    execa('git', args, { cwd, env });

  const commit = async (
    message: string,
    opts: { author?: string; date?: string; env?: Record<string, string> } = {},
  ) => {
    const author = opts.author ?? 'Alice Developer';
    const date = opts.date ?? '2026-05-01T10:00:00Z';
    const env = {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: 'alice@example.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: 'alice@example.com',
      GIT_COMMITTER_DATE: date,
      ...opts.env,
    };
    await runGit(['add', '-A'], repoDir, env);
    await runGit(['commit', '-m', message], repoDir, env);
    const { stdout } = await runGit(['rev-parse', 'HEAD']);
    return stdout.trim();
  };

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'commit-detail-test-')));
    repoDir = path.join(root, 'my-repo');
    await fs.mkdir(repoDir);
    await runGit(['init', '-b', 'main'], repoDir);
    await runGit(['config', 'user.name', 'Alice Developer'], repoDir);
    await runGit(['config', 'user.email', 'alice@example.com'], repoDir);

    await fs.writeFile(
      path.join(root, 'contextspace.json'),
      JSON.stringify({
        id: 'test-ws',
        name: 'Test Workspace',
        branchName: 'main',
        repos: [repoDir],
        assistants: [],
        workspacePath: root,
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads a root commit diffed against the empty tree with no parents', async () => {
    await fs.writeFile(path.join(repoDir, 'init.txt'), 'Hello world\nSecond line\n');
    const rootSha = await commit('Initial root commit');

    const result = await readCommit(root, 'my-repo', rootSha);

    expect(result.sha).toBe(rootSha);
    expect(result.shortSha).toBe(rootSha.slice(0, 7));
    expect(result.repo).toBe('my-repo');
    expect(result.author).toBe('Alice Developer');
    // Ensure author email is NOT returned
    expect((result as any).authorEmail).toBeUndefined();
    expect((result as any).email).toBeUndefined();
    expect(result.subject).toBe('Initial root commit');
    expect(result.body).toBe('');
    expect(result.parents).toEqual([]);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(0);
    expect(result.moreFiles).toBe(0);
    expect(result.pushed).toBe(false);
    expect(result.webUrl).toBeNull();
    expect(result.forge).toBeNull();
    expect(result.files).toEqual([
      {
        path: 'init.txt',
        status: 'added',
        additions: 2,
        deletions: 0,
      },
    ]);
  });

  it('reads a normal commit with subject and body, author, and ISO timestamp', async () => {
    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base\n');
    const parentSha = await commit('Initial commit');

    await fs.writeFile(path.join(repoDir, 'base.txt'), 'base modified\n');
    const commitMessage = 'feat: add exciting feature\n\nDetailed explanation of what changed.\nSecond paragraph.\n';
    const commitSha = await commit(commitMessage, {
      author: 'Bob Engineer',
      date: '2026-06-15T14:30:00Z',
    });

    const result = await readCommit(root, 'my-repo', commitSha);

    expect(result.sha).toBe(commitSha);
    expect(result.author).toBe('Bob Engineer');
    expect(result.at).toBe('2026-06-15T14:30:00.000Z');
    expect(result.subject).toBe('feat: add exciting feature');
    expect(result.body).toBe('Detailed explanation of what changed.\nSecond paragraph.');
    expect(result.parents).toEqual([parentSha]);
    expect(result.files).toEqual([
      {
        path: 'base.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it('handles added, modified, deleted, and renamed files', async () => {
    await fs.writeFile(path.join(repoDir, 'keep.txt'), 'line 1\nline 2\n');
    await fs.writeFile(path.join(repoDir, 'remove.txt'), 'will be removed\n');
    await fs.writeFile(path.join(repoDir, 'rename-me.txt'), 'content to rename\nline 2\n');
    await commit('Setup initial files');

    // Changes: modify keep.txt, delete remove.txt, rename rename-me.txt, add new.txt
    await fs.writeFile(path.join(repoDir, 'keep.txt'), 'line 1\nline 2 modified\nline 3\n');
    await fs.rm(path.join(repoDir, 'remove.txt'));
    await runGit(['mv', 'rename-me.txt', 'renamed.txt']);
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'brand new file\n');

    const sha = await commit('Various file modifications');
    const result = await readCommit(root, 'my-repo', sha);

    const keepFile = result.files.find((f) => f.path === 'keep.txt');
    expect(keepFile).toMatchObject({
      path: 'keep.txt',
      status: 'modified',
      additions: 2,
      deletions: 1,
    });

    const removeFile = result.files.find((f) => f.path === 'remove.txt');
    expect(removeFile).toMatchObject({
      path: 'remove.txt',
      status: 'deleted',
      additions: 0,
      deletions: 1,
    });

    const renameFile = result.files.find((f) => f.path === 'renamed.txt');
    expect(renameFile).toMatchObject({
      path: 'renamed.txt',
      oldPath: 'rename-me.txt',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    });

    const newFile = result.files.find((f) => f.path === 'new.txt');
    expect(newFile).toMatchObject({
      path: 'new.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
    });
  });

  it('handles binary files with null additions and deletions', async () => {
    await fs.writeFile(path.join(repoDir, 'dummy.txt'), 'text\n');
    await commit('Base commit');

    const binData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    await fs.writeFile(path.join(repoDir, 'image.png'), binData);
    const sha = await commit('Add binary file');

    const result = await readCommit(root, 'my-repo', sha);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      path: 'image.png',
      status: 'added',
      additions: null,
      deletions: null,
    });
    // Totals should not count binary files as NaN
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  it('handles file names with spaces and special characters', async () => {
    await fs.writeFile(path.join(repoDir, 'first file.txt'), 'first\n');
    await commit('Base commit');

    await fs.writeFile(path.join(repoDir, 'file with spaces and (special) chars.txt'), 'content\n');
    const sha = await commit('Add space file');

    const result = await readCommit(root, 'my-repo', sha);
    expect(result.files[0].path).toBe('file with spaces and (special) chars.txt');
    expect(result.files[0].status).toBe('added');
    expect(result.files[0].additions).toBe(1);
  });

  it('diffs a merge commit against its first parent', async () => {
    await fs.writeFile(path.join(repoDir, 'common.txt'), 'common\n');
    await commit('Initial common commit');

    // Create branch-a
    await runGit(['checkout', '-b', 'branch-a']);
    await fs.writeFile(path.join(repoDir, 'branch-a.txt'), 'from branch a\n');
    await commit('Commit on branch a');

    // Switch back to main
    await runGit(['checkout', 'main']);
    await fs.writeFile(path.join(repoDir, 'main-file.txt'), 'from main\n');
    const mainParentSha = await commit('Commit on main');

    // Merge branch-a into main
    await runGit(['merge', 'branch-a', '-m', 'Merge branch-a into main']);
    const { stdout: mergeSha } = await runGit(['rev-parse', 'HEAD']);

    const result = await readCommit(root, 'my-repo', mergeSha.trim());
    expect(result.parents).toHaveLength(2);
    expect(result.parents[0]).toBe(mainParentSha);
    // Diff against first parent should show what branch-a brought in
    const branchAFile = result.files.find((f) => f.path === 'branch-a.txt');
    expect(branchAFile).toMatchObject({
      path: 'branch-a.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
    });
  });

  it('caps files at 300 and accurately calculates moreFiles and totals', async () => {
    await fs.writeFile(path.join(repoDir, 'init.txt'), 'init\n');
    await commit('Init');

    // Create 305 files
    for (let i = 0; i < 305; i++) {
      await fs.writeFile(path.join(repoDir, `bulk-${i}.txt`), `line 1\nline 2\n`);
    }
    const sha = await commit('Add 305 files');

    const result = await readCommit(root, 'my-repo', sha);
    expect(result.files).toHaveLength(300);
    expect(result.moreFiles).toBe(5);
    expect(result.additions).toBe(305 * 2);
    expect(result.deletions).toBe(0);
  });

  it('returns pushed: false and webUrl: null when commit is not in remote', async () => {
    await fs.writeFile(path.join(repoDir, 'test.txt'), 'unpushed\n');
    const sha = await commit('Unpushed commit');

    const result = await readCommit(root, 'my-repo', sha);
    expect(result.pushed).toBe(false);
    expect(result.webUrl).toBeNull();
    expect(result.forge).toBeNull();
  });

  it('detects pushed commit, sets webUrl, and redacts credentials from remote URL', async () => {
    await fs.writeFile(path.join(repoDir, 'pushed.txt'), 'pushed content\n');
    const sha = await commit('Pushed commit');

    // Set up a remote with credentials in the URL
    await runGit(['remote', 'add', 'origin', 'https://user:secret-token@github.com/my-org/my-project.git']);
    // Create remote tracking ref pointing to this commit
    await runGit(['update-ref', 'refs/remotes/origin/main', sha]);

    const result = await readCommit(root, 'my-repo', sha);
    expect(result.pushed).toBe(true);
    expect(result.forge).toBe('github');
    expect(result.webUrl).toBe(`https://github.com/my-org/my-project/commit/${sha}`);
    // Verify no credentials leaked in webUrl or anywhere in result
    expect(result.webUrl).not.toContain('secret-token');
    expect(result.webUrl).not.toContain('user:');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('throws CommitInputError for invalid sha format', async () => {
    await expect(readCommit(root, 'my-repo', 'short')).rejects.toThrow(CommitInputError);
    await expect(readCommit(root, 'my-repo', 'not-hex-chars!')).rejects.toThrow(CommitInputError);
    await expect(readCommit(root, 'my-repo', '')).rejects.toThrow(CommitInputError);
  });

  it('throws CommitNotFoundError for unknown sha', async () => {
    const unknownSha = 'a'.repeat(40);
    await expect(readCommit(root, 'my-repo', unknownSha)).rejects.toThrow(CommitNotFoundError);
  });

  it('throws RepoNotFoundError for unknown repo', async () => {
    const fakeSha = 'a'.repeat(40);
    await expect(readCommit(root, 'non-existent-repo', fakeSha)).rejects.toThrow(RepoNotFoundError);
  });

  it('throws CommitInputError for ambiguous repo name', async () => {
    // Add two repos with the same name (e.g. from different folders)
    const otherRepoDir = path.join(root, 'other', 'my-repo');
    await fs.mkdir(otherRepoDir, { recursive: true });
    await fs.writeFile(
      path.join(root, 'contextspace.json'),
      JSON.stringify({
        id: 'test-ws',
        name: 'Test Workspace',
        branchName: 'main',
        repos: [repoDir, otherRepoDir],
        assistants: [],
        workspacePath: root,
      }),
    );

    const fakeSha = 'a'.repeat(40);
    await expect(readCommit(root, 'my-repo', fakeSha)).rejects.toThrow(CommitInputError);
  });

  it('throws CommitTooLargeError when diff exceeds maxBuffer', async () => {
    await fs.writeFile(path.join(repoDir, 'large.txt'), 'some content that produces diff output\n');
    const sha = await commit('Large diff commit');

    await expect(
      readCommit(root, 'my-repo', sha, { maxDiffBuffer: 5 }),
    ).rejects.toThrow(CommitTooLargeError);
  });

  it('resolves remote name with slashes and prefers origin if present', async () => {
    await fs.writeFile(path.join(repoDir, 'pushed-slash.txt'), 'content\n');
    const sha = await commit('Slash remote commit');

    // Add a remote with a slash in its name
    await runGit(['remote', 'add', 'corp/fork', 'https://gitlab.com/corp/fork-repo.git']);
    await runGit(['update-ref', 'refs/remotes/corp/fork/main', sha]);

    const result = await readCommit(root, 'my-repo', sha);
    expect(result.pushed).toBe(true);
    expect(result.forge).toBe('gitlab');
    expect(result.webUrl).toBe(`https://gitlab.com/corp/fork-repo/-/commit/${sha}`);

    // If origin also exists and contains the commit, origin takes precedence
    await runGit(['remote', 'add', 'origin', 'https://github.com/my-org/origin-repo.git']);
    await runGit(['update-ref', 'refs/remotes/origin/main', sha]);

    const resultOrigin = await readCommit(root, 'my-repo', sha);
    expect(resultOrigin.pushed).toBe(true);
    expect(resultOrigin.forge).toBe('github');
    expect(resultOrigin.webUrl).toBe(`https://github.com/my-org/origin-repo/commit/${sha}`);
  });

  it('accepts uppercase sha', async () => {
    await fs.writeFile(path.join(repoDir, 'upper.txt'), 'uppercase sha test\n');
    const sha = await commit('Test uppercase');

    const result = await readCommit(root, 'my-repo', sha.toUpperCase());
    expect(result.sha).toBe(sha);
  });
});
