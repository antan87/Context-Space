import type { LineRange } from '../board/lineNotes.js';

/** Monaco normalizes backward selections. Column 1 of the next line is an exclusive end. */
export function monacoSelectionLines(selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null): LineRange | null {
  if (!selection || selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn) return null;
  return { line: selection.startLineNumber, endLine: Math.max(selection.startLineNumber, selection.endLineNumber - (selection.endColumn === 1 ? 1 : 0)) };
}

/** Matches root-documents.format's existing types. This chooses a destination, never broadens the reader. */
export function lineNoteViewer(path: string): 'reader' | 'code' {
  return /\.(?:md|markdown|mdx|txt|rst|adoc|csv|tsv|log|mmd|json|yaml|yml|toml|xml|html?|pdf|png|jpe?g|gif|webp|svg|docx?|odt|rtf|xlsx?|ods|pptx?|odp)$/i.test(path) ? 'reader' : 'code';
}
