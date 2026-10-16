import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { refreshWorkspace, upgradeWorkspaceToRunningVersion } from './refresh.js';
import { getGeneratorVersion } from './analysis-cache.js';
import * as workspace from './workspace.js';
import * as analyzers from '../analyzers/index.js';
import * as generators from '../generators/index.js';
import * as handoff from '../commands/handoff.js';
import * as generationLock from './generation-lock.js';
import * as locks from './locks.js';
import * as workspaceTools from './workspace-tools.js';

vi.mock('node:fs/promises');
vi.mock('./workspace.js');
vi.mock('../analyzers/index.js');
vi.mock('../generators/index.js');
vi.mock('../commands/handoff.js');
vi.mock('./generation-lock.js');
vi.mock('./locks.js');
vi.mock('./workspace-tools.js');

const feature = {
  id: 'feat',
  branchName: 'feat',
  description: 'd',
  repos: ['/ws/a', '/ws/b'],
  assistants: ['claude'],
  workspacePath: '/ws',
  createdAt: '2026-07-04T00:00:00Z',
} as any;

describe('refreshWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspace.loadFeatureConfig).mockResolvedValue(feature);
    vi.mocked(workspace.resolveRepoInfos).mockResolvedValue([
      { name: 'a', path: '/ws/a', defaultBranch: 'main' },
      { name: 'b', path: '/ws/b', defaultBranch: 'main' },
    ]);
    vi.mocked(analyzers.analyzeAllReposCached).mockResolvedValue({ analysis: new Map(), analyzed: ['a'], reused: ['b'] } as any);
    vi.mocked(generators.generateContextFiles).mockResolvedValue(undefined);
    vi.mocked(handoff.handoffCommand).mockResolvedValue(undefined);
    vi.mocked(generationLock.checkGenerationLock).mockResolvedValue({ fresh: true, lock: null, drift: [] });
    vi.mocked(locks.acquireLock).mockResolvedValue(vi.fn().mockResolvedValue(undefined));
    // No handoff bundle by default.
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
  });

  it('throws when the workspace manifest is missing', async () => {
    vi.mocked(workspace.loadFeatureConfig).mockResolvedValue(null);
    await expect(refreshWorkspace('/ws')).rejects.toThrow(/Failed to load workspace configuration/);
  });

  it('passes analyzed/reused through to the report', async () => {
    const report = await refreshWorkspace('/ws');
    expect(report.analyzedRepos).toEqual(['a']);
    expect(report.reusedRepos).toEqual(['b']);
  });

  it('still reuses cached analysis for unchanged repos when not forcing', async () => {
    // The `changedRepos` argument is gone with the per-repo maps it gated — the
    // remaining generated files all describe the whole workspace — but the
    // analysis cache itself is what saves the work, and that still applies.
    const report = await refreshWorkspace('/ws');

    expect(report.reusedRepos).toEqual(['b']);
    expect(generators.generateContextFiles).toHaveBeenCalledWith(
      expect.any(Object), feature.assistants, '/ws',
    );
  });

  it('re-analyzes everything when force is set', async () => {
    await refreshWorkspace('/ws', { force: true });

    expect(analyzers.analyzeAllReposCached).toHaveBeenCalledWith(
      expect.any(Array), '/ws', { force: true },
    );
  });

  it('serializes refresh and generated-file mutation with a workspace lock', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(locks.acquireLock).mockResolvedValue(release);

    await refreshWorkspace('/ws');

    expect(locks.acquireLock).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]\.(?:contextspace|nexusflow)[\\/]generation\.lock$/),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('checks provenance without analyzing or regenerating', async () => {
    const report = await refreshWorkspace('/ws', { check: true });
    expect(report.check?.fresh).toBe(true);
    expect(generationLock.checkGenerationLock).toHaveBeenCalledWith('/ws', { markDocuments: true });
    expect(analyzers.analyzeAllReposCached).not.toHaveBeenCalled();
    expect(generators.generateContextFiles).not.toHaveBeenCalled();
  });

  it('refreshes the handoff bundle when it exists', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined); // handoff file exists

    const report = await refreshWorkspace('/ws');

    expect(handoff.handoffCommand).toHaveBeenCalledWith('/ws');
    expect(report.refreshedHandoff).toBe(true);
  });

  it('regenerates every context file, since none of them is per-repo', async () => {
    // `baseOnly` and `onlyRepo` are gone: once the per-repo architecture maps
    // went, `baseOnly` made the generator write nothing while refresh still
    // reported success, and `onlyRepo` narrowed only a logging loop.
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const report = await refreshWorkspace('/ws');

    expect(generators.generateContextFiles).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      '/ws',
    );
    expect(report.refreshedHandoff).toBe(true);
  });
});

describe('upgradeWorkspaceToRunningVersion', () => {
  const lockFrom = (toolVersion: string) => ({ schemaVersion: 1, toolVersion, repos: {}, outputs: {}, generatedAt: '' }) as any;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspace.loadFeatureConfig).mockResolvedValue(feature);
    vi.mocked(workspace.resolveRepoInfos).mockResolvedValue([]);
    vi.mocked(analyzers.analyzeAllReposCached).mockResolvedValue({ analysis: new Map(), analyzed: [], reused: [] } as any);
    vi.mocked(generators.generateContextFiles).mockResolvedValue(undefined);
    vi.mocked(locks.acquireLock).mockResolvedValue(vi.fn().mockResolvedValue(undefined));
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
  });

  it('refreshes a workspace an older version generated', async () => {
    vi.mocked(generationLock.readGenerationLock).mockResolvedValue(lockFrom('2.39.0'));
    expect(await upgradeWorkspaceToRunningVersion('/ws')).toBe(true);
    expect(generators.generateContextFiles).toHaveBeenCalledOnce();
  });

  it('leaves a workspace on this version, on a newer one, or with no lock alone', async () => {
    for (const lock of [lockFrom(getGeneratorVersion()), lockFrom('99.0.0'), null]) {
      vi.mocked(generationLock.readGenerationLock).mockResolvedValue(lock);
      expect(await upgradeWorkspaceToRunningVersion('/ws')).toBe(false);
    }
    expect(generators.generateContextFiles).not.toHaveBeenCalled();
  });

  it('leaves an archived workspace alone, however old it is', async () => {
    vi.mocked(workspace.loadFeatureConfig).mockResolvedValue({ ...feature, archivedAt: '2026-10-01T00:00:00Z' });
    vi.mocked(generationLock.readGenerationLock).mockResolvedValue(lockFrom('2.39.0'));
    expect(await upgradeWorkspaceToRunningVersion('/ws')).toBe(false);
    expect(generators.generateContextFiles).not.toHaveBeenCalled();
  });

  it('also refreshes a workspace on this version whose tools point at a program that is gone', async () => {
    vi.mocked(generationLock.readGenerationLock).mockResolvedValue(lockFrom(getGeneratorVersion()));
    vi.mocked(workspaceTools.workspaceToolsNeedRepair).mockResolvedValue(true);
    expect(await upgradeWorkspaceToRunningVersion('/ws')).toBe(true);
    expect(generators.generateContextFiles).toHaveBeenCalledOnce();
  });

  it('reports a failed refresh instead of throwing, so the workspace still opens', async () => {
    vi.mocked(generationLock.readGenerationLock).mockResolvedValue(lockFrom('2.39.0'));
    vi.mocked(generators.generateContextFiles).mockRejectedValue(new Error('Refusing to overwrite a custom launcher'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await upgradeWorkspaceToRunningVersion('/ws')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('custom launcher'));
    warn.mockRestore();
  });
});
