/**
 * @module core/plan-file-text
 * The plan in words: the Plan section every AI session reads in AGENTS.md, and where the plan stands as
 * `ctxspace plan` prints it. The plan itself is PLAN.md, which people and AIs read directly; this says only what
 * the file does not: how to work with it, what each check proved, and what waits for the user.
 */

import { PLAN_FILE, openDecisions, type PlanCheckpoint, type PlanDecision, type PlanFile } from './plan-file.js';
import type { PlanFileChange, PlanFileRead } from './plan-file-store.js';
import type { PlanEvidence } from '../types.js';

/** The Plan section of the generated AGENTS.md: the file, how to keep it true, and the one command it needs. */
export function renderPlanFileInstructions(): string {
  return [
    '## Plan',
    '',
    `The plan is \`${PLAN_FILE}\`: what the work is for, the checkpoints someone could demo, the steps under each, and the decisions only the user can make. Read it before you start. Any AI or person may change it, so read it again before you change it.`,
    '',
    '- Keep it true with your own file edits: tick a step (`- [x]`) when it is done, add the steps you find under the checkpoint they serve, and rewrite what turned out different.',
    '- A question only the user can answer: add `- [ ] Decide: <question>` under what it holds up, with a `Suggested:` line (answers separated by ` · `) and an `If no answer:` line. Carry on with everything it does not hold up.',
    '- When the user answers, however you asked, tick the decision and add `Answer: <their words>`. Never answer it yourself.',
    '- A checkpoint with a `Check:` line is done when its check passes: `ctxspace plan done "<checkpoint>"` runs the check and ticks it only then.',
    '- Tell the user in plain words what works now, what you need from them, and what you do next.',
  ].join('\n');
}

/** "now", "5 min ago", "3 h ago", "2 days ago", or the date. */
export function ago(at: string | undefined, now: Date = new Date()): string {
  const then = at ? Date.parse(at) : Number.NaN;
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

/** What a checkpoint's last check proved, in a few words; empty for a checkpoint without a check. */
export function proofWords(checkpoint: PlanCheckpoint, evidence: PlanEvidence | undefined, now: Date = new Date()): string {
  if (checkpoint.check === undefined && !evidence) return '';
  if (!evidence) return 'not checked yet';
  const when = ago(evidence.at, now);
  const commit = evidence.lastVerificationSha ? ` on ${evidence.lastVerificationSha.slice(0, 7)}` : '';
  const result = evidence.canProgress ? `check passed${commit}` : evidence.lastVerificationStatus === 'timeout' ? 'check took too long' : `check failed${commit}`;
  return when ? `${result} · ${when}` : result;
}

/** Done, being worked on (some steps ticked), or not started. */
function glyph(checkpoint: PlanCheckpoint): string {
  if (checkpoint.done) return '✓';
  return checkpoint.steps.some((step) => step.done) ? '◐' : '○';
}

function decisionLines(decision: PlanDecision, holder: PlanCheckpoint | undefined): string[] {
  return [
    `  ${decision.question}${holder ? `  (holds up: ${holder.title})` : ''}`,
    ...(decision.suggested.length ? [`    Suggested: ${decision.suggested.join(' · ')}`] : []),
    ...(decision.ifNoAnswer ? [`    If no answer: ${decision.ifNoAnswer}`] : []),
  ];
}

/** Where the plan stands, as `ctxspace plan` prints it: the checkpoints with their steps and proof, then what waits for the user. */
export function renderPlanStanding(read: PlanFileRead, checks: Record<string, PlanEvidence>, now: Date = new Date()): string {
  const { plan } = read;
  if (read.source === 'none') {
    return `No plan yet. Write ${PLAN_FILE} in the workspace: what the work is for, a "## Checkpoints" list of outcomes someone could demo, and the steps under each as checkboxes.`;
  }
  const lines = [`${plan.title || 'Plan'} · ${PLAN_FILE}${read.source === 'store' ? ' (written from the older plan on the first change)' : ''}`, ''];
  if (plan.checkpoints.length) {
    lines.push('CHECKPOINTS');
    const width = Math.min(60, Math.max(...plan.checkpoints.map((checkpoint) => checkpoint.title.length)));
    for (const checkpoint of plan.checkpoints) {
      const ticked = checkpoint.steps.filter((step) => step.done).length;
      const facts = [
        checkpoint.steps.length && !checkpoint.done ? `${ticked} of ${checkpoint.steps.length} steps` : '',
        proofWords(checkpoint, checks[checkpoint.key], now),
      ].filter(Boolean).join(' · ');
      const title = checkpoint.title.length > width ? `${checkpoint.title.slice(0, width - 1)}…` : checkpoint.title.padEnd(width);
      lines.push(`  ${glyph(checkpoint)} ${title}${facts ? `  ${facts}` : ''}`.trimEnd());
      const next = checkpoint.done ? undefined : checkpoint.steps.find((step) => !step.done);
      if (next) lines.push(`      next: ${next.text}`);
    }
    lines.push('');
  } else {
    lines.push('No checkpoints yet: add a "## Checkpoints" list of outcomes someone could demo, each a checkbox with its steps under it.', '');
  }
  const waiting = openDecisions(plan);
  if (waiting.length) {
    lines.push('WAITING FOR THE USER');
    for (const decision of waiting) lines.push(...decisionLines(decision, plan.checkpoints.find((checkpoint) => checkpoint.key === decision.checkpoint)));
    lines.push('');
  }
  const open = plan.steps.filter((step) => !step.done);
  if (open.length) lines.push(`OTHER STEPS  ${open.length} open`, ...open.slice(0, 5).map((step) => `  ○ ${step.text}`), ...(open.length > 5 ? [`  … and ${open.length - 5} more in ${PLAN_FILE}`] : []), '');
  return lines.join('\n').trimEnd();
}

const ACTION_WORDS: Record<PlanFileChange['action'], string> = { added: 'added', removed: 'removed', ticked: 'ticked', unticked: 'unticked', answered: 'answered' };

/** Who changed something, as people say it. */
export function whoWords(by: string): string {
  if (by === 'user') return 'You';
  if (by === 'file') return `${PLAN_FILE} edit`;
  if (by === 'contextspace') return 'ContextSpace';
  return by.charAt(0).toUpperCase() + by.slice(1);
}

/** The latest changes, one a line, newest first. */
export function renderPlanChanges(changes: readonly PlanFileChange[], now: Date = new Date()): string {
  if (!changes.length) return 'Nothing has changed in the plan yet.';
  return changes.map((change) => `  ${ago(change.at, now).padEnd(12)} ${whoWords(change.by).padEnd(14)} ${ACTION_WORDS[change.action]} ${change.kind} "${change.text}"${change.note ? `: ${change.note}` : ''}`).join('\n');
}

/** The plan as `ctxspace plan --json` prints it, for tools that read JSON. */
export function planFileToJson(read: PlanFileRead, checks: Record<string, PlanEvidence>) {
  const { plan } = read;
  const decision = (entry: PlanDecision) => ({
    question: entry.question, answered: entry.done, ...(entry.answer ? { answer: entry.answer } : {}),
    suggested: entry.suggested, ...(entry.ifNoAnswer ? { ifNoAnswer: entry.ifNoAnswer } : {}), ...(entry.detail ? { detail: entry.detail } : {}),
  });
  return {
    file: PLAN_FILE,
    source: read.source,
    title: plan.title,
    checkpoints: plan.checkpoints.map((checkpoint) => ({
      title: checkpoint.title, done: checkpoint.done,
      ...(checkpoint.check !== undefined ? { check: checkpoint.check ?? 'the workspace checks' } : {}),
      ...(checks[checkpoint.key] ? { proof: checks[checkpoint.key] } : {}),
      ...(checkpoint.outcome ? { outcome: checkpoint.outcome } : {}),
      steps: checkpoint.steps.map((step) => ({ text: step.text, done: step.done })),
      decisions: checkpoint.decisions.map(decision),
    })),
    steps: plan.steps.map((step) => ({ text: step.text, done: step.done })),
    decisions: plan.decisions.map(decision),
    waitingForTheUser: openDecisions(plan).map((entry) => entry.question),
  };
}

/** A count line after a change, so the caller sees where the plan stands without reading it again. */
export function standingLine(plan: PlanFile): string {
  const done = plan.checkpoints.filter((checkpoint) => checkpoint.done).length;
  const waiting = openDecisions(plan).length;
  return `Plan: ${done} of ${plan.checkpoints.length} checkpoints done${waiting ? ` · ${waiting} waiting for the user` : ''}. Run "ctxspace plan" to see it.`;
}
