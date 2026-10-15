import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planItem, planView } from './planData';

test.use({
  workspacesData: [{
    id: 'demo', branchName: 'demo', name: 'Invoice speed-up', description: 'Make invoice totals load under a second', repos: ['/dev/api', '/dev/web'],
    assistants: [], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z',
  }],
  workspacesStatusData: { demo: { id: 'demo', branchName: 'demo', changedFiles: 3, dirtyRepos: 1, syncStatus: 'up-to-date', runningServices: 0 } },
});

async function mockWorkspace(page: Page) {
  const lifecycle = { workspaceId: 'demo', flowType: 'feature', revision: 0, updatedAt: '', fleet: [], steps: [
    { id: 'baseline', title: 'Measure baseline', status: 'completed' },
    { id: 'cache', title: 'Cache invoice lookups', status: 'in_progress' },
  ] };
  const guidance = { version: 1, revision: 0, workType: 'performance', size: 'standard', documents: [],
    assignment: { stage: 'implement', objective: 'Find the bottleneck', expectedOutput: '', stopCondition: '' } };
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: { content: '# Plan' } }));
  await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle, report: { overallStatus: 'pass', canProgress: true, durationMs: 1200, repos: [] } } }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance, lifecycle, sharedDocuments: [], assignment: '' } }));
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.route('**/api/workspace/demo/plan/items', (route) => route.fulfill({ json: planView([
    planItem({ id: 'baseline', title: 'Measure baseline', status: 'done' }),
    planItem({ id: 'cache', title: 'Cache invoice lookups', status: 'in_progress' }),
    planItem({ id: 'report', title: 'Report the speed-up', waitsFor: [{ id: 'cache', label: 'cache Cache invoice lookups', status: 'in_progress' }] }),
  ]) }));
}

const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });

test('one header shows where the task stands and links to where to act', async ({ page }) => {
  await mockWorkspace(page);
  // A workspace opens on its chat, whose header is short. The full header with where the task stands is on the other destinations.
  await page.goto('/#/workspaces/demo/overview');
  await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
  const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1, name: 'Invoice speed-up' }) });
  // One row: the goal is on the plan, so the raw brief is not repeated here, and the stage word is gone.
  await expect(header).not.toContainText('Make invoice totals load under a second');
  const status = page.getByRole('group', { name: 'Task status' });
  await expect(status).not.toContainText('Stage');
  // Now and Next come from the plan's one rule: Next names what it waits for instead of claiming it can start.
  await expect(status).toContainText('Now Cache invoice lookups');
  await expect(status).toContainText('Next Report the speed-up · waits for Cache invoice lookups');
  await expect(status).toContainText('3 files');
  await expect(status).toContainText('Checks passed');
  // The workspace is named once; the old cockpit strip and stage switcher are gone.
  await expect(page.getByRole('heading', { name: 'Invoice speed-up' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Diff Review' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Process DAG' })).toHaveCount(0);

  // The rail beside the panel: what can open beside the chat, with the changed files counted.
  await expect(workspaceNav(page).getByRole('link')).toHaveText([/^Plan$/, /^Sessions$/, /^Code3$/, /^Docs$/, /^Skills/, /^Services$/]);
  await status.getByRole('link', { name: /Changes/ }).click();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/changes$/);
  await expect(workspaceNav(page).getByRole('link', { name: /^Code/ })).toHaveAttribute('aria-current', 'page');
});

test('old section links still open, each marked on the rail when it has a place there, and back navigation works', async ({ page }) => {
  await mockWorkspace(page);
  for (const [section, item] of [['documents', 'Docs'], ['services', 'Services'], ['plan', 'Plan'], ['sessions', 'Sessions']] as const) {
    await page.goto(`/#/workspaces/demo/${section}`);
    await expect(workspaceNav(page).getByRole('link', { name: item })).toHaveAttribute('aria-current', 'page');
  }
  // The overview and knowledge keep their addresses, with nothing marked on the rail.
  for (const [section, region] of [['overview', 'Overview'], ['knowledge', 'Knowledge']] as const) {
    await page.goto(`/#/workspaces/demo/${section}`);
    await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible();
    await expect(workspaceNav(page).locator('[aria-current="page"]')).toHaveCount(0);
  }
  await page.goto('/#/workspaces/demo/overview');
  await workspaceNav(page).getByRole('link', { name: 'Services' }).click();
  await expect(page).toHaveURL(/\/services$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('region', { name: 'Overview', exact: true })).toBeVisible();
});

test('switching parts keeps an unsaved brief', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/#/workspaces/demo/plan');
  await page.getByRole('button', { name: 'Edit the goal' }).click();
  const objective = page.getByLabel('Current objective');
  await expect(objective).toHaveValue('Find the bottleneck');
  await objective.fill('Cache invoice lookups per customer');

  await workspaceNav(page).getByRole('link', { name: 'Docs' }).click();
  await expect(page.getByRole('region', { name: 'Documents', exact: true })).toBeVisible();
  await workspaceNav(page).getByRole('link', { name: 'Plan' }).click();
  // The draft was not saved, and it was not lost.
  await expect(page.getByLabel('Current objective')).toHaveValue('Cache invoice lookups per customer');
});
