/**
 * @module core/plan-words
 * The words of the older plan store (`contextspace-plan.json`): its statuses and kinds of item. Only moving an older
 * plan into PLAN.md reads them now (core/plan, core/plan-file-convert).
 */

export const PLAN_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'dropped', 'later'] as const;
export type PlanStatus = typeof PLAN_STATUSES[number];

export const PLAN_KINDS = ['milestone', 'task', 'question', 'decision', 'existing'] as const;
export type PlanKind = typeof PLAN_KINDS[number];

/** Where an item is, in six words. Each says what the item must also carry. */
export const STATUS_WORDS: Record<PlanStatus, { label: string; meaning: string }> = {
  todo: { label: 'To do', meaning: 'Not started yet.' },
  in_progress: { label: 'In progress', meaning: 'Someone is working on it. It says who.' },
  blocked: { label: 'Blocked', meaning: 'Stuck. It always says why.' },
  done: { label: 'Done', meaning: 'Finished. It says what came out of it, or the answer.' },
  dropped: { label: 'Dropped', meaning: 'Not needed any more. It says why.' },
  later: { label: 'Later', meaning: 'Not now. It says when to look at it again.' },
};

/** What an item can be. The prefix starts the codes of new items: M1, T2, Q3, D1, E1. */
export const KIND_WORDS: Record<PlanKind, { label: string; prefix: string; meaning: string }> = {
  milestone: { label: 'Milestone', prefix: 'M', meaning: 'A step that delivers something. It has a check, for example the tests.' },
  task: { label: 'Task', prefix: 'T', meaning: 'Smaller work, often something a milestone waits for.' },
  question: { label: 'Question', prefix: 'Q', meaning: 'Someone must answer it. It says who.' },
  decision: { label: 'Decision', prefix: 'D', meaning: 'Something chosen, kept so nobody asks again.' },
  existing: { label: 'Existing work', prefix: 'E', meaning: 'Already built somewhere. Kept so the AI reuses it.' },
};

/**
 * What the app records on the plan's copy of a chat question when the developer replies in the chat. The app sees
 * that they replied, not what they said, so the AI then writes their words over it with `ctxspace plan answer`.
 */
export const ANSWERED_IN_CHAT = 'Answered in the chat.';

/** Statuses that still need someone to act. */
export const OPEN_STATUSES: readonly PlanStatus[] = ['todo', 'in_progress', 'blocked'];

/** Statuses that settle what an item waits for: nothing more will happen there. */
export const SETTLED_STATUSES: readonly PlanStatus[] = ['done', 'dropped'];

export function isOpenStatus(status: PlanStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isSettledStatus(status: PlanStatus): boolean {
  return SETTLED_STATUSES.includes(status);
}

/** An item as everyone names it: its code, then its name. Never the code alone. */
export function itemLabel(item: { id: string; title: string }): string {
  return `${item.id} ${item.title}`;
}

export function statusLabel(status: PlanStatus): string {
  return STATUS_WORDS[status].label;
}

/** Full commit hashes cut to the seven characters people use: "Passed its check on c9043b3". */
export function shortCommits(text: string): string {
  return text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/gi, '$1');
}

/** Ends a sentence that may end in a name: "Added Q1 Which time zone?" needs no extra full stop. */
export function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

