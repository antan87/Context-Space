import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardFileCard, boardId, boardLink, boardNote, checkpoint, decision, planFile, step, whatsNew } from './planData';
import type { WorkDocument } from '../src/types.ts';

/**
 * The Board: the workspace's plan, documents and commits on a canvas you can pan and zoom, and the notes and files that
 * people and AIs put on it. Each part is drawn from what the Plan, Docs and "Since you last looked" already read, and a
 * part that fails does not hide the rest. It opens on the work under way, and shows an AI's changes as the screen feed
 * reports them. It shows the big picture first: every group (a checkpoint, the plan's own steps, the documents, a repository's
 * commits) is one summary and only the work under way is open; a press opens a group where it stands. Only the cards that
 * people and AIs put on the board can be dragged; the place is kept in the board file.
 */
const workspace = { id: 'demo', branchName: 'demo', name: 'Reports CSV export', description: 'Add CSV export to reports', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
// A laptop-sized window, as the Board is used; a spec that needs more or less sets its own size and says why.
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

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

/** What GET /board answers, for the specs about what is put on the board. */
async function routeCards(page: Page, board: ReturnType<typeof boardFile>) {
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: board }));
}

/**
 * A board that things can be moved on: GET answers with the board as it is, and every change that is POSTed is kept in
 * `posted`, applied as the backend applies a move (a place set, or forgotten with null) and answered with the new board.
 * While `fail` is set the answer is that error instead, and the board stays as it was. While `holdPosts` (or `holdGets`)
 * is set the answers wait in `heldPosts` (`heldGets`) until the spec sends them, in the order it likes.
 */
async function routeMoves(page: Page, board: ReturnType<typeof boardFile>) {
  const state = {
    board: board as Record<string, any>, posted: [] as any[], reads: 0, fail: null as { status: number; error: string } | null,
    holdPosts: false, heldPosts: [] as Array<() => Promise<void>>, holdGets: false, heldGets: [] as Array<() => Promise<void>>,
  };
  await page.route('**/api/workspace/demo/board', async (route) => {
    state.reads += 1;
    const snapshot = state.board;
    const answer = async () => { await route.fulfill({ json: snapshot }).catch(() => {}); };
    if (state.holdGets) state.heldGets.push(answer); else await answer();
  });
  await page.route('**/api/workspace/demo/board/changes', async (route) => {
    const body = route.request().postDataJSON();
    state.posted.push(body);
    const fail = state.fail;
    let answer: () => Promise<void>;
    if (fail) {
      answer = async () => { await route.fulfill({ status: fail.status, json: { error: fail.error } }); };
    } else {
      const positions = { ...state.board.positions };
      for (const change of body.changes) for (const { id, x, y } of change.nodes) { if (x === null) delete positions[id]; else positions[id] = { x, y }; }
      state.board = { ...state.board, revision: state.board.revision + 1, positions };
      const snapshot = state.board;
      answer = async () => { await route.fulfill({ json: { ...snapshot, results: body.changes.map(() => ({})) } }); };
    }
    if (state.holdPosts) state.heldPosts.push(answer); else await answer();
  });
  return state;
}

/**
 * The board with its commits held back until the spec lets them go (the function it returns), so the board is open and the user can act
 * before they arrive, however long that takes.
 */
async function routeLateCommits(page: Page) {
  await routeBoard(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/workspace/demo/news', async (route) => {
    await gate;
    await route.fulfill({ json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the CSV writer', at: minutesAgo(30) }] }] }) });
  });
  return release;
}

/** A one-pixel PNG, for the pictures of file cards. */
const PICTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function routePictures(page: Page) {
  await page.route('**/api/workspace/demo/documents/file**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
}

const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const node = (page: Page, id: string) => board(page).locator(`.react-flow:not([inert] *) .react-flow__node[data-id="${id}"]`);

async function stepIntoArea(page: Page, name: string | RegExp = /Reports export to CSV/, options: { allowLoading?: boolean } = {}) {
  const areaBtn = board(page).locator('.board-overview-plane button.board-area').filter({ hasText: name });
  await viewAtRest(page, options);
  await areaBtn.click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
  await viewAtRest(page, options);
}
/** Where a node stands on the canvas (not on the screen): its own place, or its lane's for a card in one. */
const canvasPosition = (page: Page, id: string) => node(page, id).evaluate((element) => {
  const matrix = new DOMMatrix(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f };
});
/** A node's place and size on the canvas, in canvas units: they do not change when the view moves or is still moving. */
const canvasBox = (page: Page, id: string) => node(page, id).evaluate((element) => {
  const matrix = new DOMMatrix(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f, width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight };
});
const transformOf = async (page: Page) => {
  const stepped = board(page).locator('#board-area .react-flow__viewport');
  const count = await stepped.count();
  const chosen = count > 0 ? stepped : board(page).locator('#board-overview .react-flow__viewport');
  return chosen.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
};
/** Whether the whole of `inner` is inside `outer` on the screen. */
async function isWithin(inner: Locator, outer: Locator) {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  return Boolean(a && b && a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height);
}

/**
 * Waits until every part has arrived and the view has stopped moving: it moves by itself to take in a part that comes late, and a drag is
 * measured from rest. A move shows over the frames that are drawn, so the view is read before and after a few of them: two reads one
 * after the other can both come before a move that is about to start.
 */
async function viewAtRest(page: Page, options: { allowLoading?: boolean } = {}) {
  if (!options.allowLoading) {
    await expect(board(page).getByText(/^Still loading/)).toHaveCount(0);
  }
  await expect(board(page).locator('.board-area-exit')).toHaveCount(0);
  await expect.poll(async () => {
    const animationsSettled = await page.evaluate(() => {
      const els = [document.querySelector('#board-area'), document.querySelector('#board-overview')].filter(Boolean);
      return els.every((el) => el!.getAnimations().every((a) => a.playState !== 'running'));
    });
    if (!animationsSettled) return false;
    const before = JSON.stringify(await transformOf(page));
    await frames(page, 6);
    return JSON.stringify(await transformOf(page)) === before;
  }, { intervals: [120], timeout: 15000 }).toBe(true);
}
/**
 * Makes sure a card is on show: when it is behind a "+N more" tile (the row is wider than the window), the tile is pressed and the
 * row opens. A card that is on show already is left alone.
 */
async function reveal(page: Page, target: Locator) {
  const more = board(page).locator('#board-area').locator('.react-flow__node-more button, .react-flow__node-fold button');
  // Which row holds the card is not known, and it may not have arrived yet: each row that has more than fits is opened in turn, and closed again when the card is not in it
  await expect.poll(async () => {
    if (await target.isVisible()) return true;
    const rows = await more.count();
    for (let index = 0; index < rows; index += 1) {
      await more.nth(index).click();
      await frames(page, 6);
      // The row may have pages: each is looked at
      const older = board(page).locator('#board-area').getByRole('button', { name: 'Older ›' });
      for (let turn = 0; turn < 12 && !(await target.isVisible()) && await older.count() && await older.isEnabled(); turn += 1) {
        await older.click();
        await frames(page, 4);
      }
      if (await target.isVisible()) return true;
      await page.keyboard.press('Escape');
      await frames(page, 6);
    }
    return false;
  }, { timeout: 15000, intervals: [300] }).toBe(true);
}
/** Opens the row of the current step, if it has more than fits. */
async function revealAll(page: Page) {
  const more = board(page).locator('#board-area').getByRole('button', { name: /^Show \d+ more for Background job queue/ });
  await frames(page, 4);
  if (await more.count()) await more.click();
  await viewAtRest(page);
}
/** Waits until the browser has drawn that many frames: whatever was going to happen in them has happened. */
const frames = (page: Page, count = 6) => page.evaluate((total) => new Promise<void>((resolve) => {
  let drawn = 0;
  const tick = () => (++drawn >= total ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), count);
/**
 * Drags from the middle of `target` by that many screen pixels with the mouse, and lets go unless told to hold on. React
 * Flow starts a drag at the first move of a few pixels and counts from there, so a short move starts it and the rest is
 * the distance asked for. Gives the spot the drag counts from.
 */
async function dragBy(page: Page, target: Locator, dx: number, dy: number, options: { hold?: boolean } = {}) {
  const box = (await target.boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  const start = { x: middle.x + 6, y: middle.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 });
  if (!options.hold) await page.mouse.up();
  return start;
}

test.describe('Board', () => {
  test('opens from the rail, right after Plan, on its own address', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/plan');
    await expect(workspaceNav(page).getByRole('link')).toHaveText(['Overview', 'Plan', 'Board', 'Sessions', 'Code', 'Docs', 'Skills', 'Services']);
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    await expect(workspaceNav(page).getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page');
    await expect(board(page).locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
  });

  test('groups work into areas with status badges, step progress and item counts, fitting whole on screen', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');

    // Areas at Level 0
    const planArea = overview.locator('button.board-area').filter({ hasText: 'Plan' });
    const firstArea = overview.locator('button.board-area').filter({ hasText: 'Report rows load fast' });
    const secondArea = overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' });

    await expect(planArea).toBeVisible();
    await expect(planArea).toContainText('Plan');
    await expect(planArea).toContainText('1 step outside the checkpoints');

    await expect(firstArea).toBeVisible();
    await expect(firstArea).toContainText('Done');
    await expect(firstArea).toContainText('1 of 1 step');

    await expect(secondArea).toBeVisible();
    await expect(secondArea).toContainText('Current');
    await expect(secondArea).toContainText('Waits for you');
    await expect(secondArea).toContainText('1 of 3 steps');
    await expect(secondArea).toContainText('Which time zone should export timestamps use?');

    // Every Area fits whole inside overview canvas on one screen
    for (const target of [planArea, firstArea, secondArea]) {
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
    const overview = board(page).locator('#board-overview');
    const flow = overview.locator('.react-flow');
    for (const title of titles) {
      const btn = overview.locator('button.board-area').filter({ hasText: title });
      await expect(btn).toBeVisible();
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
    const frame = stepped.getByRole('article', { name: 'Reports export to CSV' });
    await expect(frame).toBeVisible();
    await expect(frame).toContainText('1 of 3 steps');
    await expect(frame).toContainText('Waits for you');
    // The open steps are rows, the first one is the current step, and the done step is folded into one line that opens
    await expect(stepped.getByRole('button', { name: /^Current step: Background job queue for large exports/ })).toBeVisible();
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
    const frame = canvas.locator('#board-area').getByRole('article', { name: 'Reports export to CSV' });
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

  test('opens on the checkpoint under way, with zoom controls and screen-fitted overview', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');
    const current = overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect(current).toBeVisible();
    await expect(current).toContainText('Current');
    await expect.poll(() => isWithin(current, overview.locator('.react-flow'))).toBe(true);

    await expect(canvas.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Zoom out' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Fit the board in view' })).toBeVisible();
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
    const last = overview.locator('button.board-area').filter({ hasText: 'Release notes' });
    await expect(last).toBeVisible();
    await expect(last).toContainText('Done');
    await expect.poll(() => isWithin(last, overview.locator('.react-flow'))).toBe(true);
  });

  test('zooms and pans with the controls and the keyboard, and fits the whole board on request', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);
    const overview = canvas.locator('#board-overview');
    const opened = await transformOf(page);

    await canvas.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(async () => (await transformOf(page)).scale).toBeGreaterThan(opened.scale);
    const zoomed = await transformOf(page);

    await canvas.getByRole('button', { name: 'Fit the board in view' }).click();
    await expect.poll(async () => (await transformOf(page)).scale).toBeLessThan(zoomed.scale);
    const flow = overview.locator('.react-flow');
    const current = overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect.poll(() => isWithin(current, flow)).toBe(true);
    const fitted = await transformOf(page);

    await flow.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await transformOf(page)).x).toBeGreaterThan(fitted.x);
    await page.keyboard.press('-');
    await expect.poll(async () => (await transformOf(page)).scale).toBeLessThan(fitted.scale);
    await page.keyboard.press('0');
    await expect.poll(async () => Math.abs((await transformOf(page)).scale - fitted.scale)).toBeLessThan(0.01);
  });

  test('says there are no new commits, in one card, when there are none', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [] }] }) }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/, { allowLoading: true });
    const canvas = board(page);
    await expect(canvas.getByText('No new commits since you last looked.')).toBeVisible();
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
    await expect(canvas.getByText(/No new commits/)).toHaveCount(0);

    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'gone', more: 0, commits: [], problem: 'The folder is missing.' }, { repo: 'api', more: 0, commits: [] }] }) }));
    await page.reload();
    await stepIntoArea(page);
    await expect(canvas.getByText('No new commits in the other repositories since you last looked.')).toBeVisible();
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
    const areaBtn = canvas.locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect(areaBtn).toBeVisible();
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    await canvas.locator('.react-flow__controls').evaluate((element) => { (element as HTMLElement & { marked?: boolean }).marked = true; });
    await expect(areaBtn).toContainText('1 commit');
    expect(await canvas.locator('.react-flow__controls').evaluate((element) => (element as HTMLElement & { marked?: boolean }).marked)).toBe(true);
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
    await page.mouse.move(area.x + 200, area.y + 40);
    await page.mouse.down();
    await page.mouse.move(area.x + 350, area.y + 70, { steps: 5 });
    await page.mouse.up();
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    const moved = await transformOf(page);
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
    await canvas.locator('#board-area').getByRole('button', { name: 'Read all of A long note' }).click();
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

test.describe('Board cards', () => {
  // A large window: these specs put several cards, and often a document and a commit too, on screen at once, which a laptop-sized
  // canvas shows as folded rows and "+N more" (specs for that are under "Board, rows by step").
  test.use({ viewport: { width: 1800, height: 1200 } });

  test('draws a note with its title, its text, who wrote it and when', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [
      boardNote(1, { title: 'Export leaks memory', body: 'Seen in the CSV writer.', by: 'claude', at: minutesAgo(12), updatedAt: minutesAgo(12) }),
      boardNote(2, { title: 'Ask finance about time zones', body: 'Before we ship.', by: 'user', updatedBy: 'user', at: minutesAgo(90), updatedAt: minutesAgo(90) }),
    ] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    const note = canvas.getByRole('article', { name: 'Export leaks memory' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('Seen in the CSV writer.');
    await expect(note).toContainText('by claude');
    await expect(note.locator('time')).toHaveCount(0);
    await expect(note).toContainText('12 min ago');
    await expect(note.getByRole('button')).toHaveCount(0);
    // A person's own note says "you".
    const mine = canvas.getByRole('article', { name: 'Ask finance about time zones' });
    await expect(mine).toContainText('by you');
    await expect(mine).toContainText('2 h ago');
    await expect(mine).not.toContainText('by user');
  });

  test('lets a long note be read whole, and puts the focus back on the button when it closes', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardNote(1, { title: 'A long note', body })] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const card = board(page).getByRole('article', { name: 'A long note' });
    await expect(card).toContainText('Line 1 of a long note.');
    // The card shows the start only, and says there is more: the button is only there when the text is cut.
    const readAll = card.getByRole('button', { name: 'Read all of A long note' });
    await readAll.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toContainText('Line 30 of a long note.');
    await expect(dialog).toContainText('by claude');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(readAll).toBeFocused();
  });

  test('draws a picture file as a thumbnail from the documents file address, named for those who cannot see it', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    const requested: string[] = [];
    await page.route('**/api/workspace/demo/documents/file**', (route) => { requested.push(new URL(route.request().url()).searchParams.get('name') ?? ''); return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }); });
    await routeCards(page, boardFile({
      cards: [
        boardFileCard(1, 'docs/export flow.png', { title: 'Export flow', description: 'How a report becomes a CSV file.' }),
        boardFileCard(2, 'shots/screen.JPG', { title: 'screen.JPG', description: 'The export button, in its new place.' }),
      ],
      positions: { [boardId(1)]: { x: 1060, y: 330 }, [boardId(2)]: { x: 1060, y: 650 } },
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    const flow = canvas.getByRole('article', { name: 'Export flow' });
    await expect(flow).toContainText('How a report becomes a CSV file.');
    await expect(flow).toContainText('by claude');
    // The title names the picture; when the title is only the file's name, the description does.
    const picture = flow.getByRole('img', { name: 'Export flow' });
    await expect(picture).toHaveAttribute('src', /\/api\/workspace\/demo\/documents\/file\?name=docs%2Fexport%20flow\.png$/);
    await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(canvas.getByRole('article', { name: 'screen.JPG' }).getByRole('img', { name: 'The export button, in its new place.' })).toBeAttached();
    expect(requested).toContain('docs/export flow.png');
  });

  test('shows a kind of file, not a picture, for pages, PDFs, Markdown and the rest, and falls back to it for a picture that will not load', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/documents/file**', (route) => route.fulfill({ status: 404, json: { error: 'No such file.' } }));
    await routeCards(page, boardFile({
      cards: [
        boardFileCard(1, 'docs/overview.html', { title: 'Overview page' }), boardFileCard(2, 'docs/spec.pdf', { title: 'The spec' }),
        boardFileCard(3, 'docs/notes.md', { title: 'Notes in Markdown' }), boardFileCard(4, 'docs/deck.pptx', { title: 'The deck' }),
        boardFileCard(5, 'docs/gone.png', { title: 'A picture that is gone' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await revealAll(page);
    for (const [title, kind, path] of [['Overview page', 'HTML page', 'docs/overview.html'], ['The spec', 'PDF', 'docs/spec.pdf'], ['Notes in Markdown', 'Markdown', 'docs/notes.md'], ['The deck', 'File', 'docs/deck.pptx']]) {
      const card = canvas.getByRole('article', { name: title });
      await expect(card).toContainText(kind);
      await expect(card).toContainText(path);
      await expect(card.getByRole('img')).toHaveCount(0);
      await expect(card.getByRole('button', { name: `Open ${title}` })).toBeVisible();
    }
    // The picture is tried, fails, and the card still says what the file is.
    const gone = canvas.getByRole('article', { name: 'A picture that is gone' });
    await expect(gone).toContainText('Picture');
    await expect(gone.getByRole('img')).toHaveCount(0);
  });

  test('marks a pinned card, and keeps an archived one out of sight until it is asked for', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [
      boardNote(1, { title: 'Keep this in front', pinned: true }),
      boardNote(2, { title: 'Done with this', archived: true }),
      boardFileCard(3, 'docs/old.pdf', { title: 'An old PDF', archived: true }),
      boardNote(4, { title: 'Just a note' }),
    ] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Keep this in front' })).toContainText('Pinned');
    await expect(canvas.getByRole('article', { name: 'Just a note' })).not.toContainText('Pinned');
    await expect(canvas.getByRole('article', { name: 'Done with this' })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'An old PDF' })).toHaveCount(0);

    const toggle = canvas.locator('#board-area').getByRole('button', { name: 'Archived (2)' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await reveal(page, canvas.getByRole('article', { name: 'An old PDF' }));
    for (const title of ['Done with this', 'An old PDF']) {
      const card = canvas.getByRole('article', { name: title });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Archived');
    }
    await reveal(page, canvas.getByRole('article', { name: 'Just a note' }));
    await expect(canvas.getByRole('article', { name: 'Just a note' })).not.toContainText('Archived');
    await toggle.click();
    await expect(canvas.getByRole('article', { name: 'Done with this' })).toHaveCount(0);
  });

  test('has no archived toggle when nothing is archived', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardNote(1)] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    await expect(board(page).getByRole('article', { name: 'Note 1' })).toBeVisible();
    await expect(board(page).locator('#board-area').getByRole('button', { name: /^Archived/ })).toHaveCount(0);
  });

  test('is the first stop for the keyboard, ahead of the cards', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardNote(1, { archived: true }), boardFileCard(2, 'docs/a.html')] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const toggle = board(page).locator('#board-area').getByRole('button', { name: 'Archived (1)' });
    await expect(toggle).toBeVisible();
    // It comes before the canvas in the tab order, so a keyboard user does not tab through every card to reach it.
    await board(page).locator('#board-area .react-flow').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(board(page).locator('#board-area .react-flow')).toBeFocused();
  });

  test('draws a line between a card and a checkpoint with its label, and none to a thing that is not on the board', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({
      cards: [boardNote(1, { title: 'Export leaks memory' }), boardFileCard(2, 'docs/flow.png', { title: 'Export flow' })],
      links: [
        boardLink(1, boardId(1), 'checkpoint:reports-export-to-csv', 'found while'),
        boardLink(2, boardId(2), 'commit:billing api:a91f2e0'),
        boardLink(3, boardId(1), 'checkpoint:was-renamed', 'gone'),
        boardLink(4, boardId(2), `document:${boardId(99)}`),
        boardLink(5, boardId(1), boardId(2)),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Export leaks memory' })).toBeVisible();
    const edges = canvas.locator('#board-area .react-flow__edge');
    await expect(edges).toHaveCount(3);
    // Named by what they join, with the label, not by ids. The commit lane is already open inside the area, so the line goes directly to the commit.
    await expect(canvas.getByRole('img', { name: 'Link from Export leaks memory to Reports export to CSV: found while' })).toBeAttached();
    await expect(canvas.getByRole('img', { name: 'Link from Export flow to commit a91f2e0' })).toBeAttached();
    await expect(canvas.getByRole('img', { name: 'Link from Export leaks memory to Export flow' })).toBeAttached();
    await expect(canvas.locator('#board-area .react-flow__edge-text')).toHaveText(['found while']);
    await expect(canvas.getByRole('img', { name: /gone/ })).toHaveCount(0);
  });

  test('routes cards to areas by card.area, link, or fallback, with previews and cross-area edges at Level 0', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'First note', area: 'checkpoint:report-rows-load-fast' }),
        boardNote(2, { title: 'Plan note', area: 'plan:own' }),
        boardFileCard(3, 'docs/flow.png', { title: 'Export flow', area: 'checkpoint:reports-export-to-csv' }),
        boardNote(4, { title: 'Linked note' }),
        boardNote(5, { title: 'Fresh fallback note', area: 'checkpoint:was-renamed', at: minutesAgo(0), updatedAt: minutesAgo(0) }),
      ],
      links: [
        boardLink(1, boardId(4), 'checkpoint:report-rows-load-fast', 'related'),
        boardLink(2, boardId(1), boardId(3), 'cross link'),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);

    // Level 0: 3 areas
    const fastArea = canvas.locator('.board-overview-plane button.board-area').filter({ hasText: 'Report rows load fast' });
    const planArea = canvas.locator('.board-overview-plane button.board-area').filter({ hasText: 'Plan' });
    const currentArea = canvas.locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' });

    await expect(fastArea).toBeVisible();
    await expect(planArea).toBeVisible();
    await expect(currentArea).toBeVisible();

    // Fast area has 2 notes (1 explicit + 4 linked)
    await expect(fastArea).toContainText('2 notes');
    // Plan area has 1 note (2 explicit)
    await expect(planArea).toContainText('1 note');
    // Current area has 1 note (5 fallback) and 1 file (3 explicit)
    await expect(currentArea).toContainText('1 note');
    await expect(currentArea).toContainText('1 picture');

    // Picture preview on currentArea
    const previewImg = currentArea.locator('img');
    await expect(previewImg).toHaveAttribute('src', /\/api\/workspace\/demo\/documents\/file\?name=docs%2Fflow\.png$/);

    // Fresh glow on currentArea node (card 5 is fresh!)
    await expect(canvas.locator('#board-overview .react-flow__node').filter({ hasText: 'Reports export to CSV' }).locator('.board-fresh')).toBeAttached();

    // Cross-area edge at Level 0 between the two checkpoints
    const crossEdge = canvas.locator('#board-overview .react-flow__edge');
    await expect(crossEdge).toHaveCount(1);
    await expect(canvas.locator('#board-overview').getByRole('img', { name: /cross link/ })).toBeAttached();

    // Step into Report rows load fast
    await stepIntoArea(page, /Report rows load fast/);
    await expect(canvas.getByRole('article', { name: 'First note' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'Linked note' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'Plan note' })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'Export flow' })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'Fresh fallback note' })).toHaveCount(0);

    // Step out
    await canvas.getByRole('button', { name: 'Board ›' }).click();
    await viewAtRest(page);

    // Step into current area
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(canvas.getByRole('article', { name: 'Export flow' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'Fresh fallback note' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'First note' })).toHaveCount(0);
  });

  test('ignores a saved place inside an Area: cards stand on their step row, the others under "Not tied to a step", clear of each other', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({
      cards: [boardNote(1, { title: 'Placed note' }), boardNote(2, { title: 'Second note', step: undefined }), boardNote(3, { title: 'Third note', step: 'no-such-step' }), boardFileCard(4, 'docs/a.html', { title: 'A page', step: undefined })],
      positions: { [boardId(1)]: { x: 2300, y: 333 }, 'checkpoint:reports-export-to-csv': { x: 700, y: 520 }, 'commit:billing api:a91f2e0': { x: 2000, y: 90 } },
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Placed note' })).toBeVisible();
    // The saved place is kept in the file but not used: the card is on the row of its step, under the step's header
    const [head, placed] = await Promise.all([canvasBox(page, 'row:step:background-job-queue-for-large-exports'), canvasBox(page, boardId(1))]);
    expect(placed.y).toBeGreaterThanOrEqual(head.y + head.height);
    expect(placed.x).toBeLessThan(400);
    expect(await canvasPosition(page, 'checkpoint:reports-export-to-csv')).toEqual({ x: 0, y: 0 });
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeVisible();
    // The cards with no step, or a step this Area does not have, stand in a row of their own, clear of everything beside it
    const band = canvas.getByRole('button', { name: /Not tied to a step/ });
    await expect(band).toBeVisible();
    const lane = await canvasBox(page, 'lane:board');
    expect(lane.y).toBeGreaterThan(placed.y + placed.height);
    for (const id of ['lane:documents', 'checkpoint:reports-export-to-csv', boardId(1)]) {
      const box = await canvasBox(page, id);
      const apart = box.x + box.width <= lane.x || lane.x + lane.width <= box.x || box.y + box.height <= lane.y || lane.y + lane.height <= box.y;
      expect(apart).toBe(true);
    }
    for (const title of ['Second note', 'Third note', 'A page']) {
      expect((await canvasBox(page, title === 'Second note' ? boardId(2) : title === 'Third note' ? boardId(3) : boardId(4))).y).toBeGreaterThanOrEqual(lane.y + lane.height);
      await expect(canvas.getByRole('article', { name: title })).toBeVisible();
    }
  });

  test('highlights what an AI made or changed in the last minute, and nothing else, and does not animate for those who ask for less motion', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [
      boardNote(1, { title: 'Just made by claude', at: minutesAgo(0), updatedAt: minutesAgo(0) }),
      boardNote(2, { title: 'Changed by codex', at: minutesAgo(30), updatedBy: 'codex', updatedAt: minutesAgo(0) }),
      boardNote(3, { title: 'Made by you', by: 'user', updatedBy: 'user', at: minutesAgo(0), updatedAt: minutesAgo(0) }),
      boardNote(4, { title: 'Made a while ago', at: minutesAgo(5), updatedAt: minutesAgo(5) }),
      boardNote(5, { title: 'Changed by you since', at: minutesAgo(30), updatedBy: 'user', updatedAt: minutesAgo(0) }),
    ] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await revealAll(page);
    await expect(canvas.getByRole('article', { name: 'Made a while ago' })).toBeVisible();
    const glow = (title: string) => canvas.getByRole('article', { name: title }).locator('.board-fresh');
    await expect(glow('Just made by claude')).toHaveCount(1);
    await expect(glow('Changed by codex')).toHaveCount(1);
    for (const title of ['Made by you', 'Made a while ago', 'Changed by you since']) await expect(glow(title)).toHaveCount(0);
    await expect(glow('Just made by claude')).toHaveCSS('animation-name', 'board-fresh');
    await expect(glow('Just made by claude')).toHaveCSS('pointer-events', 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(glow('Just made by claude')).toHaveCSS('animation-name', 'board-fresh-still');
  });

  test('keeps every card in view whatever place it was given, and the keyboard reaches its buttons', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({
      cards: [boardFileCard(1, 'docs/far.html', { title: 'A card far away' })],
      positions: { [boardId(1)]: { x: 4200, y: 1800 } },
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    const far = canvas.getByRole('article', { name: 'A card far away' });
    await expect(far).toBeVisible();
    await expect.poll(() => isWithin(far, canvas.locator('#board-area .react-flow'))).toBe(true);
    await canvas.getByRole('button', { name: 'Open A card far away' }).focus();
    await expect(canvas.getByRole('button', { name: 'Open A card far away' })).toBeFocused();
    await expect.poll(() => isWithin(far, canvas.locator('#board-area .react-flow'))).toBe(true);
  });

  test('draws nothing of its own for a card with a path that leaves the workspace', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardFileCard(1, '../../etc/passwd', { title: 'Sneaky' }), boardFileCard(2, '/etc/passwd', { title: 'Sneakier' }), boardNote(3, { title: 'Fine' })] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    await expect(board(page).getByRole('article', { name: 'Fine' })).toBeVisible();
    await expect(board(page).getByRole('article', { name: /Sneak/ })).toHaveCount(0);
  });
});

test.describe('Board, reader', () => {
  // A large window: these specs put several cards, and often a document and a commit too, on screen at once, which a laptop-sized
  // canvas shows as folded rows and "+N more" (specs for that are under "Board, rows by step").
  test.use({ viewport: { width: 1800, height: 1200 } });

  const MODIFIED = '2026-10-22T00:00:00.000Z';
  /** The workspace folder, so a link can name a file by its full path. */
  const ROOT = workspace.workspacePath;
  const REQUIREMENTS = 'contextspace-document-1.md';
  const markdown = (content: string) => ({ kind: 'markdown', content });
  const FILES: Record<string, { kind: string; content?: string }> = {
    'docs/design.md': markdown('# The queue design\n\nLarge exports run in a background job.'),
    'docs/spec.md': markdown('# The CSV spec\n\nOne row per line.'),
    'overview.html': { kind: 'html', content: '<!doctype html><html><body><h1>The overview page</h1><script>window.unsafe = true</script></body></html>' },
    /** A page made for 1280 px, as a designer or an AI would write it: its width is in its own style. */
    'wide.html': { kind: 'html', content: '<!doctype html><html><head><style>body { margin: 0; } .page { width: 1280px; height: 240px; background: linear-gradient(90deg, #fde68a, #93c5fd); }</style></head><body><div class="page"><h1>A page made for 1280 px</h1></div></body></html>' },
    /** A page that gets its styling from a script on the internet, which the viewer says it runs. */
    'styled.html': { kind: 'html', content: '<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body><h1>The styled page</h1></body></html>' },
    'wide.svg': { kind: 'image' },
  };

  /** What the work route reads source documents as, by id: the text kept for them. */
  const SOURCES: Record<string, string> = {
    'export-requirements': '# Customers export reports\n\nUp to 50,000 rows as CSV.\n\nSee [the design](docs/design.md).',
  };

  const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
  const readerTitle = (page: Page, name: string) => reader(page).getByRole('heading', { name, level: 2, exact: true });
  const card = (page: Page, title: string) => board(page).getByRole('article', { name: title, exact: true });
  const opener = (page: Page, title: string) => card(page, title).getByRole('button', { name: `Open ${title}`, exact: true });

  /** The documents panel's preview request, answered from FILES; the names that were asked for are kept. */
  async function routeFiles(page: Page) {
    const asked: string[] = [];
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
      const name = new URL(route.request().url()).searchParams.get('name') ?? '';
      asked.push(name);
      const file = FILES[name];
      return file ? route.fulfill({ json: { name, size: 120, modifiedAt: MODIFIED, ...file } }) : route.fulfill({ status: 404, json: { error: 'No such document.' } });
    });
    await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: Object.entries(FILES).map(([name, file]) => ({ name, kind: file.kind, size: 120, modifiedAt: MODIFIED })) } }));
    return asked;
  }
  /**
   * The work route that reads a source document through the storage port, answered from SOURCES; the ids that were asked for are kept.
   * A source document is not read from the folder by the preview request, which is for the files of the workspace.
   */
  async function routeSources(page: Page) {
    const read: string[] = [];
    await page.route('**/api/workspace/demo/work/documents/*', (route) => {
      const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
      read.push(id);
      const content = SOURCES[id];
      return content === undefined
        ? route.fulfill({ status: 400, json: { error: 'Source document not found.' } })
        : route.fulfill({ json: { document: document('Export requirements', { filename: REQUIREMENTS }), content, location: `${ROOT}/${REQUIREMENTS}` } });
    });
    return read;
  }
  /** What this browser remembers of how the reader is shown. */
  const LAYOUT_KEY = 'contextspace_board_reader_layout_v1';
  const storedLayout = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY);
  /** The viewer has chosen "Side by side", unless this browser has a choice already: the specs of the docked reader. */
  const dockReader = (page: Page) => page.addInitScript((key) => { if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, 'side'); }, LAYOUT_KEY);
  /**
   * The board of the specs: a source document that is kept as a file, and a few cards, one of each kind the reader opens. The reader is
   * docked beside the canvas, as the viewer may choose, except where `layout` is 'default': then nothing is chosen, and it is the large window.
   */
  async function openBoard(page: Page, cards: Array<Record<string, unknown>> = [], positions: Record<string, { x: number; y: number }> = FILE_PLACES, layout: 'side' | 'default' = 'side') {
    await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed'); });
    if (layout === 'side') await dockReader(page);
    await routeBoard(page);
    await routeWork(page, [
      document('Export requirements', { role: 'requirements', filename: REQUIREMENTS, summary: 'Customers export their reports as CSV.' }),
      document('Pricing sheet', { url: 'https://example.com/pricing', summary: 'Kept on the web.' }),
      document('Loose notes', { summary: 'Neither a file nor a link.' }),
    ]);
    await routeCards(page, boardFile({ cards, positions }));
    await routeSources(page);
    const asked = await routeFiles(page);
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/);
    return asked;
  }
  const FILE_CARDS = [
    boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec', description: 'What a row looks like.', at: minutesAgo(10), updatedAt: minutesAgo(10) }),
    boardFileCard(2, 'overview.html', { title: 'Overview page', description: 'Start with the diagram.', at: minutesAgo(11), updatedAt: minutesAgo(11) }),
  ];
  /** Under the checkpoints, in sight when the board opens: the first stands where the reader will not be, the second where it will. */
  const FILE_PLACES = { [boardId(1)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 } };

  test('opens a document card in a reader beside the board, with its content, and the board stays in view', async ({ page }) => {
    const asked = await openBoard(page, FILE_CARDS);
    const sources = await routeSources(page);
    await expect(reader(page)).toHaveCount(0);
    await opener(page, 'Export requirements').click();
    await expect(reader(page)).toBeVisible();
    await expect(readerTitle(page, 'Export requirements')).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
    await expect(reader(page)).toContainText('Up to 50,000 rows as CSV.');
    // A source document is read through the work route, as the rest of the app reads them, and not from the folder by the preview request.
    expect([...new Set(sources)]).toEqual(['export-requirements']);
    expect(asked).toEqual([]);
    await expect(reader(page).getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
    // It is on the right, about 45% of the section and not under 360 px; the canvas is still there, on its left.
    const [section, panel, canvas] = await Promise.all([board(page).locator('#board-area').boundingBox(), reader(page).boundingBox(), board(page).locator('#board-area .react-flow').boundingBox()]);
    expect(Math.abs(panel!.width - section!.width * 0.45)).toBeLessThanOrEqual(2);
    expect(panel!.width).toBeGreaterThanOrEqual(360);
    expect(Math.abs(panel!.x + panel!.width - (section!.x + section!.width))).toBeLessThanOrEqual(1);
    expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(panel!.x + 1);
    await expect(board(page).getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
    // Inside an Area the view is fixed: no zoom controls and no map
    await expect(board(page).locator('#board-area').getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
    await expect(board(page).locator('#board-area .react-flow__minimap')).toHaveCount(0);
  });

  test('opens a file card in the reader, and another card replaces what it shows', async ({ page }) => {
    const asked = await openBoard(page, FILE_CARDS);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
    // A file of the workspace can be downloaded; it is read by the documents panel's preview request.
    await expect(reader(page).getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', /name=docs%2Fspec\.md&download=1$/);
    await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    // The second card may be out of sight beside the reader: the keyboard brings it into view.
    await opener(page, 'Overview page').focus();
    await page.keyboard.press('Enter');
    await expect(readerTitle(page, 'Overview page')).toBeVisible();
    await expect(readerTitle(page, 'The CSV spec')).toHaveCount(0);
    await expect(reader(page)).toHaveCount(1);
    expect([...new Set(asked)]).toEqual(['docs/spec.md', 'overview.html']);
  });

  test('keeps a page\'s HTML out of the board: it is drawn in the sandboxed frame', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await opener(page, 'Overview page').click();
    const frame = reader(page).locator('iframe[title="Preview of overview.html"]');
    await expect(frame).toBeVisible();
    // Its scripts run by default, and the frame never shares the app's origin.
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(page.frameLocator('iframe[title="Preview of overview.html"]').getByRole('heading', { name: 'The overview page' })).toBeVisible();
    // Neither the page's text nor its script is in the board's own page.
    await expect(board(page).getByText('The overview page')).toHaveCount(0);
    expect(await page.evaluate(() => 'unsafe' in window)).toBe(false);
  });

  test('marks the card that is open in the reader, and only that one', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await expect(board(page).locator('[aria-current="true"]')).toHaveCount(0);
    await opener(page, 'The CSV spec').click();
    await expect(card(page, 'The CSV spec')).toHaveAttribute('aria-current', 'true');
    await expect(card(page, 'The CSV spec')).toHaveClass(/ring-2/);
    await opener(page, 'Overview page').focus();
    await page.keyboard.press('Enter');
    await expect(card(page, 'Overview page')).toHaveAttribute('aria-current', 'true');
    await expect(card(page, 'The CSV spec')).not.toHaveAttribute('aria-current', /.*/);
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await expect(board(page).locator('[aria-current="true"]')).toHaveCount(0);
  });

  test('opens a document that is a link on the web, and leaves one that is neither a file nor a link alone', async ({ page }) => {
    await openBoard(page);
    const link = card(page, 'Pricing sheet').getByRole('link', { name: 'Open Pricing sheet (opens outside the app)' });
    await expect(link).toHaveAttribute('href', 'https://example.com/pricing');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(card(page, 'Loose notes').getByRole('button')).toHaveCount(0);
    await expect(card(page, 'Loose notes').getByRole('link')).toHaveCount(0);
    await expect(card(page, 'Export requirements').getByRole('button', { name: 'Open Export requirements' })).toBeVisible();
  });

  test('takes the keyboard in when it opens, and gives it back to the card\'s button when Escape or Close closes it', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    const button = opener(page, 'The CSV spec');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(readerTitle(page, 'The CSV spec')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(button).toBeFocused();
    // The mouse opens it, and Close closes it.
    await button.click();
    await expect(reader(page)).toBeVisible();
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await expect(reader(page)).toHaveCount(0);
    await expect(button).toBeFocused();
    // Escape works from the board too, and from a button of the reader.
    await button.click();
    await board(page).locator('#board-area .react-flow').focus();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await button.click();
    await reader(page).getByRole('button', { name: 'Open in Docs' }).focus();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('leaves Escape to a dialog that is open over the board', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    await openBoard(page, [FILE_CARDS[0], boardNote(3, { title: 'A long note', body })], { [boardId(1)]: FILE_PLACES[boardId(1)], [boardId(3)]: { x: 1100, y: 240 } });
    await opener(page, 'The CSV spec').click();
    await board(page).getByRole('button', { name: 'Read all of A long note' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
  });

  test('respects 3-layer Escape precedence: Read all dialog -> BoardReader -> Stepped-in Area -> Level 0 Board', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    await openBoard(page, [FILE_CARDS[0], boardNote(3, { title: 'A long note', body })], { [boardId(1)]: FILE_PLACES[boardId(1)], [boardId(3)]: { x: 1100, y: 240 } });

    // 1. Area is stepped in
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();

    // 2. Open BoardReader
    await opener(page, 'The CSV spec').click();
    await expect(reader(page)).toBeVisible();

    // 3. Open Read all dialog over everything
    await board(page).getByRole('button', { name: 'Read all of A long note' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toBeVisible();

    // Layer 1: First Escape closes the dialog only
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();

    // Layer 2: Second Escape closes BoardReader only
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();

    // Layer 3: Third Escape steps out of the Area to Level 0 Overview
    await page.keyboard.press('Escape');
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toHaveCount(0);
    await expect(board(page).locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
  });

  test('goes to the Docs tab with "Open in Docs", with the file open there, from the large window', async ({ page }) => {
    const asked = await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
    await opener(page, 'Overview page').click();
    await expect(readerTitle(page, 'Overview page')).toBeVisible();
    await reader(page).getByRole('button', { name: 'Open in Docs' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/documents$/);
    await expect(page.getByTitle('Preview of overview.html').first()).toBeVisible();
    expect(asked).toContain('overview.html');
  });

  test('says why a file could not be read, and reads it again on request', async ({ page }) => {
    await openBoard(page, [boardFileCard(3, 'docs/gone.md', { title: 'A file that is gone' })], { [boardId(3)]: { x: 800, y: 240 } });
    let there = false;
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => (there
      ? route.fulfill({ json: { name: 'docs/gone.md', size: 12, modifiedAt: MODIFIED, ...markdown('# Back again') } })
      : route.fulfill({ status: 404, json: { error: 'No such document.' } })));
    await opener(page, 'A file that is gone').click();
    await expect(reader(page).getByRole('alert')).toContainText('No such document.');
    there = true;
    await reader(page).getByRole('button', { name: 'Retry preview' }).click();
    await expect(reader(page).getByRole('heading', { name: 'Back again', level: 1 })).toBeVisible();
    await expect(reader(page).getByRole('alert')).toHaveCount(0);
  });

  test('follows a link in the document to another file of the workspace, in the same reader', async ({ page }) => {
    const asked = await openBoard(page);
    await opener(page, 'Export requirements').click();
    await reader(page).getByRole('link', { name: 'the design' }).click();
    await expect(readerTitle(page, 'design.md')).toBeVisible();
    // The source document came from the work route; the file it links to is a plain file of the workspace.
    expect([...new Set(asked)]).toEqual(['docs/design.md']);
    await expect(reader(page).getByRole('heading', { name: 'The queue design', level: 1 })).toBeVisible();
    // It was not a card that was opened, so no card is marked; and the keyboard goes back to the card that began it.
    await expect(board(page).locator('[aria-current="true"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(opener(page, 'Export requirements')).toBeFocused();
  });

  test('covers the canvas where the section is too narrow for both, and has a Close that gives it back', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 });
    await openBoard(page, FILE_CARDS);
    // On a small screen the row is too narrow for both cards: the second is behind "+N more"; the card comes first, newest first.
    const button = opener(page, 'The CSV spec');
    await reveal(page, card(page, 'The CSV spec'));
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    const [body, panel] = await Promise.all([board(page).locator('#board-area .react-flow').boundingBox(), reader(page).boundingBox()]);
    expect(Math.abs(panel!.width - body!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel!.x - body!.x)).toBeLessThanOrEqual(1);
    // The canvas waits under it, out of the keyboard's reach.
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await expect(reader(page)).toHaveCount(0);
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(card(page, 'The CSV spec')).toBeInViewport();
  });

  test('keeps the view fixed when the reader docks: the rows are laid out again for the canvas it leaves, and the opened card stays whole beside it', async ({ page }) => {
    await openBoard(page, [boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec' })], {});
    const view = await transformOf(page);
    expect(view.scale).toBeCloseTo(0.9, 5);
    const flow = board(page).locator('#board-area .react-flow');
    const wide = (await flow.boundingBox())!;
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    const free = (await reader(page).boundingBox())!;
    await expect.poll(async () => { const box = (await card(page, 'The CSV spec').boundingBox())!; return box.x + box.width <= free.x; }).toBe(true);
    await expect.poll(async () => (await flow.boundingBox())!.width).toBeLessThan(wide.width);
    await viewAtRest(page);
    expect(await transformOf(page)).toEqual(view);
    await expect.poll(() => isWithin(card(page, 'The CSV spec'), flow)).toBe(true);
    // Closing gives the canvas back, and the view is where it was
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await viewAtRest(page);
    expect(await transformOf(page)).toEqual(view);
  });

  test('is not the user taking the view: it still follows a part that arrives after the reader opened and closed', async ({ page }) => {
    const release = await routeLateCommits(page);
    await dockReader(page);
    await routeCards(page, boardFile({ cards: [FILE_CARDS[0]], positions: { [boardId(1)]: { x: 800, y: 240 } } }));
    await routeFiles(page);
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/, { allowLoading: true });
    const canvas = board(page);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    await expect.poll(() => isWithin(card(page, 'The CSV spec'), canvas.locator('#board-area .react-flow'))).toBe(true);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    release();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeAttached();
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'a91f2e0' }), canvas.locator('#board-area .react-flow'))).toBe(true);
  });

  test('cannot be panned by a drag on the empty canvas, so a link in the reader opening another file leaves the view where it is', async ({ page }) => {
    await openBoard(page);
    await opener(page, 'Export requirements').click();
    await expect(reader(page).getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
    const before = await transformOf(page);
    const area = (await board(page).locator('#board-area .react-flow').boundingBox())!;
    await page.mouse.move(area.x + 60, area.y + area.height - 30);
    await page.mouse.down();
    await page.mouse.move(area.x + 60, area.y - 20, { steps: 8 });
    await page.mouse.up();
    await page.mouse.wheel(0, 300);
    await viewAtRest(page);
    expect(await transformOf(page)).toEqual(before);
    await reader(page).getByRole('link', { name: 'the design' }).click();
    await expect(readerTitle(page, 'design.md')).toBeVisible();
    await frames(page, 12);
    expect(await transformOf(page)).toEqual(before);
  });

  test('moves the keyboard to the reader when the window narrows until it covers the canvas, and Escape still closes it', async ({ page }) => {
    await openBoard(page, [FILE_CARDS[0]!]);
    const button = opener(page, 'The CSV spec');
    await reveal(page, card(page, 'The CSV spec'));
    await button.click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    // The keyboard is on the card again (the reader took it when it opened).
    await button.focus();
    await expect(button).toBeFocused();
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
    // The canvas is out of reach under the reader: the card that had the keyboard cannot keep it.
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
    await expect(readerTitle(page, 'The CSV spec')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('leaves the keyboard where it is when the canvas comes to be covered while it is outside the board', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    // The sidebar's field goes when the window narrows; the workspace header stays.
    const field = page.getByRole('button', { name: /^Copy branch name/ });
    await field.focus();
    await expect(field).toBeFocused();
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
    await frames(page, 30);
    await expect(field).toBeFocused();
    await expect(readerTitle(page, 'The CSV spec')).not.toBeFocused();
  });

  test('does not take the keyboard from the reader when the canvas comes to be covered while it is on one of its buttons', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await opener(page, 'The CSV spec').click();
    const docs = reader(page).getByRole('button', { name: 'Open in Docs' });
    await docs.focus();
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
    await expect(docs).toBeFocused();
  });

  test('closes with Escape when the keyboard has dropped to the page itself', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    const button = opener(page, 'The CSV spec');
    await reveal(page, card(page, 'The CSV spec'));
    await button.click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator('body')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
  });

  test('does not close the reader behind another section when Escape is pressed there', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await workspaceNav(page).getByRole('link', { name: 'Plan' }).click();
    await expect(board(page)).toBeHidden();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    // The board stays mounted behind the other sections, with its reader as it was.
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
  });

  test.describe('in a large window', () => {
    /** The dimmed board the window stands on: it fills the Board section, under the window. */
    const behind = (page: Page) => reader(page).locator('xpath=..');
    const backButton = (page: Page) => reader(page).getByRole('button', { name: 'Back to board', exact: true });
    const sideBySide = (page: Page) => reader(page).getByRole('button', { name: 'Side by side', exact: true });
    const large = (page: Page) => reader(page).getByRole('button', { name: 'Large', exact: true });
    /** The documents panel's file request, answered with a picture that is wider than any window. */
    async function routeWidePicture(page: Page) {
      await page.route('**/api/workspace/demo/documents/file**', (route) => route.fulfill({
        contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="900"><rect width="2400" height="900" fill="#93c5fd"/></svg>',
      }));
    }
    /** The frame of an HTML page in the reader: its document, which the board cannot measure but the browser's tools can. */
    async function pageFrame(page: Page, name: string) {
      const frame = await reader(page).locator(`iframe[title="Preview of ${name}"]`).elementHandle();
      return (await frame!.contentFrame())!;
    }
    const fit = (frame: Awaited<ReturnType<typeof pageFrame>>) => frame.evaluate(() => ({
      width: document.documentElement.scrollWidth, room: document.documentElement.clientWidth, zoom: Number(document.body.style.zoom || 1),
    }));

    test('opens a file in a large window over the board: about 92% by 88% of the section, centred, with the board dimmed but in sight all round it', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await expect(reader(page)).toHaveCount(0);
      const view = await transformOf(page);
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      await expect(reader(page).getByRole('button', { name: 'Open in Docs', exact: true })).toBeVisible();
      const [area, win, canvas] = await Promise.all([behind(page).boundingBox(), reader(page).boundingBox(), board(page).locator('#board-area .react-flow').boundingBox()]);
      expect(Math.abs(win!.width / area!.width - 0.92)).toBeLessThan(0.005);
      expect(Math.abs(win!.height / area!.height - 0.88)).toBeLessThan(0.005);
      // Centred, and the dimmed board shows on every side of it.
      expect(Math.abs((win!.x - area!.x) - (area!.x + area!.width - win!.x - win!.width))).toBeLessThanOrEqual(1);
      expect(Math.abs((win!.y - area!.y) - (area!.y + area!.height - win!.y - win!.height))).toBeLessThanOrEqual(1);
      expect(win!.x - canvas!.x).toBeGreaterThan(40);
      expect(win!.y - canvas!.y).toBeGreaterThan(20);
      expect(canvas!.x + canvas!.width - (win!.x + win!.width)).toBeGreaterThan(40);
      expect(canvas!.y + canvas!.height - (win!.y + win!.height)).toBeGreaterThan(20);
      // The board is still drawn under the dimming, where it was: the view did not move, and the card that was opened is marked.
      await expect(board(page).getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
      await expect(card(page, 'The CSV spec')).toHaveAttribute('aria-current', 'true');
      expect(await transformOf(page)).toEqual(view);
      // A press beside the window lands on the dimmed board and not on the canvas under it, which waits out of the keyboard's reach.
      expect(await behind(page).evaluate((element, spot) => document.elementFromPoint(spot.x, spot.y) === element, { x: area!.x + 8, y: area!.y + 8 })).toBe(true);
      await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
      await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    });

    test('opens a source document in the large window too, and a link in a note', async ({ page }) => {
      await openBoard(page, [boardNote(1, { title: 'Links', body: 'See [the spec](docs/spec.md).' })], { [boardId(1)]: { x: 800, y: 240 } }, 'default');
      await board(page).getByRole('article', { name: 'Links' }).getByRole('link', { name: 'the spec' }).click();
      await expect(readerTitle(page, 'spec.md')).toBeFocused();
      await expect(behind(page)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(board(page).getByRole('article', { name: 'Links' }).getByRole('link', { name: 'the spec' })).toBeFocused();
      await opener(page, 'Export requirements').click();
      await expect(reader(page).getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
      expect(Math.abs((await reader(page).boundingBox())!.width / (await behind(page).boundingBox())!.width - 0.92)).toBeLessThan(0.005);
    });

    test('closes with Escape, with "Back to board" and with a click on the board behind it, and gives the keyboard back to the card', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'The CSV spec');
      // Escape.
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(readerTitle(page, 'The CSV spec')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
      await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
      // Back to board.
      await button.click();
      await expect(backButton(page)).toBeVisible();
      await backButton(page).click();
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
      // A click on the dimmed board behind the window, which is beside it and not in it.
      await button.click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const area = (await behind(page).boundingBox())!;
      await page.mouse.click(area.x + 10, area.y + 10);
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
      // Escape from a button of the window works as well.
      await button.click();
      await reader(page).getByRole('button', { name: 'Open in Docs' }).focus();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('stays open for a press or a drag in the window, even one that ends on the board behind it', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await opener(page, 'The CSV spec').click();
      const heading = reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 });
      await heading.click();
      await expect(reader(page)).toBeVisible();
      // Selecting text from inside the window out to the board behind it is not a click on the board.
      const [text, area] = await Promise.all([heading.boundingBox(), behind(page).boundingBox()]);
      await page.mouse.move(text!.x + 4, text!.y + text!.height / 2);
      await page.mouse.down();
      await page.mouse.move(area!.x + 6, area!.y + 6, { steps: 6 });
      await page.mouse.up();
      await frames(page);
      await expect(reader(page)).toBeVisible();
    });

    test('stays open for a press that begins on the board behind the window and ends in it', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const [area, text] = await Promise.all([behind(page).boundingBox(), reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 }).boundingBox()]);
      await page.mouse.move(area!.x + 8, area!.y + 8);
      await page.mouse.down();
      await page.mouse.move(text!.x + 10, text!.y + text!.height / 2, { steps: 6 });
      await page.mouse.up();
      await frames(page);
      await expect(reader(page)).toBeVisible();
      // And a press and a release that are both on the board close it, as before.
      await page.mouse.move(area!.x + 8, area!.y + 8);
      await page.mouse.down();
      await page.mouse.move(area!.x + 14, area!.y + area!.height - 8, { steps: 4 });
      await page.mouse.up();
      await expect(reader(page)).toHaveCount(0);
    });

    test('closes with Escape pressed in the HTML page itself, and gives the keyboard back to the card', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'Overview page');
      await button.click();
      const inside = page.frameLocator('iframe[title="Preview of overview.html"]');
      await expect(inside.getByRole('heading', { name: 'The overview page' })).toBeVisible();
      // The keyboard is in the page, where a key never reaches the board.
      await inside.getByRole('heading', { name: 'The overview page' }).click();
      await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toBeFocused();
      // Another window, or the board's own page, saying the same words is not Escape.
      await page.evaluate(() => window.postMessage('contextspace:escape', '*'));
      await frames(page, 6);
      await expect(reader(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('takes the whole height of the window for a page, which scrolls by itself: nothing scrolls twice', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openBoard(page, [boardFileCard(3, 'wide.html', { title: 'Wide page' }), FILE_CARDS[0]], { [boardId(3)]: { x: 800, y: 240 }, [boardId(1)]: { x: 1100, y: 240 } }, 'default');
      await opener(page, 'Wide page').click();
      const frame = reader(page).locator('iframe[title="Preview of wide.html"]');
      await expect(frame).toBeVisible();
      const holder = frame.locator('xpath=..');
      // The body of the window does not scroll, and the frame fills what is left of it, inside the body's padding.
      await expect.poll(async () => {
        const [inner, shown] = await Promise.all([holder.evaluate((element) => ({ top: element.getBoundingClientRect().top, height: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY })), frame.boundingBox()]);
        return inner.overflow === 'hidden' && inner.scroll <= inner.height && Math.abs(shown!.height - (inner.height - 32)) <= 2;
      }).toBe(true);
      // A frame that fills it is taller than the share of the screen it had before.
      expect((await frame.boundingBox())!.height).toBeGreaterThan(750);
      // A document that is not a page still scrolls in the body.
      await reader(page).getByRole('button', { name: 'Back to board' }).click();
      await opener(page, 'The CSV spec').click();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      expect(await reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 }).evaluate((element) => {
        let holder = element.parentElement;
        while (holder && getComputedStyle(holder).overflowY !== 'auto') holder = holder.parentElement;
        return Boolean(holder);
      })).toBe(true);
    });

    test('docks beside the board with "Side by side", comes back with "Large", and remembers the choice after a reload', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      expect(await storedLayout(page)).toBeNull();
      await opener(page, 'The CSV spec').click();
      await expect(large(page)).toHaveCount(0);
      await sideBySide(page).click();
      // Beside the canvas, as before: about 45% of the section on its right, the canvas free again, and Close in place of Back to board.
      await expect(large(page)).toBeVisible();
      await expect(backButton(page)).toHaveCount(0);
      await expect(reader(page).getByRole('button', { name: 'Close', exact: true })).toBeVisible();
      await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
      const [section, panel] = await Promise.all([board(page).locator('#board-area').boundingBox(), reader(page).boundingBox()]);
      expect(Math.abs(panel!.width - section!.width * 0.45)).toBeLessThanOrEqual(2);
      expect(Math.abs(panel!.x + panel!.width - (section!.x + section!.width))).toBeLessThanOrEqual(1);
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      expect(await storedLayout(page)).toBe('side');
      // Kept for the next visit.
      await page.reload();
      await stepIntoArea(page, /Reports export to CSV/);
      await opener(page, 'The CSV spec').click();
      await expect(large(page)).toBeVisible();
      expect(Math.abs((await reader(page).boundingBox())!.width - (await board(page).locator('#board-area').boundingBox())!.width * 0.45)).toBeLessThanOrEqual(2);
      // And back to the window, kept the same way.
      await large(page).click();
      await expect(sideBySide(page)).toBeVisible();
      await expect(backButton(page)).toBeVisible();
      await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
      expect(await storedLayout(page)).toBe('large');
      await page.reload();
      await stepIntoArea(page, /Reports export to CSV/);
      await opener(page, 'The CSV spec').click();
      await expect(backButton(page)).toBeVisible();
    });

    test('keeps what is open, and where the keyboard is, when it changes between the window and the dock', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'The CSV spec');
      await button.click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      await sideBySide(page).click();
      await expect(large(page)).toBeFocused();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      await large(page).click();
      await expect(sideBySide(page)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('lays the rows out again for the canvas the dock leaves, without moving the view', async ({ page }) => {
      await openBoard(page, [boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec' })], {}, 'default');
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const view = await transformOf(page);
      await sideBySide(page).click();
      const free = (await reader(page).boundingBox())!;
      await expect.poll(async () => { const box = (await card(page, 'The CSV spec').boundingBox())!; return box.x + box.width <= free.x; }).toBe(true);
      await viewAtRest(page);
      expect(await transformOf(page)).toEqual(view);
    });

    test('offers no dock where the section is too narrow for both, and the window still fits', async ({ page }) => {
      await page.setViewportSize({ width: 820, height: 900 });
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'The CSV spec');
      await reveal(page, card(page, 'The CSV spec'));
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(readerTitle(page, 'The CSV spec')).toBeFocused();
      await expect(sideBySide(page)).toHaveCount(0);
      await expect(backButton(page)).toBeVisible();
      expect(Math.abs((await reader(page).boundingBox())!.width / (await behind(page).boundingBox())!.width - 0.92)).toBeLessThan(0.005);
      await backButton(page).click();
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('fits an HTML page that is wider than the window to its width, and again when the window changes size', async ({ page }) => {
      await openBoard(page, [boardFileCard(3, 'wide.html', { title: 'Wide page' })], { [boardId(3)]: { x: 800, y: 240 } }, 'default');
      await opener(page, 'Wide page').click();
      const frameBox = reader(page).locator('iframe[title="Preview of wide.html"]');
      await expect(frameBox).toBeVisible();
      const frame = await pageFrame(page, 'wide.html');
      // The page is 1280 px wide and the window is not: it is scaled down to fit and not scrolled sideways.
      expect((await frameBox.boundingBox())!.width).toBeLessThan(1280);
      await expect.poll(async () => { const now = await fit(frame); return now.width <= now.room && now.zoom < 1; }).toBe(true);
      const first = await fit(frame);
      expect(first.zoom).toBeGreaterThan(0.4);
      // Nothing in the window scrolls sideways either.
      expect(await reader(page).evaluate((element) => Array.from(element.querySelectorAll<HTMLElement>('*'))
        .filter((node) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowX)).every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
      // A narrower window scales it further.
      await page.setViewportSize({ width: 1150, height: 900 });
      await expect.poll(async () => { const now = await fit(frame); return now.width <= now.room && now.zoom < first.zoom; }).toBe(true);
      // Never smaller than half: a page that is more than twice the window's width is scaled to half and left to scroll.
      await page.setViewportSize({ width: 700, height: 900 });
      await expect.poll(async () => (await frameBox.boundingBox())!.width).toBeLessThan(640);
      await expect.poll(async () => { const now = await fit(frame); return now.zoom === 0.5 && now.width > now.room; }).toBe(true);
      // One that is wider than the page leaves it as it was made.
      await page.setViewportSize({ width: 2000, height: 900 });
      await expect.poll(async () => { const now = await fit(frame); return now.zoom === 1 && now.width <= now.room; }).toBe(true);
    });

    test('leaves a page that fits as it is, and a page whose scripts are stopped keeps today\'s behaviour', async ({ page }) => {
      await openBoard(page, [FILE_CARDS[1], boardFileCard(3, 'wide.html', { title: 'Wide page' })], { [boardId(2)]: { x: 1100, y: 240 }, [boardId(3)]: { x: 800, y: 240 } }, 'default');
      await opener(page, 'Overview page').click();
      await expect(page.frameLocator('iframe[title="Preview of overview.html"]').getByRole('heading', { name: 'The overview page' })).toBeVisible();
      await frames(page, 8);
      expect((await fit(await pageFrame(page, 'overview.html'))).zoom).toBe(1);
      await backButton(page).click();
      // With the scripts stopped nothing runs in the frame to scale the page: it is as wide as it was made.
      await opener(page, 'Wide page').click();
      await expect.poll(async () => (await fit(await pageFrame(page, 'wide.html'))).zoom < 1).toBe(true);
      await reader(page).getByRole('button', { name: 'Stop scripts', exact: true }).click();
      await expect(reader(page).locator('iframe[title="Preview of wide.html"]')).toHaveAttribute('sandbox', '');
      await expect(page.frameLocator('iframe[title="Preview of wide.html"]').getByRole('heading', { name: 'A page made for 1280 px' })).toBeVisible();
      await frames(page, 8);
      const locked = await fit(await pageFrame(page, 'wide.html'));
      expect(locked.zoom).toBe(1);
      expect(locked.width).toBeGreaterThan(locked.room);
    });

    test('fits a picture to the window', async ({ page }) => {
      await routeWidePicture(page);
      await openBoard(page, [boardFileCard(3, 'wide.svg', { title: 'Wide picture' })], { [boardId(3)]: { x: 800, y: 240 } }, 'default');
      await opener(page, 'Wide picture').click();
      const picture = reader(page).getByRole('img', { name: 'wide.svg' });
      await expect(picture).toBeVisible();
      await expect.poll(async () => (await picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth))).toBe(2400);
      const [win, shown] = await Promise.all([reader(page).boundingBox(), picture.boundingBox()]);
      expect(shown!.width).toBeLessThan(2400);
      expect(shown!.x).toBeGreaterThanOrEqual(win!.x);
      expect(shown!.x + shown!.width).toBeLessThanOrEqual(win!.x + win!.width);
      expect(await picture.evaluate((image) => {
        let holder = image.parentElement;
        while (holder && !['auto', 'scroll'].includes(getComputedStyle(holder).overflowX)) holder = holder.parentElement;
        return holder ? holder.scrollWidth <= holder.clientWidth : true;
      })).toBe(true);
    });

    test('runs the scripts of an HTML page by default, with no prompt, and "Stop scripts" puts that page back in the locked mode', async ({ page }) => {
      await openBoard(page, [boardFileCard(3, 'styled.html', { title: 'Styled page' }), FILE_CARDS[1]], { [boardId(3)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 } }, 'default');
      await opener(page, 'Styled page').click();
      const frame = reader(page).locator('iframe[title="Preview of styled.html"]');
      const srcdoc = () => frame.evaluate((element: HTMLIFrameElement) => element.srcdoc);
      await expect(frame).toBeVisible();
      await expect(reader(page).getByRole('button', { name: /^Trust/ })).toHaveCount(0);
      await expect(reader(page).getByText('Trust the document')).toHaveCount(0);
      // Trusted from the start: the script of the internet is in the page, and the frame is still an opaque origin.
      await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
      expect(await srcdoc()).toMatch(/<script src="https:\/\/cdn\.tailwindcss\.com\/"><\/script>/);
      expect(await srcdoc()).toContain('script-src');
      await expect(reader(page).getByText('This page runs scripts from the internet in a sandboxed frame', { exact: false })).toBeVisible();
      // Stop scripts: the same page, locked.
      await reader(page).getByRole('button', { name: 'Stop scripts', exact: true }).click();
      await expect(frame).toHaveAttribute('sandbox', '');
      expect(await srcdoc()).not.toContain('script-src');
      expect(await srcdoc()).not.toContain('<script');
      await expect(reader(page).getByText('Scripts are stopped', { exact: false })).toBeVisible();
      await expect(reader(page).getByRole('button', { name: 'Stop scripts', exact: true })).toHaveCount(0);
      // It can be run again, and another page starts with its scripts running whatever was done to this one.
      await reader(page).getByRole('button', { name: 'Run scripts', exact: true }).click();
      await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
      await reader(page).getByRole('button', { name: 'Stop scripts', exact: true }).click();
      await expect(frame).toHaveAttribute('sandbox', '');
      await backButton(page).click();
      await opener(page, 'Overview page').click();
      await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toHaveAttribute('sandbox', 'allow-scripts');
      await expect(reader(page).getByRole('button', { name: 'Stop scripts', exact: true })).toBeVisible();
    });
  });

  test.describe('links in text', () => {
    const NOTES = [
      boardNote(1, { title: 'Links', body: 'Read [the CSV spec](https://example.com/spec) and [the file](docs/spec.md), or [by its full path](' + ROOT + '/docs/spec.md) or [as a file address](file://' + ROOT + '/docs/spec.md).' }),
      boardNote(2, { title: 'Not links', body: '[click me](javascript:alert(1)) [mail me](mailto:me@example.com) [data](data:text/html,hi) [ftp](ftp://example.com/x) [up](../../secret.md) [here](#top) ![chart](https://example.com/chart.png)' }),
      boardFileCard(3, 'docs/design.md', { title: 'The design', description: 'Per [the queue design](https://example.com/queue) and **bold** text.' }),
    ];
    const PLACES = { [boardId(1)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 }, [boardId(3)]: { x: 800, y: 560 } };
    async function openNotes(page: Page) {
      // A new tab is not the page: the context's routes cover it, and nothing reaches the network.
      await page.context().route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Example</title><p>An example page.</p>' }));
      const asked = await openBoard(page, NOTES, PLACES);
      await revealAll(page);
      return asked;
    }

    test('opens an https link in a new tab, safely, without moving the card or the view', async ({ page }) => {
      await openNotes(page);
      const link = card(page, 'Links').getByRole('link', { name: /the CSV spec/ });
      await expect(link).toHaveAttribute('href', 'https://example.com/spec');
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      // A press on it is neither a drag nor a pan.
      await expect(link).toHaveClass(/nodrag/);
      await expect(link).toHaveClass(/nopan/);
      const place = await canvasPosition(page, boardId(1));
      const view = await transformOf(page);
      const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      expect(popup.url()).toBe('https://example.com/spec');
      // The tab was answered by the test's own route: nothing went to the network.
      await expect(popup).toHaveTitle('Example');
      await popup.close();
      expect(await canvasPosition(page, boardId(1))).toEqual(place);
      expect(await transformOf(page)).toEqual(view);
      await expect(reader(page)).toHaveCount(0);
      // The link on a file card's description works the same way.
      await expect(card(page, 'The design').getByRole('link', { name: /the queue design/ })).toHaveAttribute('href', 'https://example.com/queue');
      await expect(card(page, 'The design').locator('strong')).toHaveText('bold');
    });

    test('does not drag the card when a link is pressed and the pointer moves a little', async ({ page }) => {
      await openNotes(page);
      const link = card(page, 'Links').getByRole('link', { name: /the CSV spec/ });
      const place = await canvasPosition(page, boardId(1));
      const box = (await link.boundingBox())!;
      await page.mouse.move(box.x + 4, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 24, box.y + box.height / 2 + 20, { steps: 4 });
      await page.mouse.up();
      await frames(page);
      expect(await canvasPosition(page, boardId(1))).toEqual(place);
    });

    test('opens a link to a file of the workspace in the reader, by a relative path, a full path or a file address', async ({ page }) => {
      const asked = await openNotes(page);
      for (const text of ['the file', 'by its full path', 'as a file address']) {
        await card(page, 'Links').getByRole('link', { name: text }).click();
        await expect(readerTitle(page, 'spec.md')).toBeVisible();
        await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
        await reader(page).getByRole('button', { name: 'Close' }).click();
        await expect(reader(page)).toHaveCount(0);
      }
      expect(new Set(asked)).toEqual(new Set(['docs/spec.md']));
      // The keyboard went back to the link that was pressed.
      await expect(card(page, 'Links').getByRole('link', { name: 'as a file address' })).toBeFocused();
    });

    test('opens a link from the keyboard, with Enter', async ({ page }) => {
      await openNotes(page);
      const link = card(page, 'Links').getByRole('link', { name: 'the file' });
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(readerTitle(page, 'spec.md')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(link).toBeFocused();
    });

    test('does not make a link of any other scheme, of a path out of the workspace, or of a picture', async ({ page }) => {
      await openNotes(page);
      const note = card(page, 'Not links');
      await expect(note).toContainText('click me');
      await expect(note).toContainText('mail me');
      await expect(note.getByRole('link')).toHaveCount(0);
      await expect(note.locator('a')).toHaveCount(0);
      await expect(note.locator('img')).toHaveCount(0);
      await expect(note).toContainText('[image: chart]');
      await expect(board(page).locator('a[href^="javascript:" i], a[href^="mailto:" i], a[href^="data:" i], a[href^="ftp:" i], a[href^="#"]')).toHaveCount(0);
      // Pressing the words does nothing.
      await note.getByText('click me').click();
      await expect(reader(page)).toHaveCount(0);
      await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    });

    test('shows the whole text with working links, and a link to a file gives the dialog\'s place to the reader', async ({ page }) => {
      const long = Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of what was seen.`).join('\n');
      await page.context().route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Example</title>' }));
      await openBoard(page, [boardNote(1, { title: 'A long note', body: `${long}\nThen [the spec](docs/spec.md) and [the web](https://example.com/end).` })], { [boardId(1)]: { x: 800, y: 240 } });
      const readAll = board(page).getByRole('button', { name: 'Read all of A long note' });
      await readAll.click();
      const dialog = page.getByRole('dialog', { name: 'A long note' });
      await expect(dialog).toContainText('Line 12 of what was seen.');
      const web = dialog.getByRole('link', { name: /the web/ });
      await expect(web).toHaveAttribute('href', 'https://example.com/end');
      await expect(web).toHaveAttribute('target', '_blank');
      await expect(web).toHaveAttribute('rel', 'noopener noreferrer');
      await dialog.getByRole('link', { name: 'the spec' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(readerTitle(page, 'spec.md')).toBeVisible();
      await expect(readerTitle(page, 'spec.md')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(readAll).toBeFocused();
    });

    test('keeps the links of a card whose text is cut off out of the keyboard\'s way, and Read all has them all', async ({ page }) => {
      const body = [...Array.from({ length: 6 }, (_, index) => `Line ${index + 1}.`), 'Last line: [the hidden link](https://example.com/hidden)'].join('\n');
      await openBoard(page, [boardNote(1, { title: 'Cut note', body }), boardNote(2, { title: 'Short note', body: 'One [short link](https://example.com/short).' })], { [boardId(1)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 } });
      const cut = card(page, 'Cut note');
      const readAll = cut.getByRole('button', { name: 'Read all of Cut note' });
      await expect(readAll).toBeVisible();
      // Some of its links may be where they cannot be seen, so none is a stop; a card that shows all of its text keeps its links as stops.
      await expect(cut.getByRole('link', { name: /the hidden link/ })).toHaveAttribute('tabindex', '-1');
      await expect(card(page, 'Short note').getByRole('link', { name: /short link/ })).not.toHaveAttribute('tabindex', /.*/);
      await readAll.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(cut.getByRole('link', { name: /the hidden link/ })).not.toBeFocused();
      await page.keyboard.press('Tab');
      await expect(readAll).toBeFocused();
      // The whole text is one press away, with every link a stop.
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Cut note' });
      await expect(dialog.getByRole('link', { name: /the hidden link/ })).not.toHaveAttribute('tabindex', /.*/);
    });

    test('keeps the clamp and the Read all button on a note written in Markdown', async ({ page }) => {
      const body = ['# Findings', '', ...Array.from({ length: 10 }, (_, index) => `- point ${index + 1}`)].join('\n');
      await openBoard(page, [boardNote(1, { title: 'Findings', body })], { [boardId(1)]: { x: 800, y: 240 } });
      const note = card(page, 'Findings');
      await expect(note.locator('li').first()).toBeVisible();
      await expect(note.getByRole('button', { name: 'Read all of Findings' })).toBeVisible();
      // The card shows four lines of text at most: the clamp holds with lists in it.
      const lines = await note.locator('.board-text').evaluate((element) => Math.round(element.clientHeight / 18));
      expect(lines).toBeLessThanOrEqual(4);
      await expect(note.getByRole('heading')).toHaveCount(1);
    });
  });
});

test.describe('Board, nothing to drag inside an Area', () => {
  test('keeps every node where the layout put it when dragged, and shows no draggable cursor', async ({ page }) => {
    await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed'); });
    await routeBoard(page);
    await routeCards(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory', area: 'checkpoint:reports-export-to-csv', step: 'background-job-queue-for-large-exports' })], positions: { [boardId(1)]: { x: 352, y: -420 } } }));
    const posted: unknown[] = [];
    await page.route('**/api/workspace/demo/board/changes', (route) => { posted.push(route.request().postDataJSON()); return route.fulfill({ json: boardFile() }); });
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/);
    const card = board(page).getByRole('article', { name: 'Export leaks memory' });
    await expect(card).toBeVisible();
    // A saved place is not used inside an Area: the card is on its step row
    const before = await canvasBox(page, boardId(1));
    expect(before.y).toBeGreaterThanOrEqual(0);
    await dragBy(page, card, 120, 90);
    await frames(page, 8);
    expect(await canvasBox(page, boardId(1))).toEqual(before);
    await page.keyboard.press('Shift+ArrowRight');
    await frames(page, 4);
    expect(await canvasBox(page, boardId(1))).toEqual(before);
    expect(posted).toHaveLength(0);
    expect(await node(page, boardId(1)).evaluate((element) => element.classList.contains('draggable'))).toBe(false);
    expect(await node(page, boardId(1)).evaluate((element) => getComputedStyle(element).cursor)).not.toBe('grab');
    await expect(board(page).locator('#board-area .react-flow__node.draggable')).toHaveCount(0);
  });
});

test.describe('Board, rows by step', () => {
  const inArea = (page: Page) => board(page).locator('#board-area');
  const rowButton = (page: Page, name: RegExp | string) => inArea(page).getByRole('button', { name });
  const flow = (page: Page) => inArea(page).locator('.react-flow');
  const OPEN_STEP = (i: number) => `Open step ${i} that says something long about board polish and other things to do`;
  const DONE_STEP = (i: number) => `Done step ${i}`;
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ago = (m: number) => ({ at: minutesAgo(m), updatedAt: minutesAgo(m) });

  /**
   * The workspace of the real board, as the work on this very feature looks: a checkpoint with 13 open steps and 12 done ones, two decisions
   * that wait, a repository with commits, 10 cards that are tied to no step, 2 on an open step, 3 on done steps. And another checkpoint after it.
   */
  async function openReal(page: Page, options: { size?: { width: number; height: number }; nav?: boolean; area?: RegExp | string; onSteps?: boolean } = {}) {
    if (!options.nav) await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed'); });
    if (options.size) await page.setViewportSize(options.size);
    const open = Array.from({ length: 13 }, (_, i) => step(OPEN_STEP(i)));
    const done = Array.from({ length: 12 }, (_, i) => step(DONE_STEP(i), true));
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ title: 'Real', checkpoints: [
      checkpoint('Concept', { done: true, steps: [step('Drew the idea', true)] }),
      checkpoint('A Board tab shows the real work', { steps: [...done, ...open], decisions: [decision('Which time zone?'), decision('Which delimiter?')] }),
      checkpoint('Later work', { steps: [step('Plan the later work'), step('Do the later work')] }),
    ] }) }));
    await routeWork(page, []);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'NexusFlow', more: 0, commits: Array.from({ length: 5 }, (_, i) => ({ sha: `a91f2e0c4d5${i}`, author: 'Anna', subject: `Commit ${i}`, at: minutesAgo(30 + i) })) }] }) }));
    await routePictures(page);
    const area = 'checkpoint:a-board-tab-shows-the-real-work';
    await routeCards(page, boardFile({ cards: [
      ...Array.from({ length: 9 }, (_, i) => boardFileCard(10 + i, `board-pictures/p${i}.png`, { title: `Picture ${i}`, step: undefined, area, ...ago(i + 5) })),
      boardNote(19, { title: 'A loose note', step: undefined, area, ...ago(40) }),
      ...(options.onSteps === false ? [] : [boardNote(20, { title: 'Newest on an open step', body: Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the note.`).join('\n'), step: key(OPEN_STEP(3)), ...ago(1) }), boardNote(21, { title: 'Older on an open step', step: key(OPEN_STEP(3)), ...ago(3) })]),
      ...(options.onSteps === false ? [] : [
        boardNote(26, { title: 'Starts with code', body: '```\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n```\nsee [the plan](PLAN.md) after the code.', step: key(DONE_STEP(2)), ...ago(53) }),
        boardNote(27, { title: 'Starts with a table', body: '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n\nand then some words after the table.', step: key(DONE_STEP(2)), ...ago(54) }),
      ]),
      boardNote(22, { title: 'On a done step', step: key(DONE_STEP(2)), ...ago(50) }),
      boardNote(23, { title: 'On another done step', step: key(DONE_STEP(5)), ...ago(51) }),
      boardNote(24, { title: 'On a third done step', step: key(DONE_STEP(9)), ...ago(52) }),
      boardNote(25, { title: 'Later note', step: key('Plan the later work'), area: 'checkpoint:later-work', ...ago(2) }),
    ] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, options.area ?? /A Board tab shows the real work/);
    return area;
  }

  /** Every node is whole inside the canvas, and none is under the attribution link or any other control of the canvas. */
  async function expectClearOfControls(page: Page) {
    const canvas = (await flow(page).boundingBox())!;
    const controls = await inArea(page).locator('.react-flow__attribution, .react-flow__controls, .react-flow__minimap').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    for (const handle of await inArea(page).locator('.react-flow__node').all()) {
      const box = (await handle.boundingBox())!;
      const id = await handle.getAttribute('data-id');
      expect(box.x >= canvas.x - 0.5 && box.y >= canvas.y - 0.5 && box.x + box.width <= canvas.x + canvas.width + 0.5 && box.y + box.height <= canvas.y + canvas.height + 0.5, `${id} is outside the canvas`).toBe(true);
      for (const control of controls) {
        const apart = box.x + box.width <= control.x || control.x + control.width <= box.x || box.y + box.height <= control.y || control.y + control.height <= box.y;
        expect(apart, `${id} is under a control`).toBe(true);
      }
    }
    // No card grows out of itself: what is cut stays inside the card, so its byline and Read all are not pushed out
    const grown = await inArea(page).locator('.react-flow__node article').evaluateAll((els) => els.filter((el) => el.scrollHeight > el.clientHeight + 1).map((el) => `${el.getAttribute('aria-labelledby') ?? el.className}: ${el.scrollHeight} > ${el.clientHeight}`));
    expect(grown, 'cards that grow out of themselves').toEqual([]);
    // The control the keyboard is on is whole inside the canvas too, so the person can see where it is
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || !element.closest('#board-area .react-flow__node')) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, label: element.getAttribute('aria-label') ?? element.tagName };
    });
    if (focused) expect(focused.x >= canvas.x - 0.5 && focused.y >= canvas.y - 0.5 && focused.x + focused.width <= canvas.x + canvas.width + 0.5 && focused.y + focused.height <= canvas.y + canvas.height + 0.5, `the focused ${focused.label} is outside the canvas`).toBe(true);
  }

  const SIZES = [
    { name: '1280x800', size: { width: 1280, height: 800 }, canvasWidth: [800, 1100] },
    { name: '1100x700', size: { width: 1100, height: 700 }, canvasWidth: [600, 900] },
    // The Board in a narrow pane beside the chat: about 420 px of canvas
    { name: 'a narrow pane', size: { width: 480, height: 960 }, canvasWidth: [330, 520] },
    { name: 'a short narrow pane', size: { width: 480, height: 800 }, canvasWidth: [330, 520] },
  ] as const;

  for (const { name, size, canvasWidth } of SIZES) {
    test(`shows the current step with its cards and some more cards, all inside the canvas, at ${name}`, async ({ page }) => {
      await openReal(page, { size });
      const width = (await flow(page).boundingBox())!.width;
      expect(width).toBeGreaterThan(canvasWidth[0]);
      expect(width).toBeLessThan(canvasWidth[1]);
      // The current step is the open step with the newest card; its cards are drawn; so are some of the cards tied to no step
      const current = rowButton(page, new RegExp(`^Current step: ${OPEN_STEP(3)}`));
      await expect(current).toBeVisible();
      await expect(inArea(page).getByRole('article', { name: 'Newest on an open step' })).toBeVisible();
      expect(await inArea(page).locator('.react-flow__node-note, .react-flow__node-file').count()).toBeGreaterThanOrEqual(1);
      await expect(rowButton(page, /^Show \d+ more|Not tied to a step/).first()).toBeVisible();
      await expect(rowButton(page, /more open steps/)).toBeVisible();
      await expect(rowButton(page, /12 done steps/)).toBeVisible();
      await expect(inArea(page).getByRole('article', { name: 'Reports export to CSV' })).toHaveCount(0);
      await expect(inArea(page).getByRole('article', { name: /real work/ })).toBeVisible();
      await expectClearOfControls(page);
      // Panning and zooming are off: the view is where the layout put it
      expect((await transformOf(page)).scale).toBeCloseTo(0.9, 5);
      await expect(inArea(page).getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
      await expect(inArea(page).locator('.react-flow__minimap')).toHaveCount(0);
    });

    test(`never moves the view when rows are opened, closed or paged, and Escape gives back the exact view, at ${name}`, async ({ page }) => {
      await openReal(page, { size });
      const before = await transformOf(page);
      const same = async () => { await frames(page, 6); expect(await transformOf(page)).toEqual(before); };
      for (const label of [/^Current step:/, /more open steps/, /12 done steps/, /Not tied to a step/]) {
        const button = rowButton(page, label).first();
        await button.click();
        await same();
        await expectClearOfControls(page);
        const older = inArea(page).getByRole('button', { name: 'Older ›' });
        // A row that has more than one page is paged all the way through
        while (await older.count() && await older.isEnabled()) {
          await older.click();
          await same();
          await expectClearOfControls(page);
        }
        await page.keyboard.press('Escape');
        await same();
        await expect(inArea(page)).toBeVisible();
      }
      expect(await transformOf(page)).toEqual(before);
    });
  }

  test('fills the canvas with cards: at least 4 pictures with the index open at 1280x800, 2 in the narrow pane, most of them on a big screen', async ({ page }) => {
    // The real board has no cards on the open steps: its pictures are all tied to no step
    const pictures = () => inArea(page).locator('.react-flow__node-file').count();
    await openReal(page, { size: { width: 1280, height: 800 }, nav: true, onSteps: false });
    expect(await pictures()).toBeGreaterThanOrEqual(4);
    await expectClearOfControls(page);
    await page.goto('about:blank');
    await openReal(page, { size: { width: 480, height: 960 }, onSteps: false });
    expect(await pictures()).toBeGreaterThanOrEqual(2);
    await expectClearOfControls(page);
    await page.goto('about:blank');
    await openReal(page, { size: { width: 1920, height: 1080 }, onSteps: false });
    expect(await pictures()).toBeGreaterThanOrEqual(7);
    await expectClearOfControls(page);
  });

  test('keeps the card the reader shows drawn when the reader docks beside the canvas, from a page that is not the first, and gives the keyboard back to it when the reader closes', async ({ page }) => {
    await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_reader_layout_v1', 'side'); });
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /Not tied to a step/).first().click();
    const older = inArea(page).getByRole('button', { name: 'Older ›' });
    await older.click();
    await older.click();
    await expect(inArea(page).getByRole('navigation', { name: /Pages of/ })).toContainText(/^‹ Newer\d+–\d+ of 10Older ›$/);
    const open = inArea(page).getByRole('button', { name: /^Open Picture/ }).first();
    const label = (await open.getAttribute('aria-label'))!;
    const wide = (await flow(page).boundingBox())!;
    await open.click();
    const reading = board(page).getByRole('region', { name: 'Reader', exact: true });
    await expect(reading).toBeVisible();
    // The canvas is what the reader leaves, the rows are laid out for it again, and the card is still drawn beside the reader
    await expect.poll(async () => (await flow(page).boundingBox())!.width).toBeLessThan(wide.width);
    const card = inArea(page).getByRole('article', { name: label.replace(/^Open /, '') });
    await expect(card).toBeVisible();
    const free = (await reading.boundingBox())!;
    await expect.poll(async () => { const box = (await card.boundingBox())!; return box.x + box.width <= free.x + 1; }).toBe(true);
    await expectClearOfControls(page);
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    await expect(inArea(page).getByRole('button', { name: label })).toBeFocused();
    await expectClearOfControls(page);
  });

  test('puts the cards tied to no step in a row that opens into pages, with a count, newest first, and every card reachable by a button', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /Not tied to a step/).first().click();
    const pager = inArea(page).getByRole('navigation', { name: /Pages of/ });
    const more = rowButton(page, /Show \d+ more for Not tied/);
    await expect(more).toHaveCount(0);
    const seen = new Set<string>();
    const collect = async () => { for (const label of await inArea(page).locator('.react-flow__node-note h2, .react-flow__node-file h2').allTextContents()) if (/^(Picture|A loose note)/.test(label)) seen.add(label); };
    await collect();
    if (await pager.count()) {
      await expect(pager).toContainText(/1–\d+ of 10/);
      const older = inArea(page).getByRole('button', { name: 'Older ›' });
      const newer = inArea(page).getByRole('button', { name: '‹ Newer' });
      await expect(newer).toBeDisabled();
      while (await older.isEnabled()) { await older.click(); await frames(page, 4); await collect(); }
      await expect(older).toBeDisabled();
      await expect(pager).toContainText(/of 10/);
    }
    expect(seen.size).toBe(10);
  });

  test('does the card\'s main action for a press anywhere on the brick, but not for a press on its own buttons or for a text selection', async ({ page }) => {
    await openReal(page, { size: { width: 1920, height: 1080 } });
    const reading = board(page).getByRole('region', { name: 'Reader', exact: true });
    const picture = inArea(page).getByRole('article', { name: 'Picture 0' });
    await expect(picture).toBeVisible();
    await expect(picture).toHaveCSS('cursor', 'pointer');
    // The press on the title opens the picture in the reader, as Open does
    await picture.getByRole('heading', { name: 'Picture 0' }).click();
    await expect(reading).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    // Selecting text by dragging over the description does not open it
    // The text is selected by dragging over it; on a busy machine the pointer sometimes misses, which is a plain press and opens the reader: that is closed and the drag is tried again
    const selectText = async (target: Locator) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await reading.count()) { await page.keyboard.press('Escape'); await expect(reading).toHaveCount(0); }
        await expect.poll(() => target.evaluate((element) => Boolean(element.closest('[inert]')))).toBe(false);
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await frames(page, 10);
        const box = (await target.boundingBox())!;
        await page.mouse.move(box.x + 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
        await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
        await page.mouse.up();
        if (await page.evaluate(() => (window.getSelection()?.toString() ?? '') !== '')) return;
      }
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? ''), 'the drag selected nothing').not.toBe('');
    };
    await selectText(picture.getByText('The file 10.'));
    await frames(page, 6);
    await expect(reading).toHaveCount(0);
    // A selection in another card does not stop a press on this one: the thumbnail opens the picture
    const other = inArea(page).getByRole('article', { name: 'Picture 1' });
    await selectText(other.getByText('The file 11.'));
    await picture.locator('img').click();
    await expect(reading).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    // A note whose text is cut: a press on it does what Read all does, and Read all still does it by itself
    const note = inArea(page).getByRole('article', { name: 'Newest on an open step' });
    await note.getByRole('heading', { name: 'Newest on an open step' }).click();
    await expect(page.getByRole('dialog', { name: 'Newest on an open step' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await note.getByRole('button', { name: 'Read all of Newest on an open step' }).click();
    await expect(page.getByRole('dialog', { name: 'Newest on an open step' })).toBeVisible();
    await page.keyboard.press('Escape');
    // A note that shows all of its text is not a brick: nothing happens, and it does not look pressable
    const short = inArea(page).getByRole('article', { name: 'Older on an open step' });
    await expect(short).toHaveCSS('cursor', 'default');
    await short.getByRole('heading').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(reading).toHaveCount(0);
    // A commit does nothing for now
    await rowButton(page, /NexusFlow/).first().click();
    await inArea(page).getByRole('article', { name: /^a91f2e0/ }).first().click();
    await expect(reading).toHaveCount(0);
  });

  test('keeps a compact note whose text starts with code or a table inside its card, with its byline and Read all', async ({ page }) => {
    await openReal(page, { size: { width: 1920, height: 1080 } });
    await rowButton(page, /12 done steps/).click();
    await expectClearOfControls(page);
    for (const title of ['Starts with code', 'Starts with a table']) {
      const note = inArea(page).getByRole('article', { name: title });
      await expect(note).toBeVisible();
      await expect(note.getByRole('button', { name: `Read all of ${title}` })).toBeVisible();
      await expect(note).toHaveCSS('cursor', 'pointer');
      // The code and the table are drawn at 11 px or more on the screen as well
      const sizes = await note.locator('pre, pre *, th, td').evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize) * 0.9));
      expect(sizes.filter((size) => size < 11), "code and table sizes").toEqual([]);
      await note.getByRole('heading', { name: title }).click();
      await expect(page.getByRole('dialog', { name: title })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });

  test('draws every text of the rows at 11 px or more on the screen', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    for (const open of [null, /^Current step:/, /Not tied to a step/, /12 done steps/]) {
      if (open) await rowButton(page, open).first().click();
      const scale = (await transformOf(page)).scale;
      const small = await inArea(page).locator('.react-flow__node').evaluateAll((els, zoom) => {
        const found: string[] = [];
        for (const el of els) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            const parent = t.parentElement;
            if (!parent || !t.textContent?.trim() || parent.closest('.sr-only')) continue;
            const size = parseFloat(getComputedStyle(parent).fontSize);
            if (size * zoom < 11 - 0.01) found.push(`${t.textContent.trim().slice(0, 30)}: ${size * zoom}`);
          }
        }
        return found;
      }, scale);
      expect(small, "texts under 11 px").toEqual([]);
      if (open) await page.keyboard.press('Escape');
    }
  });

  test('moves the keyboard to the header of the row when a live change takes the pager away', async ({ page }) => {
    await page.clock.install();
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /Not tied to a step/).first().click();
    const older = inArea(page).getByRole('button', { name: 'Older ›' });
    await older.focus();
    await expect(older).toBeFocused();
    // The cards are fewer (a live change): the row fits on one page, and the pager is gone
    await routeCards(page, boardFile({ cards: [boardNote(19, { title: 'A loose note', step: undefined, area: 'checkpoint:a-board-tab-shows-the-real-work', ...ago(40) })] }));
    await page.clock.fastForward(31_000);
    await expect(inArea(page).getByRole('navigation', { name: /Pages of/ })).toHaveCount(0);
    await expect(inArea(page).locator('[data-row-control="lane:board"]')).toBeFocused();
  });

  test('moves the keyboard to the other page button when the one it was on has no page left', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /Not tied to a step/).first().click();
    const older = inArea(page).getByRole('button', { name: 'Older ›' });
    const newer = inArea(page).getByRole('button', { name: '‹ Newer' });
    await older.focus();
    for (let turn = 0; turn < 12 && await older.isEnabled(); turn += 1) { await page.keyboard.press('Enter'); await frames(page, 4); }
    await expect(older).toBeDisabled();
    await expect(newer).toBeFocused();
    for (let turn = 0; turn < 12 && await newer.isEnabled(); turn += 1) { await page.keyboard.press('Enter'); await frames(page, 4); }
    await expect(newer).toBeDisabled();
    await expect(older).toBeFocused();
  });

  test('says "Next step" and never "Current" in an Area that is not the current one', async ({ page }) => {
    await openReal(page, { area: /Later work/ });
    await expect(rowButton(page, /^Next step: Plan the later work/)).toBeVisible();
    await expect(rowButton(page, /Current step/)).toHaveCount(0);
    await expect(inArea(page).getByText('Current step')).toHaveCount(0);
    await expect(inArea(page).getByRole('article', { name: 'Later note' })).toBeVisible();
  });

  test('opens the done row with a press: the done steps with cards head them, the rest are listed; a second press closes it and the keyboard stays on the button', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    const done = rowButton(page, /12 done steps/);
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    await expect(inArea(page).getByRole('article', { name: 'On a done step' })).toHaveCount(0);
    await done.click();
    const open = rowButton(page, /12 done steps/);
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(open).toBeFocused();
    // The done steps are many: the opened row pages through them
    await expect(inArea(page).getByText(DONE_STEP(0), { exact: true }).first()).toBeVisible();
    const older = inArea(page).getByRole('button', { name: 'Older ›' });
    for (let page_ = 0; page_ < 6 && !(await inArea(page).getByRole('article', { name: 'On a done step' }).count()) && await older.count() && await older.isEnabled(); page_ += 1) await older.click();
    await expect(inArea(page).getByRole('article', { name: 'On a done step' })).toBeVisible();
    // One row is open at a time: the others are folded to one line
    await expect(rowButton(page, /^Current step/)).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    await expect(rowButton(page, /12 done steps/)).toHaveAttribute('aria-expanded', 'false');
    await expect(rowButton(page, /12 done steps/)).toBeFocused();
    await expect(inArea(page).getByRole('article', { name: 'On a done step' })).toHaveCount(0);
  });

  test('lists the open steps that have no cards in one opened line, wrapping into columns', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /12 more open steps/).click();
    await expect(inArea(page).getByText(OPEN_STEP(0), { exact: true })).toBeVisible();
    const first = (await inArea(page).locator('.react-flow__node-step', { hasText: OPEN_STEP(0) }).first().boundingBox())!;
    const second = (await inArea(page).locator('.react-flow__node-step', { hasText: OPEN_STEP(1) }).first().boundingBox())!;
    expect(Math.abs(first.y - second.y) < 2 || first.x === second.x).toBe(true);
    await expectClearOfControls(page);
  });

  test('closes things innermost first with Escape: a dialog, the reader, the open row, then the Area', async ({ page }) => {
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({ status: 404, json: { error: 'No such document.' } }));
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /Not tied to a step/).first().click();
    await expect(rowButton(page, /Not tied to a step/).first()).toHaveAttribute('aria-expanded', 'true');
    const reading = board(page).getByRole('region', { name: 'Reader', exact: true });
    // A dialog first
    await inArea(page).getByRole('button', { name: 'Read all of A loose note' }).or(inArea(page).getByRole('button', { name: /^Open Picture/ }).first()).first().click();
    await expect(reading.or(page.getByRole('dialog'))).toBeVisible();
    if (await page.getByRole('dialog').count()) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else {
      await page.keyboard.press('Escape');
      await expect(reading).toHaveCount(0);
    }
    await expect(rowButton(page, /Not tied to a step/).first()).toHaveAttribute('aria-expanded', 'true');
    // The reader, over the open row
    await inArea(page).getByRole('button', { name: /^Open Picture/ }).first().click();
    await expect(reading).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    await expect(rowButton(page, /Not tied to a step/).first()).toHaveAttribute('aria-expanded', 'true');
    // The open row
    await page.keyboard.press('Escape');
    await expect(rowButton(page, /Not tied to a step/).first()).toHaveAttribute('aria-expanded', 'false');
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
    // The Area
    await page.keyboard.press('Escape');
    await expect(inArea(page)).toHaveCount(0);
  });

  test('reaches a card button with the Tab key, and the card is in view', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    await board(page).getByRole('button', { name: 'Board ›' }).focus();
    let reached: string | null = null;
    for (let press = 0; press < 40 && !reached; press += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        return element?.closest('#board-area article') && /^(Open|Read all of)/.test(element.getAttribute('aria-label') ?? '') ? (element.getAttribute('aria-label') ?? null) : null;
      });
    }
    expect(reached, 'Tab never reached a card button').not.toBeNull();
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
    expect(await isWithin(focused, flow(page))).toBe(true);
  });

  test('lets the Board index reach every item by a jump, with the card in view, highlighted and focused, including one on a later page', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 }, nav: true });
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await expect(inArea(page)).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Board index' });
    const wanted = /^(Picture|A loose note|Newest on|Older on|On a|On another|On a third|Commit|Later note)/;
    const rows = nav.locator('ul li');
    const labels: string[] = [];
    for (const row of await rows.all()) {
      const text = ((await row.locator('button').first().textContent()) ?? '').trim();
      if (wanted.test(text) && await row.isVisible()) labels.push(text);
    }
    expect(labels.length).toBeGreaterThanOrEqual(15);
    for (const label of labels) {
      await nav.locator('ul li').filter({ hasText: label }).locator('button').first().click();
      await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
      const highlighted = inArea(page).locator('.react-flow__node[data-highlighted="true"]');
      await expect(highlighted, label).toHaveCount(1);
      await expect.poll(() => highlighted.evaluate((element) => element.contains(document.activeElement)), { message: label }).toBe(true);
      await expect.poll(() => isWithin(highlighted, flow(page)), { message: label }).toBe(true);
      await expectClearOfControls(page);
      const focused = page.locator(':focus');
      expect(await isWithin(focused, flow(page)), `${label}: the focused control is outside the canvas`).toBe(true);
      // The keyboard is on something that can be seen and pressed: the topmost thing at its centre is it, or inside it
      expect(await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const r = element.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return Boolean(top && (top === element || element.contains(top)));
      }), `${label}: the focused control is hidden`).toBe(true);
    }
  });

  test('lets go of an open row that a live change took away, so Escape leaves the Area on the first press', async ({ page }) => {
    await page.clock.install();
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /12 done steps/).click();
    await expect(rowButton(page, /12 done steps/)).toHaveAttribute('aria-expanded', 'true');
    // The plan loses its done steps (a live change): the row is not there any more
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ title: 'Real', checkpoints: [
      checkpoint('Concept', { done: true, steps: [step('Drew the idea', true)] }),
      checkpoint('A Board tab shows the real work', { steps: [step(OPEN_STEP(0))] }),
    ] }) }));
    // The plan is read again every half minute
    await page.clock.fastForward(31_000);
    await expect(rowButton(page, /done steps/)).toHaveCount(0);
    await expect(inArea(page).locator('.react-flow__node-step button[aria-expanded="true"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(inArea(page)).toHaveCount(0);
  });

  test('folds the rows with the least priority first when the canvas is short, and a press opens one', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 640 } });
    // Something is folded (commits, then what is tied to no step ...), and the current step and the waiting decisions never are
    await expect(rowButton(page, /^Current step/)).toBeVisible();
    await expect(inArea(page).getByRole('article', { name: /real work/ })).toBeVisible();
    const folded = inArea(page).locator('.react-flow__node-fold');
    expect(await folded.count()).toBeGreaterThanOrEqual(2);
    await expectClearOfControls(page);
    await folded.first().getByRole('button').click();
    await expect(inArea(page).locator('.react-flow__node-step button[aria-expanded="true"]')).toHaveCount(1);
    await expectClearOfControls(page);
    await page.keyboard.press('Escape');
    await expect(inArea(page).locator('.react-flow__node-step button[aria-expanded="true"]')).toHaveCount(0);
  });

  test('has no serious accessibility violations, in light and dark, with folded rows, "+N more" and a row open', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    const axe = async () => {
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      const results = await new AxeBuilder({ page }).include('[aria-label="Board"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.html.slice(0, 100)}`).join(' | ')}`);
      expect(serious, serious.join('\n')).toEqual([]);
    };
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await axe();
    }
    await rowButton(page, /Not tied to a step/).first().click();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await axe();
    }
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
    await expect(stepped.getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Export note' })).toBeVisible();
    await expect(stepped.getByRole('heading', { name: 'Report rows load fast' })).toHaveCount(0);
    await expect(stepped.getByRole('article', { name: 'Rows note' })).toHaveCount(0);

    // Step out via back button
    await canvas.getByRole('button', { name: 'Board ›' }).click();
    await expect(canvas.locator('#board-area')).toHaveCount(0);
    await expect(overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
    await expect(overview.locator('button.board-area').filter({ hasText: 'Report rows load fast' })).toBeVisible();

    // Step into "Report rows load fast"
    await stepIntoArea(page, 'Report rows load fast');
    await expect(stepped).toBeVisible();
    await expect(stepped.getByRole('heading', { name: 'Report rows load fast' })).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Rows note' })).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Reports export to CSV' })).toHaveCount(0);
    await expect(stepped.getByRole('article', { name: 'Export note' })).toHaveCount(0);
  });

  test('moves the Current badge as the plan progresses live', async ({ page }) => {
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
    await expect(firstArea.locator('.board-area-badge')).toHaveText(/Current/i);

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

    await expect.poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      return firstArea.locator('.board-area-badge').textContent();
    }, { timeout: 10_000, intervals: [400, 800] }).toMatch(/Done/i);

    await expect(secondArea.locator('.board-area-badge')).toHaveText(/Current/i);
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

/** The AI's live stream and the board it changes: what the screen feed tells the board, with or without the chat. */
const terminal = { id: '0199a213-81c0-7800-8aa1-bbab2a035a50', workspace: 'demo', target: 'shell', label: 'bash', cwd: workspace.workspacePath, state: 'running' };
const frame = (type: string, body: Record<string, unknown>, id: string) => `event: ${type}\nid: ${id}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const boardEvent = (revision: number, at = new Date().toISOString()) => frame('screen', { event: { id: `b${revision}`, timestamp: at, harness: 'claude', event: 'board', payload: { revision, changes: 1 } } }, at);
const nextEvent = (title: string) => frame('screen', { event: { id: 'n1', timestamp: new Date().toISOString(), harness: 'claude', event: 'next', payload: { title, reason: 'It has no tests yet' } } }, new Date().toISOString());
const PING = 'event: ping\ndata: {}\n\n';
/** A stream does not reconnect for a minute, so what it sends is sent once. */
const STREAM_HEAD = 'retry: 60000\n\n';

/**
 * What GET /board answers and how often it was asked. Before `released` it is the board as it was. After it, the read
 * that is number `newFromRead` since then, and every one after, has the new card in it: so a card only shows when the
 * board has been read that many times since the stream opened, which is what the specs check. (In development React reads
 * once more when the board opens, so a count of reads from the start would say nothing.)
 */
async function routeChanging(page: Page, newFromRead: number, added: Record<string, unknown> = boardNote(2, { title: 'Just added by claude', at: minutesAgo(0), updatedAt: minutesAgo(0) })) {
  const state = { released: false, sinceRelease: 0 };
  await page.route('**/api/workspace/demo/board', (route) => {
    if (state.released) state.sinceRelease += 1;
    const cards = [boardNote(1, { title: 'Already there' })];
    if (state.released && state.sinceRelease >= newFromRead) cards.push(added);
    return route.fulfill({ json: boardFile({ revision: 1 + state.sinceRelease, cards }) });
  });
  return state;
}

/** A progress plan with something under way, so the strip above the chat has a goal to speak of. */
async function routeFacts(page: Page) {
  await page.route('**/api/workspace/demo/progress-facts', (route) => route.fulfill({ json: { facts: {
    workspaceId: 'demo', generatedAt: new Date().toISOString(), currentMilestoneId: 'b',
    milestones: [
      { id: 'a', title: 'Cache invoice lookups', state: 'done', verified: true, reopenCount: 0, waitingOn: [] },
      { id: 'b', title: 'Add cache tests', state: 'in_progress', verified: false, reopenCount: 0, waitingOn: [] },
    ],
    counts: { total: 2, done: 1, inProgress: 1, reopened: 0, blocked: 0, upcoming: 0 }, openQuestions: [],
    changes: { repos: [], files: 0, additions: 0, deletions: 0 }, verification: { status: 'never', freshness: 'unknown' }, unavailable: [],
  } } }));
}

/**
 * Opens the Board on a stream that stays shut until `release` is called. Then it sends `events` to the connections that
 * were waiting, and a bare ping to any that open later. `chat`: `none` has no CLI chat at all (an AI in another terminal),
 * `hidden` has one open with the chat hidden, `beside` shows it beside the board.
 */
async function liveBoard(page: Page, state: { released: boolean }, events: string, chat: 'none' | 'hidden' | 'beside') {
  let open = () => {};
  const released = new Promise<void>((resolve) => { open = resolve; });
  let isReleased = false;
  await page.route('**/api/workspace/demo/screen-events**', async (route) => {
    const body = isReleased ? PING : (await released, events);
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: STREAM_HEAD + body }).catch(() => {});
  });
  if (chat === 'none') {
    await page.goto('/#/workspaces/demo/board');
  } else {
    if (chat === 'beside') {
      await page.addInitScript(() => {
        try {
          if (!sessionStorage.getItem('layout-seeded')) { localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 62 })); sessionStorage.setItem('layout-seeded', '1'); }
        } catch { /* Storage can be unavailable. */ }
      });
    }
    await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
    await page.route('**/api/terminals/demo/status', (route) => route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
    await page.routeWebSocket('**/ws/terminal', (socket: WebSocketRoute) => {
      socket.onMessage((message) => {
        if (JSON.parse(String(message)).type !== 'attach') return;
        socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      });
    });
    await page.goto('/#/workspaces/demo/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    await expect(page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-state')).toHaveText('Running');
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
  }
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await stepIntoArea(page);
  await expect(board(page).getByRole('article', { name: 'Already there' })).toBeVisible();
  return () => { state.released = true; isReleased = true; open(); };
}

test.describe('Board, live', () => {
  // Wide enough for the strip above the chat to show its Next button beside the board.
  test.use({ viewport: { width: 1800, height: 1000 } });

  for (const chat of ['beside', 'hidden', 'none'] as const) {
    const where = { beside: 'with the chat beside it', hidden: 'with the chat hidden', none: 'with no CLI chat open' }[chat];

    test(`reads the board again when a board event arrives, ${where}, and shows the new card with a highlight`, async ({ page }) => {
      await routeBoard(page);
      // The stream opening is the first read since, the board event the second: the new card is only in the second.
      const state = await routeChanging(page, 2);
      const release = await liveBoard(page, state, boardEvent(2), chat);
      const canvas = board(page);
      await expect(canvas.getByRole('article', { name: 'Just added by claude' })).toHaveCount(0);
      release();
      const added = canvas.getByRole('article', { name: 'Just added by claude' });
      await reveal(page, added);
      await expect(added.locator('.board-fresh')).toHaveCount(1);
      expect(state.sinceRelease).toBe(2);
    });
  }

  test('reads a burst of board events once', async ({ page }) => {
    await routeBoard(page);
    const state = await routeChanging(page, 2);
    const release = await liveBoard(page, state, boardEvent(2) + boardEvent(3) + boardEvent(4) + boardEvent(5), 'none');
    release();
    await expect(board(page).getByRole('article', { name: 'Just added by claude' })).toBeVisible();
    expect(state.sinceRelease).toBe(2);
  });

  test('reads the board again when the feed connects, because the stream does not replay board events', async ({ page }) => {
    await routeBoard(page);
    const state = await routeChanging(page, 1);
    const release = await liveBoard(page, state, PING, 'none');
    await expect(board(page).getByRole('article', { name: 'Just added by claude' })).toHaveCount(0);
    release();
    await expect(board(page).getByRole('article', { name: 'Just added by claude' })).toBeVisible();
    expect(state.sinceRelease).toBe(1);
  });

  test('keeps board events out of the strip that shows what the AI told the screen', async ({ page }) => {
    await routeBoard(page);
    await routeChanging(page, 99);
    await routeFacts(page);
    const state = { released: false };
    const release = await liveBoard(page, state, nextEvent('Cover the cache') + boardEvent(2) + boardEvent(3), 'beside');
    const strip = page.getByRole('region', { name: 'Where are we', exact: true });
    await expect(strip).toBeVisible();
    release();
    // What the AI said shows; the board events that came with it do not.
    await expect(strip.getByRole('button', { name: /Next: Cover the cache/ })).toBeVisible();
    await expect(strip).not.toContainText(/board|revision|changes/i);
    await strip.getByRole('button', { expanded: false }).click();
    await expect(page.getByRole('region', { name: 'Progress details' })).not.toContainText(/board|revision/i);
  });

  test('gives the strip the events the board\'s connection already received, when the chat is shown later', async ({ page }) => {
    await routeBoard(page);
    await routeFacts(page);
    const state = await routeChanging(page, 2);
    const release = await liveBoard(page, state, nextEvent('Cover the cache') + boardEvent(2), 'hidden');
    release();
    await expect(board(page).getByRole('article', { name: 'Just added by claude' })).toBeVisible();
    // The stream said what it had to say once, to the connection the board opened. The strip is on the same connection.
    await page.getByRole('button', { name: 'Show the chat beside this' }).click();
    const strip = page.getByRole('region', { name: 'Where are we', exact: true });
    await expect(strip.getByRole('button', { name: /Next: Cover the cache/ })).toBeVisible();
  });

  test('shows a long note that arrived while another part was on show, with its Read all button', async ({ page }) => {
    await routeBoard(page);
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    const state = await routeChanging(page, 2, boardNote(2, { title: 'A long note', body, at: minutesAgo(0), updatedAt: minutesAgo(0) }));
    const release = await liveBoard(page, state, boardEvent(2), 'beside');
    // The chat stays beside Docs, so its strip keeps the connection while the board is out of sight.
    await workspaceNav(page).getByRole('link', { name: 'Docs' }).click();
    await expect(board(page)).toBeHidden();
    release();
    // It is drawn behind the part that is on show, where it has no size yet.
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
    await reveal(page, board(page).getByRole('article', { name: 'A long note' }));
    await expect(board(page).getByRole('article', { name: 'A long note' }).getByRole('button', { name: 'Read all of A long note' })).toBeVisible();
  });

  /**
   * A stream the spec holds open itself: a mocked response can only be sent whole, and then it is over. The page's
   * EventSource is replaced for the screen-events address, so the spec says when it opens, drops and what it sends.
   */
  async function holdFeed(page: Page) {
    await page.addInitScript(() => {
      const Native = window.EventSource;
      const feeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> = [];
      (window as unknown as { __feeds: typeof feeds }).__feeds = feeds;
      class Held {
        closed = false; readyState = 0; listeners: Record<string, Array<(event: { data?: string; lastEventId: string }) => void>> = {};
        constructor(url: string) {
          if (!url.includes('/screen-events')) return new Native(url) as unknown as Held;
          feeds.push(this);
        }
        addEventListener(type: string, listener: (event: { data?: string; lastEventId: string }) => void) { (this.listeners[type] ??= []).push(listener); }
        close() { this.closed = true; this.readyState = 2; }
        emit(type: string, data?: string) { for (const listener of this.listeners[type] ?? []) listener({ data, lastEventId: '' }); }
      }
      (window as unknown as { EventSource: unknown }).EventSource = Held;
    });
    type Feeds = { __feeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> };
    return {
      /** How many connections are open now. */
      open: () => page.evaluate(() => (window as unknown as Feeds).__feeds.filter((feed) => !feed.closed).length),
      /** The connection opens, as the browser tells it. */
      connect: () => page.evaluate(() => { for (const feed of (window as unknown as Feeds).__feeds.filter((entry) => !entry.closed)) { feed.readyState = 1; feed.emit('open'); } }),
      /** The connection drops and the browser tries again by itself. */
      drop: () => page.evaluate(() => { for (const feed of (window as unknown as Feeds).__feeds.filter((entry) => !entry.closed)) { feed.readyState = 0; feed.emit('error'); } }),
      /** The stream sends a screen frame. */
      send: (body: Record<string, unknown>) => page.evaluate((data) => { for (const feed of (window as unknown as Feeds).__feeds.filter((entry) => !entry.closed)) feed.emit('screen', data); }, JSON.stringify({ type: 'screen', ...body })),
    };
  }
  const afterSomeFrames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const tick = () => (++frames >= 6 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));

  test('reads the board every half minute only while it is shown and the feed is not connected', async ({ page }) => {
    await page.clock.install();
    const feed = await holdFeed(page);
    await routeBoard(page);
    let reads = 0;
    await page.route('**/api/workspace/demo/board', (route) => { reads += 1; return route.fulfill({ json: boardFile({ cards: [boardNote(1, { title: 'Already there' })] }) }); });
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    await expect(board(page).getByRole('article', { name: 'Already there' })).toBeVisible();

    // The stream has not opened: half a minute later the board is read again, and again.
    const opened = reads;
    await page.clock.fastForward(31_000);
    await expect.poll(() => reads).toBeGreaterThan(opened);
    const polled = reads;
    // Hidden behind another part, it does not.
    await workspaceNav(page).getByRole('link', { name: 'Plan' }).click();
    await expect(board(page)).toBeHidden();
    await page.clock.fastForward(95_000);
    await afterSomeFrames(page);
    expect(reads).toBe(polled);
    // Shown again, it is read (the feed opens, and that reads it) and the clock goes back to being its only reader.
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
    await expect.poll(() => feed.open()).toBe(1);
    await feed.connect();
    await expect.poll(() => reads).toBeGreaterThan(polled);
    await afterSomeFrames(page);
    const connected = reads;
    await page.clock.fastForward(95_000);
    await afterSomeFrames(page);
    expect(reads).toBe(connected);
    // The connection drops: the clock reads it again.
    await feed.drop();
    await page.clock.fastForward(31_000);
    await expect.poll(() => reads).toBeGreaterThan(connected);
  });

  test('uses one connection for the board and the strip beside it, and gives both what comes', async ({ page }) => {
    const feed = await holdFeed(page);
    await routeBoard(page);
    await routeFacts(page);
    const state = await routeChanging(page, 2);
    // The chat beside the board, its strip and the board both listening.
    const release = await liveBoard(page, state, PING, 'beside');
    const strip = page.getByRole('region', { name: 'Where are we', exact: true });
    await expect(strip).toBeVisible();
    await expect.poll(() => feed.open()).toBe(1);
    release();
    await feed.connect();
    await feed.send({ event: { id: 'n1', timestamp: new Date().toISOString(), harness: 'claude', event: 'next', payload: { title: 'Cover the cache', reason: 'It has no tests yet' } } });
    await feed.send({ event: { id: 'b2', timestamp: new Date().toISOString(), harness: 'claude', event: 'board', payload: { revision: 2, changes: 1 } } });
    await expect(strip.getByRole('button', { name: /Next: Cover the cache/ })).toBeVisible();
    await reveal(page, board(page).getByRole('article', { name: 'Just added by claude' }));
    expect(await feed.open()).toBe(1);
    // The board stops listening when another part is shown; the chat stays beside Docs, and its strip keeps the one connection.
    await workspaceNav(page).getByRole('link', { name: 'Docs' }).click();
    await expect(board(page)).toBeHidden();
    await expect(strip).toBeVisible();
    await afterSomeFrames(page);
    expect(await feed.open()).toBe(1);
  });
});

test.describe('Board index sidebar', () => {
  /** Whether the keyboard is on a card of the Area, or on something inside it. */
  const cardHasFocus = (page: Page, id: string) => node(page, id).evaluate((element) => element.contains(document.activeElement));

  test('is open by default on desktop, collapses to rail, and remembers preference in storage', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();

    // Toggle button in expanded header
    const toggle = nav.getByRole('button', { name: 'Board index' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();

    // Now collapsed rail with aria-expanded="false", and what waits for you in the name of its button
    await expect(nav).toBeHidden();
    const railButton = page.getByRole('button', { name: 'Board index' });
    await expect(railButton).toHaveAttribute('aria-expanded', 'false');
    await expect(railButton).toHaveAccessibleName('Board index, 1 waits for you');

    // Reload page to verify persistence
    await page.reload();
    await viewAtRest(page);
    await expect(page.getByRole('navigation', { name: 'Board index' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Board index' })).toHaveAttribute('aria-expanded', 'false');

    // Expand back
    await page.getByRole('button', { name: 'Board index' }).click();
    await expect(page.getByRole('navigation', { name: 'Board index' })).toBeVisible();
  });

  test('switches between Category and Area modes, remembering preference', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    // Default category mode has category headers
    await expect(nav.getByRole('heading', { name: /Waiting for you/ })).toBeVisible();
    await expect(nav.getByRole('heading', { name: /Areas/ })).toBeVisible();

    await expect(nav.getByRole('button', { name: 'Category', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(nav.getByRole('button', { name: 'Area', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Switch to Area mode
    await nav.getByRole('button', { name: 'Area', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'Area', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(nav.getByRole('heading', { name: /Reports export to CSV/ })).toBeVisible();
    await expect(nav.getByRole('heading', { name: /Report rows load fast/ })).toBeVisible();

    // Reload to verify persistence
    await page.reload();
    await viewAtRest(page);
    const navAfter = page.getByRole('navigation', { name: 'Board index' });
    await expect(navAfter.getByRole('heading', { name: /Reports export to CSV/ })).toBeVisible();

    // Switch back to Category mode
    await navAfter.getByRole('button', { name: 'Category', exact: true }).click();
    await expect(navAfter.getByRole('heading', { name: /Waiting for you/ })).toBeVisible();
  });

  test('filters items across titles, descriptions, and authors, with Escape and clear button clearing search', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Export memory leak note', body: 'Investigate streaming buffer' }),
        boardFileCard(2, 'docs/flow.png', { title: 'Architecture picture', description: 'Flow diagram' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    const search = nav.getByPlaceholder('Search the board…');

    await search.fill('Architecture');
    await expect(nav.getByRole('button', { name: 'Architecture picture Picture' })).toBeVisible();
    await expect(nav.getByRole('button', { name: /Export memory leak note/ })).toBeHidden();
    // The number of matches is announced, and the section headings stay open (and cannot be folded) while searching
    await expect(nav.locator('[aria-live="polite"]')).toHaveText('1 match');
    await expect(nav.getByRole('button', { name: /^Pictures & pages/ })).toBeDisabled();
    await expect(nav.getByRole('button', { name: /^Pictures & pages/ })).toHaveAttribute('aria-expanded', 'true');

    // By a word of the description
    await search.fill('diagram');
    await expect(nav.getByRole('button', { name: 'Architecture picture Picture' })).toBeVisible();
    await expect(nav.getByRole('button', { name: /Export memory leak note/ })).toBeHidden();

    // By an author: the commit that Anna wrote
    await search.fill('Anna');
    await expect(nav.getByRole('button', { name: /Write the CSV writer/ })).toBeVisible();
    await expect(nav.getByRole('button', { name: /Architecture picture/ })).toBeHidden();
    await expect(nav.getByRole('button', { name: /Export memory leak note/ })).toBeHidden();

    await search.fill('nothing like this');
    await expect(nav.locator('[aria-live="polite"]')).toHaveText('No matches');

    // Press Escape inside input to clear search
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(nav.getByRole('button', { name: /Export memory leak note/ })).toBeVisible();

    // Clear search with clear button
    await search.fill('leak');
    await expect(nav.getByRole('button', { name: 'Clear search' })).toBeVisible();
    await nav.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
  });

  test('jumps directly to an Area and card in one click, highlighting the card', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Important note on export', body: 'Must handle UTF-8 BOM' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    // Currently at Level 0
    await expect(board(page).locator('.board-overview-plane')).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Board index' });
    // Click the note item in the sidebar
    await nav.getByRole('button', { name: /Important note on export/ }).click();

    // Should step into area
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();

    // The note card node should have data-highlighted="true", and the keyboard is on it
    const noteNode = board(page).locator(`.react-flow:not([inert] *) .react-flow__node[data-id="${boardId(1)}"]`);
    await expect(noteNode).toHaveAttribute('data-highlighted', 'true');
    await expect.poll(() => cardHasFocus(page, boardId(1))).toBe(true);
  });

  test('jumps from inside one Area to a card of another, and opens no reader later', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Important note on export', body: 'Must handle UTF-8 BOM' }),
        boardFileCard(2, 'docs/flow.png', { title: 'Architecture picture', description: 'Flow diagram' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    await stepIntoArea(page, /Report rows load fast/);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    const areaTitle = board(page).locator('#board-area > header').getByRole('heading', { level: 2 });
    const reader = board(page).getByRole('region', { name: 'Reader', exact: true });

    // The note is in another Area than the one stepped into: the card is highlighted and has the keyboard, and nothing else opens
    await nav.getByRole('button', { name: /Important note on export/ }).click();
    await expect(areaTitle).toHaveText('Reports export to CSV');
    await expect(node(page, boardId(1))).toHaveAttribute('data-highlighted', 'true');
    await expect.poll(() => cardHasFocus(page, boardId(1))).toBe(true);
    await expect(reader).toHaveCount(0);

    // Back to the first Area, and a jump that asks for the reader: it opens then, once
    await nav.getByRole('button', { name: /^Report rows load fast/ }).click();
    await expect(areaTitle).toHaveText('Report rows load fast');
    await expect(reader).toHaveCount(0);
    await nav.getByRole('button', { name: 'Read Architecture picture in reader' }).click();
    await expect(areaTitle).toHaveText('Reports export to CSV');
    await expect(reader).toBeVisible();
    // (The canvas is behind the reader's large window now, so the card is looked for there and not as a stop)
    await expect(board(page).locator(`#board-area .react-flow__node[data-id="${boardId(2)}"]`)).toHaveAttribute('data-highlighted', 'true');

    // Stepping out and back in later opens no reader of its own
    await reader.getByRole('button', { name: 'Back to board' }).click();
    await expect(reader).toHaveCount(0);
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(reader).toHaveCount(0);
  });

  test('closes the reader before it jumps to a card in the Area it is open over', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Important note on export', body: 'Must handle UTF-8 BOM' }),
        boardFileCard(2, 'docs/flow.png', { title: 'Architecture picture', description: 'Flow diagram' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    await nav.getByRole('button', { name: 'Read Architecture picture in reader' }).click();
    const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
    await expect(reader).toBeVisible();
    await viewAtRest(page);

    // The reader's large window covers the canvas: the jump takes it away to show the card
    await nav.getByRole('button', { name: /Important note on export/ }).click();
    await expect(reader).toHaveCount(0);
    await expect(node(page, boardId(1))).toHaveAttribute('data-highlighted', 'true');
    await expect.poll(() => cardHasFocus(page, boardId(1))).toBe(true);
  });

  test('puts focus on the Back button when an Area entry is pressed with the reader open', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [boardFileCard(2, 'docs/flow.png', { title: 'Architecture picture', description: 'Flow diagram' })],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    await nav.getByRole('button', { name: 'Read Architecture picture in reader' }).click();
    const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
    await expect(reader).toBeVisible();
    await viewAtRest(page);

    // The jump closes the reader and changes the Area in one go: the opener of the old Area must not keep the focus
    await nav.getByRole('button', { name: /^Report rows load fast/ }).first().click();
    await expect(reader).toHaveCount(0);
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeFocused();
  });

  test('opens reader directly from quick reader icon button without extra steps', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await routeWork(page, [
      document('Export requirements', { role: 'requirements', filename: 'contextspace-document-1.md', summary: 'Customers export their reports as CSV.' }),
    ]);
    await page.route('**/api/workspace/demo/work/documents/*', (route) => route.fulfill({ json: {
      document: document('Export requirements', { filename: 'contextspace-document-1.md' }),
      location: '/tmp/demo/contextspace-document-1.md',
      content: '# Export requirements\n\nCustomers export reports as CSV.\n',
    } }));

    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    // Quick reader button has aria-label="Read Export requirements in reader"
    const readerBtn = nav.getByRole('button', { name: 'Read Export requirements in reader' });
    await expect(readerBtn).toBeVisible();
    await readerBtn.click();

    // Stepped in and reader open
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
    const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
    await expect(reader.getByRole('heading', { name: 'Export requirements', level: 1 })).toBeVisible();
  });

  test('operates as an overlay drawer on narrow viewports, closing on backdrop click or Escape', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    // Narrow viewport (<960px): overlay mode, collapsed rail visible by default
    const openBtn = page.getByRole('button', { name: 'Board index' });
    await expect(openBtn).toHaveAttribute('aria-expanded', 'false');

    // Click to open narrow drawer overlay: the keyboard goes to its search box
    await openBtn.click();
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();
    await expect(nav.getByPlaceholder('Search the board…')).toBeFocused();
    const backdrop = board(page).locator('[data-sidebar-backdrop="true"]');
    await expect(backdrop).toBeVisible();

    // Press Escape to close narrow overlay: the keyboard goes back to the toggle
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(backdrop).toBeHidden();
    await expect(openBtn).toBeFocused();

    // Open again and click backdrop to close
    await openBtn.click();
    await expect(nav).toBeVisible();
    await expect(nav.getByPlaceholder('Search the board…')).toBeFocused();
    await backdrop.click({ position: { x: 350, y: 200 } });
    await expect(nav).toBeHidden();
    await expect(openBtn).toBeFocused();
  });

  test('leaves an Escape that is pressed outside the Board to the page, with the drawer open', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    await page.getByRole('button', { name: 'Board index' }).click();
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();

    // Something outside the Board has the keyboard
    const outside = workspaceNav(page).getByRole('link').first();
    await outside.focus();
    await expect(outside).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(nav).toBeVisible();
  });

  test('keeps the keyboard on a toggle when the index folds into its rail and opens again', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    const toggle = page.getByRole('button', { name: 'Board index' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(nav).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(nav).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
  // A large window: these specs put several cards, and often a document and a commit too, on screen at once, which a laptop-sized
  // canvas shows as folded rows and "+N more" (specs for that are under "Board, rows by step").
  test.use({ viewport: { width: 1800, height: 1200 } });

    test.use({ colorScheme });

    async function expectNoSeriousViolations(page: Page, scope: string) {
      // Settled colours only: a transition caught half-way reports a contrast no one sees.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      const results = await new AxeBuilder({ page }).include(scope).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.html.slice(0, 100)}`).join(' | ')}`);
      expect(serious, serious.join('\n')).toEqual([]);
    }

    test('has no serious accessibility violations, with every kind of card on screen', async ({ page }) => {
      await routeBoard(page);
      await routePictures(page);
      await routeWork(page, [
        document('Export requirements', { role: 'requirements', summary: 'Customers export their reports as CSV, up to 50,000 rows.' }),
        document('Draft notes', { role: 'reference', status: 'draft', summary: 'Rough notes.' }),
        document('First export design', { status: 'superseded', summary: 'Replaced by the queue design.' }),
      ]);
      await routeMoves(page, boardFile({
        cards: [
          boardNote(1, { title: 'Export leaks memory', body: Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of what was seen in the CSV writer.`).join('\n'), updatedAt: minutesAgo(0) }),
          boardNote(2, { title: 'Ask finance about time zones', body: 'Before we ship.', pinned: true, by: 'user', updatedBy: 'user' }),
          boardNote(3, { title: 'An idea we dropped', body: 'It was too slow.', archived: true }),
          boardFileCard(4, 'docs/export flow.png', { title: 'Export flow', description: 'How a report becomes a CSV file.', pinned: true }),
          boardFileCard(5, 'docs/overview.html', { title: 'Overview page', description: 'Start with the diagram.', by: 'codex', updatedBy: 'codex' }),
          boardFileCard(6, 'docs/spec.pdf', { title: 'The spec', description: 'What was agreed.', archived: true }),
          boardFileCard(7, 'docs/flow.png', { title: 'flow.png', description: 'The same flow, drawn smaller.' }),
        ],
        links: [boardLink(1, boardId(1), 'checkpoint:reports-export-to-csv', 'found while'), boardLink(2, boardId(4), 'commit:billing api:a91f2e0'), boardLink(3, boardId(2), `document:${boardId(99)}`)],
        positions: { [boardId(2)]: { x: 1060, y: 330 } },
      }));
      await page.goto('/#/workspaces/demo/board');
      await expect(board(page).locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
      // Level 0 Overview accessibility
      await expectNoSeriousViolations(page, '[aria-label="Board"]');

      // Step into area for Level 1 accessibility
      await stepIntoArea(page);
      const canvas = board(page);
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
      await revealAll(page);
      await expect(canvas.getByRole('article', { name: 'Export flow' }).getByRole('img', { name: 'Export flow' })).toBeAttached();
      await expect(canvas.getByRole('button', { name: 'Read all of Export leaks memory' })).toBeVisible();
      await expect(canvas.locator('#board-area .react-flow__edge')).toHaveCount(2);
      await expectNoSeriousViolations(page, '[aria-label="Board"]');

      await canvas.locator('#board-area').getByRole('button', { name: 'Archived (2)' }).click();
      await expect(canvas.getByRole('article', { name: 'The spec' })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');

      // The whole text of a card, in its dialog.
      await canvas.locator('#board-area').getByRole('button', { name: 'Read all of Export leaks memory' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Export leaks memory' })).toBeVisible();
      await expectNoSeriousViolations(page, '[role="dialog"]');
    });

    /** The board with links in its cards and a source document to open: the reader docked beside the canvas when `docked`, else in its large window. */
    async function checkReader(page: Page, docked: boolean) {
      if (docked) await page.addInitScript(() => window.localStorage.setItem('contextspace_board_reader_layout_v1', 'side'));
      await routeBoard(page);
      await routeWork(page, [
        document('Export requirements', { role: 'requirements', filename: 'contextspace-document-1.md', summary: 'Customers export their reports as CSV.' }),
        document('Pricing sheet', { url: 'https://example.com/pricing', summary: 'Kept on the web.' }),
      ]);
      await routeCards(page, boardFile({
        cards: [
          boardNote(1, { title: 'Links', body: 'Read [the CSV spec](https://example.com/spec), [the file](docs/spec.md) and `code`.\n\n- one\n- two' }),
          boardFileCard(2, 'docs/spec.md', { title: 'The CSV spec', description: 'See [the queue design](https://example.com/queue).' }),
        ],
        positions: { [boardId(1)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 } },
      }));
      // A source document is read through the work route.
      await page.route('**/api/workspace/demo/work/documents/*', (route) => route.fulfill({ json: {
        document: document('Export requirements', { filename: 'contextspace-document-1.md' }), location: '/tmp/demo/contextspace-document-1.md',
        content: '# Customers export reports\n\nUp to 50,000 rows as CSV. See [the design](docs/design.md) and [the web](https://example.com).\n\n| Column | Meaning |\n| --- | --- |\n| id | The row |\n',
      } }));
      await page.goto('/#/workspaces/demo/board');
      await stepIntoArea(page);
      const canvas = board(page);
      await expect(canvas.getByRole('article', { name: 'Links' }).getByRole('link', { name: 'the CSV spec' })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
      await canvas.getByRole('button', { name: 'Open Export requirements' }).click();
      const reader = canvas.getByRole('region', { name: 'Reader', exact: true });
      await expect(reader.getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
      // The card that is open has its ring, and is still fine to read.
      await expect(canvas.getByRole('article', { name: 'Export requirements' })).toHaveAttribute('aria-current', 'true');
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
    }

    test('has no serious accessibility violations with links in the cards and the reader open in its large window', async ({ page }) => {
      await checkReader(page, false);
      const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
      await expect(reader.getByRole('button', { name: 'Back to board' })).toBeVisible();
      await expect(reader.getByRole('button', { name: 'Side by side' })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
    });

    test('has no serious accessibility violations with links in the cards and the reader open beside them', async ({ page }) => {
      await checkReader(page, true);
      const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
      await expect(reader.getByRole('button', { name: 'Large', exact: true })).toBeVisible();
    });
  });
}
