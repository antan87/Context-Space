import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { PLAN_RULES } from '../../src/core/plan-words.ts';
import { planItem, planView } from './planData';
import type { PlanView } from '../src/features/plan/planTypes.ts';

/**
 * The Plan tab: what needs the user first, the milestones in order, the rest, and what changed, in
 * the words `ctxspace plan` uses. The user answers, accepts or sends back in place, and opens any item.
 */
const workspace = { id: 'demo', branchName: 'demo', name: 'Reports CSV export', description: 'Add CSV export to reports', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 1000 } });

const SHOTS = process.env.PLAN_SHOTS_DIR;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function csvExportPlan(): PlanView {
  const items = [
    planItem({ id: 'M1', title: 'Database query for report rows', status: 'done', resolution: 'Passed its check on a91f2e0c4d5b6a7980112233445566778899aabb', gate: { required: true, command: 'npm test' },
      history: [{ at: minutesAgo(3000), by: 'user', action: 'added' }, { at: minutesAgo(2900), by: 'claude', action: 'done', note: 'Passed its check on a91f2e0' }] }),
    planItem({ id: 'M2', title: 'CSV export endpoint', status: 'in_progress', gate: { required: true, command: 'npm test' },
      detail: 'A report can be downloaded as a CSV file. Large reports run in the background. At most 50,000 rows per export.',
      links: { repo: 'NexusFlow', branch: 'feat/csv-export', workItem: '#412 (draft)' },
      waitsFor: [{ id: 'T1', label: 'T1 Background job queue for large exports', status: 'in_progress' }, { id: 'Q1', label: 'Q1 Which time zone should export timestamps use?', status: 'todo' }, { id: 'Q2', label: 'Q2 Maximum rows per export?', status: 'done' }],
      holdsUp: ['M3 Export button in the UI'],
      history: [{ at: minutesAgo(1500), by: 'user', action: 'added' }, { at: minutesAgo(120), by: 'codex', action: 'waits', note: 'waits for T1 Background job queue for large exports' }, { at: minutesAgo(40), by: 'claude', action: 'started' }] }),
    planItem({ id: 'M3', title: 'Export button in the UI', waitsFor: [{ id: 'M2', label: 'M2 CSV export endpoint', status: 'in_progress' }] }),
    planItem({ id: 'M4', title: 'User docs for export', status: 'dropped', resolution: 'Docs are generated automatically now' }),
    planItem({ id: 'T1', kind: 'task', title: 'Background job queue for large exports', status: 'in_progress', owner: 'user', holdsUp: ['M2 CSV export endpoint'],
      proposal: { action: 'done', by: 'claude', note: 'Exports over 10,000 rows now run in the background. Tests pass on commit a1b2c3d.', at: minutesAgo(2) },
      history: [{ at: minutesAgo(120), by: 'codex', action: 'added' }, { at: minutesAgo(60), by: 'claude', action: 'started' }] }),
    planItem({ id: 'Q1', kind: 'question', title: 'Which time zone should export timestamps use?', owner: 'user', holdsUp: ['M2 CSV export endpoint'],
      detail: 'Timestamps in the file must match what the report shows.\n\nSuggested answers: UTC · The account time zone',
      history: [{ at: minutesAgo(5), by: 'codex', action: 'added' }] }),
    planItem({ id: 'Q2', kind: 'question', title: 'Maximum rows per export?', status: 'done', owner: 'user', resolution: '50,000 rows per export' }),
    planItem({ id: 'Q3', kind: 'question', title: 'Should archived reports be included?', owner: 'agent' }),
    planItem({ id: 'D1', kind: 'decision', title: 'Excel (.xlsx) export', status: 'later', revisitWhen: 'after user feedback on CSV' }),
    planItem({ id: 'E1', kind: 'existing', title: 'CSV helper in lib/csv.ts', status: 'done', resolution: 'Already merged (abc123)' }),
  ];
  return planView(items, {
    changes: [
      { at: minutesAgo(2), by: 'claude', action: 'proposed', itemId: 'T1', label: 'T1 Background job queue for large exports', note: 'done: Exports over 10,000 rows now run in the background' },
      { at: minutesAgo(5), by: 'codex', action: 'added', itemId: 'Q1', label: 'Q1 Which time zone should export timestamps use?' },
      { at: minutesAgo(40), by: 'claude', action: 'started', itemId: 'M2', label: 'M2 CSV export endpoint' },
      { at: minutesAgo(60), by: 'user', action: 'answered', itemId: 'Q2', label: 'Q2 Maximum rows per export?', note: '50,000 rows per export' },
      { at: minutesAgo(61), by: 'user', action: 'dropped', itemId: 'M4', label: 'M4 User docs for export', note: 'Docs are generated automatically now' },
    ],
    evidence: { M1: { canProgress: true, lastVerificationSha: 'a91f2e0', lastVerificationStatus: 'pass', at: minutesAgo(2900) },
      M2: { canProgress: true, lastVerificationSha: '7c9e1f2', lastVerificationStatus: 'pass', at: minutesAgo(12) } },
  });
}

/** Routes the plan, and records each change the tab sends, answering with `next`. */
async function routePlan(page: Page, plan: PlanView, next?: (body: { change: { type: string } }) => PlanView) {
  const changes: unknown[] = [];
  await page.route('**/api/workspace/demo/plan/items', async (route: Route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      changes.push(body);
      const updated = next ? next(body) : plan;
      plan = updated;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'Saved.', plan: updated }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(plan) });
  });
  return changes;
}

const planRegion = (page: Page) => page.getByRole('region', { name: 'The plan', exact: true });

test('shows what needs the user, the milestones in order, the rest, and what changed', async ({ page }) => {
  await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  const plan = planRegion(page);
  await expect(plan.getByText('Needs you 2 · In progress 2 · To do 3 · Done 3')).toBeVisible();
  await expect(plan.getByText('2 things wait for you')).toBeVisible();
  // A question says who asked, when, why and what it holds up, with the answers the AI suggested.
  await expect(plan.getByText('Codex asked 5 min ago · holds up CSV export endpoint')).toBeVisible();
  await expect(plan.getByText('Timestamps in the file must match what the report shows.')).toBeVisible();
  await expect(plan.getByRole('group', { name: 'Suggested answers' }).getByRole('button')).toHaveText(['UTC', 'The account time zone']);
  await expect(plan.getByText('Claude says it is done · check and decide')).toBeVisible();
  await expect(plan.getByRole('progressbar', { name: 'Milestones done' })).toHaveAttribute('aria-valuenow', '1');
  await expect(plan.getByText('1 of 3 milestones done')).toBeVisible();
  // Names, not codes: the code is in the tooltip. Every row starts with its status word, so there is no legend.
  // A task a milestone waits for is shown under it, and commits are short.
  const milestones = plan.getByRole('list').nth(1);
  await expect(milestones.getByRole('button')).toHaveText([
    /^Database query for report rowsDone · Passed its check on a91f2e0You/,
    /^CSV export endpointIn progress · ClaudeYou/,
    /^Background job queue for large exportsClaude says it is done/,
    /^Export button in the UITo do · starts after CSV export endpointYou/,
    /^User docs for exportDropped · Docs are generated automatically nowYou/,
  ]);
  await expect(milestones.getByRole('button', { name: /^CSV export endpoint/ })).toHaveAttribute('title', 'M2 CSV export endpoint');
  await expect(plan.getByRole('list', { name: 'Tasks for CSV export endpoint' })).toContainText('Background job queue for large exports');
  await expect(plan.getByText('The AI answers')).toBeVisible();
  await expect(plan.getByText('Later · look again after user feedback on CSV')).toBeVisible();
  await expect(plan.getByText('started CSV export endpoint')).toBeVisible();
  await expect(plan.getByText('a91f2e0c4d5b')).toHaveCount(0);
  // The plan is taught where it is used: no legend row, no explainer dialog.
  await expect(plan.getByLabel('What the icons mean')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'How the plan works' })).toHaveCount(0);
  if (SHOTS) await plan.screenshot({ path: `${SHOTS}/plan-tab.png` });
});

test('fills the answer from a suggestion, and puts off or drops a stale question from its row', async ({ page }) => {
  const changes = await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  const plan = planRegion(page);
  await plan.getByRole('group', { name: 'Suggested answers' }).getByRole('button', { name: 'UTC' }).click();
  await expect(page.getByLabel('Your answer to Which time zone should export timestamps use?')).toHaveValue('UTC');
  await plan.getByRole('button', { name: 'Put off…' }).click();
  await plan.getByLabel('When should it be looked at again?').fill('After the first release');
  await plan.getByRole('button', { name: 'Put off', exact: true }).click();
  await plan.getByRole('button', { name: 'Drop…' }).click();
  await plan.getByLabel('Why is it not needed any more?').fill('Timestamps are dropped from the export');
  await plan.getByRole('button', { name: 'Drop', exact: true }).click();
  await expect.poll(() => changes).toEqual([
    { change: { type: 'later', id: 'Q1', revisitWhen: 'After the first release' }, ifRevision: 3 },
    { change: { type: 'drop', id: 'Q1', reason: 'Timestamps are dropped from the export' }, ifRevision: 3 },
  ]);
});

test('answers the user\'s question in place, as the user', async ({ page }) => {
  const changes = await routePlan(page, csvExportPlan(), () => {
    const plan = csvExportPlan();
    const answered = plan.needsYou.find((item) => item.id === 'Q1')!;
    return planView([...plan.milestones, ...plan.otherOpen, ...plan.closed, ...plan.needsYou.filter((item) => item.id !== 'Q1'),
      { ...answered, status: 'done', resolution: 'UTC' }]);
  });
  await page.goto('/#/workspaces/demo/plan');
  await page.getByLabel('Your answer to Which time zone should export timestamps use?').fill('UTC');
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect.poll(() => changes).toEqual([{ change: { type: 'answer', id: 'Q1', answer: 'UTC' }, ifRevision: 3 }]);
  await expect(planRegion(page).getByText('1 thing waits for you')).toBeVisible();
});

test('accepts the AI\'s done, or sends it back with what still needs doing', async ({ page }) => {
  const changes = await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  await page.getByRole('button', { name: 'Not yet' }).click();
  await page.getByLabel('What still needs doing?').fill('Also export the totals row');
  await page.getByRole('button', { name: 'Send back to Claude' }).click();
  await page.getByRole('button', { name: 'Yes, it is done' }).click();
  await expect.poll(() => changes).toEqual([
    { change: { type: 'reject', id: 'T1', reason: 'Also export the totals row' }, ifRevision: 3 },
    { change: { type: 'accept', id: 'T1' }, ifRevision: 3 },
  ]);
});

test('opens a milestone: what it must deliver, what it waits for and holds up, its check, where the work is, its history', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const changes = await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  await planRegion(page).getByRole('button', { name: /^CSV export endpoint/ }).click();
  const detail = page.getByRole('region', { name: 'Milestone M2 CSV export endpoint' });
  await expect(detail.getByText('Milestone 2 of 3')).toBeVisible();
  await expect(detail.getByText('A report can be downloaded as a CSV file.', { exact: false })).toBeVisible();
  await expect(detail.getByText('Waiting for your answer')).toBeVisible();
  await expect(detail.getByText('Claude says it is done · Exports over 10,000 rows', { exact: false })).toBeVisible();
  await expect(detail.getByText('Answered · 50,000 rows per export')).toBeVisible();
  await expect(detail.getByText('Export button in the UI', { exact: true })).toBeVisible();
  await expect(detail.getByText('Last run passed · commit 7c9e1f2', { exact: false })).toBeVisible();
  await expect(detail.getByText(PLAN_RULES[2]!)).toBeVisible();
  await expect(detail.getByText('feat/csv-export')).toBeVisible();
  await expect(detail.getByText('2 h ago · Codex')).toBeVisible();
  if (SHOTS) await detail.screenshot({ path: `${SHOTS}/plan-milestone.png` });

  // Opened beside the list, which stays in view; its main action sits next to its name.
  await expect(planRegion(page)).toBeVisible();
  await expect(planRegion(page).getByRole('button', { name: /^CSV export endpoint/ })).toHaveAttribute('aria-current', 'true');
  await expect(detail.getByRole('button', { name: 'Done…' })).toBeVisible();
  await detail.getByRole('button', { name: 'Mark blocked…' }).click();
  await detail.getByLabel('What is it stuck on?').fill('Waiting for the design');
  await detail.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => changes).toEqual([{ change: { type: 'block', id: 'M2', reason: 'Waiting for the design' }, ifRevision: 3 }]);
  // What it waits for opens from here.
  await detail.getByRole('button', { name: /^Which time zone should export timestamps use\?/ }).click();
  await expect(page.getByRole('region', { name: 'Question Q1 Which time zone should export timestamps use?' })).toBeVisible();
  await page.getByRole('region', { name: 'Question Q1 Which time zone should export timestamps use?' }).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('region', { name: /^Question Q1/ })).toHaveCount(0);
});

test('opens an item in place of the list when there is no room beside it', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  await planRegion(page).getByRole('button', { name: /^CSV export endpoint/ }).click();
  await expect(page.getByRole('region', { name: 'Milestone M2 CSV export endpoint' })).toBeVisible();
  await expect(planRegion(page)).toBeHidden();
  await page.getByRole('button', { name: 'Back to the plan' }).click();
  await expect(planRegion(page)).toBeVisible();
});

test('adds an item that holds up a milestone', async ({ page }) => {
  const changes = await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  await page.getByRole('button', { name: 'Add to the plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to the plan' });
  await dialog.getByLabel('What is it?').selectOption('task');
  await dialog.getByLabel('Name').fill('Rate limit for exports');
  await dialog.getByLabel('Holds up').selectOption('M2');
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/plan-add.png` });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => changes).toEqual([{ change: { type: 'add', kind: 'task', title: 'Rate limit for exports', before: ['M2'] }, ifRevision: 3 }]);
  await expect(dialog).toBeHidden();
});

test.describe('with two workspaces', () => {
  const other = { ...workspace, id: 'other', branchName: 'other', name: 'Billing retries', description: 'Retry failed card payments', workspacePath: '/tmp/other' };
  test.use({ workspacesData: [[workspace, other], { option: true }] });

  test('switching back and forth shows only the plan of the workspace on screen', async ({ page }) => {
    await routePlan(page, csvExportPlan());
    await page.route('**/api/workspace/other/plan/items', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(planView([planItem({ id: 'M1', title: 'Retry a failed payment once' })])) }));
    for (const [id, title] of [['demo', 'CSV export endpoint'], ['other', 'Retry a failed payment once'], ['demo', 'CSV export endpoint'], ['other', 'Retry a failed payment once']]) {
      await page.goto(`/#/workspaces/${id}/plan`);
      // The new plan first, then the count: a plan left behind from the last workspace would make it two.
      await expect(planRegion(page).filter({ hasText: title })).toBeVisible();
      await expect(planRegion(page)).toHaveCount(1);
    }
  });
});

test('says when the plan cannot be read, and reads it again on Retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/workspace/demo/plan/items', async (route) => fail
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'The plan file contextspace-plan.json can\'t be read.' }) })
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(csvExportPlan()) }));
  await page.goto('/#/workspaces/demo/plan');
  await expect(page.getByRole('alert').filter({ hasText: 'The plan could not be read' })).toBeVisible({ timeout: 15_000 });
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(planRegion(page)).toBeVisible();
});
