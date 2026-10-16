import { describe, expect, it } from 'vitest';

import {
  canDeleteSkill, deleteWorkspaceFor, groupToggled, matchesSkillSearch, sameIds, scopeLabel, selectionFor, selectionState, skillTargets, toggled,
} from './skillSelection.js';

const saved = { enabledSkills: ['a', 'b'], revision: 3 };

describe('the unsaved selection', () => {
  it('shows what is saved until a choice is made, and nothing until that is known', () => {
    expect(selectionFor(undefined, saved)).toEqual(['a', 'b']);
    expect(selectionFor(undefined, undefined)).toBeNull();
    expect(selectionFor({ skills: ['c'], revision: 3 }, saved)).toEqual(['c']);
    // The unsaved choice stays visible even while the saved selection is still loading.
    expect(selectionFor({ skills: ['c'], revision: 3 }, undefined)).toEqual(['c']);
  });

  it('starts from what is saved and remembers the revision it started from', () => {
    expect(toggled(undefined, saved, 'c')).toEqual({ skills: ['a', 'b', 'c'], revision: 3 });
    expect(toggled(undefined, saved, 'a')).toEqual({ skills: ['b'], revision: 3 });
  });

  it('keeps the revision of the first change, however many follow and whatever the server has since', () => {
    const first = toggled(undefined, saved, 'c');
    const later = toggled(first, { enabledSkills: ['z'], revision: 9 }, 'a');
    expect(later).toEqual({ skills: ['b', 'c'], revision: 3 });
  });

  it('switches a whole group on or off', () => {
    expect(groupToggled(undefined, saved, ['c', 'd', 'a'], true).skills.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(groupToggled(undefined, saved, ['a', 'b'], false).skills).toEqual([]);
  });

  it('is saved when there is no draft or the draft says the same, unsaved when it differs, outdated when the server moved on', () => {
    expect(selectionState(undefined, saved)).toBe('saved');
    expect(selectionState({ skills: ['b', 'a'], revision: 1 }, saved)).toBe('saved');
    expect(selectionState({ skills: ['a'], revision: 3 }, saved)).toBe('unsaved');
    expect(selectionState({ skills: ['a'], revision: 2 }, saved)).toBe('outdated');
    expect(selectionState({ skills: ['a'], revision: 0 }, { enabledSkills: [] })).toBe('unsaved');
    expect(selectionState({ skills: ['a'], revision: 0 }, undefined)).toBe('saved');
  });

  it('compares ids as sets', () => {
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
});

describe('deleting a skill', () => {
  it('names a workspace only for a workspace package viewed in that workspace', () => {
    expect(deleteWorkspaceFor({ scope: 'workspace' }, 'demo')).toBe('demo');
    expect(deleteWorkspaceFor({ scope: 'global' }, 'demo')).toBeUndefined();
    expect(deleteWorkspaceFor({ scope: 'global' }, 'global')).toBeUndefined();
    expect(deleteWorkspaceFor({ scope: undefined }, 'demo')).toBeUndefined();
    // Not possible from the page, but never turns a workspace delete into a global one by naming nothing.
    expect(deleteWorkspaceFor({ scope: 'workspace' }, 'global')).toBeUndefined();
  });

  it('offers delete for a person\'s own skills where deleting means what the page says', () => {
    expect(canDeleteSkill({ custom: true, scope: 'global' }, false)).toBe(true);
    expect(canDeleteSkill({ custom: true, scope: undefined }, false)).toBe(true);
    expect(canDeleteSkill({ custom: true, scope: 'workspace' }, true)).toBe(true);
    // A workspace's view must not delete what every workspace uses, or a built-in template.
    expect(canDeleteSkill({ custom: true, scope: 'global' }, true)).toBe(false);
    expect(canDeleteSkill({ custom: false, scope: 'global' }, false)).toBe(false);
    expect(canDeleteSkill({ custom: false, scope: 'workspace' }, true)).toBe(false);
    expect(canDeleteSkill({ custom: true, scope: 'workspace' }, false)).toBe(false);
  });
});

describe('the skill search', () => {
  const skill = { title: 'Review PRs', name: 'review-prs', description: 'Use when reviewing a pull request', tags: ['git'], allowedTools: ['Bash(gh pr view)', 'Read'] };

  it('matches title, name, description, tags and the tools a skill may use, ignoring case', () => {
    for (const query of ['review PRs', 'REVIEW-prs', 'pull request', 'GIT', 'gh pr view', 'read']) expect(matchesSkillSearch(skill, query)).toBe(true);
  });

  it('matches everything for an empty search, and nothing for text that is nowhere', () => {
    expect(matchesSkillSearch(skill, '')).toBe(true);
    expect(matchesSkillSearch(skill, '   ')).toBe(true);
    expect(matchesSkillSearch(skill, 'kubernetes')).toBe(false);
    expect(matchesSkillSearch({ name: 'bare', description: '' }, 'x')).toBe(false);
  });
});

describe('workspaces in the scope list', () => {
  const live = { id: 'live', branchName: 'feat/live', name: 'Live work' };
  const old = { id: 'old', branchName: 'old', name: 'Old', archivedAt: '2026-09-28T00:00:00Z' };

  it('leaves archived workspaces out of where a new skill can be written', () => {
    expect(skillTargets([live, old]).map((workspace) => workspace.id)).toEqual(['live']);
  });

  it('names a workspace by its name, adds the branch when different, and marks an archived one', () => {
    expect(scopeLabel(live)).toBe('Live work (feat/live)');
    expect(scopeLabel(old)).toBe('Old · archived');
    expect(scopeLabel({ id: 'bare', branchName: 'bare' })).toBe('bare');
  });
});
