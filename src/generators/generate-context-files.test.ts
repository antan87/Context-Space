import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import fse from 'fs-extra';
import { generateContextFiles } from './index.js';
import type { WorkspaceContext } from '../types.js';

describe('generateContextFiles with Pi harness', () => {
  let tempDir: string;
  let tempWorkspace: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-pi-test-'));
    tempWorkspace = path.join(tempDir, 'workspace');
    await fs.mkdir(tempWorkspace, { recursive: true });

    await execa('git', ['init'], { cwd: tempWorkspace });
    await execa('git', ['config', 'user.name', 'Test Runner'], { cwd: tempWorkspace });
    await execa('git', ['config', 'user.email', 'test@local'], { cwd: tempWorkspace });
  });

  afterEach(async () => {
    await fse.remove(tempDir);
  });

  it('generates context files for pi without throwing TypeError', async () => {
    const ctx: WorkspaceContext = {
      feature: {
        id: 'pi-session-feature',
        branchName: 'feat/pi-session',
        description: 'Testing workspace creation with Pi assistant',
        repos: [],
        assistants: ['pi'],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [],
    };

    await fs.writeFile(path.join(tempWorkspace, 'contextspace.json'), JSON.stringify(ctx.feature));

    await expect(generateContextFiles(ctx, ['pi'], tempWorkspace)).resolves.not.toThrow();

    const agentsMd = await fs.readFile(path.join(tempWorkspace, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('Testing workspace creation with Pi assistant');

    const workspaceMd = await fs.readFile(path.join(tempWorkspace, 'WORKSPACE.md'), 'utf-8');
    expect(workspaceMd).toContain('Testing workspace creation with Pi assistant');

    const knowledgeMd = await fs.readFile(path.join(tempWorkspace, 'contextspace-knowledge.md'), 'utf-8');
    expect(knowledgeMd).toContain('Testing workspace creation with Pi assistant');
  });

  it('writes clean context files for a workspace created without a description', async () => {
    const ctx: WorkspaceContext = {
      feature: {
        id: 'no-description-feature',
        branchName: 'no-description-feature',
        name: 'No description',
        description: '',
        repos: [],
        assistants: ['claude'],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [],
    };

    await fs.writeFile(path.join(tempWorkspace, 'contextspace.json'), JSON.stringify(ctx.feature));
    await generateContextFiles(ctx, ['claude'], tempWorkspace);

    const agentsMd = await fs.readFile(path.join(tempWorkspace, 'AGENTS.md'), 'utf-8');
    const workspaceMd = await fs.readFile(path.join(tempWorkspace, 'WORKSPACE.md'), 'utf-8');
    const knowledgeMd = await fs.readFile(path.join(tempWorkspace, 'contextspace-knowledge.md'), 'utf-8');

    // No blank paragraph where the description would have been, and no placeholder in its place.
    expect(agentsMd).toMatch(/# no-description-feature\n\n[^\n]/);
    expect(workspaceMd).toMatch(/# Workspace: no-description-feature\n\n> Assistant context lives/);
    expect(knowledgeMd).not.toContain('## Feature Goal');
    for (const content of [agentsMd, workspaceMd, knowledgeMd]) {
      expect(content).not.toContain('undefined');
    }
  });

  it('supports combining pi with other assistants like claude', async () => {
    const ctx: WorkspaceContext = {
      feature: {
        id: 'multi-assistant-feature',
        branchName: 'feat/multi',
        description: 'Multi-assistant feature with Claude and Pi',
        repos: [],
        assistants: ['claude', 'pi'],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [],
    };

    await fs.writeFile(path.join(tempWorkspace, 'contextspace.json'), JSON.stringify(ctx.feature));

    await expect(generateContextFiles(ctx, ['claude', 'pi'], tempWorkspace)).resolves.not.toThrow();

    expect(await fse.pathExists(path.join(tempWorkspace, 'CLAUDE.md'))).toBe(true);
    expect(await fse.pathExists(path.join(tempWorkspace, 'AGENTS.md'))).toBe(true);
  });
});

describe('generateContextFiles retires the old planning files', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-retire-test-'));
    await execa('git', ['init'], { cwd: workspace });
    await execa('git', ['config', 'user.name', 'Test Runner'], { cwd: workspace });
    await execa('git', ['config', 'user.email', 'test@local'], { cwd: workspace });
  });

  afterEach(async () => {
    await fse.remove(workspace);
  });

  it('moves the notes into the plan, commits the kept copy, removes the old assignment file, and keeps the summary out of the lock', async () => {
    const ctx: WorkspaceContext = {
      feature: { id: 'retire', branchName: 'retire', description: 'Retire old files', repos: [], assistants: ['claude'], workspacePath: workspace, createdAt: new Date().toISOString() },
      repos: [],
    };
    await fs.writeFile(path.join(workspace, 'contextspace.json'), JSON.stringify(ctx.feature));
    await fs.writeFile(path.join(workspace, 'contextspace-milestones.md'), [
      '## Open questions', '',
      '| ID | Question | Owner | Status (open / resolved) | Blocks | Resolution / evidence |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Q1 | Which time zone? | | open | | |', '',
    ].join('\n'));
    await fs.writeFile(path.join(workspace, 'contextspace-assignment.md'), '# Current AI assignment\n');
    // As an older version left it: the notes file committed in the workspace history.
    await execa('git', ['add', 'contextspace-milestones.md'], { cwd: workspace });
    await execa('git', ['commit', '-m', 'notes'], { cwd: workspace });

    await generateContextFiles(ctx, ['claude'], workspace);

    const exists = (file: string) => fs.access(path.join(workspace, file)).then(() => true, () => false);
    expect(await exists('contextspace-milestones.md')).toBe(false);
    expect(await exists('contextspace-assignment.md')).toBe(false);
    const plan = JSON.parse(await fs.readFile(path.join(workspace, 'contextspace-plan.json'), 'utf8'));
    expect(plan.items.map((item: { id: string; title: string }) => `${item.id} ${item.title}`)).toEqual(['Q1 Which time zone?']);
    const summary = await fs.readFile(path.join(workspace, 'contextspace-plan.md'), 'utf8');
    expect(summary).toContain('Q1 Which time zone?');
    expect(summary).not.toContain('<!--');

    const tracked = (await execa('git', ['ls-files'], { cwd: workspace })).stdout.split('\n');
    expect(tracked).toContain('contextspace-plan.json');
    expect(tracked).toContain('contextspace-plan.md');
    expect(tracked.some((file) => file.startsWith('.contextspace/archive/contextspace-milestones-'))).toBe(true);
    expect(tracked).not.toContain('contextspace-milestones.md');
    expect((await execa('git', ['status', '--porcelain', '--', 'contextspace-milestones.md', '.contextspace/archive'], { cwd: workspace })).stdout).toBe('');

    const lock = JSON.parse(await fs.readFile(path.join(workspace, 'contextspace.lock'), 'utf8'));
    expect(Object.keys(lock.outputs)).not.toContain('contextspace-plan.md');

    // A second refresh finds nothing more to move.
    await generateContextFiles(ctx, ['claude'], workspace);
    expect(JSON.parse(await fs.readFile(path.join(workspace, 'contextspace-plan.json'), 'utf8')).items).toHaveLength(1);
    expect(await exists('contextspace-milestones.md')).toBe(false);
  });
});
