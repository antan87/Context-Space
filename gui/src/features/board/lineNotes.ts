export interface LineNote {
  id: string; path: string; repo?: string; line: number; endLine: number; text: string;
  tag: 'question' | 'risk' | 'todo'; harness: string; createdAt: string; doneAt?: string;
  anchor: string; anchorCut: boolean;
}
export interface LineRange { line: number; endLine: number }
export function sourceLineRange(position: { start: { line: number }; end: { line: number } } | undefined): LineRange | null {
  return position ? { line: position.start.line, endLine: position.end.line } : null;
}
export function pointAndAskText(path: string, line: number, endLine: number): string {
  return `About ${Array.from(path, c => { const n = c.charCodeAt(0); return n < 32 || n >= 127 && n <= 159 ? ' ' : c; }).join('')} ${line === endLine ? `line ${line}` : `lines ${line}-${endLine}`} (when you answer, also pin a short answer to these lines with annotate_document): `;
}
export function placeLineNote(note: Pick<LineNote, 'line' | 'endLine' | 'anchor' | 'anchorCut'>, text: string): LineRange & { status: 'same' | 'moved' | 'changed' } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const anchor = note.anchor.replace(/\r\n/g, '\n');
  const needle = anchor.split('\n');
  // A capped anchor follows its saved prefix; the original range length is retained.
  if (anchor) {
    const matches: number[] = [];
    for (let i = 0; i <= lines.length - needle.length; i++) {
      if (note.anchorCut ? lines.slice(i, i + needle.length).join('\n').startsWith(anchor) : needle.every((line, j) => lines[i + j] === line)) matches.push(i + 1);
    }
    matches.sort((a, b) => Math.abs(a - note.line) - Math.abs(b - note.line) || a - b);
    const line = matches[0];
    if (line !== undefined) return { line, endLine: Math.min(lines.length, line + note.endLine - note.line), status: line === note.line ? 'same' : 'moved' };
  }
  const line = Math.max(1, Math.min(note.line, lines.length));
  return { line, endLine: Math.max(line, Math.min(note.endLine, lines.length)), status: 'changed' };
}

/** Endpoints must both be in one source body; rendered blocks carry source positions from react-markdown. */
export function selectionLines(body: HTMLElement, selection: Selection | null): LineRange | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
  const endpoint = (node: Node, offset: number, end: boolean) => {
    const el = node.nodeType === 1 ? node as Element : node.parentElement;
    const block = el?.closest<HTMLElement>('[data-source-line]');
    if (!block || !body.contains(block) || el?.closest('[data-line-note-ui]')) return null;
    // A selection ending at the start of the next source line doesn't include that line.
    const line = Number(end ? block.dataset.sourceEnd ?? block.dataset.sourceLine : block.dataset.sourceLine);
    return end && offset === 0 && block.dataset.sourceSingle !== undefined ? Math.max(1, line - 1) : line;
  };
  const line = endpoint(range.startContainer, range.startOffset, false);
  const endLine = endpoint(range.endContainer, range.endOffset, true);
  return line && endLine ? { line, endLine: Math.max(line, endLine) } : null;
}
