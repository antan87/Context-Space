import { expect, it, vi } from 'vitest';
import * as jump from './codeNoteJump.js';
const note = { line: 12, endLine: 14, anchor: 'twelve\nthirteen\nfourteen', anchorCut: false };
it('reveals, selects and highlights the placed first line when a requested note moved', () => {
  const content = Array.from({ length: 14 }, (_, i) => ['twelve', 'thirteen', 'fourteen'][i - 11] ?? String(i + 1)).join('\n');
  const editor = { revealLineInCenter: vi.fn(), setPosition: vi.fn() };
  expect(jump.codeNoteJumpLine(12, note, 'insert\ninsert\ninsert\n'+content)).toBe(15);
  jump.revealCodeNoteJump(editor, 12, note, 'insert\ninsert\ninsert\n'+content);
  expect(editor.revealLineInCenter).toHaveBeenCalledWith(15);
  expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 15, column: 1 });
});
it('uses the same clamped location as the marker when the note changed or file shortened', () => {
  expect(jump.codeNoteJumpLine(12, note, 'short\nfile')).toBe(2);
});
it('retains ordinary file jumps and has no old-line jump while a note request is loading', () => {
  expect(jump.codeNoteJumpLine(12, undefined, 'one\ntwo')).toBe(2);
  expect(jump.codeNoteJumpLine(12, undefined, 'one\ntwo', true)).toBeUndefined();
});
