/**
 * What the strip above the chat takes from the plan: the questions that wait for the developer, and
 * what the AI closed while they were not looking. Pure, so it is tested on its own.
 */

import type { OpenQuestion } from '../../types.js';
import type { PlanChangeEntry, PlanItemView, PlanView } from '../plan/planTypes.js';
import { whenText, whoName } from '../plan/planView.js';

/** Who asked a plan question, when, and what it holds up, in one line. */
export function questionContext(item: PlanItemView): string {
  const asker = item.history?.find((entry) => entry.action === 'added');
  const asked = asker ? `${whoName(asker.by)} asked${whenText(asker.at) ? ` ${whenText(asker.at)}` : ''}` : 'Question';
  return item.holdsUp.length ? `${asked} · holds up ${item.holdsUp.map((label) => label.replace(/^\S+\s/, '')).join(', ')}` : asked;
}

/**
 * Whether a plan question is the AI's chat question. The plan names a chat question by its words, cut
 * with an ellipsis when they are longer than a name may be (core `questionTitle`).
 */
export function sameQuestion(planTitle: string, chatMessage: string): boolean {
  const message = chatMessage.replace(/\s+/g, ' ').trim();
  if (!planTitle.endsWith('…')) return message === planTitle;
  return message.startsWith(planTitle.slice(0, -1).trimEnd());
}

/** The plan's question that a chat question is, when the AI put it in the plan. */
export function planQuestionFor(view: PlanView | undefined, question: OpenQuestion): PlanItemView | undefined {
  return view?.needsYou.find((item) => item.kind === 'question' && !item.proposal && sameQuestion(item.title, question.message));
}

/** The plan's questions for the developer that the chat is not already asking, oldest first. */
export function planQuestionsForYou(view: PlanView | undefined, chat: readonly OpenQuestion[]): PlanItemView[] {
  if (!view) return [];
  return view.needsYou.filter((item) => item.kind === 'question' && !item.proposal && !chat.some((question) => sameQuestion(item.title, question.message)));
}

const CLOSES = new Set(['done', 'dropped', 'later', 'reopened']);

/** Whether a change was made by an AI tool: not by the developer, and not by ContextSpace moving old files. */
export function byAi(by: string): boolean {
  return !/^(user|contextspace)$/i.test(by.trim());
}

/** The milestones an AI finished, dropped, put off or reopened after `since`, newest first. */
export function aiCloses(view: PlanView | undefined, since: string | undefined): PlanChangeEntry[] {
  if (!view) return [];
  const milestones = new Set(view.milestones.map((item) => item.id));
  return view.changes.filter((entry) => CLOSES.has(entry.action) && milestones.has(entry.itemId) && byAi(entry.by) && (!since || entry.at > since));
}

const SEEN_KEY = (workspace: string) => `contextspace.strip.seen-closes.${workspace}`;

/** When the developer last said they saw what the AI closed here. Storage can be unavailable: then nothing is remembered. */
export function readSeenCloses(workspace: string): string | undefined {
  try { return window.localStorage.getItem(SEEN_KEY(workspace)) ?? undefined; } catch { return undefined; }
}
export function rememberSeenCloses(workspace: string, at: string): void {
  try { window.localStorage.setItem(SEEN_KEY(workspace), at); } catch { /* shown again next time */ }
}
