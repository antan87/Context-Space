import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { checkpoint, decision, planFile, step, whatsNew } from './planData';
import type { PlanFileChangeInput, PlanFileView } from '../src/features/plan/planFile.ts';
import type { WhatsNewView } from '../src/features/plan/whatsNew.ts';

/**
 * The Plan tab: PLAN.md as a document. Its free text reads as written; its checkpoints, steps and decisions are
 * ticked and answered in place, and each checkpoint says what its check proved. Every change goes into the file.
 */
const workspace = { id: 'demo', branchName: 'demo', name: 'Reports CSV export', description: 'Add CSV export to reports', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 1000 } });

const SHOTS = process.env.PLAN_SHOTS_DIR;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function csvExportPlan(): PlanFileView {
  return planFile({
    title: 'Reports CSV export',
    intro: 'Customers export their reports as **CSV**. Large reports run in the background, at most 50,000 rows each.',
    checkpoints: [
      checkpoint('Report rows load fast', { done: true, check: 'npm test', outcome: 'Loads 10,000 rows in 40 ms',
        proof: { canProgress: true, lastVerificationSha: 'a91f2e0c4d5b', lastVerificationStatus: 'pass', at: minutesAgo(2900) },
        steps: [step('Query the report rows', true)] }),
      checkpoint('Reports export to CSV', { check: 'npm test', detail: 'A report downloads as a CSV file from the report page.',
        proof: { canProgress: false, lastVerificationSha: 'c9043b3aa', lastVerificationStatus: 'fail', at: minutesAgo(30) },
        steps: [step('Write the CSV writer', true), step('Background job queue for large exports')],
        decisions: [decision('Which time zone should export timestamps use?', { detail: 'Timestamps must match what the report shows.', suggested: ['UTC', 'The account time zone'], ifNoAnswer: 'UTC' })] }),
      checkpoint('Export button in the UI'),
    ],
    steps: [step('Tidy the old export script'), step('Rename the export module', true)],
    decisions: [decision('Maximum rows per export?', { done: true, answer: '50,000 rows' })],
    sections: [{ heading: 'Notes', body: 'Excel export comes after feedback on CSV.' }],
    changes: [
      { at: minutesAgo(5), by: 'codex', action: 'added', kind: 'decision', key: 'which-time-zone-should-export-timestamps-use', text: 'Which time zone should export timestamps use?' },
      { at: minutesAgo(40), by: 'file', action: 'ticked', kind: 'step', key: 'write-the-csv-writer', text: 'Write the CSV writer' },
      { at: minutesAgo(2900), by: 'claude', action: 'ticked', kind: 'checkpoint', key: 'report-rows-load-fast', text: 'Report rows load fast' },
    ],
  });
}

/** Serves `plan`, records each change, and answers it with `respond` (the plan back, unchanged, by default). */
async function routePlan(page: Page, plan: PlanFileView, respond?: (change: PlanFileChangeInput) => { status: number; body: object }) {
  const changes: PlanFileChangeInput[] = [];
  await page.route('**/api/workspace/demo/plan', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: plan });
    const { change } = route.request().postDataJSON() as { change: PlanFileChangeInput };
    changes.push(change);
    const answer = respond?.(change) ?? { status: 200, body: { message: 'Done.', plan } };
    return route.fulfill({ status: answer.status, json: answer.body });
  });
  return changes;
}

const planRegion = (page: Page) => page.getByRole('region', { name: 'The plan' });

test('reads PLAN.md as a document: its text, the checkpoints with their steps and proof, decisions and what changed', async ({ page }) => {
  await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  const plan = planRegion(page);
  await expect(plan.getByRole('heading', { name: 'Reports CSV export', exact: true })).toBeVisible();
  await expect(plan).toContainText('1 of 3 checkpoints done · 1 decision waits for you');
  await expect(plan.locator('strong').filter({ hasText: 'CSV' })).toBeVisible();
  await expect(plan.getByRole('progressbar', { name: 'Checkpoints done' })).toHaveAttribute('aria-valuenow', '1');

  // No codes, statuses or approval requests: names, ticks and proof.
  await expect(plan).not.toContainText(/\b[MTQ]\d\b/);
  const csv = plan.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Reports export to CSV' }) });
  await expect(csv).toContainText('1 of 2 steps');
  await expect(csv).toContainText('Check failed on c9043b3 · 30 min ago');
  await expect(csv.getByRole('checkbox', { name: 'Write the CSV writer' })).toBeChecked();
  await expect(csv.getByRole('checkbox', { name: 'Background job queue for large exports' })).not.toBeChecked();
  const question = csv.getByRole('group', { name: 'Which time zone should export timestamps use?' });
  await expect(question).toContainText('Waits for you · holds up Reports export to CSV');
  await expect(question).toContainText('Timestamps must match what the report shows.');
  await expect(question).toContainText('If you don’t answer: UTC');

  // A finished checkpoint folds to its title, outcome and proof.
  const done = plan.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Report rows load fast' }) });
  await expect(done).toContainText('Loads 10,000 rows in 40 ms');
  await expect(done).toContainText('Check passed on a91f2e0');
  await expect(done.getByRole('checkbox', { name: 'Query the report rows' })).toHaveCount(0);
  await done.getByRole('button', { name: 'Show its steps' }).click();
  await expect(done.getByRole('checkbox', { name: 'Query the report rows' })).toBeChecked();

  await expect(plan).toContainText('Maximum rows per export? — 50,000 rows');
  await expect(plan.getByRole('checkbox', { name: 'Tidy the old export script' })).toBeVisible();
  await expect(plan.getByRole('checkbox', { name: 'Rename the export module' })).toHaveCount(0);
  await expect(plan).toContainText('1 done · show');
  await plan.getByText('Notes').click();
  await expect(plan).toContainText('Excel export comes after feedback on CSV.');
  await expect(plan).toContainText('Codex added “Which time zone should export timestamps use?”');
  await expect(plan).toContainText('An edit to PLAN.md ticked “Write the CSV writer”');
  if (SHOTS) {
    await page.setViewportSize({ width: 1280, height: 2000 });
    await page.screenshot({ path: `${SHOTS}/plan-document.png` });
  }
});

test('ticks a step and answers a decision in place, as the user, naming each by its words', async ({ page }) => {
  const changes = await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  const plan = planRegion(page);
  await plan.getByRole('checkbox', { name: 'Background job queue for large exports' }).click();
  await expect.poll(() => changes).toEqual([{ type: 'tick', key: 'background-job-queue-for-large-exports', done: true, expected: 'Background job queue for large exports' }]);
  const question = plan.getByRole('group', { name: 'Which time zone should export timestamps use?' });
  await question.getByRole('button', { name: 'UTC' }).click();
  await question.getByRole('button', { name: 'Answer' }).click();
  await expect.poll(() => changes.at(-1)).toEqual({ type: 'answer', key: 'which-time-zone-should-export-timestamps-use', answer: 'UTC', expected: 'Which time zone should export timestamps use?' });
  await expect(plan.getByRole('status')).toHaveText('Done.');
});

test('ticks a checkpoint with a check only once it passes, and says why when it does not', async ({ page }) => {
  const changes = await routePlan(page, csvExportPlan(), (change) => change.type === 'tick'
    ? { status: 400, body: { error: '"Reports export to CSV" stays open: its check failed. Fix what fails, then tick it again.' } }
    : { status: 200, body: { message: 'The check failed.', plan: csvExportPlan() } });
  await page.goto('/#/workspaces/demo/plan');
  const plan = planRegion(page);
  await plan.getByRole('checkbox', { name: 'Reports export to CSV' }).click();
  await expect(plan.getByRole('alert')).toContainText('stays open: its check failed');
  await expect(plan.getByRole('checkbox', { name: 'Reports export to CSV' })).not.toBeChecked();
  await plan.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Reports export to CSV' }) }).getByRole('button', { name: 'Run it now' }).click();
  await expect.poll(() => changes.at(-1)).toEqual({ type: 'check', key: 'reports-export-to-csv' });
});

test('adds a step under a checkpoint', async ({ page }) => {
  const changes = await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  const csv = planRegion(page).getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Reports export to CSV' }) });
  await csv.getByRole('button', { name: 'Add a step' }).click();
  await csv.getByRole('textbox', { name: 'The new step' }).fill('Rate limit for exports');
  await csv.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => changes).toEqual([{ type: 'add', step: 'Rate limit for exports', checkpoint: 'reports-export-to-csv' }]);
});

test('says how a plan starts when there is none', async ({ page }) => {
  await routePlan(page, planFile());
  await page.goto('/#/workspaces/demo/plan');
  await expect(planRegion(page)).toContainText('No plan yet. When the work has steps worth checking off, an AI writes PLAN.md');
  await expect(planRegion(page).getByRole('button', { name: 'Add a step' })).toBeVisible();
});

test.describe('with two workspaces', () => {
  const other = { ...workspace, id: 'other', branchName: 'other', name: 'Billing retries', description: 'Retry failed card payments', workspacePath: '/tmp/other' };
  test.use({ workspacesData: [[workspace, other], { option: true }] });

  test('switching back and forth shows only the plan of the workspace on screen', async ({ page }) => {
    await routePlan(page, csvExportPlan());
    await page.route('**/api/workspace/other/plan', (route) => route.fulfill({ json: planFile({ title: 'Billing retries', checkpoints: [checkpoint('Retry a failed payment once')] }) }));
    for (const [id, title] of [['demo', 'Reports export to CSV'], ['other', 'Retry a failed payment once'], ['demo', 'Reports export to CSV'], ['other', 'Retry a failed payment once']]) {
      await page.goto(`/#/workspaces/${id}/plan`);
      // The new plan first, then the count: a plan left behind from the last workspace would make it two.
      await expect(planRegion(page).filter({ hasText: title })).toBeVisible();
      await expect(planRegion(page)).toHaveCount(1);
    }
  });
});

test('says when the plan cannot be read, and reads it again on Retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/workspace/demo/plan', async (route) => fail
    ? route.fulfill({ status: 500, json: { error: 'PLAN.md cannot be read.' } })
    : route.fulfill({ json: csvExportPlan() }));
  await page.goto('/#/workspaces/demo/plan');
  await expect(page.getByRole('alert').filter({ hasText: 'The plan could not be read' })).toBeVisible({ timeout: 15_000 });
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(planRegion(page)).toBeVisible();
});

/** Since the user last looked: two hours ago, an AI ticked a step and two others added, a document came and two commits landed. */
function sinceLastLook(): WhatsNewView {
  return whatsNew({
    from: minutesAgo(120),
    plan: { items: [
      { at: minutesAgo(40), by: 'codex', action: 'ticked', kind: 'step', key: 'write-the-csv-writer', text: 'Write the CSV writer' },
      { at: minutesAgo(30), by: 'file', action: 'added', kind: 'step', key: 'add-the-export-button', text: 'Add the Export button' },
      { at: minutesAgo(20), by: 'claude', action: 'answered', kind: 'decision', key: 'which-time-zone', text: 'Which time zone?', note: 'UTC' },
    ], more: 0 },
    documents: { items: [{ name: 'docs/export-flow.png', kind: 'image', change: 'added', at: minutesAgo(60) }], more: 0 },
    commits: [{ repo: 'api', more: 0, commits: [
      { sha: 'a1b2c3d', author: 'Anna', subject: 'Fix rounding in totals', at: minutesAgo(180) },
      { sha: 'b2c3d4e', author: 'Ben', subject: 'Add the CSV writer', at: minutesAgo(90) },
    ] }],
  });
}

const sinceCard = (page: Page) => page.getByRole('region', { name: 'Since you last looked' });

test('says what changed since the user last looked, lists it on Show, and hides the card when they say Got it', async ({ page }) => {
  await routePlan(page, csvExportPlan());
  const report = sinceLastLook();
  const seen: unknown[] = [];
  let current = report;
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: current }));
  await page.route('**/api/workspace/demo/news/seen', (route) => {
    seen.push(route.request().postDataJSON());
    current = whatsNew({ from: report.at });
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto('/#/workspaces/demo/plan');
  const card = sinceCard(page);
  await expect(card).toContainText('Since you last looked, 2 h ago: 3 plan changes, 1 new document, 2 commits');
  // It sits above the plan, and nothing in it is a code.
  await expect(card).not.toContainText(/\b[MTQ]\d\b/);
  const above = await Promise.all([card.boundingBox(), planRegion(page).boundingBox()]);
  expect(above[0]!.y).toBeLessThan(above[1]!.y);

  await expect(card).not.toContainText('Fix rounding in totals');
  await card.getByRole('button', { name: 'Show' }).click();
  await expect(card.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  await expect(card.getByRole('region', { name: 'Plan' })).toContainText('Codex ticked “Write the CSV writer” · 40 min ago');
  await expect(card.getByRole('region', { name: 'Plan' })).toContainText('An edit to PLAN.md added “Add the Export button” · 30 min ago');
  await expect(card.getByRole('region', { name: 'Plan' })).toContainText('Claude answered “Which time zone?”: UTC · 20 min ago');
  await expect(card.getByRole('region', { name: 'Documents' })).toContainText('docs/export-flow.png added · 1 h ago');
  await expect(card.getByRole('region', { name: 'Commits' })).toContainText('api: a1b2c3d Fix rounding in totals (Anna) · 3 h ago');
  await expect(card.getByRole('region', { name: 'Knowledge' })).toHaveCount(0);
  if (SHOTS) {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.screenshot({ path: `${SHOTS}/since-you-looked.png` });
  }

  await card.getByRole('button', { name: 'Got it' }).click();
  await expect(card).toHaveCount(0);
  expect(seen).toEqual([{ reader: 'user', at: report.at }]);
  // The plan itself is still there.
  await expect(planRegion(page)).toBeVisible();
});

test('shows no card when nothing changed since the user last looked', async ({ page }) => {
  await routePlan(page, csvExportPlan());
  await page.goto('/#/workspaces/demo/plan');
  await expect(planRegion(page)).toBeVisible();
  await expect(sinceCard(page)).toHaveCount(0);
});

test('says why Got it was refused when the list changed meanwhile, and reads the list again', async ({ page }) => {
  await routePlan(page, csvExportPlan());
  let reads = 0;
  let current = sinceLastLook();
  await page.route('**/api/workspace/demo/news', (route) => { reads += 1; return route.fulfill({ json: current }); });
  await page.route('**/api/workspace/demo/news/seen', (route) => {
    current = { ...sinceLastLook(), at: new Date().toISOString(), commits: [] };
    return route.fulfill({ status: 409, json: { error: 'The list changed; read it again.' } });
  });
  await page.goto('/#/workspaces/demo/plan');
  const card = sinceCard(page);
  await expect(card).toContainText('3 plan changes, 1 new document, 2 commits');
  const readsBefore = reads;
  await card.getByRole('button', { name: 'Got it' }).click();
  await expect(card.getByRole('alert')).toHaveText('The list changed; read it again.');
  await expect(card).not.toContainText('2 commits');
  await expect(card).toContainText('3 plan changes, 1 new document');
  expect(reads).toBeGreaterThan(readsBefore);
});

test.describe('an archived workspace', () => {
  const archived = { ...workspace, archivedAt: '2026-09-28T10:00:00.000Z', archive: { archivedAt: '2026-09-28T10:00:00.000Z', previousMode: 'in-place', parked: true, repos: [] } };
  test.use({ workspacesData: [[archived], { option: true }] });

  test('shows what changed, but cannot say it was seen', async ({ page }) => {
    await routePlan(page, csvExportPlan());
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: sinceLastLook() }));
    await page.goto('/#/workspaces/demo/plan');
    const card = sinceCard(page);
    await expect(card).toContainText('Since you last looked, 2 h ago: 3 plan changes');
    await card.getByRole('button', { name: 'Show' }).click();
    await expect(card).toContainText('Fix rounding in totals');
    await expect(card.getByRole('button', { name: 'Got it' })).toHaveCount(0);
  });
});
