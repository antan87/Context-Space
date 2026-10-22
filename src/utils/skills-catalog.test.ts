import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import fse from 'fs-extra';

import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  getSkillCategories,
  saveSkillCategory,
  deleteSkillCategory,
  getAllSkills,
  saveSkill,
  deleteSkill,
  getWorkspaceSkillsConfig,
  saveWorkspaceSkillsConfig,
  importHarnessSkill,
  listInstalledSkillIds,
  SkillImportError,
  DEFAULT_CATEGORIES,
  DEFAULT_SKILLS,
} from './skills-catalog.js';
import { PRIMARY_CONFIG_DIR_NAME } from '../core/constants.js';

describe('Skills Catalog & Frontmatter Utils', () => {
  let tempHome: string;
  const originalEnv = process.env.NEXUSFLOW_HOME;
  const originalCsEnv = process.env.CONTEXTSPACE_HOME;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-skills-test-home-'));
    process.env.NEXUSFLOW_HOME = tempHome;
    delete process.env.CONTEXTSPACE_HOME;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.NEXUSFLOW_HOME = originalEnv;
    } else {
      delete process.env.NEXUSFLOW_HOME;
    }
    if (originalCsEnv !== undefined) {
      process.env.CONTEXTSPACE_HOME = originalCsEnv;
    } else {
      delete process.env.CONTEXTSPACE_HOME;
    }
    await fse.remove(tempHome);
  });



  it('returns a JSON-serializable save result for API responses', async () => {
    const saved = await saveSkill({ name: 'serializable', description: 'Probe', content: '# Probe' });
    const response = JSON.parse(JSON.stringify({ success: true, skill: saved }));
    expect(response.skill.id).toBe('serializable');
    expect(response.skill.skill.id).toBe('serializable');
    expect(await fs.readFile(saved.path, 'utf8')).toContain('# Probe');
  });

  it.each(['.agents', '.agents/skills'])('rejects workspace writes and deletes through linked %s', async (linked) => {
    const workspace = path.join(tempHome, 'workspace');
    const outside = path.join(tempHome, 'outside');
    const linkPath = path.join(workspace, linked);
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(outside, linked === '.agents' ? 'skills' : '', 'probe');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), 'original');
    await expect(saveSkill({ name: 'probe', description: 'Probe', content: '# Changed' }, {
      scope: 'workspace', workspacePath: workspace,
    })).rejects.toThrow(/Linked/);
    await expect(deleteSkill('probe', { scope: 'workspace', workspacePath: workspace })).rejects.toThrow(/Linked/);
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('original');
  });

  describe('parseSkillMarkdown & serializeSkillMarkdown', () => {
    it('should parse simple frontmatter, CRLF line endings, and markdown body', () => {
      const raw = `---\r\nname: test-skill\r\ntitle: Test Skill\r\ncategory: pull-requests\r\ndescription: "A test skill for testing."\r\ntags:\r\n  - git\r\n  - test\r\nallowed-tools:\r\n  - run_command\r\n  - view_file\r\n---\r\n\r\n# Test Playbook\r\n\r\nSome instructions here.`;

      const { metadata, content } = parseSkillMarkdown(raw);
      expect(metadata.name).toBe('test-skill');
      expect(metadata.title).toBe('Test Skill');
      expect(metadata.category).toBe('pull-requests');
      expect(metadata.description).toBe('A test skill for testing.');
      expect(metadata.tags).toEqual(['git', 'test']);
      expect(metadata['allowed-tools']).toEqual(['run_command', 'view_file']);
      expect(content).toContain('# Test Playbook');
      expect(content).toContain('Some instructions here.');
    });

    it('should serialize metadata with objects/parameters and markdown body into valid frontmatter markdown', () => {
      const metadata = {
        name: 'custom-skill',
        title: 'Custom Skill',
        category: 'custom-category',
        description: 'Testing multiline\ndescription with "quotes"',
        tags: ['alpha', 'beta'],
        parameters: [
          { name: 'target_env', type: 'string', default: 'staging' },
        ],
      };
      const content = '# Custom Playbook\n\nSteps to follow.';

      const output = serializeSkillMarkdown(metadata, content);
      expect(output).toContain('name: custom-skill');
      expect(output).toContain('title: Custom Skill');
      expect(output).toContain('category: custom-category');
      expect(output).toContain('# Custom Playbook');

      // Roundtrip verification
      const parsed = parseSkillMarkdown(output);
      expect(parsed.metadata.name).toBe('custom-skill');
      expect(parsed.metadata.title).toBe('Custom Skill');
      expect(parsed.metadata.category).toBe('custom-category');
      expect(parsed.metadata.tags).toEqual(['alpha', 'beta']);
      expect(parsed.metadata.parameters).toEqual([
        { name: 'target_env', type: 'string', default: 'staging' },
      ]);
      expect(parsed.content).toContain('# Custom Playbook');
    });
  });

  describe('Categories Management', () => {
    it('should start with an empty category list when no custom categories exist', async () => {
      const categories = await getSkillCategories();
      expect(categories).toEqual([]);
      expect(categories.length).toBe(0);
      expect(DEFAULT_CATEGORIES.length).toBe(0);
    });

    it('should create, save, and delete a new user custom category', async () => {
      const newCat = await saveSkillCategory({
        name: 'DevOps & Cloud',
        description: 'Kubernetes, Terraform, and Docker workflows',
        icon: 'zap',
        color: '#10b981',
      });

      expect(newCat.id).toBe('devops-cloud');
      expect(newCat.name).toBe('DevOps & Cloud');
      expect(newCat.custom).toBe(true);

      const all = await getSkillCategories();
      const found = all.find((c) => c.id === 'devops-cloud');
      expect(found).toBeDefined();
      expect(found?.description).toBe('Kubernetes, Terraform, and Docker workflows');

      // Clean up
      await deleteSkillCategory('devops-cloud');
      const afterDelete = await getSkillCategories();
      expect(afterDelete.find((c) => c.id === 'devops-cloud')).toBeUndefined();
    });

    it('should create a custom category and delete it completely', async () => {
      const created = await saveSkillCategory({
        id: 'team-workflows',
        name: 'Team Workflows',
        description: 'Company-specific team workflows',
      });
      expect(created.name).toBe('Team Workflows');

      let current = await getSkillCategories();
      expect(current.find((c) => c.id === 'team-workflows')?.name).toBe('Team Workflows');

      await deleteSkillCategory('team-workflows');
      current = await getSkillCategories();
      expect(current.find((c) => c.id === 'team-workflows')).toBeUndefined();
    });

    it('should reject deleting non-existent categories', async () => {
      await expect(deleteSkillCategory('non-existent-category')).rejects.toThrow(
        /Category not found/i,
      );
    });
  });

  describe('Skills Management', () => {
    it('should start with an empty skill catalog when no custom skills are saved', async () => {
      const skills = await getAllSkills();
      expect(skills).toEqual([]);
      expect(skills.length).toBe(0);
      expect(DEFAULT_SKILLS.length).toBe(0);
    });

    it('should save and delete a custom skill package with references and scripts', async () => {
      const customSkill = await saveSkill({
        name: 'unit-test-generator',
        title: 'Unit Test Generator',
        category: 'testing-qa',
        description: 'Auto-generates unit tests with mocks',
        tags: ['test', 'generator'],
        content: '# Unit Test Generator\n\nGenerate tests with Vitest.',
        references: [{ name: 'checklist.md', relativePath: 'references/checklist.md', content: '# Checklist' }],
        scripts: [{ name: 'gen.sh', relativePath: 'scripts/gen.sh', content: '#!/bin/bash\necho "generating"' }],
      });

      expect(customSkill.id).toBe('unit-test-generator');
      expect(customSkill.custom).toBe(true);

      const all = await getAllSkills();
      const found = all.find((s) => s.id === 'unit-test-generator');
      expect(found).toBeDefined();
      expect(found?.title).toBe('Unit Test Generator');
      expect(found?.references?.length).toBe(1);
      expect(found?.scripts?.length).toBe(1);

      // Clean up
      await deleteSkill('unit-test-generator');
      const afterDelete = await getAllSkills();
      expect(afterDelete.find((s) => s.id === 'unit-test-generator')).toBeUndefined();
    });

    it('should reject path traversal in skill ID and references', async () => {
      await expect(
        saveSkill({
          name: '../../evil-skill',
          content: 'evil',
        }),
      ).rejects.toThrow();

      await expect(deleteSkill('../../evil-skill')).rejects.toThrow();
    });

    it('saves and deletes a custom skill with standard identity', async () => {
      const saved = await saveSkill({
        name: 'pr-review-toolkit',
        description: 'Custom review toolkit.',
        content: '# Review Toolkit',
      });
      expect(saved.id).toBe('pr-review-toolkit');
      expect(saved.custom).toBe(true);
      expect(await fse.pathExists(path.join(tempHome, 'skills', 'pr-review-toolkit'))).toBe(true);

      await deleteSkill('pr-review-toolkit');
      expect(await fse.pathExists(path.join(tempHome, 'skills', 'pr-review-toolkit'))).toBe(false);
    });

    it('rejects mismatched skill identities', async () => {
      await expect(saveSkill({
        id: 'stable-id',
        name: 'different-name',
        description: 'Mismatched identity.',
        content: '# Mismatch',
      })).rejects.toThrow(/id and name must match/i);
      expect(await fse.pathExists(path.join(tempHome, 'skills', 'stable-id'))).toBe(false);
    });

    it('rejects persisted metadata identities that do not match their directory', async () => {
      const skillDir = path.join(tempHome, 'skills', 'safe-directory');
      await fse.ensureDir(skillDir);
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: ../../outside\ndescription: malicious\n---\n\nDo something.\n',
        'utf-8',
      );

      const skills = await getAllSkills();
      expect(skills.some((skill) => skill.sourcePath === skillDir)).toBe(false);
      expect(await fse.pathExists(path.join(tempHome, 'outside'))).toBe(false);
    });

    it('preserves support folders on metadata edits and removes them only when explicitly cleared', async () => {
      await saveSkill({
        name: 'snapshot-skill',
        description: 'Initial snapshot.',
        content: '# Initial',
        scripts: [{ name: 'old.sh', relativePath: 'scripts/old.sh', content: 'echo old' }],
      });
      await saveSkill({
        name: 'snapshot-skill',
        description: 'Updated snapshot.',
        content: '# Updated',
      });

      expect(await fs.readFile(path.join(tempHome, 'skills', 'snapshot-skill', 'scripts', 'old.sh'), 'utf-8')).toBe('echo old');

      await saveSkill({
        name: 'snapshot-skill',
        description: 'Updated snapshot.',
        content: '# Updated',
        scripts: [],
      });

      expect(await fse.pathExists(path.join(tempHome, 'skills', 'snapshot-skill', 'scripts', 'old.sh'))).toBe(false);
    });

    it('preserves portable frontmatter owned by other tools during edits', async () => {
      const skillDir = path.join(tempHome, 'skills', 'portable-metadata');
      await fse.ensureDir(skillDir);
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: portable-metadata\ndescription: Original trigger.\nlicense: Apache-2.0\ncompatibility: Requires git.\nmetadata:\n  owner: platform-team\n  nexusflow:\n    custom-field: keep\n---\n\n# Original\n',
        'utf-8',
      );
      const existing = (await getAllSkills()).find((item) => item.id === 'portable-metadata');
      expect(existing).toBeDefined();

      await saveSkill({
        id: existing!.id,
        name: existing!.name,
        title: 'Updated title',
        category: 'general',
        description: 'Updated trigger.',
        content: '# Updated',
      });

      const written = parseSkillMarkdown(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8'));
      expect(written.metadata).toMatchObject({
        license: 'Apache-2.0',
        compatibility: 'Requires git.',
        metadata: {
          owner: 'platform-team',
          nexusflow: { 'custom-field': 'keep', title: 'Updated title' },
        },
      });
    });

    it('supports assets directory and Agent Skills standard metadata fallbacks', async () => {
      const skillWithAssets = await saveSkill({
        name: 'pdf-archiver',
        description: 'Extract and archive PDF documents.',
        license: 'MIT',
        compatibility: 'Requires pdftotext CLI',
        content: '# PDF Archiver\n\nArchive PDF docs.',
        metadata: {
          tags: ['pdf', 'archive'],
          category: 'documents',
          title: 'PDF Archiving Standard',
        },
        assets: [{ name: 'template.json', relativePath: 'assets/template.json', content: '{"version": 1}' }],
      });

      expect(skillWithAssets.id).toBe('pdf-archiver');
      expect(skillWithAssets.assets).toBeDefined();
      expect(skillWithAssets.assets?.length).toBe(1);
      expect(skillWithAssets.assets?.[0].name).toBe('template.json');

      const all = await getAllSkills();
      const loaded = all.find((s) => s.id === 'pdf-archiver');
      expect(loaded).toBeDefined();
      expect(loaded?.title).toBe('PDF Archiving Standard');
      expect(loaded?.category).toBe('documents');
      expect(loaded?.tags).toEqual(['pdf', 'archive']);
      expect(loaded?.assets?.length).toBe(1);

      await deleteSkill('pdf-archiver');
    });
  });

  describe('Workspace Skills Config', () => {
    it('should load an empty workspace configuration when file does not exist', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        const config = await getWorkspaceSkillsConfig(tempDir);
        expect(config.enabledSkills).toEqual([]);
        expect(config.enabledAgents).toEqual([]);
        expect(config.revision).toBe(0);
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('should save and load workspace skill assignments', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        await saveWorkspaceSkillsConfig(tempDir, {
          enabledSkills: ['pr-review-toolkit', 'verifier-workspace'],
          enabledAgents: ['docs_researcher'],
          enabledCategories: ['pull-requests', 'testing-qa'],
        });

        const loaded = await getWorkspaceSkillsConfig(tempDir);
        expect(loaded.enabledSkills).toEqual(['pr-review-toolkit', 'verifier-workspace']);
        expect(loaded.enabledAgents).toEqual(['docs_researcher']);
        expect(loaded.enabledCategories).toEqual(['pull-requests', 'testing-qa']);
        expect(loaded.revision).toBe(1);
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('writes version 2 on every save and keeps the subscribed categories', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        const saved = await saveWorkspaceSkillsConfig(tempDir, {
          enabledSkills: ['standup'],
          enabledCategories: ['pull-requests'],
        });
        expect(saved.schemaVersion).toBe(2);
        const onDisk = await fse.readJson(path.join(tempDir, PRIMARY_CONFIG_DIR_NAME, 'skills.json'));
        expect(onDisk).toMatchObject({ schemaVersion: 2, revision: 1, enabledCategories: ['pull-requests'] });
        expect((await getWorkspaceSkillsConfig(tempDir)).enabledCategories).toEqual(['pull-requests']);

        const second = await saveWorkspaceSkillsConfig(tempDir, { enabledSkills: [], enabledCategories: ['pull-requests', 'notes'] });
        expect(second.schemaVersion).toBe(2);
        expect((await getWorkspaceSkillsConfig(tempDir)).enabledCategories).toEqual(['pull-requests', 'notes']);
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('saves the skills switched off when they are given, and clears them when given empty', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        await saveWorkspaceSkillsConfig(tempDir, {
          enabledSkills: [],
          enabledCategories: ['pull-requests'],
          disabledSkills: ['write-description'],
        });
        expect((await getWorkspaceSkillsConfig(tempDir)).disabledSkills).toEqual(['write-description']);

        await saveWorkspaceSkillsConfig(tempDir, { enabledSkills: [], enabledCategories: ['pull-requests'], disabledSkills: [] });
        expect((await getWorkspaceSkillsConfig(tempDir)).disabledSkills).toEqual([]);
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('ignores the categories in a version 1 file, since the old app saved every registered category', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        await fse.ensureDir(path.join(tempDir, PRIMARY_CONFIG_DIR_NAME));
        await fse.writeJson(path.join(tempDir, PRIMARY_CONFIG_DIR_NAME, 'skills.json'), {
          schemaVersion: 1,
          revision: 3,
          enabledSkills: ['standup'],
          disabledSkills: ['old-exception'],
          enabledAgents: [],
          enabledCategories: ['pull-requests', 'notes', 'testing'],
        });

        const loaded = await getWorkspaceSkillsConfig(tempDir);

        expect(loaded).toMatchObject({ schemaVersion: 1, revision: 3, enabledSkills: ['standup'], disabledSkills: ['old-exception'] });
        expect(loaded.enabledCategories).toEqual([]);

        // Saving upgrades the file, and what it writes is what the caller chose.
        const saved = await saveWorkspaceSkillsConfig(tempDir, { enabledSkills: ['standup'] }, 3);
        expect(saved).toMatchObject({ schemaVersion: 2, revision: 4, enabledCategories: [] });
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('ignores the categories in a file written before versions existed', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        await fse.ensureDir(path.join(tempDir, PRIMARY_CONFIG_DIR_NAME));
        await fse.writeJson(path.join(tempDir, PRIMARY_CONFIG_DIR_NAME, 'skills.json'), {
          enabledSkills: ['standup'],
          enabledCategories: ['pull-requests'],
        });

        expect(await getWorkspaceSkillsConfig(tempDir)).toMatchObject({ enabledSkills: ['standup'], enabledCategories: [] });
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('rejects a version it does not know', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        await fse.ensureDir(path.join(tempDir, PRIMARY_CONFIG_DIR_NAME));
        await fse.writeJson(path.join(tempDir, PRIMARY_CONFIG_DIR_NAME, 'skills.json'), { schemaVersion: 3, enabledSkills: [] });
        await expect(getWorkspaceSkillsConfig(tempDir)).rejects.toThrow(/Invalid workspace resource configuration/);
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('lists the skills that have a SKILL.md in either skill folder right now', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        const put = async (folder: string, id: string, file = 'SKILL.md') => {
          await fse.ensureDir(path.join(tempDir, folder, 'skills', id));
          await fs.writeFile(path.join(tempDir, folder, 'skills', id, file), '# skill');
        };
        await put('.agents', 'only-agents');
        await put('.claude', 'only-claude');
        await put('.agents', 'both');
        await put('.claude', 'both');
        await put('.claude', 'no-skill-file', 'README.md');

        expect(await listInstalledSkillIds(tempDir)).toEqual(['both', 'only-agents', 'only-claude']);
        expect(await listInstalledSkillIds(path.join(tempDir, 'nowhere'))).toEqual([]);
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('rejects stale assignment revisions', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        await saveWorkspaceSkillsConfig(tempDir, { enabledSkills: ['pr-review-toolkit'] }, 0);
        await expect(
          saveWorkspaceSkillsConfig(tempDir, { enabledSkills: ['verifier-workspace'] }, 0),
        ).rejects.toThrow(/expected revision 0, current 1/i);
      } finally {
        await fse.remove(tempDir);
      }
    });

    it('serializes concurrent writes so only one request can claim a revision', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-skills-test-'));
      try {
        const results = await Promise.allSettled([
          saveWorkspaceSkillsConfig(tempDir, { enabledSkills: ['pr-review-toolkit'] }, 0),
          saveWorkspaceSkillsConfig(tempDir, { enabledSkills: ['verifier-workspace'] }, 0),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect((await getWorkspaceSkillsConfig(tempDir)).revision).toBe(1);
      } finally {
        await fse.remove(tempDir);
      }
    });
  });

  describe('Project-Specific (Workspace-Scoped) Skills', () => {
    it('saves a workspace-scoped skill into .agents/skills/ and does not expose it globally', async () => {
      const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-local-'));
      try {
        const saved = await saveSkill(
          {
            name: 'workspace-local-helper',
            title: 'Local Helper',
            category: 'testing',
            description: 'Only for this project',
            content: '# Local Helper\n\nRun workspace command.',
          },
          { scope: 'workspace', workspacePath: ws },
        );

        expect(saved.id).toBe('workspace-local-helper');
        expect(saved.custom).toBe(true);
        expect(saved.scope).toBe('workspace');
        expect(await fs.realpath(saved.path)).toBe(await fs.realpath(path.join(ws, '.agents', 'skills', 'workspace-local-helper', 'SKILL.md')));
        expect(saved.skill.id).toBe('workspace-local-helper');

        // Verify file written to <ws>/.agents/skills/workspace-local-helper/SKILL.md
        const localSkillPath = path.join(ws, '.agents', 'skills', 'workspace-local-helper', 'SKILL.md');
        expect(await fse.pathExists(localSkillPath)).toBe(true);

        // Verify NOT present in global user home
        expect(await fse.pathExists(path.join(tempHome, 'skills', 'workspace-local-helper'))).toBe(false);

        // Global catalog is still empty
        const globalSkills = await getAllSkills();
        expect(globalSkills.some((s) => s.id === 'workspace-local-helper')).toBe(false);

        // Workspace-scoped query discovers it
        const wsSkills = await getAllSkills(ws);
        expect(wsSkills.some((s) => s.id === 'workspace-local-helper')).toBe(true);
        const wsFound = wsSkills.find((s) => s.id === 'workspace-local-helper');
        expect(wsFound?.scope).toBe('workspace');
      } finally {
        await fse.remove(ws);
      }
    });

    it('saves a global skill into user dir and exposes it across workspaces', async () => {
      const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-global-'));
      try {
        await saveSkill(
          {
            name: 'company-standard-skill',
            title: 'Company Standard',
            category: 'quality',
            description: 'Available in all workspaces',
            content: '# Company Standard\n\nGlobal instructions.',
          },
          { scope: 'global' },
        );

        // Present in global user dir
        expect(await fse.pathExists(path.join(tempHome, 'skills', 'company-standard-skill', 'SKILL.md'))).toBe(true);

        // Present in global query
        expect((await getAllSkills()).some((s) => s.id === 'company-standard-skill')).toBe(true);

        // Present in workspace query
        expect((await getAllSkills(ws)).some((s) => s.id === 'company-standard-skill')).toBe(true);
      } finally {
        await fse.remove(ws);
        await deleteSkill('company-standard-skill').catch(() => {});
      }
    });

    it('allows a workspace skill to shadow a global skill and deletes properly by scope', async () => {
      const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-ws-shadow-'));
      try {
        await saveSkill(
          {
            name: 'shared-name-skill',
            description: 'Global definition',
            content: '# Global',
          },
          { scope: 'global' },
        );

        await saveSkill(
          {
            name: 'shared-name-skill',
            description: 'Workspace-specific override',
            content: '# Local Override',
          },
          { scope: 'workspace', workspacePath: ws },
        );

        const wsSkills = await getAllSkills(ws);
        const active = wsSkills.find((s) => s.id === 'shared-name-skill');
        expect(active?.content).toContain('# Local Override');
        expect(active?.scope).toBe('workspace');

        // Delete workspace skill
        await deleteSkill('shared-name-skill', { scope: 'workspace', workspacePath: ws });
        expect(await fse.pathExists(path.join(ws, '.agents', 'skills', 'shared-name-skill'))).toBe(false);

        // Global skill remains intact
        const afterLocalDelete = await getAllSkills(ws);
        const globalRemaining = afterLocalDelete.find((s) => s.id === 'shared-name-skill');
        expect(globalRemaining?.content).toContain('# Global');
        expect(globalRemaining?.scope).toBe('global');
      } finally {
        await fse.remove(ws);
        await deleteSkill('shared-name-skill').catch(() => {});
      }
    });

    it('rejects saving a workspace skill without workspacePath', async () => {
      await expect(
        saveSkill(
          {
            name: 'missing-path-skill',
            description: 'No ws path',
            content: '# Test',
          },
          { scope: 'workspace' },
        ),
      ).rejects.toThrow(/workspacePath is required/i);
    });

    it('rejects deleting a workspace skill without workspacePath', async () => {
      await expect(
        deleteSkill('any-skill', { scope: 'workspace' }),
      ).rejects.toThrow(/workspacePath is required/i);
    });
  });
});

describe('Skill discovery diagnostics', () => {
  let tempHome: string;
  let workspace: string;
  const originalEnv = process.env.NEXUSFLOW_HOME;
  const originalCsEnv = process.env.CONTEXTSPACE_HOME;
  type Diagnostics = NonNullable<Parameters<typeof getAllSkills>[1]>;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-skill-diag-home-'));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-skill-diag-ws-'));
    process.env.NEXUSFLOW_HOME = tempHome;
    delete process.env.CONTEXTSPACE_HOME;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) process.env.NEXUSFLOW_HOME = originalEnv;
    else delete process.env.NEXUSFLOW_HOME;
    if (originalCsEnv !== undefined) process.env.CONTEXTSPACE_HOME = originalCsEnv;
    else delete process.env.CONTEXTSPACE_HOME;
    await fse.remove(tempHome);
    await fse.remove(workspace);
  });

  /** Writes a SKILL.md by hand, so a test can leave out or get wrong exactly one field. */
  async function writeSkill(root: string, folder: string, frontmatter: string[]): Promise<void> {
    await fs.mkdir(path.join(root, folder), { recursive: true });
    await fs.writeFile(path.join(root, folder, 'SKILL.md'), ['---', ...frontmatter, '---', '', '# Body', ''].join('\n'));
  }
  const globalDir = () => path.join(tempHome, 'skills');
  const workspaceDir = () => path.join(workspace, '.agents', 'skills');

  it('says what to fix when name: does not match the folder', async () => {
    await writeSkill(globalDir(), 'my-skill', ['name: other-name', 'description: Mismatched', 'category: quality']);
    const diagnostics: Diagnostics = [];

    const skills = await getAllSkills(undefined, diagnostics);

    expect(skills.some((s) => s.id === 'other-name' || s.id === 'my-skill')).toBe(false);
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: 'my-skill', scope: 'global', level: 'error' }));
    const message = diagnostics.find((d) => d.id === 'my-skill')!.message;
    expect(message).toContain('Rename the folder to "other-name"');
    expect(message).toContain('change name: to "my-skill"');
  });

  it('reports a SKILL.md that fails validation as an error', async () => {
    await writeSkill(globalDir(), 'no-description', ['name: no-description']);
    const diagnostics: Diagnostics = [];

    await getAllSkills(undefined, diagnostics);

    expect(diagnostics).toContainEqual(expect.objectContaining({ id: 'no-description', level: 'error', message: expect.stringContaining('Invalid SKILL.md') }));
  });

  it('warns when a skill names no category, because it lands in "general" where it looks missing', async () => {
    await writeSkill(globalDir(), 'no-category', ['name: no-category', 'description: Names no category']);
    const diagnostics: Diagnostics = [];

    const skills = await getAllSkills(undefined, diagnostics);

    const loaded = skills.find((s) => s.id === 'no-category')!;
    expect(loaded.category).toBe('general');
    expect(loaded.categoryAssumed).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: 'no-category', scope: 'global', level: 'warning' }));
    expect(diagnostics.find((d) => d.id === 'no-category')!.message).toContain('listed under "general"');
  });

  it('says nothing about a skill that names its category', async () => {
    await writeSkill(globalDir(), 'has-category', ['name: has-category', 'description: Names one', 'category: quality']);
    const diagnostics: Diagnostics = [];

    const skills = await getAllSkills(undefined, diagnostics);

    const loaded = skills.find((s) => s.id === 'has-category')!;
    expect(loaded.category).toBe('quality');
    expect(loaded).not.toHaveProperty('categoryAssumed');
    expect(diagnostics.filter((d) => d.id === 'has-category')).toEqual([]);
  });

  it('also warns about a workspace skill that names no category', async () => {
    await writeSkill(workspaceDir(), 'local-no-category', ['name: local-no-category', 'description: Local, no category']);
    const diagnostics: Diagnostics = [];

    await getAllSkills(workspace, diagnostics);

    expect(diagnostics).toContainEqual(expect.objectContaining({ id: 'local-no-category', scope: 'workspace', level: 'warning' }));
  });

  it('does not warn about the category of a workspace copy of a global skill', async () => {
    await writeSkill(globalDir(), 'shared', ['name: shared', 'description: Global original']);
    await writeSkill(workspaceDir(), 'shared', ['name: shared', 'description: Workspace copy', 'scope: global']);
    const diagnostics: Diagnostics = [];

    await getAllSkills(workspace, diagnostics);

    expect(diagnostics.filter((d) => d.scope === 'workspace')).toEqual([]);
  });

  it('reports a workspace copy whose global source is missing as an error, and does not load it', async () => {
    await writeSkill(workspaceDir(), 'orphan', ['name: orphan', 'description: Copy of a deleted global skill', 'category: quality', 'scope: global']);
    const diagnostics: Diagnostics = [];

    const skills = await getAllSkills(workspace, diagnostics);

    expect(skills.some((s) => s.id === 'orphan')).toBe(false);
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: 'orphan', scope: 'workspace', level: 'error' }));
    expect(diagnostics.find((d) => d.id === 'orphan')!.message).toContain('catalog source is missing');
  });

  it('reports a workspace skill that overrides a global one as a warning, because it still loads', async () => {
    await writeSkill(globalDir(), 'twin', ['name: twin', 'description: Global twin', 'category: quality']);
    await writeSkill(workspaceDir(), 'twin', ['name: twin', 'description: Workspace twin', 'category: quality']);
    const diagnostics: Diagnostics = [];

    const skills = await getAllSkills(workspace, diagnostics);

    expect(skills.find((s) => s.id === 'twin')!.scope).toBe('workspace');
    expect(diagnostics).toContainEqual(expect.objectContaining({ id: 'twin', scope: 'workspace', level: 'warning', message: expect.stringContaining('overrides a global skill') }));
  });
});

describe('Skills owned by a harness', () => {
  let tempHome: string;
  let harnessHome: string;
  const saved = {
    nexusflow: process.env.NEXUSFLOW_HOME,
    contextspace: process.env.CONTEXTSPACE_HOME,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  type Diagnostics = NonNullable<Parameters<typeof getAllSkills>[1]>;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-harness-skills-catalog-'));
    // realpath: the catalog reports symlink-resolved roots, and tmpdir is a symlink on macOS.
    harnessHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-harness-skills-home-')));
    process.env.NEXUSFLOW_HOME = tempHome;
    delete process.env.CONTEXTSPACE_HOME;
  });

  afterEach(async () => {
    restore('NEXUSFLOW_HOME', saved.nexusflow);
    restore('CONTEXTSPACE_HOME', saved.contextspace);
    restore('HOME', saved.home);
    restore('USERPROFILE', saved.userProfile);
    await fse.remove(tempHome);
    await fse.remove(harnessHome);
  });

  async function writeSkill(relativeDir: string, frontmatter: string[] = []): Promise<string> {
    const dir = path.join(harnessHome, relativeDir);
    const name = path.basename(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      ['---', `name: ${name}`, 'description: From the harness', ...frontmatter, '---', '', '# Body', ''].join('\n'),
    );
    return dir;
  }
  const list = (diagnostics?: Diagnostics) => getAllSkills(undefined, diagnostics, { harnessHomeDir: harnessHome });

  it('lists them as read-only global skills that name their harness', async () => {
    await writeSkill('.claude/skills/synced/bucket-1/pdf');
    await writeSkill('.codex/skills/.system/imagegen');
    const diagnostics: Diagnostics = [];

    const skills = await list(diagnostics);

    expect(skills.find((s) => s.id === 'pdf')).toMatchObject({
      scope: 'global',
      custom: false,
      source: { harness: 'claude', label: 'Claude Code', root: path.join(harnessHome, '.claude', 'skills') },
    });
    expect(skills.find((s) => s.id === 'imagegen')?.source).toMatchObject({ harness: 'codex', label: 'Codex' });
    // The user cannot add a category to a harness's file, so nothing is flagged.
    expect(skills.find((s) => s.id === 'pdf')?.categoryAssumed).toBeUndefined();
    // The Raw view shows the file as written, so it keeps the frontmatter that `content` leaves out.
    const pdf = skills.find((s) => s.id === 'pdf')!;
    expect(pdf.rawFile).toMatch(/^---\nname: pdf\ndescription: From the harness\n---/);
    expect(pdf.content).not.toContain('description: From the harness');
    expect(diagnostics).toEqual([]);
  });

  it('lets a skill in the ContextSpace catalog win an id clash', async () => {
    await writeSkill('.claude/skills/shared');
    await saveSkill({ name: 'shared', description: 'From the catalog', content: '# Mine' });

    const shared = (await list()).filter((s) => s.id === 'shared');

    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ description: 'From the catalog', custom: true });
    expect(shared[0].source).toBeUndefined();
  });

  it('shows the first harness when two ship the same id, and says the other was hidden', async () => {
    await writeSkill('.claude/skills/skill-creator');
    await writeSkill('.codex/skills/.system/skill-creator');
    const diagnostics: Diagnostics = [];

    const matches = (await list(diagnostics)).filter((s) => s.id === 'skill-creator');

    expect(matches).toHaveLength(1);
    expect(matches[0].source?.harness).toBe('claude');
    expect(diagnostics).toEqual([
      expect.objectContaining({ id: 'skill-creator', level: 'warning', source: 'codex', message: expect.stringContaining('Showing the Claude Code copy') }),
    ]);
  });

  it('lists a skill once, without a warning, when one harness ships it in two folders', async () => {
    await writeSkill('.gemini/antigravity/builtin/skills/twice');
    await writeSkill('.gemini/antigravity-cli/builtin/skills/twice');
    const diagnostics: Diagnostics = [];

    const matches = (await list(diagnostics)).filter((s) => s.id === 'twice');

    expect(matches).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  it('warns about a skill that cannot load, once, and still lists the others', async () => {
    const mismatched = ['.gemini/antigravity/builtin/skills/bad', '.gemini/antigravity-cli/builtin/skills/bad'];
    for (const dir of mismatched) {
      await fs.mkdir(path.join(harnessHome, dir), { recursive: true });
      await fs.writeFile(path.join(harnessHome, dir, 'SKILL.md'), '---\nname: other\ndescription: Wrong name\n---\n# Body\n');
    }
    await writeSkill('.claude/skills/fine');
    const diagnostics: Diagnostics = [];

    const skills = await list(diagnostics);

    expect(skills.map((s) => s.id)).toContain('fine');
    expect(skills.some((s) => s.id === 'bad' || s.id === 'other')).toBe(false);
    expect(diagnostics).toEqual([
      expect.objectContaining({ id: 'bad', level: 'warning', source: 'antigravity', message: expect.stringContaining('must match directory identity') }),
    ]);
  });

  it('skips them in an isolated home, and finds them in the real home', async () => {
    await writeSkill('.claude/skills/pdf');
    process.env.HOME = harnessHome;
    process.env.USERPROFILE = harnessHome;

    expect((await getAllSkills()).some((s) => s.source)).toBe(false);

    delete process.env.NEXUSFLOW_HOME;
    delete process.env.CONTEXTSPACE_HOME;
    expect((await getAllSkills()).find((s) => s.id === 'pdf')?.source?.harness).toBe('claude');
  });

  it('cannot delete a harness skill through the catalog', async () => {
    const dir = await writeSkill('.claude/skills/keep-me');
    expect((await list()).some((s) => s.id === 'keep-me')).toBe(true);

    await expect(deleteSkill('keep-me')).rejects.toThrow(/Skill not found/);

    expect(await fse.pathExists(path.join(dir, 'SKILL.md'))).toBe(true);
  });
  describe('adding one to My library', () => {
    const importFromClaude = (id: string) => importHarnessSkill('claude', id, { harnessHomeDir: harnessHome });
    const libraryCopy = (id: string, ...parts: string[]) => path.join(tempHome, 'skills', id, ...parts);

    it('copies the skill folder into the library and returns it as a library skill', async () => {
      const dir = await writeSkill('.claude/skills/pdf', ['category: documents']);
      await fs.mkdir(path.join(dir, 'references'));
      await fs.writeFile(path.join(dir, 'references', 'forms.md'), '# Forms');
      await fs.mkdir(path.join(dir, 'scripts'));
      await fs.writeFile(path.join(dir, 'scripts', 'fill.sh'), '#!/bin/sh\n', { mode: 0o755 });
      // A file a workspace copy would reject stays behind.
      await fs.writeFile(path.join(dir, 'LICENSE.txt'), 'MIT');

      const imported = await importFromClaude('pdf');

      expect(imported).toMatchObject({ id: 'pdf', category: 'documents', custom: true, scope: 'global' });
      expect(imported.source).toBeUndefined();
      expect(imported.sourcePath).toBe(libraryCopy('pdf'));
      expect(await fs.readFile(libraryCopy('pdf', 'SKILL.md'), 'utf-8')).toBe(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8'));
      expect(await fs.readFile(libraryCopy('pdf', 'references', 'forms.md'), 'utf-8')).toBe('# Forms');
      expect((await fs.stat(libraryCopy('pdf', 'scripts', 'fill.sh'))).mode & 0o111).not.toBe(0);
      expect(await fse.pathExists(libraryCopy('pdf', 'LICENSE.txt'))).toBe(false);
      // The harness keeps its own copy, and the library now wins the id.
      expect(await fse.pathExists(path.join(dir, 'SKILL.md'))).toBe(true);
      const listed = (await list()).filter((skill) => skill.id === 'pdf');
      expect(listed).toHaveLength(1);
      expect(listed[0].source).toBeUndefined();
      expect(await fs.readdir(path.join(tempHome, 'skills'))).toEqual(['pdf']);
    });

    it('finds a skill the harness keeps in a nested folder', async () => {
      await writeSkill('.claude/skills/synced/bucket-1/pdf');
      await expect(importFromClaude('pdf')).resolves.toMatchObject({ id: 'pdf' });
    });

    it('says not-found when that harness has no such skill', async () => {
      await writeSkill('.codex/skills/.system/imagegen');

      await expect(importFromClaude('imagegen')).rejects.toMatchObject({ name: 'SkillImportError', code: 'not-found' });
      await expect(importFromClaude('nothing-here')).rejects.toBeInstanceOf(SkillImportError);
      expect(await fse.pathExists(path.join(tempHome, 'skills'))).toBe(false);
      await expect(importHarnessSkill('codex', 'imagegen', { harnessHomeDir: harnessHome })).resolves.toMatchObject({ id: 'imagegen' });
    });

    it('says exists when My library already has a skill with that id, and leaves both alone', async () => {
      await writeSkill('.claude/skills/shared');
      await saveSkill({ name: 'shared', description: 'Mine', content: '# Mine' });

      await expect(importFromClaude('shared')).rejects.toMatchObject({ name: 'SkillImportError', code: 'exists' });

      expect(await fs.readFile(libraryCopy('shared', 'SKILL.md'), 'utf-8')).toContain('description: Mine');
      expect(await fse.pathExists(path.join(harnessHome, '.claude', 'skills', 'shared', 'SKILL.md'))).toBe(true);
    });

    it('does not write over a library folder that is there but does not load', async () => {
      await writeSkill('.claude/skills/pdf');
      await fse.ensureDir(libraryCopy('pdf'));
      await fs.writeFile(libraryCopy('pdf', 'notes.txt'), 'keep me');

      await expect(importFromClaude('pdf')).rejects.toMatchObject({ code: 'exists' });

      expect(await fs.readFile(libraryCopy('pdf', 'notes.txt'), 'utf-8')).toBe('keep me');
    });

    it('lets only one of two simultaneous imports of the same skill through', async () => {
      await writeSkill('.claude/skills/pdf');

      const results = await Promise.allSettled([importFromClaude('pdf'), importFromClaude('pdf')]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: 'exists' });
      expect(await fs.readdir(path.join(tempHome, 'skills'))).toEqual(['pdf']);
    });

    it('does not follow a link inside the skill, and leaves nothing behind', async () => {
      const dir = await writeSkill('.claude/skills/linky');
      const outside = path.join(harnessHome, 'secret.txt');
      await fs.writeFile(outside, 'secret');
      // The catalog does not look inside agents/, so the skill lists and the copy is what must refuse the link.
      await fs.mkdir(path.join(dir, 'agents'));
      await fs.symlink(outside, path.join(dir, 'agents', 'secret.txt'));

      await expect(importFromClaude('linky')).rejects.toThrow(/Linked skill support files are not allowed/);

      expect(await fs.readdir(path.join(tempHome, 'skills'))).toEqual([]);
    });
  });
});
