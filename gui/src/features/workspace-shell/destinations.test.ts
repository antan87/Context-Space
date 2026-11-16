import { describe, expect, it } from 'vitest';
import { SECTION_LABELS, knowledgeRedirect, parseSection, railSectionsFor, visibleSection } from './destinations.js';

describe('workspace sections', () => {
  it('name every section once', () => {
    expect(Object.keys(SECTION_LABELS).sort()).toEqual(['board', 'changes', 'chat', 'documents', 'overview', 'plan', 'services', 'sessions', 'skills']);
    expect(SECTION_LABELS.changes).toBe('Review');
  });

  it('keep old tab URLs working, aliasing deprecated sections to board', () => {
    for (const active of ['overview', 'board', 'sessions', 'skills']) {
      expect(parseSection(active)).toBe(active);
    }
    // Plan, changes, documents, and services tabs are deprecated and alias to board
    expect(parseSection('plan')).toBe('board');
    expect(parseSection('changes')).toBe('board');
    expect(parseSection('documents')).toBe('board');
    expect(parseSection('services')).toBe('board');
    // The Knowledge tab is gone too: its old address opens the board, with Knowledge open in the reader (see knowledgeRedirect)
    expect(parseSection('knowledge')).toBe('board');
    // An unknown segment lands on the overview. No segment at all opens the board, the workspace's home.
    expect(parseSection('diff')).toBe('overview');
    expect(parseSection(undefined)).toBe('board');
    expect(parseSection(null)).toBe('board');
    expect(parseSection('')).toBe('board');
    expect(parseSection('chat')).toBe('chat');
  });

  it('show an archived workspace only its record and board', () => {
    // A deep link to a working section of an archived workspace lands on its overview.
    expect(visibleSection('changes', true)).toBe('overview');
    expect(visibleSection('sessions', true)).toBe('overview');
    // An archived workspace has no chat: a link with no section opens its board, and one to the chat shows its record.
    expect(visibleSection(parseSection(undefined), true)).toBe('board');
    expect(visibleSection('chat', true)).toBe('overview');
    expect(visibleSection('chat', false)).toBe('chat');
    expect(visibleSection(parseSection('knowledge'), true)).toBe('board');
    expect(visibleSection('board', true)).toBe('board');
    expect(visibleSection('changes', false)).toBe('changes');
  });
});

describe('railSectionsFor', () => {
  it('offers the parts a developer works in: streamlined to overview, board, sessions, and skills', () => {
    expect(railSectionsFor(false)).toEqual([
      'overview',
      'board',
      'sessions',
      'skills',
    ]);
    expect(railSectionsFor(false)).not.toContain('plan');
    expect(railSectionsFor(false)).not.toContain('chat');
    expect(railSectionsFor(false)).not.toContain('changes');
    expect(railSectionsFor(false)).not.toContain('documents');
    expect(railSectionsFor(false)).not.toContain('services');
    expect(railSectionsFor(false)).not.toContain('knowledge');
  });

  it('puts the board right after overview, and keeps it on archived rail', () => {
    const rail = railSectionsFor(false);
    expect(rail.indexOf('board')).toBe(rail.indexOf('overview') + 1);
    expect(SECTION_LABELS.board).toBe('Board');
    expect(railSectionsFor(true)).toContain('board');
    // A link to the board of an archived workspace lands on the board.
    expect(visibleSection('board', true)).toBe('board');
    expect(visibleSection('board', false)).toBe('board');
  });

  it('keeps old addresses working: active sections parse to themselves, deprecated alias to board', () => {
    for (const section of ['overview', 'sessions', 'skills', 'board'] as const) expect(parseSection(section)).toBe(section);
    expect(parseSection('plan')).toBe('board');
    expect(parseSection('services')).toBe('board');
    // Not on the rail does not mean hidden: an active workspace still shows them.
    expect(visibleSection('sessions', false)).toBe('sessions');
    expect(visibleSection('skills', false)).toBe('skills');
  });

  it('shows an archived workspace its record and its board, and nothing to act on', () => {
    expect(railSectionsFor(true)).toEqual(['overview', 'board']);
    // Its knowledge is still open to read: its old address opens the board with Knowledge in the reader.
    expect(knowledgeRedirect('/workspaces/old-one/knowledge')).not.toBeNull();
    expect(visibleSection(parseSection('knowledge'), true)).toBe('board');
  });

  it('sends the old Knowledge address to the board, and only that address', () => {
    expect(knowledgeRedirect('/workspaces/demo/knowledge')).toEqual({ workspaceId: 'demo', to: '/workspaces/demo/board' });
    // The id keeps its encoding in the address and is decoded for the request
    expect(knowledgeRedirect('/workspaces/feat%2Fone/knowledge')).toEqual({ workspaceId: 'feat/one', to: '/workspaces/feat%2Fone/board' });
    for (const other of ['/workspaces/demo/board', '/workspaces/demo/documents', '/workspaces/demo', '/workspaces/demo/knowledge-base', '/workspaces/knowledge', '/settings/knowledge', '/knowledge']) {
      expect(knowledgeRedirect(other)).toBeNull();
    }
  });
});
