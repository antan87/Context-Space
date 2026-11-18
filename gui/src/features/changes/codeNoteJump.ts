import { placeLineNote, type LineNote } from '../board/lineNotes.js';
type Anchor = Pick<LineNote, 'line' | 'endLine' | 'anchor' | 'anchorCut'>;
export function codeNoteJumpLine(targetLine: number | undefined, note: Anchor | undefined, content: string, pendingNote = false): number | undefined {
  if (note) return placeLineNote(note, content).line;
  if (pendingNote || !targetLine || targetLine < 1) return undefined;
  return Math.min(targetLine, content.replace(/\r\n/g, '\n').split('\n').length);
}
export function revealCodeNoteJump(editor: { revealLineInCenter: (line: number) => void; setPosition: (position: { lineNumber: number; column: number }) => void }, targetLine: number | undefined, note: Anchor | undefined, content: string, pendingNote = false): number | undefined {
  const line = codeNoteJumpLine(targetLine, note, content, pendingNote);
  if (line !== undefined) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); }
  return line;
}
