/**
 * Read-only answers: `explain/*.md` files in a workspace, parsed into parts and cards, with each copied code block
 * checked against the real file it points at. Nothing here writes; the files are written by an AI (or a person).
 *
 * Format (plain Markdown, one answer per file):
 * - the first `# ` line is the question (else the file name, made readable); an optional YAML front matter block is skipped,
 *   except its `area: checkpoint:<plan key>` (or `plan:own`; the key is a plan key, so letters of any language), which says what Area the answer is about;
 * - what stands before the first `## ` is the short answer ("In short");
 * - each `## ` starts a part; inside a part, text is one card until a code fence, a diagram or a picture;
 * - a code fence whose info string is `<language> <where>:<start>-<end>` is checked against that place;
 *   `<where>` starting with a workspace repository's name is that repository's working copy, otherwise a path in the workspace;
 * - a `mermaid` fence is a diagram card, `![alt](path)` on a line of its own is a picture card.
 */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { getWorkspaceRepoPaths } from '../utils/multi-git.js';
import { assertFileHandleMatchesPath, assertNoLinkedPathComponents, assertPathWithin, readFileHandleAtMost } from '../resources/fs-safety.js';

export const MAX_ANSWERS = 200;
export const MAX_ANSWER_BYTES = 1024 * 1024;
export const MAX_CHECKED_FILE_BYTES = 2 * 1024 * 1024;
/** The most lines of "the same lines now" that a changed card carries. */
const MAX_CURRENT_LINES = 400;

export type CodeCheckStatus = 'matches' | 'moved' | 'changed' | 'gone' | 'not-in-workspace' | 'unreadable' | 'none';
export interface CodeCheck {
  status: CodeCheckStatus;
  /** Where the copy is now, for `moved`. */
  start?: number;
  end?: number;
  /** The lines now, for `changed`. */
  current?: string;
}

export type QuestionCard =
  | { kind: 'text'; text: string }
  | {
    kind: 'code';
    language: string;
    copy: string;
    /** As written in the fence: `NexusFlow/src/http/auth.ts`. Missing for a plain code card. */
    where?: string;
    repo?: string;
    repoPath?: string;
    /** The path inside the repository (or the workspace when `repo` is missing). */
    file?: string;
    start?: number;
    end?: number;
    check: CodeCheck;
  }
  | { kind: 'picture'; alt: string; /** As written. */ path: string; /** The workspace path when the picture is there, else null. */ src: string | null }
  | { kind: 'diagram'; source: string };

export interface QuestionPart {
  /** "In short" for the short answer, else the `##` heading as written. */
  title: string;
  /** The heading the reader scrolls to; null for the short answer. */
  heading: string | null;
  cards: QuestionCard[];
}

export interface QuestionAnswer {
  /** The file, from the workspace folder: `explain/<name>.md`. */
  path: string;
  question: string;
  /** The first line of the short answer, as written. */
  summary: string;
  /** The Area it is about (`checkpoint:<plan key>` or `plan:own`), from the front matter; missing when the file names none. */
  area?: string;
  modifiedAt: string;
  parts: QuestionPart[];
}

// ─── Parsing ────────────────────────────────────────────────────────────────

type RawCard =
  | { kind: 'text'; text: string }
  | { kind: 'code'; language: string; info: string; copy: string }
  | { kind: 'picture'; alt: string; path: string }
  | { kind: 'diagram'; source: string };
interface RawPart { title: string; heading: string | null; cards: RawCard[] }
interface RawAnswer { question: string; summary: string; area: string | null; parts: RawPart[] }

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const PICTURE_LINE = /^!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)\s*$/;

function readableName(file: string): string {
  const base = file.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Untitled answer';
}

function skipFrontMatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== '---') return lines;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---' || lines[i]!.trim() === '...') return lines.slice(i + 1);
  }
  return lines;
}

/** The Area an answer is about, from its front matter `area:`: `checkpoint:<plan key>` or `plan:own`; null for anything else. */
export function parseArea(markdown: string): string | null {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'));
  // A block that never closes is not front matter (the parser does not skip it either)
  if (end < 0) return null;
  for (const line of lines.slice(1, end)) {
    const match = /^area\s*:(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1]!.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    return value === 'plan:own' || /^checkpoint:[\p{L}\p{N}][\p{L}\p{N}_-]{0,199}$/u.test(value) ? value : null;
  }
  return null;
}

/** Parses one answer file. Pure: no file is read. */
export function parseAnswer(markdown: string, fileName: string): RawAnswer {
  const lines = skipFrontMatter(markdown.replace(/^﻿/, '').split(/\r\n|\r|\n/));
  let question: string | null = null;
  const parts: RawPart[] = [{ title: 'In short', heading: null, cards: [] }];
  let text: string[] = [];
  const flush = () => {
    const body = text.join('\n').trim();
    text = [];
    if (body) parts[parts.length - 1]!.cards.push({ kind: 'text', text: body });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1]!;
      const indent = /^ */.exec(line)![0].length;
      const info = fence[2]!.trim();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const close = FENCE.exec(lines[j]!);
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length && close[2]!.trim() === '') break;
        // As CommonMark does: the fence's own indentation is not part of the code
        body.push(lines[j]!.replace(new RegExp(`^ {0,${indent}}`), ''));
      }
      // A blank line before the closing fence is not a line of the code
      while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
      i = j; // The closing fence, or the end of the file for a fence that never closes
      const language = info.split(/\s+/)[0] ?? '';
      if (language.toLowerCase() === 'mermaid') parts[parts.length - 1]!.cards.push({ kind: 'diagram', source: body.join('\n') });
      else parts[parts.length - 1]!.cards.push({ kind: 'code', language, info: info.slice(language.length).trim(), copy: body.join('\n') });
      continue;
    }
    if (question === null && /^# +\S/.test(line)) {
      question = line.replace(/^# +/, '').replace(/\s+#+\s*$/, '').trim();
      continue;
    }
    const heading = /^## +(\S.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      flush();
      parts.push({ title: heading[1]!.trim(), heading: heading[1]!.trim(), cards: [] });
      continue;
    }
    const picture = PICTURE_LINE.exec(line.trim());
    if (picture) {
      flush();
      const target = picture[2]!;
      parts[parts.length - 1]!.cards.push({ kind: 'picture', alt: picture[1]!.trim(), path: target.startsWith('<') ? target.slice(1, -1) : target });
      continue;
    }
    text.push(line);
  }
  flush();
  const short = parts[0]!;
  if (short.cards.length === 0) parts.shift();
  const firstText = short.cards.find((card): card is { kind: 'text'; text: string } => card.kind === 'text');
  const summary = firstText?.text.split('\n').find((line) => line.trim())?.trim() ?? '';
  return { question: question || readableName(fileName), summary, area: parseArea(markdown), parts };
}

/** `<where>:<start>-<end>` or `<where>:<line>`; null when the info string names no place. */
export function parseWhere(info: string): { where: string; start: number; end: number } | null {
  const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(info.trim());
  if (!match) return null;
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  return { where: match[1]!.trim(), start, end };
}

// ─── Checking ───────────────────────────────────────────────────────────────

interface Repo { name: string; path: string }
interface Context { root: string; repos: Repo[]; files: Map<string, Promise<string[] | 'gone' | 'unreadable' | 'outside'>> }

const within = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** Lines of a text without its line endings; a final line break does not make an empty last line. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, index) => line.trimEnd() === b[index]!.trimEnd());

/** Reads a text file under `base`, refusing links, other files and anything over the limit. */
async function readLines(base: string, target: string): Promise<string[] | 'gone' | 'unreadable' | 'outside'> {
  try {
    assertPathWithin(base, target);
  } catch {
    return 'outside';
  }
  try {
    await assertNoLinkedPathComponents(base, target);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return 'outside';
    if (!stat.isFile()) return 'gone';
    if (stat.size > MAX_CHECKED_FILE_BYTES) return 'unreadable';
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      await assertFileHandleMatchesPath(handle, target);
      const bytes = await readFileHandleAtMost(handle, MAX_CHECKED_FILE_BYTES + 1);
      if (bytes.length > MAX_CHECKED_FILE_BYTES || bytes.subarray(0, 8000).includes(0)) return 'unreadable';
      return linesOf(bytes.toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone';
    if (/Linked path|outside the allowed/.test(error instanceof Error ? error.message : '')) return 'outside';
    return 'unreadable';
  }
}

function placeOf(where: string, ctx: Context): { repo?: Repo; file: string; base: string } | null {
  const clean = where.replace(/\\/g, '/').replace(/^\.\//, '');
  // eslint-disable-next-line no-control-regex
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || /[\u0000-\u001f\u007f]/.test(clean)) return null;
  const segments = clean.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) return null;
  const repo = ctx.repos.find((entry) => entry.name === segments[0]);
  if (repo) return { repo, file: segments.slice(1).join('/'), base: repo.path };
  return { file: clean, base: ctx.root };
}

async function checkCode(card: { where: string; start: number; end: number; copy: string }, ctx: Context): Promise<{ check: CodeCheck; repo?: Repo; file?: string }> {
  const place = placeOf(card.where, ctx);
  if (!place) return { check: { status: 'not-in-workspace' } };
  const { repo, file, base } = place;
  const absolute = path.resolve(base, file);
  if (!file) return { check: { status: 'gone' }, repo, file };
  // A workspace path inside a repository is not a workspace file
  if (!repo && ctx.repos.some((entry) => within(entry.path, absolute))) return { check: { status: 'not-in-workspace' } };
  let pending = ctx.files.get(absolute);
  if (!pending) {
    pending = readLines(base, absolute);
    ctx.files.set(absolute, pending);
  }
  const lines = await pending;
  if (lines === 'outside') return { check: { status: 'not-in-workspace' }, repo, file };
  if (lines === 'unreadable') return { check: { status: 'unreadable' }, repo, file };
  if (lines === 'gone') return { check: { status: repo ? 'gone' : 'not-in-workspace' }, repo, file };
  const copy = linesOf(card.copy);
  // Matches is true only when the range is in the file and the copy has exactly its lines
  const wanted = card.end - card.start + 1;
  if (card.end <= lines.length && copy.some((line) => line.trim() !== '')) {
    const range = lines.slice(card.start - 1, card.end);
    // The parser drops a copy's trailing blank lines, so a range that ends on blank lines in the file is compared without them
    let kept = range.length;
    while (kept > 0 && range[kept - 1]!.trim() === '') kept -= 1;
    if ((copy.length === wanted && same(copy, range)) || same(copy, range.slice(0, kept))) return { check: { status: 'matches' }, repo, file };
  }
  if (copy.some((line) => line.trim() !== '')) {
    let best = -1;
    const first = copy[0]!.trimEnd();
    for (let at = 0; at + copy.length <= lines.length; at += 1) {
      // The same place with the wrong count of lines is not "moved"; the first line is compared before the rest
      if (at === card.start - 1 || lines[at]!.trimEnd() !== first || !same(copy, lines.slice(at, at + copy.length))) continue;
      if (best < 0 || Math.abs(at + 1 - card.start) < Math.abs(best + 1 - card.start)) best = at;
    }
    if (best >= 0) return { check: { status: 'moved', start: best + 1, end: best + copy.length }, repo, file };
  }
  return { check: { status: 'changed', current: lines.slice(card.start - 1, Math.min(card.end, card.start - 1 + MAX_CURRENT_LINES)).join('\n') }, repo, file };
}

const PICTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/** The workspace path of a picture named relative to its answer, when that file is there; else null. */
async function resolvePicture(raw: string, answerPath: string, ctx: Context): Promise<string | null> {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  let decoded = raw.replace(/[?#].*$/, '');
  try { decoded = decodeURIComponent(decoded); } catch { /* keep as written */ }
  // eslint-disable-next-line no-control-regex
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(answerPath), decoded));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined) || joined.split('/').some((segment) => segment.toLowerCase() === '.git')) return null;
  if (!PICTURE_EXTENSIONS.has(path.posix.extname(joined).toLowerCase())) return null;
  const absolute = path.resolve(ctx.root, ...joined.split('/'));
  if (ctx.repos.some((entry) => within(entry.path, absolute))) return null;
  try {
    assertPathWithin(ctx.root, absolute);
    await assertNoLinkedPathComponents(ctx.root, absolute);
    const stat = await fs.lstat(absolute);
    return stat.isFile() && !stat.isSymbolicLink() ? joined : null;
  } catch {
    return null;
  }
}

// ─── Reading the folder ─────────────────────────────────────────────────────

const parsed = new Map<string, { mtimeMs: number; size: number; answer: RawAnswer }>();

async function readAnswerFile(file: string, mtimeMs: number, size: number, name: string): Promise<RawAnswer | null> {
  const known = parsed.get(file);
  if (known && known.mtimeMs === mtimeMs && known.size === size) return known.answer;
  try {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const bytes = await readFileHandleAtMost(handle, MAX_ANSWER_BYTES + 1);
      if (bytes.length > MAX_ANSWER_BYTES) return null;
      const answer = parseAnswer(bytes.toString('utf8'), name);
      if (parsed.size > 500) parsed.clear();
      parsed.set(file, { mtimeMs, size, answer });
      return answer;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The answers of a workspace, newest file first: `explain/*.md` directly in the workspace folder (no subfolders), at most
 * 200 of them, each at most 1 MB. A file that cannot be read is left out; a card whose file cannot be read gets a status.
 * The parse is kept per file (by its time and size); the checks are made again on every call.
 */
export async function readQuestions(workspacePath: string): Promise<QuestionAnswer[]> {
  const root = await fs.realpath(workspacePath).catch(() => path.resolve(workspacePath));
  const folder = path.join(root, 'explain');
  let names: string[];
  try {
    await assertNoLinkedPathComponents(root, folder);
    if (!(await fs.lstat(folder)).isDirectory()) return [];
    names = (await fs.readdir(folder, { withFileTypes: true })).filter((entry) => entry.isFile() && /\.md$/i.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: Array<{ name: string; file: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    const file = path.join(folder, name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_ANSWER_BYTES) found.push({ name, file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { /* gone while listing */ }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const repos = (await getWorkspaceRepoPaths(root).catch(() => [])).map((repo) => ({ name: repo.name, path: path.resolve(repo.path) }));
  const ctx: Context = { root, repos, files: new Map() };
  const answers: QuestionAnswer[] = [];
  for (const entry of found.slice(0, MAX_ANSWERS)) {
    const raw = await readAnswerFile(entry.file, entry.mtimeMs, entry.size, entry.name);
    if (!raw) continue;
    const answerPath = `explain/${entry.name}`;
    const parts: QuestionPart[] = [];
    for (const part of raw.parts) {
      const cards: QuestionCard[] = [];
      for (const card of part.cards) {
        if (card.kind === 'text' || card.kind === 'diagram') cards.push(card);
        else if (card.kind === 'picture') cards.push({ kind: 'picture', alt: card.alt, path: card.path, src: await resolvePicture(card.path, answerPath, ctx) });
        else {
          const place = parseWhere(card.info);
          if (!place) {
            cards.push({ kind: 'code', language: card.language, copy: card.copy, check: { status: 'none' } });
            continue;
          }
          const { check, repo, file } = await checkCode({ ...place, copy: card.copy }, ctx);
          cards.push({
            kind: 'code', language: card.language, copy: card.copy, where: place.where, ...(repo ? { repo: repo.name, repoPath: repo.path } : {}),
            ...(file !== undefined ? { file } : {}), start: place.start, end: place.end, check,
          });
        }
      }
      parts.push({ title: part.title, heading: part.heading, cards });
    }
    answers.push({ path: answerPath, question: raw.question, summary: raw.summary, ...(raw.area ? { area: raw.area } : {}), modifiedAt: new Date(entry.mtimeMs).toISOString(), parts });
  }
  return answers;
}

// ─── A short list, for the CLI and the board tool ───────────────────────────

export interface AnswerSummary {
  path: string;
  question: string;
  /** `checkpoint:<plan key>` or `plan:own`; null when the answer names no Area. */
  area: string | null;
  /** The `##` parts, in order. */
  parts: string[];
  codeBlocks: number;
  /** Every copy that does not say Matches (a plain code block with no place is not a copy). `moved` carries the lines it is at now. */
  notMatching: Array<{ where: string; status: CodeCheckStatus; start?: number; end?: number }>;
}

/** What an AI needs to know about the existing answers: where they are, what they cover and which copies to fix. Pure. */
export function summarizeAnswers(answers: readonly QuestionAnswer[]): AnswerSummary[] {
  return answers.map((answer) => {
    let codeBlocks = 0;
    const notMatching: AnswerSummary['notMatching'] = [];
    for (const part of answer.parts) {
      for (const card of part.cards) {
        if (card.kind !== 'code') continue;
        codeBlocks += 1;
        const { status } = card.check;
        if (status === 'matches' || status === 'none') continue;
        notMatching.push({
          where: `${card.where ?? ''}:${card.start ?? ''}${card.end !== undefined && card.end !== card.start ? `-${card.end}` : ''}`,
          status,
          ...(status === 'moved' && card.check.start !== undefined ? { start: card.check.start, end: card.check.end } : {}),
        });
      }
    }
    return {
      path: answer.path, question: answer.question, area: answer.area ?? null,
      parts: answer.parts.filter((part) => part.heading !== null).map((part) => part.title), codeBlocks, notMatching,
    };
  });
}
