import { describe, expect, it } from 'vitest';

import { archivedTabs, defaultWorkspaceTarget, isArchivedWorkspace, jumpTargets, workspacesForList } from './workspaceList.js';

const workspace = (branchName: string, extra: Record<string, unknown> = {}) => ({
  branchName, name: branchName, description: '', repos: [] as string[], ...extra,
});

const active = workspace('feat/alpha', { description: 'invoice export', repos: ['/dev/billing'] });
const archived = workspace('feat/old-beta', { description: 'retired work', repos: ['/dev/web'], archivedAt: '2026-09-28T10:00:00Z' });
const all = [active, archived];

describe('isArchivedWorkspace', () => {
  it('is true only for a workspace with an archive date', () => {
    expect(isArchivedWorkspace(archived)).toBe(true);
    expect(isArchivedWorkspace(active)).toBe(false);
    expect(isArchivedWorkspace(null)).toBe(false);
    expect(isArchivedWorkspace(undefined)).toBe(false);
  });
});

describe('jumpTargets', () => {
  it('puts active workspaces first, keeps each group in its order, and marks the archived ones', () => {
    const second = workspace('feat/second', { repos: ['/dev/a', '/dev/b'] });
    const targets = jumpTargets([archived, active, second]);

    expect(targets.map((target) => target.route)).toEqual(['/workspaces/feat%2Falpha', '/workspaces/feat%2Fsecond', '/workspaces/feat%2Fold-beta']);
    expect(targets[2]!.detail).toMatch(/^Archived · /);
    expect(targets[0]!.detail).not.toMatch(/Archived/);
    expect(targets[1]!.detail).toBe('2 repositories · feat/second');
  });

  it('is found by typing "archived" in the detail, and handles an empty list', () => {
    expect(jumpTargets([active, archived]).filter((target) => `${target.title} ${target.detail}`.toLowerCase().includes('archived'))).toHaveLength(1);
    expect(jumpTargets([])).toEqual([]);
  });
});

describe('workspacesForList', () => {
  it('lists the active workspaces, or the archived ones, when there is no search', () => {
    expect(workspacesForList(all, false, '')).toEqual([active]);
    expect(workspacesForList(all, true, '')).toEqual([archived]);
    expect(workspacesForList(all, true, '   ')).toEqual([archived]);
  });

  it('searches both lists, so an active workspace is found from the archived list and back', () => {
    expect(workspacesForList(all, true, 'alpha')).toEqual([active]);
    expect(workspacesForList(all, false, 'old-beta')).toEqual([archived]);
  });

  it('matches on name, branch, description and repository, ignoring case', () => {
    expect(workspacesForList(all, false, 'INVOICE')).toEqual([active]);
    expect(workspacesForList(all, false, 'billing')).toEqual([active]);
    expect(workspacesForList(all, false, 'retired')).toEqual([archived]);
    expect(workspacesForList(all, false, '/dev/web')).toEqual([archived]);
  });

  it('finds nothing for text that is in neither list, and does not throw on missing fields', () => {
    expect(workspacesForList(all, false, 'nowhere')).toEqual([]);
    expect(workspacesForList([{ branchName: 'bare', description: undefined, name: undefined, repos: undefined } as never], false, 'bare')).toHaveLength(1);
    expect(workspacesForList([], true, '')).toEqual([]);
  });
});

describe('defaultWorkspaceTarget', () => {
  const ids = ['alpha', 'beta', 'gamma'];

  it('stays on the workspace being read while it still exists', () => {
    expect(defaultWorkspaceTarget(ids, 'beta', 'gamma', ['gamma'])).toBe('beta');
  });

  it('does not return to a workspace that is gone or archived, but goes to the chat the person was last in', () => {
    // After a delete the address still names the deleted workspace for a moment.
    expect(defaultWorkspaceTarget(['alpha', 'gamma'], 'beta', 'gamma', ['gamma', 'alpha'])).toBe('gamma');
    expect(defaultWorkspaceTarget(['alpha', 'gamma'], 'old-archived', null, ['alpha'])).toBe('alpha');
  });

  it('falls back to the first active workspace, and to none when there is none', () => {
    expect(defaultWorkspaceTarget(ids, 'deleted', 'also-deleted', ['also-deleted'])).toBe('alpha');
    expect(defaultWorkspaceTarget(ids, null, null, [])).toBe('alpha');
    expect(defaultWorkspaceTarget([], 'deleted', 'deleted', ['deleted'])).toBeNull();
    expect(defaultWorkspaceTarget([], null, null, [])).toBeNull();
  });
});

describe('archivedTabs', () => {
  const list = [
    { id: 'a', branchName: 'feat/alpha' },
    { id: 'old', branchName: 'feat/old', archivedAt: '2026-09-28T10:00:00Z' },
    { id: 'older', branchName: 'older', archivedAt: '2026-09-01T10:00:00Z' },
  ];

  it('names the open tabs of archived workspaces, by branch or by id, in the order they are open', () => {
    expect(archivedTabs(['feat/alpha', 'older', 'feat/old'], list)).toEqual(['older', 'feat/old']);
    expect(archivedTabs(['old'], list)).toEqual(['old']);
  });

  it('leaves active, unknown and no tabs alone', () => {
    expect(archivedTabs(['feat/alpha', 'ghost'], list)).toEqual([]);
    expect(archivedTabs([], list)).toEqual([]);
    expect(archivedTabs(['feat/old'], [])).toEqual([]);
  });
});
