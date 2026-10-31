import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planFile } from './planData';

/**
 * The primary journey — create → brief → verify → review — completed with the
 * keyboard alone: every step is reached with Tab and activated with Enter,
 * Space or typing, and the focused control shows a visible indicator.
 */

/** Tab presses made so far in the running test, for journeys that promise to be short. */
let tabPresses = 0;

async function tabTo(page: Page, target: Locator, max = 150) {
  for (let presses = 0; presses < max; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
    tabPresses += 1;
  }
  throw new Error(`Not reachable with Tab within ${max} presses: ${target}`);
}

/** The control, or the field wrapper that draws its ring, shows focus. */
async function expectVisibleFocus(target: Locator) {
  const shown = await target.evaluate((element) => [element, element.parentElement].some((node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
  }));
  expect(shown, 'focused control has a visible focus indicator').toBe(true);
}

async function activate(page: Page, target: Locator, key: 'Enter' | 'Space' = 'Enter') {
  await tabTo(page, target);
  await expectVisibleFocus(target);
  await page.keyboard.press(key);
}

test.describe('keyboard-only primary journey', () => {
  // Every step is reached by pressing Tab, often over a hundred times, and each press is a round trip to the page.
  test.describe.configure({ timeout: 90_000 });

  test.use({
    reposData: [{ name: 'api', path: '/dev/api', defaultBranch: 'main' }],
    workspacesData: [{
      id: 'demo', branchName: 'demo', name: 'Invoice speed-up', description: 'Make invoice totals load under a second',
      repos: ['/ws/demo/api'], assistants: [], workspacePath: '/ws/demo', mode: 'worktree', createdAt: '2026-06-01T00:00:00.000Z',
    }],
    workspacesStatusData: { demo: { id: 'demo', branchName: 'demo', changedFiles: 1, dirtyRepos: 1, syncStatus: 'up-to-date', runningServices: 0 } },
  });

  test('create a workspace', async ({ page }) => {
    let payload: Record<string, unknown> | undefined;
    await page.route('**/api/workspace', (route) => {
      payload = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, jobId: 'keyboard-start' } });
    });
    await page.goto('/#/new');
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    // Everything in the main area is a few Tab presses away: the keyboard starts on the repositories, and
    // More options (closed) is one stop, so nothing beyond the task has to be tabbed through.
    tabPresses = 0;
    await activate(page, page.getByRole('checkbox', { name: 'api' }), 'Space');
    await tabTo(page, page.getByLabel('What do you want to do?'));
    await page.keyboard.type('Cache invoice lookups');
    await tabTo(page, page.getByLabel('Workspace name'));
    await page.keyboard.type('Invoice speed-up');
    await activate(page, page.getByRole('button', { name: 'Create workspace' }));
    expect(tabPresses, 'Tab presses from the first stop to Create').toBeLessThanOrEqual(8);

    await expect.poll(() => payload?.name).toBe('Invoice speed-up');
    expect(payload).toMatchObject({ description: 'Cache invoice lookups' });
  });

  test('edit the brief, verify, and review changes', async ({ page }) => {
    let guidance = { version: 1, revision: 0, workType: 'feature', size: 'standard', documents: [],
      assignment: { stage: 'implement', objective: 'Find the bottleneck', expectedOutput: '', stopCondition: '' } };
    let report: unknown = null;
    const lifecycle = { workspaceId: 'demo', flowType: 'feature', revision: 0, updatedAt: '', fleet: [], steps: [] };
    const work = () => ({ guidance, lifecycle, sharedDocuments: [], assignment: '' });
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
    await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle, report } }));
    await page.route('**/api/workspace/demo/work', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        guidance = { ...guidance, ...body, revision: guidance.revision + 1 };
      }
      await route.fulfill({ json: work() });
    });
    await page.route('**/api/workspace/demo/verify', (route) => {
      report = { overallStatus: 'pass', canProgress: true, durationMs: 1500, repos: [{ repoName: 'api', status: 'pass', command: 'npm test', exitCode: 0 }] };
      return route.fulfill({ json: { report } });
    });
    await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [{ repoName: 'api', repoPath: '/ws/demo/api', files: [{ file: 'src/cache.ts', type: 'modified', additions: 4, deletions: 1 }] }] } }));
    await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
    await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({ json: { repositories: [{
      name: 'api', access: 'worktree', editable: true, path: '/ws/demo/api', sourcePath: '/dev/api', branch: 'demo', expectedBranch: 'demo',
      onExpectedBranch: true, baseBranch: 'main', headSha: 'abc1234', dirty: true, changedFiles: [{ code: ' M', path: 'src/cache.ts' }],
      ahead: 0, behind: 0, remoteUrl: 'git@github.com:o/api.git',
    }] } }));
    await page.route('**/api/workspace/demo/progression', (route) => route.fulfill({ json: { ready: true, blockers: [], repos: [{ name: 'api', state: 'passed-dirty', ready: true, detail: 'api passed.' }] } }));
    await page.route('**/api/workspace/demo/finish/last', (route) => route.fulfill({ json: { lastFinish: null } }));
    let commit: Record<string, unknown> | undefined;
    await page.route('**/api/workspace/demo/commit', (route) => {
      commit = route.request().postDataJSON();
      return route.fulfill({ json: { skipped: [], results: [{ repoName: 'api', success: true, committed: true, pushed: false, branch: 'demo', commitHash: 'fff0001', filesChanged: 1, message: 'ok' }] } });
    });

    await page.goto('/#/workspaces/demo/overview');
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    const destinations = page.getByRole('navigation', { name: 'Workspace' });

    // Brief: reach the plan, edit the objective, save.
    await activate(page, destinations.getByRole('link', { name: 'Plan' }));
    await expect(page).toHaveURL(/\/plan$/);
    await activate(page, page.getByRole('button', { name: 'Edit the goal' }));
    const objective = page.getByLabel('Current objective');
    await tabTo(page, objective);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Cache invoice lookups per customer');
    await activate(page, page.getByRole('button', { name: 'Save goal' }));
    await expect.poll(() => guidance.assignment.objective).toBe('Cache invoice lookups per customer');

    // Verify: run verification; the header reports the recorded result.
    await activate(page, page.getByRole('button', { name: 'Run verification', exact: true }));
    await expect(page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) }).getByRole('link', { name: 'Checks passed' })).toBeVisible();

    // Review: open Code, review the commit, commit by keyboard.
    await activate(page, destinations.getByRole('link', { name: /^Code/ }));
    await expect(page).toHaveURL(/\/changes$/);
    await activate(page, page.getByRole('button', { name: 'Review & commit', exact: true }));
    const panel = page.getByRole('region', { name: 'Review commit' });
    await tabTo(page, panel.getByLabel('Commit message'));
    await page.keyboard.type('perf: cache invoice lookups');
    const push = panel.getByRole('checkbox', { name: 'Push after committing' });
    if (await push.isChecked()) await activate(page, push, 'Space');
    await activate(page, panel.getByRole('button', { name: /^Commit( & push)? selected$/ }));
    await expect.poll(() => commit?.message).toBe('perf: cache invoice lookups');
    expect(commit).toMatchObject({ noPush: true, files: { api: ['src/cache.ts'] } });
  });
});
