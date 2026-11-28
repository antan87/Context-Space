import { test, expect } from './fixtures';
import { board, canvasBox, PICTURE, routeCards, routeWork, stepIntoArea, viewAtRest, workspace } from './boardHelpers';
import { boardFile, boardFileCard, boardId, checkpoint, planFile } from './planData';

// DB4b: a picture linked to a plan item by id (a card with `step`, no `area`) sits under that step, in that step's Area.
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

const PIC = 'board-pictures/db4b-linked-shot.png';
const dbPlan = () => ({
  ...planFile({
    title: 'Reports CSV export',
    checkpoints: [
      { ...checkpoint('Reports export to CSV', { steps: [{ key: 's1wrt0', text: 'Write the CSV writer', done: false }] }), key: 'c1csv0' },
      { ...checkpoint('Ship it to customers', { steps: [{ key: 's3dpl0', text: 'Deploy the export to production', done: false }] }), key: 'c2shp0' },
    ],
    steps: [],
  }),
  store: 'database' as const,
  revision: 3,
  dbId: 'a1b2c3d4e5f60718',
});

test('a picture linked to a step by id sits under that step in its Area and opens with its step', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed'));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: dbPlan() }));
  await routeWork(page, []);
  await routeCards(page, boardFile({ cards: [boardFileCard(1, PIC, { title: 'db4b-linked-shot.png', description: undefined, step: 's3dpl0' })] }));
  await page.route('**/api/workspace/demo/documents/file?*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // Not in the first open Area.
  await stepIntoArea(page, /Reports export to CSV/);
  await expect(board(page).locator('#board-area').getByRole('button', { name: 'Open db4b-linked-shot.png' })).toHaveCount(0);
  await board(page).getByRole('button', { name: 'Board ›' }).click();

  // In the Area of its step, under that step.
  await stepIntoArea(page, /Ship it to customers/);
  const pic = board(page).locator('#board-area').getByRole('button', { name: 'Open db4b-linked-shot.png' });
  await expect(pic).toHaveCount(1);
  // Inside the step's own row: directly under its head, not in "Not tied to a step".
  const [head, placed] = await Promise.all([canvasBox(page, 'row:step:s3dpl0'), canvasBox(page, boardId(1))]);
  expect(placed.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
  expect(placed.y - (head.y + head.height)).toBeLessThan(40);
  await expect(board(page).locator('#board-area').getByText('Not tied to a step')).toHaveCount(0);
  await pic.click();
  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.locator('footer')).toContainText('In step: Deploy the export to production');
});
