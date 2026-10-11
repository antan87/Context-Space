import { describe, expect, it } from 'vitest';
import { applyPlanChange, emptyPlan, type PlanActor, type PlanChange, type PlanDocument } from './plan.js';
import { checkPlan, firstLine, goalFromBrief, planToJson, relativeTime, renderChanges, renderHistory, renderPlanInstructions, renderPlanRules, renderPlanText } from './plan-text.js';
import { PLAN_RULES, PLAN_WORKFLOW, WHO_ACTS } from './plan-words.js';

const user: PlanActor = { by: 'user' };
const claude: PlanActor = { by: 'agent', harness: 'claude' };
const codex: PlanActor = { by: 'agent', harness: 'codex' };
const NOW = new Date('2026-10-10T12:00:00.000Z');

/** The CSV export example from the mockup, built in memory with times a few minutes apart. */
function examplePlan(): PlanDocument {
  const plan = emptyPlan();
  let minute = 0;
  const apply = (change: PlanChange, actor: PlanActor = user) => {
    minute += 1;
    applyPlanChange(plan, change, actor, new Date(Date.parse('2026-10-10T11:00:00.000Z') + minute * 60_000).toISOString());
  };
  apply({ type: 'add', kind: 'milestone', title: 'Database query for report rows' });
  apply({ type: 'add', kind: 'milestone', title: 'CSV export endpoint', after: ['M1'] });
  apply({ type: 'add', kind: 'milestone', title: 'Export button in the UI', after: ['M2'] });
  apply({ type: 'add', kind: 'milestone', title: 'User docs for export' });
  apply({ type: 'done', id: 'M1', resolution: 'Passed its check on a91f2e0' });
  apply({ type: 'drop', id: 'M4', reason: 'Docs are generated automatically now' });
  apply({ type: 'add', kind: 'task', title: 'Background job queue for large exports', before: ['M2'] }, claude);
  apply({ type: 'add', kind: 'question', title: 'Which time zone should export timestamps use?', owner: 'user', before: ['M2'] }, codex);
  apply({ type: 'add', kind: 'question', title: 'Maximum rows per export?', owner: 'user', before: ['M2'] });
  apply({ type: 'answer', id: 'Q2', answer: '50,000 rows' });
  apply({ type: 'start', id: 'T1' }, claude);
  apply({ type: 'done', id: 'T1', resolution: 'Exports over 10,000 rows run in the background' }, claude);
  apply({ type: 'add', kind: 'question', title: 'Should archived reports be included?' }, claude);
  apply({ type: 'add', kind: 'decision', title: 'Excel (.xlsx) export' });
  apply({ type: 'later', id: 'D1', revisitWhen: 'after user feedback on CSV' });
  apply({ type: 'add', kind: 'task', title: 'Limit export size', after: ['Q2'] }, claude);
  apply({ type: 'start', id: 'T2' }, claude);
  apply({ type: 'done', id: 'T2', resolution: 'Capped at 50,000 rows' }, claude);
  apply({ type: 'add', kind: 'task', title: 'Write the CSV encoder', before: ['M2'], owner: 'user' }, claude);
  apply({ type: 'start', id: 'T3' }, claude);
  apply({ type: 'done', id: 'T3', resolution: 'Encoder handles quotes and commas' }, claude);
  return plan;
}

describe('renderPlanText', () => {
  const goal = { objective: 'Add CSV export to reports.\n\nMore detail that is not shown.', stage: 'implement', stopCondition: 'The CSV export endpoint passes its check.' };

  it('shows the sections in the order of the Plan tab', () => {
    const text = renderPlanText(examplePlan(), { goal, now: NOW });
    const order = ['GOAL', 'NEEDS YOU', 'MILESTONES', 'OTHER OPEN WORK', 'DONE AND DROPPED', 'WHAT CHANGED', 'Change it:'].map((heading) => text.indexOf(heading));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('GOAL        Add CSV export to reports.');
    expect(text).not.toContain('More detail');
    expect(text).toContain('Stage: Implement · Stop when: The CSV export endpoint passes its check.');
  });

  it('says what needs the user, what each milestone waits for, and why work was closed', () => {
    const text = renderPlanText(examplePlan(), { goal, now: NOW });
    expect(text).toContain('✓?  T3 Write the CSV encoder · Claude says it is done: Encoder handles quotes and commas · the user decides');
    expect(text).toContain('?   Q1 Which time zone should export timestamps use? · to do · the user answers');
    expect(text).toContain('holds up: M2 CSV export endpoint');
    expect(text).toContain('✓   M1 Database query for report rows · done · Passed its check on a91f2e0');
    expect(text).toContain('waits for: Q1 Which time zone should export timestamps use? (to do), T3 Write the CSV encoder (in progress)');
    expect(text).toContain('○   Q3 Should archived reports be included? · to do · the AI answers');
    expect(text).toContain('✗   M4 User docs for export · dropped: Docs are generated automatically now');
    expect(text).toContain('‖   D1 Excel (.xlsx) export · later · look again: after user feedback on CSV');
    expect(text).toContain('DONE AND DROPPED  4 done · 1 dropped · list them: ctxspace plan --all');
  });

  it('never prints a code without its name', () => {
    const plan = examplePlan();
    const text = renderPlanText(plan, { goal, now: NOW, all: true, changes: 30 });
    for (const item of plan.items) {
      const occurrences = [...text.matchAll(new RegExp(`\\b${item.id}\\b`, 'g'))];
      expect(occurrences.length).toBeGreaterThan(0);
      for (const occurrence of occurrences) {
        expect(text.slice(occurrence.index!, occurrence.index! + item.id.length + 1 + item.title.length)).toBe(`${item.id} ${item.title}`);
      }
    }
  });

  it('lists done and dropped items with --all', () => {
    const text = renderPlanText(examplePlan(), { now: NOW, all: true });
    expect(text).toContain('✓   T1 Background job queue for large exports · done · Exports over 10,000 rows run in the background');
    expect(text).toContain('✓   Q2 Maximum rows per export? · answered: 50,000 rows');
  });

  it('shows who changed what, newest first, in words', () => {
    const text = renderChanges(examplePlan().items.flatMap((item) => item.history.map((entry) => ({ ...entry, itemId: item.id, label: `${item.id} ${item.title}` })))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 2), NOW);
    expect(text.split('\n')).toEqual([
      'WHAT CHANGED',
      '  39 min ago   Claude       proposed a change to T3 Write the CSV encoder: done: Encoder handles quotes and commas',
      '  40 min ago   Claude       started T3 Write the CSV encoder',
    ]);
  });

  it('tells how to start when the plan is empty', () => {
    expect(renderPlanText(emptyPlan())).toContain('The plan has no items yet. Add one: ctxspace plan add milestone');
  });
});

describe('planToJson', () => {
  it('returns the same sections, with labels, waits and what each item holds up', () => {
    const json = planToJson(examplePlan(), { goal: { objective: 'Add CSV export' } });
    expect(json.needsYou.map((item) => item.label)).toEqual(['T3 Write the CSV encoder', 'Q1 Which time zone should export timestamps use?']);
    expect(json.milestones.map((item) => item.id)).toEqual(['M1', 'M2', 'M3', 'M4']);
    const m2 = json.milestones[1]!;
    expect(m2.waitsFor).toContainEqual({ id: 'Q1', label: 'Q1 Which time zone should export timestamps use?', status: 'todo' });
    expect(m2.holdsUp).toEqual(['M3 Export button in the UI']);
    expect(json.otherOpen.map((item) => item.id)).toEqual(['Q3', 'D1']);
    expect(json.closed).toEqual(['M1 Database query for report rows', 'M4 User docs for export', 'T1 Background job queue for large exports', 'Q2 Maximum rows per export?', 'T2 Limit export size']);
    expect(json.counts).toMatchObject({ needsYou: 2, done: 4, dropped: 1, later: 1 });
  });
});

describe('checkPlan', () => {
  it('finds waits that can never clear, proposals, blocks and idle work', () => {
    const plan = emptyPlan();
    const at = '2026-10-01T10:00:00.000Z';
    applyPlanChange(plan, { type: 'add', kind: 'task', title: 'Parked' }, user, at);
    applyPlanChange(plan, { type: 'add', kind: 'task', title: 'Gone' }, user, at);
    applyPlanChange(plan, { type: 'add', kind: 'milestone', title: 'Waits on parked', after: ['T1', 'T2'] }, user, at);
    applyPlanChange(plan, { type: 'later', id: 'T1', revisitWhen: 'next quarter' }, user, at);
    applyPlanChange(plan, { type: 'drop', id: 'T2', reason: 'Not needed' }, user, at);
    applyPlanChange(plan, { type: 'add', kind: 'task', title: 'Stuck' }, user, at);
    applyPlanChange(plan, { type: 'block', id: 'T3', reason: 'No access' }, user, at);
    applyPlanChange(plan, { type: 'add', kind: 'task', title: 'Slow' }, claude, at);
    applyPlanChange(plan, { type: 'start', id: 'T4' }, claude, at);
    const findings = checkPlan(plan, NOW);
    expect(findings.filter((finding) => finding.level === 'problem').map((finding) => finding.message)).toEqual([
      'M1 Waits on parked waits for T1 Parked, which is set for later. It can\'t start until that is done or dropped.',
    ]);
    const notes = findings.filter((finding) => finding.level === 'note').map((finding) => finding.message);
    expect(notes).toContain('M1 Waits on parked waits for T2 Gone, which was dropped, so it holds nothing up. Remove it: ctxspace plan edit M1 --not-after T2');
    expect(notes).toContain('T3 Stuck is blocked: No access');
    expect(notes).toContain('T4 Slow has been in progress with no change for 9 days.');
  });

  it('finds nothing in a healthy plan', () => {
    const plan = emptyPlan();
    applyPlanChange(plan, { type: 'add', kind: 'task', title: 'Fine' }, user, NOW.toISOString());
    expect(checkPlan(plan, NOW)).toEqual([]);
  });
});

describe('small helpers', () => {
  it('states the six rules and names-first in the help', () => {
    const help = renderPlanRules();
    PLAN_RULES.forEach((rule, index) => expect(help).toContain(`${index + 1}. ${rule}`));
    expect(help).toContain('M2 CSV export endpoint');
    expect(help).toContain('To do, In progress, Blocked, Done, Dropped, Later');
  });

  it('gives the AI a work routine: read, keep the plan true, record what the user says, report with names', () => {
    expect(PLAN_WORKFLOW).toHaveLength(6);
    expect(PLAN_WORKFLOW[0].text).toMatch(/^Start by running `ctxspace plan`/);
    expect(PLAN_WORKFLOW[2].list).toHaveLength(3);
    expect(PLAN_WORKFLOW.map((step) => step.text).join(' ')).toContain('your part is done');
    expect(PLAN_WORKFLOW.at(-1)!.text).toContain('never "M2" alone');
  });

  it('writes the Plan section of AGENTS.md: command, numbered routine with its changes, rules, who acts', () => {
    const text = renderPlanInstructions();
    expect(text.split('\n')[0]).toBe('## Plan');
    expect(text).toContain('`ctxspace plan add|start|done|answer|block|later|drop|reopen|edit`');
    expect(text).toContain('Never edit `contextspace-plan.json` by hand.');
    expect(text).toContain('.\\.contextspace\\bin\\ctxspace.cmd plan');
    expect(text).toContain('3. Keep the plan true while you work, one change at a time:\n   - new work you find:');
    expect(text).toContain('6. Report back in three short parts');
    PLAN_RULES.forEach((rule, index) => expect(text).toContain(`${index + 1}. ${rule}`));
    expect(text.trimEnd().split('\n').at(-1)).toBe(WHO_ACTS.slice(0, 3).join(' '));
    // Told how a person acts as the user, an AI tried it: AGENTS.md leaves it out.
    expect(text).not.toContain('--as user');
  });

  it('takes the goal from the brief, or from the workspace description', () => {
    expect(goalFromBrief({ objective: 'Ship CSV', stage: 'implement', stopCondition: '' }, 'Reports')).toEqual({ objective: 'Ship CSV', stage: 'implement', stopCondition: undefined });
    expect(goalFromBrief({ objective: '', stage: 'investigate' }, 'Reports')).toEqual({ objective: 'Reports', stage: 'investigate', stopCondition: undefined });
    expect(goalFromBrief({ objective: '' })).toBeUndefined();
  });

  it('shortens text to its first sentence', () => {
    expect(firstLine('One thing. Then another.')).toBe('One thing.');
    expect(firstLine('\n\nFirst line\nsecond')).toBe('First line');
    expect(firstLine('x'.repeat(150), 20)).toHaveLength(20);
  });

  it('says how long ago in words', () => {
    expect(relativeTime('2026-10-10T11:59:40.000Z', NOW)).toBe('now');
    expect(relativeTime('2026-10-10T11:15:00.000Z', NOW)).toBe('45 min ago');
    expect(relativeTime('2026-10-10T09:00:00.000Z', NOW)).toBe('3 h ago');
    expect(relativeTime('2026-10-09T12:00:00.000Z', NOW)).toBe('1 day ago');
    expect(relativeTime('2026-09-01T12:00:00.000Z', NOW)).toBe('Sep 1');
  });

  it('shows one item\'s history in words', () => {
    const plan = examplePlan();
    const text = renderHistory(plan, plan.items.find((item) => item.id === 'T1')!, NOW);
    expect(text.split('\n')[0]).toBe('T1 Background job queue for large exports · Task · done · Exports over 10,000 rows run in the background');
    expect(text).toContain('Claude       finished: Exports over 10,000 rows run in the background');
  });
});
