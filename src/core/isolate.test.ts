import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';

import { isolateWorkspaceRepo } from './isolate.js';
import { saveFeatureConfig, loadFeatureConfig, deleteWorkspace } from './workspace.js';
import { resolveFeatureRepoPath, isRepoIsolated } from '../utils/feature.js';
import { syncWorkspace } from './sync.js';
import { runDoctor } from './doctor.js';
import type { Feature } from '../types.js';

async function initGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# Test Repo\n', 'utf-8');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
}

describe('isolateWorkspaceRepo & on-demand worktree isolation', { timeout: 30000 }, () => {
  let tmpDir: string;
  let repo1Dir: string;
  let repo2Dir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nf-isolate-test-'));
    repo1Dir = path.join(tmpDir, 'repo1');
    repo2Dir = path.join(tmpDir, 'repo2');
    workspaceDir = path.join(tmpDir, 'workspace');

    await initGitRepo(repo1Dir);
    await initGitRepo(repo2Dir);
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  });

  it('throws when the workspace manifest does not exist', async () => {
    await expect(
      isolateWorkspaceRepo(path.join(tmpDir, 'non-existent'), 'repo1'),
    ).rejects.toThrow('Workspace manifest not found');
  });

  it('throws when the target repo is not in the workspace', async () => {
    const feature: Feature = {
      id: 'test-ws',
      mode: 'in-place',
      branchName: 'test-ws',
      description: 'test in-place',
      repos: [repo1Dir],
      originalRepos: [repo1Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    await expect(
      isolateWorkspaceRepo(workspaceDir, 'unknown-repo'),
    ).rejects.toThrow('is not part of workspace');
  });

  it('returns alreadyIsolated: true if workspace is already in worktree mode', async () => {
    const feature: Feature = {
      id: 'test-worktree-ws',
      mode: 'worktree',
      branchName: 'feat/all-repos',
      description: 'test worktree mode',
      repos: [path.join(workspaceDir, 'repo1')],
      originalRepos: [repo1Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    const result = await isolateWorkspaceRepo(workspaceDir, 'repo1');
    expect(result.alreadyIsolated).toBe(true);
    expect(result.repoName).toBe('repo1');
    expect(result.branchName).toBe('feat/all-repos');
  });

  it('dynamically isolates an in-place repo into a worktree on-demand', async () => {
    const feature: Feature = {
      id: 'my-feature',
      mode: 'in-place',
      branchName: 'my-feature',
      description: 'In-place with lazy isolation',
      repos: [repo1Dir, repo2Dir],
      originalRepos: [repo1Dir, repo2Dir],
      assistants: ['antigravity', 'claude'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    // Initial state: repos are NOT isolated
    expect(isRepoIsolated(feature, 'repo1')).toBe(false);
    expect(resolveFeatureRepoPath(feature, workspaceDir, repo1Dir)).toBe(repo1Dir);

    // Isolate repo1
    const result = await isolateWorkspaceRepo(workspaceDir, 'repo1', {
      branchName: 'feat/repo1-custom',
    });

    expect(result.alreadyIsolated).toBe(false);
    expect(result.repoName).toBe('repo1');
    expect(result.branchName).toBe('feat/repo1-custom');
    expect(result.worktreePath).toBe(path.join(workspaceDir, 'repo1'));

    // Check that worktree directory exists on disk and is on the right branch
    const { stdout: branchOut } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: result.worktreePath,
    });
    expect(branchOut.trim()).toBe('feat/repo1-custom');

    // Check manifest was updated
    const updated = await loadFeatureConfig(workspaceDir);
    expect(updated?.isolatedRepos?.['repo1']).toBeDefined();
    expect(updated?.isolatedRepos?.['repo1']?.branchName).toBe('feat/repo1-custom');
    expect(updated?.isolatedRepos?.['repo1']?.worktreePath).toBe(result.worktreePath);

    // Check that resolveFeatureRepoPath now points to worktree for repo1, and source for repo2
    expect(isRepoIsolated(updated!, 'repo1')).toBe(true);
    expect(isRepoIsolated(updated!, 'repo2')).toBe(false);
    expect(resolveFeatureRepoPath(updated!, workspaceDir, repo1Dir)).toBe(result.worktreePath);
    expect(resolveFeatureRepoPath(updated!, workspaceDir, repo2Dir)).toBe(repo2Dir);

    // Check .gitignore in workspace ignores /repo1/
    const gitignoreContent = await fs.readFile(path.join(workspaceDir, '.gitignore'), 'utf-8');
    expect(gitignoreContent).toContain('/repo1/');

    // Calling isolate again on repo1 is idempotent
    const rerun = await isolateWorkspaceRepo(workspaceDir, 'repo1');
    expect(rerun.alreadyIsolated).toBe(true);
    expect(rerun.branchName).toBe('feat/repo1-custom');
  });

  it('syncs isolated worktree repos while skipping non-isolated repos in in-place mode', async () => {
    const remote1Dir = path.join(tmpDir, 'remote1.git');
    const syncRepo1Dir = path.join(tmpDir, 'syncRepo1');

    await fs.mkdir(remote1Dir, { recursive: true });
    await execa('git', ['init', '--bare', '-b', 'main'], { cwd: remote1Dir });

    await fs.mkdir(syncRepo1Dir, { recursive: true });
    await execa('git', ['init', '-b', 'main'], { cwd: syncRepo1Dir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: syncRepo1Dir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: syncRepo1Dir });
    await fs.writeFile(path.join(syncRepo1Dir, 'README.md'), '# Sync Repo\n', 'utf-8');
    await execa('git', ['add', '.'], { cwd: syncRepo1Dir });
    await execa('git', ['commit', '-m', 'Initial commit'], { cwd: syncRepo1Dir });
    await execa('git', ['remote', 'add', 'origin', remote1Dir], { cwd: syncRepo1Dir });
    await execa('git', ['push', '-u', 'origin', 'main'], { cwd: syncRepo1Dir });

    const feature: Feature = {
      id: 'sync-test',
      mode: 'in-place',
      branchName: 'sync-test',
      description: 'In-place sync test',
      repos: [syncRepo1Dir, repo2Dir],
      originalRepos: [syncRepo1Dir, repo2Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    // Isolate syncRepo1
    await isolateWorkspaceRepo(workspaceDir, 'syncRepo1', { branchName: 'feat/sync-repo1' });

    // Commit and push a new change on origin main
    await fs.writeFile(path.join(syncRepo1Dir, 'newfile.txt'), 'hello\n');
    await execa('git', ['add', '.'], { cwd: syncRepo1Dir });
    await execa('git', ['commit', '-m', 'Add newfile on main'], { cwd: syncRepo1Dir });
    await execa('git', ['push', 'origin', 'main'], { cwd: syncRepo1Dir });

    const syncReport = await syncWorkspace(workspaceDir);
    expect(syncReport.repos).toHaveLength(2);

    const repo1Sync = syncReport.repos.find((r) => r.name === 'syncRepo1');
    const repo2Sync = syncReport.repos.find((r) => r.name === 'repo2');

    expect(repo1Sync?.status).toBe('rebased');
    expect(repo2Sync?.message).toContain('In-place repo — branches are managed by you');
  });

  it('cleans up isolated worktrees when deleting an in-place workspace', async () => {
    const feature: Feature = {
      id: 'cleanup-test',
      mode: 'in-place',
      branchName: 'cleanup-test',
      description: 'In-place cleanup test',
      repos: [repo1Dir],
      originalRepos: [repo1Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    await isolateWorkspaceRepo(workspaceDir, 'repo1');
    const worktreeDir = path.join(workspaceDir, 'repo1');
    expect(await fs.stat(worktreeDir)).toBeDefined();

    await deleteWorkspace(workspaceDir);

    // Workspace directory removed
    await expect(fs.access(workspaceDir)).rejects.toThrow();

    // Source repo intact
    expect(await fs.stat(repo1Dir)).toBeDefined();

    // Worktree list in source repo is clean
    const { stdout: wtList } = await execa('git', ['worktree', 'list'], { cwd: repo1Dir });
    expect(wtList).not.toContain(worktreeDir);
  });

  it('rejects invalid or option-injected branch names', async () => {
    const feature: Feature = {
      id: 'sec-test',
      mode: 'in-place',
      branchName: 'sec-test',
      description: 'Security validation test',
      repos: [repo1Dir],
      originalRepos: [repo1Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    await expect(
      isolateWorkspaceRepo(workspaceDir, 'repo1', { branchName: '--lock' }),
    ).rejects.toThrow('Invalid branch name');

    await expect(
      isolateWorkspaceRepo(workspaceDir, 'repo1', { branchName: '-f' }),
    ).rejects.toThrow('Invalid branch name');

    await expect(
      isolateWorkspaceRepo(workspaceDir, 'repo1', { branchName: 'invalid branch with spaces' }),
    ).rejects.toThrow('Invalid branch name');
  });

  it('recovers and recreates worktree if directory is deleted from disk', async () => {
    const feature: Feature = {
      id: 'recover-test',
      mode: 'in-place',
      branchName: 'recover-test',
      description: 'Recovery test',
      repos: [repo1Dir],
      originalRepos: [repo1Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    // Initial isolation
    const res1 = await isolateWorkspaceRepo(workspaceDir, 'repo1', { branchName: 'feat/rec-1' });
    expect(res1.alreadyIsolated).toBe(false);

    // Simulate accidental deletion of worktree folder from disk
    await fs.rm(res1.worktreePath, { recursive: true, force: true });

    // Calling isolate again should prune stale git registration and recreate cleanly
    const res2 = await isolateWorkspaceRepo(workspaceDir, 'repo1', { branchName: 'feat/rec-1' });
    expect(res2.worktreePath).toBe(res1.worktreePath);
    expect(await fs.stat(res2.worktreePath)).toBeDefined();
  });

  it('handles case-insensitive repository lookups on Windows', async () => {
    const feature: Feature = {
      id: 'case-test',
      mode: 'in-place',
      branchName: 'case-test',
      description: 'Case sensitivity test',
      repos: [repo1Dir],
      originalRepos: [repo1Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    // Pass uppercase repo name 'REPO1'
    const result = await isolateWorkspaceRepo(workspaceDir, 'REPO1', { branchName: 'feat/case-test' });
    expect(result.repoName).toBe('repo1');
    expect(result.branchName).toBe('feat/case-test');
  });

  it('handles concurrent isolation operations without manifest clobbering', async () => {
    const feature: Feature = {
      id: 'concurrency-test',
      mode: 'in-place',
      branchName: 'concurrency-test',
      description: 'Concurrency test',
      repos: [repo1Dir, repo2Dir],
      originalRepos: [repo1Dir, repo2Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    // Isolate repo1 and repo2 concurrently
    const [res1, res2] = await Promise.all([
      isolateWorkspaceRepo(workspaceDir, 'repo1', { branchName: 'feat/concurrent-1' }),
      isolateWorkspaceRepo(workspaceDir, 'repo2', { branchName: 'feat/concurrent-2' }),
    ]);

    expect(res1.repoName).toBe('repo1');
    expect(res2.repoName).toBe('repo2');

    const updated = await loadFeatureConfig(workspaceDir);
    expect(updated?.isolatedRepos?.['repo1']).toBeDefined();
    expect(updated?.isolatedRepos?.['repo2']).toBeDefined();
  });

  it('doctor passes cleanly on isolated in-place workspace without false branch mismatch warnings', async () => {
    const feature: Feature = {
      id: 'doc-test',
      mode: 'in-place',
      branchName: 'doc-test',
      description: 'Doctor test',
      repos: [repo1Dir],
      originalRepos: [repo1Dir],
      assistants: ['antigravity'],
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspaceDir, feature);

    await isolateWorkspaceRepo(workspaceDir, 'repo1', { branchName: 'feat/doc-isolated' });

    const report = await runDoctor(workspaceDir);
    const branchCheck = report.checks.find((c) => c.category === 'Branch Alignment & Git Status');
    expect(branchCheck?.status).toBe('pass');
    expect(report.errors).toHaveLength(0);
  });

  it('doctor rejects explicit contract endpoints that do not exist', async () => {
    const feature: Feature = {
      id: 'contract-test', mode: 'in-place', branchName: 'contract-test', description: 'Contract test',
      repos: [repo1Dir], originalRepos: [repo1Dir], assistants: [], workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      contracts: [{ from: 'src/missing-bff', to: 'src/missing-spa', kind: 'http-envelope', entry: '2026-08-25-bff-errors' }],
    };
    await saveFeatureConfig(workspaceDir, feature);
    await fs.writeFile(path.join(workspaceDir, 'nexusflow-knowledge.md'), '### 2026-08-25 — bff-errors\n**Gotcha:** Decode once.\n');

    const report = await runDoctor(workspaceDir);

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'Explicit Contracts', status: 'fail' }),
    ]));
  });

  it('doctor accepts explicit contract endpoints backed by real paths and knowledge', async () => {
    await fs.mkdir(path.join(repo1Dir, 'apps', 'bff'), { recursive: true });
    await fs.mkdir(path.join(repo1Dir, 'apps', 'spa'), { recursive: true });
    const feature: Feature = {
      id: 'contract-test', mode: 'in-place', branchName: 'contract-test', description: 'Contract test',
      repos: [repo1Dir], originalRepos: [repo1Dir], assistants: [], workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      contracts: [{ from: 'apps/bff', to: 'apps/spa', kind: 'http-envelope', entry: '2026-08-25-bff-errors' }],
    };
    await saveFeatureConfig(workspaceDir, feature);
    await fs.writeFile(path.join(workspaceDir, 'nexusflow-knowledge.md'), '### 2026-08-25 — bff-errors\n**Gotcha:** Decode once.\n');

    const report = await runDoctor(workspaceDir);

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'Explicit Contracts', name: 'http-envelope', status: 'pass' }),
    ]));
  });

  it('doctor finds the knowledge entry a contract names when its title is written as words', async () => {
    await fs.mkdir(path.join(repo1Dir, 'apps', 'bff'), { recursive: true });
    await fs.mkdir(path.join(repo1Dir, 'apps', 'spa'), { recursive: true });
    const feature: Feature = {
      id: 'contract-test', mode: 'in-place', branchName: 'contract-test', description: 'Contract test',
      repos: [repo1Dir], originalRepos: [repo1Dir], assistants: [], workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      contracts: [
        { from: 'apps/bff', to: 'apps/spa', kind: 'http-envelope', entry: '2026-08-25-bff-errors' },
        { from: 'apps/spa', to: 'apps/bff', kind: 'retry', entry: '2026-08-26-missing-entry' },
      ],
    };
    await saveFeatureConfig(workspaceDir, feature);
    await fs.writeFile(path.join(workspaceDir, 'nexusflow-knowledge.md'), '### 2026-08-25 — BFF errors\n**Gotcha:** Decode once.\n');

    const report = await runDoctor(workspaceDir);

    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'Explicit Contracts', name: 'http-envelope', status: 'pass' }),
      expect.objectContaining({ category: 'Explicit Contracts', name: 'retry', status: 'warn' }),
    ]));
  });
});
