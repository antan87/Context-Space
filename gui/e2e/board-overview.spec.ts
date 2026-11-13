import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  boardFile,
  boardFileCard,
  boardId,
  boardNote,
  checkpoint,
  decision,
  planFile,
  step,
  whatsNew,
} from "./planData";
import {
  workspace,
  minutesAgo,
  document,
  routeWork,
  routeBoard,
  routeCards,
  routeLateCommits,
  routePictures,
  workspaceNav,
  board,
  stepIntoArea,
  transformOf,
  isWithin,
  viewAtRest,
  reveal,
  frames,
} from "./boardHelpers";

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

test.describe('Board', () => {
  test('opens from the rail, right after Overview, on its own address, with legacy plan aliased', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/overview');
    await expect(workspaceNav(page).getByRole('link')).toHaveText(['Overview', 'Board', 'Sessions', 'Skills']);
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    await expect(workspaceNav(page).getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
    await expect(board(page).locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();

    // Legacy /plan URL opens the board as well
    await page.goto('/#/workspaces/demo/plan');
    await expect(workspaceNav(page).getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
  });

  test('groups work into areas with status badges, step progress and item counts, fitting whole on screen', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');

    // Areas at Level 0
    const planArea = overview.locator('button.board-area').filter({ hasText: 'Plan' });
    const secondAreaNode = overview.locator('.react-flow__node-area').filter({ hasText: 'Reports export to CSV' });
    const secondArea = secondAreaNode.locator('button.board-area');

    await expect(planArea).toBeVisible();
    await expect(planArea).toContainText('Plan');
    await expect(planArea).toHaveAttribute('aria-label', /1 step outside the checkpoints/);
    await expect(planArea).toContainText('Tidy the old export script');

    await expect(secondArea).toBeVisible();
    await expect(secondArea).toContainText('Now');
    await expect(secondArea).toContainText('Waits for you');
    await expect(secondArea).toHaveAttribute('aria-label', /1 of 3 steps/);
    await expect(secondAreaNode).toContainText('Which time zone should export timestamps use?');

    // Finished area is folded into Tier 5 and opens
    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toHaveText('1 done');
    await fold.click();
    const firstArea = overview.locator('button.board-area').filter({ hasText: 'Report rows load fast' });
    await expect(firstArea).toBeVisible();
    await expect(firstArea).toHaveAttribute('aria-label', /done/);
    await expect(firstArea).toContainText('1 of 1');

    // Every Area fits whole inside overview canvas on one screen
    for (const target of [planArea, firstArea, secondAreaNode]) {
      await expect.poll(() => isWithin(target, overview.locator('.react-flow'))).toBe(true);
    }
  });

  test('fits an 8-checkpoint plan whole on screen at Level 0 with no scrolling', async ({ page }) => {
    await routeBoard(page);
    const titles = Array.from({ length: 8 }, (_, i) => `Checkpoint ${i + 1}`);
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Large 8-checkpoint plan',
        checkpoints: titles.map((title, i) => checkpoint(title, { done: i < 3 })),
      }),
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const overview = board(page).locator('#board-overview');
    const flow = overview.locator('.react-flow');

    // Before opening the fold, assert that what is shown is whole on screen with no scrolling
    const shown = overview.locator('button.board-area, button.board-area-fold');
    const count = await shown.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect.poll(() => isWithin(shown.nth(i), flow)).toBe(true);
    }

    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toBeVisible();
    await fold.click();
    await viewAtRest(page);

    for (const title of titles) {
      const btn = overview.locator('button.board-area').filter({ hasText: title });
      await btn.focus();
      await expect.poll(() => isWithin(btn, flow)).toBe(true);
    }
  });

  test('steps into an area on click, Enter or Space: Plane 0 recedes and Plane 1 shows details fitting on screen', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');
    const areaBtn = overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' });

    // Step in via click
    await areaBtn.click();
    const stepped = canvas.locator('#board-area');
    await expect(stepped).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Board ›' })).toBeVisible();
    await expect(canvas.locator('.board-overview-scrim')).toBeVisible();
    await expect(overview).toHaveAttribute('data-receded', 'true');
    await expect(overview).toHaveAttribute('inert', '');

    // Stepped-in details are open and visible
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();
    // The Area's name and steps are said once, in the header above; the waiting frame says what waits, not whose it is
    await expect(frame).toContainText('Waits for you');
    await expect(frame).toContainText('Which time zone should export timestamps use?');
    await expect(frame).not.toContainText('Reports export to CSV');
    await expect(frame).not.toContainText('1 of 3 steps');
    const header = stepped.locator('header').first();
    await expect(header).toContainText('Reports export to CSV');
    await expect(header).toContainText('1 of 3 steps');
    await expect(header).not.toContainText(/wait/i);
    // The open steps are rows, the first one is the current step, and the done step is folded into one line that opens
    await expect(stepped.getByRole('button', { name: /^Now: Background job queue for large exports/ })).toBeVisible();
    await expect(stepped.getByRole('button', { name: /^1 more open step/ })).toBeVisible();
    const done = stepped.getByRole('button', { name: /1 done step/ });
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    await done.click();
    await expect(stepped.getByRole('button', { name: /1 done step/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(stepped.getByText('Write the CSV writer')).toBeVisible();
    await stepped.getByRole('button', { name: /1 done step/ }).click();

    // Documents & commits routed to this area are open
    await expect(stepped.getByRole('article', { name: 'Export requirements' })).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'a91f2e0' })).toBeVisible();

    // Fits whole inside stepped area canvas
    const areaFlow = stepped.locator('.react-flow');
    await expect.poll(() => isWithin(frame, areaFlow)).toBe(true);
    await expect.poll(() => isWithin(stepped.getByRole('article', { name: 'Export requirements' }), areaFlow)).toBe(true);
    await expect.poll(() => isWithin(stepped.getByRole('article', { name: 'a91f2e0' }), areaFlow)).toBe(true);
  });

  test('steps out via Board ›, Escape and clicking the dimmed backdrop, returning focus to the area button', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');
    const areaBtn = overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' });

    // 1. Step in, then step out via "Board ›"
    await areaBtn.click();
    await expect(canvas.getByRole('button', { name: 'Board ›' })).toBeVisible();
    await canvas.getByRole('button', { name: 'Board ›' }).click();
    await expect(canvas.locator('#board-area')).toHaveCount(0);
    await expect(areaBtn).toBeFocused();

    // 2. Step in via keyboard Enter, then step out via Escape
    await areaBtn.focus();
    await page.keyboard.press('Enter');
    await expect(canvas.getByRole('button', { name: 'Board ›' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(canvas.locator('#board-area')).toHaveCount(0);
    await expect(areaBtn).toBeFocused();

    // 3. Step in via keyboard Space, test backdrop dragging does NOT step out, but backdrop click does
    await areaBtn.focus();
    await page.keyboard.press('Space');
    await expect(canvas.getByRole('button', { name: 'Board ›' })).toBeVisible();

    // Dragging from inside onto backdrop does NOT step out
    const frame = canvas.locator('#board-area').getByRole('article', { name: 'Waits for you' });
    const box = (await frame.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(10, 10, { steps: 5 });
    await page.mouse.up();
    await expect(canvas.getByRole('button', { name: 'Board ›' })).toBeVisible();

    // Clicking the dimmed backdrop steps out
    const scrim = canvas.locator('.board-overview-scrim');
    await scrim.click({ position: { x: 10, y: 10 } });
    await expect(canvas.locator('#board-area')).toHaveCount(0);
    await expect(areaBtn).toBeFocused();
  });

  test('draws fallback Current work area when workspace has cards and no plan checkpoints', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({
      json: planFile({ title: 'No checkpoints', checkpoints: [] }),
    }));
    await page.goto('/#/workspaces/demo/board');
    const overview = board(page).locator('#board-overview');
    const workArea = overview.locator('button.board-area').filter({ hasText: 'Current work' });
    await expect(workArea).toBeVisible();
    await expect(workArea).toContainText('Current');

    // Stepping into Current work shows the documents and commits
    await workArea.click();
    const stepped = board(page).locator('#board-area');
    await expect(stepped).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Export requirements' })).toBeVisible();
  });

  test('opens on the checkpoint under way, with a screen-fitted overview and no zoom buttons', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');
    const current = overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect(current).toBeVisible();
    await expect(current).toContainText('Now');
    await expect.poll(() => isWithin(current, overview.locator('.react-flow'))).toBe(true);

    await expect(canvas.getByRole('button', { name: /^Zoom (in|out)$|^Fit the board in view$/ })).toHaveCount(0);
    await expect(canvas.locator('.react-flow__controls')).toHaveCount(0);
  });

  test('opens with all checkpoints done when every checkpoint is done', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Reports CSV export',
        checkpoints: ['Report rows load fast', 'Reports export to CSV', 'Background queue', 'Download link', 'Release notes'].map((title) => checkpoint(title, { done: true })),
      }),
    }));
    await page.goto('/#/workspaces/demo/board');
    const overview = board(page).locator('#board-overview');
    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toHaveText('5 done');
    await fold.click();
    const last = overview.locator('button.board-area').filter({ hasText: 'Release notes' });
    await expect(last).toBeVisible();
    await expect(last).toContainText('Done');
    await expect.poll(() => isWithin(last, overview.locator('.react-flow'))).toBe(true);
  });

  test('pans with the keyboard and puts the board back in view with zero, and does not zoom', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const flow = board(page).locator('#board-overview .react-flow');
    const current = board(page).locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect.poll(() => isWithin(current, flow)).toBe(true);
    const fitted = await transformOf(page);

    await flow.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await transformOf(page)).x).toBeGreaterThan(fitted.x);
    // Plus and minus, the wheel and a double click leave the zoom alone
    await page.keyboard.press('-');
    await page.keyboard.press('+');
    await flow.hover();
    await page.mouse.wheel(0, 400);
    await current.dblclick({ trial: true });
    await frames(page, 8);
    expect((await transformOf(page)).scale).toBeCloseTo(fitted.scale, 3);
    await page.keyboard.press('0');
    await expect.poll(async () => Math.abs((await transformOf(page)).x - fitted.x)).toBeLessThan(1);
    expect((await transformOf(page)).scale).toBeCloseTo(fitted.scale, 3);
  });

  test('says there are no commits in the last days, in one card, when there are none', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [] }] }) }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/, { allowLoading: true });
    const canvas = board(page);
    await expect(canvas.getByText('No commits in the last 3 days.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: /^Commits/ })).toBeVisible();
    await expect(canvas.getByRole('button', { name: /^api/ })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toHaveCount(0);
  });

  test('does not say there are no new commits next to a repository that could not be read', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'gone', more: 0, commits: [], problem: 'The folder is missing.' }] }) }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/, { allowLoading: true });
    const canvas = board(page);
    await expect(canvas.getByRole('button', { name: /^gone/ })).toBeVisible();
    await expect(canvas.getByText('Could not be read: The folder is missing.')).toBeVisible();
    await expect(canvas.getByText(/No commits in/)).toHaveCount(0);

    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'gone', more: 0, commits: [], problem: 'The folder is missing.' }, { repo: 'api', more: 0, commits: [] }] }) }));
    await page.reload();
    await stepIntoArea(page);
    await expect(canvas.getByText('No commits in the other repositories in the last 3 days.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: /^api/ })).toHaveCount(0);
  });

  test('moves to the work again, without being rebuilt, when a part arrives after the board opened', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the CSV writer', at: minutesAgo(30) }] }] }) });
    });
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    const area = canvas.locator('.board-overview-plane .react-flow__node-area').filter({ hasText: 'Reports export to CSV' });
    const areaBtn = area.locator('button.board-area');
    await expect(areaBtn).toBeVisible();
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    await canvas.locator('#board-overview .react-flow').evaluate((element) => { (element as HTMLElement & { marked?: boolean }).marked = true; });
    await expect(area).toContainText('1 commit');
    expect(await canvas.locator('#board-overview .react-flow').evaluate((element) => (element as HTMLElement & { marked?: boolean }).marked)).toBe(true);
  });

  const afterSomeFrames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const tick = () => (++frames >= 6 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));

  test('leaves the view where the user put it when a part arrives after they moved it', async ({ page }) => {
    const release = await routeLateCommits(page);
    const answered = page.waitForResponse('**/api/workspace/demo/news');
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    const area = (await canvas.locator('#board-overview .react-flow').boundingBox())!;
    const before0 = await transformOf(page);
    await page.mouse.move(area.x + 200, area.y + 40);
    await page.mouse.down();
    await page.mouse.move(area.x + 350, area.y + 70, { steps: 5 });
    await page.mouse.up();
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    // The view at rest: the same for several frames in a row, so the drag has settled before it is read.
    let moved = await transformOf(page);
    for (let still = 0; still < 3;) {
      await afterSomeFrames(page);
      const now = await transformOf(page);
      still = JSON.stringify(now) === JSON.stringify(moved) ? still + 1 : 0;
      moved = now;
    }
    // The drag really moved the view by about (150, 30): a snap back before the part arrives cannot hide.
    expect(Math.abs(moved.x - before0.x - 150)).toBeLessThanOrEqual(4);
    expect(Math.abs(moved.y - before0.y - 30)).toBeLessThanOrEqual(4);
    release();
    await answered;
    await afterSomeFrames(page);
    expect(await transformOf(page)).toEqual(moved);
  });

  test('keeps following the work after a press on a card button or the archived toggle, which do not move the view', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    const release = await routeLateCommits(page);
    await routeCards(page, boardFile({ cards: [boardNote(1, { archived: true }), boardNote(2, { title: 'A long note', body })], positions: { [boardId(2)]: { x: 800, y: 240 } } }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/, { allowLoading: true });
    const canvas = board(page);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    await canvas.locator('#board-area').getByRole('button', { name: 'Archived (1)' }).click();
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    await reveal(page, canvas.getByRole('article', { name: 'A long note' }));
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'A long note' }), canvas.locator('#board-area .react-flow'))).toBe(true);
    await canvas.locator('#board-area').getByRole('button', { name: 'Read A long note' }).click();
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toContainText('Line 30 of a long note.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    release();
    await reveal(page, canvas.getByRole('article', { name: 'a91f2e0' }));
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'a91f2e0' }), canvas.locator('#board-area .react-flow'))).toBe(true);
  });

  test('does not take the Space key from the other sections', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await expect(board(page).locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
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
    await expect(board(page).getByText('Nothing on the board yet. The plan, documents and commits of this workspace appear here, and so do the notes and files you and the AI add.')).toBeVisible();
    await expect(board(page).getByRole('application')).toHaveCount(0);
  });

  test('names a part it could not read and still draws the others', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ status: 500, json: { error: 'git is not available' } }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    await expect(canvas.getByRole('alert')).toContainText('The commits could not be read', { timeout: 20_000 });
    await expect(canvas.getByRole('alert')).toHaveCount(1);
    await expect(canvas.locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
  });

  test('names the notes and files when they could not be read, and still draws the rest', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ status: 500, json: { error: 'The board file is not valid JSON.' } }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    await expect(canvas.getByRole('alert')).toContainText('The notes and files could not be read: The board file is not valid JSON.', { timeout: 20_000 });
    await expect(canvas.getByRole('alert')).toHaveCount(1);
    await expect(canvas.locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
  });

  test('does not read a reply that is not a board as an empty one', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: { hello: 'an older backend' } }));
    await page.goto('/#/workspaces/demo/board');
    await expect(board(page).getByRole('alert')).toContainText('The notes and files could not be read: the board came back in a form this version of the app does not read', { timeout: 20_000 });
  });
});

test.describe('Board, areas', () => {
  test('fits 1, 3 and 9 areas whole on screen in 1440x900 and 820x900 viewports', async ({ page }) => {
    await routeBoard(page);
    const viewports = [
      { width: 1440, height: 900 },
      { width: 820, height: 900 },
    ];

    // 1 area (single checkpoint, no loose steps or decisions)
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Single area plan',
        steps: [],
        decisions: [],
        checkpoints: [checkpoint('Only checkpoint', { steps: [step('Step 1')] })],
      }),
    }));
    await page.goto('/#/workspaces/demo/board');
    const overview = board(page).locator('#board-overview');
    const flow = overview.locator('.react-flow');

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await viewAtRest(page);
      const area = overview.locator('button.board-area').filter({ hasText: 'Only checkpoint' });
      await expect(area).toBeVisible();
      await expect.poll(() => isWithin(area, flow)).toBe(true);
    }

    // 3 areas (standard test board: Plan, Report rows load fast, Reports export to CSV)
    await routeBoard(page);
    await page.reload();
    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await viewAtRest(page);
      const fold = overview.locator('button.board-area-fold');
      if (await fold.count() && (await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
      for (const name of ['Plan', 'Report rows load fast', 'Reports export to CSV']) {
        const area = overview.locator('button.board-area').filter({ hasText: name });
        await expect(area).toBeVisible();
        await expect.poll(() => isWithin(area, flow)).toBe(true);
      }
    }

    // 9 areas
    const titles = Array.from({ length: 9 }, (_, i) => `Area Checkpoint ${i + 1}`);
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Nine areas plan',
        steps: [],
        decisions: [],
        checkpoints: titles.map((title, i) => checkpoint(title, { done: i < 4 })),
      }),
    }));
    await page.reload();
    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await viewAtRest(page);
      const fold = overview.locator('button.board-area-fold');
      if (await fold.count() && (await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
      for (const name of titles) {
        const area = overview.locator('button.board-area').filter({ hasText: name });
        await expect(area).toBeVisible();
        await expect.poll(() => isWithin(area, flow)).toBe(true);
      }
    }
  });

  test('steps between multiple areas isolating their steps, documents and cards', async ({ page }) => {
    await routeBoard(page);
    await routeWork(page, [
      document('Export requirements', { role: 'requirements', summary: 'Customers export CSV.' }),
    ]);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Export note', area: 'checkpoint:reports-export-to-csv' }),
        boardNote(2, { title: 'Rows note', area: 'checkpoint:report-rows-load-fast' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');

    // Step into "Reports export to CSV"
    await stepIntoArea(page, 'Reports export to CSV');
    const stepped = canvas.locator('#board-area');
    await expect(stepped).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Waits for you' })).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Export note' })).toBeVisible();
    await expect(stepped.getByRole('heading', { name: 'Report rows load fast' })).toHaveCount(0);
    await expect(stepped.getByRole('article', { name: 'Rows note' })).toHaveCount(0);

    // Step out via back button
    await canvas.getByRole('button', { name: 'Board ›' }).click();
    await expect(canvas.locator('#board-area')).toHaveCount(0);
    await expect(overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();

    // Finished area is in Tier 5 fold and opens
    const fold = overview.locator('button.board-area-fold');
    if (await fold.count()) await fold.click();
    await expect(overview.locator('button.board-area').filter({ hasText: 'Report rows load fast' })).toBeVisible();

    // Step into "Report rows load fast"
    await stepIntoArea(page, 'Report rows load fast');
    await expect(stepped).toBeVisible();
    await expect(stepped.getByRole('heading', { name: 'Report rows load fast' })).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Rows note' })).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Waits for you' })).toHaveCount(0);
    await expect(stepped.getByRole('article', { name: 'Export note' })).toHaveCount(0);
  });

  test('moves the Next up badge as the plan progresses live', async ({ page }) => {
    test.setTimeout(45_000);
    await routeBoard(page);
    const planState = {
      current: planFile({
        title: 'Progressing plan',
        steps: [],
        decisions: [],
        checkpoints: [
          checkpoint('First checkpoint', { done: false, steps: [step('Step 1.1')] }),
          checkpoint('Second checkpoint', { done: false, steps: [step('Step 2.1')] }),
        ],
      }),
    };
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planState.current }));
    await page.goto('/#/workspaces/demo/board');
    const overview = board(page).locator('#board-overview');
    const firstArea = overview.locator('button.board-area').filter({ hasText: 'First checkpoint' });
    const secondArea = overview.locator('button.board-area').filter({ hasText: 'Second checkpoint' });

    await expect(firstArea).toBeVisible();
    await expect(firstArea.locator('.board-area-badge')).toHaveText(/Next up/i);

    // Progress the plan: First checkpoint completes
    planState.current = planFile({
      title: 'Progressing plan',
      steps: [],
      decisions: [],
      checkpoints: [
        checkpoint('First checkpoint', { done: true, steps: [step('Step 1.1', true)] }),
        checkpoint('Second checkpoint', { done: false, steps: [step('Step 2.1')] }),
      ],
    });

    const fold = overview.locator('button.board-area-fold');
    await expect.poll(async () => fold.textContent(), { timeout: 35_000, intervals: [1000, 2000] }).toBe('1 done');
    await expect(secondArea.locator('.board-area-badge')).toHaveText(/Next up/i);
    await fold.click();
    await expect(firstArea).toHaveAttribute('aria-label', /Done/i);
  });

  test('supports prefers-reduced-motion: reduce with instant step-in and step-out', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');
    const stepped = canvas.locator('#board-area');
    const areaBtn = overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' });

    await expect(areaBtn).toBeVisible();
    await areaBtn.click();
    await expect(stepped).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Board ›' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(canvas.locator('#board-area')).toHaveCount(0);
    await expect(overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
  });
});

test.describe('Board, a quiet frame and a readable overview', () => {
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const AREAS = [
    'Board opens on the work under way', 'The plan is the first thing a person reads', 'Commits read as sentences, not hashes', 'Documents open in a reader beside the board',
    'Areas stay readable at every window size', 'Pictures are told apart from files', 'The AI says what it needs from you', 'Notes keep who wrote them',
    'Decisions wait in one place', 'The index finds a card in one click', 'Release notes say what changed',
  ];

  /** `count` Areas as the real board has them: the first `done` finished, the next under way with a decision waiting, notes and pictures on a few. */
  async function routeAreas(page: Page, options: { count?: number; done?: number; titles?: string[]; question?: string; archived?: boolean } = {}) {
    const count = options.count ?? AREAS.length;
    const done = options.done ?? 4;
    const titles = Array.from({ length: count }, (_, i) => options.titles?.[i] ?? AREAS[i] ?? `Slice ${i + 1}: more of the same work`);
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({
      title: 'A board that is quiet',
      now: { key: `second-step-of-${(titles[done] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`, by: 'claude', at: new Date().toISOString() },
      checkpoints: titles.map((title, i) => checkpoint(title, {
        done: i < done,
        steps: [step(`First step of ${title}`, i <= done), step(`Second step of ${title}`, i < done), step(`Third step of ${title}`, i < done)],
        ...(i === done ? { decisions: [decision(options.question ?? 'Which size is the least a person can read?')] } : {}),
      })),
    }) }));
    await routeWork(page, []);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [
      { repo: 'NexusFlow', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Make the overview readable', at: minutesAgo(30) }] },
    ] }) }));
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [
      boardNote(1, { title: 'Why rows', step: undefined, area: `checkpoint:${slug(titles[Math.min(done, count - 1)]!)}` }),
      boardFileCard(2, 'board-pictures/a.png', { title: 'The overview', step: undefined, area: `checkpoint:${slug(titles[Math.min(done, count - 1)]!)}` }),
      boardNote(3, { title: 'Done notes', step: undefined, area: `checkpoint:${slug(titles[0]!)}` }),
      ...(options.archived ? [boardNote(4, { title: 'An old note', step: undefined, archived: true, area: `checkpoint:${slug(titles[Math.min(done, count - 1)]!)}` })] : []),
    ] }));
  }

  /** The chat is hidden by default in these specs: this shows it beside the board, so the board is a pane. */
  const chatBeside = (page: Page) => page.addInitScript(() => { window.localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 62 })); });

  /** What the overview shows, as the person sees it: each Area's place, and each text's size on the screen (its font size times the zoom). */
  const overviewFacts = (page: Page) => board(page).locator('#board-overview').evaluate((overview) => {
    const stage = overview.querySelector('.react-flow')!.getBoundingClientRect();
    const areaButtons = Array.from(overview.querySelectorAll<HTMLElement>('button.board-area'));
    const areas = Array.from(overview.querySelectorAll<HTMLElement>('button.board-area, button.board-area-fold'));
    const sizes: Array<{ text: string; size: number }> = [];
    const titles: number[] = [];
    for (const area of areas) {
      let areaTitleFound = false;
      for (const element of Array.from(area.querySelectorAll<HTMLElement>('*'))) {
        const own = Array.from(element.childNodes).filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent!.trim()).join('');
        if (!own || element.offsetWidth === 0) continue;
        const zoom = element.getBoundingClientRect().width / element.offsetWidth;
        const size = parseFloat(getComputedStyle(element).fontSize) * zoom;
        sizes.push({ text: own, size });
        if (!areaTitleFound && element.hasAttribute('title') && element.getAttribute('title') === own) {
          titles.push(size);
          areaTitleFound = true;
        }
      }
    }
    const boxes = areas.map((area) => { const r = area.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const inside = boxes.every((r) => r.x >= stage.x - 0.5 && r.y >= stage.y - 0.5 && r.x + r.width <= stage.x + stage.width + 0.5 && r.y + r.height <= stage.y + stage.height + 0.5);
    return { count: areaButtons.length, inside, sizes, titles, boxes, rows: overview.querySelectorAll('.react-flow__node-areaRow').length, minis: overview.querySelectorAll('.react-flow__node-areaMini').length, stageWidth: stage.width, cards: overview.querySelectorAll('.react-flow__node-area').length };
  });

  const sizes = [
    { name: 'full width at 1280x800', size: { width: 1280, height: 800 }, beside: false },
    { name: 'in the pane beside the chat at 1280x800', size: { width: 1280, height: 800 }, beside: true },
    { name: 'on a phone at 390x800', size: { width: 390, height: 800 }, beside: false },
  ];

  for (const { name, size, beside } of sizes) {
    test(`draws 11 areas ${name} at a readable size, every one in view, with no "Empty" and no zoom buttons`, async ({ page }) => {
      await page.setViewportSize(size);
      if (beside) await chatBeside(page);
      await routeAreas(page);
      await page.goto('/#/workspaces/demo/board');
      await viewAtRest(page);
      const isNarrow = size.width < 600 || beside;
      const fold = board(page).locator('#board-overview button.board-area-fold');
      const flow = board(page).locator('#board-overview .react-flow');

      const facts = await overviewFacts(page);
      test.info().annotations.push({ type: 'form', description: `${facts.cards} cards, ${facts.minis} minis, ${facts.rows} rows, zoom ${(await transformOf(page)).scale.toFixed(2)}, titles ${facts.titles.map((size) => size.toFixed(1)).join(' ')}` });

      expect(facts.inside, 'every Area is whole inside the stage, with no panning').toBe(true);

      // Nothing overlapping
      for (let i = 0; i < facts.boxes.length; i++) {
        for (let j = i + 1; j < facts.boxes.length; j++) {
          const a = facts.boxes[i]!;
          const b = facts.boxes[j]!;
          const overlap = !(a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5);
          expect(overlap, `boxes ${i} and ${j} overlap`).toBe(false);
        }
      }

      for (const title of facts.titles) expect(title).toBeGreaterThanOrEqual(12);
      for (const { text, size: px } of facts.sizes) expect(px, `"${text}" is drawn at ${px.toFixed(1)} px`).toBeGreaterThanOrEqual(11.95);
      expect((await transformOf(page)).scale).toBeGreaterThanOrEqual(0.9 - 1e-6);

      let foldCount = 0;
      if ((await fold.count()) > 0 && (await fold.isVisible())) {
        const foldText = (await fold.textContent()) ?? '';
        const foldMatch = foldText.match(/(\d+)\s+more/);
        const doneMatch = foldText.match(/(\d+)\s+done/);
        foldCount = (foldMatch ? parseInt(foldMatch[1]!, 10) : 0) + (doneMatch ? parseInt(doneMatch[1]!, 10) : 0);
      }
      expect(facts.count + foldCount, 'shown Areas plus fold count add up to 11').toBe(11);

      if (isNarrow) {
        expect(facts.cards, '1 focus card').toBe(1);
        expect(facts.rows, 'rows for other shown areas').toBe(facts.count - 1);
        // Focus card is whole
        const heroNode = board(page).locator('#board-overview .react-flow__node-area');
        const cardDiv = heroNode.locator('> div');
        const whole = await cardDiv.evaluate((el) => el.scrollHeight <= el.clientHeight + 1.5);
        expect(whole, 'focus card is whole').toBe(true);
        // Rows are one line each
        const rowHeights = await board(page).locator('#board-overview .react-flow__node-areaRow').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
        expect(rowHeights.every((h) => Math.abs(h - 40) <= 2), 'rows are one line each').toBe(true);
      } else {
        expect(facts.boxes.every((box) => box.height >= 36)).toBe(true);
      }

      // Open the fold and check every Area is reachable, scrolling the stage if the fold scrolls
      if (await fold.isVisible()) {
        await fold.click();
        await viewAtRest(page);
      }
      const allAreaButtons = board(page).locator('#board-overview button.board-area');
      await expect(allAreaButtons).toHaveCount(11);
      for (let i = 0; i < 11; i++) {
        const btn = allAreaButtons.nth(i);
        await btn.focus();
        await expect.poll(() => isWithin(btn, flow)).toBe(true);
      }
      const openFacts = await overviewFacts(page);
      // The measure divides a real width by a whole-pixel offsetWidth, so a row of a fractional width reads a hair under its true 12 px
      for (const title of openFacts.titles) expect(title).toBeGreaterThanOrEqual(11.9);

      await expect(board(page).getByText('Empty', { exact: true })).toHaveCount(0);
      await expect(board(page).getByRole('button', { name: /^Zoom (in|out)$|^Fit the board in view$/ })).toHaveCount(0);
      await expect(board(page).locator('.react-flow__controls')).toHaveCount(0);
      // The attribution watermark is hidden on the board
      await expect(board(page).locator('#board-overview .react-flow__attribution')).toHaveCount(0);
    });
  }

  test('draws the cards with no blank space: each line of them ends where its content ends, and none says it is empty', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await routeAreas(page, { count: 6, done: 2, titles: ['Plan the slice', 'Build the slice', 'Look at it', 'Fix what shows', 'Ship it', 'Tell people'], question: 'Which size can be read?' });
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const fold = board(page).locator('#board-overview button.board-area-fold');
    if (await fold.isVisible()) await fold.click();
    const facts = await overviewFacts(page);
    expect(facts.cards, 'focus Area is hero card').toBe(1);
    expect(facts.minis, 'other Areas are small cards').toBe(5);
    // Between the last thing in a card and its bottom edge there is its padding and no more, in the card that is the highest of its line
    const gaps = await board(page).locator('#board-overview').evaluate((overview) => {
      const lines = new Map<number, { gap: number; card: string }>();
      for (const card of Array.from(overview.querySelectorAll<HTMLElement>('button.board-area'))) {
        const box = card.getBoundingClientRect();
        const last = Math.max(...Array.from(card.querySelectorAll('*')).map((el) => el.getBoundingClientRect().bottom));
        const top = Math.round(box.top);
        if (box.bottom - last < (lines.get(top)?.gap ?? Infinity)) lines.set(top, { gap: box.bottom - last, card: card.getAttribute('aria-label')! });
      }
      return [...lines.values()];
    });
    expect(gaps.length).toBeGreaterThan(0);
    for (const { gap, card } of gaps) expect(gap, card).toBeLessThanOrEqual(14);
    await expect(board(page).getByText(/^Empty$|no items yet/)).toHaveCount(0);
    // Only what differs from the usual is said: Done and Now are, "Not done" is not (the name still says it)
    const overview = board(page).locator('#board-overview');
    await expect(overview.getByText('Not done', { exact: true })).toHaveCount(0);
    await expect(overview.locator('.react-flow__node-area .board-area-badge')).toHaveText(['Now', 'Waits for you']);
    await expect(overview.locator('button.board-area').filter({ hasText: 'Plan the slice' })).toHaveAttribute('aria-label', /done/i);
    await expect(overview.locator('button.board-area').filter({ hasText: 'Build the slice' })).toHaveAttribute('aria-label', /done/i);
    await expect(overview.locator('button.board-area').filter({ hasText: 'Fix what shows' })).toHaveAttribute('aria-label', /not done/i);
  });

  test('has no title row of its own: the board starts under the workspace header, with the pane\'s icons in its corner', async ({ page }) => {
    await routeAreas(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const header = (await page.locator('header').filter({ hasText: 'Reports CSV export' }).first().boundingBox())!;
    const region = (await board(page).boundingBox())!;
    expect(Math.abs(region.y - (header.y + header.height))).toBeLessThanOrEqual(2);
    const icons = board(page).getByRole('button', { name: /^Close this panel/ });
    await expect(icons).toHaveCount(1);
    const iconBox = (await icons.boundingBox())!;
    expect(iconBox.y).toBeLessThan(region.y + 44 + 36 /* the Assignment card sits under the Now line */);
    expect(iconBox.x + iconBox.width).toBeGreaterThan(region.x + region.width - 48);
    // Nothing is drawn under them
    for (const box of (await overviewFacts(page)).boxes) {
      const apart = box.x + box.width <= iconBox.x || iconBox.x + iconBox.width <= box.x || box.y + box.height <= iconBox.y || iconBox.y + iconBox.height <= box.y;
      expect(apart, 'an Area is under the pane\'s icons').toBe(true);
    }
    // Quiet until pointed at or focused
    const quiet = await icons.evaluate((button) => parseFloat(getComputedStyle(button.parentElement!).opacity));
    expect(quiet).toBeLessThan(1);
    await icons.focus();
    await expect.poll(() => icons.evaluate((button) => parseFloat(getComputedStyle(button.parentElement!).opacity))).toBe(1);
  });

  test('hides and shows the chat, and closes the panel, from the board\'s own icons', async ({ page }) => {
    await chatBeside(page);
    await routeAreas(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const narrow = (await board(page).boundingBox())!;
    await page.getByRole('button', { name: 'Hide the chat and give this the whole width' }).click();
    await expect.poll(async () => (await board(page).boundingBox())!.width).toBeGreaterThan(narrow.width + 100);
    await viewAtRest(page);
    const fold = board(page).locator('#board-overview button.board-area-fold');
    if (await fold.isVisible()) await fold.click();
    await expect(board(page).locator('#board-overview button.board-area')).toHaveCount(11);
    await page.getByRole('button', { name: 'Show the chat beside this' }).click();
    await expect.poll(async () => (await board(page).boundingBox())!.width).toBeLessThan(narrow.width + 2);
    await page.getByRole('button', { name: 'Close this panel and give the chat the whole screen' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
  });

  test('has the pane\'s icons at the end of the Area\'s heading once, not behind it as well', async ({ page }) => {
    await routeAreas(page);
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, AREAS[4]!);
    const heading = board(page).locator('#board-area > header');
    const close = page.getByRole('button', { name: 'Close this panel and give the chat the whole screen' });
    await expect(close).toHaveCount(1);
    await expect(heading.getByRole('button', { name: 'Close this panel and give the chat the whole screen' })).toBeVisible();
    const [box, header] = await Promise.all([close.boundingBox(), heading.boundingBox()]);
    expect(box!.x + box!.width).toBeGreaterThan(header!.x + header!.width - 24);
    await expect(board(page).getByRole('button', { name: /^Zoom (in|out)$|^Fit the board in view$/ })).toHaveCount(0);
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await expect(board(page).locator('#board-area')).toHaveCount(0);
    await expect(close).toHaveCount(1);
    await expect(board(page).getByRole('button', { name: /^Close this panel/ })).toBeVisible();
  });

  test('steps into an Area from its row as from its card: by press, Enter and Space, and gives the keyboard back to the row', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 836 /* the Assignment card takes 36 px */ });
    await routeAreas(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const row = board(page).locator('#board-overview button.board-area').filter({ hasText: AREAS[5]! });
    const fold = board(page).locator('#board-overview button.board-area-fold');
    if (await fold.isVisible()) await fold.click();
    await expect(board(page).locator('#board-overview .react-flow__node-area')).toHaveCount(1);
    await expect(board(page).locator('#board-overview .react-flow__node-areaRow')).toHaveCount(10);
    // It names the Area, its state and its steps, and shows the title in full on pointing
    await expect(row).toHaveAttribute('aria-label', /^Pictures are told apart from files, not done, 0 of 3 steps/);
    await expect(row.locator('[title]').first()).toHaveAttribute('title', AREAS[5]!);
    for (const key of ['Enter', 'Space', null] as const) {
      await row.focus();
      if (key) await page.keyboard.press(key); else await row.click();
      await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
      await expect(board(page).getByRole('region', { name: AREAS[5]! })).toBeVisible();
      await board(page).getByRole('button', { name: 'Board ›' }).click();
      await expect(board(page).locator('#board-area')).toHaveCount(0);
      await expect(row).toBeFocused();
    }
    // The current one says Now, the finished ones are marked done, and the one that waits for you is named
    await expect(board(page).locator('#board-overview button.board-area').filter({ hasText: AREAS[4]! })).toContainText('Now');
    await expect(board(page).locator('#board-overview button.board-area').filter({ hasText: AREAS[4]! })).toHaveAttribute('aria-label', /waits for you/);
    await expect(board(page).locator('#board-overview button.board-area').filter({ hasText: AREAS[4]! })).toContainText('Waits for you');
    await expect(board(page).locator('#board-overview button.board-area').filter({ hasText: AREAS[3]! })).not.toContainText('Waits for you');
    await expect(board(page).locator('#board-overview button.board-area').filter({ hasText: AREAS[0]! })).toHaveAttribute('aria-label', /done, 3 of 3 steps/);
  });

  test('folds the finished Areas into one last row when even the rows do not fit, and opens them on a press', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 756 /* the Assignment card takes 36 px */ });
    await routeAreas(page, { count: 25, done: 16 });
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const areas = board(page).locator('#board-overview button.board-area');
    const fold = board(page).locator('#board-overview button.board-area-fold');
    await expect(fold).toHaveText('3 more · 16 done');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(areas).toHaveCount(6);
    expect((await overviewFacts(page)).inside).toBe(true);
    // The last row is the last
    const [foldBox, lastArea] = await Promise.all([fold.boundingBox(), areas.last().boundingBox()]);
    expect(foldBox!.y).toBeGreaterThan(lastArea!.y);
    await fold.click();
    await expect(areas).toHaveCount(25);
    await expect(fold).toHaveText('Show fewer');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(fold).toBeFocused();
    await fold.click();
    await expect(areas).toHaveCount(6);
    await expect(fold).toHaveText('3 more · 16 done');
    await viewAtRest(page);
    expect((await overviewFacts(page)).inside).toBe(true);
  });

  // The app's sidebar on its slim rail, as the app starts: the board is 1160 px wide at 1280x800
  test.describe('the Board index at 1280x800', () => {
    test.use({ sidebarDocked: false });

    test('starts with the index closed at 1280x800 when that turns the small cards into cards, and it is one press away', async ({ page }) => {
      await routeAreas(page);
      await page.goto('/#/workspaces/demo/board');
      await viewAtRest(page);
      const overview = board(page).locator('#board-overview');
      await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
      await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(6);
      await expect(overview.locator('.react-flow__node-areaRow')).toHaveCount(0);
      expect((await transformOf(page)).scale).toBeGreaterThanOrEqual(0.9 - 1e-6);
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeHidden();
      const rail = page.getByRole('button', { name: /^Board index/ });
      await expect(rail).toHaveAttribute('aria-expanded', 'false');
      // One press opens it, and that is the person's choice from then on
      await rail.click();
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeVisible();
      await viewAtRest(page);
      await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(6);
      await page.reload();
      await viewAtRest(page);
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeVisible();
      await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(6);
    });

    test('never shows the docked index, the rows or the small cards on the way to the closed index and cards, even when the commits take their time', async ({ page }) => {
      // Every frame is looked at from the first one: the index (docked, drawn), the rows and the small cards (the form of the open index) are what must never be seen
      await page.addInitScript(() => {
        const seen = { frames: 0, loadingFrames: 0, indexFrames: 0, rowFrames: 0, miniFrames: 0, blankFrames: 0 };
        (window as unknown as { __seen: typeof seen }).__seen = seen;
        // Seen: not hidden, not faded out by a parent, and with a size
        const drawn = (element: Element | null) => {
          if (!element || element.getBoundingClientRect().width === 0 || getComputedStyle(element).visibility === 'hidden') return false;
          for (let parent: Element | null = element; parent; parent = parent.parentElement) if (getComputedStyle(parent).opacity === '0') return false;
          return true;
        };
        const tick = () => {
          seen.frames += 1;
          if (document.body.textContent?.includes('Still loading')) seen.loadingFrames += 1;
          if (drawn(document.querySelector('nav[aria-label="Board index"]'))) seen.indexFrames += 1;
          const rows = Array.from(document.querySelectorAll('.react-flow__node-areaRow')).some(drawn);
          if (rows) seen.rowFrames += 1;
          const minis = Array.from(document.querySelectorAll('.react-flow__node-areaMini')).some(drawn);
          if (minis) seen.miniFrames += 1;
          // A stage with nothing on it and nothing said about why is a frame the person should not see
          const region = document.querySelector<HTMLElement>('[role="region"][aria-label="Board"]');
          const areas = Array.from(document.querySelectorAll('.react-flow__node-area')).some(drawn);
          if (region && !region.hidden && region.getBoundingClientRect().height > 0 && !rows && !minis && !areas && !/Still loading|Loading the board|Nothing on the board yet/.test(region.textContent ?? '')) seen.blankFrames += 1;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await routeAreas(page);
      await page.route('**/api/workspace/demo/news', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fulfill({ json: whatsNew({ commits: [{ repo: 'NexusFlow', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Make the overview readable', at: minutesAgo(30) }] }] }) });
      });
      await page.goto('/#/workspaces/demo/board');
      await expect(board(page).locator('#board-overview .react-flow__node-area')).toHaveCount(1, { timeout: 10_000 });
      await expect(board(page).locator('#board-overview .react-flow__node-areaMini')).toHaveCount(6);
      await viewAtRest(page);
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeHidden();
      const seen = await page.evaluate(() => (window as unknown as { __seen: Record<string, number> }).__seen);
      // The page really was waiting for the commits for a good while, frame after frame
      expect(seen.frames).toBeGreaterThan(30);
      expect(seen.indexFrames, 'frames with the index drawn').toBe(0);
      expect(seen.rowFrames, 'frames with rows drawn').toBe(0);
      expect(seen.blankFrames, 'frames with an empty stage and no word about why').toBe(0);
    });

    test('shows the Areas while the commits are still on their way, with no index, rows or small cards seen, and adds their counts when they land', async ({ page }) => {
      await page.addInitScript(() => {
        const seen = { frames: 0, indexFrames: 0, rowFrames: 0, miniFrames: 0 };
        (window as unknown as { __seen: typeof seen }).__seen = seen;
        const drawn = (element: Element | null) => {
          if (!element || element.getBoundingClientRect().width === 0 || getComputedStyle(element).visibility === 'hidden') return false;
          for (let parent: Element | null = element; parent; parent = parent.parentElement) if (getComputedStyle(parent).opacity === '0') return false;
          return true;
        };
        const tick = () => {
          seen.frames += 1;
          if (drawn(document.querySelector('nav[aria-label="Board index"]'))) seen.indexFrames += 1;
          if (Array.from(document.querySelectorAll('.react-flow__node-areaRow')).some(drawn)) seen.rowFrames += 1;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await routeAreas(page);
      // The commits come when the spec lets them
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route('**/api/workspace/demo/news', async (route) => {
        await gate;
        await route.fulfill({ json: whatsNew({ commits: [{ repo: 'NexusFlow', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Make the overview readable', at: minutesAgo(30) }] }] }) });
      });
      await page.goto('/#/workspaces/demo/board');
      const overview = board(page).locator('#board-overview');
      const current = overview.locator('.react-flow__node-area').filter({ hasText: AREAS[4]! });
      // An Area is there to be seen and pressed while the commits are still waited for, and the board is the cards with the index closed
      await expect(board(page).getByRole('status').filter({ hasText: 'Still loading: commits' })).toBeVisible();
      await expect(current).toBeVisible({ timeout: 5000 });
      await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
      await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(6);
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeHidden();
      await expect(current).not.toContainText('commit');
      await viewAtRest(page, { allowLoading: true });
      await current.click();
      await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
      await board(page).getByRole('button', { name: 'Board ›' }).click();
      await expect(board(page).locator('#board-area')).toHaveCount(0);
      // The commits land: their count is on the card, and nothing else moves
      release();
      await expect(current).toContainText('1 commit');
      await expect(board(page).getByText(/^Still loading/)).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeHidden();
      await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
      await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(6);
      const seen = await page.evaluate(() => (window as unknown as { __seen: Record<string, number> }).__seen);
      expect(seen.frames).toBeGreaterThan(30);
      expect(seen.indexFrames, 'frames with the index drawn').toBe(0);
      expect(seen.rowFrames, 'frames with rows drawn').toBe(0);
    });

    test('decides only once the index docks: opened in the pane, then given the whole width, it ends closed with cards', async ({ page }) => {
      await chatBeside(page);
      await routeAreas(page);
      await page.goto('/#/workspaces/demo/board');
      await viewAtRest(page);
      const overview = board(page).locator('#board-overview');
      // In the pane the index overlays and the lower Areas are rows
      await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
      await expect(overview.locator('.react-flow__node-areaRow')).toHaveCount(6);
      await page.getByRole('button', { name: 'Hide the chat and give this the whole width' }).click();
      await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
      await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(6);
      await viewAtRest(page);
      await expect(overview.locator('.react-flow__node-areaRow')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeHidden();
      await expect(page.getByRole('button', { name: /^Board index/ })).toHaveAttribute('aria-expanded', 'false');
    });

    test('keeps the index open where the person chose it open, even if the Areas would be cards without it', async ({ page }) => {
      await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'open'); });
      await routeAreas(page);
      await page.goto('/#/workspaces/demo/board');
      await viewAtRest(page);
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeVisible();
      await expect(board(page).locator('#board-overview .react-flow__node-areaMini')).toHaveCount(6);
    });

    test('leaves the index open where closing it would not give cards: few Areas, and a stage too small for cards', async ({ page }) => {
      await routeAreas(page, { count: 3, done: 1 });
      await page.goto('/#/workspaces/demo/board');
      await viewAtRest(page);
      // Index starts closed at every size per W2
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeHidden();
      await page.getByRole('button', { name: /^Board index/ }).click();
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeVisible();
      await page.goto('about:blank');
      await page.setViewportSize({ width: 1100, height: 700 });
      await routeAreas(page);
      await page.goto('/#/workspaces/demo/board');
      await viewAtRest(page);
      await expect(board(page).locator('#board-overview .react-flow__node-areaMini')).toHaveCount(6);
      await expect(page.getByRole('navigation', { name: 'Board index' })).toBeVisible();
    });
  });

  test('lets the folded Areas go when the overview becomes cards, so they are folded again when it is rows again', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 720 });
    await routeAreas(page, { count: 14, done: 0 });
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const fold = board(page).locator('#board-overview button.board-area-fold');
    await expect(fold).toHaveText(/^\d+ more$/);
    await fold.click();
    await expect(fold).toHaveText('Show fewer');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await viewAtRest(page);
    await expect(board(page).locator('#board-overview .react-flow__node-area')).toHaveCount(1);
    await expect(board(page).locator('#board-overview .react-flow__node-areaMini')).toHaveCount(13);
    await expect(fold).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 720 });
    await viewAtRest(page);
    await expect(fold).toHaveText(/^\d+ more$/);
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
  });

  test('folds the finished Areas of the small cards as of the rows, keeps the fold open from rows to small cards, and lets it go when the overview has none', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 756 /* the Assignment card takes 36 px */ });
    await routeAreas(page, { count: 14, done: 8 });
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const overview = board(page).locator('#board-overview');
    const fold = overview.locator('button.board-area-fold');
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
    await expect(overview.locator('.react-flow__node-areaRow')).toHaveCount(5);
    await fold.click();
    await expect(fold).toHaveText('Show fewer');
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
    await expect(overview.locator('.react-flow__node-areaRow')).toHaveCount(13);
    // A wider stage draws small cards, with the fold as they have one: still open, nothing lost
    await page.setViewportSize({ width: 700, height: 596 });
    await viewAtRest(page);
    await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(13);
    await expect(fold).toHaveText('Show fewer');
    await fold.click();
    // The stage has finished Areas folded, and the one under way is not
    await expect(fold).toHaveText('3 more · 8 done');
    expect(await overview.locator('.react-flow__node-areaMini').count()).toBeLessThan(14);
    await expect(overview.locator('.react-flow__node-area').filter({ hasText: AREAS[8]! })).toHaveCount(1);
    // Re-opening the fold, then resizing to wide where open areas fit clears the open fold
    await fold.click();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await viewAtRest(page);
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 756 });
    await viewAtRest(page);
    await expect(fold).toHaveText('8 done');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
    await expect(overview.locator('.react-flow__node-areaRow')).toHaveCount(5);
  });

  test('lays the cards out again when the fold goes away by itself after the view was moved', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 720 });
    await routeAreas(page, { count: 14, done: 0 });
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const overview = board(page).locator('#board-overview');
    await overview.locator('button.board-area-fold').click();
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
    await expect(overview.locator('.react-flow__node-areaRow')).toHaveCount(13);
    // The person scrolls the rows
    await overview.locator('.react-flow__pane').hover({ position: { x: 5, y: 300 } });
    await page.mouse.wheel(0, 200);
    await viewAtRest(page);
    expect((await transformOf(page)).y).toBeLessThan(0);
    // The window grows: all open Areas fit, the fold goes away by itself, and the view is laid out again
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
    await viewAtRest(page);
    await expect(overview.locator('button.board-area-fold')).toHaveCount(0);
    expect((await overviewFacts(page)).inside, 'every Area is whole inside the stage').toBe(true);
  });

  // The app's sidebar on its slim rail, as the app starts
  test.describe('the Area\'s heading', () => {
    test.use({ sidebarDocked: false });

    for (const { name, size, beside } of [
      { name: 'in the pane beside the chat', size: { width: 1280, height: 800 }, beside: true },
      { name: 'on a phone at 390', size: { width: 390, height: 800 }, beside: false },
    ]) {
      test(`keeps the Area's title readable in its heading ${name}, with the Archived button there too`, async ({ page }) => {
        await page.setViewportSize(size);
        if (beside) await chatBeside(page);
        await routeAreas(page, { archived: true });
        await page.goto('/#/workspaces/demo/board');
        await stepIntoArea(page, AREAS[4]!);
        const header = board(page).locator('#board-area > header');
        const heading = header.locator('h2');
        await expect(heading).toHaveText(AREAS[4]!);
        await expect(header.getByRole('button', { name: 'Archived (1)' })).toBeVisible();
        const box = (await heading.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(7 * 16 - 1);
        // The heading's icons are still whole inside it
        const icons = (await header.getByRole('button', { name: /^Close this panel/ }).boundingBox())!;
        const frame = (await header.boundingBox())!;
        expect(icons.x + icons.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
        // What there is no room to show is left out of sight but not out of the accessibility tree: how far the Area is
        for (const [text, wrapper] of [[/^\d+ of \d+ steps$/, '.']] as const) {
          const hidden = header.getByText(text);
          await expect(hidden).toHaveCount(1);
          // The steps are that box themselves
          const box = hidden.locator(`xpath=${wrapper}`);
          expect((await box.boundingBox())!.width).toBeLessThanOrEqual(1.5);
          // Still drawn (not display:none or visibility:hidden), which is what the accessibility tree keeps
          expect(await hidden.evaluate((element) => { const style = getComputedStyle(element); return [style.display, style.visibility]; })).toEqual([expect.not.stringMatching(/^none$/), 'visible']);
        }
      });
    }

    test('keeps the Area\'s title at 7rem or more where the heading has no room for all of it, with the Archived button there too', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await routeAreas(page, { archived: true });
      await page.goto('/#/workspaces/demo/board');
      await stepIntoArea(page, AREAS[4]!);
      const header = board(page).locator('#board-area > header');
      await expect(header.getByRole('button', { name: 'Archived (1)' })).toBeVisible();
      expect((await header.locator('h2').boundingBox())!.width).toBeGreaterThanOrEqual(7 * 16 - 1);
    });

    test('keeps the heading\'s icons whole inside it at 360, with the Archived button there too', async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await routeAreas(page, { archived: true });
      await page.goto('/#/workspaces/demo/board');
      await stepIntoArea(page, AREAS[4]!);
      const header = board(page).locator('#board-area > header');
      await expect(header.getByRole('button', { name: 'Archived (1)' })).toBeVisible();
      const icons = (await header.getByRole('button', { name: /^Close this panel/ }).boundingBox())!;
      const frame = (await header.boundingBox())!;
      expect(icons.x + icons.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
    });

    test('says how far the Area is in its heading where there is room for it', async ({ page }) => {
      await routeAreas(page);
      await page.goto('/#/workspaces/demo/board');
      await stepIntoArea(page, AREAS[4]!);
      await expect(board(page).locator('#board-area > header').getByText('1 of 3 steps')).toBeVisible();
    });
  });

  test('has no serious accessibility violations in the overview, as cards and as rows, in light and dark', async ({ page }) => {
    await routeAreas(page);
    await page.goto('/#/workspaces/demo/board');
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 800 }]) {
      await page.setViewportSize(size);
      await viewAtRest(page);
      // Settled colours only: a transition caught half-way reports a contrast no one sees.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        const results = await new AxeBuilder({ page }).include('[aria-label="Board"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
        expect(results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'), `${colorScheme} ${size.width}`).toEqual([]);
      }
    }
  });
});
