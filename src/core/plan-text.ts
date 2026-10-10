/**
 * @module core/plan-text
 * The plan as text and as JSON, in the sections, order and words of the Plan tab, so a person and
 * every AI tool read the same plan. `ctxspace plan` prints the text; MCP and `--json` return the JSON.
 */

import {
  CHANGE_WORDS,
  KIND_WORDS,
  NAMES_FIRST,
  PLAN_RULES,
  PLAN_WORKFLOW,
  STATUS_WORDS,
  WHO_ACTS,
  isOpenStatus,
  itemLabel,
  type PlanStatus,
} from './plan-words.js';
import {
  heldUpBy,
  planSections,
  unsettledWaits,
  type PlanChangeEntry,
  type PlanDocument,
  type PlanItem,
} from './plan.js';

/** The goal shown above the plan: the brief's objective, stage and stop condition. */
export interface PlanGoal {
  objective: string;
  stage?: string;
  stopCondition?: string;
}

/** The goal from the brief, or from the workspace description when the brief has no objective yet. */
export function goalFromBrief(assignment: { objective?: string; stage?: string; stopCondition?: string }, description?: string): PlanGoal | undefined {
  const objective = assignment.objective || description || '';
  return objective ? { objective, stage: assignment.stage, stopCondition: assignment.stopCondition || undefined } : undefined;
}

const STATUS_GLYPHS: Record<PlanStatus, string> = {
  todo: '○', in_progress: '◐', blocked: '⊘', done: '✓', dropped: '✗', later: '‖',
};

/** The first sentence or line of a longer text, short enough for one line. */
export function firstLine(text: string | undefined, max = 100): string {
  const line = (text ?? '').split(/\n/).map((part) => part.trim()).find(Boolean) ?? '';
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Who did something, as people say it: "Claude", "Codex", "the user", "the AI". */
export function actorWords(by: string): string {
  if (by === 'user') return 'the user';
  if (by === 'agent') return 'the AI';
  if (by === 'contextspace') return 'ContextSpace';
  return by.charAt(0).toUpperCase() + by.slice(1);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "now", "5 min ago", "3 h ago", "2 days ago", or the date. */
export function relativeTime(at: string, now: Date = new Date()): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PROPOSAL_WORDS: Record<string, string> = {
  done: 'says it is done', answer: 'suggests the answer', drop: 'suggests dropping it',
  later: 'suggests moving it to later', reopen: 'asks to reopen it',
};

/** One line saying where an item stands, in the plan's words. */
export function itemState(plan: PlanDocument, item: PlanItem): string {
  const status = STATUS_WORDS[item.status].label.toLowerCase();
  if (item.proposal) {
    return `${actorWords(item.proposal.by)} ${PROPOSAL_WORDS[item.proposal.action] ?? item.proposal.action}: ${item.proposal.note} · the user decides`;
  }
  switch (item.status) {
    case 'done': return item.kind === 'question' ? `answered: ${item.resolution}` : `done · ${item.resolution}`;
    case 'dropped': return `dropped: ${item.resolution}`;
    case 'later': return `later · look again: ${item.revisitWhen}`;
    case 'blocked': return `blocked: ${item.blockedReason}`;
    case 'in_progress': {
      const by = [...item.history].reverse().find((entry) => entry.action === 'started' || entry.action === 'reopened')?.by;
      return by ? `in progress · ${actorWords(by)}` : 'in progress';
    }
    case 'todo': {
      if (unsettledWaits(plan, item).length) return status;
      // A question is answered, not started.
      if (item.kind === 'question') return `to do · ${actorWords(item.owner?.trim().toLowerCase() || 'user')} answers`;
      return 'to do · ready to start';
    }
  }
}

function waitsLine(plan: PlanDocument, item: PlanItem): string | null {
  const waiting = unsettledWaits(plan, item);
  if (!waiting.length || item.status === 'done' || item.status === 'dropped') return null;
  return `waits for: ${waiting.map((wait) => `${itemLabel(wait)} (${STATUS_WORDS[wait.status].label.toLowerCase()})`).join(', ')}`;
}

function itemLines(plan: PlanDocument, item: PlanItem, glyph = STATUS_GLYPHS[item.status]): string[] {
  const lines = [`  ${glyph.padEnd(3)} ${itemLabel(item)} · ${itemState(plan, item)}`];
  const waits = waitsLine(plan, item);
  if (waits) lines.push(`        ${waits}`);
  const holds = heldUpBy(plan, item.id).filter((later) => isOpenStatus(later.status) || later.status === 'later');
  if (holds.length && (isOpenStatus(item.status) || item.status === 'later') && item.kind !== 'milestone') {
    lines.push(`        holds up: ${holds.map(itemLabel).join(', ')}`);
  }
  return lines;
}

function changeLine(entry: PlanChangeEntry, now: Date): string {
  return `  ${relativeTime(entry.at, now).padEnd(12)} ${actorWords(entry.by).padEnd(12)} ${CHANGE_WORDS[entry.action] ?? entry.action} ${entry.label}${entry.note ? `: ${entry.note}` : ''}`;
}

/** The latest changes, newest first, as `ctxspace plan log` prints them. */
export function renderChanges(changes: PlanChangeEntry[], now = new Date()): string {
  return changes.length ? ['WHAT CHANGED', ...changes.map((entry) => changeLine(entry, now))].join('\n') : 'Nothing has changed yet.';
}

/**
 * The plan as `ctxspace plan` prints it: Goal, Needs you, Milestones, Other open work, Done and
 * dropped, What changed. Plain text, so it reads the same in a terminal and in an AI's context.
 */
export function renderPlanText(plan: PlanDocument, options: { goal?: PlanGoal; all?: boolean; now?: Date; changes?: number } = {}): string {
  const now = options.now ?? new Date();
  const sections = planSections(plan, { changes: options.changes ?? 5 });
  const { counts } = sections;
  const lines: string[] = [];

  if (options.goal?.objective) {
    lines.push(`GOAL        ${firstLine(options.goal.objective)}`);
    const facts = [
      options.goal.stage ? `Stage: ${capitalize(options.goal.stage)}` : '',
      options.goal.stopCondition ? `Stop when: ${firstLine(options.goal.stopCondition, 80)}` : '',
    ].filter(Boolean);
    if (facts.length) lines.push(`            ${facts.join(' · ')}`);
    lines.push(`            Needs you ${counts.needsYou} · In progress ${counts.inProgress} · To do ${counts.todo} · Done ${counts.done}`, '');
  } else {
    lines.push(`Needs you ${counts.needsYou} · In progress ${counts.inProgress} · To do ${counts.todo} · Done ${counts.done}`, '');
  }

  if (!plan.items.length) {
    lines.push('The plan has no items yet. Add one: ctxspace plan add milestone "What it delivers"');
    return lines.join('\n');
  }

  if (sections.needsYou.length) {
    lines.push('NEEDS YOU');
    for (const item of sections.needsYou) lines.push(...itemLines(plan, item, item.proposal ? '✓?' : '?'));
    lines.push('');
  }

  if (sections.milestones.length) {
    lines.push('MILESTONES  in order');
    for (const item of sections.milestones) lines.push(...itemLines(plan, item));
    lines.push('');
  }

  if (sections.otherOpen.length) {
    lines.push('OTHER OPEN WORK');
    for (const item of sections.otherOpen) lines.push(...itemLines(plan, item));
    lines.push('');
  }

  const closedOther = sections.closed.filter((item) => item.kind !== 'milestone');
  if (sections.closed.length) {
    lines.push(`DONE AND DROPPED  ${counts.done} done · ${counts.dropped} dropped${options.all ? '' : ' · list them: ctxspace plan --all'}`);
    if (options.all) for (const item of closedOther) lines.push(...itemLines(plan, item));
    lines.push('');
  }

  if (sections.ready.length) {
    lines.push(`READY TO START  ${sections.ready.map(itemLabel).join(', ')}`, '');
  }

  if (sections.changes.length) lines.push(renderChanges(sections.changes, now), '');

  lines.push('Change it: ctxspace plan add|start|done|answer|block|later|drop|reopen  (--help)');
  return lines.join('\n');
}

/** An item as JSON: its label and state in words, what it waits for and what it holds up. */
export function itemToJson(plan: PlanDocument, item: PlanItem) {
  return {
    id: item.id,
    label: itemLabel(item),
    kind: item.kind,
    title: item.title,
    status: item.status,
    state: itemState(plan, item),
    ...(item.owner ? { owner: item.owner } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
    waitsFor: item.waitsFor.map((id) => {
      const wait = plan.items.find((candidate) => candidate.id === id);
      return { id, label: wait ? itemLabel(wait) : id, status: wait?.status };
    }),
    holdsUp: heldUpBy(plan, item.id).map(itemLabel),
    ...(item.resolution ? { resolution: item.resolution } : {}),
    ...(item.revisitWhen ? { revisitWhen: item.revisitWhen } : {}),
    ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
    ...(item.proposal ? { proposal: item.proposal } : {}),
    ...(item.links ? { links: item.links } : {}),
    ...(item.gate ? { gate: item.gate } : {}),
    updatedAt: item.updatedAt,
  };
}

/** The plan as JSON, in the same sections as the text. */
export function planToJson(plan: PlanDocument, options: { goal?: PlanGoal; all?: boolean; changes?: number } = {}) {
  const sections = planSections(plan, { changes: options.changes ?? 10 });
  const json = (items: PlanItem[]) => items.map((item) => itemToJson(plan, item));
  return {
    revision: plan.revision,
    ...(options.goal ? { goal: options.goal } : {}),
    counts: sections.counts,
    needsYou: json(sections.needsYou),
    milestones: json(sections.milestones),
    otherOpen: json(sections.otherOpen),
    closed: options.all ? json(sections.closed) : sections.closed.map(itemLabel),
    ready: sections.ready.map(itemLabel),
    changes: sections.changes,
  };
}

/** One item's history, newest last, in words. */
export function renderHistory(plan: PlanDocument, item: PlanItem, now = new Date()): string {
  const lines = [`${itemLabel(item)} · ${KIND_WORDS[item.kind].label} · ${itemState(plan, item)}`];
  for (const entry of item.history) {
    lines.push(`  ${relativeTime(entry.at, now).padEnd(12)} ${actorWords(entry.by).padEnd(12)} ${CHANGE_WORDS[entry.action] ?? entry.action}${entry.note ? `: ${entry.note}` : ''}`);
  }
  return lines.join('\n');
}

export interface PlanFinding {
  /** `problem` needs fixing; `note` is worth knowing. */
  level: 'problem' | 'note';
  itemId: string;
  message: string;
}

/** What `ctxspace plan check` reports: waits that can never clear, and work that sits still. */
export function checkPlan(plan: PlanDocument, now = new Date()): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  for (const item of plan.items) {
    if (item.status === 'done' || item.status === 'dropped') continue;
    for (const id of item.waitsFor) {
      const wait = byId.get(id);
      if (wait?.status === 'dropped') {
        findings.push({ level: 'note', itemId: item.id, message: `${itemLabel(item)} waits for ${itemLabel(wait)}, which was dropped, so it holds nothing up. Remove it: ctxspace plan edit ${item.id} --not-after ${wait.id}` });
      } else if (wait?.status === 'later') {
        findings.push({ level: 'problem', itemId: item.id, message: `${itemLabel(item)} waits for ${itemLabel(wait)}, which is set for later. It can't start until that is done or dropped.` });
      }
    }
    if (item.proposal) {
      findings.push({ level: 'note', itemId: item.id, message: `${itemLabel(item)}: ${actorWords(item.proposal.by)} ${PROPOSAL_WORDS[item.proposal.action] ?? item.proposal.action} (${relativeTime(item.proposal.at, now)}). The user decides.` });
    }
    if (item.status === 'blocked') {
      findings.push({ level: 'note', itemId: item.id, message: `${itemLabel(item)} is blocked: ${item.blockedReason}` });
    }
    const idleDays = (now.getTime() - Date.parse(item.updatedAt)) / 86_400_000;
    if (item.status === 'in_progress' && idleDays >= 7) {
      findings.push({ level: 'note', itemId: item.id, message: `${itemLabel(item)} has been in progress with no change for ${Math.floor(idleDays)} days.` });
    }
  }
  return findings;
}

/** The rules, as `ctxspace plan --help` and the AI instructions state them. */
export function renderPlanRules(): string {
  return [
    'How the plan works:',
    ...PLAN_RULES.map((rule, index) => `  ${index + 1}. ${rule}`),
    `  ${NAMES_FIRST}`,
    '',
    `Words: ${Object.values(STATUS_WORDS).map((word) => word.label).join(', ')}. Needs you collects what waits for the user.`,
  ].join('\n');
}

/**
 * The Plan section of the generated AGENTS.md, for every AI tool: the command, the work routine, the
 * rules and who acts. AIs change the plan only with `ctxspace plan`; there are no MCP plan tools.
 * It leaves out how a person acts as the user (`--as user`): told about it, an AI tried it.
 */
export function renderPlanInstructions(): string {
  return [
    '## Plan',
    '',
    'Read the plan with `ctxspace plan` (`--json` gives every field). Change it one item at a time with `ctxspace plan add|start|done|answer|block|later|drop|reopen|edit`; `--help` shows how. If `plan` is an unknown command, use `./.contextspace/bin/ctxspace plan` (PowerShell: `.\\.contextspace\\bin\\ctxspace.cmd plan`). Never edit `contextspace-plan.json` by hand.',
    '',
    'How to work with the plan:',
    ...PLAN_WORKFLOW.flatMap((step, index) => [`${index + 1}. ${step.text}`, ...(step.list ?? []).map((line) => `   - ${line}`)]),
    '',
    'How the plan works:',
    ...PLAN_RULES.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    WHO_ACTS.filter((line) => !line.includes('--as user')).join(' '),
  ].join('\n');
}
