import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';
import { execa } from 'execa';

import { describeWorkspaceBackup } from './workspace-backup.js';
import { addWorkspaceRemote, ensureWorkspaceGitRepository } from './workspace-git.js';
import { ensurePlanningNotes, PLANNING_NOTES_FILE } from './planning-notes.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { PRIMARY_KNOWLEDGE_FILE } from './constants.js';

const knowledgeWithTwoEntries = [
  '# Workspace Knowledge — backup-test',
  '',
  '## Known Gotchas',
  '',
  '- **2026-10-09:** the CI audit step fails on a low advisory until the lockfile is refreshed',
  '- **2026-10-09:** Windows cannot read uncommitted files safely, so freshness stays unverified',
  '',
].join('\n');

const knowledgeTemplate = [
  '# Workspace Knowledge — backup-test',
  '',
  '## Known Gotchas',
  '',
  '_(No gotchas recorded yet.)_',
  '',
].join('\n');

const authoredPlanningNotes = [
  '# Delivery plan and open questions', '',
  '## Outcomes and release order', '',
  '| Milestone ID | Outcome |', '| --- | --- |', '| m1 | Ship the first slice |', '',
].join('\n');

describe('workspace backup status', () => {
  let workspacePath: string;
  let remotePath: string;

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-backup-'));
    remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-backup-remote-'));
    await execa('git', ['init', '--bare'], { cwd: remotePath });
    await fs.writeFile(
      path.join(workspacePath, 'contextspace.json'),
      JSON.stringify({ id: 'backup-test', branchName: 'backup-test', description: 'Backup', repos: [], assistants: [] }),
    );
    await ensureWorkspaceGitRepository(workspacePath);
  });

  afterEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    await fse.remove(workspacePath);
    await fse.remove(remotePath);
  });

  const writeKnowledge = (content: string) => fs.writeFile(path.join(workspacePath, PRIMARY_KNOWLEDGE_FILE), content);

  it('has nothing at risk in a new workspace', async () => {
    const status = await describeWorkspaceBackup(workspacePath);

    expect(status).toMatchObject({ atRisk: false, summary: null, message: null, remote: { state: 'none' }, handWritten: { knowledgeEntries: 0, planningNotes: false } });
  });

  it('is at risk when knowledge has been written and there is no remote', async () => {
    await writeKnowledge(knowledgeWithTwoEntries);

    const status = await describeWorkspaceBackup(workspacePath);

    expect(status.handWritten.knowledgeEntries).toBe(2);
    expect(status.atRisk).toBe(true);
    expect(status.message).toContain('2 knowledge entries');
    expect(status.message).toContain('exist only on this computer');
    // The summary is the sentence alone; the message adds the commands that fix it.
    expect(status.summary).toBe('2 knowledge entries in this workspace exist only on this computer, because it has no git remote.');
    expect(status.summary).not.toContain('ctxspace');
    expect(status.message!.startsWith(status.summary!)).toBe(true);
    expect(status.message).toContain('`ctxspace remote add <git-url>`');
    expect(status.message).toContain('`ctxspace remote push`');
  });

  it('says "exists" for a single entry and "exist" for everything else', async () => {
    await writeKnowledge('# Workspace Knowledge — backup-test\n\n## Known Gotchas\n\n- **2026-10-09:** the only lesson so far\n');
    expect((await describeWorkspaceBackup(workspacePath)).summary).toBe('1 knowledge entry in this workspace exists only on this computer, because it has no git remote.');

    await writeKnowledge(knowledgeWithTwoEntries);
    expect((await describeWorkspaceBackup(workspacePath)).summary).toContain('2 knowledge entries in this workspace exist only');

    await writeKnowledge('# Workspace Knowledge — backup-test\n\n## Known Gotchas\n\n- **2026-10-09:** the only lesson so far\n');
    await fs.writeFile(path.join(workspacePath, PLANNING_NOTES_FILE), authoredPlanningNotes);
    expect((await describeWorkspaceBackup(workspacePath)).summary).toContain('1 knowledge entry and the planning notes in this workspace exist only');
  });

  it('is at risk when only planning notes have been written', async () => {
    await fs.writeFile(path.join(workspacePath, PLANNING_NOTES_FILE), authoredPlanningNotes);

    const status = await describeWorkspaceBackup(workspacePath);

    expect(status.handWritten).toEqual({ knowledgeEntries: 0, planningNotes: true });
    expect(status.atRisk).toBe(true);
    expect(status.message).toMatch(/^The planning notes in this workspace exist only on this computer/);
  });

  it('names both when both have been written', async () => {
    await writeKnowledge(knowledgeWithTwoEntries);
    await fs.writeFile(path.join(workspacePath, PLANNING_NOTES_FILE), authoredPlanningNotes);

    const status = await describeWorkspaceBackup(workspacePath);

    expect(status.message).toMatch(/^2 knowledge entries and the planning notes in this workspace/);
  });

  it('does not count an empty knowledge template or untouched planning notes as something to lose', async () => {
    await writeKnowledge(knowledgeTemplate);
    await ensurePlanningNotes(workspacePath, 'backup-test');

    const status = await describeWorkspaceBackup(workspacePath);

    expect(status.handWritten).toEqual({ knowledgeEntries: 0, planningNotes: false });
    expect(status.atRisk).toBe(false);
  });

  it('is no longer at risk once a remote is set, however much is written', async () => {
    await writeKnowledge(knowledgeWithTwoEntries);
    await fs.writeFile(path.join(workspacePath, PLANNING_NOTES_FILE), authoredPlanningNotes);
    await addWorkspaceRemote(workspacePath, remotePath);

    const status = await describeWorkspaceBackup(workspacePath);

    expect(status.remote).toMatchObject({ state: 'configured', name: 'origin' });
    expect(status.atRisk).toBe(false);
    expect(status.summary).toBeNull();
    expect(status.message).toBeNull();
  });

  it('only reads: it adds no remote and pushes nothing', async () => {
    await writeKnowledge(knowledgeWithTwoEntries);

    await describeWorkspaceBackup(workspacePath);

    const remotes = await execa('git', ['remote'], { cwd: workspacePath });
    expect(remotes.stdout).toBe('');
    const refs = await execa('git', ['for-each-ref'], { cwd: remotePath });
    expect(refs.stdout).toBe('');
  });

  it('never throws for a folder that is not a workspace', async () => {
    const missing = path.join(workspacePath, 'does-not-exist');

    await expect(describeWorkspaceBackup(missing)).resolves.toMatchObject({ atRisk: false, message: null });
  });
});
