import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { checkpoint, planFile, step } from './planData';

/**
 * Docs is the one place to read: what ContextSpace keeps for the work, by what each file is for, above the developer's
 * own documents, with knowledge as entries. The plan is read first, and each part is edited in place.
 */
const workspace = { id: 'demo', branchName: 'demo', name: 'Invoice speed-up', description: 'Faster invoices', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1440, height: 900 } });

const KNOWLEDGE = `# Workspace Knowledge — demo

> Append with \`ctxspace knowledge add\`.

## Feature Goal

Invoices should load in under a second.

## Team notes

Ask before changing the cache keys.

## Architecture Decisions

### 2026-10-02 — cache-invoice-lookups
**Decision:** Cache invoice lookups per customer, because totals were read three times a page.
**Scope:** \`path:api/src/invoices\`

## Known Gotchas

### 2026-10-03 — totals-differ-after-midnight
**Gotcha:** Totals differ after midnight UTC: the cache key used local time.
**Evidence:** commit abc1234
`;

async function mockDocuments(page: Page, knowledge = KNOWLEDGE) {
  const documents = ['contextspace-knowledge.md', 'contextspace-milestones.md', 'AGENTS.md', 'release-notes.md', 'concepts.html']
    .map((name) => ({ name, size: 2048, modifiedAt: '2026-10-04T10:00:00Z', kind: name.endsWith('.html') ? 'html' : 'markdown' }));
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name')!;
    return route.fulfill({ json: { name, kind: 'markdown', content: name === 'contextspace-knowledge.md' ? knowledge : `# ${name}\n\nPlain words.` } });
  });
}

const docs = (page: Page) => page.getByRole('region', { name: 'Workspace documents' });

test.describe('Docs', () => {
  test('pins what ContextSpace keeps above your own documents, by what each is for', async ({ page }) => {
    await mockDocuments(page);
    await page.goto('/#/workspaces/demo/documents');
    const pinned = docs(page).getByRole('list', { name: 'ContextSpace documents' });
    await expect(pinned.getByRole('button')).toHaveText([/^Knowledge/, /^Delivery plan/, /^Assistant instructions/]);
    // Your own documents are listed once, below; ContextSpace's files are not repeated there.
    await expect(docs(page).getByRole('treeitem', { name: /release-notes\.md/ })).toBeVisible();
    await expect(docs(page).getByRole('treeitem', { name: /AGENTS\.md/ })).toHaveCount(0);
    // The filter reaches both groups.
    await docs(page).getByLabel('Filter documents').fill('delivery');
    await expect(pinned.getByRole('button')).toHaveText([/^Delivery plan/]);
    await expect(docs(page).getByRole('treeitem', { name: /release-notes\.md/ })).toHaveCount(0);
  });

  test('reads knowledge as entries you can search and filter, and shows the file on request', async ({ page }) => {
    await mockDocuments(page);
    await page.goto('/#/workspaces/demo/documents');
    await docs(page).getByRole('button', { name: /^Knowledge/ }).click();
    const entries = docs(page).getByRole('list', { name: 'Knowledge entries' }).getByRole('listitem');
    await expect(entries).toHaveCount(2);
    // Newest first, the title in words, with where it applies and the evidence.
    await expect(entries.first()).toContainText('Gotcha');
    await expect(entries.first()).toContainText('Totals differ after midnight');
    await expect(entries.first()).toContainText('commit abc1234');
    await expect(entries.last()).toContainText('Applies to api/src/invoices');
    // The goal and what was written by hand are there too, not only the entries.
    await expect(docs(page).getByRole('region', { name: 'Feature goal' })).toContainText('Invoices should load in under a second.');
    await expect(docs(page).getByRole('region', { name: 'Team notes' })).toContainText('Ask before changing the cache keys.');
    await docs(page).getByRole('button', { name: /^Decisions/ }).click();
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('Cache invoice lookups');
    await docs(page).getByRole('button', { name: /^All/ }).click();
    await docs(page).getByLabel('Search the knowledge').fill('midnight');
    await expect(entries).toHaveCount(1);
    await docs(page).getByLabel('Search the knowledge').fill('nothing like this');
    await expect(docs(page).getByRole('status')).toHaveText('Nothing matches.');
    await docs(page).getByRole('button', { name: 'Show the file' }).click();
    await expect(docs(page).getByRole('list', { name: 'Knowledge entries' })).toHaveCount(0);
    await expect(docs(page).getByText('Append with')).toBeVisible();
  });

  test('shows a knowledge file that does not use entries as it is written', async ({ page }) => {
    await mockDocuments(page, '# Notes\n\nWe learned to cache lookups.');
    await page.goto('/#/workspaces/demo/documents');
    await docs(page).getByRole('button', { name: /^Knowledge/ }).click();
    await expect(docs(page).getByText('We learned to cache lookups.')).toBeVisible();
    await expect(docs(page).getByRole('list', { name: 'Knowledge entries' })).toHaveCount(0);
  });

  test('beside the chat, a document takes the panel, and the list is one click away over it', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 62 })));
    await mockDocuments(page);
    await page.goto('/#/workspaces/demo/documents');
    await docs(page).getByRole('button', { name: /^Delivery plan/ }).click();
    await expect(docs(page).getByRole('heading', { name: 'Delivery plan (contextspace-milestones.md)', exact: true })).toBeVisible();
    // The document gets the narrow panel; the list is not stacked above it.
    const list = docs(page).getByRole('complementary', { name: 'Documents to open' });
    await expect(list).toBeHidden();
    // Quick-switch moves to the next document in one click.
    await docs(page).getByRole('button', { name: 'Next document' }).click();
    await expect(docs(page).getByRole('heading', { name: 'Assistant instructions (AGENTS.md)', exact: true })).toBeVisible();
    // The list opens over the document, and closes again once a document is chosen.
    await docs(page).getByRole('button', { name: 'Show the document list' }).click();
    await expect(list).toBeVisible();
    await list.getByRole('treeitem', { name: /release-notes\.md/ }).click();
    await expect(list).toBeHidden();
    await expect(docs(page).getByRole('heading', { level: 3, name: 'release-notes.md', exact: true })).toBeVisible();
  });
});

test.describe('the plan', () => {
  test('is read first: the plan, then the goal in a line with the rest on request, and the milestones as a checklist', async ({ page }) => {
    const steps = [
      { id: 'measure', title: 'Measure the slow page', status: 'completed' },
      { id: 'cache', title: 'Cache the lookups', status: 'in_progress' },
      { id: 'ship', title: 'Ship behind a flag', status: 'pending' },
    ];
    const lifecycle = { workspaceId: 'demo', flowType: 'feature', revision: 1, steps, currentStepId: 'cache', fleet: [], updatedAt: '' };
    await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: {
      guidance: { version: 1, revision: 1, workType: 'performance', size: 'standard', documents: [], assignment: {
        stage: 'implement', objective: 'Make invoices load in under a second. Today they take four, because totals are read three times.',
        expectedOutput: 'A cached lookup with a test', stopCondition: 'Stop before the release' } },
      lifecycle, sharedDocuments: [], assignment: 'Stage: implement' } }));
    await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle, report: null } }));
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ checkpoints: [
      checkpoint('Measure the slow page', { done: true, outcome: 'Passed its check' }),
      checkpoint('Cache the lookups', { steps: [step('Cache the totals', true), step('Expire them on change')] }),
      checkpoint('Ship behind a flag'),
    ] }) }));
    await page.goto('/#/workspaces/demo/plan');
    const goal = page.getByRole('region', { name: 'Goal', exact: true });
    await expect(goal).toContainText('Make invoices load in under a second.');
    await expect(goal).toContainText('Implement · Performance · Standard change');
    // With milestones, each says what it delivers: the brief's own Delivers and Stops when would go stale beside them.
    await expect(goal).not.toContainText('Delivers');
    await expect(goal).not.toContainText('Stop before the release');
    await expect(goal.getByText('Today they take four')).toBeHidden();
    await goal.getByText('The whole goal').click();
    await expect(goal.getByText(/Today they take four/)).toBeVisible();
    await expect(page.getByLabel('Current objective')).toHaveCount(0);

    // Above the goal, the plan: the checkpoints in order, each saying how far it is.
    const plan = page.getByRole('region', { name: 'The plan', exact: true });
    await expect(plan).toContainText('1 of 3 checkpoints done');
    await expect(plan.getByRole('heading', { level: 4 })).toHaveText(['Measure the slow page', 'Cache the lookups', 'Ship behind a flag']);
    await expect(plan).toContainText('1 of 2 steps');
    expect((await plan.boundingBox())!.y).toBeLessThan((await goal.boundingBox())!.y);

    // Editing opens the form in place, and Done closes it again.
    await page.getByRole('button', { name: 'Edit the goal' }).click();
    await expect(page.getByLabel('Current objective')).toHaveValue(/Make invoices load/);
    await page.getByRole('button', { name: 'Done with the goal' }).click();
    await expect(page.getByLabel('Current objective')).toHaveCount(0);
  });

  const OBJECTIVE = 'Make invoices load in under a second. Today they take four, because totals are read three times.';
  const INTRO = 'Invoices must load in **under a second**, so the report page feels instant.';

  /** A workspace with milestones, a brief whose objective is OBJECTIVE, and a PLAN.md that opens with `intro`. */
  async function routeBriefAndPlan(page: Page, intro: string) {
    const lifecycle = { workspaceId: 'demo', flowType: 'feature', revision: 1, currentStepId: 'cache', fleet: [], updatedAt: '', steps: [
      { id: 'measure', title: 'Measure the slow page', status: 'completed' },
      { id: 'cache', title: 'Cache the lookups', status: 'in_progress' },
    ] };
    const work = { guidance: { version: 1, revision: 1, workType: 'performance', size: 'standard', documents: [], assignment: {
      stage: 'implement', objective: OBJECTIVE, expectedOutput: '', stopCondition: '' } },
      lifecycle, sharedDocuments: [], assignment: 'Stage: implement' };
    const saves: unknown[] = [];
    await page.route('**/api/workspace/demo/work', (route) => {
      if (route.request().method() === 'PUT') saves.push(route.request().postDataJSON());
      return route.fulfill({ json: work });
    });
    await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle, report: null } }));
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ title: 'Invoice speed-up', intro, checkpoints: [
      checkpoint('Measure the slow page', { done: true, outcome: 'Passed its check' }),
      checkpoint('Cache the lookups', { steps: [step('Cache the totals', true), step('Expire them on change')] }),
    ] }) }));
    return saves;
  }

  test('says the goal once: with opening text in PLAN.md the brief shrinks to a line and does not repeat it', async ({ page }) => {
    const saves = await routeBriefAndPlan(page, INTRO);
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto('/#/workspaces/demo/plan');
    const plan = page.getByRole('region', { name: 'The plan', exact: true });
    await expect(plan).toContainText('Invoices must load in under a second');
    const brief = page.getByRole('region', { name: 'Brief', exact: true });
    await expect(brief).toBeVisible();
    await expect(page.getByRole('region', { name: 'Goal', exact: true })).toHaveCount(0);
    // The objective is nowhere on the page but the plan's own words, and no "whole goal" is offered.
    await expect(page.getByText('Make invoices load in under a second')).toHaveCount(0);
    await expect(brief.getByText('The whole goal')).toHaveCount(0);
    // A line of chips instead, and the way to edit it.
    await expect(brief.getByText('Implement', { exact: true })).toBeVisible();
    await expect(brief.getByText('Performance', { exact: true })).toBeVisible();
    await expect(brief.getByText('Standard change', { exact: true })).toBeVisible();
    await expect(brief.getByRole('button', { name: 'Edit the brief' })).toBeVisible();
    // The sources stay, with their own edit action.
    await expect(page.getByRole('region', { name: 'Sources', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit sources' })).toBeVisible();

    // The plan first, then the brief, then the sources and the checks.
    const checks = page.getByRole('region', { name: 'Checks', exact: true });
    const ys = await Promise.all([plan, brief, page.getByRole('region', { name: 'Sources', exact: true }), checks].map(async (part) => (await part.boundingBox())?.y ?? NaN));
    expect(ys.every(Number.isFinite)).toBe(true);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    if (process.env.PLAN_SHOTS_DIR) await page.screenshot({ path: `${process.env.PLAN_SHOTS_DIR}/workspace-plan-tab.png` });

    // Editing is what it was: the form holds the objective, and saving sends the brief.
    await brief.getByRole('button', { name: 'Edit the brief' }).click();
    await expect(page.getByLabel('Current objective')).toHaveValue(OBJECTIVE);
    await page.getByLabel('Current objective').fill('Make invoices load in under 800 ms');
    await page.getByRole('button', { name: 'Save goal' }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ workType: 'performance', size: 'standard', assignment: { objective: 'Make invoices load in under 800 ms' } });
    await expect(page.getByRole('status').filter({ hasText: 'Goal saved.' })).toBeVisible();
    await page.getByRole('button', { name: 'Done with the brief' }).click();
    await expect(page.getByLabel('Current objective')).toHaveCount(0);
  });

  for (const [what, intro] of [['no opening text', ''], ['only blank lines for opening text', '   \n']] as const) {
    test(`shows the objective as the Goal when PLAN.md has ${what}`, async ({ page }) => {
      await routeBriefAndPlan(page, intro);
      await page.goto('/#/workspaces/demo/plan');
      const goal = page.getByRole('region', { name: 'Goal', exact: true });
      await expect(goal).toContainText('Make invoices load in under a second.');
      await expect(goal.getByRole('button', { name: 'Edit the goal' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Brief', exact: true })).toHaveCount(0);
    });
  }

  test('shows the objective as the Goal when there is no PLAN.md at all', async ({ page }) => {
    await routeBriefAndPlan(page, '');
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
    await page.goto('/#/workspaces/demo/plan');
    await expect(page.getByRole('region', { name: 'Goal', exact: true })).toContainText('Make invoices load in under a second.');
    await expect(page.getByRole('region', { name: 'Brief', exact: true })).toHaveCount(0);
  });
});

