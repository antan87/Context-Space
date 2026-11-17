import { describe, expect, it } from 'vitest';
const note = { line: 2, endLine: 3, anchor: 'two\nthree', anchorCut: false };
describe('line note placement', () => {
  it.each([
    ['same', 'one\ntwo\nthree\nfour', note, { status: 'same', line: 2, endLine: 3 }],
    ['nearest match', 'two\nthree\nx\ntwo\nthree', { ...note, line: 4, endLine: 5 }, { status: 'same', line: 4, endLine: 5 }],
    ['moved nearest of two', 'two\nthree\nx\nx\ntwo\nthree', { ...note, line: 4, endLine: 5 }, { status: 'moved', line: 5, endLine: 6 }],
    ['changed', 'one\nchanged\nthree', note, { status: 'changed', line: 2, endLine: 3 }],
    ['shorter file', 'one', note, { status: 'changed', line: 1, endLine: 1 }],
    ['empty anchor', 'one\ntwo', { ...note, anchor: '' }, { status: 'changed', line: 2, endLine: 2 }],
    ['CRLF', 'one\r\ntwo\r\nthree\r\n', note, { status: 'same', line: 2, endLine: 3 }],
  ])('%s', async (_label, text, anchor, expected) => {
    const { placeLineNote } = await import('./lineNotes.js');
    expect(placeLineNote(anchor, text)).toEqual(expected);
  });
  it.each([[12, 12, 'line 12'], [12, 18, 'lines 12-18']])('terminal text %i..%i never submits', async (line, endLine, label) => {
    const { pointAndAskText } = await import('./lineNotes.js');
    const text = pointAndAskText('NexusFlow/src/x.ts', line, endLine);
    expect(text).toBe(`About NexusFlow/src/x.ts ${label} (when you answer, also pin a short answer to these lines with annotate_document): `);
    expect(text).not.toMatch(/[\r\n]/);
    expect(pointAndAskText('a\n\rb', line, endLine)).not.toMatch(/[\r\n]/);
  });
  it('maps rendered Markdown blocks to their source positions, not display rows', async () => {
    const { sourceLineRange } = await import('./lineNotes.js');
    expect(sourceLineRange({ start: { line: 7 }, end: { line: 11 } })).toEqual({ line: 7, endLine: 11 });
    expect(sourceLineRange(undefined)).toBeNull();
  });
});
