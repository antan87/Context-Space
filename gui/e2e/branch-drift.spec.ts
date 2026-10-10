import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

test.use({
  workspacesData: [{
    id: 'demo', branchName: 'demo', name: 'Invoice speed-up', description: 'Make invoice totals load under a second', repos: ['/ws/demo/api'],
    originalRepos: ['/dev/api'], assistants: [], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z',
  }],
  workspacesStatusData: { demo: { id: 'demo', branchName: 'demo', changedFiles: 0, dirtyRepos: 0, syncStatus: 'up-to-date', runningServices: 0 } },
});

/** A live repository as the server reports it. */
const repo = (over: Record<string, unknown> = {}) => ({
  name: 'api', access: 'worktree', editable: true, path: '/ws/demo/api', sourcePath: '/dev/api',
  branch: 'feature_a', expectedBranch: 'feature_a', onExpectedBranch: true, baseBranch: 'main',
  headSha: 'abc1234', dirty: false, changedFiles: [], ahead: 0, behind: 0, remoteUrl: null, ...over,
});
const switched = (branch: string | null = 'feature_b') => repo({ branch, onExpectedBranch: false });

async function openWorkspace(page: Page, initial: unknown[]) {
  const state = { repositories: initial };
  const lifecycle = { workspaceId: 'demo', flowType: 'feature', revision: 0, updatedAt: '', fleet: [], steps: [] };
  const guidance = { version: 1, revision: 0, workType: 'feature', size: 'standard', documents: [],
    assignment: { stage: 'implement', objective: 'Find the bottleneck', expectedOutput: '', stopCondition: '' } };
  await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({ json: { repositories: state.repositories } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: { content: '# Plan' } }));
  await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle, report: { overallStatus: 'pass', canProgress: true, durationMs: 1000, repos: [] } } }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance, lifecycle, sharedDocuments: [], assignment: '' } }));
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.goto('/#/workspaces/demo/overview');
  await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
  return state;
}

const notice = (page: Page) => page.getByRole('status', { name: 'Branch' });

test.describe('Branch changed notice', () => {
  test('says which folder is on which branch, and how to switch back', async ({ page }) => {
    await openWorkspace(page, [switched('feature_b')]);

    await expect(notice(page)).toContainText('Branch changed.');
    await expect(notice(page)).toContainText('api is on branch feature_b, but this workspace edits on feature_a.');
    await expect(notice(page)).toContainText('The files you see there belong to feature_b.');
    await expect(notice(page).getByRole('button', { name: 'Copy command: git -C "/ws/demo/api" switch feature_a' })).toBeVisible();
  });

  test('says so plainly for a detached HEAD', async ({ page }) => {
    await openWorkspace(page, [switched(null)]);

    await expect(notice(page)).toContainText('api is on a detached HEAD, but this workspace edits on feature_a.');
    await expect(notice(page)).toContainText('not on any branch');
  });

  test('shows nothing when the folder is on the right branch', async ({ page }) => {
    await openWorkspace(page, [repo()]);

    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });

  test('does not flag a read-only reference, which is not edited here', async ({ page }) => {
    await openWorkspace(page, [repo({ editable: false, access: 'reference', branch: 'develop', onExpectedBranch: false })]);

    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });

  test('copies the command and sends nothing: the app never switches branches itself', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const writes: string[] = [];
    page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${request.url()}`); });
    await openWorkspace(page, [switched()]);
    await expect(notice(page)).toBeVisible();
    writes.length = 0;

    await notice(page).getByRole('button', { name: /^Copy command:/ }).click();

    await expect(notice(page).getByRole('button', { name: /^Copied:/ })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('git -C "/ws/demo/api" switch feature_a');
    expect(writes).toEqual([]);
  });

  test('can be dismissed and stays dismissed after a reload, but a different branch is flagged again', async ({ page }) => {
    const state = await openWorkspace(page, [switched('feature_b')]);
    await notice(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice(page)).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);

    state.repositories = [switched('feature_c')];
    await page.reload();
    await expect(notice(page)).toContainText('api is on branch feature_c');
  });

  test('clears by itself soon after the folder is switched back', async ({ page }) => {
    await page.clock.install();
    const state = await openWorkspace(page, [switched()]);
    await expect(notice(page)).toBeVisible();

    state.repositories = [repo()];
    await page.clock.fastForward(31_000);

    await expect(notice(page)).toHaveCount(0);
  });

  test('shows nothing, and breaks nothing, when the repositories cannot be read', async ({ page }) => {
    await openWorkspace(page, [switched()]);
    await page.unroute('**/api/workspace/demo/repositories');
    await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));
    await page.reload();

    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });
});

test.describe('Branch changed in the sidebar', () => {
  test('marks the repositories button and names what the workspace edits on', async ({ page }) => {
    await openWorkspace(page, [switched('feature_b')]);

    const toggle = page.getByRole('button', { name: /repositories and branches for demo \(a branch has changed\)/ });
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(page.getByTestId('off-branch-api')).toContainText('workspace edits on feature_a');
    await expect(page.getByRole('list', { name: 'Repositories' })).toContainText('feature_b');
  });

  test('leaves the button and list unmarked when the folder is on the right branch', async ({ page }) => {
    await openWorkspace(page, [repo()]);

    const toggle = page.getByRole('button', { name: /repositories and branches for demo$/ });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('list', { name: 'Repositories' })).toContainText('feature_a');
    await expect(page.getByTestId('off-branch-api')).toHaveCount(0);
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the notice meets the automated accessibility rules', async ({ page }) => {
      await openWorkspace(page, [switched()]);
      await expect(notice(page)).toBeVisible();
      // Measure settled colours, not a fade caught half-way.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .include('[aria-label="Branch"]')
        .analyze();

      const serious = results.violations
        .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.html.slice(0, 100)).join(' | ')}`);
      expect(serious, `${colorScheme}: ${serious.join('\n')}`).toEqual([]);
    });
  });
}
