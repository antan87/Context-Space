/**
 * What the Where Are We strip says, worked out from checkable facts. Pure, so
 * every rule can be tested without a DOM. Nothing here writes prose of its own
 * about the work: counts and states come from the facts, and the only AI words
 * shown are its own suggestions and questions, labelled as such by the caller.
 */

import type { MilestoneFact, OpenQuestion, ProgressFacts, ScreenEvent, SessionAssistant, WorkGuidance } from '../../types';
import type { RingMilestone } from './ringGeometry';

export type NextEvent = Extract<ScreenEvent, { event: 'next' }>;
export type ProposalEvent = Extract<ScreenEvent, { event: 'milestone_proposal' }>;

// ─── The ring ───────────────────────────────────────────────────────────────

/** The milestones in plan order, as the Context Ring draws them. No fraction is ever invented. */
export function ringMilestones(facts: ProgressFacts | undefined): RingMilestone[] {
  return (facts?.milestones ?? []).map((milestone) => ({ state: milestone.state, title: milestone.title }));
}

/** Where the "you are here" marker goes, or undefined when the current milestone is not in the plan. */
export function currentMilestoneIndex(facts: ProgressFacts | undefined): number | undefined {
  if (!facts?.currentMilestoneId) return undefined;
  const index = facts.milestones.findIndex((milestone) => milestone.id === facts.currentMilestoneId);
  return index < 0 ? undefined : index;
}

// ─── The state chip ─────────────────────────────────────────────────────────

export type StripTone = 'needs' | 'ai' | 'done' | 'reopened' | 'idle';

const unavailable = (facts: ProgressFacts, source: ProgressFacts['unavailable'][number]['source']) =>
  facts.unavailable.some((entry) => entry.source === source);

/** A failed or timed-out check that may still describe the code as it is now. */
export function checkIsFailing(facts: ProgressFacts): boolean {
  const { status, freshness } = facts.verification;
  return (status === 'fail' || status === 'timeout') && freshness !== 'stale' && !unavailable(facts, 'verification');
}

/** The one state the chip shows. What needs the developer comes before what is merely under way. */
export function stripState(facts: ProgressFacts): { tone: StripTone; label: string } {
  const { counts } = facts;
  if (facts.openQuestions.length > 0 && !unavailable(facts, 'questions')) return { tone: 'needs', label: 'Needs you' };
  if (counts.blocked > 0) return { tone: 'needs', label: 'Blocked' };
  if (checkIsFailing(facts)) return { tone: 'needs', label: 'Check failing' };
  if (counts.reopened > 0) return { tone: 'reopened', label: 'Reopened' };
  if (counts.inProgress > 0) return { tone: 'ai', label: 'In progress' };
  if (unavailable(facts, 'milestones')) return { tone: 'idle', label: 'Plan unavailable' };
  if (counts.total === 0) return { tone: 'idle', label: 'No plan yet' };
  if (counts.done === counts.total) return { tone: 'done', label: 'All done' };
  return { tone: 'idle', label: 'Not started' };
}

// ─── The facts line ─────────────────────────────────────────────────────────

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The short facts beside the chip. A fact whose source could not be read is left
 * out rather than shown as zero, and a zero that carries no news is left out too.
 */
export function factsLine(facts: ProgressFacts): string[] {
  const out: string[] = [];
  if (!unavailable(facts, 'milestones') && facts.counts.total > 0) out.push(`${facts.counts.done} of ${facts.counts.total} done`);
  if (!unavailable(facts, 'questions') && facts.openQuestions.length > 0) out.push(plural(facts.openQuestions.length, 'question'));
  if (!unavailable(facts, 'changes') && facts.changes.files > 0) out.push(`${plural(facts.changes.files, 'file')} changed`);
  if (!unavailable(facts, 'verification')) {
    const { status, freshness } = facts.verification;
    if (status === 'pass' || status === 'pass_dirty') out.push(freshness === 'stale' ? 'checks passed, code changed since' : 'checks passed');
    else if (status === 'fail') out.push(freshness === 'stale' ? 'checks failed, code changed since' : 'checks failed');
    else if (status === 'timeout') out.push(freshness === 'stale' ? 'checks timed out, code changed since' : 'checks timed out');
  }
  return out;
}

// ─── The goal ───────────────────────────────────────────────────────────────

/** Sentences this short are not cut off: "Fix v2." is a whole goal, not the opening of one. */
const HEADLINE_MIN = 20;

/**
 * The opening of a goal: its first line, cut after the first sentence. An objective is often a paragraph (the problem,
 * the evidence, the plan), and a line on screen has room for what it is for, not why.
 */
export function headline(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  const end = /[.!?](?=\s|$)/g;
  for (let match = end.exec(line); match; match = end.exec(line)) {
    if (match.index + 1 >= HEADLINE_MIN && match.index + 1 < line.length) return line.slice(0, match.index + 1);
  }
  return line;
}

/** What the work is for: the opening of the assignment's objective, else the current milestone, else nothing. `full` is the whole objective when it says more. */
export function goalLine(guidance: WorkGuidance | undefined, facts: ProgressFacts | undefined): { stage?: string; text: string; full?: string } {
  // Read defensively: a server from before the fix sends no objective for a workspace without a description.
  const objective = guidance?.assignment?.objective?.trim();
  if (objective) {
    const text = headline(objective);
    return text === objective ? { stage: guidance!.assignment.stage, text } : { stage: guidance!.assignment.stage, text, full: objective };
  }
  const current = facts?.milestones.find((milestone) => milestone.id === facts.currentMilestoneId);
  return current ? { text: current.title } : { text: '' };
}

// ─── Replies ────────────────────────────────────────────────────────────────

const ASSISTANTS: readonly SessionAssistant[] = ['claude', 'antigravity', 'codex', 'copilot', 'cursor', 'pi'];

/**
 * Whether a line sent to the CLI running `target` (claude, codex, antigravity-cli...) answers an open question. A
 * question that names another assistant waits for that one; one that names none, or an unknown one, any CLI answers.
 */
export function answersQuestion(target: string, questions: readonly Pick<OpenQuestion, 'harness'>[]): boolean {
  if (target === 'shell') return false;
  return questions.some(({ harness }) => {
    const name = harness.trim().toLowerCase();
    return !ASSISTANTS.includes(name as SessionAssistant) || target === name || target.startsWith(`${name}-`);
  });
}

// ─── Next ───────────────────────────────────────────────────────────────────

export type NextAction =
  | { kind: 'panel'; section: 'open' | 'milestones'; label: string; reason: string }
  | { kind: 'prompt'; source: 'ai' | 'facts'; label: string; reason: string; prompt: string; target?: { path: string; line?: number } };

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`);

const at = (timestamp: string) => {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? time : undefined;
};

/**
 * The files the AI asked to put in front of the developer (show, or a note on a line) since `since`, oldest first, and
 * not yet opened. Older ones come back in the replay when a stream opens; opening them again would steal the panel.
 */
export function freshReveals(events: readonly ScreenEvent[], since: number, opened: ReadonlySet<string>): { id: string; target: { path: string; line?: number } }[] {
  const out: { id: string; time: number; target: { path: string; line?: number } }[] = [];
  for (const event of events) {
    if ((event.event !== 'show' && event.event !== 'annotate') || opened.has(event.id) || !event.payload.path) continue;
    const time = at(event.timestamp);
    if (time === undefined || time < since) continue;
    const { path, repo, line } = event.payload;
    out.push({ id: event.id, time, target: { path: repo ? `${repo}/${path}` : path, ...(line !== undefined ? { line } : {}) } });
  }
  return out.sort((a, b) => a.time - b.time).map(({ id, target }) => ({ id, target }));
}

/** The AI's most recent suggestion for what to do next, or undefined when it has made none. */
export function latestNext(events: readonly ScreenEvent[]): NextEvent | undefined {
  let latest: NextEvent | undefined;
  for (const event of events) {
    if (event.event !== 'next') continue;
    if (!latest || (at(event.timestamp) ?? 0) >= (at(latest.timestamp) ?? 0)) latest = event;
  }
  return latest;
}

/**
 * What the Next button offers. A question waiting on the developer comes first,
 * then the AI's own suggestion, then whatever the facts say is the obvious step.
 * Returns null when nothing is left to do, so the button is not shown at all.
 */
export function nextAction(facts: ProgressFacts, suggestion?: NextEvent): NextAction | null {
  const question = facts.openQuestions[0];
  if (question && !unavailable(facts, 'questions')) {
    return { kind: 'panel', section: 'open', label: 'Answer the question', reason: clip(question.message, 140) };
  }
  if (suggestion) {
    const { title, reason, path, repo, line } = suggestion.payload;
    return {
      kind: 'prompt', source: 'ai', label: title, reason, prompt: `Go ahead: ${title}`,
      ...(path ? { target: { path: repo ? `${repo}/${path}` : path, ...(line !== undefined ? { line } : {}) } } : {}),
    };
  }
  const blocked = facts.milestones.find((milestone) => milestone.state === 'blocked');
  if (blocked) {
    return { kind: 'panel', section: 'milestones', label: `Unblock "${blocked.title}"`, reason: blocked.blockedReason ?? blocked.unblockCondition ?? 'It is blocked.' };
  }
  if (checkIsFailing(facts)) {
    return { kind: 'prompt', source: 'facts', label: 'Look at the failing check', reason: 'The last verification failed.', prompt: 'The last check failed. Please find out why and fix it.' };
  }
  const reopened = facts.milestones.find((milestone) => milestone.state === 'reopened');
  if (reopened) {
    const why = reopened.reopen?.reason.trim();
    return { kind: 'prompt', source: 'facts', label: `Redo "${reopened.title}"`, reason: why ? `Reopened: ${why}` : 'It was reopened.', prompt: `Let's redo "${reopened.title}"${why ? `: ${why}` : '.'}` };
  }
  const underway = facts.milestones.find((milestone) => milestone.id === facts.currentMilestoneId && milestone.state === 'in_progress')
    ?? facts.milestones.find((milestone) => milestone.state === 'in_progress');
  if (underway) {
    return { kind: 'prompt', source: 'facts', label: `Continue "${underway.title}"`, reason: 'It is in progress.', prompt: `Continue with "${underway.title}".` };
  }
  // The plan's Next, by the one rule every surface uses. It is offered only when it can start.
  const next = facts.milestones.find((milestone) => milestone.id === facts.nextMilestoneId);
  if (next && next.state === 'upcoming' && next.waitingOn.length === 0) {
    return { kind: 'prompt', source: 'facts', label: `Start "${next.title}"`, reason: 'Nothing it depends on is left.', prompt: `Start "${next.title}".` };
  }
  return null;
}

// ─── The AI's proposals ─────────────────────────────────────────────────────

export interface ActiveProposal { event: ProposalEvent; milestone: MilestoneFact }

/**
 * Proposals the AI made that still make sense, newest per milestone, in plan
 * order. A proposal goes stale when the milestone moved on after it was made, and
 * the developer can dismiss one. Only the developer ever acts on a proposal.
 */
export function activeProposals(events: readonly ScreenEvent[], facts: ProgressFacts, dismissed: ReadonlySet<string> = new Set()): ActiveProposal[] {
  const newest = new Map<string, ProposalEvent>();
  for (const event of events) {
    if (event.event !== 'milestone_proposal') continue;
    const held = newest.get(event.payload.stepId);
    if (!held || (at(event.timestamp) ?? 0) >= (at(held.timestamp) ?? 0)) newest.set(event.payload.stepId, event);
  }
  const out: ActiveProposal[] = [];
  for (const milestone of facts.milestones) {
    const event = newest.get(milestone.id);
    if (!event || dismissed.has(event.id)) continue;
    const made = at(event.timestamp);
    if (event.payload.proposal === 'reopen') {
      const completed = milestone.completedAt ? at(milestone.completedAt) : undefined;
      if (milestone.state !== 'done' || (made !== undefined && completed !== undefined && completed > made)) continue;
    } else {
      const reopened = milestone.reopen ? at(milestone.reopen.at) : undefined;
      if ((milestone.state !== 'in_progress' && milestone.state !== 'reopened') || (made !== undefined && reopened !== undefined && reopened > made)) continue;
    }
    out.push({ event, milestone });
  }
  return out;
}

// ─── Small formats ──────────────────────────────────────────────────────────

/** "just now", "5 min ago", "3 h ago", "2 d ago". Empty for a time that cannot be read. */
export function formatAge(timestamp: string | undefined, now: number = Date.now()): string {
  const time = timestamp ? at(timestamp) : undefined;
  if (time === undefined) return '';
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The last check, in words, for the panel. Null when no check has run or it cannot be read. */
export function verificationLine(facts: ProgressFacts, now: number = Date.now()): { tone: 'bad' | 'ok' | 'note'; text: string } | null {
  if (unavailable(facts, 'verification')) return null;
  const { status, freshness, verifiedAt } = facts.verification;
  const when = formatAge(verifiedAt, now);
  const ran = when ? ` ${when}` : '';
  if (status === 'fail' || status === 'timeout') {
    const what = status === 'fail' ? 'failed' : 'timed out';
    return { tone: freshness === 'stale' ? 'note' : 'bad', text: freshness === 'stale' ? `The last check ${what}${ran}; the code has changed since.` : `The last check ${what}${ran}.` };
  }
  if (status === 'pass' || status === 'pass_dirty') {
    return freshness === 'stale'
      ? { tone: 'note', text: `The last check passed${ran}; the code has changed since.` }
      : { tone: 'ok', text: `The last check passed${ran}.` };
  }
  return null;
}
