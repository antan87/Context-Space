/**
 * @module core/plan-file
 * The workspace plan as people and every AI tool read and write it: `PLAN.md`, plain markdown.
 *
 * Free text says what the work is for and how. Under a "Checkpoints" heading, each top-level checkbox is an outcome
 * someone could demo, with its steps as checkboxes under it and an optional `Check:` line naming the command that
 * proves it. A checkbox that starts with "Decide:" is a question only the user can answer, placed under what it
 * holds up, with optional `Suggested:`, `If no answer:` and `Answer:` lines:
 *
 * ```markdown
 * ## Checkpoints
 *
 * - [ ] Reports export to CSV
 *   Check: `npm test`
 *   - [x] Query the report rows
 *   - [ ] Decide: Should archived reports be exported?
 *     Suggested: Yes, all of them · Only the last year
 *     If no answer: only the last year
 * ```
 *
 * No command or tool connection is needed: an AI ticks a step with its own file edits. ContextSpace reads the
 * structure out of the text and changes it one line at a time, so everything else in the file stays as written.
 * Nothing here touches the disk; core/plan-file-store does.
 */

export const PLAN_FILE = 'PLAN.md';

/** What every checkbox in the plan has. */
export interface PlanLine {
  /** Unique in the file, made from the words, so a change can name the line it means. */
  key: string;
  /** Ticked: a step or checkpoint finished, a decision answered. */
  done: boolean;
  /** Where it is in the file: the checkbox line and the last line that belongs to it, counted from 0. */
  line: number;
  end: number;
}

export interface PlanStep extends PlanLine {
  text: string;
}

export interface PlanDecision extends PlanLine {
  question: string;
  answer?: string;
  /** The answers the AI suggests, for the user to pick from. */
  suggested: string[];
  /** What the AI does when nobody answers. */
  ifNoAnswer?: string;
  /** Why it is asked: the other lines under it. */
  detail?: string;
  /** The checkpoint it holds up; none for a decision outside the Checkpoints list. */
  checkpoint?: string;
}

export interface PlanCheckpoint extends PlanLine {
  title: string;
  /** The command that proves it, or `null` for the workspace's own checks ("Check: the workspace checks"). */
  check?: string | null;
  /** What came out of it, as its `Outcome:` line says. */
  outcome?: string;
  detail?: string;
  steps: PlanStep[];
  decisions: PlanDecision[];
}

export interface PlanFile {
  /** The first top-level heading. */
  title: string;
  checkpoints: PlanCheckpoint[];
  /** Steps outside the Checkpoints list. */
  steps: PlanStep[];
  /** Decisions outside the Checkpoints list: nothing in particular waits for them. */
  decisions: PlanDecision[];
}

const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const DECIDE = /^(?:\*\*|__)?(?:decide|decision|question)\s*:\s*(?:\*\*|__)?\s*/i;
const FIELD = /^(check|suggested(?: answers)?|if no answer|answer|outcome)\s*:\s*(.*)$/i;
const CHECKPOINTS = /^(?:checkpoints|milestones)\b/i;
const WORKSPACE_CHECKS = /^the workspace(?:'s)? (?:own )?(?:checks|tests)\.?$/i;

const indentOf = (text: string) => text.replace(/\t/g, '    ').length;
const unbold = (text: string) => text.replace(/^(\*\*|__)(.+)\1$/, '$2').trim();
const unquote = (text: string) => text.replace(/^`(.+)`$/, '$1').trim();

/** Words to a key: "Reports export to CSV" → "reports-export-to-csv". */
export function planKey(text: string): string {
  return text.toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

/** Reads the plan's structure out of the text. Anything it does not recognise is free text and is left alone. */
export function parsePlanFile(text: string): PlanFile {
  const lines = text.split('\n');
  const plan: PlanFile = { title: '', checkpoints: [], steps: [], decisions: [] };
  const keys = new Map<string, number>();
  const uniqueKey = (words: string) => {
    const key = planKey(words);
    const seen = (keys.get(key) ?? 0) + 1;
    keys.set(key, seen);
    return seen === 1 ? key : `${key}-${seen}`;
  };

  let fence: string | null = null;
  let inCheckpoints = false;
  let checkpointsLevel = 0;
  let checkpointIndent: number | null = null;
  let checkpoint: PlanCheckpoint | null = null;
  // The item the next indented lines belong to, with its indent, and the free text kept under each item.
  let open: { item: PlanStep | PlanDecision | PlanCheckpoint; indent: number } | null = null;
  const details = new Map<PlanLine, string[]>();
  const keep = (item: PlanLine, line: string) => details.set(item, [...(details.get(item) ?? []), line]);
  const close = () => { open = null; };

  lines.forEach((line, index) => {
    const fenceMark = FENCE.exec(line)?.[1];
    if (fence) {
      if (fenceMark === fence) fence = null;
      if (open) open.item.end = index;
      return;
    }
    if (fenceMark) {
      fence = fenceMark;
      if (open && indentOf(/^\s*/.exec(line)![0]) > open.indent) { open.item.end = index; return; }
      close();
      return;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      close();
      const level = heading[1]!.length;
      const words = heading[2]!.trim();
      if (level === 1 && !plan.title) plan.title = words;
      if (inCheckpoints && level <= checkpointsLevel) { inCheckpoints = false; checkpoint = null; }
      if (!inCheckpoints && CHECKPOINTS.test(words)) {
        inCheckpoints = true;
        checkpointsLevel = level;
        checkpointIndent = null;
        checkpoint = null;
      }
      return;
    }

    const task = TASK.exec(line);
    if (task) {
      close();
      const indent = indentOf(task[1]!);
      const done = task[2] !== ' ';
      const words = task[3]!.trim();
      if (inCheckpoints && (checkpointIndent === null || indent <= checkpointIndent)) {
        checkpointIndent = indent;
        const title = unbold(words);
        checkpoint = { key: uniqueKey(title), title, done, line: index, end: index, steps: [], decisions: [] };
        plan.checkpoints.push(checkpoint);
        open = { item: checkpoint, indent };
        return;
      }
      const under = inCheckpoints ? checkpoint : null;
      if (DECIDE.test(words)) {
        const question = words.replace(DECIDE, '').replace(/(\*\*|__)$/, '').trim();
        const decision: PlanDecision = {
          key: uniqueKey(question), question, done, line: index, end: index, suggested: [],
          ...(under ? { checkpoint: under.key } : {}),
        };
        (under ? under.decisions : plan.decisions).push(decision);
        open = { item: decision, indent };
      } else {
        const step: PlanStep = { key: uniqueKey(words), text: words, done, line: index, end: index };
        (under ? under.steps : plan.steps).push(step);
        open = { item: step, indent };
      }
      if (under) under.end = index;
      return;
    }

    if (!open) return;
    const lead = indentOf(/^\s*/.exec(line)![0]);
    if (!line.trim()) { keep(open.item, ''); return; }
    if (lead <= open.indent) {
      // A line at the item's own level ends it; under a checkpoint, it is still the checkpoint's text.
      if (checkpoint && inCheckpoints && checkpointIndent !== null && lead > checkpointIndent) open = { item: checkpoint, indent: checkpointIndent };
      else { close(); return; }
    }
    open.item.end = index;
    if (checkpoint && open.item !== checkpoint && inCheckpoints) checkpoint.end = index;
    const content = line.trim();
    const field = LIST_ITEM.test(content) ? null : FIELD.exec(content);
    const name = field?.[1]!.toLowerCase();
    const value = field?.[2]!.trim() ?? '';
    const item = open.item;
    if (name === 'check' && 'steps' in item) item.check = WORKSPACE_CHECKS.test(unquote(value)) ? null : unquote(value);
    else if (name === 'outcome' && 'steps' in item) item.outcome = value;
    else if (name?.startsWith('suggested') && 'question' in item) item.suggested = value.split(/\s+·\s+|\s+\|\s+/).map((answer) => answer.trim()).filter(Boolean);
    else if (name === 'if no answer' && 'question' in item) item.ifNoAnswer = value;
    else if (name === 'answer' && 'question' in item) item.answer = value;
    else keep(item, content);
  });
  for (const [item, kept] of details) {
    const detail = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (detail && ('steps' in item || 'question' in item)) (item as PlanCheckpoint | PlanDecision).detail = detail;
  }
  return plan;
}

/** Every item in the file, in order, whatever it is. */
export function planItems(plan: PlanFile): Array<PlanCheckpoint | PlanStep | PlanDecision> {
  return [...plan.checkpoints.flatMap((checkpoint) => [checkpoint, ...checkpoint.steps, ...checkpoint.decisions]), ...plan.steps, ...plan.decisions]
    .sort((a, b) => a.line - b.line);
}

/** A decision that waits for the user's answer: open, and not under a checkpoint that is already done. */
export function openDecisions(plan: PlanFile): PlanDecision[] {
  return [
    ...plan.checkpoints.filter((checkpoint) => !checkpoint.done).flatMap((checkpoint) => checkpoint.decisions),
    ...plan.decisions,
  ].filter((decision) => !decision.done);
}

/** A change the file no longer allows: the line moved or changed since it was read, or is not there. */
export class PlanFileError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'conflict' | 'invalid') {
    super(message);
    this.name = 'PlanFileError';
  }
}

function findItem(plan: PlanFile, key: string): PlanCheckpoint | PlanStep | PlanDecision {
  const item = planItems(plan).find((candidate) => candidate.key === key);
  if (!item) throw new PlanFileError(`Nothing in ${PLAN_FILE} matches "${key}" any more. Read the plan again.`, 'not_found');
  return item;
}

const nameOf = (item: PlanCheckpoint | PlanStep | PlanDecision) => ('question' in item ? item.question : 'title' in item ? item.title : item.text);

/** One line of text, safe to put on a line of the file. */
export function oneLine(text: string, max = 2000): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) throw new PlanFileError('Say it in words.', 'invalid');
  if (clean.length > max) throw new PlanFileError(`Keep it to ${max} characters or fewer.`, 'invalid');
  return clean;
}

/** The indent the lines under an item use: what is there already, else two spaces past the checkbox. */
function innerIndent(lines: readonly string[], item: PlanLine): string {
  for (let index = item.line + 1; index <= item.end; index += 1) {
    if (lines[index]!.trim()) return /^\s*/.exec(lines[index]!)![0];
  }
  return `${/^\s*/.exec(lines[item.line]!)![0]}  `;
}

/**
 * Ticks or unticks an item. `expected` is the name the caller showed; when the line no longer says it, nothing changes.
 */
export function setDone(text: string, key: string, done: boolean, expected?: string): string {
  const lines = text.split('\n');
  const item = findItem(parsePlanFile(text), key);
  if (expected !== undefined && nameOf(item) !== expected) {
    throw new PlanFileError(`"${expected}" changed in ${PLAN_FILE} since it was read. Read the plan again.`, 'conflict');
  }
  lines[item.line] = lines[item.line]!.replace(/\[[ xX]\]/, done ? '[x]' : '[ ]');
  return lines.join('\n');
}

/** Answers a decision: ticks it and writes the answer on its `Answer:` line, replacing an earlier one. */
export function answerDecision(text: string, key: string, answer: string, expected?: string): string {
  const words = oneLine(answer);
  const lines = text.split('\n');
  const item = findItem(parsePlanFile(text), key);
  if (!('question' in item)) throw new PlanFileError(`Only a decision has an answer. Tick "${nameOf(item)}" instead.`, 'invalid');
  if (expected !== undefined && item.question !== expected) {
    throw new PlanFileError(`"${expected}" changed in ${PLAN_FILE} since it was read. Read the plan again.`, 'conflict');
  }
  const indent = innerIndent(lines, item);
  lines[item.line] = lines[item.line]!.replace(/\[[ xX]\]/, '[x]');
  for (let index = item.line + 1; index <= item.end; index += 1) {
    if (/^answer\s*:/i.test(lines[index]!.trim())) {
      lines[index] = `${/^\s*/.exec(lines[index]!)![0]}Answer: ${words}`;
      return lines.join('\n');
    }
  }
  lines.splice(lastContentLine(lines, item) + 1, 0, `${indent}Answer: ${words}`);
  return lines.join('\n');
}

/** The item's last non-blank line, so a new line goes right under what is there. */
function lastContentLine(lines: readonly string[], item: PlanLine): number {
  let last = item.line;
  for (let index = item.line + 1; index <= item.end; index += 1) if (lines[index]!.trim()) last = index;
  return last;
}

export interface NewDecision {
  question: string;
  suggested?: string[];
  ifNoAnswer?: string;
  detail?: string;
}

/**
 * Adds a step or a decision under a checkpoint, after what is there, or without one under a "Steps" or "Decisions"
 * heading at the end of the file, made when missing. Returns the new text and the new item's key.
 */
export function addToPlan(text: string, entry: { step: string } | { decision: NewDecision }, options: { checkpoint?: string } = {}): { text: string; key: string } {
  const plan = parsePlanFile(text);
  const lines = text.split('\n');
  const body = 'step' in entry ? [oneLine(entry.step, 300)] : decisionLines(entry.decision);
  let at: number;
  let indent: string;
  if (options.checkpoint) {
    const checkpoint = plan.checkpoints.find((candidate) => candidate.key === options.checkpoint);
    if (!checkpoint) throw new PlanFileError(`There is no checkpoint "${options.checkpoint}" in ${PLAN_FILE}.`, 'not_found');
    const children = [...checkpoint.steps, ...checkpoint.decisions].sort((a, b) => a.line - b.line);
    indent = children.length ? /^\s*/.exec(lines[children[0]!.line]!)![0] : innerIndent(lines, checkpoint);
    at = lastContentLine(lines, checkpoint) + 1;
  } else {
    const heading = 'step' in entry ? 'Steps' : 'Decisions';
    const section = sectionEnd(lines, heading);
    indent = '';
    if (section === null) {
      while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
      lines.push('', `## ${heading}`, '');
      at = lines.length;
      lines.push('');
    } else {
      at = section;
    }
  }
  const [first, ...rest] = body;
  lines.splice(at, 0, `${indent}- [ ] ${first}`, ...rest.map((line) => `${indent}  ${line}`));
  const added = planItems(parsePlanFile(lines.join('\n'))).find((item) => item.line === at)!;
  return { text: lines.join('\n'), key: added.key };
}

function decisionLines(decision: NewDecision): string[] {
  return [
    `Decide: ${oneLine(decision.question, 300)}`,
    ...(decision.detail?.trim() ? decision.detail.trim().split('\n').map((line) => line.trim()).filter(Boolean) : []),
    ...(decision.suggested?.length ? [`Suggested: ${decision.suggested.map((answer) => oneLine(answer, 200)).join(' · ')}`] : []),
    ...(decision.ifNoAnswer?.trim() ? [`If no answer: ${oneLine(decision.ifNoAnswer, 300)}`] : []),
  ];
}

/** Where a new line goes in the section under `## <heading>`: after its last non-blank line, or null without one. */
function sectionEnd(lines: string[], heading: string): number | null {
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line));
  if (start < 0) return null;
  let last = start;
  for (let index = start + 1; index < lines.length && !/^#{1,2}\s/.test(lines[index]!); index += 1) {
    if (lines[index]!.trim()) last = index;
  }
  if (last > start) return last + 1;
  if (lines[start + 1]?.trim() === '') return start + 2;
  lines.splice(start + 1, 0, '');
  return start + 2;
}

/** The headings whose lists ContextSpace reads as the plan's structure; everything else is free text. */
const STRUCTURED = /^(?:checkpoints|milestones|steps|decisions)\b/i;

/**
 * The file's free text, for showing beside the structure: what comes before the first second-level heading (the
 * title line left out), and every second-level section that is not Checkpoints, Steps or Decisions.
 */
export function planText(text: string): { intro: string; sections: Array<{ heading: string; body: string }> } {
  const parts: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const mark = FENCE.exec(line)?.[1];
    if (fence) { if (mark === fence) fence = null; parts[parts.length - 1]!.lines.push(line); continue; }
    if (mark) fence = mark;
    const heading = !mark ? /^##\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (heading) parts.push({ heading: heading[1]!, lines: [] });
    else if (!(parts.length === 1 && /^#\s/.test(line))) parts[parts.length - 1]!.lines.push(line);
  }
  const body = (lines: string[]) => lines.join('\n').trim();
  return {
    intro: body(parts[0]!.lines),
    sections: parts.slice(1).filter((part) => !STRUCTURED.test(part.heading!)).map((part) => ({ heading: part.heading!, body: body(part.lines) })),
  };
}
