import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import fse from 'fs-extra';
import { generateContextFiles } from './index.js';
import { checkGenerationLock, GENERATED_VIEW_HEADER, hashGeneratedContent } from '../core/generation-lock.js';
import { commitWorkspaceArtifacts } from '../core/workspace-git.js';
import { HARNESSES, HARNESS_IDS } from '../harnesses/registry.js';
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

    // The index for people is no longer written: the Docs panel and AGENTS.md cover it.
    expect(await fse.pathExists(path.join(tempWorkspace, 'WORKSPACE.md'))).toBe(false);

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
    const knowledgeMd = await fs.readFile(path.join(tempWorkspace, 'contextspace-knowledge.md'), 'utf-8');

    // No blank paragraph where the description would have been, and no placeholder in its place.
    expect(agentsMd).toMatch(/# no-description-feature\n\n[^\n]/);
    expect(knowledgeMd).not.toContain('## Feature Goal');
    for (const content of [agentsMd, knowledgeMd]) {
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

describe('generateContextFiles writes the instruction file each harness declares', () => {
  let workspace: string;
  const ownFiles = HARNESS_IDS.flatMap((id) => HARNESSES[id].instructions?.outputFile ?? []);
  const run = async (assistants: string[]) => {
    const ctx: WorkspaceContext = {
      feature: { id: 'instructions', branchName: 'instructions', description: 'Instruction files', repos: [], assistants: assistants as any, workspacePath: workspace, createdAt: new Date().toISOString() },
      repos: [],
    };
    await fs.writeFile(path.join(workspace, 'contextspace.json'), JSON.stringify(ctx.feature));
    await generateContextFiles(ctx, assistants, workspace);
  };
  const exists = (file: string) => fse.pathExists(path.join(workspace, file));

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-instructions-test-'));
    await execa('git', ['init'], { cwd: workspace });
    await execa('git', ['config', 'user.name', 'Test Runner'], { cwd: workspace });
    await execa('git', ['config', 'user.email', 'test@local'], { cwd: workspace });
  });

  afterEach(async () => {
    await fse.remove(workspace);
  });

  it('writes every declared file when all harnesses are chosen', async () => {
    await run([...HARNESS_IDS]);

    expect(ownFiles.sort()).toEqual(['.cursor/rules/contextspace.mdc', '.github/copilot-instructions.md', 'CLAUDE.md']);
    for (const file of ownFiles) expect(await exists(file)).toBe(true);
    expect(await exists('AGENTS.md')).toBe(true);
  });

  it('writes none for the harnesses that read AGENTS.md, Pi among them', async () => {
    await run(['pi', 'codex', 'antigravity']);

    for (const file of ownFiles) expect(await exists(file)).toBe(false);
    expect(await exists('AGENTS.md')).toBe(true);
  });

  it('ignores a name that is not a harness', async () => {
    await run(['not-a-harness']);

    for (const file of ownFiles) expect(await exists(file)).toBe(false);
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

  it('moves the notes and the plan into PLAN.md, commits it with the kept copies, and removes the old assignment file', async () => {
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
    // The notes moved into the plan, and the plan into PLAN.md; the older store is kept in the archive.
    const plan = await fs.readFile(path.join(workspace, 'PLAN.md'), 'utf8');
    expect(plan).toContain('- [ ] Decide: Which time zone?');
    expect(await exists('contextspace-plan.json')).toBe(false);
    expect(await exists('contextspace-plan.md')).toBe(false);

    const tracked = (await execa('git', ['ls-files'], { cwd: workspace })).stdout.split('\n');
    expect(tracked).toContain('PLAN.md');
    expect(tracked).not.toContain('contextspace-plan.json');
    expect(tracked.some((file) => file.startsWith('.contextspace/archive/contextspace-milestones-'))).toBe(true);
    expect(tracked.some((file) => file.startsWith('.contextspace/archive/contextspace-plan-'))).toBe(true);
    expect(tracked).not.toContain('contextspace-milestones.md');
    expect((await execa('git', ['status', '--porcelain', '--', 'contextspace-milestones.md', '.contextspace/archive', 'PLAN.md'], { cwd: workspace })).stdout).toBe('');

    const lock = JSON.parse(await fs.readFile(path.join(workspace, 'contextspace.lock'), 'utf8'));
    expect(Object.keys(lock.outputs)).not.toContain('PLAN.md');

    // A second refresh finds nothing more to move and leaves PLAN.md as it is.
    await generateContextFiles(ctx, ['claude'], workspace);
    expect(await fs.readFile(path.join(workspace, 'PLAN.md'), 'utf8')).toBe(plan);
    expect(await exists('contextspace-milestones.md')).toBe(false);
  });
});

describe('generateContextFiles retires WORKSPACE.md', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-index-test-'));
    await execa('git', ['init'], { cwd: workspace });
    await execa('git', ['config', 'user.name', 'Test Runner'], { cwd: workspace });
    await execa('git', ['config', 'user.email', 'test@local'], { cwd: workspace });
  });

  afterEach(async () => {
    await fse.remove(workspace);
  });

  it('removes an older WORKSPACE.md, commits the removal and leaves the generation lock without drift', async () => {
    const ctx: WorkspaceContext = {
      feature: { id: 'index', branchName: 'index', description: 'Drop the index', repos: [], assistants: ['claude'], workspacePath: workspace, createdAt: new Date().toISOString() },
      repos: [],
    };
    await fs.writeFile(path.join(workspace, 'contextspace.json'), JSON.stringify(ctx.feature));
    // As the older version left it: written, listed in the lock and committed with the other generated files.
    await generateContextFiles(ctx, ['claude'], workspace);
    const index = `${GENERATED_VIEW_HEADER}\n\n# Workspace: index\n`;
    await fs.writeFile(path.join(workspace, 'WORKSPACE.md'), index);
    const lockPath = path.join(workspace, 'contextspace.lock');
    const older = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    older.outputs['WORKSPACE.md'] = { hash: hashGeneratedContent(index), source: 'AGENTS.md', location: 'workspace' };
    await fs.writeFile(lockPath, JSON.stringify(older, null, 2) + '\n');
    await commitWorkspaceArtifacts(workspace, 'chore: older refresh');
    expect((await execa('git', ['ls-files'], { cwd: workspace })).stdout.split('\n')).toContain('WORKSPACE.md');
    await expect(checkGenerationLock(workspace)).resolves.toMatchObject({ fresh: true });

    await generateContextFiles(ctx, ['claude'], workspace);

    expect(await fse.pathExists(path.join(workspace, 'WORKSPACE.md'))).toBe(false);
    const tracked = (await execa('git', ['ls-files'], { cwd: workspace })).stdout.split('\n');
    expect(tracked).not.toContain('WORKSPACE.md');
    expect(tracked).toContain('AGENTS.md');
    expect((await execa('git', ['status', '--porcelain', '--', 'WORKSPACE.md'], { cwd: workspace })).stdout).toBe('');
    const removed = await execa('git', ['log', '--diff-filter=D', '--name-only', '--format=%s', '--', 'WORKSPACE.md'], { cwd: workspace });
    expect(removed.stdout).toContain('refresh workspace artifacts');
    expect(removed.stdout).toContain('WORKSPACE.md');

    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    expect(Object.keys(lock.outputs)).not.toContain('WORKSPACE.md');
    await expect(checkGenerationLock(workspace)).resolves.toMatchObject({ fresh: true, drift: [] });
  });
});
