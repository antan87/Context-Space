/**
 * How the Plan tab words and draws each item: the status icon and tone, the one line under a name,
 * who did what in What changed, and plan codes in chat as names. Pure, so it is tested on its own.
 */

import { CircleCheck, Circle, CircleDashed, CircleDot, CirclePause, CircleSlash, CircleX, type LucideIcon } from 'lucide-react';
import type { PlanChangeEntry, PlanItemView, PlanStatus, PlanView, PlanWords, ProposalAction } from './planTypes.js';

export type Tone = 'idle' | 'ai' | 'needs' | 'done' | 'reopened';

/** Each status has an icon and a word; colour only repeats what they say. */
export const STATUS_LOOK: Record<PlanStatus, { icon: LucideIcon; tone: Tone }> = {
  todo: { icon: Circle, tone: 'idle' },
  in_progress: { icon: CircleDot, tone: 'ai' },
  blocked: { icon: CircleSlash, tone: 'reopened' },
  done: { icon: CircleCheck, tone: 'done' },
  dropped: { icon: CircleX, tone: 'idle' },
  later: { icon: CirclePause, tone: 'idle' },
};
/** An item that waits for the user's answer or OK. */
export const NEEDS_YOU_LOOK = { icon: CircleDashed, tone: 'needs' as Tone };

/**
 * The shared words speak about "the user", for AI tools. Shown to the user, they say "you".
 */
export function forYou(text: string): string {
  return text
    .replace(/\bthe user sees\b/g, 'you see').replace(/\bThe user sees\b/g, 'You see')
    .replace(/\bthe user's\b/g, 'your').replace(/\bThe user's\b/g, 'Your')
    .replace(/\bthe user\b/g, 'you').replace(/\bThe user\b/g, 'You');
}

/** The colour of each tone, from the app's state tokens. */
export const TONE_CLASS: Record<Tone, string> = {
  idle: 'text-muted-foreground',
  ai: 'text-[var(--state-ai)]',
  needs: 'text-[var(--state-needs)]',
  done: 'text-[var(--state-done)]',
  reopened: 'text-[var(--state-reopened)]',
};

const HOW_IT_WORKS_SEEN = 'contextspace.plan.how-it-works-seen';
/** Whether How it works has been shown here before. Storage can be unavailable; then it shows once per load. */
export function howItWorksSeen(): boolean {
  try { return window.localStorage.getItem(HOW_IT_WORKS_SEEN) === '1'; } catch { return false; }
}
export function rememberHowItWorksSeen(): void {
  try { window.localStorage.setItem(HOW_IT_WORKS_SEEN, '1'); } catch { /* shown again next time */ }
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Who made a change, as the tab says it: You, the AI tool by name, or ContextSpace. */
export function whoName(by: string | undefined): string {
  const name = (by ?? 'agent').trim();
  if (/^user$/i.test(name)) return 'You';
  if (/^agent$/i.test(name)) return 'The AI';
  if (/^contextspace$/i.test(name)) return 'ContextSpace';
  if (/^antigravity$/i.test(name)) return 'Antigravity';
  return sentenceCase(name);
}

/** Who answers a question. */
function answerer(owner: string | undefined): string {
  const name = owner?.trim() || 'user';
  if (/^user$/i.test(name)) return 'you';
  if (/^agent$/i.test(name)) return 'the AI';
  return whoName(name);
}

const PROPOSAL_WORDS: Record<ProposalAction, string> = {
  done: 'says it is done', answer: 'proposes an answer', drop: 'asks to drop it', later: 'asks to move it to later', reopen: 'asks to reopen it',
};

/** What a proposal asks, in one line: "Claude says it is done". */
export function proposalLine(item: PlanItemView): string {
  if (!item.proposal) return '';
  return `${whoName(item.proposal.by)} ${PROPOSAL_WORDS[item.proposal.action]}`;
}

/** Who is working on an item: the last one to start it. */
function startedBy(item: PlanItemView): string | undefined {
  const entry = [...(item.history ?? [])].reverse().find((candidate) => candidate.action === 'started');
  return entry ? whoName(entry.by) : undefined;
}

/** The line under an item's name: where it is, and what it carries. */
export function stateLine(item: PlanItemView, words: PlanWords): string {
  if (item.proposal) return `${proposalLine(item)} · ${item.proposal.note}`;
  const label = words.statuses[item.status].label;
  switch (item.status) {
    case 'todo': {
      if (item.kind === 'question') return answerer(item.owner) === 'you' ? 'Waiting for your answer' : `${sentenceCase(answerer(item.owner))} answers`;
      const open = item.waitsFor.filter((wait) => wait.status !== 'done' && wait.status !== 'dropped');
      return open.length ? `${label} · starts after ${open.map((wait) => wait.label).join(', ')}` : `${label} · ready to start`;
    }
    case 'in_progress': {
      const who = startedBy(item);
      return who ? `${label} · ${who}` : label;
    }
    case 'blocked': return `${label} · ${item.blockedReason ?? 'no reason given'}`;
    case 'done': return item.kind === 'question' ? `Answered · ${item.resolution ?? ''}` : `${label} · ${item.resolution ?? ''}`;
    case 'dropped': return `${label} · ${item.resolution ?? ''}`;
    case 'later': return `${label} · look again ${item.revisitWhen ?? 'later'}`;
  }
}

/** The look of a row: an item waiting for the user shows as Needs you, whatever its status. */
export function itemLook(item: PlanItemView): { icon: LucideIcon; tone: Tone } {
  const waitsForUser = Boolean(item.proposal) || (item.kind === 'question' && item.status === 'todo' && answerer(item.owner) === 'you');
  return waitsForUser ? NEEDS_YOU_LOOK : STATUS_LOOK[item.status];
}

/** "2 min ago", "3 h ago", "Oct 7". Empty when the time is unknown, never an invented date. */
export function whenText(at: string | undefined, now: Date = new Date()): string {
  const then = at ? Date.parse(at) : NaN;
  // The epoch stands in for a time that was never recorded; showing it would say "Jan 1".
  if (!Number.isFinite(then) || then <= 0) return '';
  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One line of What changed: "Claude started M2 CSV export endpoint". */
export function changeText(entry: PlanChangeEntry, words: PlanWords): string {
  const verb = words.changes[entry.action] ?? entry.action;
  return `${verb} ${entry.label}${entry.note ? `: ${entry.note}` : ''}`;
}

/** How far the milestones are: done ones over all that are not dropped. */
export function milestoneProgress(view: Pick<PlanView, 'milestones'>): { done: number; total: number } {
  const live = view.milestones.filter((item) => item.status !== 'dropped');
  return { done: live.filter((item) => item.status === 'done').length, total: live.length };
}

/** Every item's code and name, for showing codes in chat as names. */
export function planNames(view: Pick<PlanView, 'needsYou' | 'milestones' | 'otherOpen' | 'closed'> | undefined): Map<string, string> {
  const names = new Map<string, string>();
  if (!view) return names;
  for (const item of [...view.needsYou, ...view.milestones, ...view.otherOpen, ...view.closed]) names.set(item.id, item.title);
  return names;
}

export type PlanCodePart = string | { id: string; title: string; named: boolean };

/**
 * Splits text at plan codes the plan knows ("M2"), so each can be shown with its name. `named` says
 * the name already follows the code in the text, so only the code needs marking.
 */
export function splitPlanCodes(text: string, names: Map<string, string>): PlanCodePart[] {
  if (!names.size) return [text];
  const codes = [...names.keys()].sort((a, b) => b.length - a.length).map((code) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\w-])(${codes.join('|')})(?![\\w-])`, 'g');
  const parts: PlanCodePart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const id = match[1]!;
    const title = names.get(id)!;
    const after = text.slice(match.index + id.length).replace(/^[\s:–—-]+/, '');
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ id, title, named: after.toLowerCase().startsWith(title.toLowerCase()) });
    last = match.index + id.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

/** What a tool is working on, by the plan: the in-progress items it started, newest first. */
export function workingOn(view: Pick<PlanView, 'milestones' | 'otherOpen' | 'needsYou'> | undefined, tool: string): PlanItemView[] {
  if (!view) return [];
  const started = (item: PlanItemView) => [...(item.history ?? [])].reverse().find((entry) => entry.action === 'started');
  const seen = new Set<string>();
  return [...view.milestones, ...view.otherOpen, ...view.needsYou]
    .filter((item) => !seen.has(item.id) && seen.add(item.id) && item.status === 'in_progress' && started(item)?.by.toLowerCase() === tool.toLowerCase())
    .sort((a, b) => (started(b)?.at ?? '').localeCompare(started(a)?.at ?? ''));
}

/** Items a new session can start on: ready milestones and tasks, then what is in progress, without items waiting for the user. */
export function startableItems(view: PlanView | undefined): PlanItemView[] {
  if (!view) return [];
  const all = [...view.milestones, ...view.otherOpen];
  const ready = all.filter((item) => view.ready.includes(item.label));
  const going = all.filter((item) => item.status === 'in_progress' && !item.proposal);
  return [...ready, ...going.filter((item) => !ready.includes(item))];
}
