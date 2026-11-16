import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearNotesView, commitNotesOf, noteAuthorName, noteCountText, notesOfCommit, requestNotesView, takeNotesView } from './commitNotes.js';
import type { BoardCard } from './boardData.js';

const SHA = '3bc923fabcdef0123456789abcdef0123456789a';
const card = (id: string, fields: Partial<BoardCard> & { about?: string } = {}): BoardCard => ({
  id, kind: 'note', title: `Note ${id}`, body: 'text', pinned: false, archived: false, by: 'claude', at: '2026-11-14T10:00:00.000Z', updatedBy: 'claude', updatedAt: '2026-11-14T10:00:00.000Z', ...fields,
}) as BoardCard;

describe('commitNotesOf', () => {
  it('keeps only live notes about a commit, newest first, the later one first on equal times', () => {
    const notes = commitNotesOf([
      card('a', { about: `commit:billing:${SHA}`, at: '2026-11-14T10:00:00.000Z' }),
      card('b', { about: `commit:billing:${SHA}`, at: '2026-11-14T11:00:00.000Z' }),
      card('c', { about: `commit:billing:${SHA}`, at: '2026-11-14T10:00:00.000Z' }),
      card('d', { about: `commit:billing:${SHA}`, archived: true }),
      card('e'),
      { ...card('f'), kind: 'file', path: 'a.png', description: '' } as BoardCard,
    ]);
    expect(notes.map((note) => note.id)).toEqual(['b', 'c', 'a']);
    expect(notes[0]).toMatchObject({ repo: 'billing', sha: SHA, title: 'Note b', by: 'claude' });
  });

  it('copes with no cards', () => {
    expect(commitNotesOf(undefined)).toEqual([]);
  });
});

describe('notesOfCommit', () => {
  const notes = commitNotesOf([card('a', { about: `commit:billing:${SHA}` }), card('b', { about: `commit:other:${SHA}` })]);

  it('matches a short or a full sha in the same repository only', () => {
    expect(notesOfCommit(notes, 'billing', SHA.slice(0, 7)).map((note) => note.id)).toEqual(['a']);
    expect(notesOfCommit(notes, 'billing', SHA).map((note) => note.id)).toEqual(['a']);
    expect(notesOfCommit(notes, 'other', SHA.slice(0, 9)).map((note) => note.id)).toEqual(['b']);
    expect(notesOfCommit(notes, 'billing', '3bc9240')).toEqual([]);
    expect(notesOfCommit(notes, 'billing', '3bc92')).toEqual([]);
  });
});

describe('words', () => {
  it('counts and names', () => {
    expect(noteCountText(1)).toBe('1 note');
    expect(noteCountText(2)).toBe('2 notes');
    expect(noteAuthorName('ai')).toBe('AI');
    expect(noteAuthorName('claude')).toBe('Claude');
  });
});

describe('the request to show the notes', () => {
  it('is used once, only for its own commit', () => {
    clearNotesView();
    requestNotesView('billing', SHA.slice(0, 7));
    expect(takeNotesView('billing', 'ffffff0')).toBe(false);
    expect(takeNotesView('other', SHA)).toBe(false);
    expect(takeNotesView('billing', SHA)).toBe(true);
    expect(takeNotesView('billing', SHA)).toBe(false);
  });
});

describe('the request to show the notes, over time', () => {
  afterEach(() => { vi.useRealTimers(); clearNotesView(); });

  it('runs out after 15 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
    requestNotesView('billing', SHA);
    vi.setSystemTime(new Date('2026-11-14T10:00:14Z'));
    expect(takeNotesView('billing', SHA)).toBe(true);
    requestNotesView('billing', SHA);
    vi.setSystemTime(new Date('2026-11-14T10:00:30Z'));
    expect(takeNotesView('billing', SHA)).toBe(false);
  });
});
