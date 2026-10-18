import { describe, expect, it } from 'vitest';
import { PlanFileError, addToPlan, answerDecision, openDecisions, parsePlanFile, planItems, planKey, planText, setDone } from './plan-file.js';

const PLAN = `# Reports export

Customers export their reports as CSV. ![The export button](docs/export.png)

## Checkpoints

- [x] **Report rows load fast**
  Check: \`npm test -- rows\`
  Outcome: 40 ms for 10k rows
  - [x] Query the report rows
- [ ] Reports export to CSV
  Check: the workspace checks
  Customers asked for this in the September survey.
  - [x] Write the CSV writer
  - [ ] Add the Export button
  - [ ] Decide: Should archived reports be exported?
    Archived reports are a third of the rows.
    Suggested: Yes, all of them · Only the last year
    If no answer: only the last year
- [ ] Exports run in the background

\`\`\`markdown
- [ ] Not a step: an example inside a code block
\`\`\`

## Steps

- [ ] Tidy the old export script

## Decisions

- [x] Decide: Which file name do exports get?
  Answer: report-<date>.csv
- [ ] **Decide:** Keep the PDF export?
`;

describe('reading PLAN.md', () => {
  it('finds the checkpoints, their checks, steps and decisions, and what holds what up', () => {
    const plan = parsePlanFile(PLAN);
    expect(plan.title).toBe('Reports export');
    expect(plan.checkpoints.map((checkpoint) => [checkpoint.title, checkpoint.done, checkpoint.check])).toEqual([
      ['Report rows load fast', true, 'npm test -- rows'],
      ['Reports export to CSV', false, null],
      ['Exports run in the background', false, undefined],
    ]);
    const [rows, csv] = plan.checkpoints;
    expect(rows!.outcome).toBe('40 ms for 10k rows');
    expect(csv!.detail).toBe('Customers asked for this in the September survey.');
    expect(csv!.steps.map((step) => `${step.done ? 'x' : ' '} ${step.text}`)).toEqual(['x Write the CSV writer', '  Add the Export button']);
    expect(csv!.decisions).toEqual([expect.objectContaining({
      question: 'Should archived reports be exported?', done: false, checkpoint: 'reports-export-to-csv',
      detail: 'Archived reports are a third of the rows.', suggested: ['Yes, all of them', 'Only the last year'], ifNoAnswer: 'only the last year',
    })]);
    expect(plan.steps.map((step) => step.text)).toEqual(['Tidy the old export script']);
    expect(plan.decisions.map((decision) => [decision.question, decision.done, decision.answer])).toEqual([
      ['Which file name do exports get?', true, 'report-<date>.csv'],
      ['Keep the PDF export?', false, undefined],
    ]);
  });

  it('knows where each item starts and ends, so a change touches only its lines', () => {
    const plan = parsePlanFile(PLAN);
    const lines = PLAN.split('\n');
    const csv = plan.checkpoints[1]!;
    expect(lines[csv.line]).toBe('- [ ] Reports export to CSV');
    expect(lines[csv.end]).toBe('    If no answer: only the last year');
    expect(lines[csv.decisions[0]!.end]).toBe('    If no answer: only the last year');
    expect(planItems(plan).map((item) => item.key)).toContain('add-the-export-button');
  });

  it('lists the decisions that wait for an answer: none under a finished checkpoint', () => {
    const finished = PLAN.replace('- [ ] Reports export to CSV', '- [x] Reports export to CSV');
    expect(openDecisions(parsePlanFile(PLAN)).map((decision) => decision.question)).toEqual(['Should archived reports be exported?', 'Keep the PDF export?']);
    expect(openDecisions(parsePlanFile(finished)).map((decision) => decision.question)).toEqual(['Keep the PDF export?']);
  });

  it('reads a plan without checkpoints, and checkboxes anywhere, as steps', () => {
    const plan = parsePlanFile('Some notes.\n\n- [ ] One\n  - [x] Two\n* [X] Three\n');
    expect(plan.checkpoints).toEqual([]);
    expect(plan.steps.map((step) => `${step.done}:${step.text}`)).toEqual(['false:One', 'true:Two', 'true:Three']);
  });

  it('ends the checkpoints at the next heading of the same level, and keeps keys unique', () => {
    const plan = parsePlanFile('## Milestones\n\n- [ ] Ship\n  - [ ] Ship\n\n## Later\n\n- [ ] Ship\n');
    expect(plan.checkpoints.map((checkpoint) => checkpoint.key)).toEqual(['ship']);
    expect(plan.checkpoints[0]!.steps.map((step) => step.key)).toEqual(['ship-2']);
    expect(plan.steps.map((step) => step.key)).toEqual(['ship-3']);
    expect(planKey('**Reports** export to `CSV`!')).toBe('reports-export-to-csv');
  });
});

describe('changing PLAN.md one line at a time', () => {
  it('ticks and unticks an item and leaves every other line as written', () => {
    const ticked = setDone(PLAN, 'add-the-export-button', true, 'Add the Export button');
    expect(ticked.split('\n').filter((line, index) => line !== PLAN.split('\n')[index])).toEqual(['  - [x] Add the Export button']);
    expect(setDone(ticked, 'add-the-export-button', false)).toBe(PLAN);
  });

  it('refuses a change to a line that changed since it was read', () => {
    expect(() => setDone(PLAN, 'add-the-export-button', true, 'Add the Export link')).toThrow(PlanFileError);
    expect(() => setDone(PLAN, 'gone', true)).toThrow(/Nothing in PLAN.md matches/);
  });

  it('answers a decision under its other lines, and replaces an earlier answer', () => {
    const answered = answerDecision(PLAN, 'should-archived-reports-be-exported', 'Yes,\nall of them', 'Should archived reports be exported?');
    const decision = parsePlanFile(answered).checkpoints[1]!.decisions[0]!;
    expect(decision).toMatchObject({ done: true, answer: 'Yes, all of them' });
    expect(answered.split('\n')[decision.end]).toBe('    Answer: Yes, all of them');
    const again = answerDecision(answered, 'which-file-name-do-exports-get', 'export.csv');
    expect(parsePlanFile(again).decisions[0]).toMatchObject({ done: true, answer: 'export.csv' });
    expect(again.split('\n').length).toBe(answered.split('\n').length);
    expect(() => answerDecision(PLAN, 'tidy-the-old-export-script', 'yes')).toThrow(/Only a decision has an answer/);
  });

  it('adds a step or a decision under a checkpoint, after what is there', () => {
    const { text, key } = addToPlan(PLAN, { decision: { question: 'Which delimiter?', suggested: ['Comma', 'Semicolon'], ifNoAnswer: 'comma' } }, { checkpoint: 'reports-export-to-csv' });
    const csv = parsePlanFile(text).checkpoints[1]!;
    expect(key).toBe('which-delimiter');
    expect(csv.decisions.map((decision) => decision.question)).toEqual(['Should archived reports be exported?', 'Which delimiter?']);
    expect(text.split('\n').slice(csv.decisions[1]!.line, csv.decisions[1]!.end + 1)).toEqual([
      '  - [ ] Decide: Which delimiter?', '    Suggested: Comma · Semicolon', '    If no answer: comma',
    ]);
    const stepped = addToPlan(PLAN, { step: 'Run it nightly' }, { checkpoint: 'exports-run-in-the-background' });
    expect(parsePlanFile(stepped.text).checkpoints[2]!.steps.map((step) => step.text)).toEqual(['Run it nightly']);
    expect(stepped.text.split('\n')).toContain('  - [ ] Run it nightly');
  });

  it('adds outside the checkpoints under Steps or Decisions, making the heading when missing', () => {
    const step = addToPlan(PLAN, { step: 'Delete the old script' });
    expect(parsePlanFile(step.text).steps.map((entry) => entry.text)).toEqual(['Tidy the old export script', 'Delete the old script']);
    const fresh = addToPlan('# Notes\n\nJust text.\n', { decision: { question: 'Go on?' } });
    expect(fresh.text).toBe('# Notes\n\nJust text.\n\n## Decisions\n\n- [ ] Decide: Go on?\n');
    expect(parsePlanFile(fresh.text).decisions.map((decision) => decision.key)).toEqual([fresh.key]);
    expect(() => addToPlan(PLAN, { step: 'x' }, { checkpoint: 'nope' })).toThrow(/no checkpoint/);
  });
});

describe('the free text around the structure', () => {
  it('is what comes before the first section, and every section that is not the plan\'s own lists', () => {
    const text = `${PLAN}\n## Notes\n\nKeep the CSV small.\n\n\`\`\`\n## not a heading\n\`\`\`\n`;
    expect(planText(text)).toEqual({
      intro: 'Customers export their reports as CSV. ![The export button](docs/export.png)',
      sections: [{ heading: 'Notes', body: 'Keep the CSV small.\n\n```\n## not a heading\n```' }],
    });
  });
});
