/**
 * Plan payloads for the Plan tab, as GET /api/workspace/:id/plan/items sends them. The words are the
 * real ones from the backend, so a spec fails when the tab and `ctxspace plan` drift apart.
 */
import { CHANGE_WORDS, KIND_WORDS, NAMES_FIRST, NEEDS_YOU, PLAN_RULES, PLAN_SECTIONS, STATUS_WORDS } from '../../src/core/plan-words.ts';
import type { PlanItemView, PlanView } from '../src/features/plan/planTypes.ts';

export const PLAN_WORDS: PlanView['words'] = {
  statuses: STATUS_WORDS, kinds: KIND_WORDS, needsYou: NEEDS_YOU, sections: [...PLAN_SECTIONS],
  rules: [...PLAN_RULES], namesFirst: NAMES_FIRST, changes: CHANGE_WORDS,
};

const AT = '2026-10-10T10:00:00.000Z';
export function planItem(fields: Partial<PlanItemView> & Pick<PlanItemView, 'id' | 'title'>): PlanItemView {
  return { label: `${fields.id} ${fields.title}`, kind: 'milestone', status: 'todo', waitsFor: [], holdsUp: [], updatedAt: AT, createdAt: AT, history: [], ...fields };
}

/** What is current and next, by the rule of core/plan.ts `planFocus`. */
export function planFocus(items: PlanItemView[]): PlanView['focus'] {
  const ref = (item: PlanItemView) => ({ id: item.id, label: item.label, title: item.title });
  const settled = (id: string) => ['done', 'dropped'].includes(items.find((item) => item.id === id)?.status ?? 'done');
  const milestones = items.filter((item) => item.kind === 'milestone');
  const current = milestones.find((item) => item.status === 'in_progress');
  const upcoming = milestones.filter((item) => item !== current && (item.status === 'todo' || item.status === 'blocked'));
  const ready = upcoming.find((item) => item.status === 'todo' && item.waitsFor.every((wait) => settled(wait.id)));
  const next = ready ?? upcoming[0];
  const waits = next && !ready ? next.waitsFor.filter((wait) => !settled(wait.id)).map((wait) => items.find((item) => item.id === wait.id)!).map(ref) : [];
  return {
    ...(current ? { current: ref(current) } : {}),
    ...(next ? { next: { ...ref(next), waitsFor: waits, ...(next.status === 'blocked' && next.blockedReason ? { blockedReason: next.blockedReason } : {}) } } : {}),
  };
}

/** A plan from its items, sorted into the tab's sections the way core/plan.ts does. */
export function planView(items: PlanItemView[], extra: Partial<PlanView> = {}): PlanView {
  const needsUser = (item: PlanItemView) => Boolean(item.proposal) || (item.kind === 'question' && item.status === 'todo' && item.owner === 'user');
  const count = (status: PlanItemView['status']) => items.filter((item) => item.status === status).length;
  const open = (item: PlanItemView) => ['todo', 'in_progress', 'blocked', 'later'].includes(item.status);
  return {
    revision: 3,
    counts: { needsYou: items.filter(needsUser).length, inProgress: count('in_progress'), todo: count('todo'), blocked: count('blocked'), later: count('later'), done: count('done'), dropped: count('dropped') },
    needsYou: [...items.filter((item) => item.proposal), ...items.filter((item) => !item.proposal && needsUser(item))],
    milestones: items.filter((item) => item.kind === 'milestone'),
    otherOpen: items.filter((item) => item.kind !== 'milestone' && !needsUser(item) && open(item)),
    closed: items.filter((item) => item.status === 'done' || item.status === 'dropped'),
    ready: [],
    focus: planFocus(items),
    changes: [],
    evidence: {},
    finish: { blocks: [], warns: [], handled: { done: count('done'), dropped: count('dropped'), later: count('later') } },
    words: PLAN_WORDS,
    ...extra,
  };
}
