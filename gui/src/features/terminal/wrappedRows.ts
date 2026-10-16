/**
 * A CLI that wraps its own output ends a row with a real line break, not the soft wrap xterm joins by itself. A long URL
 * or path then arrives in two rows, and each half alone names the wrong page or file. A row continues into the next one
 * only when it ends with a path or URL that reaches the last column and the next row goes on with more of it, which a
 * sentence that merely ends at the edge does not.
 */
const PATH_OR_URL = /^[\w\-.~%+@:#?&=,;!*'()[\]$/\\]+$/;

/**
 * How many leading blanks of `next` to skip when it continues `previous`, or null when it starts a new line.
 * Both are the row's text with trailing blanks removed; `cols` is the width of the terminal.
 */
export function hardWrapSkip(previous: string, next: string, cols: number): number | null {
  if (cols < 2 || previous.length < cols) return null;
  const tail = /\S+$/.exec(previous)?.[0] ?? '';
  if (!tail.includes('/') || !PATH_OR_URL.test(tail)) return null;
  const skip = /^ */.exec(next)?.[0].length ?? 0;
  const head = /^\S+/.exec(next.slice(skip))?.[0] ?? '';
  // A list marker (`-`, `*`, `1.`) at the start of the next row begins a new item.
  return head && PATH_OR_URL.test(head) && /[a-z\d]/i.test(head) && !/^\d+[.)]$/.test(head) ? skip : null;
}
