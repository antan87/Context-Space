import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'pa1-notes-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const input = { path: 'a.ts', line: 2, endLine: 3, text: 'Answer', tag: 'question' as const, harness: 'codex', anchor: 'two\nthree', anchorCut: false };
describe('lasting line notes', () => {
  it('creates a note and saves Done', async () => {
    const s = await import('./line-notes.js');
    const note = await s.addLineNote(root, input);
    expect(note).toMatchObject(input);
    expect(note.id).toBeTruthy();
    await s.finishLineNote(root, note.id);
    expect((await s.readLineNotes(root))[0].doneAt).toBeTruthy();
  });
  it('serializes two writers without losing either note', async () => {
    const s = await import('./line-notes.js');
    await Promise.all([s.addLineNote(root, input), s.addLineNote(root, { ...input, text: 'Other' })]);
    expect(await s.readLineNotes(root)).toHaveLength(2);
  });
  it('caps open notes without dropping unfinished work and drops finished first', async () => {
    const s = await import('./line-notes.js');
    const note = await s.addLineNote(root, input);
    const file = path.join(root, '.contextspace/line-notes.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, notes: Array.from({ length: s.LINE_NOTES_CAP }, (_, i) => ({ ...note, id: `n${i}`, text: `Answer ${i}` })) }));
    await expect(s.addLineNote(root, input)).rejects.toThrow(/500|limit|full/i);
    await s.finishLineNote(root, 'n0');
    await s.addLineNote(root, { ...input, text: 'Room now' });
    expect(await s.readLineNotes(root)).toHaveLength(s.LINE_NOTES_CAP);
    expect((await s.readLineNotes(root)).some(n => n.id === 'n0')).toBe(false);
  });
  it('preserves a damaged file beside the replacement', async () => {
    const s = await import('./line-notes.js');
    await fs.mkdir(path.join(root, '.contextspace'));
    await fs.writeFile(path.join(root, '.contextspace/line-notes.json'), '{broken');
    await expect(s.readLineNotes(root)).rejects.toThrow(/damaged/i);
    await s.addLineNote(root, input);
    const backup = (await fs.readdir(path.join(root, '.contextspace'))).find(n => n.includes('.damaged-'))!;
    expect(await fs.readFile(path.join(root, '.contextspace', backup), 'utf8')).toBe('{broken');
    expect(await s.readLineNotes(root)).toHaveLength(1);
  });
  it('refuses a linked state directory', async () => {
    const s = await import('./line-notes.js');
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, '.contextspace'));
    await expect(s.addLineNote(root, input)).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
