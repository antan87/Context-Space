import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { checkpoint, decision, planFile, step, whatsNew } from './planData';
import type { WorkDocument } from '../src/types.ts';

/**
 * The Board: the workspace's plan, documents and commits on a canvas you can pan and zoom. Read-only: each part is
 * drawn from what the Plan, Docs and "Since you last looked" already read, and a part that fails does not hide the rest.
 */
const workspace = { id: 'demo', branchName: 'demo', name: 'Reports CSV export', description: 'Add CSV export to reports', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1440, height: 900 } });

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const document = (title: string, fields: Partial<WorkDocument> = {}): WorkDocument => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title, role: 'design', status: 'approved', scope: {}, summary: `About ${title}.`,
  createdAt: minutesAgo(5000), updatedAt: minutesAgo(3000), ...fields,
});

async function routeWork(page: Page, documents: WorkDocument[]) {
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: {
    guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents },
    lifecycle: null, assignment: '', sharedDocuments: [],
  } }));
}

async function routeBoard(page: Page) {
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({
    title: 'Reports CSV export',
    checkpoints: [
      checkpoint('Report rows load fast', { done: true, steps: [step('Query the report rows', true)] }),
      checkpoint('Reports export to CSV', {
        steps: [step('Write the CSV writer', true), step('Background job queue for large exports'), step('Download link in the report page')],
        decisions: [decision('Which time zone should export timestamps use?')],
      }),
    ],
    steps: [step('Tidy the old export script')],
    sections: [{ heading: 'Notes', body: 'Excel export comes after feedback on CSV.' }],
  }) }));
  await routeWork(page, [
    document('Export requirements', { role: 'requirements', summary: 'Customers export their reports as CSV, up to 50,000 rows.' }),
    document('First export design', { status: 'superseded', summary: 'Replaced by the queue design.' }),
  ]);
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [
    { repo: 'billing api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the CSV writer', at: minutesAgo(30) }] },
  ] }) }));
}

const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });

test.describe('Board', () => {
  test('opens from the rail, right after Plan, on its own address', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/plan');
    await expect(workspaceNav(page).getByRole('link')).toHaveText(['Overview', 'Plan', 'Board', 'Sessions', 'Code', 'Docs', 'Skills', 'Services']);
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    await expect(workspaceNav(page).getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
    await expect(board(page).getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
  });

  test('draws a frame per checkpoint, the documents and the commits of each repository', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);

    const frame = canvas.getByRole('article', { name: 'Reports export to CSV' });
    await expect(frame).toBeVisible();
    await expect(frame).toContainText('Not done');
    await expect(frame).toContainText('1 of 3 steps');
    await expect(frame.getByRole('listitem').filter({ hasText: 'Write the CSV writer' })).toContainText('Done:');
    await expect(frame.getByRole('listitem').filter({ hasText: 'Background job queue for large exports' })).toContainText('Not done:');
    // The decision that waits for the user is marked.
    await expect(frame).toContainText('Waits for you');
    await expect(frame.getByRole('list', { name: 'Decisions waiting for you' })).toContainText('Which time zone should export timestamps use?');
    const finished = canvas.getByRole('article', { name: 'Report rows load fast' });
    await expect(finished).toContainText('Done');
    await expect(finished).not.toContainText('Waits for you');

    // The plan's own step sits in a frame of its own, ahead of the checkpoints.
    const own = canvas.getByRole('article', { name: 'Plan', exact: true });
    await expect(own).toContainText('Tidy the old export script');
    await expect(own).not.toContainText('Done');
    // In plan order, left to right.
    const [first, second] = await Promise.all([finished.boundingBox(), frame.boundingBox()]);
    expect(first!.x).toBeLessThan(second!.x);
    expect((await own.boundingBox())!.x).toBeLessThan(first!.x);

    const card = canvas.getByRole('article', { name: 'Export requirements' });
    await expect(card).toContainText('Requirements');
    await expect(card).toContainText('Approved');
    await expect(card).toContainText('Customers export their reports as CSV');
    // A superseded document recedes but still says what it is.
    const old = canvas.getByRole('article', { name: 'First export design' });
    await expect(old).toContainText('Superseded');

    // The documents are on the left, the commits on the right.
    const commit = canvas.getByRole('article', { name: 'a91f2e0' });
    await expect(commit).toContainText('Write the CSV writer');
    await expect(commit).toContainText('Anna');
    await expect(commit).toContainText('30 min ago');
    await expect(canvas.getByRole('heading', { name: 'billing api' })).toBeVisible();
    await expect(canvas.getByText('New since you last looked')).toBeVisible();
    const [documentBox, commitBox] = await Promise.all([card.boundingBox(), commit.boundingBox()]);
    expect(documentBox!.x).toBeLessThan((await own.boundingBox())!.x);
    expect(commitBox!.x).toBeGreaterThan(second!.x);
  });

  test('opens fitted to the content, with zoom controls and a minimap', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeInViewport();
    await expect(canvas.getByRole('article', { name: 'Export requirements' })).toBeInViewport();
    await expect(canvas.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Zoom out' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Fit the board in view' })).toBeVisible();
    await expect(canvas.getByRole('img', { name: 'Board overview' })).toBeVisible();
  });

  test('zooms and pans with the controls and the keyboard, and fits again on request', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    const viewport = canvas.locator('.react-flow__viewport');
    const transform = () => viewport.evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, scale: matrix.a };
    });
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeInViewport();
    const fitted = await transform();

    await canvas.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(async () => (await transform()).scale).toBeGreaterThan(fitted.scale);
    await canvas.getByRole('button', { name: 'Fit the board in view' }).click();
    await expect.poll(async () => Math.abs((await transform()).scale - fitted.scale)).toBeLessThan(0.01);

    // The canvas is one keyboard stop: arrows pan, plus and minus zoom.
    await canvas.getByRole('application').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await transform()).x).toBeGreaterThan(fitted.x);
    await page.keyboard.press('-');
    await expect.poll(async () => (await transform()).scale).toBeLessThan(fitted.scale);
  });

  test('does not let the cards be dragged: dragging on one pans the whole board', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    const card = board(page).getByRole('article', { name: 'Export requirements' });
    const lane = board(page).getByRole('heading', { name: 'Documents' });
    await expect(card).toBeInViewport();
    const [cardBefore, laneBefore] = await Promise.all([card.boundingBox(), lane.boundingBox()]);
    const from = { x: cardBefore!.x + cardBefore!.width / 2, y: cardBefore!.y + cardBefore!.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 40, { steps: 5 });
    await page.mouse.up();
    // The card did move on screen, with the board, and it kept its place among the rest.
    await expect.poll(async () => (await card.boundingBox())!.x).toBeGreaterThan(cardBefore!.x + 30);
    const [cardAfter, laneAfter] = await Promise.all([card.boundingBox(), lane.boundingBox()]);
    expect(cardAfter!.x - laneAfter!.x).toBeCloseTo(cardBefore!.x - laneBefore!.x, 0);
    expect(cardAfter!.y - laneAfter!.y).toBeCloseTo(cardBefore!.y - laneBefore!.y, 0);
  });

  test('says there are no new commits, in one card, when there are none', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [] }] }) }));
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByText('No new commits since you last looked.')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Commits', exact: true })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toHaveCount(0);
  });

  test('fits again, without being rebuilt, when a part arrives after the board opened', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the CSV writer', at: minutesAgo(30) }] }] }) });
    });
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
    await expect(canvas.getByRole('status')).toContainText('Still loading: commits');
    // The canvas drawn for the first parts is the one that stays: its controls are marked now and must still be marked later.
    await canvas.locator('.react-flow__controls').evaluate((element) => { (element as HTMLElement & { marked?: boolean }).marked = true; });
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeInViewport();
    await expect(canvas.getByRole('article', { name: 'Export requirements' })).toBeInViewport();
    expect(await canvas.locator('.react-flow__controls').evaluate((element) => (element as HTMLElement & { marked?: boolean }).marked)).toBe(true);
  });

  test('does not take the Space key from the other sections', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await expect(board(page).getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
    // The board stays mounted behind the other sections, so whatever it listens for on the window is still listening.
    await workspaceNav(page).getByRole('link', { name: 'Plan' }).click();
    const notes = page.getByRole('region', { name: 'The plan' }).locator('details').filter({ hasText: 'Notes' });
    await expect(notes).toBeVisible();
    await expect(notes).not.toHaveAttribute('open', '');
    await notes.locator('summary').focus();
    await page.keyboard.press('Space');
    await expect(notes).toHaveAttribute('open', '');
  });

  test('says there is nothing to show when the workspace has no plan, documents or commits', async ({ page }) => {
    await page.goto('/#/workspaces/demo/board');
    await expect(board(page).getByText('Nothing on the board yet: the plan, documents and commits of this workspace appear here.')).toBeVisible();
    await expect(board(page).getByRole('application')).toHaveCount(0);
  });

  test('names a part it could not read and still draws the others', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ status: 500, json: { error: 'git is not available' } }));
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    // A failed read is tried again a few times before it is called a failure.
    await expect(canvas.getByRole('alert')).toContainText('The commits could not be read', { timeout: 20_000 });
    await expect(canvas.getByRole('alert')).toHaveCount(1);
    await expect(canvas.getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'Export requirements' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toHaveCount(0);
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('has no serious accessibility violations, with every kind of card on screen', async ({ page }) => {
      await routeBoard(page);
      await routeWork(page, [
        document('Export requirements', { role: 'requirements', summary: 'Customers export their reports as CSV, up to 50,000 rows.' }),
        document('Draft notes', { role: 'reference', status: 'draft', summary: 'Rough notes.' }),
        document('First export design', { status: 'superseded', summary: 'Replaced by the queue design.' }),
      ]);
      await page.goto('/#/workspaces/demo/board');
      await expect(board(page).getByRole('article', { name: 'Draft notes' })).toBeVisible();
      await expect(board(page).getByRole('article', { name: 'a91f2e0' })).toBeVisible();
      // Settled colours only: a transition caught half-way reports a contrast no one sees.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      const results = await new AxeBuilder({ page }).include('[aria-label="Board"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.html.slice(0, 100)}`).join(' | ')}`);
      expect(serious, serious.join('\n')).toEqual([]);
    });
  });
}
