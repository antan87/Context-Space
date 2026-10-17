import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { PRIMARY_MANIFEST_FILE } from '../core/constants.js';
import {
  rebaseRepo,
  getRepoBranch,
  getAheadBehind,
  getRemoteUrl,
  pushRepo,
  commitAndPush,
  parsePorcelainZ,
  isSensitiveFile,
  getWorkspaceRepoPaths,
} from './multi-git.js';

vi.mock('execa');

/** Builds an execa-style error carrying stderr (as execa does on non-zero exit). */
function gitError(stderr: string): Error {
  return Object.assign(new Error('git failed'), { stderr });
}

interface GitMockOpts {
  fetchError?: Error;
  statusStdout?: string;      // output of `git status --porcelain` ('' = clean)
  stashPushError?: Error;
  stashPopError?: Error;
  rebaseError?: Error;
  rebaseStdout?: string;
}

/** Resolves a single mocked `git` call by subcommand. */
async function routeGit(a: string[], opts: GitMockOpts): Promise<{ stdout: string }> {
  const sub = a[0];
  if (sub === 'fetch') {
    if (opts.fetchError) throw opts.fetchError;
    return { stdout: '' };
  }
  if (sub === 'status') {
    return { stdout: opts.statusStdout ?? '' };
  }
  if (sub === 'stash' && a[1] === 'push') {
    if (opts.stashPushError) throw opts.stashPushError;
    return { stdout: '' };
  }
  if (sub === 'stash' && a[1] === 'pop') {
    if (opts.stashPopError) throw opts.stashPopError;
    return { stdout: '' };
  }
  if (sub === 'rebase' && a[1] === '--abort') {
    return { stdout: '' };
  }
  if (sub === 'rebase') {
    if (opts.rebaseError) throw opts.rebaseError;
    return { stdout: opts.rebaseStdout ?? 'Successfully rebased.' };
  }
  return { stdout: '' };
}

/** Routes mocked `git` calls by subcommand so each test declares only what matters. */
function mockGit(opts: GitMockOpts): void {
  vi.mocked(execa).mockImplementation(((_file: any, args: any) =>
    routeGit(args as string[], opts)) as any);
}

/** Returns the recorded execa calls as arrays of git args. */
function gitCalls(): string[][] {
  return vi.mocked(execa).mock.calls.map((c) => c[1] as string[]);
}

describe('rebaseRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports "rebased" for a clean tree with new base commits', async () => {
    mockGit({ statusStdout: '', rebaseStdout: 'Successfully rebased and updated.' });

    const result = await rebaseRepo('/repo', 'main');

    expect(result.success).toBe(true);
    expect(result.status).toBe('rebased');
    expect(result.stashed).toBeFalsy();
    // No stash should be created for a clean tree.
    expect(gitCalls().some((c) => c[0] === 'stash')).toBe(false);
  });

  it('reports "up-to-date" when already current', async () => {
    mockGit({ statusStdout: '', rebaseStdout: 'Current branch feature is up to date.' });

    const result = await rebaseRepo('/repo', 'main');

    expect(result.success).toBe(true);
    expect(result.status).toBe('up-to-date');
  });

  it('auto-stashes a dirty tree and restores it (the regression fix)', async () => {
    mockGit({ statusStdout: ' M src/app.ts\n', rebaseStdout: 'Successfully rebased.' });

    const result = await rebaseRepo('/repo', 'main');

    expect(result.success).toBe(true);
    expect(result.status).toBe('rebased');
    expect(result.stashed).toBe(true);

    const calls = gitCalls();
    // Stash push (with untracked) before rebase, stash pop after.
    expect(calls).toContainEqual(['stash', 'push', '-u', '-m', 'nexusflow-autostash']);
    expect(calls).toContainEqual(['stash', 'pop']);
  });

  it('classifies a fetch failure as "error", not a conflict', async () => {
    mockGit({ fetchError: gitError('fatal: unable to access origin: Could not resolve host') });

    const result = await rebaseRepo('/repo', 'main');

    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/^Fetch failed:/);
    expect(result.conflict).toBeUndefined();
    // Should never attempt a rebase if fetch failed.
    expect(gitCalls().some((c) => c[0] === 'rebase')).toBe(false);
  });

  it('classifies a real merge conflict as "conflict" and aborts', async () => {
    mockGit({
      statusStdout: '',
      rebaseError: gitError('CONFLICT (content): Merge conflict in src/app.ts'),
    });

    const result = await rebaseRepo('/repo', 'main');

    expect(result.success).toBe(false);
    expect(result.status).toBe('conflict');
    expect(result.conflict).toContain('CONFLICT');
    expect(gitCalls()).toContainEqual(['rebase', '--abort']);
  });

  it('restores the stash after aborting a conflicting rebase on a dirty tree', async () => {
    mockGit({
      statusStdout: ' M src/app.ts\n',
      rebaseError: gitError('CONFLICT (content): Merge conflict'),
    });

    const result = await rebaseRepo('/repo', 'main');

    expect(result.status).toBe('conflict');
    expect(result.stashed).toBe(true);
    const calls = gitCalls();
    expect(calls).toContainEqual(['rebase', '--abort']);
    expect(calls).toContainEqual(['stash', 'pop']); // local work restored
  });

  it('reports "stash-conflict" when the rebase lands but the stash pop conflicts', async () => {
    mockGit({
      statusStdout: ' M src/app.ts\n',
      rebaseStdout: 'Successfully rebased.',
      stashPopError: gitError('CONFLICT (content): Merge conflict in src/app.ts'),
    });

    const result = await rebaseRepo('/repo', 'main');

    // The rebase itself succeeded, so success is true, but it needs attention.
    expect(result.success).toBe(true);
    expect(result.status).toBe('stash-conflict');
    expect(result.stashed).toBe(true);
    expect(result.message).toMatch(/stash preserved/i);
  });
});

describe('getWorkspaceRepoPaths', () => {
  beforeEach(() => vi.mocked(execa).mockReset());

  it('reads names and paths from the manifest without running git', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-paths-'));
    try {
      const inPlace = { id: 'w', name: 'w', branchName: 'w', mode: 'in-place', repos: ['/src/app', '/src/lib'],
        isolatedRepos: { lib: { worktreePath: path.join(dir, 'lib'), branchName: 'feat/w' } } };
      await fs.writeFile(path.join(dir, PRIMARY_MANIFEST_FILE), JSON.stringify(inPlace));
      expect(await getWorkspaceRepoPaths(dir)).toEqual([{ name: 'app', path: '/src/app' }, { name: 'lib', path: path.join(dir, 'lib') }]);

      await fs.writeFile(path.join(dir, PRIMARY_MANIFEST_FILE), JSON.stringify({ ...inPlace, mode: 'worktree', isolatedRepos: undefined }));
      expect(await getWorkspaceRepoPaths(dir)).toEqual([{ name: 'app', path: path.join(dir, 'app') }, { name: 'lib', path: path.join(dir, 'lib') }]);
      expect(execa).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('getRepoBranch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the current branch name', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'feature/foo\n' } as any);
    expect(await getRepoBranch('/repo')).toBe('feature/foo');
  });

  it('returns null for a detached HEAD', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'HEAD\n' } as any);
    expect(await getRepoBranch('/repo')).toBeNull();
  });

  it('returns null when git fails', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('not a repo'));
    expect(await getRepoBranch('/repo')).toBeNull();
  });
});

describe('getAheadBehind', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses behind/ahead counts from rev-list --left-right', async () => {
    // Output is "<behind>\t<ahead>".
    vi.mocked(execa).mockResolvedValue({ stdout: '2\t3\n' } as any);
    expect(await getAheadBehind('/repo', 'main')).toEqual({ ahead: 3, behind: 2 });
  });

  it('returns nulls when the remote branch does not exist', async () => {
    vi.mocked(execa).mockRejectedValue(new Error("unknown revision 'origin/main'"));
    expect(await getAheadBehind('/repo', 'main')).toEqual({ ahead: null, behind: null });
  });
});

describe('getRemoteUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the remote URL', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'git@github.com:owner/repo.git\n' } as any);
    expect(await getRemoteUrl('/repo')).toBe('git@github.com:owner/repo.git');
  });

  it('returns null when the remote does not exist', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('No such remote'));
    expect(await getRemoteUrl('/repo')).toBeNull();
  });
});

describe('pushRepo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pushes with -u and reports success', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: '' } as any);
    const result = await pushRepo('/repo', 'feature/foo');
    expect(result.success).toBe(true);
    expect(execa).toHaveBeenCalledWith('git', ['push', '-u', 'origin', 'feature/foo'], { cwd: '/repo' });
  });

  it('reports failure with the first line of the error', async () => {
    vi.mocked(execa).mockRejectedValue(
      Object.assign(new Error('git failed'), { stderr: 'fatal: no upstream\nmore detail' }),
    );
    const result = await pushRepo('/repo', 'feature/foo');
    expect(result.success).toBe(false);
    expect(result.message).toBe('fatal: no upstream');
  });
});

describe('parsePorcelainZ', () => {
  it('parses standard modified and untracked records', () => {
    const raw = ' M src/index.ts\0?? .env\0A  README.md\0';
    const parsed = parsePorcelainZ(raw);
    expect(parsed).toEqual([
      { code: ' M', path: 'src/index.ts' },
      { code: '??', path: '.env' },
      { code: 'A ', path: 'README.md' },
    ]);
  });

  it('correctly skips old path on renamed and copied files', () => {
    const raw = 'R  new-name.ts\0old-name.ts\0 M other.ts\0';
    const parsed = parsePorcelainZ(raw);
    expect(parsed).toEqual([
      { code: 'R ', path: 'new-name.ts' },
      { code: ' M', path: 'other.ts' },
    ]);
  });

  it('handles empty output', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe('isSensitiveFile', () => {
  it('detects .env files and .envrc as sensitive', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.envrc')).toBe(true);
    expect(isSensitiveFile('.env.local')).toBe(true);
    expect(isSensitiveFile('.env.production')).toBe(true);
    expect(isSensitiveFile('subfolder/.env')).toBe(true);
    expect(isSensitiveFile('config/.envrc')).toBe(true);
  });

  it('allows template and example env files', () => {
    expect(isSensitiveFile('.env.example')).toBe(false);
    expect(isSensitiveFile('.env.template')).toBe(false);
    expect(isSensitiveFile('.env.sample')).toBe(false);
  });

  it('detects key and certificate files as sensitive', () => {
    expect(isSensitiveFile('server.key')).toBe(true);
    expect(isSensitiveFile('cert.pem')).toBe(true);
    expect(isSensitiveFile('id_rsa')).toBe(true);
    expect(isSensitiveFile('id_ed25519')).toBe(true);
    expect(isSensitiveFile('gcp-credentials.json')).toBe(true);
    expect(isSensitiveFile('secret.yaml')).toBe(true);
  });

  it('allows standard source files and avoids ancestor directory false positives', () => {
    expect(isSensitiveFile('src/index.ts')).toBe(false);
    expect(isSensitiveFile('package.json')).toBe(false);
    expect(isSensitiveFile('README.md')).toBe(false);
    expect(isSensitiveFile('i18n/tokens/strings.json')).toBe(false);
    expect(isSensitiveFile('locales/secrets/en.json')).toBe(false);
    expect(isSensitiveFile('ui/credential-manager/component.tsx')).toBe(false);
  });
});

describe('commitAndPush secret filtering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes untracked .env and stages only safe files', async () => {
    vi.mocked(execa).mockImplementation(((file: any, args: any) => {
      const sub = args[0];
      if (sub === 'status') {
        return Promise.resolve({ stdout: ' M src/app.ts\0?? .env\0?? src/new-feature.ts\0' });
      }
      if (sub === 'diff' && args[1] === '--cached') {
        return Promise.resolve({ stdout: 'src/app.ts\nsrc/new-feature.ts\n' });
      }
      if (sub === 'commit') {
        return Promise.resolve({ stdout: '[main abc1234] feat: safe commit\n 2 files changed' });
      }
      return Promise.resolve({ stdout: '' });
    }) as any);

    const result = await commitAndPush('/repo', 'feat: safe commit', 'main', { noPush: true });
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc1234');
    expect(result.withheldFiles).toEqual(['.env']);

    const calls = gitCalls();
    // Verify tracked files were staged
    expect(calls).toContainEqual(['add', '-u', '.']);
    // Verify safe untracked file was staged
    expect(calls).toContainEqual(['add', '--', 'src/new-feature.ts']);
    // Verify .env was NOT staged
    expect(calls.some((c) => c.includes('.env'))).toBe(false);
  });

  it('filters untracked sensitive files inside subdirectories (B1)', async () => {
    vi.mocked(execa).mockImplementation(((file: any, args: any) => {
      const sub = args[0];
      if (sub === 'status') {
        // -uall yields individual paths inside config/
        return Promise.resolve({ stdout: '?? config/.env\0?? config/credentials.json\0?? config/app.json\0' });
      }
      if (sub === 'diff' && args[1] === '--cached') {
        return Promise.resolve({ stdout: 'config/app.json\n' });
      }
      if (sub === 'commit') {
        return Promise.resolve({ stdout: '[main def5678] feat: config\n 1 file changed' });
      }
      return Promise.resolve({ stdout: '' });
    }) as any);

    const result = await commitAndPush('/repo', 'feat: config', 'main', { noPush: true });
    expect(result.success).toBe(true);
    expect(result.withheldFiles).toEqual(['config/.env', 'config/credentials.json']);

    const calls = gitCalls();
    // Verify git status received -uall flag
    expect(calls).toContainEqual(['status', '--porcelain', '-z', '-uall']);
    // Verify only safe file config/app.json was staged
    expect(calls).toContainEqual(['add', '--', 'config/app.json']);
    // Verify config/.env and config/credentials.json were NOT staged
    expect(calls.some((c) => c.includes('config/.env') || c.includes('config/credentials.json'))).toBe(false);
  });

  it('batches large numbers of untracked files into chunks of 50 (C1)', async () => {
    const files = Array.from({ length: 120 }, (_, i) => `src/file_${i}.ts`);
    const statusOutput = files.map((f) => `?? ${f}\0`).join('');

    vi.mocked(execa).mockImplementation(((file: any, args: any) => {
      const sub = args[0];
      if (sub === 'status') {
        return Promise.resolve({ stdout: statusOutput });
      }
      if (sub === 'diff' && args[1] === '--cached') {
        return Promise.resolve({ stdout: files.join('\n') });
      }
      if (sub === 'commit') {
        return Promise.resolve({ stdout: '[main 9999999] feat: batch\n 120 files changed' });
      }
      return Promise.resolve({ stdout: '' });
    }) as any);

    const result = await commitAndPush('/repo', 'feat: batch', 'main', { noPush: true });
    expect(result.success).toBe(true);

    const calls = gitCalls();
    const addCalls = calls.filter((c) => c[0] === 'add' && c[1] === '--');
    // 120 files in chunks of 50 -> 3 calls (50, 50, 20)
    expect(addCalls).toHaveLength(3);
    expect(addCalls[0]!.slice(2)).toHaveLength(50);
    expect(addCalls[1]!.slice(2)).toHaveLength(50);
    expect(addCalls[2]!.slice(2)).toHaveLength(20);
  });

  it('handles all-sensitive untracked tree reporting withheld outcome (C2)', async () => {
    vi.mocked(execa).mockImplementation(((file: any, args: any) => {
      const sub = args[0];
      if (sub === 'status') {
        return Promise.resolve({ stdout: '?? .env\0?? private.key\0' });
      }
      if (sub === 'diff' && args[1] === '--cached') {
        return Promise.resolve({ stdout: '' });
      }
      return Promise.resolve({ stdout: '' });
    }) as any);

    const result = await commitAndPush('/repo', 'feat: only secrets', 'main', { noPush: true });
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('');
    expect(result.filesChanged).toBe(0);
    expect(result.withheldFiles).toEqual(['.env', 'private.key']);
    expect(result.message).toContain('2 sensitive file(s) excluded');
  });
});

