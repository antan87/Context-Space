import { describe, expect, it } from 'vitest';

import { matchesKnowledge, parseKnowledge, readableTitle } from './knowledgeEntries.js';

const FILE = `# Workspace Knowledge — redo-gui

> Accumulated decisions and gotchas for this feature. Append with
> \`ctxspace knowledge add -t decision|gotcha --title "..." -m "..."\`.

## Feature Goal

I mostly use the chat cli.

We need a major refactor of the UX.

## Architecture Decisions

### 2026-10-02 — chat-first-workspace-layout
**Decision:** The chat stays the real terminal and docks as the workspace centre.
**Scope:** \`path:NexusFlow/gui/src\`

### 2026-10-04 — a-rail-beside-the-panel-not-a-header-menu
**Decision:** What opens beside the chat is a rail at the right edge.
It replaces the header menu.
**Scope:** \`path:NexusFlow/gui/src/features/workspace-shell/WorkspaceRail.tsx\`
**Evidence:** commit 9b73c92

## Team notes

We pair on the terminal work.
Ask before touching the release scripts.

## Known Gotchas

### 2026-10-03 — tablist-may-hold-only-tabs
**Gotcha:** A role=tablist may hold only tabs.
**Evidence:** commit 0592f87

### 2026-10-03 — an entry written by hand
Plain text without a label, under the gotchas.
`;

describe('parseKnowledge', () => {
  const parsed = parseKnowledge(FILE);

  it('reads every entry, newest first, with its kind, text, scope and evidence', () => {
    expect(parsed.entries.map((entry) => entry.title)).toEqual([
      'a-rail-beside-the-panel-not-a-header-menu', 'an entry written by hand', 'tablist-may-hold-only-tabs', 'chat-first-workspace-layout',
    ]);
    expect(parsed.entries[0]).toMatchObject({
      date: '2026-10-04', kind: 'decision', text: 'What opens beside the chat is a rail at the right edge.\nIt replaces the header menu.',
      scope: 'NexusFlow/gui/src/features/workspace-shell/WorkspaceRail.tsx', evidence: 'commit 9b73c92',
    });
    expect(parsed.entries[2]).toMatchObject({ kind: 'gotcha', text: 'A role=tablist may hold only tabs.', evidence: 'commit 0592f87' });
    expect(parsed.entries[2]!.scope).toBeUndefined();
  });

  it('takes the kind from its section when an entry does not say, and keeps its plain text', () => {
    expect(parsed.entries[1]).toMatchObject({ kind: 'gotcha', text: 'Plain text without a label, under the gotchas.' });
  });

  it('keeps the feature goal apart from the entries, and leaves out the file header', () => {
    expect(parsed.goal).toBe('I mostly use the chat cli.\nWe need a major refactor of the UX.');
    expect(parsed.entries.some((entry) => entry.text.includes('Accumulated'))).toBe(false);
  });

  it('keeps writing under other sections that is not an entry, so nothing in the file goes unseen', () => {
    expect(parsed.sections).toEqual([{ title: 'Team notes', text: 'We pair on the terminal work.\nAsk before touching the release scripts.' }]);
  });

  it('reads a file with no entries, or none at all, as empty', () => {
    expect(parseKnowledge('# Just a title\n\nSome prose.').entries).toEqual([]);
    expect(parseKnowledge('')).toEqual({ goal: '', entries: [], sections: [] });
  });
});

describe('readableTitle', () => {
  it('turns a slug into words and keeps a title that already is words', () => {
    expect(readableTitle('chat-first-workspace-layout')).toBe('Chat first workspace layout');
    expect(readableTitle('Already a title')).toBe('Already a title');
    expect(readableTitle('one')).toBe('One');
  });

  it('keeps a title written as words exactly, capitals, dots, apostrophes and hyphens included', () => {
    for (const title of ["PLAN.md has its own lock, apart from the AI's loop", 'Re-run', 'iOS notes', 'README']) {
      expect(readableTitle(title), title).toBe(title);
    }
  });
});

describe('matchesKnowledge', () => {
  const entry = parseKnowledge(FILE).entries[0]!;
  it('finds an entry by its title as words, its text, scope or evidence, ignoring case', () => {
    expect(matchesKnowledge(entry, 'rail beside')).toBe(true);
    expect(matchesKnowledge(entry, 'HEADER MENU')).toBe(true);
    expect(matchesKnowledge(entry, 'WorkspaceRail')).toBe(true);
    expect(matchesKnowledge(entry, '9b73c92')).toBe(true);
    expect(matchesKnowledge(entry, 'terminal')).toBe(false);
    expect(matchesKnowledge(entry, '  ')).toBe(true);
  });
});
