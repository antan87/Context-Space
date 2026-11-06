/**
 * Inline Markdown as plain words, for the places that cannot style it: an `aria-label`, a `title`, a one-line preview. The marks go and
 * the words stay: `**Slice A: Purge**:` is "Slice A: Purge", `` `npm test` `` is "npm test", `[docs](https://x)` is "docs". A plan heading
 * often ends with a colon that says "the steps below", so a trailing colon goes too. This is the one place that knows the marks.
 *
 * Code spans are lifted out first and put back untouched, so `` `__init__.py` `` and `` `src/**\/*.ts` `` keep every character. A mark only
 * counts when it hugs its words (a `*` with a space after it is a star), and `_` / `__` never start or end inside a word.
 */
const WORD = '\\p{L}\\p{N}_';
const MARKS = [
  [/!?\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/gu, '$1'],
  [new RegExp(`(^|[^${WORD}])__(?=\\S)(.+?)(?<=\\S)__(?![${WORD}])`, 'gu'), '$1$2'],
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, '$1'],
  [new RegExp(`(^|[^${WORD}])_(?=\\S)([^_]+?)(?<=\\S)_(?![${WORD}])`, 'gu'), '$1$2'],
  [/\*(?=\S)([^*]*?\S)\*/gu, '$1'],
  [/~~(?=\S)(.+?)(?<=\S)~~/gu, '$1'],
] as const;

/** The trailing colon of a heading ("Slice C:"), also when it sits outside or inside the closing marks, with the marks kept. */
export function stripHeadingColon(text: string): string {
  return text
    .trimEnd()
    .replace(/\s*:(\s*(?:\*\*|__|\*|_|~~)+)$/, '$1')
    .replace(/(\*\*|__|\*|_|~~)\s*:$/, '$1')
    .replace(/\s*:$/, '');
}

export function plainText(text: string): string {
  const code: string[] = [];
  let out = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, body: string) => {
    code.push(body.trim());
    return `\uE000${code.length - 1}\uE000`;
  });
  for (const [pattern, to] of MARKS) out = out.replace(pattern, to);
  out = out.replace(/\s+/g, ' ');
  out = stripHeadingColon(out).trim();
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => code[Number(i)] ?? '');
}
