import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { appendFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { clearRepositoryListingCache, listRepositoryChanges, listRepositoryChangesWithFingerprint, parseGitStatus } from './repository-changes.js';

const roots: string[] = [];
afterEach(async () => { clearRepositoryListingCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('repository file listing', () => {
  it('preserves destination paths, whitespace, Unicode, and rename-looking filenames', () => {
    expect(parseGitStatus(' M src/ space \"å\".ts\0R  new\nname.ts\0old.ts\0?? literal -> arrow.ts\0').map(file => [file.file, file.type])).toEqual([
      ['src/ space \"å\".ts', 'modified'], ['new\nname.ts', 'renamed'], ['literal -> arrow.ts', 'added'],
    ]);
  });
  it('lists nested untracked files, excludes ignored files, and keeps clean files in Files mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-code-tree-')); roots.push(root);
    const git = (...args: string[]) => execa('git', args, { cwd: root });
    await git('init'); await git('config', 'user.email', 'test@example.com'); await git('config', 'user.name', 'Test');
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
    await writeFile(path.join(root, 'clean.ts'), 'old\n');
    await git('add', '.'); await git('commit', '-m', 'initial');
    await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'ignored'));
    await writeFile(path.join(root, 'src', 'å space.ts'), 'new\n');
    await writeFile(path.join(root, 'ignored', 'secret'), 'ignored');
    expect((await listRepositoryChanges(root)).map(file => file.file)).toEqual(['src/å space.ts']);
    const all = await listRepositoryChanges(root, true);
    expect(all.map(file => file.file).sort()).toEqual(['.gitignore', 'clean.ts', 'src/å space.ts']);
    await git('mv', 'clean.ts', 'renamed.ts');
    expect(await listRepositoryChanges(root)).toContainEqual(expect.objectContaining({ file: 'renamed.ts', type: 'renamed' }));
  });
});

describe('repository listing reuse', () => {
  async function repo() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-listing-')); roots.push(root);
    const git = (...args: string[]) => execa('git', args, { cwd: root });
    await git('init', '-b', 'main'); await git('config', 'user.email', 'test@example.com'); await git('config', 'user.name', 'Test');
    await writeFile(path.join(root, 'a.ts'), 'one\n');
    await git('add', '.'); await git('commit', '-m', 'initial');
    return { root, git };
  }
  const counts = async (root: string, file: string) => {
    const entry = (await listRepositoryChanges(root)).find(f => f.file === file);
    return entry && [entry.additions, entry.deletions];
  };

  it('keeps the same fingerprint while nothing changes', async () => {
    const { root } = await repo();
    await appendFile(path.join(root, 'a.ts'), 'two\n');
    const first = await listRepositoryChangesWithFingerprint(root, true);
    const second = await listRepositoryChangesWithFingerprint(root, true);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.files).toEqual(first.files);
  });

  it('updates line counts when an already modified file is edited again', async () => {
    const { root } = await repo();
    await appendFile(path.join(root, 'a.ts'), 'two\n');
    expect(await counts(root, 'a.ts')).toEqual([1, 0]);
    // Status still says " M"; only the file's size and mtime tell the change apart.
    await appendFile(path.join(root, 'a.ts'), 'three\nfour\n');
    expect(await counts(root, 'a.ts')).toEqual([3, 0]);
  });

  it('sees commits and branch switches that leave the tree clean', async () => {
    const { root, git } = await repo();
    const files = async () => (await listRepositoryChanges(root, true)).map(f => `${f.file}:${f.type}`).sort();
    expect(await files()).toEqual(['a.ts:unchanged']);

    await git('checkout', '-q', '-b', 'feature');
    await writeFile(path.join(root, 'b.ts'), 'b\n');
    await git('add', '.'); await git('commit', '-q', '-m', 'add b');
    expect(await files()).toEqual(['a.ts:unchanged', 'b.ts:unchanged']);

    // Clean before and clean after: the status output is identical, the index is not.
    await git('checkout', '-q', 'main');
    expect(await files()).toEqual(['a.ts:unchanged']);
  });

  it('finds the index of a linked worktree through its .git file', async () => {
    const { root, git } = await repo();
    const worktree = path.join(root, '..', `${path.basename(root)}-wt`); roots.push(worktree);
    await git('worktree', 'add', '-q', '-b', 'wt', worktree);
    await appendFile(path.join(worktree, 'a.ts'), 'two\n');
    const first = await listRepositoryChangesWithFingerprint(worktree);
    await appendFile(path.join(worktree, 'a.ts'), 'three\n');
    const second = await listRepositoryChangesWithFingerprint(worktree);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.files.find(f => f.file === 'a.ts')?.additions).toBe(2);
  });
});

describe('line counts of untracked files', () => {
  it('counts the lines of a small text file git does not track yet, and leaves a binary one at zero', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'ctx-untracked-'));
    roots.push(repo);
    const git = (...args: string[]) => execa('git', args, { cwd: repo });
    await git('init', '-q');
    await writeFile(path.join(repo, 'tracked.txt'), 'one\n');
    await git('add', '.');
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    await writeFile(path.join(repo, 'new.txt'), 'a\nb\nc');
    await writeFile(path.join(repo, 'blob.bin'), Buffer.from([1, 0, 2, 10, 3]));
    const files = await listRepositoryChanges(repo);
    expect(files.find((file) => file.file === 'new.txt')?.additions).toBe(3);
    expect(files.find((file) => file.file === 'blob.bin')?.additions).toBe(0);
  });
});

describe('safe legacy listing filesystem access', () => {
  const limit = 256 * 1024;
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-listing-safe-')); roots.push(root);
    const repo = path.join(root, 'repo'); await mkdir(repo);
    const git = (...args: string[]) => execa('git', args, { cwd: repo });
    await git('init', '-q');
    expect((await git('rev-parse', '--git-dir')).stdout).toBe('.git');
    await mkdir(path.join(repo, 'nested'));
    await writeFile(path.join(repo, 'nested', 'tracked.txt'), 'old\n');
    await git('add', '.');
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return { root, repo, git };
  }

  it.skipIf(process.platform === 'win32')('never follows an unrelated untracked symlink for metadata or contents', async () => {
    const { root, repo } = await fixture();
    const outside = path.join(root, 'sentinel.txt'); await writeFile(outside, 'secret\nsecret\n');
    const linked = path.join(repo, 'unrelated.txt'); await fs.symlink(outside, linked);
    const row = (await listRepositoryChanges(repo)).find(f => f.file === 'unrelated.txt');
    expect(row).toMatchObject({ rawStatus: '??', additions: 0 });
    expect(row?.size).toBeUndefined(); expect(row?.mtimeMs).toBeUndefined();
  });

  it('rejects metadata through a linked parent of a deleted tracked file', async () => {
    const { root, repo } = await fixture();
    const outside = path.join(root, 'external'); await mkdir(outside);
    await writeFile(path.join(outside, 'tracked.txt'), 'external sentinel\n');
    await rm(path.join(repo, 'nested'), { recursive: true });
    await fs.symlink(outside, path.join(repo, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    const row = (await listRepositoryChanges(repo)).find(f => f.file === 'nested/tracked.txt');
    expect(row).toMatchObject({ type: 'deleted', deletions: 1 });
    expect(row?.size).toBeUndefined();
  });

  it('keeps full-buffer NUL detection and the exact size boundary', async () => {
    const { repo } = await fixture();
    await writeFile(path.join(repo, 'boundary.txt'), Buffer.alloc(limit, 10));
    await writeFile(path.join(repo, 'large.txt'), Buffer.alloc(limit + 1, 10));
    const binary = Buffer.alloc(limit, 10); binary[limit - 1] = 0;
    await writeFile(path.join(repo, 'late-nul.bin'), binary);
    await writeFile(path.join(repo, 'empty.txt'), '');
    const rows = await listRepositoryChanges(repo);
    expect(rows.find(f => f.file === 'boundary.txt')?.additions).toBe(limit);
    for (const name of ['large.txt', 'late-nul.bin', 'empty.txt']) expect(rows.find(f => f.file === name)?.additions).toBe(0);
  });

  it('does not let callers mutate cached rows', async () => {
    const { repo } = await fixture(); await writeFile(path.join(repo, 'new.txt'), 'one\ntwo');
    const first = await listRepositoryChanges(repo); first[0]!.additions = 999;
    expect((await listRepositoryChanges(repo))[0]?.additions).toBe(2);
  });
});
