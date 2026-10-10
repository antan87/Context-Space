import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';
import { execa } from 'execa';

import { offerBackupRemote } from './backup-offer.js';
import { ensureWorkspaceGitRepository } from '../core/workspace-git.js';

describe('offerBackupRemote', () => {
  let workspacePath: string;
  let remotePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-offer-'));
    remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-offer-remote-'));
    await execa('git', ['init', '--bare'], { cwd: remotePath });
    await ensureWorkspaceGitRepository(workspacePath);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fse.remove(workspacePath);
    await fse.remove(remotePath);
  });

  const remotesOf = async (cwd: string) => (await execa('git', ['remote'], { cwd })).stdout;

  it('adds the remote the person pastes, and pushes nothing', async () => {
    const result = await offerBackupRemote(workspacePath, { interactive: true, ask: async () => `  ${remotePath}  ` });

    expect(result).toBe('added');
    expect(await remotesOf(workspacePath)).toBe('origin');
    expect((await execa('git', ['remote', 'get-url', 'origin'], { cwd: workspacePath })).stdout).toBe(remotePath);
    expect((await execa('git', ['for-each-ref'], { cwd: remotePath })).stdout).toBe('');
  });

  it('adds nothing when the person presses Enter', async () => {
    const result = await offerBackupRemote(workspacePath, { interactive: true, ask: async () => '   ' });

    expect(result).toBe('declined');
    expect(await remotesOf(workspacePath)).toBe('');
  });

  it('treats a cancelled prompt as a no, not as a failure', async () => {
    const result = await offerBackupRemote(workspacePath, {
      interactive: true,
      ask: async () => { throw new Error('User force closed the prompt'); },
    });

    expect(result).toBe('declined');
    expect(await remotesOf(workspacePath)).toBe('');
  });

  it('does not ask at all when skipped, or when nobody is at the keyboard', async () => {
    const ask = vi.fn(async () => remotePath);

    expect(await offerBackupRemote(workspacePath, { interactive: true, skip: true, ask })).toBe('skipped');
    expect(await offerBackupRemote(workspacePath, { interactive: false, ask })).toBe('skipped');

    expect(ask).not.toHaveBeenCalled();
    expect(await remotesOf(workspacePath)).toBe('');
  });

  it('reports a remote that cannot be added without throwing, and leaves the existing one alone', async () => {
    await execa('git', ['remote', 'add', 'origin', remotePath], { cwd: workspacePath });

    const result = await offerBackupRemote(workspacePath, { interactive: true, ask: async () => 'https://example.com/other.git' });

    expect(result).toBe('failed');
    expect((await execa('git', ['remote', 'get-url', 'origin'], { cwd: workspacePath })).stdout).toBe(remotePath);
  });
});
