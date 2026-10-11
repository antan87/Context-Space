/**
 * @module core/plan-app
 * The plan as the app's Plan tab reads it: the sections in the tab's order, every item with its
 * history, each milestone's last check, what stops finishing the workspace and what only warns, and
 * the words, so the tab says exactly what `ctxspace plan` and AGENTS.md say.
 */

import { CHANGE_WORDS, KIND_WORDS, NAMES_FIRST, NEEDS_YOU, PLAN_RULES, PLAN_SECTIONS, STATUS_WORDS, isOpenStatus, isSettledStatus } from './plan-words.js';
import { itemToJson, planToJson } from './plan-text.js';
import { preparePlan } from './plan-import.js';
import { loadWorkspaceState } from './workspace-state.js';
import type { PlanDocument, PlanItem } from './plan.js';

/** The words of the plan, sent with it so the app has no copy of its own. */
export const PLAN_WORDS = {
  statuses: STATUS_WORDS,
  kinds: KIND_WORDS,
  needsYou: NEEDS_YOU,
  sections: PLAN_SECTIONS,
  rules: PLAN_RULES,
  namesFirst: NAMES_FIRST,
  changes: CHANGE_WORDS,
};

/**
 * The sixth rule: before the workspace is finished, everything a milestone waits for must be
 * handled. `blocks` are those items, directly or through what they wait for in turn, that are not
 * done or dropped, or that wait for the user's OK. `warns` are the other open items. Items for
 * later count as handled unless a milestone waits for them.
 */
export function planFinishCheck(plan: PlanDocument): { blocks: PlanItem[]; warns: PlanItem[] } {
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const waitedFor = new Set<string>();
  const visit = (id: string) => {
    if (waitedFor.has(id)) return;
    waitedFor.add(id);
    for (const next of byId.get(id)?.waitsFor ?? []) visit(next);
  };
  for (const milestone of plan.items) {
    if (milestone.kind === 'milestone' && milestone.status !== 'dropped') for (const id of milestone.waitsFor) visit(id);
  }
  const unhandled = (item: PlanItem) => Boolean(item.proposal) || !isSettledStatus(item.status);
  const blocks = plan.items.filter((item) => waitedFor.has(item.id) && unhandled(item));
  const blocking = new Set(blocks.map((item) => item.id));
  const warns = plan.items.filter((item) => !blocking.has(item.id) && (isOpenStatus(item.status) || Boolean(item.proposal)));
  return { blocks, warns };
}

/** Everything the Plan tab shows, read the way `ctxspace plan` reads it. */
export async function planForApp(workspacePath: string) {
  const plan = await preparePlan(workspacePath);
  const state = await loadWorkspaceState(workspacePath);
  const finish = planFinishCheck(plan);
  const evidence = Object.fromEntries(plan.items
    .filter((item) => item.kind === 'milestone' && state.planEvidence?.[item.id])
    .map((item) => [item.id, state.planEvidence![item.id]!]));
  const count = (status: PlanItem['status']) => plan.items.filter((item) => item.status === status).length;
  return {
    ...planToJson(plan, { all: true, changes: 15, history: true }),
    evidence,
    finish: {
      blocks: finish.blocks.map((item) => itemToJson(plan, item)),
      warns: finish.warns.map((item) => itemToJson(plan, item)),
      handled: { done: count('done'), dropped: count('dropped'), later: count('later') },
    },
    words: PLAN_WORDS,
  };
}

export type PlanForApp = Awaited<ReturnType<typeof planForApp>>;
