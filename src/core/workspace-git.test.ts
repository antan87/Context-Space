import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';
import { execa } from 'execa';

import {
  addWorkspaceRemote,
  commitWorkspaceArtifacts,
  commitExactWorkspaceArtifacts,
  ensureWorkspaceGitRepository,
  getWorkspaceRemote,
  pullWorkspaceArtifacts,
  pushWorkspaceArtifacts,
  redactRemoteUrl,
} from './workspace-git.js';

describe('workspace artifact git', () => {
  let workspacePath: string;
  let remotePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-artifacts-'));
    remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-artifacts-remote-'));
    await execa('git', ['init', '--bare'], { cwd: remotePath });
    await ensureWorkspaceGitRepository(workspacePath);
  });

  afterEach(async () => {
    await fse.remove(workspacePath);
    await fse.remove(remotePath);
  });

  it('commits only the explicitly owned path', async () => {
    await fs.writeFile(path.join(workspacePath, 'nexusflow-knowledge.md'), '# Knowledge\n');
    await fs.writeFile(path.join(workspacePath, 'unrelated.txt'), 'mine\n');
    const result = await commitExactWorkspaceArtifacts(workspacePath, 'remember', ['nexusflow-knowledge.md']);
    expect(result.committed).toBe(true);
    const tracked = await execa('git', ['ls-files'], { cwd: workspacePath });
    expect(tracked.stdout).toContain('nexusflow-knowledge.md');
    expect(tracked.stdout).not.toContain('unrelated.txt');
  });

  it('leaves unrelated pre-staged files out of automatic refresh commits', async () => {
    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), '# Context\n');
    await fs.writeFile(path.join(workspacePath, 'unrelated.txt'), 'mine\n');
    await execa('git', ['add', 'unrelated.txt'], { cwd: workspacePath });

    await commitWorkspaceArtifacts(workspacePath, 'refresh');

    const committed = await execa('git', ['show', '--name-only', '--format='], { cwd: workspacePath });
    expect(committed.stdout).toContain('AGENTS.md');
    expect(committed.stdout).not.toContain('unrelated.txt');
    const staged = await execa('git', ['diff', '--cached', '--name-only'], { cwd: workspacePath });
    expect(staged.stdout).toContain('unrelated.txt');
  });

  it('pushes history and refuses to pull over dirty workspace artifacts', async () => {
    await fs.writeFile(path.join(workspacePath, 'nexusflow-knowledge.md'), '# Knowledge\n');
    await commitExactWorkspaceArtifacts(workspacePath, 'remember', ['nexusflow-knowledge.md']);
    await addWorkspaceRemote(workspacePath, remotePath);
    await pushWorkspaceArtifacts(workspacePath);
    const refs = await execa('git', ['show-ref'], { cwd: remotePath });
    expect(refs.stdout).toContain('refs/heads/');

    await fs.appendFile(path.join(workspacePath, 'nexusflow-knowledge.md'), 'dirty\n');
    await expect(pullWorkspaceArtifacts(workspacePath)).rejects.toThrow(/uncommitted changes/);
  });
});

describe('workspace remote status', () => {
  let workspacePath: string;
  let remotePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-remote-status-'));
    remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-remote-status-bare-'));
    await execa('git', ['init', '--bare'], { cwd: remotePath });
  });

  afterEach(async () => {
    await fse.remove(workspacePath);
    await fse.remove(remotePath);
  });

  it('has no remote in a folder that is not its own git repository', async () => {
    expect(await getWorkspaceRemote(workspacePath)).toEqual({ state: 'none' });
  });

  it('has no remote in a fresh artifact repository', async () => {
    await ensureWorkspaceGitRepository(workspacePath);
    expect(await getWorkspaceRemote(workspacePath)).toEqual({ state: 'none' });
  });

  it('reports the remote once it is added, and reading it pushes nothing', async () => {
    await ensureWorkspaceGitRepository(workspacePath);
    await addWorkspaceRemote(workspacePath, remotePath);

    expect(await getWorkspaceRemote(workspacePath)).toEqual({ state: 'configured', name: 'origin', url: remotePath });
    const refs = await execa('git', ['for-each-ref'], { cwd: remotePath });
    expect(refs.stdout).toBe('');
  });

  it('prefers origin, and otherwise names the one remote it has', async () => {
    await ensureWorkspaceGitRepository(workspacePath);
    await execa('git', ['remote', 'add', 'backup', remotePath], { cwd: workspacePath });
    expect(await getWorkspaceRemote(workspacePath)).toMatchObject({ state: 'configured', name: 'backup' });

    await execa('git', ['remote', 'add', 'origin', remotePath], { cwd: workspacePath });
    expect(await getWorkspaceRemote(workspacePath)).toMatchObject({ state: 'configured', name: 'origin' });
  });

  it('does not credit a workspace with the remote of a git repository it only sits inside', async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-remote-status-outer-'));
    try {
      await execa('git', ['init'], { cwd: outer });
      await execa('git', ['remote', 'add', 'origin', remotePath], { cwd: outer });
      const inner = path.join(outer, 'workspace');
      await fs.mkdir(inner);

      expect(await getWorkspaceRemote(inner)).toEqual({ state: 'none' });
    } finally {
      await fse.remove(outer);
    }
  });

  it('never shows a credential embedded in the remote URL', async () => {
    await ensureWorkspaceGitRepository(workspacePath);
    await execa('git', ['remote', 'add', 'origin', 'https://someone:ghp_secrettoken@example.com/team/notes.git'], { cwd: workspacePath });

    const remote = await getWorkspaceRemote(workspacePath);

    expect(remote).toEqual({ state: 'configured', name: 'origin', url: 'https://***@example.com/team/notes.git' });
    expect(JSON.stringify(remote)).not.toContain('ghp_secrettoken');
  });

  it('redacts only embedded credentials and leaves ordinary URLs alone', () => {
    expect(redactRemoteUrl('https://user:token@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(redactRemoteUrl('ssh://git@host.example/a/b.git')).toBe('ssh://***@host.example/a/b.git');
    expect(redactRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(redactRemoteUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(redactRemoteUrl('/srv/git/notes.git')).toBe('/srv/git/notes.git');
  });
});
