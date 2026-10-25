import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import fse from 'fs-extra';

import type { AIAssistant, CodexAgentItem, SkillItem } from '../types.js';
import { previewResourceFiles, reconcileWorkspaceResources, ResourceConflictError } from './materializer.js';
import { PRIMARY_CONFIG_DIR_NAME } from '../core/constants.js';

const skill: SkillItem = {
  id: 'portable-skill',
  name: 'portable-skill',
  title: 'Portable Skill',
  category: 'general',
  description: 'Use when testing portable skill materialization.',
  content: '# Portable skill\n\nFollow the test instructions.',
  custom: false,
};

const agent: CodexAgentItem = {
  id: 'code_reviewer',
  name: 'code_reviewer',
  category: 'general',
  description: 'Use when reviewing a fixed diff.',
  developerInstructions: 'Review correctness and security.',
  sandboxMode: 'read-only',
  custom: true,
};

describe('workspace resource materializer', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-materializer-'));
  });

  afterEach(async () => {
    await fse.remove(workspace);
  });

  it('installs portable skills and Codex agents idempotently', async () => {
    const first = await reconcileWorkspaceResources(workspace, ['codex', 'claude', 'cursor', 'copilot'], [skill], [agent]);
    expect(first.installed).toContain('.agents/skills/portable-skill/SKILL.md');
    expect(first.installed).toContain('.claude/skills/portable-skill/SKILL.md');
    expect(first.installed).not.toContain('.codex/skills/portable-skill/SKILL.md');
    expect(first.installed).not.toContain('.github/skills/portable-skill/SKILL.md');
    expect(first.installed).not.toContain('.cursor/skills/portable-skill/SKILL.md');
    expect(first.installed).toContain('.codex/agents/code_reviewer.toml');
    expect(await fse.pathExists(path.join(workspace, '.agents', 'skills', 'portable-skill', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(workspace, '.claude', 'skills', 'portable-skill', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(workspace, '.codex', 'skills', 'portable-skill', 'SKILL.md'))).toBe(false);
    expect(await fse.pathExists(path.join(workspace, '.github', 'skills', 'portable-skill', 'SKILL.md'))).toBe(false);
    expect(await fse.pathExists(path.join(workspace, '.cursor', 'skills', 'portable-skill', 'SKILL.md'))).toBe(false);
    expect(await fs.readFile(path.join(workspace, '.codex', 'agents', 'code_reviewer.toml'), 'utf-8')).toContain('developer_instructions');

    const second = await reconcileWorkspaceResources(workspace, ['codex', 'claude', 'cursor', 'copilot'], [skill], [agent]);
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toHaveLength(3);
  });

  it('previews exactly the files an install writes, without writing', async () => {
    const assistants = ['codex', 'claude'] as const;
    const preview = await previewResourceFiles([...assistants], [skill], [agent]);
    expect(await fs.readdir(workspace)).toEqual([]);
    const result = await reconcileWorkspaceResources(workspace, [...assistants], [skill], [agent]);
    // `installed` lists resource ids as well as files; compare the files.
    expect(preview.map((file) => file.path).sort()).toEqual(result.installed.filter((entry) => entry.includes('/')).sort());
    expect(preview).toContainEqual({ kind: 'codex-agent', resourceId: 'code_reviewer', path: '.codex/agents/code_reviewer.toml' });
  });

  it.each([[[]], [['claude']], [['codex']], [['antigravity', 'cursor']], [['pi']]] as Array<[AIAssistant[]]>)(
    'copies a skill to both skill folders whichever assistants are chosen (%j)',
    async (assistants) => {
      const expected = ['.agents/skills/portable-skill/SKILL.md', '.claude/skills/portable-skill/SKILL.md'];
      expect((await previewResourceFiles(assistants, [skill], [])).map((file) => file.path)).toEqual(expected);

      const result = await reconcileWorkspaceResources(workspace, assistants, [skill], [agent]);

      expect(result.installed.filter((entry) => entry.includes('/'))).toEqual(
        expect.arrayContaining(expected),
      );
      for (const file of expected) expect(await fse.pathExists(path.join(workspace, file))).toBe(true);
      // Agents are Codex-only: they need Codex to be a chosen assistant.
      expect(await fse.pathExists(path.join(workspace, '.codex', 'agents', 'code_reviewer.toml'))).toBe(assistants.includes('codex'));
    },
  );

  it('gives a workspace-only skill just the Claude copy, since its source already lives in .agents/skills', async () => {
    const sourceDir = path.join(workspace, '.agents', 'skills', 'local-plan');
    await fse.ensureDir(sourceDir);
    const source = '---\nname: local-plan\ndescription: Local planning\n---\n# Local plan\n';
    await fs.writeFile(path.join(sourceDir, 'SKILL.md'), source);
    const local: SkillItem = { ...skill, id: 'local-plan', name: 'local-plan', scope: 'workspace', sourcePath: sourceDir };

    for (const assistants of [[], ['claude'], ['codex']] as AIAssistant[][]) {
      await reconcileWorkspaceResources(workspace, assistants, [local], []);
      expect(await fse.pathExists(path.join(workspace, '.claude', 'skills', 'local-plan', 'SKILL.md'))).toBe(true);
      expect(await fs.readFile(path.join(sourceDir, 'SKILL.md'), 'utf-8')).toBe(source);
    }
    expect((await previewResourceFiles([], [local], [])).map((file) => file.path)).toEqual(['.claude/skills/local-plan/SKILL.md']);
  });

  it('removes only unchanged owned packages and permits reassignment', async () => {
    await reconcileWorkspaceResources(workspace, ['codex'], [skill], [agent]);
    const result = await reconcileWorkspaceResources(workspace, ['codex'], [], []);
    expect(result.removed).toEqual(expect.arrayContaining([
      '.agents/skills/portable-skill/SKILL.md',
      '.codex/agents/code_reviewer.toml',
    ]));
    expect(await fse.pathExists(path.join(workspace, '.agents', 'skills', 'portable-skill', 'SKILL.md'))).toBe(false);
    expect(await fse.pathExists(path.join(workspace, '.agents', 'skills', 'portable-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(workspace, '.codex', 'agents', 'code_reviewer.toml'))).toBe(false);

    const reassigned = await reconcileWorkspaceResources(workspace, ['codex'], [skill], [agent]);
    expect(reassigned.installed).toEqual(expect.arrayContaining([
      '.agents/skills/portable-skill/SKILL.md',
      '.codex/agents/code_reviewer.toml',
    ]));
  });

  it('gracefully prunes legacy .codex/skills, .cursor/skills, and .github/skills projections from older locks', async () => {
    const legacyFiles = [
      path.join(workspace, '.codex', 'skills', 'portable-skill', 'SKILL.md'),
      path.join(workspace, '.github', 'skills', 'portable-skill', 'SKILL.md'),
      path.join(workspace, '.cursor', 'skills', 'portable-skill', 'SKILL.md'),
    ];
    for (const file of legacyFiles) {
      await fse.ensureDir(path.dirname(file));
      await fs.writeFile(file, '# legacy\n', 'utf-8');
    }
    const hash = createHash('sha256').update('# legacy\n').digest('hex');
    const lockPath = path.join(workspace, PRIMARY_CONFIG_DIR_NAME, 'resources.lock.json');
    await fse.ensureDir(path.dirname(lockPath));
    await fs.writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      outputs: [
        { kind: 'skill', resourceId: 'portable-skill', adapter: 'codex-skill-v1', path: '.codex/skills/portable-skill/SKILL.md', hash },
        { kind: 'skill', resourceId: 'portable-skill', adapter: 'copilot-skill-v1', path: '.github/skills/portable-skill/SKILL.md', hash },
        { kind: 'skill', resourceId: 'portable-skill', adapter: 'cursor-skill-v1', path: '.cursor/skills/portable-skill/SKILL.md', hash },
      ],
    }, null, 2), 'utf-8');

    const result = await reconcileWorkspaceResources(workspace, ['codex'], [skill], []);
    expect(result.removed).toContain('.codex/skills/portable-skill/SKILL.md');
    expect(result.removed).toContain('.github/skills/portable-skill/SKILL.md');
    expect(result.removed).toContain('.cursor/skills/portable-skill/SKILL.md');
    expect(await fse.pathExists(path.join(workspace, '.codex', 'skills', 'portable-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(workspace, '.github', 'skills', 'portable-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(workspace, '.cursor', 'skills', 'portable-skill'))).toBe(false);
    expect(result.installed).toContain('.agents/skills/portable-skill/SKILL.md');
    expect(await fse.pathExists(path.join(workspace, '.agents', 'skills', 'portable-skill', 'SKILL.md'))).toBe(true);

    const updatedLock = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    // The legacy projections are gone; the skill is owned in both current folders.
    expect(updatedLock.outputs.map((output: { adapter: string; path: string }) => [output.adapter, output.path])).toEqual([
      ['agent-skill-v1', '.agents/skills/portable-skill/SKILL.md'],
      ['claude-skill-v1', '.claude/skills/portable-skill/SKILL.md'],
    ]);
  });

  it('detects user modifications to legacy projections and aborts without mutating anything', async () => {
    const legacyFile = path.join(workspace, '.cursor', 'skills', 'portable-skill', 'SKILL.md');
    await fse.ensureDir(path.dirname(legacyFile));
    await fs.writeFile(legacyFile, '# user customized legacy skill\n', 'utf-8');
    const originalHash = createHash('sha256').update('# original legacy\n').digest('hex');
    const lockPath = path.join(workspace, PRIMARY_CONFIG_DIR_NAME, 'resources.lock.json');
    await fse.ensureDir(path.dirname(lockPath));
    await fs.writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      outputs: [
        { kind: 'skill', resourceId: 'portable-skill', adapter: 'cursor-skill-v1', path: '.cursor/skills/portable-skill/SKILL.md', hash: originalHash },
      ],
    }, null, 2), 'utf-8');

    await expect(
      reconcileWorkspaceResources(workspace, ['cursor'], [skill], []),
    ).rejects.toBeInstanceOf(ResourceConflictError);

    // Legacy file remains completely untouched
    expect(await fs.readFile(legacyFile, 'utf-8')).toBe('# user customized legacy skill\n');
    // Canonical file was NOT installed due to preflight abort
    expect(await fse.pathExists(path.join(workspace, '.agents', 'skills', 'portable-skill'))).toBe(false);
  });

  it('preserves modified managed files and reports drift before mutating anything', async () => {
    await reconcileWorkspaceResources(workspace, ['codex'], [skill], [agent]);
    const skillPath = path.join(workspace, '.agents', 'skills', 'portable-skill', 'SKILL.md');
    const agentPath = path.join(workspace, '.codex', 'agents', 'code_reviewer.toml');
    await fs.writeFile(skillPath, 'user edit', 'utf-8');

    await expect(reconcileWorkspaceResources(workspace, ['codex'], [], [])).rejects.toBeInstanceOf(ResourceConflictError);
    expect(await fs.readFile(skillPath, 'utf-8')).toBe('user edit');
    expect(await fse.pathExists(agentPath)).toBe(true);
  });

  it('restores the old target and lock when installing a staged replacement fails', async () => {
    await reconcileWorkspaceResources(workspace, ['antigravity'], [skill], []);
    const target = path.join(workspace, '.agents', 'skills', 'portable-skill', 'SKILL.md');
    const lockPath = path.join(workspace, PRIMARY_CONFIG_DIR_NAME, 'resources.lock.json');
    const beforeTarget = await fs.readFile(target, 'utf-8');
    const beforeLock = await fs.readFile(lockPath, 'utf-8');
    let renameCall = 0;

    await expect(reconcileWorkspaceResources(
      workspace,
      ['antigravity'],
      [{ ...skill, content: '# Changed\n\nNew instructions.' }],
      [],
      {
        rename: async (source, destination) => {
          renameCall += 1;
          if (renameCall === 2) throw Object.assign(new Error('injected staged rename failure'), { code: 'EACCES' });
          await fs.rename(source, destination);
        },
      },
    )).rejects.toThrow(/injected staged rename failure/i);

    expect(await fs.readFile(target, 'utf-8')).toBe(beforeTarget);
    expect(await fs.readFile(lockPath, 'utf-8')).toBe(beforeLock);
  });

  it('rejects unmanaged files added inside an owned skill package', async () => {
    await reconcileWorkspaceResources(workspace, ['codex'], [skill], []);
    const extra = path.join(workspace, '.agents', 'skills', 'portable-skill', 'scripts', 'extra.sh');
    await fse.ensureDir(path.dirname(extra));
    await fs.writeFile(extra, 'echo unmanaged', 'utf-8');

    await expect(reconcileWorkspaceResources(workspace, ['codex'], [skill], [])).rejects.toMatchObject({
      conflicts: expect.arrayContaining([expect.stringMatching(/is not owned by (ContextSpace|NexusFlow)/)]),
    });
    expect(await fs.readFile(extra, 'utf-8')).toBe('echo unmanaged');
  });

  it('rejects unmanaged collisions with zero target mutations', async () => {
    const target = path.join(workspace, '.agents', 'skills', 'portable-skill');
    await fse.ensureDir(target);
    await fs.writeFile(path.join(target, 'README.md'), 'user owned', 'utf-8');

    await expect(reconcileWorkspaceResources(workspace, ['codex'], [skill], [])).rejects.toBeInstanceOf(ResourceConflictError);
    expect(await fs.readFile(path.join(target, 'README.md'), 'utf-8')).toBe('user owned');
    expect(await fse.pathExists(path.join(target, 'SKILL.md'))).toBe(false);
    expect(await fse.pathExists(path.join(workspace, PRIMARY_CONFIG_DIR_NAME, 'resources.lock.json'))).toBe(false);
  });

  it('rejects invalid identities before writing targets', async () => {
    await expect(reconcileWorkspaceResources(
      workspace,
      ['codex'],
      [{ ...skill, id: '../../escape', name: '../../escape' }],
      [],
    )).rejects.toThrow(/invalid skill identity/i);
    expect(await fse.pathExists(path.join(workspace, 'escape'))).toBe(false);
  });

  it('normalizes legacy NexusFlow frontmatter without dropping package files', async () => {
    const source = path.join(workspace, 'source-skill');
    await fse.ensureDir(path.join(source, 'assets'));
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      '---\nname: portable-skill\ndescription: Use when testing.\ntitle: Legacy title\ncategory: general\ntags: [test]\nmetadata:\n  owner: team\n---\n\n# Instructions\n',
      'utf-8',
    );
    await fs.writeFile(path.join(source, 'assets', 'fixture.txt'), 'fixture', 'utf-8');

    await reconcileWorkspaceResources(workspace, ['codex'], [{ ...skill, sourcePath: source }], []);

    const installed = await fs.readFile(
      path.join(workspace, '.agents', 'skills', 'portable-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(installed).not.toContain('title: Legacy title');
    expect(installed).not.toContain('category: general');
    expect(installed).toContain('owner: team');
    expect(await fs.readFile(
      path.join(workspace, '.agents', 'skills', 'portable-skill', 'assets', 'fixture.txt'),
      'utf-8',
    )).toBe('fixture');
  });

  it.skipIf(process.platform === 'win32')('preserves executable script modes and detects permission drift', async () => {
    const source = path.join(workspace, 'executable-skill');
    const sourceScript = path.join(source, 'scripts', 'check.sh');
    await fse.ensureDir(path.dirname(sourceScript));
    await fs.writeFile(
      path.join(source, 'SKILL.md'),
      '---\nname: portable-skill\ndescription: Use when checking executable scripts.\n---\n\n# Check\n',
      'utf-8',
    );
    await fs.writeFile(sourceScript, '#!/bin/sh\necho ok\n', 'utf-8');
    await fs.chmod(sourceScript, 0o755);

    await reconcileWorkspaceResources(workspace, ['codex'], [{ ...skill, sourcePath: source }], []);
    const targetScript = path.join(workspace, '.agents', 'skills', 'portable-skill', 'scripts', 'check.sh');
    expect((await fs.stat(targetScript)).mode & 0o777).toBe(0o755);

    await fs.chmod(targetScript, 0o644);
    await expect(
      reconcileWorkspaceResources(workspace, ['codex'], [{ ...skill, sourcePath: source }], []),
    ).rejects.toBeInstanceOf(ResourceConflictError);
  });

  it('never trusts a tampered ownership lock to delete an arbitrary workspace file', async () => {
    await reconcileWorkspaceResources(workspace, ['codex'], [skill], []);
    const victim = path.join(workspace, 'victim.txt');
    await fs.writeFile(victim, 'keep me', 'utf-8');
    const lockPath = path.join(workspace, PRIMARY_CONFIG_DIR_NAME, 'resources.lock.json');
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf-8')) as {
      outputs: Array<{ path: string; hash: string }>;
    };
    lock.outputs[0].path = 'victim.txt';
    lock.outputs[0].hash = '6cc7d5a6f9f85c209a8e18e5426de33f0db1df6d2a223c90a4a4e0e08e64b341';
    await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');

    await expect(reconcileWorkspaceResources(workspace, ['codex'], [], [])).rejects.toThrow(
      /invalid workspace resource ownership path/i,
    );
    expect(await fs.readFile(victim, 'utf-8')).toBe('keep me');
  });
});
