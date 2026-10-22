import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import fse from 'fs-extra';

import { generateSkills } from './skills-generator.js';
import {
  getAllSkills,
  saveWorkspaceSkillsConfig,
  saveSkill,
  saveSkillCategory,
} from '../utils/skills-catalog.js';
import type { WorkspaceContext, ProjectAnalysis, AIAssistant } from '../types.js';
import { PRIMARY_CONFIG_DIR_NAME } from '../core/constants.js';
import { resolveResourceLockPath } from '../resources/materializer.js';

describe('skills-generator', () => {
  let tempWorkspace: string;
  let tempHome: string;
  const originalEnv = process.env.NEXUSFLOW_HOME;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-gen-skills-ws-'));
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-gen-skills-home-'));
    process.env.NEXUSFLOW_HOME = tempHome;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.NEXUSFLOW_HOME = originalEnv;
    } else {
      delete process.env.NEXUSFLOW_HOME;
    }
    await fse.remove(tempWorkspace);
    await fse.remove(tempHome);
  });

  it('deploys enabled skills across claude, antigravity, cursor, copilot, and codex', async () => {
    await saveSkill({
      name: 'pr-review-toolkit',
      title: 'Pull Request Review Toolkit',
      category: 'pull-requests',
      description: 'Reviews pull requests',
      content: '# PR Review',
    });
    await saveSkill({
      name: 'verifier-workspace',
      title: 'Local Runtime Verifier',
      category: 'testing-qa',
      description: 'Local runtime verifier',
      content: '# Verifier',
    });

    // Enable 2 specific skills
    await saveWorkspaceSkillsConfig(tempWorkspace, {
      enabledSkills: ['pr-review-toolkit', 'verifier-workspace'],
    });

    const ctx: WorkspaceContext = {
      feature: {
        id: 'test-feature',
        branchName: 'feature-test',
        description: 'Testing skills generation',
        repos: [],
        assistants: ['claude', 'antigravity', 'cursor', 'copilot', 'codex'],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [],
    };

    const assistants: AIAssistant[] = ['claude', 'antigravity', 'cursor', 'copilot', 'codex'];
    await generateSkills(ctx, assistants, tempWorkspace);

    // 1. Claude: .claude/skills/<skillName>/SKILL.md
    expect(await fse.pathExists(path.join(tempWorkspace, '.claude', 'skills', 'pr-review-toolkit', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(tempWorkspace, '.claude', 'skills', 'verifier-workspace', 'SKILL.md'))).toBe(true);

    // 2. Canonical Agent Skills: .agents/skills/<skillName>/SKILL.md (for Antigravity, Codex, Cursor, Copilot)
    expect(await fse.pathExists(path.join(tempWorkspace, '.agents', 'skills', 'pr-review-toolkit', 'SKILL.md'))).toBe(true);

    // 3. Redundant projections eliminated: Codex, Copilot, Cursor read .agents/skills/ natively
    expect(await fse.pathExists(path.join(tempWorkspace, '.codex', 'skills', 'pr-review-toolkit', 'SKILL.md'))).toBe(false);
    expect(await fse.pathExists(path.join(tempWorkspace, '.github', 'skills', 'pr-review-toolkit', 'SKILL.md'))).toBe(false);
    expect(await fse.pathExists(path.join(tempWorkspace, '.cursor', 'skills', 'pr-review-toolkit', 'SKILL.md'))).toBe(false);

    // No lossy rules/instructions copies
    expect(await fse.pathExists(path.join(tempWorkspace, '.cursor', 'rules', 'pr-review-toolkit.mdc'))).toBe(false);
    expect(await fse.pathExists(path.join(tempWorkspace, '.github', 'instructions', 'pr-review-toolkit.instructions.md'))).toBe(false);
    expect(await fse.pathExists(path.join(tempWorkspace, PRIMARY_CONFIG_DIR_NAME, 'resources.lock.json'))).toBe(true);
  });

  it('honors explicit local-skill deselection without removing authored source files', async () => {
    const local = path.join(tempWorkspace, '.agents/skills/local-plan/SKILL.md');
    await fs.mkdir(path.dirname(local), { recursive: true });
    const content = '---\nname: local-plan\ndescription: Local planning\n---\n# Local plan\n';
    await fs.writeFile(local, content);
    const ctx: WorkspaceContext = { feature: { id: 'local', branchName: 'local', description: '', repos: [], assistants: ['claude'], workspacePath: tempWorkspace, createdAt: '' }, repos: [] };
    await saveWorkspaceSkillsConfig(tempWorkspace, { enabledSkills: ['local-plan'] });
    await generateSkills(ctx, ['claude'], tempWorkspace);
    const mirror = path.join(tempWorkspace, '.claude/skills/local-plan/SKILL.md');
    expect(await fse.pathExists(mirror)).toBe(true);
    await saveWorkspaceSkillsConfig(tempWorkspace, { enabledSkills: [] });
    await generateSkills(ctx, ['claude'], tempWorkspace);
    expect(await fse.pathExists(mirror)).toBe(false);
    expect(await fs.readFile(local, 'utf8')).toBe(content);
    await generateSkills(ctx, ['claude'], tempWorkspace);
    expect(await fse.pathExists(mirror)).toBe(false);
  });

  it('respects empty enabledSkills array and deploys nothing when all are disabled', async () => {
    await saveWorkspaceSkillsConfig(tempWorkspace, {
      enabledSkills: [],
    });

    const ctx: WorkspaceContext = {
      feature: {
        id: 'test-feature',
        branchName: 'feature-test',
        description: 'Testing empty skills generation',
        repos: [],
        assistants: ['claude', 'antigravity'],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [],
    };

    await generateSkills(ctx, ['claude', 'antigravity'], tempWorkspace);

    expect(await fse.pathExists(path.join(tempWorkspace, '.claude', 'skills', 'pr-review-toolkit'))).toBe(false);
    expect(await fse.pathExists(path.join(tempWorkspace, '.agents', 'skills', 'pr-review-toolkit'))).toBe(false);
  });

  it('auto-deploys dynamically inferred skills in default workspace', async () => {
    // Fresh workspace without custom config
    const mockAnalysis = new Map<string, ProjectAnalysis>();
    mockAnalysis.set('service-a', {
      name: 'service-a',
      path: path.join(tempWorkspace, 'service-a'),
      techStack: { languages: ['typescript'], frameworks: [], buildTools: [], projectType: 'backend' },
      dependencies: [{ name: 'shared-pkg', type: 'npm', version: '^1.0.0' }],
      ports: [],
      readmeSummary: 'Service A',
      existingAIConfigs: [],
      runConfig: {
        entryPoints: [{ projectPath: 'service-a', type: 'npm', command: 'npm start', port: 8080 }],
        databases: [],
        sharedInfraWarnings: [],
        committedSecrets: [],
        externalDependencies: [],
      },
    });
    mockAnalysis.set('lib-pkg', {
      name: 'lib-pkg',
      path: path.join(tempWorkspace, 'lib-pkg'),
      techStack: { languages: ['typescript'], frameworks: [], buildTools: [], projectType: 'library' },
      dependencies: [],
      ports: [],
      readmeSummary: 'Library',
      existingAIConfigs: [],
      produces: [{ name: 'shared-pkg', type: 'npm', version: '1.0.0' }],
    });

    const ctx: WorkspaceContext = {
      feature: {
        id: 'test-dynamic-skills',
        branchName: 'feature-test',
        description: 'Testing dynamic skills generation',
        repos: [],
        assistants: ['antigravity', 'claude'],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [
        { name: 'service-a', path: path.join(tempWorkspace, 'service-a'), defaultBranch: 'main' },
        { name: 'lib-pkg', path: path.join(tempWorkspace, 'lib-pkg'), defaultBranch: 'main' },
      ],
      analysis: mockAnalysis,
    };

    await generateSkills(ctx, ['antigravity', 'claude'], tempWorkspace);

    // Both package loop and verifier should be deployed automatically in fresh workspace
    expect(await fse.pathExists(path.join(tempWorkspace, '.agents', 'skills', 'nexusflow-local-package-loop', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(tempWorkspace, '.agents', 'skills', 'verifier-workspace', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(tempWorkspace, '.claude', 'skills', 'nexusflow-local-package-loop', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(tempWorkspace, '.claude', 'skills', 'verifier-workspace', 'SKILL.md'))).toBe(true);
  });

  it('respects explicit opt-out / disable: disable -> save -> refresh does not redeploy', async () => {
    // User explicitly disabled verifier-workspace and package loop
    await saveWorkspaceSkillsConfig(tempWorkspace, {
      enabledSkills: [],
      disabledSkills: ['verifier-workspace', 'nexusflow-local-package-loop'],
    });

    const mockAnalysis = new Map<string, ProjectAnalysis>();
    mockAnalysis.set('service-a', {
      name: 'service-a',
      path: path.join(tempWorkspace, 'service-a'),
      techStack: { languages: ['typescript'], frameworks: [], buildTools: [], projectType: 'backend' },
      dependencies: [{ name: 'shared-pkg', type: 'npm', version: '^1.0.0' }],
      ports: [],
      readmeSummary: 'Service A',
      existingAIConfigs: [],
      runConfig: {
        entryPoints: [{ projectPath: 'service-a', type: 'npm', command: 'npm start', port: 8080 }],
        databases: [],
        sharedInfraWarnings: [],
        committedSecrets: [],
        externalDependencies: [],
      },
    });

    const ctx: WorkspaceContext = {
      feature: {
        id: 'test-disabled-skills',
        branchName: 'feature-test',
        description: 'Testing disabled skills',
        repos: [],
        assistants: ['antigravity', 'claude'],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [
        { name: 'service-a', path: path.join(tempWorkspace, 'service-a'), defaultBranch: 'main' },
      ],
      analysis: mockAnalysis,
    };

    // Run skill generation (refresh)
    await generateSkills(ctx, ['antigravity', 'claude'], tempWorkspace);

    // Disabled skills must NOT be deployed
    expect(await fse.pathExists(path.join(tempWorkspace, '.agents', 'skills', 'verifier-workspace'))).toBe(false);
    expect(await fse.pathExists(path.join(tempWorkspace, '.claude', 'skills', 'verifier-workspace'))).toBe(false);
    expect(await fse.pathExists(path.join(tempWorkspace, '.agents', 'skills', 'nexusflow-local-package-loop'))).toBe(false);
  });

  it('auto-deploys the skills of a subscribed category', async () => {
    await saveSkillCategory({
      id: 'pull-requests',
      name: 'Pull Requests & Review',
      description: 'PR workflows',
      skills: ['pr-review-toolkit'],
    });
    await saveSkill({
      name: 'pr-review-toolkit',
      title: 'Pull Request Review Toolkit',
      category: 'pull-requests',
      description: 'Reviews pull requests',
      content: '# PR Review',
    });

    // Workspace subscribed to the 'pull-requests' category
    await saveWorkspaceSkillsConfig(tempWorkspace, {
      enabledSkills: [],
      enabledCategories: ['pull-requests'],
    });

    const ctx: WorkspaceContext = {
      feature: {
        id: 'test-category-skills',
        branchName: 'feature-pr',
        description: 'Review PR feature',
        repos: [],
        assistants: ['antigravity'],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [],
    };

    await generateSkills(ctx, ['antigravity'], tempWorkspace);

    // pr-review-toolkit names the pull-requests category, so it is deployed
    expect(
      await fse.pathExists(
        path.join(tempWorkspace, '.agents', 'skills', 'pr-review-toolkit', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('copies enabled skills to both skill folders when the workspace has no assistant', async () => {
    await saveSkill({
      name: 'pr-review-toolkit',
      title: 'Pull Request Review Toolkit',
      category: 'pull-requests',
      description: 'Reviews pull requests',
      content: '# PR Review',
    });
    await saveWorkspaceSkillsConfig(tempWorkspace, { enabledSkills: ['pr-review-toolkit'] });

    const ctx: WorkspaceContext = {
      feature: {
        id: 'no-assistant',
        branchName: 'feature-test',
        description: 'Workspace created without choosing an assistant',
        repos: [],
        assistants: [],
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [],
    };

    await generateSkills(ctx, [], tempWorkspace);

    expect(await fse.pathExists(path.join(tempWorkspace, '.agents', 'skills', 'pr-review-toolkit', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(tempWorkspace, '.claude', 'skills', 'pr-review-toolkit', 'SKILL.md'))).toBe(true);
    // No harness was chosen, so nothing Codex-only is written.
    expect(await fse.pathExists(path.join(tempWorkspace, '.codex', 'agents'))).toBe(false);

    const lock = (await fse.readJson(await resolveResourceLockPath(tempWorkspace))) as {
      outputs: Array<{ path: string; resourceId: string }>;
    };
    const owned = lock.outputs.filter((output) => output.resourceId === 'pr-review-toolkit').map((output) => output.path);
    expect(owned).toEqual(
      expect.arrayContaining([
        '.agents/skills/pr-review-toolkit/SKILL.md',
        '.claude/skills/pr-review-toolkit/SKILL.md',
      ]),
    );
  });
  describe('skills chosen by category', () => {
    const feature = (assistants: AIAssistant[]): WorkspaceContext => ({
      feature: {
        id: 'by-category',
        branchName: 'feature-category',
        description: 'Skills by category',
        repos: [],
        assistants,
        workspacePath: tempWorkspace,
        createdAt: new Date().toISOString(),
      },
      repos: [],
    });
    const addSkill = (name: string, category: string) =>
      saveSkill({ name, title: name, category, description: `About ${name}`, content: `# ${name}` });
    const installed = (folder: string, id: string) =>
      fse.pathExists(path.join(tempWorkspace, folder, 'skills', id, 'SKILL.md'));

    it('picks up a skill added to the category after the workspace subscribed', async () => {
      await addSkill('review-pr', 'pull-requests');
      await saveWorkspaceSkillsConfig(tempWorkspace, { enabledSkills: [], enabledCategories: ['pull-requests'] });
      await generateSkills(feature(['claude']), ['claude'], tempWorkspace);
      expect(await installed('.claude', 'review-pr')).toBe(true);

      await addSkill('merge-helper', 'pull-requests');
      await generateSkills(feature(['claude']), ['claude'], tempWorkspace);

      expect(await installed('.claude', 'merge-helper')).toBe(true);
      expect(await installed('.agents', 'merge-helper')).toBe(true);
    });

    it('leaves out a skill switched off inside a subscribed category and removes its copies', async () => {
      await addSkill('review-pr', 'pull-requests');
      await addSkill('write-description', 'pull-requests');
      await saveWorkspaceSkillsConfig(tempWorkspace, { enabledSkills: [], enabledCategories: ['pull-requests'] });
      await generateSkills(feature(['claude']), ['claude'], tempWorkspace);
      expect(await installed('.claude', 'write-description')).toBe(true);

      await saveWorkspaceSkillsConfig(tempWorkspace, {
        enabledSkills: [],
        enabledCategories: ['pull-requests'],
        disabledSkills: ['write-description'],
      });
      await generateSkills(feature(['claude']), ['claude'], tempWorkspace);

      expect(await installed('.claude', 'review-pr')).toBe(true);
      expect(await installed('.claude', 'write-description')).toBe(false);
      expect(await installed('.agents', 'write-description')).toBe(false);
    });

    it('adds a single pick from outside the subscribed categories', async () => {
      await addSkill('review-pr', 'pull-requests');
      await addSkill('standup', 'notes');
      await saveWorkspaceSkillsConfig(tempWorkspace, {
        enabledSkills: ['standup'],
        enabledCategories: ['pull-requests'],
      });

      await generateSkills(feature(['codex']), ['codex'], tempWorkspace);

      expect(await installed('.agents', 'review-pr')).toBe(true);
      expect(await installed('.agents', 'standup')).toBe(true);
    });

    it('does not let the skills list in a category file switch skills on', async () => {
      await saveSkillCategory({ id: 'pull-requests', name: 'Pull Requests', skills: ['standup'] });
      await addSkill('review-pr', 'pull-requests');
      await addSkill('standup', 'notes');
      await saveWorkspaceSkillsConfig(tempWorkspace, { enabledSkills: [], enabledCategories: ['pull-requests'] });

      await generateSkills(feature(['claude']), ['claude'], tempWorkspace);

      expect(await installed('.claude', 'review-pr')).toBe(true);
      expect(await installed('.claude', 'standup')).toBe(false);
    });

    it('ignores the categories a version 1 skills file lists', async () => {
      await addSkill('review-pr', 'pull-requests');
      const configDir = path.join(tempWorkspace, PRIMARY_CONFIG_DIR_NAME);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'skills.json'),
        JSON.stringify({ schemaVersion: 1, revision: 2, enabledSkills: [], enabledAgents: [], enabledCategories: ['pull-requests'] }),
      );

      await generateSkills(feature(['claude']), ['claude'], tempWorkspace);

      expect(await installed('.claude', 'review-pr')).toBe(false);
    });

    it.each([[['claude']], [['codex']], [['cursor', 'copilot']]] as Array<[AIAssistant[]]>)(
      'copies a skill to both skill folders whichever assistants are chosen (%j)',
      async (assistants) => {
        await addSkill('review-pr', 'pull-requests');
        await saveWorkspaceSkillsConfig(tempWorkspace, { enabledSkills: ['review-pr'] });

        await generateSkills(feature(assistants), assistants, tempWorkspace);

        expect(await installed('.agents', 'review-pr')).toBe(true);
        expect(await installed('.claude', 'review-pr')).toBe(true);
      },
    );

    it('never copies a skill a harness ships, even when an old config picks it or its category is subscribed', async () => {
      const savedEnv = { nexusflow: process.env.NEXUSFLOW_HOME, home: process.env.HOME, userProfile: process.env.USERPROFILE };
      // Harness folders are only read in a real home, so stand one up.
      const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-gen-skills-real-home-')));
      try {
        await fs.mkdir(path.join(home, '.claude', 'skills', 'pdf'), { recursive: true });
        await fs.writeFile(
          path.join(home, '.claude', 'skills', 'pdf', 'SKILL.md'),
          '---\nname: pdf\ndescription: From Claude\ncategory: documents\n---\n# PDF\n',
        );
        delete process.env.NEXUSFLOW_HOME;
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        await addSkill('review-pr', 'documents');
        expect((await getAllSkills()).find((skill) => skill.id === 'pdf')?.source?.harness).toBe('claude');
        await saveWorkspaceSkillsConfig(tempWorkspace, {
          enabledSkills: ['pdf'],
          enabledCategories: ['documents'],
        });

        await generateSkills(feature(['claude']), ['claude'], tempWorkspace);

        expect(await installed('.claude', 'review-pr')).toBe(true);
        expect(await installed('.claude', 'pdf')).toBe(false);
        expect(await installed('.agents', 'pdf')).toBe(false);
      } finally {
        if (savedEnv.nexusflow === undefined) delete process.env.NEXUSFLOW_HOME;
        else process.env.NEXUSFLOW_HOME = savedEnv.nexusflow;
        if (savedEnv.home === undefined) delete process.env.HOME;
        else process.env.HOME = savedEnv.home;
        if (savedEnv.userProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = savedEnv.userProfile;
        await fse.remove(home);
      }
    });

    it('still refuses a picked skill that has left the library', async () => {
      await saveWorkspaceSkillsConfig(tempWorkspace, { enabledSkills: ['deleted-skill'] });
      await expect(generateSkills(feature(['claude']), ['claude'], tempWorkspace)).rejects.toThrow(
        'Selected skills are no longer available: deleted-skill',
      );
    });
  });
});
