import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from 'fs-extra';

import { saveAgent } from './agents-catalog.js';
import { saveSkill, getAllSkills, type SkillDiagnostic } from '../utils/skills-catalog.js';
import {
  ResourceSelectionError,
  previewResourceSelections,
  validateResourceSelections,
  withResourceAdministrationLock,
} from './service.js';

describe('resource administration service', () => {
  let tempHome: string;
  const originalHome = process.env.NEXUSFLOW_HOME;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-resource-service-'));
    process.env.NEXUSFLOW_HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.NEXUSFLOW_HOME;
    else process.env.NEXUSFLOW_HOME = originalHome;
    await fse.remove(tempHome);
  });

  it('rejects missing selections and accepts existing underscore-style agents', async () => {
    await saveSkill({
      name: 'pr-review-toolkit',
      title: 'Pull Request Review Toolkit',
      category: 'general',
      description: 'Reviews pull requests.',
      content: '# Review',
    });

    await saveAgent({
      name: 'docs_researcher',
      category: 'general',
      description: 'Use when researching docs.',
      developerInstructions: 'Research official documentation.',
    });

    await expect(validateResourceSelections(['pr-review-toolkit'], ['docs_researcher'])).resolves.toBeUndefined();
    await expect(validateResourceSelections(['missing-skill'], ['missing_agent'])).rejects.toMatchObject({
      missingSkills: ['missing-skill'],
      missingAgents: ['missing_agent'],
    } satisfies Partial<ResourceSelectionError>);
  });

  it('serializes administration operations under one shared boundary', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });

    const first = withResourceAdministrationLock(async () => {
      events.push('first-start');
      firstStarted();
      await firstGate;
      events.push('first-end');
    });
    await started;
    const second = withResourceAdministrationLock(async () => {
      events.push('second-start');
      events.push('second-end');
    });

    expect(events).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('validates local skills only in their owning workspace', async () => {
    const workspace = path.join(tempHome, 'workspace');
    await fs.mkdir(workspace);
    await saveSkill({ name: 'local-check', description: 'Local check', content: 'Check local behavior' }, { scope: 'workspace', workspacePath: workspace });
    await expect(validateResourceSelections(['local-check'], [], workspace)).resolves.toBeUndefined();
    await expect(validateResourceSelections(['local-check'], [])).rejects.toMatchObject({ missingSkills: ['local-check'] });
    await expect(validateResourceSelections(['local-check'], [], path.join(tempHome, 'other'))).rejects.toMatchObject({ missingSkills: ['local-check'] });
  });

  it('reports invalid, orphaned global, and shadowing workspace packages to callers', async () => {
    const workspace = path.join(tempHome, 'workspace');
    const put = async (id: string, name: string, scope: string) => {
      const dir = path.join(workspace, '.agents', 'skills', id);
      await fs.mkdir(dir, { recursive: true });
      // Names a category, so the only notices are the three this test is about.
      await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Example\ncategory: testing\nscope: ${scope}\n---\nExample`);
    };
    await saveSkill({ name: 'shadowed', description: 'Global', content: 'Global' });
    await put('shadowed', 'shadowed', 'workspace');
    await put('orphan', 'orphan', 'global');
    await put('mismatch', 'different', 'workspace');
    const diagnostics: SkillDiagnostic[] = [];
    const skills = await getAllSkills(workspace, diagnostics);
    expect(skills.find((skill) => skill.id === 'shadowed')?.scope).toBe('workspace');
    expect(skills.some((skill) => skill.id === 'orphan')).toBe(false);
    expect(diagnostics.map((item) => item.id).sort()).toEqual(['mismatch', 'orphan', 'shadowed']);
  });

  describe('previewResourceSelections', () => {
    const files = (items: Awaited<ReturnType<typeof previewResourceSelections>>, id: string) =>
      items.find((item) => item.id === id)?.files;

    it('covers the skills of a chosen category as well as the single picks, in both skill folders', async () => {
      await saveSkill({ name: 'review-pr', category: 'pull-requests', description: 'Reviews', content: '# Review' });
      await saveSkill({ name: 'write-description', category: 'pull-requests', description: 'Describes', content: '# Describe' });
      await saveSkill({ name: 'standup', category: 'notes', description: 'Notes', content: '# Notes' });
      await saveSkill({ name: 'run-e2e', category: 'testing', description: 'Tests', content: '# Tests' });

      const items = await previewResourceSelections(['standup'], [], [], ['pull-requests']);

      expect(items.map((item) => item.id).sort()).toEqual(['review-pr', 'standup', 'write-description']);
      expect(files(items, 'review-pr')).toEqual(['.agents/skills/review-pr/SKILL.md', '.claude/skills/review-pr/SKILL.md']);
      expect(files(items, 'standup')).toEqual(['.agents/skills/standup/SKILL.md', '.claude/skills/standup/SKILL.md']);
    });

    it('leaves out a skill switched off inside a chosen category', async () => {
      await saveSkill({ name: 'review-pr', category: 'pull-requests', description: 'Reviews', content: '# Review' });
      await saveSkill({ name: 'write-description', category: 'pull-requests', description: 'Describes', content: '# Describe' });

      const items = await previewResourceSelections([], [], [], ['pull-requests'], ['write-description']);

      expect(items.map((item) => item.id)).toEqual(['review-pr']);
    });

    it('still previews only the single picks when no category is chosen', async () => {
      await saveSkill({ name: 'review-pr', category: 'pull-requests', description: 'Reviews', content: '# Review' });
      await saveSkill({ name: 'standup', category: 'notes', description: 'Notes', content: '# Notes' });

      const items = await previewResourceSelections(['standup'], [], ['claude']);

      expect(items.map((item) => item.id)).toEqual(['standup']);
    });

    it('leaves out a skill a harness ships, whether it is picked or in a chosen category', async () => {
      const saved = { nexusflow: process.env.NEXUSFLOW_HOME, home: process.env.HOME, userProfile: process.env.USERPROFILE };
      const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-resource-service-home-')));
      try {
        await fs.mkdir(path.join(home, '.claude', 'skills', 'pdf'), { recursive: true });
        await fs.writeFile(
          path.join(home, '.claude', 'skills', 'pdf', 'SKILL.md'),
          '---\nname: pdf\ndescription: From Claude\ncategory: documents\n---\n# PDF\n',
        );
        // Harness folders are only read in a real home.
        delete process.env.NEXUSFLOW_HOME;
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        await saveSkill({ name: 'write-report', category: 'documents', description: 'Writes', content: '# Report' });

        const items = await previewResourceSelections(['pdf'], [], ['claude'], ['documents']);

        expect(items.map((item) => item.id)).toEqual(['write-report']);
      } finally {
        for (const [key, value] of [['NEXUSFLOW_HOME', saved.nexusflow], ['HOME', saved.home], ['USERPROFILE', saved.userProfile]] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await fse.remove(home);
      }
    });
  });
});
