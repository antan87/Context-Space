import { fileUrlToPath, splitLocation, trimTrailingPunctuation } from '../../lib/fileReference.js';
import { isWebOrDomain } from './webLinks.js';

export interface FileReference { text: string; path: string; line?: number; start: number; end: number }

const MARKDOWN_LINK = /\[([^\]]*)\]\((<[^>]+>|[^)]+)\)/g;
/** `Update(` in `Update(src/app.ts)`: the tool a CLI names before the file it works on. */
const CALL_PREFIX = /^[A-Za-z][A-Za-z\d_]*\(/;
/** The header rows of a diff, where git names each file with an `a/` or `b/` side in front. */
const DIFF_ROW = /^\s*(?:diff --git |--- |\+\+\+ )/;
const DIFF_SIDE = /^[ab]\//;

/** The path and line a printed token names, or null when it does not look like a file path. */
function toPathAndLine(text: string): { path: string; line?: number } | null {
  const location = splitLocation(text);
  let path = fileUrlToPath(location.path.replace(/['"`>]$/, ''));
  // `owner/repo#123` is how a pull request or issue is named, not a file with a section anchor. A repository can have a dot
  // in its name (`next.js`), so only an extension that is surely a file's keeps a name like `docs/guide.md#12` a file.
  if (/^[\w-]+\/[\w.-]+#\d+$/.test(path) && !/\.(?:md|tsx?|jsx|json|py|go|rs|rb|java|css|html|ya?ml|toml|txt|sh|c|h|cpp)#\d+$/i.test(path)) return null;
  path = path.replace(/#.*$/, '');
  if (!path || isWebOrDomain(path)) return null;
  if (!/[/\\]/.test(path) && !/^[^.:]+(?:\.[a-z\d_-]+)*\.[a-z][a-z\d]{0,11}$/i.test(path)) return null;
  if (/^(?:\.\.?[/\\])?$/.test(path)) return null;
  return { path, line: location.line };
}

/** The path a token names once the decoration around it is taken off, and where that starts inside the token. */
function readAt(token: string, from: number, diffRow: boolean): { text: string; path: string; line?: number; offset: number } | null {
  let offset = from;
  let text = trimTrailingPunctuation(token.slice(offset));
  // Bold or italic around a path (`**src/app.ts**`, `**src/app.ts:**`). A glob such as `**/*.ts` has no closing run, so it stays.
  const stars = /^\*{1,3}(?=[^*\s])/.exec(text)?.[0].length ?? 0;
  if (stars) {
    const inner = text.slice(stars).replace(/\*{1,3}(?=[:,;.!?)]*$)/, '');
    if (inner.length < text.length - stars) {
      offset += stars;
      text = trimTrailingPunctuation(inner);
    }
  }
  if (diffRow && DIFF_SIDE.test(text)) {
    offset += 2;
    text = text.slice(2);
  }
  const reference = toPathAndLine(text);
  return reference ? { text, ...reference, offset } : null;
}

/**
 * A CLI prints the files it works on as a tool call (`Update(src/app.ts)`), in bold, or as a diff header, and none of
 * that decoration is part of the path. The reading without the tool name goes first, and the plain one stays as the
 * fallback, so `Name(` is only dropped when a path is left after it.
 */
function readToken(token: string, diffRow: boolean): { text: string; path: string; line?: number; offset: number } | null {
  const leading = token.match(/^[('"`[{<]*/)?.[0].length ?? 0;
  const call = CALL_PREFIX.exec(token.slice(leading))?.[0].length ?? 0;
  for (const skip of call ? [call, 0] : [0]) {
    const found = readAt(token, leading + skip, diffRow);
    if (found) return found;
  }
  return null;
}

/** Find file paths in terminal output, retaining spaces inside quoted paths and stripping markdown/angle wrapper syntax. */
export function findFileReferences(row: string): FileReference[] {
  const result: FileReference[] = [];
  const handledRanges: [number, number][] = [];

  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK.exec(row)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    handledRanges.push([matchStart, matchEnd]);

    let raw = match[2].trim();
    let unwrapped = false;
    if (raw.startsWith('<') && raw.endsWith('>')) {
      raw = raw.slice(1, -1).trim();
      unwrapped = true;
    }
    if (isWebOrDomain(raw)) continue;

    const text = trimTrailingPunctuation(raw);
    const reference = toPathAndLine(text);
    if (!reference) continue;

    const targetOffset = match[0].indexOf(match[2]) + (unwrapped ? 1 : 0);
    const start = matchStart + targetOffset;
    result.push({ text, ...reference, start, end: start + text.length });
  }

  for (let index = 0; index < row.length;) {
    if (/\s/.test(row[index])) { index++; continue; }
    const range = handledRanges.find(([s, e]) => index >= s && index < e);
    if (range) { index = range[1]; continue; }

    const tokenStart = index;
    let quote: '"' | "'" | '`' | null = null;
    while (index < row.length) {
      const char = row[index];
      if (quote && char === quote) quote = null;
      else if (!quote && (char === '"' || char === "'" || char === '`') && /^[([{<]*$/.test(row.slice(tokenStart, index))) quote = char;
      else if (/\s/.test(char) && !quote) break;
      index++;
    }
    const found = readToken(row.slice(tokenStart, index), DIFF_ROW.test(row));
    if (!found) continue;
    const start = tokenStart + found.offset;
    result.push({ text: found.text, path: found.path, line: found.line, start, end: start + found.text.length });
  }

  return result.sort((a, b) => a.start - b.start);
}
