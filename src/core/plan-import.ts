/**
 * @module core/plan-import
 * Moves the old hand-written planning notes (contextspace-milestones.md) into the plan, once per
 * workspace and safe to repeat. Each row of the four template tables becomes a plan item. Text the
 * template does not hold, and rows that cannot be read, go into one task for the user to read, so
 * nothing is lost. The file is then kept under .contextspace/archive/ for one release.
 *
 * The plan records each import with the file's hash, so a second run, or a run interrupted after
 * the plan was saved, adds nothing twice.
 */

import { createHash } from 'node:crypto';
import { ensurePlanStore } from './lifecycle.js';
import {
  DETAIL_MAX,
  ID_PATTERN,
  NOTE_MAX,
  TITLE_MAX,
  mutatePlan,
  nextId,
  planIntegrityProblem,
  readPlanIfExists,
  type PlanDocument,
  type PlanItem,
} from './plan.js';
import { PLANNING_NOTES_FILE, PLANNING_NOTES_TEMPLATE, withPlanningNotesLock } from './planning-notes.js';
import { deleteWorkspaceFile, readWorkspaceFile, workspaceFileExists, writeWorkspaceFile } from './storage.js';
import { loadFeatureConfig } from './workspace.js';
import type { PlanKind } from './plan-words.js';

export const PLAN_ARCHIVE_DIR = '.contextspace/archive';
/**
 * The question that holds whatever in the notes was not a table row. A question for the user, so it
 * shows under Needs you and no AI starts it as work.
 */
export const IMPORTED_NOTES_TITLE = `Is anything in the notes kept from ${PLANNING_NOTES_FILE} still needed?`;

type Table = 'outcomes' | 'questions' | 'existing' | 'decisions';

/** The template's four tables: how to recognise each heading, and how many columns a row has. */
const TABLES: Array<{ table: Table; heading: RegExp; columns: number }> = [
  { table: 'outcomes', heading: /^outcomes\b/i, columns: 5 },
  { table: 'questions', heading: /^open questions\b/i, columns: 6 },
  { table: 'existing', heading: /^existing work\b/i, columns: 5 },
  { table: 'decisions', heading: /^(flagged|deferred)\b/i, columns: 5 },
];

export interface ParsedNotes {
  rows: Record<Table, string[][]>;
  /** Everything that is neither the template's own text nor a readable row, under its heading. */
  leftover: string[];
}

let templateLines: Set<string> | undefined;
/** The template's own lines. Built on first use: the modules that load this one also load the template's. */
const isTemplateLine = (line: string) =>
  (templateLines ??= new Set(PLANNING_NOTES_TEMPLATE.split('\n').map((text) => text.trim()).filter(Boolean))).has(line);
const isRow = (line: string) => line.trimStart().startsWith('|');
const isSeparator = (line: string) => isRow(line) && /^[\s|:-]+$/.test(line);
/** A cell that says nothing: empty, a dash, or n/a. */
const blank = (cell: string | undefined) => !cell || /^(?:-+|—|–|n\/?a|none)$/i.test(cell.trim());

function cells(line: string): string[] {
  const parts = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/);
  return parts.map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/** Reads the notes file into table rows and leftover text. Pure: it changes nothing. */
export function parsePlanningNotes(content: string): ParsedNotes {
  const rows: Record<Table, string[][]> = { outcomes: [], questions: [], existing: [], decisions: [] };
  const leftover: string[] = [];
  const lines = content.split(/\r?\n/);
  let table: (typeof TABLES)[number] | undefined;
  let heading: string | undefined;
  let headingShown = false;
  /** The index of the last line kept, so a kept table keeps its `| --- |` line. */
  let lastKept = -2;
  const keep = (line: string, index: number) => {
    if (!line.trim()) {
      // A blank line only separates kept text; it never brings in a heading on its own.
      if ((headingShown || !heading) && leftover.at(-1)?.trim()) leftover.push('');
      return;
    }
    if (heading && !headingShown) {
      if (leftover.at(-1)?.trim()) leftover.push('');
      leftover.push(heading);
      headingShown = true;
    }
    leftover.push(line);
    lastKept = index;
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const title = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (title) {
      table = TABLES.find((candidate) => candidate.heading.test(title[1]!.trim()));
      heading = trimmed;
      headingShown = false;
      return;
    }
    if (!trimmed) { keep('', index); return; }
    if (isRow(line)) {
      if (isSeparator(line)) {
        if (lastKept === index - 1) keep(line, index);
        return;
      }
      const header = isSeparator(lines[index + 1] ?? '');
      if (header && isTemplateLine(trimmed)) return;
      const row = cells(line);
      if (table && !header && row.length === table.columns && !blank(row[0]) && !row.every(blank)) {
        rows[table.table].push(row.map((cell) => (blank(cell) ? '' : cell)));
        return;
      }
      if (!row.every(blank)) keep(line, index);
      return;
    }
    if (!isTemplateLine(trimmed)) keep(line, index);
  });
  while (leftover.length && !leftover[leftover.length - 1]!.trim()) leftover.pop();
  return { rows, leftover };
}

/** Whether the notes hold anything beyond the empty template. */
export function notesHaveContent(parsed: ParsedNotes): boolean {
  return Object.values(parsed.rows).some((rows) => rows.length > 0) || parsed.leftover.some((line) => line.trim());
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const firstSentence = (text: string) => clip(/^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text, TITLE_MAX);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const codes = (text: string) => text.split(/\s*(?:,|;|\band\b)\s*/i).map((code) => code.trim()).filter(Boolean);

/** Who owns an item, from the notes' Owner column: the user, the AI, or a person's name as written. */
export function ownerFrom(text: string): string {
  if (!text.trim() || /^(?:user|you|me|owner|the user)$/i.test(text.trim())) return 'user';
  if (/\b(?:ai|agent|assistant|claude|codex|copilot|gemini|agy|antigravity|cursor)\b/i.test(text)) return 'agent';
  return clip(text.trim(), 200);
}

export interface NotesApplied {
  added: string[];
  updated: string[];
}

/**
 * Adds the notes to the plan. Pure: the caller saves the plan. A row whose item is already in the
 * plan (the same kind and name) is not added again, so new notes written later only add what is new.
 */
export function applyPlanningNotes(plan: PlanDocument, parsed: ParsedNotes, at: string, archivedAs?: string): NotesApplied {
  const added: string[] = [];
  const updated: string[] = [];
  const source = `From ${PLANNING_NOTES_FILE}`;
  const history = (note = source) => [{ at, by: 'contextspace', action: 'imported', note }];
  const find = (code: string) => plan.items.find((item) => item.id === code) ?? plan.items.find((item) => same(item.id, code));
  const exists = (kind: PlanKind, title: string) => plan.items.some((item) => item.kind === kind && same(item.title, title));
  const codeFor = (kind: PlanKind, wanted: string) =>
    wanted && ID_PATTERN.test(wanted) && wanted.length <= 100 && !find(wanted) ? wanted : nextId(plan, kind);
  const add = (item: Omit<PlanItem, 'createdAt' | 'updatedAt' | 'history' | 'waitsFor'> & { waitsFor?: string[] }): PlanItem => {
    const full: PlanItem = { waitsFor: [], ...item, createdAt: at, updatedAt: at, history: history() };
    if (full.status === 'done' || full.status === 'dropped') full.closedAt = at;
    plan.items.push(full);
    added.push(full.id);
    return full;
  };
  /** `waiter` waits for `code`, unless that names nothing or would make a circle. */
  const wait = (waiter: PlanItem, code: string): boolean => {
    const target = find(code);
    if (!target || target.id === waiter.id) return false;
    if (waiter.waitsFor.includes(target.id)) return true;
    waiter.waitsFor.push(target.id);
    if (planIntegrityProblem(plan)) { waiter.waitsFor.pop(); return false; }
    return true;
  };
  const lines = (...pairs: Array<[string, string]>) => pairs.filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`).join('\n');

  for (const [code, outcome, work, dependsOn, release] of parsed.rows.outcomes) {
    const facts = lines(['Outcome', outcome!], ['Work item', work!], ['Release order', release!]);
    let milestone = find(code!);
    if (milestone && milestone.kind !== 'milestone') milestone = undefined;
    if (milestone) {
      const note = `${source}:\n${facts}`;
      if (!milestone.detail?.includes(note)) {
        milestone.detail = clip(milestone.detail ? `${milestone.detail}\n\n${note}` : note, DETAIL_MAX);
        milestone.updatedAt = at;
        milestone.history = [...milestone.history, ...history('Added its notes from the old notes file')].slice(-20);
        updated.push(milestone.id);
      }
    } else {
      const title = firstSentence(outcome || code!);
      if (exists('milestone', title)) continue;
      milestone = add({ id: codeFor('milestone', code!), kind: 'milestone', title, status: 'todo', detail: clip(facts, DETAIL_MAX) });
    }
    const missing = codes(dependsOn ?? '').filter((dependency) => !wait(milestone, dependency));
    if (missing.length) milestone.detail = clip(`${milestone.detail ?? ''}\nAlso waited for, in the old notes: ${missing.join(', ')}`.trim(), DETAIL_MAX);
  }

  for (const [code, question, owner, status, blocks, resolution] of parsed.rows.questions) {
    const title = clip(question || code!, TITLE_MAX);
    if (exists('question', title)) continue;
    const closed = /^(?:resolved|closed|answered|done|decided)\b/i.test(status ?? '');
    const dropped = /^(?:dropped|obsolete|not needed|won'?t)\b/i.test(status ?? '');
    const item = add({
      id: codeFor('question', code!), kind: 'question', title, owner: ownerFrom(owner ?? ''),
      status: closed ? 'done' : dropped ? 'dropped' : 'todo',
      ...(closed || dropped
        ? { resolution: clip(resolution || (closed ? 'Answered before the plan existed' : 'No longer needed'), NOTE_MAX) }
        : resolution ? { detail: clip(`So far: ${resolution}`, DETAIL_MAX) } : {}),
    });
    const missing = codes(blocks ?? '').filter((blocked) => {
      const waiter = find(blocked);
      return !waiter || !wait(waiter, item.id);
    });
    if (missing.length) item.detail = clip(`${item.detail ?? ''}\nHeld up, in the old notes: ${missing.join(', ')}`.trim(), DETAIL_MAX);
  }

  for (const [outcome, where, status, evidence, remaining] of parsed.rows.existing) {
    const title = clip(outcome!, TITLE_MAX);
    if (exists('existing', title)) continue;
    add({
      id: nextId(plan, 'existing'), kind: 'existing', title, status: 'done',
      resolution: clip([status, evidence].filter(Boolean).join('; ') || 'Recorded as existing work', NOTE_MAX),
      ...(where || remaining ? { detail: clip(lines(['Where', where!], ['Still to do', remaining!]), DETAIL_MAX) } : {}),
    });
  }

  for (const [subject, decision, reason, owner, followUp] of parsed.rows.decisions) {
    const title = clip(subject!, TITLE_MAX);
    if (exists('decision', title)) continue;
    const choice = /\bdefer/i.test(decision ?? '') ? 'defer' : /\bflag/i.test(decision ?? '') ? 'flag' : /\bimplement/i.test(decision ?? '') ? 'implement' : 'open';
    const detail = clip(lines(['Reason', reason!], ['Follow-up', followUp!]), DETAIL_MAX);
    add({
      id: nextId(plan, 'decision'), kind: 'decision', title,
      ...(owner ? { owner: ownerFrom(owner) } : {}),
      ...(choice === 'defer' ? { status: 'later' as const, revisitWhen: clip(followUp || 'When the owner picks it up again', NOTE_MAX) }
        : choice === 'flag' ? { status: 'done' as const, resolution: clip(`Flag only${reason ? `: ${reason}` : ''}`, NOTE_MAX) }
          : choice === 'implement' ? { status: 'done' as const, resolution: clip(`Implement${reason ? `: ${reason}` : ''}`, NOTE_MAX) }
            : { status: 'todo' as const }),
      ...(detail ? { detail } : {}),
    });
  }

  if (parsed.leftover.some((line) => line.trim())) {
    const where = archivedAs ? `The whole file is kept in ${archivedAs}.` : '';
    const text = parsed.leftover.join('\n');
    const room = DETAIL_MAX - where.length - 2;
    const detail = [text.length > room ? `${text.slice(0, room - 1)}…` : text, where].filter(Boolean).join('\n\n');
    if (!plan.items.some((item) => item.kind === 'question' && same(item.title, IMPORTED_NOTES_TITLE) && item.detail === detail)) {
      add({ id: nextId(plan, 'question'), kind: 'question', title: IMPORTED_NOTES_TITLE, owner: 'user', status: 'todo', detail });
    }
  }
  return { added, updated };
}

export interface NotesImportResult {
  /** `none`: no notes file. `already`: this content was moved before. */
  status: 'none' | 'imported' | 'already';
  added: string[];
  updated: string[];
  archivedAs?: string;
  /** False when the storage adapter cannot remove files, so the old file stayed. */
  removed: boolean;
}

async function archiveName(workspacePath: string, featureId: string, at: string): Promise<string> {
  const day = at.slice(0, 10);
  const plain = `${PLAN_ARCHIVE_DIR}/contextspace-milestones-${day}.md`;
  if (!(await workspaceFileExists(workspacePath, featureId, plain))) return plain;
  return `${PLAN_ARCHIVE_DIR}/contextspace-milestones-${at.replace(/[:.]/g, '-')}.md`;
}

/**
 * Moves the notes file into the plan and archives it. Safe to repeat and to run from several
 * processes: the plan's lock and the recorded hash keep an import from happening twice.
 */
export async function importPlanningNotes(workspacePath: string, now = new Date()): Promise<NotesImportResult> {
  const feature = await loadFeatureConfig(workspacePath);
  if (!feature || !(await workspaceFileExists(workspacePath, feature.id, PLANNING_NOTES_FILE))) {
    return { status: 'none', added: [], updated: [], removed: true };
  }
  // The milestones must be in the plan before the notes can add to them.
  await ensurePlanStore(workspacePath);
  return withPlanningNotesLock(workspacePath, async () => {
    let content: string;
    try { content = await readWorkspaceFile(workspacePath, feature.id, PLANNING_NOTES_FILE); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' as const, added: [], updated: [], removed: true };
      throw error;
    }
    const at = now.toISOString();
    const hash = createHash('sha256').update(content).digest('hex');
    const parsed = parsePlanningNotes(content);
    // Anything but the untouched template is kept, even when nothing in it could be read.
    const keep = notesHaveContent(parsed) || content.trim() !== PLANNING_NOTES_TEMPLATE.trim();
    const previous = (await readPlanIfExists(workspacePath))?.imports?.find((entry) => entry.hash === hash);
    const archivedAs = previous ? previous.archivedAs : keep ? await archiveName(workspacePath, feature.id, at) : undefined;

    const { result } = await mutatePlan(workspacePath, (plan) => {
      if (plan.imports?.some((entry) => entry.hash === hash)) return { status: 'already' as const, added: [], updated: [] };
      const applied = applyPlanningNotes(plan, parsed, at, archivedAs);
      plan.imports = [...(plan.imports ?? []), { file: PLANNING_NOTES_FILE, hash, at, ...(archivedAs ? { archivedAs } : {}), items: applied.added }].slice(-100);
      return { status: 'imported' as const, ...applied };
    });

    // Keep a copy first, then remove the original: an interruption leaves both, never neither.
    if (archivedAs && !(await workspaceFileExists(workspacePath, feature.id, archivedAs))) {
      await writeWorkspaceFile(workspacePath, feature.id, archivedAs, content);
    }
    const removed = await deleteWorkspaceFile(workspacePath, feature.id, PLANNING_NOTES_FILE);
    return { ...result, ...(archivedAs ? { archivedAs } : {}), removed };
  });
}
