import { describe, expect, it } from 'vitest';
import { filesChangedText, plusMinusText, summarizeChanges, totalLine } from './changeSummary.js';

const repo = (files: { file: string; type?: string; additions?: number; deletions?: number }[]) =>
  ({ repoName: 'app', repoPath: '/r', files: files.map((f) => ({ type: 'modified', ...f })) });

describe('change summary', () => {
  it('counts files and lines, and names the first files', () => {
    const s = summarizeChanges([repo([{ file: 'a/one.ts', additions: 10, deletions: 2 }, { file: 'two.ts', additions: 5, deletions: 0 }, { file: 'x/y/three.ts' }, { file: 'four.ts' }])]);
    expect(s.files).toBe(4);
    expect([s.additions, s.deletions]).toEqual([15, 2]);
    expect(s.repos[0]).toMatchObject({ files: 4, additions: 15, deletions: 2, names: ['one.ts', 'two.ts', 'three.ts'], firstFile: 'a/one.ts' });
  });
  it('leaves out clean repositories and unchanged rows, and has no numbers when the listing has none', () => {
    const s = summarizeChanges([repo([]), repo([{ file: 'z', type: 'unchanged' }]), repo([{ file: 'q.ts' }])]);
    expect(s.repos).toHaveLength(1);
    expect(s.additions).toBeUndefined();
    expect(plusMinusText(s.additions, s.deletions)).toBe('');
    expect(summarizeChanges(undefined).files).toBe(0);
  });
  it('words', () => {
    expect(filesChangedText(1)).toBe('1 file changed');
    expect(filesChangedText(3)).toBe('3 files changed');
    expect(plusMinusText(120, 40)).toBe('+120 −40');
    expect(plusMinusText(0, 0)).toBe('');
    expect(totalLine(13, 420, 96)).toBe('13 changed files · +420 −96');
    expect(totalLine(1)).toBe('1 changed file');
  });
});
