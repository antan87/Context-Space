import { describe, expect, it } from 'vitest';
import { planFileFromStore } from './plan-file-convert.js';
import { openDecisions, parsePlanFile } from './plan-file.js';
import type { PlanDocument, PlanItem } from './plan.js';

const at = '2026-10-10T09:00:00.000Z';
const item = (id: string, kind: PlanItem['kind'], title: string, fields: Partial<PlanItem> = {}): PlanItem => ({
  id, kind, title, status: 'todo', owner: 'agent', waitsFor: [], createdAt: at, updatedAt: at, history: [], ...fields,
});
const store = (items: PlanItem[]): PlanDocument => ({ version: 1, revision: 9, updatedAt: at, items });

describe('moving an older plan store into PLAN.md', () => {
  const plan = store([
    item('M1', 'milestone', 'Report rows load fast', { status: 'done', resolution: 'Passed its check on c9043b3', gate: { required: true, command: 'npm test' }, waitsFor: ['T1'] }),
    item('T1', 'task', 'Query the report rows', { status: 'done', resolution: 'Done' }),
    item('M2', 'milestone', 'Reports export to CSV', { gate: { required: true }, detail: 'Customers asked for it.', waitsFor: ['T2', 'Q1', 'T3', 'T9'] }),
    item('T2', 'task', 'Write the CSV writer', { status: 'blocked', blockedReason: 'Waiting for the schema' }),
    item('Q1', 'question', 'Should archived reports be exported?', { owner: 'user', detail: 'A third of the rows.\n\nSuggested answers: Yes · No' }),
    item('T3', 'task', 'An idea nobody needs', { status: 'dropped', resolution: 'Not needed' }),
    item('T9', 'task', 'Add the Export button', { status: 'later', revisitWhen: 'after the redesign' }),
    item('T4', 'task', 'Tidy the old script'),
    item('Q2', 'question', 'Which file name?', { owner: 'user', status: 'done', resolution: 'report-<date>.csv' }),
    item('Q3', 'question', 'Is the API stable?', { owner: 'codex' }),
    item('D1', 'decision', 'Use UTF-8 without BOM', { status: 'done', resolution: 'Excel reads it' }),
    item('E1', 'existing', 'A CSV helper in utils', { detail: 'Where: src/utils/csv.ts' }),
  ]);

  it('writes milestones as checkpoints with their checks and outcomes, and what they wait for under them', () => {
    const text = planFileFromStore(plan, { title: 'Reports export', goal: 'Customers export their reports.' });
    expect(text).toBe(`# Reports export

Customers export their reports.

## Checkpoints

- [x] Report rows load fast
  Check: \`npm test\`
  Outcome: Passed its check on c9043b3
  - [x] Query the report rows

- [ ] Reports export to CSV
  Check: the workspace checks
  Customers asked for it.
  - [ ] Write the CSV writer (blocked: Waiting for the schema)
  - [ ] Decide: Should archived reports be exported?
    A third of the rows.
    Suggested: Yes · No
  - [ ] Add the Export button (later: after the redesign)

## Steps

- [ ] Tidy the old script
- [ ] Is the API stable?

## Decisions

- [x] Decide: Which file name?
  Answer: report-<date>.csv

## Decided

- Use UTF-8 without BOM: Excel reads it

## Existing work

- A CSV helper in utils
  Where: src/utils/csv.ts
`);
  });

  it('reads back as the same plan: every checkpoint, step and question, and the one open decision', () => {
    const back = parsePlanFile(planFileFromStore(plan, { title: 'Reports export' }));
    expect(back.checkpoints.map((checkpoint) => [checkpoint.title, checkpoint.done, checkpoint.check])).toEqual([
      ['Report rows load fast', true, 'npm test'],
      ['Reports export to CSV', false, null],
    ]);
    expect(back.checkpoints[1]!.decisions[0]).toMatchObject({ suggested: ['Yes', 'No'], detail: 'A third of the rows.' });
    expect(openDecisions(back).map((decision) => decision.question)).toEqual(['Should archived reports be exported?']);
    expect(back.decisions[0]).toMatchObject({ done: true, answer: 'report-<date>.csv' });
    expect(back.steps.map((step) => step.text)).toEqual(['Tidy the old script', 'Is the API stable?']);
  });

  it('writes a plan without milestones as steps and decisions only, and an empty one as its title', () => {
    expect(planFileFromStore(store([item('T1', 'task', 'One')]), { title: 'Small' })).toBe('# Small\n\n## Steps\n\n- [ ] One\n');
    expect(planFileFromStore(store([]), { title: '' })).toBe('# Plan\n');
  });
});
