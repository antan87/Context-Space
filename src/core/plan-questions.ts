/**
 * @module core/plan-questions
 * A question the AI asks in the chat is also a question in the plan. The user sees one list of what
 * waits for them (the strip above the chat and Needs you), the plan says what the question holds up,
 * and the AI records the answer where every surface reads it.
 */

import { preparePlan } from './plan-import.js';
import { TITLE_MAX, changePlan, planFocus } from './plan.js';
import { isOpenStatus, itemLabel } from './plan-words.js';

/** A chat question's name in the plan: its words on one line, cut at a word when longer than a name may be. */
export function questionTitle(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  if (text.length <= TITLE_MAX) return text;
  const cut = text.slice(0, TITLE_MAX - 1);
  const atWord = cut.replace(/\s+\S*$/, '');
  return `${(atWord.length > TITLE_MAX / 2 ? atWord : cut).trimEnd()}…`;
}

/**
 * Adds the AI's chat question to the plan as the user's question. The milestone being worked on waits
 * for it, so it cannot be finished with the question open. Asking again while the same question is open
 * adds nothing. Returns the question as the AI names it.
 */
export async function addChatQuestionToPlan(
  workspacePath: string,
  input: { message: string; options?: string[]; harness: string },
): Promise<{ id: string; label: string }> {
  const title = questionTitle(input.message);
  // Prepared first, so a workspace whose milestones are still in an older file keeps them.
  const plan = await preparePlan(workspacePath);
  const open = plan.items.find((item) => item.kind === 'question' && isOpenStatus(item.status) && item.title === title);
  if (open) return { id: open.id, label: itemLabel(open) };
  const current = planFocus(plan).current;
  const detail = [
    title !== input.message.trim() ? input.message.trim() : '',
    input.options?.length ? `Suggested answers: ${input.options.join(' · ')}` : '',
  ].filter(Boolean).join('\n\n');
  const { item } = await changePlan(workspacePath, {
    type: 'add', kind: 'question', title, owner: 'user',
    ...(detail ? { detail } : {}),
    ...(current ? { before: [current.id] } : {}),
  }, { actor: { by: 'agent', ...(input.harness && input.harness !== 'agent' ? { harness: input.harness } : {}) } });
  return { id: item.id, label: itemLabel(item) };
}
