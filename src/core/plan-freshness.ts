/**
 * @module core/plan-freshness
 * Questions nobody needs answered any more, so they never reach the user:
 * - a question for the user that holds items up, all of which are closed now;
 * - the question the old notes import asked about leftover text, which the archived notes file keeps.
 * Pure: it says which questions and why. `withdrawStaleQuestions` in core/plan closes them as ContextSpace, when a
 * change closes an item and in the backend's daily pass over every workspace.
 */

import type { PlanDocument, PlanItem } from './plan.js';
import { PLANNING_NOTES_FILE } from './planning-notes.js';
import { isOpenStatus, isSettledStatus } from './plan-words.js';

/** The question the notes import used to add for text outside the template's tables. */
export const IMPORTED_NOTES_TITLE = `Is anything in the notes kept from ${PLANNING_NOTES_FILE} still needed?`;

const forUser = (item: PlanItem) => item.kind === 'question' && isOpenStatus(item.status) && !item.proposal
  && item.owner?.trim().toLowerCase() === 'user';

/**
 * The open questions for the user that nobody needs answered any more, each with the reason it is withdrawn.
 * With `holding`, only the questions that item waits for: the ones a change to it can settle.
 */
export function staleQuestions(plan: PlanDocument, options: { holding?: string } = {}): Array<{ item: PlanItem; reason: string }> {
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const candidates = options.holding === undefined
    ? plan.items
    : (byId.get(options.holding)?.waitsFor ?? []).map((id) => byId.get(id)).filter((item): item is PlanItem => Boolean(item));
  const stale: Array<{ item: PlanItem; reason: string }> = [];
  for (const item of candidates.filter(forUser)) {
    if (item.title === IMPORTED_NOTES_TITLE && item.history.some((entry) => entry.action === 'imported')) {
      stale.push({ item, reason: `A leftover from moving ${PLANNING_NOTES_FILE} into the plan, not a question: the whole file is kept in .contextspace/archive/.` });
      continue;
    }
    const holdsUp = plan.items.filter((other) => other.waitsFor.includes(item.id));
    if (holdsUp.length > 0 && holdsUp.every((other) => isSettledStatus(other.status))) {
      const names = holdsUp.map((other) => `"${other.title}"`).join(', ');
      stale.push({ item, reason: `Nothing waits for it any more: ${names} ${holdsUp.length === 1 ? 'is' : 'are'} closed.` });
    }
  }
  return stale;
}
