import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { checkpoint, planFile, step } from './planData';

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
  await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle, report: { overallStatus: 'pass', canProgress: true, durationMs: 1200, repos: [] } } }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance, lifecycle, sharedDocuments: [], assignment: '' } }));
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ checkpoints: [
    checkpoint('Measure baseline', { done: true }),
    checkpoint('Cache invoice lookups', { steps: [step('Cache the totals', true), step('Expire them on change')] }),
    checkpoint('Report the speed-up'),
  ] }) }));
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
  // One chip: Now is the first checkpoint still open, and it goes to the plan. Next, the place, the changes and the checks move one press away.
  await expect(status).toContainText('Now Cache invoice lookups');
  await expect(status).not.toContainText('Next');
  await expect(status).not.toContainText('3 files');
  await expect(header.getByRole('link', { name: 'Checks passed' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Checks passed' })).toHaveAttribute('href', /#?\/workspaces\/demo\/plan$/);
  await header.getByRole('button', { name: 'Workspace actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Next\s*Report the speed-up/ })).toBeVisible();
  await expect(page.getByRole('menu')).toContainText('Worktree · 2 repositories');
  await expect(page.getByRole('menuitem', { name: /Changes\s*3 files/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy AI Context' })).toBeVisible();
  await page.keyboard.press('Escape');
  // One line, not two rows of chips: it leaves the board and the panes their room.
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48);
  // The workspace is named once; the old cockpit strip and stage switcher are gone.
  await expect(page.getByRole('heading', { name: 'Invoice speed-up' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Diff Review' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Process DAG' })).toHaveCount(0);

  // The rail beside the panel: what can open beside the chat, with the changed files counted.
  await expect(workspaceNav(page).getByRole('link')).toHaveText([
    'Overview',
    'Plan',
    'Board',
    'Sessions',
    /^Code3$/,
    'Docs',
    'Skills',
    'Services',
  ]);
  await header.getByRole('button', { name: 'Workspace actions' }).click();
  await page.getByRole('menuitem', { name: /Changes/ }).click();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/changes$/);
  await expect(workspaceNav(page).getByRole('link', { name: /^Code/ })).toHaveAttribute('aria-current', 'page');
});

test('old section links still open, each marked on the rail when it has a place there, and back navigation works', async ({ page }) => {
  await mockWorkspace(page);
  for (const [section, item] of [
    ['documents', 'Docs'],
    ['services', 'Services'],
    ['plan', 'Plan'],
    ['board', 'Board'],
    ['changes', 'Code'],
    ['overview', 'Overview'],
    ['skills', 'Skills'],
  ] as const) {
    await page.goto(`/#/workspaces/demo/${section}`);
    await expect(workspaceNav(page).getByRole('link', { name: new RegExp(`^${item}`) })).toHaveAttribute('aria-current', 'page');
  }
  // Knowledge keeps its address and opens, but has no link on the rail.
  await page.goto('/#/workspaces/demo/knowledge');
  await expect(page.getByRole('region', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(workspaceNav(page).locator('[aria-current="page"]')).toHaveCount(0);
  await page.goto('/#/workspaces/demo/sessions');
  await expect(page.getByRole('region', { name: 'Session history', exact: true })).toBeVisible();
  await expect(workspaceNav(page).getByRole('link', { name: /^Sessions/ })).toHaveAttribute('aria-current', 'page');
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

test('the header is one 48 px line at laptop size, and the moved items are reached by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkspace(page);
  await page.goto('/#/workspaces/demo/overview');
  const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1, name: 'Invoice speed-up' }) });
  await expect(header).toBeVisible();
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48);
  // Now goes to the plan, opened with Enter on the focused chip.
  await header.getByRole('link', { name: /^Now/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/workspaces\/demo\/plan$/);
  // Next and Changes are in the menu, each reached with the keyboard.
  for (const [item, url] of [[/Next/, /plan$/], [/Changes\s*3 files/, /changes$/]] as const) {
    await page.goto('/#/workspaces/demo/overview');
    await header.getByRole('button', { name: 'Workspace actions' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
    await page.getByRole('menuitem', { name: item }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(url);
  }
});

test('the menu has Next beside the chat too, where the header is compact', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 62 })));
  await mockWorkspace(page);
  await page.goto('/#/workspaces/demo/documents');
  const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1, name: 'Invoice speed-up' }) });
  await header.getByRole('button', { name: 'Workspace actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Next\s*Report the speed-up/ })).toBeVisible();
});

test.describe('a long name, where the Now chip reaches its limit', () => {
  const longName = 'Investigate why the nightly pipeline fails on Windows runner';
  test.use({
    workspacesData: [{
      id: 'demo', branchName: 'demo', name: longName, description: '', repos: ['/dev/api', '/dev/web'],
      assistants: [], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z',
    }],
  });

  test('the Now chip and the menu item always agree, across the width where the chip goes, with a larger root font', async ({ page }) => {
    await mockWorkspace(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/workspaces/demo/overview');
    const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1, name: longName }) });
    await expect(header).toBeVisible();
    await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
    const slotWidth = () => page.evaluate(() => (document.querySelector('header [aria-label="Task status"]') as HTMLElement | null)?.getBoundingClientRect().width ?? -1);
    const seen = new Set<boolean>();
    for (let width = 1280; width >= 1100; width -= 8) {
      await page.setViewportSize({ width, height: 800 });
      // Settle: the slot has the same width on two reads in a row.
      let last = -2;
      await expect.poll(async () => { const now = await slotWidth(); const stable = now === last; last = now; return stable; }, { intervals: [60] }).toBe(true);
      const chip = await header.getByRole('link', { name: /^Now/ }).isVisible();
      seen.add(chip);
      await header.getByRole('button', { name: 'Workspace actions' }).click();
      await expect(page.getByRole('menuitem', { name: /^Changes/ })).toBeVisible();
      const item = await page.getByRole('menuitem', { name: /^Now ·/ }).count();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      expect.soft(item, `at ${width} px the chip is ${chip ? 'shown' : 'hidden'} and the menu item count is ${item}`).toBe(chip ? 0 : 1);
    }
    // The sweep must cross the limit, or it proves nothing.
    expect([...seen].sort()).toEqual([false, true]);
  });
});

test('warnings are named on the menu button for a screen reader', async ({ page }) => {
  await mockWorkspace(page);
  const summary = 'Notes exist only on this computer.';
  await page.route('**/api/workspace/demo/backup', (route) => route.fulfill({ json: { backup: {
    remote: { state: 'none' }, handWritten: { knowledgeEntries: 1, planningNotes: true }, atRisk: true, summary, message: summary,
  } } }));
  await page.goto('/#/workspaces/demo/overview');
  await expect(page.getByRole('button', { name: 'Workspace actions, 1 warning' })).toBeVisible();
});

test.describe('a long name and a long branch', () => {
  const name = 'Speed up the invoice totals page and cache every customer lookup';
  const branch = 'feature/invoice-speed-up-with-per-customer-cache-and-expiry';
  test.use({
    workspacesData: [{
      id: 'demo', branchName: branch, name, description: '', repos: ['/dev/api'],
      assistants: [], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z',
    }],
    workspacesStatusData: { [branch]: { id: branch, branchName: branch, changedFiles: 1, dirtyRepos: 1, syncStatus: 'up-to-date', runningServices: 0 } },
  });
  async function open(page: Page) {
    await page.route(`**/api/workspace/${encodeURIComponent(branch)}/**`, (route) => route.fulfill({ json: {} }));
    await page.goto(`/#/workspaces/${encodeURIComponent(branch)}/overview`);
  }

  test('keeps the title readable at 1100 px and the branch from shrinking to a sliver', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await mockWorkspace(page);
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planFile({ checkpoints: [
      checkpoint('Cache invoice lookups per customer with an expiry'),
    ] }) }));
    await open(page);
    const title = page.getByRole('heading', { level: 1, name });
    await expect(title).toBeVisible();
    const copy = page.getByRole('button', { name: /Copy branch name/ });
    await expect(copy).toBeVisible();
    expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(240);
    expect((await copy.boundingBox())!.width).toBeGreaterThanOrEqual(50);
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/header-1100.png` : 'test-results/header-1100.png' });
  });

  test('a long title ends in an ellipsis, never cut mid-letter, and the chip gives way to a Now item in the menu', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 700 });
    await page.route(`**/api/workspace/${encodeURIComponent(branch)}/**`, (route) => route.fulfill({ json: {} }));
    await page.route(`**/api/workspace/${encodeURIComponent(branch)}/plan`, (route) => route.fulfill({ json: planFile({ checkpoints: [
      checkpoint('Cache invoice lookups per customer with an expiry'),
    ] }) }));
    await page.goto(`/#/workspaces/${encodeURIComponent(branch)}/overview`);
    const title = page.getByRole('heading', { level: 1, name });
    await expect(title).toBeVisible();
    const style = await title.evaluate((el) => ({ overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth }));
    expect(style).toEqual({ overflow: 'ellipsis', clipped: true });
    // 16 characters stay readable.
    expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(120);
    // The chip is gone rather than a sliver; Now is one press away in the menu.
    const header = page.locator('header').filter({ has: title });
    await expect(header.getByRole('link', { name: /^Now/ })).toBeHidden();
    await header.getByRole('button', { name: 'Workspace actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Now ·\s*Cache invoice lookups/ })).toBeVisible();
    // The place is a menu item, so arrowing through the menu reads it.
    await expect(page.getByRole('menuitem', { name: 'Worktree · 1 repository' })).toHaveAttribute('aria-disabled', 'true');
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/header-820.png` : 'test-results/header-820.png' });
  });

  test('a long title on a phone leaves the menu button on screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    const title = page.getByRole('heading', { level: 1, name });
    await expect(title).toBeVisible();
    const menu = (await page.getByRole('button', { name: /Workspace actions/ }).boundingBox())!;
    expect(menu.x + menu.width).toBeLessThanOrEqual(390);
    const t = (await title.boundingBox())!;
    expect(t.x + t.width).toBeLessThanOrEqual(menu.x);
    expect(t.width).toBeGreaterThanOrEqual(200);
  });

  test('on a phone a short real name shows untruncated, with room to spare', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: [{ id: 'demo', branchName: branch, name: 'New canvas interaction', description: '', repos: ['/dev/api'], assistants: [], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z' }] }));
    await open(page);
    const title = page.getByRole('heading', { level: 1, name: 'New canvas interaction' });
    await expect(title).toBeVisible();
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test('a phone copies the branch name from the menu', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByRole('button', { name: /Copy branch name/ })).toBeHidden();
    await page.getByRole('button', { name: 'Workspace actions' }).click();
    await page.getByRole('menuitem', { name: 'Copy branch name' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(branch);
  });
});

const gapBranch = 'feature/new-canvas-interaction';
for (const t of ['Docs', 'Fix issues', 'Chatt with ACP']) {
  test.describe(`title "${t}" next to the branch`, () => {
    test.use({
      workspacesData: [{ id: 'demo', branchName: gapBranch, name: t, description: '', repos: ['/dev/api'], assistants: [], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z' }],
      workspacesStatusData: { [gapBranch]: { id: gapBranch, branchName: gapBranch, changedFiles: 1, dirtyRepos: 1, syncStatus: 'up-to-date', runningServices: 0 } },
    });
    for (const width of [1280, 1100, 820]) {
      test(`leaves a normal gap at ${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.route(`**/api/workspace/${encodeURIComponent(gapBranch)}/**`, (route) => route.fulfill({ json: {} }));
        await page.goto(`/#/workspaces/${encodeURIComponent(gapBranch)}/overview`);
        const title = page.getByRole('heading', { level: 1, name: t });
        await expect(title).toBeVisible();
        const copy = page.getByRole('button', { name: /Copy branch name/ });
        await expect(copy).toBeVisible();
        // From the end of the text, not the box: a stretched box hides its own empty space.
        const textRight = await title.evaluate((h1) => { const r = document.createRange(); r.selectNodeContents(h1); return r.getBoundingClientRect().right; });
        const b = (await copy.boundingBox())!;
        const gap = b.x - textRight;
        expect(gap).toBeGreaterThanOrEqual(8);
        expect(gap).toBeLessThanOrEqual(16);
      });
    }
  });
}
