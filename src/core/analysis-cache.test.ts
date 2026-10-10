import { describe, it, expect, vi, beforeEach } from 'vitest';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { execa } from 'execa';
import {
  loadAnalysisCache,
  saveAnalysisCache,
  getRepoFingerprint,
  type AnalysisCache,
} from './analysis-cache.js';
import type { ProjectAnalysis } from '../types.js';

vi.mock('node:fs/promises');
vi.mock('execa');

const mockAnalysis: ProjectAnalysis = {
  name: 'repo-1',
  path: '/ws/repo-1',
  techStack: { languages: ['typescript'], frameworks: [], buildTools: [], projectType: 'backend' },
  dependencies: [],
  ports: [],
  readmeSummary: null,
  existingAIConfigs: [],
};

/** Parses the JSON written by the most recent writeFile call. */
function lastWritten(): AnalysisCache {
  const calls = vi.mocked(fs.writeFile).mock.calls;
  const data = calls[calls.length - 1][1] as string;
  return JSON.parse(data) as AnalysisCache;
}

describe('analysis-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.readlink).mockRejectedValue(Object.assign(new Error('not a link'), { code: 'EINVAL' }));
  });

  describe('loadAnalysisCache', () => {
    it('returns an empty skeleton when the file is absent', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      const cache = await loadAnalysisCache('/ws');

      expect(cache.version).toBe(1);
      expect(cache.repos).toEqual({});
    });

    it('round-trips an existing cache file', async () => {
      const existing: AnalysisCache = {
        version: 1,
        repos: {
          'repo-1': {
            repoName: 'repo-1',
            fingerprint: 'abc123',
            analyzedAt: '2026-01-01T00:00:00.000Z',
            analysis: mockAnalysis,
          },
        },
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing) as any);

      const cache = await loadAnalysisCache('/ws');

      expect(cache.repos['repo-1']!.fingerprint).toBe('abc123');
      expect(cache.repos['repo-1']!.analysis.name).toBe('repo-1');
    });
  });

  describe('saveAnalysisCache', () => {
    it('prunes entries for repos no longer in the workspace', async () => {
      const cache: AnalysisCache = {
        version: 1,
        repos: {
          'repo-1': { repoName: 'repo-1', fingerprint: 'a', analyzedAt: '', analysis: mockAnalysis },
          'removed-repo': { repoName: 'removed-repo', fingerprint: 'b', analyzedAt: '', analysis: mockAnalysis },
        },
      };

      await saveAnalysisCache('/ws', cache, ['repo-1']);

      const written = lastWritten();
      expect(written.repos['repo-1']).toBeDefined();
      expect(written.repos['removed-repo']).toBeUndefined();
    });
  });

  describe('getRepoFingerprint', () => {
    it('returns the version-prefixed HEAD SHA for a clean tree', async () => {
      vi.mocked(execa).mockImplementation((async (_cmd: any, args: any) => {
        if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
        return { stdout: '' }; // clean status
      }) as any);

      const fp = await getRepoFingerprint('/ws/repo-1');

      // The version prefix gates map regeneration on upgrade, not just on repo
      // content — otherwise a generator improvement reaches no existing
      // workspace until someone runs `refresh --force`.
      expect(fp).toMatch(/^nf\S+:abc123$/);
    });

    it('extends the SHA with a dirty-files hash when the tree is dirty', async () => {
      vi.mocked(execa).mockImplementation((async (_cmd: any, args: any) => {
        if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
        return { stdout: ' M src/file1.ts\0' };
      }) as any);
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('first') as any);

      const fp = await getRepoFingerprint('/ws/repo-1');

      if (typeof constants.O_NOFOLLOW === 'number') {
        expect(fp).toMatch(/^nf\S+:abc123\+[0-9a-f]{12}$/);
      } else {
        expect(fp).toBeNull();
      }
    });

    it('invalidates every cached fingerprint when the version changes', async () => {
      // The whole point: an upgraded install must not accept the old key.
      vi.mocked(execa).mockImplementation((async (_cmd: any, args: any) => {
        if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
        return { stdout: '' };
      }) as any);

      const fp = await getRepoFingerprint('/ws/repo-1');

      expect(fp).not.toBe('abc123');
      expect(fp!.split(':')[0]).not.toBe('nf');
    });

    it('changes the fingerprint when a dirty file is edited', async () => {
      vi.mocked(execa).mockImplementation((async (_cmd: any, args: any) => {
        if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
        return { stdout: ' M src/file1.ts\0' };
      }) as any);

      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('first') as any);
      const before = await getRepoFingerprint('/ws/repo-1');

      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('second') as any);
      const after = await getRepoFingerprint('/ws/repo-1');

      if (typeof constants.O_NOFOLLOW === 'number') {
        expect(before).not.toBe(after);
        expect(before).not.toBe('abc123');
      } else {
        expect(before).toBeNull();
        expect(after).toBeNull();
      }
    });

    it('changes when content inside an untracked directory changes without directory metadata changing', async () => {
      vi.mocked(execa).mockImplementation((async (_cmd: any, args: any) => {
        if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
        return { stdout: '?? newdir/source.ts\0' };
      }) as any);
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('aaaa') as any);
      const before = await getRepoFingerprint('/ws/repo-1');

      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('bbbb') as any);
      const after = await getRepoFingerprint('/ws/repo-1');

      if (typeof constants.O_NOFOLLOW === 'number') {
        expect(after).not.toBe(before);
      } else {
        expect(before).toBeNull();
        expect(after).toBeNull();
      }
    });

    it('hashes a symlink target without reading through the link', async () => {
      vi.mocked(execa).mockImplementation((async (_cmd: any, args: any) => {
        if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
        return { stdout: ' M src/link.ts\0' };
      }) as any);
      vi.mocked(fs.readlink).mockResolvedValue('../outside/secret' as any);

      const fp = await getRepoFingerprint('/ws/repo-1');

      expect(fp).toMatch(/^nf\S+:abc123\+[0-9a-f]{12}$/);
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('returns null when git fails', async () => {
      vi.mocked(execa).mockRejectedValue(new Error('not a git repository'));

      const fp = await getRepoFingerprint('/not-a-repo');

      expect(fp).toBeNull();
    });
  });
});

describe('getRepoFingerprint where a file cannot be opened without following links', () => {
  const dirtyStatus = (stdout: string) => vi.mocked(execa).mockImplementation((async (_cmd: any, args: any) =>
    args[0] === 'rev-parse' ? { stdout: 'abc123\n' } : { stdout }) as any);
  const stat = (over: Record<string, number> = {}) => ({ size: 10, mtimeMs: 1000, ctimeMs: 1000, ino: 7, ...over }) as any;
  const windows = { hasNoFollow: false } as const;
  const metadata = { hasNoFollow: false, unsafeRead: 'metadata' } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readlink).mockRejectedValue(Object.assign(new Error('not a link'), { code: 'EINVAL' }));
    vi.mocked(fs.lstat).mockResolvedValue(stat());
    dirtyStatus(' M src/file1.ts\0');
  });

  it('gives up by default, which is what reusing a cached analysis needs', async () => {
    expect(await getRepoFingerprint('/ws/repo-1', windows)).toBeNull();
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('with the metadata form, fingerprints an uncommitted file without opening it', async () => {
    const fp = await getRepoFingerprint('/ws/repo-1', metadata);

    expect(fp).toMatch(/^nf\S+:abc123\+[0-9a-f]{12}$/);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('is the same fingerprint every time while nothing changes, so a refresh can settle on it', async () => {
    expect(await getRepoFingerprint('/ws/repo-1', metadata)).toBe(await getRepoFingerprint('/ws/repo-1', metadata));
  });

  it.each([
    ['its size', { size: 11 }],
    ['its modified time', { mtimeMs: 2000 }],
    ['its change time', { ctimeMs: 2000 }],
    ['its identity on disk', { ino: 8 }],
  ])('changes when %s changes', async (_what, change) => {
    const before = await getRepoFingerprint('/ws/repo-1', metadata);
    vi.mocked(fs.lstat).mockResolvedValue(stat(change));

    expect(await getRepoFingerprint('/ws/repo-1', metadata)).not.toBe(before);
  });

  it('changes when a different file is the uncommitted one', async () => {
    const before = await getRepoFingerprint('/ws/repo-1', metadata);
    dirtyStatus(' M src/file2.ts\0');

    expect(await getRepoFingerprint('/ws/repo-1', metadata)).not.toBe(before);
  });

  it('records a deleted file as missing, and that differs from the file being there', async () => {
    const present = await getRepoFingerprint('/ws/repo-1', metadata);
    vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    const deleted = await getRepoFingerprint('/ws/repo-1', metadata);

    expect(deleted).toMatch(/^nf\S+:abc123\+[0-9a-f]{12}$/);
    expect(deleted).not.toBe(present);
  });

  it('still reads a symlink by its target, never through the link', async () => {
    vi.mocked(fs.readlink).mockResolvedValue('../outside/secret' as any);

    const fp = await getRepoFingerprint('/ws/repo-1', metadata);

    expect(fp).toMatch(/^nf\S+:abc123\+[0-9a-f]{12}$/);
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('needs no file information for a clean tree', async () => {
    dirtyStatus('');

    expect(await getRepoFingerprint('/ws/repo-1', metadata)).toMatch(/^nf\S+:abc123$/);
    expect(fs.lstat).not.toHaveBeenCalled();
  });

  it('keeps hashing the real bytes where files can be opened safely, whatever form is asked for', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('first') as any);
    const before = await getRepoFingerprint('/ws/repo-1', { hasNoFollow: true, unsafeRead: 'metadata' });
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('second') as any);
    const after = await getRepoFingerprint('/ws/repo-1', { hasNoFollow: true, unsafeRead: 'metadata' });

    expect(fs.lstat).not.toHaveBeenCalled();
    expect(after).not.toBe(before);
  });
});
