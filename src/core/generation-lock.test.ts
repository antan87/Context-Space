import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as analysisCache from './analysis-cache.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';
import { execa } from 'execa';

import {
  captureGenerationSnapshot,
  checkGenerationLock,
  renderFreshnessBanner,
  writeGenerationLock,
} from './generation-lock.js';
import { getStorageProvider, setActiveStorageProvider } from './adapters/registry.js';
import type { StoragePort } from './ports/storage.js';

import { PRIMARY_MANIFEST_FILE, PRIMARY_LOCK_FILE, BRAND_NAME } from './constants.js';

describe('generation lock', () => {
  let workspacePath: string;
  let repoPath: string;

  beforeEach(async () => {
    setActiveStorageProvider(getStorageProvider('local'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-lock-'));
    repoPath = path.join(workspacePath, 'repo');
    await fs.mkdir(repoPath);
    await execa('git', ['init'], { cwd: repoPath });
    await execa('git', ['config', 'user.name', 'ContextSpace Test'], { cwd: repoPath });
    await execa('git', ['config', 'user.email', 'contextspace-test@local'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
    await execa('git', ['add', 'README.md'], { cwd: repoPath });
    await execa('git', ['commit', '-m', 'fixture'], { cwd: repoPath });
    await fs.writeFile(path.join(workspacePath, PRIMARY_MANIFEST_FILE), JSON.stringify({
      id: 'lock-test', mode: 'in-place', branchName: 'lock-test', description: 'test',
      repos: [repoPath], assistants: [], workspacePath, createdAt: new Date().toISOString(),
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setActiveStorageProvider(getStorageProvider('local'));
    await fse.remove(workspacePath);
  });

  async function createLock(): Promise<void> {
    const repos = [{ name: 'repo', path: repoPath, defaultBranch: 'main' }];
    const snapshot = await captureGenerationSnapshot(repos);
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), `${renderFreshnessBanner(snapshot)}\n\n# Test\n`);
    await writeGenerationLock(workspacePath, snapshot, [{ path: 'AGENTS.md', source: 'test' }]);
  }

  it('accepts the exact repo and generated-output snapshot', async () => {
    await createLock();
    await expect(checkGenerationLock(workspacePath)).resolves.toMatchObject({ fresh: true, drift: [] });
  });

  it('retains generatedAt when refresh reproduces the identical snapshot and outputs', async () => {
    await createLock();
    const before = JSON.parse(await fs.readFile(path.join(workspacePath, PRIMARY_LOCK_FILE), 'utf-8')) as { generatedAt: string };
    const snapshot = await captureGenerationSnapshot([{ name: 'repo', path: repoPath, defaultBranch: 'main' }]);
    snapshot.generatedAt = '2099-01-01T00:00:00.000Z';
    await writeGenerationLock(workspacePath, snapshot, [{ path: 'AGENTS.md', source: 'test' }]);
    const after = JSON.parse(await fs.readFile(path.join(workspacePath, PRIMARY_LOCK_FILE), 'utf-8')) as { generatedAt: string };

    expect(after.generatedAt).toBe(before.generatedAt);
  });

  it('detects dirty repo state and injects a loud bounded banner', async () => {
    await createLock();
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n');
    const result = await checkGenerationLock(workspacePath, { markDocuments: true });
    expect(result.fresh).toBe(false);
    expect(result.drift).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'repo', name: 'repo' })]));
    expect(await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf-8')).toContain(`STALE ${BRAND_NAME.toUpperCase()} CONTEXT`);
  });

  it('still proves clean-to-dirty drift when dirty bytes cannot be fingerprinted', async () => {
    await createLock();
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed without a safe file-open flag\n');
    vi.spyOn(analysisCache, 'getRepoFingerprint').mockResolvedValue(null);
    const result = await checkGenerationLock(workspacePath, { markDocuments: true });
    expect(result.drift).toContainEqual(expect.objectContaining({ kind: 'repo', name: 'repo' }));
    expect(await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8')).toContain('with uncommitted changes');
  });

  it('gives a repo with uncommitted files a real fingerprint on every platform, so generation never has to give up on it', async () => {
    await fs.writeFile(path.join(repoPath, 'README.md'), '# dirty\n');
    const snapshot = await captureGenerationSnapshot([
      { name: 'repo', path: repoPath, defaultBranch: 'main' },
    ]);

    // Where the platform can open a file without following links the bytes are hashed; where it cannot
    // (Windows) the file's size and timestamps are used instead. Either way there is a fingerprint, so
    // the snapshot is never recorded as unreadable and the notice never has to say it cannot be verified.
    expect(snapshot.repos.repo!.fingerprint).toContain('+');
    expect(snapshot.repos.repo!.fingerprint).not.toMatch(/^uncacheable:/);
    expect(renderFreshnessBanner(snapshot)).not.toContain('CANNOT BE VERIFIED');
  });

  it('reports an unverifiable same-revision snapshot without claiming known staleness', async () => {
    await createLock();
    const lockPath = path.join(workspacePath, PRIMARY_LOCK_FILE);
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    lock.repos.repo.fingerprint = 'uncacheable:platform';
    await fs.writeFile(lockPath, JSON.stringify(lock));
    const result = await checkGenerationLock(workspacePath, { markDocuments: true });
    expect(result.fresh).toBe(false);
    expect(result.drift).toContainEqual(expect.objectContaining({ kind: 'unverified', name: 'repo' }));
    const banner = await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');
    expect(banner).toContain('CANNOT BE VERIFIED');
    expect(banner).not.toContain('STALE');
    expect(banner).not.toContain('Run `ctxspace refresh` before');
  });

  it('says what is degraded, what is still checked and how to clear an unverifiable snapshot', async () => {
    await createLock();
    const lockPath = path.join(workspacePath, PRIMARY_LOCK_FILE);
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    lock.repos.repo.fingerprint = 'uncacheable:platform';
    await fs.writeFile(lockPath, JSON.stringify(lock));
    const result = await checkGenerationLock(workspacePath, { markDocuments: true });

    const banner = await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');
    const message = result.drift.find((item) => item.kind === 'unverified')!.message;
    for (const text of [banner, message]) {
      expect(text).toContain('they could not be fingerprinted');
      expect(text).toContain('Commits are still checked');
      expect(text).toContain('run `ctxspace refresh`');
      expect(text).toContain('make sure git can read the repository');
      expect(text).not.toContain('Windows');
    }
    expect(banner).toContain('Uncommitted changes in repo cannot be checked');
    expect(banner).toContain('check live state with `ctxspace status`');
  });

  describe('on a platform that cannot open files without following links (Windows)', () => {
    // The real fingerprint, told it is on such a platform. Bytes are never read there.
    beforeEach(() => {
      const real = analysisCache.getRepoFingerprint;
      vi.spyOn(analysisCache, 'getRepoFingerprint').mockImplementation((repo, options) => real(repo, { ...options, hasNoFollow: false }));
    });
    const unverified = expect.objectContaining({ kind: 'unverified', name: 'repo' });
    const stale = expect.objectContaining({ kind: 'repo', name: 'repo' });

    it('settles on a refresh while files are uncommitted, instead of staying unverifiable', async () => {
      await fs.writeFile(path.join(repoPath, 'README.md'), '# uncommitted\n');

      await createLock();

      const lock = JSON.parse(await fs.readFile(path.join(workspacePath, PRIMARY_LOCK_FILE), 'utf8'));
      expect(lock.repos.repo.fingerprint).not.toMatch(/^uncacheable:/);
      expect(await checkGenerationLock(workspacePath)).toMatchObject({ fresh: true, drift: [] });
      expect(await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8')).not.toContain('CANNOT BE VERIFIED');
    });

    it('still notices an edit to an uncommitted file made after the context was generated', async () => {
      await fs.writeFile(path.join(repoPath, 'README.md'), '# uncommitted\n');
      await createLock();

      await fs.writeFile(path.join(repoPath, 'README.md'), '# uncommitted, then edited further\n');

      const result = await checkGenerationLock(workspacePath);
      expect(result.fresh).toBe(false);
      expect(result.drift).toContainEqual(stale);
      expect(result.drift).not.toContainEqual(unverified);
    });

    it('is fresh again after the next refresh, and after committing and refreshing', async () => {
      await fs.writeFile(path.join(repoPath, 'README.md'), '# uncommitted\n');
      await createLock();
      await fs.writeFile(path.join(repoPath, 'README.md'), '# uncommitted, then edited further\n');
      await createLock();
      expect(await checkGenerationLock(workspacePath)).toMatchObject({ fresh: true, drift: [] });

      await execa('git', ['commit', '-am', 'save the work'], { cwd: repoPath });
      expect((await checkGenerationLock(workspacePath)).drift).toContainEqual(stale);
      await createLock();
      expect(await checkGenerationLock(workspacePath)).toMatchObject({ fresh: true, drift: [] });
    });

    it('clears, with one refresh, a lock an older version recorded as unreadable on this platform', async () => {
      await fs.writeFile(path.join(repoPath, 'README.md'), '# uncommitted\n');
      await createLock();
      const lockPath = path.join(workspacePath, PRIMARY_LOCK_FILE);
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      lock.repos.repo.fingerprint = `uncacheable:${lock.repos.repo.sha}`;
      await fs.writeFile(lockPath, JSON.stringify(lock));
      expect((await checkGenerationLock(workspacePath)).drift).toContainEqual(unverified);

      await createLock();

      expect(await checkGenerationLock(workspacePath)).toMatchObject({ fresh: true, drift: [] });
    });

    it('does not weaken the analysis cache: asking without the metadata form still gives up', async () => {
      await fs.writeFile(path.join(repoPath, 'README.md'), '# uncommitted\n');

      expect(await analysisCache.getRepoFingerprint(repoPath)).toBeNull();
    });
  });

  it('stays unverified, with a way out that names git, when git cannot report on the repository', async () => {
    await fs.writeFile(path.join(repoPath, 'README.md'), '# uncommitted\n');
    vi.spyOn(analysisCache, 'getRepoFingerprint').mockResolvedValue(null);

    await createLock();
    const result = await checkGenerationLock(workspacePath, { markDocuments: true });

    expect(result.drift).toContainEqual(expect.objectContaining({ kind: 'unverified', name: 'repo' }));
    const message = result.drift.find((item) => item.kind === 'unverified')!.message;
    expect(message).toContain('make sure git can read the repository');
    expect(await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8')).toContain('CANNOT BE VERIFIED');
  });

  it('detects edits outside the mutable freshness banner', async () => {
    await createLock();
    await fs.appendFile(path.join(workspacePath, 'AGENTS.md'), 'manual edit\n');
    const result = await checkGenerationLock(workspacePath);
    expect(result.drift).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output', name: 'AGENTS.md' })]));
  });

  it('marks context stale when the generator version changes', async () => {
    await createLock();
    const lockPath = path.join(workspacePath, PRIMARY_LOCK_FILE);
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf-8')) as { toolVersion: string };
    lock.toolVersion = '0.0.0-old';
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');

    const result = await checkGenerationLock(workspacePath, { markDocuments: true });

    expect(result.drift).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool' })]));
    expect(await fs.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf-8')).toContain(`Generated with ${BRAND_NAME} 0.0.0-old`);
  });

  it('hashes local binary resource bytes without UTF-8 replacement collisions', async () => {
    const assetPath = path.join(workspacePath, '.agents', 'skills', 'demo', 'assets', 'sample.bin');
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.writeFile(assetPath, Buffer.from([0x80]));
    const snapshot = await captureGenerationSnapshot([{ name: 'repo', path: repoPath, defaultBranch: 'main' }]);
    await writeGenerationLock(workspacePath, snapshot, [{
      path: '.agents/skills/demo/assets/sample.bin',
      source: 'test asset',
      location: 'local',
    }]);

    await fs.writeFile(assetPath, Buffer.from([0x81]));
    const result = await checkGenerationLock(workspacePath);

    expect(result.drift).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'output', name: '.agents/skills/demo/assets/sample.bin' }),
    ]));
  });

  it('reads workspace documents through the active storage adapter', async () => {
    const documents = new Map<string, string>([['AGENTS.md', '# Adapter context\n']]);
    const adapter: StoragePort = {
      meta: { name: 'memory', displayName: 'Memory', description: 'test', configFields: [] },
      writeWorkspaceFile: async (_workspace, _feature, filename, content) => { documents.set(filename, content); },
      readWorkspaceFile: async (_workspace, _feature, filename) => {
        const content = documents.get(filename);
        if (content === undefined) throw new Error('missing');
        return content;
      },
      workspaceFileExists: async (_workspace, _feature, filename) => documents.has(filename),
      resolveWorkspaceFileUrl: (_workspace, _feature, filename) => `memory:${filename}`,
      writeBaseFile: async () => {},
      readBaseFile: async () => '',
      baseFileExists: async () => false,
      resolveBaseFileUrl: () => 'memory:base',
      deleteWorkspace: async () => {},
    };
    setActiveStorageProvider(adapter);
    const snapshot = await captureGenerationSnapshot([{ name: 'repo', path: repoPath, defaultBranch: 'main' }]);
    await writeGenerationLock(workspacePath, snapshot, [{ path: 'AGENTS.md', source: 'test', location: 'workspace' }]);
    await expect(checkGenerationLock(workspacePath)).resolves.toMatchObject({ fresh: true });

    documents.set('AGENTS.md', '# Changed adapter context\n');
    const result = await checkGenerationLock(workspacePath);
    expect(result.drift).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output', name: 'AGENTS.md' })]));
  });
});
