import { test, expect } from './fixtures';
import { planFile } from './planData';

/**
 * The sidebar keeps the list of workspaces on every page, a workspace page included, so moving
 * between workspaces never means going back first. A workspace's repositories and branches are
 * one disclosure away on its own row instead of replacing the list.
 */
const workspace = (name: string) => ({
  id: name, branchName: name, description: `${name} workspace`, repos: ['C:/repo'], assistants: [], workspacePath: `/tmp/${name}`, createdAt: '2026-09-24T00:00:00Z',
});

test.use({
  workspacesData: [['alpha', 'beta', 'gamma'].map(workspace), { option: true }],
  reposData: [{ data: [{ name: 'repo', path: 'C:/repo', defaultBranch: 'main' }] }, { option: true }],
  viewport: { width: 1365, height: 900 },
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planFile() }));
});

const sidebar = (page: import('@playwright/test').Page) => page.locator('aside.context-sidebar');
const row = (page: import('@playwright/test').Page, name: string) => sidebar(page).getByRole('link', { name: new RegExp(`^${name}\\b`) });

test('the workspace list stays on a workspace page, with the active one marked', async ({ page }) => {
  await page.goto('/#/workspaces/alpha');
  for (const name of ['alpha', 'beta', 'gamma']) await expect(row(page, name)).toBeVisible();
  await expect(row(page, 'alpha')).toHaveAttribute('aria-current', 'page');
  await expect(row(page, 'beta')).not.toHaveAttribute('aria-current', 'page');
  // There is nothing to go back out of.
  await expect(sidebar(page).getByRole('button', { name: 'All workspaces' })).toHaveCount(0);
  await expect(sidebar(page).getByRole('list', { name: 'Repositories' })).toHaveCount(0);
});

test('moving to another workspace is one click, and the list is still there afterwards', async ({ page }) => {
  await page.goto('/#/workspaces/alpha/plan');
  await row(page, 'beta').click();
  await expect(page).toHaveURL(/#\/workspaces\/beta$/);
  await expect(row(page, 'beta')).toHaveAttribute('aria-current', 'page');
  await row(page, 'gamma').click();
  await expect(page).toHaveURL(/#\/workspaces\/gamma$/);
  for (const name of ['alpha', 'beta', 'gamma']) await expect(row(page, name)).toBeVisible();
});

test('repositories and branches are folded away until asked for, and only on the active workspace', async ({ page }) => {
  await page.goto('/#/workspaces/alpha');
  await expect(sidebar(page).getByRole('list', { name: 'Repositories' })).toHaveCount(0);
  // Only the workspace you are in has the disclosure.
  await expect(sidebar(page).getByRole('button', { name: /repositories and branches for (beta|gamma)/ })).toHaveCount(0);

  const toggle = sidebar(page).getByRole('button', { name: 'Show repositories and branches for alpha' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(sidebar(page).getByRole('button', { name: 'Hide repositories and branches for alpha' })).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar(page).getByRole('list', { name: 'Repositories' })).toBeVisible();
  // The list is still all there while they are open.
  await expect(row(page, 'beta')).toBeVisible();

  await sidebar(page).getByRole('button', { name: 'Hide repositories and branches for alpha' }).click();
  await expect(sidebar(page).getByRole('list', { name: 'Repositories' })).toHaveCount(0);
});

test('the workspace list is the same on pages outside a workspace', async ({ page }) => {
  await page.goto('/#/overview');
  for (const name of ['alpha', 'beta', 'gamma']) await expect(row(page, name)).toBeVisible();
  await expect(row(page, 'alpha')).not.toHaveAttribute('aria-current', 'page');
});

test('the chat resume buttons are there on a workspace page too', async ({ page }) => {
  await page.goto('/#/workspaces/alpha/plan');
  await sidebar(page).getByRole('button', { name: 'Resume CLI chat for beta' }).click();
  await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
  await expect(page.getByRole('region', { name: 'CLI Chat', exact: true })).toBeVisible();
});

test.describe('a repository that has to be prepared before it can be edited', () => {
  const repository = (name: string, reference: boolean) => ({
    name, path: `C:/${name}`, access: reference ? 'reference' : 'worktree', editable: !reference, branch: 'main', expectedBranch: reference ? null : 'main',
    head: 'abc1234', changedFiles: [],
  });

  test('is marked with a dot, and offers its preparation once the repositories are opened', async ({ page }) => {
    await page.route('**/api/workspace/alpha/repositories', (route) => route.fulfill({ json: { repositories: [repository('repo', true)] } }));
    await page.goto('/#/workspaces/alpha');
    const toggle = sidebar(page).getByRole('button', { name: 'Show repositories and branches for alpha' });
    // Nothing opens by itself: the list stays a list of workspaces.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('title', /needs preparing/);
    await expect(sidebar(page).getByRole('button', { name: 'Prepare repo for editing', exact: true })).toHaveCount(0);

    await toggle.click();
    await expect(sidebar(page).getByRole('button', { name: 'Prepare repo for editing', exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole('list', { name: 'Repositories' })).toContainText('read-only');
    await expect(row(page, 'beta')).toBeVisible();
  });

  test('shows a plain line per repository, with no tree, filter or cards', async ({ page }) => {
    await page.route('**/api/workspace/alpha/repositories', (route) => route.fulfill({ json: { repositories: [repository('repo', false)] } }));
    await page.goto('/#/workspaces/alpha');
    await sidebar(page).getByRole('button', { name: 'Show repositories and branches for alpha' }).click();
    const list = sidebar(page).getByRole('list', { name: 'Repositories' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('repo');
    await expect(list).toContainText('main');
    await expect(sidebar(page).getByPlaceholder('Filter worktrees...')).toHaveCount(0);
    await expect(sidebar(page).getByText('HOST: RO')).toHaveCount(0);
  });

  test('has no dot, and no preparation to offer, when every repository is already editable', async ({ page }) => {
    await page.route('**/api/workspace/alpha/repositories', (route) => route.fulfill({ json: { repositories: [repository('repo', false)] } }));
    await page.goto('/#/workspaces/alpha');
    const toggle = sidebar(page).getByRole('button', { name: 'Show repositories and branches for alpha' });
    await expect(toggle).not.toHaveAttribute('title', /needs preparing/);
    await toggle.click();
    await expect(sidebar(page).getByRole('button', { name: /Prepare .* for editing/ })).toHaveCount(0);
  });
});
