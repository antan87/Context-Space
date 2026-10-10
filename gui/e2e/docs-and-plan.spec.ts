import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planItem, planView } from './planData';

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
  test('is read first: the goal in a line, the rest on request, and the milestones as a checklist', async ({ page }) => {
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
    await page.route('**/api/workspace/demo/plan/items', (route) => route.fulfill({ json: planView([
      planItem({ id: 'measure', title: 'Measure the slow page', status: 'done', resolution: 'Passed its check' }),
      planItem({ id: 'cache', title: 'Cache the lookups', status: 'in_progress', history: [{ at: '2026-10-10T10:00:00.000Z', by: 'claude', action: 'started' }] }),
      planItem({ id: 'ship', title: 'Ship behind a flag', waitsFor: [{ id: 'cache', label: 'cache Cache the lookups', status: 'in_progress' }] }),
    ]) }));
    await page.goto('/#/workspaces/demo/plan');
    const goal = page.getByRole('region', { name: 'Goal', exact: true });
    await expect(goal).toContainText('Make invoices load in under a second.');
    await expect(goal).toContainText('Implement · Performance · Standard change');
    await expect(goal).toContainText('Delivers');
    await expect(goal.getByText('Today they take four')).toBeHidden();
    await goal.getByText('The whole goal').click();
    await expect(goal.getByText(/Today they take four/)).toBeVisible();
    await expect(page.getByLabel('Current objective')).toHaveCount(0);

    // Under the goal, the plan: the milestones in order, each saying where it is.
    const plan = page.getByRole('region', { name: 'The plan', exact: true });
    await expect(plan).toContainText('1 of 3 milestones done');
    await expect(plan.getByRole('listitem')).toHaveText([
      /Measure the slow page.*Done · Passed its check/, /Cache the lookups.*In progress · Claude/, /Ship behind a flag.*To do · starts after cache Cache the lookups/,
    ]);

    // Editing opens the form in place, and Done closes it again.
    await page.getByRole('button', { name: 'Edit the goal' }).click();
    await expect(page.getByLabel('Current objective')).toHaveValue(/Make invoices load/);
    await page.getByRole('button', { name: 'Done with the goal' }).click();
    await expect(page.getByLabel('Current objective')).toHaveCount(0);
  });
});
