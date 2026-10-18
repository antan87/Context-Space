import { describe, expect, it } from 'vitest';
import { SECTION_LABELS, parseSection, railSectionsFor, visibleSection } from './destinations.js';

describe('workspace sections', () => {
  it('name every section once', () => {
    expect(Object.keys(SECTION_LABELS).sort()).toEqual(['changes', 'chat', 'documents', 'knowledge', 'overview', 'plan', 'services', 'sessions', 'skills']);
  });

  it('keep old tab URLs working', () => {
    for (const legacy of ['overview', 'plan', 'documents', 'changes', 'services', 'sessions', 'knowledge', 'skills']) {
      expect(parseSection(legacy)).toBe(legacy);
    }
    // An unknown segment lands on the overview. No segment at all opens the plan, the workspace's home.
    expect(parseSection('diff')).toBe('overview');
    expect(parseSection(undefined)).toBe('plan');
    expect(parseSection(null)).toBe('plan');
    expect(parseSection('')).toBe('plan');
    expect(parseSection('chat')).toBe('chat');
  });

  it('show an archived workspace only its record', () => {
    // A deep link to a working section of an archived workspace lands on its overview.
    expect(visibleSection('changes', true)).toBe('overview');
    expect(visibleSection('sessions', true)).toBe('overview');
    // An archived workspace has no chat: a link with no section opens its plan, and one to the chat shows its record.
    expect(visibleSection(parseSection(undefined), true)).toBe('plan');
    expect(visibleSection('chat', true)).toBe('overview');
    expect(visibleSection('chat', false)).toBe('chat');
    expect(visibleSection('knowledge', true)).toBe('knowledge');
    expect(visibleSection('changes', false)).toBe('changes');
  });
});

describe('railSectionsFor', () => {
  it('offers the parts a developer works in, and no place for the chat, the overview, knowledge, sessions or skills', () => {
    expect(railSectionsFor(false)).toEqual(['plan', 'changes', 'documents', 'services']);
    for (const gone of ['chat', 'overview', 'knowledge', 'sessions', 'skills'] as const) expect(railSectionsFor(false)).not.toContain(gone);
  });

  it('keeps old addresses working: every section still parses to itself, on the rail or not', () => {
    for (const section of ['overview', 'sessions', 'skills', 'knowledge', 'services', 'plan'] as const) expect(parseSection(section)).toBe(section);
    // Not on the rail does not mean hidden: an active workspace still shows them.
    expect(visibleSection('sessions', false)).toBe('sessions');
    expect(visibleSection('skills', false)).toBe('skills');
  });

  it('shows an archived workspace its record, its plan and its documents, and nothing to act on', () => {
    expect(railSectionsFor(true)).toEqual(['overview', 'plan', 'documents']);
    // Its knowledge is still open to read, in Docs or at its old address.
    expect(visibleSection('knowledge', true)).toBe('knowledge');
  });
});
