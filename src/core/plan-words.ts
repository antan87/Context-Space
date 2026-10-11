/**
 * @module core/plan-words
 * The words of the workspace plan, kept in one place: the status words, the kinds of item, the
 * section names and the rules. The Plan tab, `ctxspace plan`, the MCP plan tools and the generated
 * AGENTS.md all read them from here, so a person and every AI tool see the same plan in the same
 * words. Change a word here and every surface changes with it.
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

/** Not a status: everything that waits for the user's answer or OK. */
export const NEEDS_YOU = {
  label: 'Needs you',
  meaning: "Not a status. It collects what waits for the user's answer or OK.",
} as const;

/** What an item can be. The prefix starts the codes of new items: M1, T2, Q3, D1, E1. */
export const KIND_WORDS: Record<PlanKind, { label: string; prefix: string; meaning: string }> = {
  milestone: { label: 'Milestone', prefix: 'M', meaning: 'A step that delivers something. It has a check, for example the tests.' },
  task: { label: 'Task', prefix: 'T', meaning: 'Smaller work, often something a milestone waits for.' },
  question: { label: 'Question', prefix: 'Q', meaning: 'Someone must answer it. It says who.' },
  decision: { label: 'Decision', prefix: 'D', meaning: 'Something chosen, kept so nobody asks again.' },
  existing: { label: 'Existing work', prefix: 'E', meaning: 'Already built somewhere. Kept so the AI reuses it.' },
};

/** The sections of the plan, in the order every surface shows them. */
export const PLAN_SECTIONS = [
  { key: 'goal', label: 'Goal' },
  { key: 'needsYou', label: NEEDS_YOU.label },
  { key: 'milestones', label: 'Milestones' },
  { key: 'otherOpen', label: 'Other open work' },
  { key: 'closed', label: 'Done and dropped' },
  { key: 'changes', label: 'What changed' },
] as const;
export type PlanSectionKey = typeof PLAN_SECTIONS[number]['key'];

/** The six rules, as the How it works panel, `ctxspace plan --help` and AGENTS.md state them. */
export const PLAN_RULES = [
  'Every close has a reason. Nothing is deleted.',
  "The AI closes only its own items. For the user's items, and for milestones, it asks: the user sees it under Needs you.",
  'A milestone is done when everything it waits for is done and its check passes on the latest code.',
  'Nothing starts by itself. When a milestone is done, the next one is suggested.',
  'Plans change: anyone can add, move, block or reopen an item at any time. History shows who did what, and when.',
  'Before the workspace is finished, everything a milestone waits for must be handled. Other open items only warn. Finishing anyway needs a reason.',
] as const;

/**
 * How an AI works with the plan, step by step, for the generated AGENTS.md. In the agy and Haiku test,
 * this routine cut agy's tool calls from 166 to 58, its reads outside the workspace from 50 to 0,
 * and its codes written without a name to 0: rules alone left the AI guessing how to work.
 */
export const PLAN_WORKFLOW: readonly { text: string; list?: readonly string[] }[] = [
  { text: 'Start by running `ctxspace plan`. Its output is the whole plan: you do not need the program\'s code, the store file, or other folders.' },
  { text: 'Continue what is in progress for you, or start what is ready: `ctxspace plan start <code>`. If the user asks for something else, do that.' },
  { text: 'Keep the plan true while you work, one change at a time:', list: [
    'new work you find: `ctxspace plan add task "<name>" --before <code it holds up>`',
    'a question for the user: `ctxspace plan add question "<question>" --owner user --before <code it holds up>`',
    'stuck: `ctxspace plan block <code> --reason "<what you wait for>"`',
  ] },
  { text: 'When the user tells you an answer or a decision, record it with the command. For the user\'s items and milestones it becomes a proposal: that is correct, and your part is done.' },
  { text: 'Finish your own work with `ctxspace plan done <code> --resolution "<what came out of it>"`.' },
  { text: 'Report back in three short parts: what you changed, what waits for the user (Needs you), and what is next. Write the name with every code: "M2 CSV export endpoint", never "M2" alone.' },
];

/** Who a change is made as, one sentence a line, for `ctxspace plan --help` and AGENTS.md. */
export const WHO_ACTS = [
  'Who acts: every change is made as the AI and recorded with its name.',
  'When a close is the user\'s (a milestone, or an item the user owns), it becomes a proposal: the user accepts it in the Plan tab.',
  'That is the end of the AI\'s part, even when the user told you the answer: say it waits for them.',
  'The user can act as themselves with --as user in their own terminal.',
] as const;

/** Codes like M2 are for tools; people read names. */
export const NAMES_FIRST = 'Always write an item\'s name with its code, for example "M2 CSV export endpoint".';

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

/** Ends a sentence that may end in a name: "Added Q1 Which time zone?" needs no extra full stop. */
export function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** What each recorded change is called when people read the history. */
export const CHANGE_WORDS: Record<string, string> = {
  added: 'added', imported: 'moved into the plan', started: 'started', done: 'finished', answered: 'answered',
  dropped: 'dropped', later: 'moved to later', blocked: 'blocked', reopened: 'reopened', edited: 'changed',
  waits: 'changed', proposed: 'proposed a change to', accepted: 'accepted', rejected: 'sent back',
};
