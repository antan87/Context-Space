/**
 * What the strip above the chat takes from the plan (PLAN.md): the decisions that wait for the developer, and the
 * checkpoints an AI ticked while they were not looking. Pure, so it is tested on its own.
 */

import type { OpenQuestion } from '../../types.js';
import type { PlanFileChange, PlanFileView } from '../plan/planFile.js';
import { changedBy } from '../plan/planFile.js';
import { whenText } from '../plan/planView.js';

/** A decision in the plan that waits for the developer, as the strip and its panel show it. */
export interface PlanQuestion {
  /** The decision's key in PLAN.md. */
  id: string;
  title: string;
  /** Why it is asked, with its suggested answers as "Suggested answers: A · B". */
  detail?: string;
  /** Who asked, when, and what it holds up, in one line. */
  context: string;
  /** The open checkpoint it holds up. */
  holdsUp?: string;
}

/** A checkpoint an AI ticked, as the strip says it. */
export interface PlanClose {
  at: string;
  by: string;
  action: string;
  /** The checkpoint's key in PLAN.md. */
  itemId: string;
  label: string;
  note?: string;
}

/**
 * Whether a plan question is the AI's chat question. The plan words a chat question as it was asked, cut with an
 * ellipsis when it is longer than a line of the plan may be (core `questionTitle`).
 */
export function sameQuestion(planTitle: string, chatMessage: string): boolean {
  const message = chatMessage.replace(/\s+/g, ' ').trim();
  if (!planTitle.endsWith('…')) return message === planTitle;
  return message.startsWith(planTitle.slice(0, -1).trimEnd());
}

/** The decisions that wait for the developer, oldest in the file first, with who asked and what each holds up. */
function waitingQuestions(view: PlanFileView): PlanQuestion[] {
  const decisions = [...view.checkpoints.flatMap((checkpoint) => checkpoint.decisions.map((decision) => ({ decision, holder: checkpoint }))), ...view.decisions.map((decision) => ({ decision, holder: undefined }))];
  return decisions.filter(({ decision }) => view.waiting.includes(decision.key)).map(({ decision, holder }) => {
    const added = view.changes.find((change) => change.key === decision.key && change.action === 'added' && change.by !== 'file');
    const asked = added ? `${changedBy(added.by)} asked${whenText(added.at) ? ` ${whenText(added.at)}` : ''}` : 'Waits for you';
    const why = [decision.detail, decision.ifNoAnswer ? `If you don't answer: ${decision.ifNoAnswer}` : '', decision.suggested.length ? `Suggested answers: ${decision.suggested.join(' · ')}` : '']
      .filter(Boolean).join('\n\n');
    const holdsUp = holder && !holder.done ? holder.title : undefined;
    return { id: decision.key, title: decision.question, ...(why ? { detail: why } : {}), context: holdsUp ? `${asked} · holds up ${holdsUp}` : asked, ...(holdsUp ? { holdsUp } : {}) };
  });
}

/** The plan's decision that a chat question is, when the AI put it in the plan. */
export function planQuestionFor(view: PlanFileView | undefined, question: OpenQuestion): PlanQuestion | undefined {
  return view ? waitingQuestions(view).find((item) => sameQuestion(item.title, question.message)) : undefined;
}

/** The plan's decisions for the developer that the chat is not already asking. */
export function planQuestionsForYou(view: PlanFileView | undefined, chat: readonly OpenQuestion[]): PlanQuestion[] {
  if (!view) return [];
  return waitingQuestions(view).filter((item) => !chat.some((question) => sameQuestion(item.title, question.message)));
}

/** Whether a change was made by an AI: not by the developer, and not by ContextSpace itself. */
export function byAi(by: string): boolean {
  return !/^(user|contextspace)$/i.test(by.trim());
}

/** The checkpoints an AI ticked after `since`, newest first. An edit to the file names nobody; it is nearly always an AI's. */
export function aiCloses(view: PlanFileView | undefined, since: string | undefined): PlanClose[] {
  if (!view) return [];
  return view.changes
    .filter((change: PlanFileChange) => change.kind === 'checkpoint' && change.action === 'ticked' && byAi(change.by) && (!since || change.at > since))
    .map((change) => ({ at: change.at, by: change.by === 'file' || change.by === 'ai' ? 'agent' : change.by, action: 'done', itemId: change.key, label: change.text }));
}

const SEEN_KEY = (workspace: string) => `contextspace.strip.seen-closes.${workspace}`;

/** When the developer last said they saw what the AI closed here. Storage can be unavailable: then nothing is remembered. */
export function readSeenCloses(workspace: string): string | undefined {
  try { return window.localStorage.getItem(SEEN_KEY(workspace)) ?? undefined; } catch { return undefined; }
}
export function rememberSeenCloses(workspace: string, at: string): void {
  try { window.localStorage.setItem(SEEN_KEY(workspace), at); } catch { /* shown again next time */ }
}
