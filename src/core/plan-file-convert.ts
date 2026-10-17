/**
 * @module core/plan-file-convert
 * Writes an older plan store (`contextspace-plan.json`) as PLAN.md, so a workspace keeps its plan when it moves to
 * the plan file. Milestones become checkpoints, with the tasks and the user's questions they wait for under them;
 * other open work goes under Steps and Decisions; recorded decisions and existing work become plain lists. Dropped
 * items are left out: the old store is kept, so they are not lost.
 */

import type { PlanDocument, PlanItem } from './plan.js';

/** Lines of free text indented under a checkbox, blank lines kept as blank. */
function indented(text: string | undefined, indent: string): string[] {
  if (!text?.trim()) return [];
  return text.trim().split('\n').map((line) => (line.trim() ? `${indent}${line.trimEnd()}` : ''));
}

const box = (item: PlanItem) => (item.status === 'done' ? '[x]' : '[ ]');
/** A note on a step that is not simply to do: put off, or stuck. */
function stateNote(item: PlanItem): string {
  if (item.status === 'later') return ` (later${item.revisitWhen ? `: ${item.revisitWhen}` : ''})`;
  if (item.status === 'blocked') return ` (blocked${item.blockedReason ? `: ${item.blockedReason}` : ''})`;
  return '';
}
const forUser = (item: PlanItem) => item.kind === 'question' && (item.owner ?? 'user').trim().toLowerCase() === 'user';

/** A question for the user as a decision: its detail, the answers it suggested, and the answer once given. */
function decisionLines(item: PlanItem, indent: string): string[] {
  const inner = `${indent}  `;
  const detail = (item.detail ?? '').split('\n');
  const suggested = detail.find((line) => line.startsWith('Suggested answers: '))?.slice('Suggested answers: '.length);
  return [
    `${indent}- ${box(item)} Decide: ${item.title}${stateNote(item)}`,
    ...indented(detail.filter((line) => !line.startsWith('Suggested answers: ')).join('\n'), inner),
    ...(suggested ? [`${inner}Suggested: ${suggested}`] : []),
    ...(item.status === 'done' && item.resolution ? [`${inner}Answer: ${item.resolution}`] : []),
  ];
}

function stepLines(item: PlanItem, indent: string): string[] {
  if (forUser(item)) return decisionLines(item, indent);
  return [`${indent}- ${box(item)} ${item.title}${stateNote(item)}`, ...indented(item.detail, `${indent}  `)];
}

/** Drops the blank lines a section ends with, and runs of them, so the file reads evenly. */
function tidy(lines: string[]): string {
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * The plan store as PLAN.md. `title` heads the file and `goal` (the brief's objective, or the workspace's
 * description) opens it.
 */
export function planFileFromStore(plan: PlanDocument, options: { title: string; goal?: string }): string {
  const live = plan.items.filter((item) => item.status !== 'dropped');
  const byId = new Map(live.map((item) => [item.id, item]));
  const placed = new Set<string>();
  const lines: string[] = [`# ${options.title.trim() || 'Plan'}`, ''];
  if (options.goal?.trim()) lines.push(options.goal.trim(), '');

  const milestones = live.filter((item) => item.kind === 'milestone');
  if (milestones.length) {
    lines.push('## Checkpoints', '');
    for (const milestone of milestones) {
      placed.add(milestone.id);
      lines.push(`- ${box(milestone)} ${milestone.title}${stateNote(milestone)}`);
      if (milestone.gate?.command) lines.push(`  Check: \`${milestone.gate.command}\``);
      else if (milestone.gate?.required) lines.push('  Check: the workspace checks');
      if (milestone.status === 'done' && milestone.resolution) lines.push(`  Outcome: ${milestone.resolution.replace(/\s+/g, ' ')}`);
      lines.push(...indented(milestone.detail, '  '));
      // What it waits for goes under it, once: a task several milestones wait for stays with the first.
      const under = milestone.waitsFor.map((id) => byId.get(id))
        .filter((item): item is PlanItem => Boolean(item) && item!.kind !== 'milestone' && !placed.has(item!.id));
      for (const item of under) {
        placed.add(item.id);
        lines.push(...stepLines(item, '  '));
      }
      lines.push('');
    }
  }

  const rest = live.filter((item) => !placed.has(item.id));
  const steps = rest.filter((item) => item.kind === 'task' || (item.kind === 'question' && !forUser(item)));
  if (steps.length) lines.push('## Steps', '', ...steps.flatMap((item) => stepLines(item, '')), '');
  const decisions = rest.filter(forUser);
  if (decisions.length) lines.push('## Decisions', '', ...decisions.flatMap((item) => decisionLines(item, '')), '');
  const decided = rest.filter((item) => item.kind === 'decision');
  if (decided.length) {
    lines.push('## Decided', '', ...decided.map((item) => `- ${item.title}${item.resolution ? `: ${item.resolution}` : ''}`), '');
  }
  const existing = rest.filter((item) => item.kind === 'existing');
  if (existing.length) {
    lines.push('## Existing work', '', ...existing.flatMap((item) => [`- ${item.title}`, ...indented(item.detail, '  ')]), '');
  }
  return tidy(lines);
}
