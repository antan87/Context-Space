import { describe, expect, it } from 'vitest';

import {
  builtInGroups, categoryGroups, choiceFromConfig, folderReaders, installChanges, matchesSkillSearch, onSkillIds, pickAll, sameChoice, sameIds,
  selectionState, setCategory, skillOrigin, skillStatus, subscribedCategories, toggleSkill,
  type SkillChoice,
} from './skillSelection.js';
import type { HarnessInfo, SkillItem } from '../../types.js';

const skill = (id: string, category: string, extra: Partial<SkillItem> = {}): SkillItem => ({
  id, name: id, category, description: `Use ${id}`, content: '', custom: true, ...extra,
});

const review = skill('review', 'git');
const commit = skill('commit', 'git');
const lint = skill('lint', 'quality');
const loose = skill('loose', 'general');
const notes = skill('notes', 'general', { scope: 'workspace' });
const pdf = skill('pdf', 'documents', { custom: false, source: { harness: 'claude', label: 'Claude Code', root: '~/.claude/skills' } });
const skills = [review, commit, lint, loose, notes, pdf];

const none: SkillChoice = { categories: [], picks: [], exceptions: [] };

describe('which skills a choice turns on, and why', () => {
  it('turns on nothing for an empty choice', () => {
    expect(onSkillIds(skills, none)).toEqual([]);
    expect(skillStatus(review, none)).toEqual({ on: false, why: null });
  });

  it('turns on every skill of a category that is on, now and for skills added to it later', () => {
    const choice = { ...none, categories: ['git'] };
    expect(onSkillIds(skills, choice)).toEqual(['review', 'commit']);
    expect(skillStatus(review, choice)).toEqual({ on: true, why: 'category' });
    const later = skill('rebase', 'git');
    expect(onSkillIds([...skills, later], choice)).toEqual(['review', 'commit', 'rebase']);
  });

  it('turns on a skill picked on its own, and says so', () => {
    const choice = { ...none, picks: ['lint'] };
    expect(onSkillIds(skills, choice)).toEqual(['lint']);
    expect(skillStatus(lint, choice)).toEqual({ on: true, why: 'picked' });
  });

  it('leaves out an exception, and says it was left out', () => {
    const choice = { categories: ['git'], picks: [], exceptions: ['commit'] };
    expect(onSkillIds(skills, choice)).toEqual(['review']);
    expect(skillStatus(commit, choice)).toEqual({ on: false, why: 'left-out' });
    // An exception beats a pick too.
    expect(skillStatus(lint, { categories: [], picks: ['lint'], exceptions: ['lint'] })).toEqual({ on: false, why: 'left-out' });
    // An exception for a skill nothing brings in changes nothing.
    expect(skillStatus(lint, { ...none, exceptions: ['lint'] })).toEqual({ on: false, why: null });
  });

  it('never turns on a skill a tool ships, however it is named', () => {
    const choice = { categories: ['documents'], picks: ['pdf'], exceptions: [] };
    expect(skillStatus(pdf, choice)).toEqual({ on: false, why: null });
    expect(onSkillIds(skills, choice)).toEqual([]);
  });

  it('counts a skill written for one workspace like any other when its category is on', () => {
    expect(onSkillIds(skills, { ...none, categories: ['general'] })).toEqual(['loose', 'notes']);
  });
});

describe('changing the choice', () => {
  it('subscribes to a category when it is turned on, and unsubscribes when it is turned off', () => {
    const on = setCategory(none, skills, 'git', true);
    expect(on.categories).toEqual(['git']);
    expect(onSkillIds(skills, on)).toEqual(['review', 'commit']);
    expect(setCategory(on, skills, 'git', false).categories).toEqual([]);
    // Turning it on twice subscribes once.
    expect(setCategory(on, skills, 'git', true).categories).toEqual(['git']);
  });

  it('brings back a skill that was left out when the category is turned on again, and forgets it when it is turned off', () => {
    const left = { categories: ['git'], picks: [], exceptions: ['commit', 'lint'] };
    expect(setCategory(left, skills, 'git', true).exceptions).toEqual(['lint']);
    expect(setCategory(left, skills, 'git', false).exceptions).toEqual(['lint']);
  });

  it('keeps a skill that was picked on its own when its category is turned off', () => {
    const choice = { categories: ['git'], picks: ['review'], exceptions: [] };
    expect(onSkillIds(skills, setCategory(choice, skills, 'git', false))).toEqual(['review']);
  });

  it('adds an exception for a skill switched off inside an on category, and removes it when switched on again', () => {
    const inGit = setCategory(none, skills, 'git', true);
    const off = toggleSkill(inGit, commit);
    expect(off).toEqual({ categories: ['git'], picks: [], exceptions: ['commit'] });
    expect(onSkillIds(skills, off)).toEqual(['review']);
    expect(toggleSkill(off, commit)).toEqual(inGit);
  });

  it('picks a skill outside the on categories, and unpicks it', () => {
    const picked = toggleSkill(none, lint);
    expect(picked).toEqual({ categories: [], picks: ['lint'], exceptions: [] });
    expect(toggleSkill(picked, lint)).toEqual(none);
  });

  it('switching a picked skill off inside an on category leaves it out for good, even if the category is turned off later', () => {
    const choice = { categories: ['git'], picks: ['review'], exceptions: [] };
    const off = toggleSkill(choice, review);
    expect(off).toEqual({ categories: ['git'], picks: [], exceptions: ['review'] });
    expect(onSkillIds(skills, setCategory(off, skills, 'git', false))).toEqual([]);
  });

  it('clears a stale exception when a skill outside the on categories is switched on', () => {
    const stale = { categories: [], picks: [], exceptions: ['lint'] };
    expect(onSkillIds(skills, toggleSkill(stale, lint))).toEqual(['lint']);
  });

  it('does not change anything for a skill a tool ships', () => {
    expect(toggleSkill(none, pdf)).toBe(none);
  });

  it('picks every skill on its own for Select All, ignoring a tool\'s', () => {
    const all = pickAll({ ...none, exceptions: ['lint'] }, skills);
    expect(all.picks).toEqual(['review', 'commit', 'lint', 'loose', 'notes']);
    expect(all.exceptions).toEqual([]);
  });

  it('does not change the choice it was given', () => {
    const choice: SkillChoice = { categories: ['git'], picks: ['lint'], exceptions: [] };
    const copy = structuredClone(choice);
    toggleSkill(choice, commit);
    toggleSkill(choice, lint);
    setCategory(choice, skills, 'git', false);
    pickAll(choice, skills);
    expect(choice).toEqual(copy);
  });
});

describe('reading a saved config', () => {
  it('subscribes to the categories of a version 2 file', () => {
    expect(subscribedCategories({ schemaVersion: 2, enabledCategories: ['git'] })).toEqual(['git']);
  });

  it('ignores the categories of a version 1 file: the old app saved every registered category there', () => {
    expect(subscribedCategories({ schemaVersion: 1, enabledCategories: ['git', 'quality'] })).toEqual([]);
    expect(subscribedCategories({ enabledCategories: ['git'] })).toEqual([]);
    expect(subscribedCategories(undefined)).toEqual([]);
  });

  it('drops ids that name a skill a tool ships or no skill at all', () => {
    const choice = choiceFromConfig({ schemaVersion: 2, enabledSkills: ['lint', 'pdf', 'gone'], disabledSkills: ['commit', 'gone'], enabledCategories: ['git'] }, skills);
    expect(choice).toEqual({ categories: ['git'], picks: ['lint'], exceptions: ['commit'] });
  });

  it('picks what the server turns on but the config does not explain, such as a workspace\'s own skills before anything was saved', () => {
    const choice = choiceFromConfig({ schemaVersion: 1, revision: 0, enabledSkills: [] }, skills, ['notes', 'pdf', 'gone']);
    expect(choice.picks).toEqual(['notes']);
    // A skill that was left out is not picked back in because an older reading still lists it.
    expect(choiceFromConfig({ schemaVersion: 2, enabledSkills: [], disabledSkills: ['commit'], enabledCategories: ['git'] }, skills, ['review', 'commit']).picks).toEqual([]);
    // What a category already explains is not picked again.
    const inGit = choiceFromConfig({ schemaVersion: 2, enabledSkills: [], enabledCategories: ['git'] }, skills, ['review', 'commit']);
    expect(inGit.picks).toEqual([]);
  });

  it('compares choices as sets', () => {
    expect(sameChoice({ categories: ['a', 'b'], picks: [], exceptions: ['x'] }, { categories: ['b', 'a'], picks: [], exceptions: ['x'] })).toBe(true);
    expect(sameChoice({ categories: ['a'], picks: [], exceptions: [] }, { categories: ['a'], picks: ['p'], exceptions: [] })).toBe(false);
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('the unsaved change', () => {
  const saved = { choice: { categories: ['git'], picks: [], exceptions: [] }, agents: ['reviewer'], revision: 3 };

  it('is saved when there is no draft or it says the same, unsaved when it differs, outdated when the server moved on', () => {
    expect(selectionState(null, saved)).toBe('saved');
    expect(selectionState({ choice: { categories: ['git'], picks: [], exceptions: [] }, agents: ['reviewer'], revision: 1 }, saved)).toBe('saved');
    expect(selectionState({ choice: { categories: [], picks: [], exceptions: [] }, agents: ['reviewer'], revision: 3 }, saved)).toBe('unsaved');
    expect(selectionState({ choice: saved.choice, agents: [], revision: 3 }, saved)).toBe('unsaved');
    expect(selectionState({ choice: { categories: [], picks: [], exceptions: [] }, agents: ['reviewer'], revision: 2 }, saved)).toBe('outdated');
    expect(selectionState({ choice: { categories: [], picks: [], exceptions: [] }, agents: [], revision: 0 }, undefined)).toBe('saved');
  });
});

describe('the categories on offer', () => {
  const registered = [
    { id: 'git', name: 'Git', description: 'Working with git', color: '#f00' },
    { id: 'empty', name: 'Empty', description: '' },
    { id: 'general', name: 'General', description: '' },
  ];

  it('lists registered categories with their library skills, and those only a skill names, but not "general" or a tool\'s skills', () => {
    const groups = categoryGroups(registered, skills, []);
    expect(groups.map((group) => group.id)).toEqual(['git', 'empty', 'quality']);
    expect(groups[0]).toMatchObject({ name: 'Git', color: '#f00', on: false });
    expect(groups[0]!.members.map((member) => member.id)).toEqual(['review', 'commit']);
    expect(groups[1]!.members).toEqual([]);
    expect(groups[2]).toMatchObject({ name: 'Quality', description: '' });
  });

  it('keeps a category that is on even when it is not registered and no skill is in it, so it can be turned off', () => {
    const groups = categoryGroups(registered, skills, ['general', 'retired']);
    expect(groups.map((group) => group.id)).toEqual(['git', 'empty', 'general', 'quality', 'retired']);
    expect(groups.filter((group) => group.on).map((group) => group.id)).toEqual(['general', 'retired']);
    expect(groups.find((group) => group.id === 'retired')!.name).toBe('Retired');
  });

  it('does not count a skill written for one workspace among the members', () => {
    const groups = categoryGroups(registered, skills, ['general']);
    expect(groups.find((group) => group.id === 'general')!.members.map((member) => member.id)).toEqual(['loose']);
  });
});

describe('what Save and apply changes', () => {
  it('adds what will be on and is not installed, and removes managed skills that are installed and will not be on', () => {
    const changes = installChanges(skills, ['review', 'lint'], ['review', 'commit', 'analysis-extra', 'notes']);
    expect(changes.added).toEqual(['lint']);
    // "analysis-extra" comes from elsewhere and "notes" is stored in the workspace's own folder: neither is removed.
    expect(changes.removed).toEqual(['commit']);
  });

  it('reports nothing when the installed skills are the selected ones', () => {
    expect(installChanges(skills, ['review'], ['review'])).toEqual({ added: [], removed: [] });
  });
});

describe('the skills built into each tool', () => {
  it('groups them per tool', () => {
    const codex = skill('imagegen', 'general', { source: { harness: 'codex', label: 'Codex', root: '~/.codex/skills' } });
    const claudeTwo = skill('xlsx', 'documents', { source: { harness: 'claude', label: 'Claude Code', root: '~/.claude/skills' } });
    const groups = builtInGroups([review, pdf, codex, claudeTwo]);
    expect(groups.map((group) => [group.label, group.skills.map((s) => s.id)])).toEqual([['Claude Code', ['pdf', 'xlsx']], ['Codex', ['imagegen']]]);
  });
});

describe('naming a skill by who loads it', () => {
  it('says My library, This workspace only, or Built into the tool, and never Global', () => {
    expect(skillOrigin(review)).toBe('My library');
    expect(skillOrigin({ scope: 'global' })).toBe('My library');
    expect(skillOrigin(notes)).toBe('This workspace only');
    expect(skillOrigin(pdf)).toBe('Built into Claude Code');
  });
});

describe('the skill search', () => {
  const found = { title: 'Review PRs', name: 'review-prs', description: 'Use when reviewing a pull request', tags: ['git'], allowedTools: ['Bash(gh pr view)', 'Read'] };

  it('matches title, name, description, tags and the tools a skill may use, ignoring case', () => {
    for (const query of ['review PRs', 'REVIEW-prs', 'pull request', 'GIT', 'gh pr view', 'read']) expect(matchesSkillSearch(found, query)).toBe(true);
  });

  it('matches everything for an empty search, and nothing for text that is nowhere', () => {
    expect(matchesSkillSearch(found, '')).toBe(true);
    expect(matchesSkillSearch(found, '   ')).toBe(true);
    expect(matchesSkillSearch(found, 'kubernetes')).toBe(false);
    expect(matchesSkillSearch({ name: 'bare', description: '' }, 'x')).toBe(false);
  });
});

describe('which tools read which workspace skill folder', () => {
  const harness = (id: string, name: string, workspaceSkillFolder: string): HarnessInfo => ({
    id, name, workspaceSkillFolder, globalSkillRoots: [], history: true, instructionsFile: null,
  });
  const registry = [
    harness('claude', 'Claude Code', '.claude/skills'),
    harness('antigravity', 'Antigravity (agy)', '.agents/skills'),
    harness('codex', 'Codex', '.agents/skills'),
    harness('pi', 'Pi', '.agents/skills'),
  ];

  it('groups the tools by folder, folders and tools in registry order, with the short names the app uses', () => {
    expect(folderReaders(registry)).toEqual([
      { folder: '.claude/skills', tools: ['Claude Code'] },
      { folder: '.agents/skills', tools: ['Antigravity', 'Codex', 'Pi'] },
    ]);
  });

  it('names a tool the app has not heard of from the registry, and gives it a folder of its own', () => {
    expect(folderReaders([...registry, harness('acme', 'Acme Agent (acme)', '.acme/skills')]).at(-1)).toEqual({
      folder: '.acme/skills',
      tools: ['Acme Agent'],
    });
  });

  it('has nothing to say without tools', () => {
    expect(folderReaders([])).toEqual([]);
  });
});
