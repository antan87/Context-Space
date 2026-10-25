import { describe, expect, it } from 'vitest';

import type { SkillItem } from '../types.js';
import { isDefaultSkillsConfig, resolveWorkspaceSkills, workspaceOnlySkillIds } from './selection.js';

function skill(id: string, category: string, extra: Partial<SkillItem> = {}): SkillItem {
  return { id, name: id, category, description: `About ${id}`, content: `# ${id}`, custom: true, ...extra };
}

const harnessSkill = (id: string, category = 'general'): SkillItem =>
  skill(id, category, { custom: false, scope: 'global', source: { harness: 'claude', label: 'Claude Code', root: '/home/me/.claude/skills' } });

const ids = (skills: SkillItem[]) => skills.map((item) => item.id).sort();

describe('resolveWorkspaceSkills', () => {
  const library = [
    skill('review-pr', 'pull-requests'),
    skill('write-description', 'pull-requests'),
    skill('run-e2e', 'testing'),
    skill('standup', 'notes'),
  ];

  it('turns on every skill in a subscribed category, including one added later', () => {
    const config = { enabledSkills: [], enabledCategories: ['pull-requests'] };
    expect(ids(resolveWorkspaceSkills(config, library).skills)).toEqual(['review-pr', 'write-description']);

    const later = [...library, skill('merge-helper', 'pull-requests')];
    expect(ids(resolveWorkspaceSkills(config, later).skills)).toEqual(['merge-helper', 'review-pr', 'write-description']);
  });

  it('lets one skill be switched off inside a subscribed category', () => {
    const config = { enabledSkills: [], enabledCategories: ['pull-requests'], disabledSkills: ['write-description'] };
    expect(ids(resolveWorkspaceSkills(config, library).skills)).toEqual(['review-pr']);
  });

  it('adds a single pick outside every subscribed category', () => {
    const config = { enabledSkills: ['standup'], enabledCategories: ['pull-requests'] };
    expect(ids(resolveWorkspaceSkills(config, library).skills)).toEqual(['review-pr', 'standup', 'write-description']);
  });

  it('lists a skill once when it is both picked and in a subscribed category', () => {
    const config = { enabledSkills: ['review-pr', 'review-pr'], enabledCategories: ['pull-requests'] };
    const resolved = resolveWorkspaceSkills(config, library).skills.filter((item) => item.id === 'review-pr');
    expect(resolved).toHaveLength(1);
  });

  it('never includes a skill a harness ships, even when it is picked or sits in a subscribed category', () => {
    const catalog = [...library, harnessSkill('pdf'), harnessSkill('imagegen', 'pull-requests')];
    const config = { enabledSkills: ['pdf', 'standup'], enabledCategories: ['pull-requests', 'general'] };

    const resolved = resolveWorkspaceSkills(config, catalog);

    expect(ids(resolved.skills)).toEqual(['review-pr', 'standup', 'write-description']);
    expect(resolved.builtIn).toEqual(['pdf']);
    expect(resolved.missing).toEqual([]);
  });

  it('ignores the skills list a category file carries, since only the skill names its category', () => {
    // A category's own `skills` list used to switch skills on. Resolution never sees it.
    const config = { enabledSkills: [], enabledCategories: ['testing'] };
    expect(ids(resolveWorkspaceSkills(config, library).skills)).toEqual(['run-e2e']);
  });

  it('reports a picked id that is not in the library', () => {
    const config = { enabledSkills: ['standup', 'deleted-skill'], enabledCategories: [] };
    const resolved = resolveWorkspaceSkills(config, library);
    expect(ids(resolved.skills)).toEqual(['standup']);
    expect(resolved.missing).toEqual(['deleted-skill']);
  });

  it('does not report a missing id that is switched off', () => {
    const config = { enabledSkills: ['deleted-skill'], disabledSkills: ['deleted-skill'] };
    expect(resolveWorkspaceSkills(config, library)).toEqual({ skills: [], missing: [], builtIn: [] });
  });

  it('adds the extras, drops an exception from them, and ignores an unknown or harness id', () => {
    const catalog = [...library, harnessSkill('pdf')];
    const config = { enabledSkills: [], disabledSkills: ['standup'] };

    const resolved = resolveWorkspaceSkills(config, catalog, { ids: ['run-e2e', 'standup', 'pdf', 'no-such-skill'] });

    expect(ids(resolved.skills)).toEqual(['run-e2e']);
    expect(resolved.missing).toEqual([]);
    expect(resolved.builtIn).toEqual([]);
  });

  it('finds a generated skill by id but never puts it in through a category', () => {
    const generated = skill('verifier-workspace', 'testing', { custom: false });

    const byCategory = resolveWorkspaceSkills({ enabledSkills: [], enabledCategories: ['testing'] }, library, { generated: [generated] });
    expect(ids(byCategory.skills)).toEqual(['run-e2e']);

    const picked = resolveWorkspaceSkills({ enabledSkills: ['verifier-workspace'] }, library, { generated: [generated] });
    expect(picked.skills).toEqual([generated]);
    expect(picked.missing).toEqual([]);
  });

  it('prefers a generated skill over a library skill with the same id', () => {
    const generated = skill('run-e2e', 'testing', { custom: false, description: 'Generated for this workspace' });
    const resolved = resolveWorkspaceSkills({ enabledSkills: ['run-e2e'] }, library, { generated: [generated] });
    expect(resolved.skills).toEqual([generated]);
  });

  it('selects nothing for an empty config', () => {
    expect(resolveWorkspaceSkills({ enabledSkills: [] }, library)).toEqual({ skills: [], missing: [], builtIn: [] });
  });
});

describe('workspace-only skills on a default config', () => {
  const catalog = [skill('library-skill', 'general'), skill('local-plan', 'general', { scope: 'workspace' }), harnessSkill('pdf')];

  it('are switched on until a selection is saved', () => {
    expect(isDefaultSkillsConfig({ revision: 0, disabledSkills: [] })).toBe(true);
    expect(workspaceOnlySkillIds({ revision: 0 }, catalog)).toEqual(['local-plan']);
  });

  it('stop being automatic once a selection is saved or a skill is switched off', () => {
    expect(isDefaultSkillsConfig({ revision: 1 })).toBe(false);
    expect(workspaceOnlySkillIds({ revision: 1 }, catalog)).toEqual([]);
    expect(workspaceOnlySkillIds({ revision: 0, disabledSkills: ['x'] }, catalog)).toEqual([]);
  });
});
