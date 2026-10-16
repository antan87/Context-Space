import { test, expect } from './fixtures';

const feature = {
  id: 'feature-x',
  branchName: 'feature-x',
  description: 'Test feature workspace',
  repos: ['C:/dev/api-gateway'],
  assistants: [],
  workspacePath: 'C:/ws/feature-x',
  createdAt: '2026-06-01T00:00:00.000Z',
};

test.describe('Redesigned ContextSpace shell', () => {
  test.use({
    configData: {
      exists: true,
      config: { version: '0.2.19', devDir: 'C:/dev', workspacesDir: 'C:/ws', defaultAssistant: 'claude', scanDepth: 2 },
    },
    workspacesData: [feature],
    workspacesStatusData: {
      'feature-x': { id: 'feature-x', branchName: 'feature-x', changedFiles: 3, dirtyRepos: 1, runningServices: 0, syncStatus: 'up-to-date', pendingValidation: false },
    },
  });

  test('says what needs you across the workspaces, then the changes to review and the recent work', async ({ page }) => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const asked: string[] = [];
    await page.route('**/api/needs-you?*', (route) => {
      asked.push(new URL(route.request().url()).searchParams.get('workspaces') ?? '');
      return route.fulfill({ json: { workspaces: [{
        workspaceId: 'feature-x',
        chatQuestion: { message: 'Which branch should I target?', timestamp: minutesAgo(2), harness: 'claude' },
        questions: [{ id: 'Q1', title: 'Should archived reports be exported?', holdsUp: ['CSV export endpoint'], askedBy: 'codex', at: minutesAgo(30) }],
        proposals: [],
        failedChecks: [{ id: 'M2', title: 'CSV export endpoint' }],
        closedByAi: [{ id: 'M1', title: 'Database query for report rows', action: 'done', by: 'claude', at: minutesAgo(90), note: 'Tests pass' }],
      }] } });
    });
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect.poll(() => asked).toContain('feature-x');
    const needs = page.getByRole('region', { name: /^Needs you/ });
    await expect(needs.getByRole('heading')).toHaveText('Needs you 3');
    await expect(needs.getByRole('link', { name: 'Test feature workspace' })).toHaveAttribute('href', '#/workspaces/feature-x/plan');
    const chat = needs.getByRole('link', { name: /Which branch should I target\?/ });
    await expect(chat).toContainText('Claude asked in the chat 2 min ago');
    await expect(chat).toHaveAttribute('href', '#/workspaces/feature-x');
    await expect(needs.getByRole('link', { name: /Should archived reports be exported\?/ })).toContainText('Codex asked 30 min ago · holds up CSV export endpoint');
    await expect(needs.getByRole('link', { name: /CSV export endpoint.*Its check failed/ })).toHaveAttribute('href', '#/workspaces/feature-x/plan');
    await expect(page.getByRole('region', { name: 'Finished by the AI lately' })).toContainText('Claude finished “Database query for report rows”: Tests pass');

    const review = page.getByRole('region', { name: 'Changes to review' });
    await expect(review).toContainText('Test feature workspace3 files · Review diffs');
    await expect(page.getByRole('article')).toHaveCount(1);
    // Not the sidebar again: no totals, no card per workspace with Open workspace, no second place to start a session.
    await expect(page.getByRole('region', { name: 'Overview totals' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Open workspace/ })).toHaveCount(0);
    await expect(page.getByText('Assistant launchers')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/overview-needs-you.png', fullPage: true });
    await review.getByRole('link', { name: /Test feature workspace/ }).click();
    await expect(page).toHaveURL(/#\/workspaces\/feature-x\/changes/);
  });

  test('says so when nothing needs you, and offers another try when it cannot be read', async ({ page }) => {
    let fail = true;
    await page.route('**/api/needs-you?*', (route) => fail ? route.fulfill({ status: 500, json: { error: 'boom' } }) : route.fulfill({ json: { workspaces: [] } }));
    await page.goto('/');
    const needs = page.getByRole('region', { name: /^Needs you/ });
    await expect(needs.getByRole('alert')).toContainText('Could not read what needs you.', { timeout: 15_000 });
    fail = false;
    await needs.getByRole('button', { name: 'Try again' }).click();
    await expect(needs).toContainText('Nothing needs you right now.');
  });

  test('navigates to the workspaces master-detail and opens a workspace via deep link', async ({ page }) => {
    // Sidebar navigation updates the route.
    await page.goto('/');
    await page.getByRole('link', { name: /feature-x/ }).first().click();
    await expect(page).toHaveURL(/#\/workspaces\/feature-x/);
    await expect(page.getByRole('heading', { name: 'feature-x' })).toBeVisible();

    // Deep link selects a workspace and shows the detail tabs.
    await page.goto('/#/workspaces/feature-x/overview');
    await expect(page.getByRole('heading', { name: 'feature-x' })).toBeVisible();
    await expect(page.getByText('Test feature workspace', { exact: true }).first()).toBeVisible();
    // The overview keeps its address; the rail beside it opens the other parts.
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Plan' }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('Overview diffs', () => {
  test.use({
    workspacesData: [[feature, {
      ...feature,
      id: 'feature-clean', branchName: 'feature-clean', description: 'Clean workspace',
      repos: ['C:/dev/website'], workspacePath: 'C:/ws/feature-clean',
    }], { scope: 'test' }],
    workspacesStatusData: {
      'feature-x': { id: 'feature-x', branchName: 'feature-x', changedFiles: 3, dirtyRepos: 1, runningServices: 0, syncStatus: 'up-to-date', pendingValidation: false },
      'feature-clean': { id: 'feature-clean', branchName: 'feature-clean', changedFiles: 0, dirtyRepos: 0, runningServices: 0, syncStatus: 'up-to-date', pendingValidation: false },
    },
  });

  test('lists only the workspaces with changes to review, and opens their changes', async ({ page }) => {
    await page.goto('/');
    const review = page.getByRole('region', { name: 'Changes to review' });
    await expect(review.getByRole('listitem')).toHaveCount(1);
    await expect(review).not.toContainText('Clean workspace');
    await expect(page.getByRole('article')).toHaveCount(2);
    await review.getByRole('link', { name: /Test feature workspace/ }).click();
    await expect(page).toHaveURL(/#\/workspaces\/feature-x\/changes/);
  });
});

test.describe('Many workspaces', () => {
  const workspaces = Array.from({ length: 33 }, (_, index) => ({
    ...feature,
    id: `feature-${index}`,
    branchName: `feature-${index}`,
    description: `Workspace ${index}`,
    workspacePath: `C:/ws/feature-${index}`,
    createdAt: new Date(Date.UTC(2026, 5, 33 - index)).toISOString(),
  }));
  test.use({
    workspacesData: [workspaces, { scope: 'test' }],
    workspacesStatusData: Object.fromEntries(workspaces.map((ws, index) => [ws.branchName, {
      id: ws.id, branchName: ws.branchName, changedFiles: index === 32 ? 7 : 0,
      dirtyRepos: index === 32 ? 1 : 0, runningServices: 0,
      syncStatus: 'up-to-date', pendingValidation: false,
    }])),
  });

  test('loads status in pages, lists the few recent workspaces, and leaves the rest to the sidebar', async ({ page }) => {
    const offsets: number[] = [];
    let releaseSecondPage = () => {};
    const secondPageHeld = new Promise<void>((resolve) => { releaseSecondPage = resolve; });
    await page.route('**/api/workspaces/status?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('offset') === '24') await secondPageHeld;
      await route.fallback();
    });
    page.on('request', (request) => {
      if (request.url().includes('/api/workspaces/status?')) {
        offsets.push(Number(new URL(request.url()).searchParams.get('offset')));
      }
    });
    await page.goto('/');
    const review = page.getByRole('region', { name: 'Changes to review' });
    await expect(page.getByRole('article')).toHaveCount(6);
    await expect(page.getByText('The other 27 workspaces are in the sidebar.')).toBeVisible();
    await expect(review).toContainText('Checking 24 of 33 workspaces');
    releaseSecondPage();
    await expect(review).toContainText('Workspace 327 files · Review diffs');
    expect(offsets).toContain(0);
    expect(offsets).toContain(24);
  });
});

test.describe('Narrow-screen navigation', () => {
  test.use({ viewport: { width: 390, height: 844 }, workspacesData: [feature] });

  test('opens, restores keyboard focus, and closes after selecting a workspace', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /^Needs you/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
    await trigger.click();
    const navigation = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await expect(navigation).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(navigation).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await navigation.getByRole('link', { name: /feature-x/ }).click();
    await expect(page).toHaveURL(/#\/workspaces\/feature-x/);
    await expect(navigation).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'feature-x' })).toBeVisible();
    const main = await page.getByRole('main').boundingBox();
    expect(main?.width).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // Every destination and section stays reachable by keyboard without growing the page.
    const skills = page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: /^Skills/ });
    await skills.focus();
    await page.keyboard.press('Enter');
    await expect(skills).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
