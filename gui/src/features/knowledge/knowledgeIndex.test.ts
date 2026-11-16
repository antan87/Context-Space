import { describe, expect, it } from 'vitest';

import { parseKnowledge } from './knowledgeEntries.js';
import { entryKey, isKnowledgeFile, knowledgeCountText, knowledgeNavItems, knowledgeNewText, newsEntryKey } from './knowledgeIndex.js';

const FILE = `# Workspace Knowledge

## Decisions

### 2026-11-12 — use-available-models
**Decision:** Sonnet builds, Opus reviews.

### 2026-11-13 — Gemini 4 Hydrogen is a main builder
**Decision:** It runs through agy.

## Gotchas

### 2026-11-13 — build-gui-to-scratch-while-preview-is-running
**Gotcha:** A plain build deletes the live dist.
`;
const entries = parseKnowledge(FILE).entries;

describe('the words of the index entry', () => {
  it('counts entries, with the singular and the empty file', () => {
    expect(knowledgeCountText(24)).toBe('24 entries');
    expect(knowledgeCountText(1)).toBe('1 entry');
    expect(knowledgeCountText(0)).toBe('No entries yet');
  });

  it('says how many are new only when some are', () => {
    expect(knowledgeNewText(3)).toBe('3 new');
    expect(knowledgeNewText(0)).toBe('');
  });
});

describe('knowledge found by a search', () => {
  it('finds entries by the words of their title, whether written as a slug or as words, newest first', () => {
    expect(knowledgeNavItems(entries, 'gui').map((item) => item.title)).toEqual(['Build gui to scratch while preview is running']);
    expect(knowledgeNavItems(entries, 'HYDROGEN')).toEqual([{ key: entryKey(entries.find((entry) => entry.title.startsWith('Gemini'))!), title: 'Gemini 4 Hydrogen is a main builder', subtitle: 'Decision · 2026-11-13' }]);
    expect(knowledgeNavItems(entries, 'use available').map((item) => item.title)).toEqual(['Use available models']);
  });

  it('does not search the text of an entry, only its title, and finds nothing for an empty search', () => {
    expect(knowledgeNavItems(entries, 'deletes the live dist')).toEqual([]);
    expect(knowledgeNavItems(entries, '   ')).toEqual([]);
  });

  it('gives each entry a key that is the same when the file is read again', () => {
    expect(entries.map(entryKey)).toEqual(parseKnowledge(FILE).entries.map(entryKey));
    expect(new Set(entries.map(entryKey)).size).toBe(entries.length);
  });
});

describe('the entry a news line is about', () => {
  it('is found by its day and title, as the news writes them', () => {
    const wanted = entries.find((entry) => entry.title.startsWith('build-gui'))!;
    expect(newsEntryKey(entries, { title: 'Build gui to scratch while preview is running', date: '2026-11-13' })).toBe(entryKey(wanted));
    expect(newsEntryKey(entries, { title: 'Gemini 4 Hydrogen is a main builder', date: '2026-11-13' })).toBe(entryKey(entries.find((entry) => entry.title.startsWith('Gemini'))!));
  });

  it('is none when the entry is gone, the day differs, or the file is not read yet, so the line opens the top', () => {
    expect(newsEntryKey(entries, { title: 'Something removed', date: '2026-11-13' })).toBeNull();
    expect(newsEntryKey(entries, { title: 'Use available models', date: '2026-11-13' })).toBeNull();
    expect(newsEntryKey([], { title: 'Use available models', date: '2026-11-12' })).toBeNull();
  });
});

describe('which file is the knowledge', () => {
  it('is the knowledge file of the workspace, named alone or in the workspace folder, and no other file or repository', () => {
    expect(isKnowledgeFile('contextspace-knowledge.md')).toBe(true);
    expect(isKnowledgeFile('nexusflow-knowledge.md')).toBe(true);
    expect(isKnowledgeFile('/work/ws/contextspace-knowledge.md', '/work/ws')).toBe(true);
    expect(isKnowledgeFile('/work/ws/contextspace-knowledge.md', '/work/ws/')).toBe(true);
    expect(isKnowledgeFile('/work/ws/contextspace-knowledge.md')).toBe(false);
    expect(isKnowledgeFile('/work/other/contextspace-knowledge.md', '/work/ws')).toBe(false);
    expect(isKnowledgeFile('docs/contextspace-knowledge.md', '/work/ws')).toBe(false);
    expect(isKnowledgeFile('PLAN.md')).toBe(false);
  });
});
