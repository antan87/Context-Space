/**
 * The Board's "Questions" space: each `explain/*.md` answer, read and checked by the backend (`GET /api/workspace/:id/questions`),
 * becomes an Area of its own, built here without ever touching `contextspace-board.json`. Inside the Area, the short answer and each
 * part of the answer are a row, and each text, code block, picture and diagram is a card. Generated ids carry their own prefix
 * (`question:<file>` for the Area, `qcard:<file>#<n>` for a card), which can never be read as a card's uuid or a plan Area's id,
 * so nothing here can be dragged, archived, pinned or saved.
 */
import { plainText } from '../../lib/plainText.js';
import type { AreaData, BoardArea } from './boardAreas.js';
import type { AreaCountItem } from './boardCountNav.js';

export type CodeCheckStatus = 'matches' | 'moved' | 'changed' | 'gone' | 'not-in-workspace' | 'unreadable' | 'none';
export interface CodeCheck { status: CodeCheckStatus; start?: number; end?: number; current?: string }

export type QuestionCardDto =
  | { kind: 'text'; text: string }
  | { kind: 'code'; language: string; copy: string; where?: string; repo?: string; repoPath?: string; file?: string; start?: number; end?: number; check: CodeCheck }
  | { kind: 'picture'; alt: string; path: string; src: string | null }
  | { kind: 'diagram'; source: string };
export interface QuestionPartDto { title: string; heading: string | null; cards: QuestionCardDto[] }
export interface QuestionAnswerDto { path: string; question: string; summary: string; /** The Area it is about: `checkpoint:<plan key>` or `plan:own`. */ area?: string; modifiedAt: string; parts: QuestionPartDto[] }

export const QUESTION_AREA_PREFIX = 'question:';
export const ANSWER_CARD_PREFIX = 'qcard:';
export const QUESTIONS_GROUP = 'Questions';
/** How high every card of an answer is: text, code, picture and diagram stand level in a line. */
export const ANSWER_CARD_HEIGHT = 120;

export const questionAreaId = (file: string) => `${QUESTION_AREA_PREFIX}${file}`;
export const isQuestionAreaId = (id: unknown): id is string => typeof id === 'string' && id.startsWith(QUESTION_AREA_PREFIX);
export const isAnswerCardId = (id: unknown): id is string => typeof id === 'string' && id.startsWith(ANSWER_CARD_PREFIX);
export const answerRowId = (index: number) => `row:q:${index}`;

/** `explain/<name>.md` directly in the workspace: shown as an answer, not as a file. */
export const isQuestionFile = (path: string) => /^explain\/[^/]+\.md$/i.test(path.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, ''));

// ─── What a card draws ──────────────────────────────────────────────────────

type CardBase = {
  /** The card's name: the part it is in for text, the place for code, the alt text for a picture. */
  title: string;
  /** The answer file, the question it answers, and the heading of the part (null for the short answer): what the reader opens. */
  path: string;
  question: string;
  heading: string | null;
  compact?: boolean;
}
export type AnswerCardData = CardBase & (
  | { variant: 'text'; text: string }
  | { variant: 'code'; language: string; copy: string; where?: string; repo?: string; repoPath?: string; file?: string; start?: number; end?: number; check: CodeCheck }
  | { variant: 'picture'; alt: string; src: string | null; rawPath: string }
  | { variant: 'diagram'; source: string }
);

export interface AnswerCardDef { id: string; data: AnswerCardData }
export interface AnswerPartView { rowId: string; title: string; heading: string | null; cards: AnswerCardDef[] }
export interface AnswerView { path: string; question: string; summary: string; area?: string; modifiedAt: string; parts: AnswerPartView[] }

/** Text as one plain, readable run: no marks of Markdown, lists and tables as words. */
export function readableText(text: string): string {
  const lines = text.split('\n')
    .filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || !line.includes('-'))
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ' · '));
  return plainText(lines.join(' ')).slice(0, 400);
}

/** The head of a code card in two parts, so a long place can be cut at its start and the lines never are: "NexusFlow/src/http/auth.ts" and " · 12–40". */
export function codeHeadParts(card: { where?: string; language: string; start?: number; end?: number }, check?: CodeCheck): { name: string; lines: string } {
  if (!card.where) return { name: card.language || 'code', lines: '' };
  const start = check?.status === 'moved' && check.start !== undefined ? check.start : card.start;
  const end = check?.status === 'moved' && check.end !== undefined ? check.end : card.end;
  const lines = start === undefined ? '' : end === undefined || end === start ? ` · ${start}` : ` · ${start}–${end}`;
  return { name: card.where, lines };
}

/** "NexusFlow/src/http/auth.ts · 12–40" */
export function codeHead(card: { where?: string; language: string; start?: number; end?: number }, check?: CodeCheck): string {
  const { name, lines } = codeHeadParts(card, check);
  return `${name}${lines}`;
}

export interface CodeStatus { label: string; tone: 'ok' | 'warn' | 'muted'; hint?: string }
/** What a code card says of its check; null when there is nothing to check. */
export function codeStatus(check: CodeCheck, where?: string): CodeStatus | null {
  switch (check.status) {
    case 'matches': return { label: 'Matches', tone: 'ok' };
    case 'moved': return { label: check.start !== undefined && check.end !== undefined ? `Moved to ${check.start}–${check.end}` : 'Moved', tone: 'ok' };
    case 'changed': return { label: 'Changed since', tone: 'warn' };
    case 'gone': return { label: 'File gone', tone: 'warn' };
    case 'not-in-workspace': {
      const name = where?.split('/')[0] ?? 'it';
      return { label: 'Not in this workspace', tone: 'muted', hint: `Add ${name} to the workspace to check it` };
    }
    case 'unreadable': return { label: 'Could not be checked', tone: 'muted' };
    default: return null;
  }
}

/** What a part's cards say of their checks, for its folded line: "Matches", "1 changed since", "1 file gone", "2 not checked". Empty when there is no code. */
export function checkSummary(cards: ReadonlyArray<{ data: AnswerCardData }>): string {
  let ok = 0; let changed = 0; let gone = 0; let unchecked = 0;
  for (const { data } of cards) {
    if (data.variant !== 'code') continue;
    const status = data.check.status;
    if (status === 'matches' || status === 'moved') ok += 1;
    else if (status === 'changed') changed += 1;
    else if (status === 'gone') gone += 1;
    else if (status === 'not-in-workspace' || status === 'unreadable') unchecked += 1;
  }
  const words = [
    ...(changed ? [`${changed} changed since`] : []),
    ...(gone ? [`${gone} file gone`] : []),
    ...(unchecked ? [`${unchecked} not checked`] : []),
  ];
  return words.length > 0 ? words.join(' · ') : ok > 0 ? 'Matches' : '';
}

/** The line a code card opens the Code window at: where the copy is now. */
export function codeOpenLine(card: Extract<AnswerCardData, { variant: 'code' }>): number | undefined {
  return card.check.status === 'moved' ? card.check.start : card.start;
}

// ─── Building the Areas ─────────────────────────────────────────────────────

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const line = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined);
/** What an answer may name as its Area: a plan checkpoint or the plan's own steps. */
const AREA_ID = /^(?:plan:own|checkpoint:[\p{L}\p{N}][\p{L}\p{N}_-]{0,199})$/u;
const STATUSES: ReadonlySet<string> = new Set(['matches', 'moved', 'changed', 'gone', 'not-in-workspace', 'unreadable', 'none']);

function cleanCheck(raw: unknown): CodeCheck {
  if (!isRecord(raw) || typeof raw.status !== 'string' || !STATUSES.has(raw.status)) return { status: 'none' };
  const start = line(raw.start);
  const end = line(raw.end);
  return {
    status: raw.status as CodeCheckStatus,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(typeof raw.current === 'string' ? { current: raw.current.slice(0, 40_000) } : {}),
  };
}

function cleanCard(raw: unknown): QuestionCardDto | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'text') return { kind: 'text', text: text(raw.text, 40_000) };
  if (raw.kind === 'diagram') return { kind: 'diagram', source: text(raw.source, 40_000) };
  if (raw.kind === 'picture') return { kind: 'picture', alt: text(raw.alt, 300), path: text(raw.path, 400), src: typeof raw.src === 'string' ? raw.src.slice(0, 400) : null };
  if (raw.kind === 'code') {
    const start = line(raw.start);
    const end = line(raw.end);
    return {
      kind: 'code', language: text(raw.language, 40), copy: text(raw.copy, 40_000), check: cleanCheck(raw.check),
      ...(typeof raw.where === 'string' ? { where: raw.where.slice(0, 400) } : {}),
      ...(typeof raw.repo === 'string' ? { repo: raw.repo.slice(0, 200) } : {}),
      ...(typeof raw.repoPath === 'string' ? { repoPath: raw.repoPath.slice(0, 1000) } : {}),
      ...(typeof raw.file === 'string' ? { file: raw.file.slice(0, 400) } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
    };
  }
  return null;
}

/** Rebuilds the reply field by field: nothing is trusted just for arriving, and what is unusable is dropped. */
export function cleanAnswers(raw: unknown): QuestionAnswerDto[] {
  const list = isRecord(raw) && Array.isArray(raw.answers) ? raw.answers : [];
  const answers: QuestionAnswerDto[] = [];
  for (const entry of list.slice(0, 200)) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !isQuestionFile(entry.path) || !Array.isArray(entry.parts)) continue;
    const parts: QuestionPartDto[] = [];
    for (const part of entry.parts.slice(0, 100)) {
      if (!isRecord(part) || !Array.isArray(part.cards)) continue;
      parts.push({
        title: text(part.title, 300) || 'Part',
        heading: typeof part.heading === 'string' ? part.heading.slice(0, 300) : null,
        cards: part.cards.slice(0, 200).map(cleanCard).filter((card): card is QuestionCardDto => card !== null),
      });
    }
    answers.push({
      path: entry.path, question: text(entry.question, 400) || entry.path, summary: text(entry.summary, 1000),
      ...(typeof entry.area === 'string' && AREA_ID.test(entry.area) ? { area: entry.area } : {}),
      modifiedAt: typeof entry.modifiedAt === 'string' ? entry.modifiedAt : '', parts,
    });
  }
  return answers;
}

export interface AnswerCounts { parts: number; code: number; pictures: number; changed: number }

/** How much an answer holds. A part is a `##` part: the short answer is not counted. A card whose copy no longer matches counts as changed. */
export function answerCounts(answer: Pick<AnswerView, 'parts'>): AnswerCounts {
  const counts: AnswerCounts = { parts: 0, code: 0, pictures: 0, changed: 0 };
  for (const part of answer.parts) {
    if (part.heading !== null) counts.parts += 1;
    for (const card of part.cards) {
      if (card.data.variant === 'picture') counts.pictures += 1;
      else if (card.data.variant === 'code') {
        counts.code += 1;
        if (card.data.check.status === 'changed' || card.data.check.status === 'gone') counts.changed += 1;
      }
    }
  }
  return counts;
}

/** The pressable count line of an answer's card: "5 parts", "7 code blocks", "1 picture", "2 changed since". */
export function answerCountWords(counts: AnswerCounts): Array<{ kind: 'parts' | 'code' | 'pictures' | 'changed'; count: number; label: string }> {
  const out: Array<{ kind: 'parts' | 'code' | 'pictures' | 'changed'; count: number; label: string }> = [];
  if (counts.parts > 0) out.push({ kind: 'parts', count: counts.parts, label: `${counts.parts} ${counts.parts === 1 ? 'part' : 'parts'}` });
  if (counts.code > 0) out.push({ kind: 'code', count: counts.code, label: `${counts.code} code ${counts.code === 1 ? 'block' : 'blocks'}` });
  if (counts.pictures > 0) out.push({ kind: 'pictures', count: counts.pictures, label: `${counts.pictures} ${counts.pictures === 1 ? 'picture' : 'pictures'}` });
  if (counts.changed > 0) out.push({ kind: 'changed', count: counts.changed, label: `Out of date · ${counts.changed} ${counts.changed === 1 ? 'copy' : 'copies'}` });
  return out;
}

/** A request sent by the same terminal path as Ask in CLI. */
export function refreshRequest(answer: AnswerView): string | null {
  const copies = answer.parts.flatMap((part) => part.cards.flatMap(({ data }) => {
    if (data.variant !== 'code' || (data.check.status !== 'changed' && data.check.status !== 'gone')) return [];
    const range = data.start === undefined ? '' : `:${data.start}${data.end !== undefined && data.end !== data.start ? `-${data.end}` : ''}`;
    return [`${data.where ?? ''}${range} (${data.check.status})`];
  }));
  return copies.length ? `Refresh the answer ${answer.path} ("${answer.question}"): these copies no longer match: ${copies.join(', ')}. Follow the contextspace-explain skill and run ctxspace explain until all copies match.` : null;
}

/** Plain repair request for the reader's existing Ask in CLI path; nothing starts or submits an AI. */
export function diagramFixRequest(answer: { path: string; question: string; heading?: string | null }, error: string): string {
  const part = answer.heading ? `, part "${answer.heading}"` : '';
  return `Fix the diagram in ${answer.path} ("${answer.question}")${part}: Mermaid says: ${error}. Follow the diagram rules of the contextspace-explain skill.`;
}

/** The answer as rows of cards, with the ids the Board draws them by. */
export function answerView(answer: QuestionAnswerDto): AnswerView {
  let n = 0;
  const parts = answer.parts.map((part, index): AnswerPartView => ({
    rowId: answerRowId(index),
    title: part.title,
    heading: part.heading,
    cards: part.cards.map((card): AnswerCardDef => {
      n += 1;
      const base = { path: answer.path, question: answer.question, heading: part.heading };
      const id = `${ANSWER_CARD_PREFIX}${answer.path}#${n}`;
      if (card.kind === 'text') return { id, data: { ...base, variant: 'text', title: part.title, text: card.text } };
      if (card.kind === 'diagram') return { id, data: { ...base, variant: 'diagram', title: 'Diagram', source: card.source } };
      if (card.kind === 'picture') return { id, data: { ...base, variant: 'picture', title: card.alt || card.path || 'Picture', alt: card.alt, src: card.src, rawPath: card.path } };
      return { id, data: { ...base, variant: 'code', title: codeHead(card, card.check), language: card.language, copy: card.copy, check: card.check, ...(card.where !== undefined ? { where: card.where } : {}), ...(card.repo !== undefined ? { repo: card.repo } : {}), ...(card.repoPath !== undefined ? { repoPath: card.repoPath } : {}), ...(card.file !== undefined ? { file: card.file } : {}), ...(card.start !== undefined ? { start: card.start } : {}), ...(card.end !== undefined ? { end: card.end } : {}) } };
    }),
  }));
  return { path: answer.path, question: answer.question, summary: answer.summary, ...(answer.area ? { area: answer.area } : {}), modifiedAt: answer.modifiedAt, parts };
}

/** One Area for each answer, newest first (the order the backend sends them in). Nothing for no answers. */
export function buildQuestionAreas(answers: readonly QuestionAnswerDto[] | undefined): BoardArea[] {
  const seen = new Set<string>();
  const areas: BoardArea[] = [];
  for (const dto of answers ?? []) {
    if (seen.has(dto.path)) continue;
    seen.add(dto.path);
    const view = answerView(dto);
    const counts = answerCounts(view);
    const data: AreaData = {
      kind: 'questions',
      title: view.question,
      done: false,
      current: false,
      nowSet: false,
      stepsDone: 0,
      stepsTotal: 0,
      waitingCount: 0,
      noteCount: 0,
      fileCount: 0,
      pictureCount: 0,
      documentCount: 0,
      commitCount: 0,
      archivedCount: 0,
      pictures: [],
      ...(view.summary ? { preview: plainText(view.summary) } : {}),
      fresh: false,
      answerCounts: counts,
    };
    areas.push({
      id: questionAreaId(view.path),
      kind: 'questions',
      data,
      planItems: { steps: [], decisions: [] },
      documents: [],
      repos: [],
      cards: [],
      archivedCount: 0,
      allMemberNodeIds: view.parts.flatMap((part) => part.cards.map((card) => card.id)),
      answer: view,
    });
  }
  return areas;
}

/**
 * Which lines of two texts are not in the other, by the longest run of lines they share (trailing space ignored): what the compare view
 * marks. `before` is the copy as the answer has it, `after` the same lines now.
 */
export function differingLines(before: readonly string[], after: readonly string[]): { before: boolean[]; after: boolean[] } {
  const a = before.slice(0, 400).map((l) => l.trimEnd());
  const b = after.slice(0, 400).map((l) => l.trimEnd());
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const left = before.map(() => true);
  const right = after.map(() => true);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { left[i] = false; right[j] = false; i += 1; j += 1; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return { before: left, after: right };
}

// ─── Beside its Area ────────────────────────────────────────────────────────

/** "1 question", "2 questions": what an Area's card says of the answers about it. */
export const questionWords = (count: number) => `${count} ${count === 1 ? 'question' : 'questions'}`;

/**
 * Puts each answer right after the Area it is about, when that Area is one of `areas` (a plan Area, not Workspace files or Current work),
 * and says so on both: the Area's card gets "1 question" (its button opens the newest answer), the answer gets `about` (its header's
 * "About: <Area>"). Answers whose Area is missing or not there stay in `rest`, in the order they came (newest first). Pure; the
 * Areas and the answers it is given are not changed.
 */
export function placeQuestionAreas(areas: readonly BoardArea[], answers: readonly BoardArea[]): { areas: BoardArea[]; rest: BoardArea[] } {
  const host = new Map<string, BoardArea>();
  for (const area of areas) if (area.kind === 'checkpoint' || area.kind === 'plan') host.set(area.id, area);
  const placed = new Map<string, BoardArea[]>();
  const rest: BoardArea[] = [];
  for (const answer of answers) {
    const target = answer.answer?.area ? host.get(answer.answer.area) : undefined;
    if (!target) { rest.push(answer); continue; }
    placed.set(target.id, [...(placed.get(target.id) ?? []), { ...answer, data: { ...answer.data, about: { id: target.id, title: target.data.title } } }]);
  }
  const out: BoardArea[] = [];
  for (const area of areas) {
    const mine = placed.get(area.id);
    if (!mine) { out.push(area); continue; }
    const label = questionWords(mine.length);
    const item: AreaCountItem = {
      kind: 'question', count: mine.length, label,
      actionLabel: mine.length === 1 ? `Open the answer: ${mine[0]!.data.title}` : `Open the newest of the ${label}: ${mine[0]!.data.title}`,
    };
    // Where the card already has buttons for what is new, "1 question" stands among them, before the updates
    const news = area.data.newsItems;
    const newsItems = news && news.length > 0
      ? (() => { const at = news.findIndex((entry) => entry.kind === 'updates'); return at < 0 ? [...news, item] : [...news.slice(0, at), item, ...news.slice(at)]; })()
      : undefined;
    out.push({ ...area, data: { ...area.data, questionItem: item, questionTarget: mine[0]!.id, ...(newsItems ? { newsItems } : {}) } }, ...mine);
  }
  return { areas: out, rest };
}
