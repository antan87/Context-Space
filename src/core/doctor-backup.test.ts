import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';
import { execa } from 'execa';

import { runDoctor } from './doctor.js';
import { ensureWorkspaceGitRepository } from './workspace-git.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { PRIMARY_KNOWLEDGE_FILE } from './constants.js';

const knowledge = [
  '# Workspace Knowledge — doctor-backup',
  '',
  '## Known Gotchas',
  '',
  '- **2026-10-09:** something worth keeping that exists nowhere else',
  '',
].join('\n');

describe('doctor: workspace backup', () => {
  let workspacePath: string;

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-doctor-backup-'));
    await fs.writeFile(
      path.join(workspacePath, 'contextspace.json'),
      JSON.stringify({ id: 'doctor-backup', branchName: 'doctor-backup', description: 'Doctor', repos: [], assistants: [], mode: 'in-place' }),
    );
    await ensureWorkspaceGitRepository(workspacePath);
  });

  afterEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    await fse.remove(workspacePath);
  });

  const backupCheck = async () => (await runDoctor(workspacePath)).checks.find((check) => check.category === 'Workspace Backup');

  it('warns, and says how to fix it, when hand-written knowledge has no remote', async () => {
    await fs.writeFile(path.join(workspacePath, PRIMARY_KNOWLEDGE_FILE), knowledge);

    const report = await runDoctor(workspacePath);
    const check = report.checks.find((item) => item.category === 'Workspace Backup')!;

    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 knowledge entry');
    expect(check.message).toContain('`ctxspace remote add <git-url>`');
    expect(report.warnings).toContain(check.message);
    expect(report.healthy).toBe(false);
  });

  it('only notes the missing remote, without a warning, when there is nothing hand-written yet', async () => {
    const report = await runDoctor(workspacePath);
    const check = report.checks.find((item) => item.category === 'Workspace Backup')!;

    expect(check.status).toBe('info');
    expect(report.warnings.some((warning) => warning.includes('git remote'))).toBe(false);
  });

  it('passes once a remote is set, and never prints a credential in its URL', async () => {
    await fs.writeFile(path.join(workspacePath, PRIMARY_KNOWLEDGE_FILE), knowledge);
    await execa('git', ['remote', 'add', 'origin', 'https://someone:ghp_secrettoken@example.com/team/notes.git'], { cwd: workspacePath });

    const report = await runDoctor(workspacePath);
    const check = report.checks.find((item) => item.category === 'Workspace Backup')!;

    expect(check.status).toBe('pass');
    expect(check.message).toContain('https://***@example.com/team/notes.git');
    expect(JSON.stringify(report)).not.toContain('ghp_secrettoken');
    expect(report.warnings.some((warning) => warning.includes('git remote'))).toBe(false);
  });

  it('keeps the rest of the report intact', async () => {
    expect(await backupCheck()).toBeDefined();
    expect((await runDoctor(workspacePath)).checks.some((check) => check.category === 'Core Artifacts')).toBe(true);
  });
});
