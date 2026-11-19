/**
 * @module core/workspace-db/plan-text
 * The plan file's grammar, as ordered blocks, and back. Every line of the source belongs to exactly one block:
 * a heading, a run of prose (verbatim lines, fenced code and all), or an item (a checkpoint, step or decision) whose
 * own line is verbatim and whose `detail` holds the verbatim lines under it.
 *
 * It follows `core/plan-file.ts` (checkbox lines, `Decide:` questions, the `Checkpoints` heading, fenced blocks and the
 * `Check:` / `Suggested:` / `If no answer:` / `Answer:` / `Outcome:` fields). That file is not changed here; the
 * export round-trip tests are what keep the two readings together until the old code is retired.
 *
 * An export writes each item and heading line with its id as a trailing `<!-- id -->`. Reading strips it first, so
 * words and kinds never see it.
 */

export type BlockKind = 'heading' | 'prose' | 'checkpoint' | 'step' | 'decision';
export type ItemKind = 'checkpoint' | 'step' | 'decision';

export const isItemKind = (kind: BlockKind): kind is ItemKind => kind === 'checkpoint' || kind === 'step' || kind === 'decision';

export const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
export const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const DECIDE = /^(?:\*\*|__)?(?:decide|decision|question)\s*:\s*(?:\*\*|__)?\s*/i;
const FIELD = /^(check|suggested(?: answers)?|if no answer|answer|outcome)\s*:\s*(.*)$/i;
export const CHECKPOINTS_HEADING = /^(?:checkpoints|milestones)\b/i;
const WORKSPACE_CHECKS = /^the workspace(?:'s)? (?:own )?(?:checks|tests)\.?$/i;
/** The id an export puts at the end of an item or heading line. */
const ID_COMMENT = / <!-- ([a-z][0-9a-hjkmnp-tv-z]{5}) -->$/;
export const HEADER_LINE = /^<!-- Written by ContextSpace from the workspace database\..* db=(\S+) revision=(\d+) digest=([0-9a-f]+) -->$/;

export const indentOf = (text: string): number => /^\s*/.exec(text)![0].replace(/\t/g, '    ').length;
const unbold = (text: string) => text.replace(/^(\*\*|__)(.+)\1$/, '$2').trim();
const unquote = (text: string) => text.replace(/^`(.+)`$/, '$1').trim();

export interface ParsedBlock {
  kind: BlockKind;
  /** Verbatim: an item's own line without its id comment, a heading's line without it, or prose lines. */
  text: string;
  detail: string;
  done: boolean;
  name: string | null;
  /** From a trailing id comment, when the source had one. */
  id?: string;
  /** Index into the same list, or -1. */
  parentIdx: number;
}

export interface ParsedPlan {
  header: { dbId: string; revision: number; digest: string } | null;
  blocks: ParsedBlock[];
  trailingNewline: boolean;
  /** CRLF when every line ends with it; anything else reads as LF (a stray CR stays in its line). */
  eol: '\n' | '\r\n';
}

/** The line ending of a text: CRLF only when no line ends with a bare LF. */
export function eolOf(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') && !/(^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

/** The readable words of an item line. */
export function itemName(kind: ItemKind, line: string): string {
  const words = TASK.exec(line)![3]!.trim();
  if (kind === 'checkpoint') return unbold(words);
  if (kind === 'decision') return words.replace(DECIDE, '').replace(/(\*\*|__)$/, '').trim();
  return words;
}

/** The words after the checkbox, as written. */
export const wordsOf = (line: string): string => TASK.exec(line)![3]!;

export interface DetailFields {
  hasCheck: boolean;
  /** null = "the workspace checks". */
  check: string | null;
  outcome?: string;
  suggested: string[];
  ifNoAnswer?: string;
  answer?: string;
}

export interface FieldLine { index: number; name: string; value: string }

/**
 * The `Check:`, `Suggested:`, `If no answer:`, `Answer:` and `Outcome:` lines of an item's detail, in order. A line
 * inside a fenced code block is an example, not a field, so it is skipped. Import, the derived rows and the ops
 * (`answer`, reopening) all read fields through this one function.
 */
export function fieldLines(detail: string): FieldLine[] {
  const out: FieldLine[] = [];
  let fence: string | null = null;
  detail.split('\n').forEach((raw, index) => {
    const mark = FENCE.exec(raw)?.[1];
    if (fence) { if (mark === fence) fence = null; return; }
    if (mark) { fence = mark; return; }
    const content = raw.trim();
    if (!content || LIST_ITEM.test(content)) return;
    const field = FIELD.exec(content);
    if (field) out.push({ index, name: field[1]!.toLowerCase(), value: field[2]!.trim() });
  });
  return out;
}

/** Reads Check, Outcome, Suggested, If no answer and Answer out of an item's detail lines (fenced examples skipped). */
export function parseDetail(kind: ItemKind, detail: string): DetailFields {
  const out: DetailFields = { hasCheck: false, check: null, suggested: [] };
  for (const { name, value } of fieldLines(detail)) {
    if (kind === 'checkpoint' && name === 'check') {
      out.hasCheck = true;
      out.check = WORKSPACE_CHECKS.test(unquote(value)) ? null : unquote(value);
    } else if (kind === 'checkpoint' && name === 'outcome') out.outcome = value;
    else if (kind === 'decision' && name.startsWith('suggested')) out.suggested = value.split(/\s+·\s+|\s+\|\s+/).map((a) => a.trim()).filter(Boolean);
    else if (kind === 'decision' && name === 'if no answer') out.ifNoAnswer = value;
    else if (kind === 'decision' && name === 'answer') out.answer = value;
  }
  return out;
}

/** Parses plan text into blocks. Ids are only those found in trailing id comments. */
export function parsePlanText(source: string): ParsedPlan {
  const eol = eolOf(source);
  let lines = source.split(eol);
  let header: ParsedPlan['header'] = null;
  const headerMatch = HEADER_LINE.exec(lines[0] ?? '');
  if (headerMatch) {
    header = { dbId: headerMatch[1]!, revision: Number(headerMatch[2]), digest: headerMatch[3]! };
    lines = lines.slice(1);
  }
  const text = lines.join('\n');
  let trailingNewline = false;
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
    trailingNewline = text !== '';
  }

  const blocks: ParsedBlock[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) blocks.push({ kind: 'prose', text: prose.join('\n'), detail: '', done: false, name: null, parentIdx: -1 });
    prose = [];
  };
  let fence: string | null = null;
  let inCheckpoints = false;
  let checkpointsLevel = 0;
  let checkpointIndent: number | null = null;
  let stack: Array<{ idx: number; indent: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMark = FENCE.exec(line)?.[1];
    if (fence) {
      prose.push(line);
      if (fenceMark === fence) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      prose.push(line);
      continue;
    }
    const idMatch = ID_COMMENT.exec(line);
    const own = idMatch ? line.slice(0, line.length - idMatch[0].length) : line;
    const heading = HEADING.exec(own);
    if (heading) {
      flush();
      stack = [];
      const level = heading[1]!.length;
      if (inCheckpoints && level <= checkpointsLevel) inCheckpoints = false;
      if (!inCheckpoints && CHECKPOINTS_HEADING.test(heading[2]!.trim())) {
        inCheckpoints = true;
        checkpointsLevel = level;
        checkpointIndent = null;
      }
      blocks.push({ kind: 'heading', text: own, detail: '', done: false, name: heading[2]!.trim(), parentIdx: -1, ...(idMatch ? { id: idMatch[1]! } : {}) });
      continue;
    }
    const task = TASK.exec(own);
    if (!task) {
      prose.push(line);
      continue;
    }
    flush();
    const indent = indentOf(task[1]!);
    const done = task[2] !== ' ';
    const words = task[3]!.trim();
    let kind: ItemKind;
    if (inCheckpoints && (checkpointIndent === null || indent <= checkpointIndent)) {
      kind = 'checkpoint';
      checkpointIndent = indent;
      stack = [];
    } else kind = DECIDE.test(words) ? 'decision' : 'step';
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parentIdx = kind === 'checkpoint' ? -1 : stack.length ? stack[stack.length - 1]!.idx : -1;
    // The lines under it: blank or deeper lines, with fenced blocks kept whole.
    let j = i + 1;
    let last = i;
    while (j < lines.length) {
      const l = lines[j]!;
      const f = FENCE.exec(l)?.[1];
      if (f && indentOf(l) > indent) {
        let k = j + 1;
        while (k < lines.length && FENCE.exec(lines[k]!)?.[1] !== f) k += 1;
        if (k >= lines.length) k = lines.length - 1;
        last = k;
        j = k + 1;
        continue;
      }
      if (TASK.test(l) || HEADING.test(l)) break;
      if (!l.trim()) { j += 1; continue; }
      if (indentOf(l) > indent) { last = j; j += 1; continue; }
      break;
    }
    blocks.push({
      kind,
      text: own,
      detail: lines.slice(i + 1, last + 1).join('\n'),
      done,
      name: itemName(kind, own),
      parentIdx,
      ...(idMatch ? { id: idMatch[1]! } : {}),
    });
    stack.push({ idx: blocks.length - 1, indent });
    i = last;
  }
  flush();
  return { header, blocks, trailingNewline, eol };
}

export interface RenderBlock {
  id: string;
  kind: BlockKind;
  text: string;
  detail: string;
}

/** The lines a block exports as. Items and headings end with their id comment. */
export function blockLines(block: RenderBlock, withIds: boolean): string[] {
  if (block.kind === 'prose') return block.text.split('\n');
  const first = withIds ? `${block.text} <!-- ${block.id} -->` : block.text;
  if (block.kind === 'heading') return [first];
  return block.detail === '' ? [first] : [first, ...block.detail.split('\n')];
}

export function renderBody(blocks: readonly RenderBlock[], trailingNewline: boolean, withIds = true, eol: '\n' | '\r\n' = '\n'): string {
  const lines: string[] = [];
  for (const block of blocks) lines.push(...blockLines(block, withIds));
  return lines.join(eol) + (trailingNewline && lines.length ? eol : '');
}

export function headerLine(dbId: string, revision: number, digest: string): string {
  return `<!-- Written by ContextSpace from the workspace database. Change it with \`ctxspace plan apply\` (see \`ctxspace plan help\`), or edit this file and run \`ctxspace plan import\`. db=${dbId} revision=${revision} digest=${digest} -->`;
}

/** Removes the header line and every id comment: what must equal the source an import came from, byte for byte. */
export function stripExport(text: string): string {
  const eol = eolOf(text);
  const lines = text.split(eol);
  const body = HEADER_LINE.test(lines[0] ?? '') ? lines.slice(1) : lines;
  return body.map((line) => line.replace(ID_COMMENT, '')).join(eol);
}

/** The export text without its header line. */
export function bodyOf(text: string): string {
  const eol = eolOf(text);
  const lines = text.split(eol);
  return HEADER_LINE.test(lines[0] ?? '') ? lines.slice(1).join(eol) : text;
}

export interface StructureBlock {
  id: string;
  kind: BlockKind;
  parent_id: string | null;
  text: string;
  detail: string;
  done: boolean;
}

/**
 * The file grammar wins: writes the blocks out as an export, reads that back, and reports every place where the
 * reading differs from what the blocks say (a step placed where the file would read it as a checkpoint, a detail
 * line that would read as an item, a heading that would swallow its neighbours). Empty = the blocks read back as meant.
 */
export function structureProblems(blocks: readonly StructureBlock[]): string[] {
  const want = signature(blocks.map((b) => ({ kind: b.kind, id: b.id, parent: b.parent_id, done: b.done, text: b.text, detail: b.detail })));
  const parsed = parsePlanText(renderBody(blocks, true, true));
  const got = signature(parsed.blocks.map((b) => ({ kind: b.kind, id: b.id ?? '?', parent: b.parentIdx >= 0 ? (parsed.blocks[b.parentIdx]!.id ?? '?') : null, done: b.done, text: b.text, detail: b.detail })));
  const problems: string[] = [];
  const limit = Math.max(want.length, got.length);
  for (let i = 0; i < limit && problems.length < 3; i += 1) {
    if (want[i] === got[i]) continue;
    problems.push(`${describe(want[i])} would read back as ${describe(got[i])}`);
  }
  return problems;
}

interface SigInput { kind: BlockKind; id: string; parent: string | null; done: boolean; text: string; detail: string }

function signature(blocks: SigInput[]): string[] {
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => { if (prose.length) out.push(`prose\u0000${prose.join('\n')}`); prose = []; };
  for (const b of blocks) {
    if (b.kind === 'prose') { prose.push(b.text); continue; }
    flush();
    out.push(`${b.kind}\u0000${b.id}\u0000${b.parent ?? '-'}\u0000${b.done ? 1 : 0}\u0000${b.text}\u0000${b.detail}`);
  }
  flush();
  return out;
}

function describe(entry: string | undefined): string {
  if (entry === undefined) return '(nothing)';
  const [kind, id, parent, , text] = entry.split('\u0000');
  if (kind === 'prose') return `free text "${(id ?? '').slice(0, 50)}"`;
  const words = (text ?? '').trim().slice(0, 50);
  const under = parent && parent !== '-' ? ` under ${parent}` : parent === '-' ? ' at the top level' : '';
  return `${kind} ${id}${under} "${words}"`;
}
