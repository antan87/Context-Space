import { describe, expect, it } from 'vitest';
import { workspaceTitle } from './workspaceTitle.js';

describe('the name a workspace goes by on the Overview', () => {
  it('is the name the developer gave it, then its name, then a description short enough to read as one', () => {
    expect(workspaceTitle({ name: 'Redo GUI', description: 'Make it easy', branchName: 'redo-gui' }, ' Palette work ')).toBe('Palette work');
    expect(workspaceTitle({ name: 'Redo GUI', description: 'Make it easy', branchName: 'redo-gui' })).toBe('Redo GUI');
    expect(workspaceTitle({ name: '', description: 'CSV export\n\nThe longer story', branchName: 'csv' })).toBe('CSV export');
  });

  it('is the branch in words when the description is a paragraph', () => {
    const description = 'The logic for need you and milestones is so cluttery and the user quickly loses all control and understanding.';
    expect(workspaceTitle({ name: '', description, branchName: 'feat/simplify-the-logic' })).toBe('Simplify the logic');
    expect(workspaceTitle({ name: '', description: '', branchName: 'costizing_poc' })).toBe('Costizing poc');
  });
});
