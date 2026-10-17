import { describe, expect, it } from 'vitest';
import { emptyPlan, type PlanDocument, type PlanItem } from './plan.js';
import { IMPORTED_NOTES_TITLE, staleQuestions } from './plan-freshness.js';

const AT = '2026-10-17T08:00:00.000Z';
const item = (fields: Partial<PlanItem> & Pick<PlanItem, 'id' | 'title'>): PlanItem => ({
  kind: 'question', status: 'todo', owner: 'user', waitsFor: [], createdAt: AT, updatedAt: AT, history: [], ...fields,
});
const plan = (...items: PlanItem[]): PlanDocument => ({ ...emptyPlan(), items });

describe('staleQuestions', () => {
  it('finds a question for the user whose held-up items are all closed, with the reason', () => {
    const stale = staleQuestions(plan(
      item({ id: 'Q1', title: 'Which time zone?' }),
      item({ id: 'M1', kind: 'milestone', title: 'CSV export', status: 'done', waitsFor: ['Q1'] }),
      item({ id: 'M2', kind: 'milestone', title: 'Export button', status: 'dropped', waitsFor: ['Q1'] }),
    ));
    expect(stale.map(({ item, reason }) => [item.id, reason])).toEqual([['Q1', 'Nothing waits for it any more: "CSV export", "Export button" are closed.']]);
  });

  it('finds the question the notes import added, and only an imported one', () => {
    const imported = item({ id: 'Q1', title: IMPORTED_NOTES_TITLE, history: [{ at: AT, by: 'contextspace', action: 'imported' }] });
    const typed = item({ id: 'Q2', title: IMPORTED_NOTES_TITLE });
    expect(staleQuestions(plan(imported, typed)).map(({ item }) => item.id)).toEqual(['Q1']);
  });

  it('keeps questions that hold up open work or nothing, and questions for an AI', () => {
    expect(staleQuestions(plan(
      item({ id: 'Q1', title: 'Open work waits' }),
      item({ id: 'M1', kind: 'milestone', title: 'CSV export', waitsFor: ['Q1'] }),
      item({ id: 'Q2', title: 'Holds nothing up' }),
      item({ id: 'Q3', title: 'For an AI', owner: 'claude' }),
      item({ id: 'M2', kind: 'milestone', title: 'Done', status: 'done', waitsFor: ['Q3'] }),
    ))).toEqual([]);
  });

  it('with holding, looks only at the questions that item waits for', () => {
    const doc = plan(
      item({ id: 'Q1', title: 'For M1' }),
      item({ id: 'M1', kind: 'milestone', title: 'One', status: 'dropped', waitsFor: ['Q1'] }),
      item({ id: 'Q2', title: 'For M2' }),
      item({ id: 'M2', kind: 'milestone', title: 'Two', status: 'dropped', waitsFor: ['Q2'] }),
    );
    expect(staleQuestions(doc, { holding: 'M1' }).map(({ item }) => item.id)).toEqual(['Q1']);
    expect(staleQuestions(doc).map(({ item }) => item.id)).toEqual(['Q1', 'Q2']);
  });
});
