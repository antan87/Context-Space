import { describe, it, expect } from 'vitest';
describe('Code file point and ask', () => {
  it.each([
    [12, 1, 18, 1, { line: 12, endLine: 17 }],
    [12, 2, 18, 4, { line: 12, endLine: 18 }],
    [12, 1, 12, 1, null],
    [12, 1, 12, 4, { line: 12, endLine: 12 }],
  ])('maps Monaco selection %i:%i..%i:%i', async (startLineNumber, startColumn, endLineNumber, endColumn, range) => {
    const { monacoSelectionLines } = await import('./codeLineNotes.js');
    expect(monacoSelectionLines({ startLineNumber, startColumn, endLineNumber, endColumn })).toEqual(range);
  });
  it.each(['guide.md', 'config.json', 'data.yaml', 'config.toml', 'report.xml', 'notes.txt', 'chart.svg'])('keeps reader-supported %s in the reader', async path => {
    const { lineNoteViewer } = await import('./codeLineNotes.js');
    expect(lineNoteViewer(path)).toBe('reader');
  });
  it.each(['src/values.ts', 'index.py', 'Makefile', 'src/main.rs', 'main.cpp'])('routes %s to Code without widening reader types', async path => {
    const { lineNoteViewer } = await import('./codeLineNotes.js');
    expect(lineNoteViewer(path)).toBe('code');
  });
});
