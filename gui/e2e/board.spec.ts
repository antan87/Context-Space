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
/** What the board says about a move: its live region, which is there from the start and empty until there is something to say. */
const status = (page: Page) => board(page).getByRole('status').filter({ hasNotText: /^Still loading/ });
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
  }, { intervals: [120] }).toBe(true);
}
/** Waits until the browser has drawn that many frames: whatever was going to happen in them has happened. */
const frames = (page: Page, count = 6) => page.evaluate((total) => new Promise<void>((resolve) => {
  let drawn = 0;
  const tick = () => (++drawn >= total ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), count);
/**
 * Shows the whole board, with room all round. A drag that comes within a few dozen pixels of the edge of the canvas makes it
 * pan by itself, so the cards that are dragged stand well inside, wherever the board opened.
 */
async function fitted(page: Page) {
  const steppedBtn = board(page).locator('#board-area button[aria-label="Fit the board in view"]');
  const count = await steppedBtn.count();
  const chosen = count > 0 ? steppedBtn : board(page).locator('#board-overview button[aria-label="Fit the board in view"]');
  await chosen.click();
  await viewAtRest(page);
}
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
/** How big a card is on the canvas, as the layout makes it: a note, and any card across. */
const BOARD_CARD = { width: 264, note: 160 };
const nearTo = (at: { x: number; y: number }, expected: { x: number; y: number }, tolerance = 3) => Math.abs(at.x - expected.x) <= tolerance && Math.abs(at.y - expected.y) <= tolerance;

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
    await expect(frame.getByRole('listitem').filter({ hasText: 'Write the CSV writer' })).toContainText('Done:');
    await expect(frame).toContainText('Waits for you');

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
    await expect(canvas.getByRole('heading', { name: 'Commits', exact: true })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'api' })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toHaveCount(0);
  });

  test('does not say there are no new commits next to a repository that could not be read', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'gone', more: 0, commits: [], problem: 'The folder is missing.' }] }) }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/, { allowLoading: true });
    const canvas = board(page);
    await expect(canvas.getByRole('heading', { name: 'gone' })).toBeVisible();
    await expect(canvas.getByText('Could not be read: The folder is missing.')).toBeVisible();
    await expect(canvas.getByText(/No new commits/)).toHaveCount(0);

    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'gone', more: 0, commits: [], problem: 'The folder is missing.' }, { repo: 'api', more: 0, commits: [] }] }) }));
    await page.reload();
    await stepIntoArea(page);
    await expect(canvas.getByText('No new commits in the other repositories since you last looked.')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'api' })).toHaveCount(0);
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
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'A long note' }), canvas.locator('#board-area .react-flow'))).toBe(true);
    await canvas.locator('#board-area').getByRole('button', { name: 'Read all of A long note' }).click();
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toContainText('Line 30 of a long note.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    release();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeAttached();
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
    for (const title of ['Done with this', 'An old PDF']) {
      const card = canvas.getByRole('article', { name: title });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Archived');
    }
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

  test('uses a saved place over the automatic one, and puts the cards with none by the plan, not over it', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({
      cards: [boardNote(1, { title: 'Placed note' }), boardNote(2, { title: 'Second note' }), boardNote(3, { title: 'Third note' }), boardFileCard(4, 'docs/a.html', { title: 'A page' })],
      positions: { [boardId(1)]: { x: 2300, y: 333 }, 'checkpoint:reports-export-to-csv': { x: 700, y: 520 }, 'commit:billing api:a91f2e0': { x: 2000, y: 90 } },
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Placed note' })).toBeVisible();
    // A saved place is used as it is for a card. The app places checkpoints, documents and commits itself: a place saved for
    // one of them is ignored, and it stays in its group and order.
    await expect(node(page, boardId(1))).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 2300, 333)');
    expect(await canvasPosition(page, 'checkpoint:reports-export-to-csv')).toEqual({ x: 0, y: 0 });
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeVisible();
    // The others stand in a band under the checkpoints, clear of everything beside it.
    const band = canvas.getByRole('heading', { name: 'From the board' });
    await expect(band).toBeVisible();
    // Compared where they stand on the canvas: the view may still be moving, and two screen readings would differ.
    const [lane, current] = await Promise.all([canvasBox(page, 'lane:board'), canvasBox(page, 'checkpoint:reports-export-to-csv')]);
    expect(lane.y).toBeGreaterThan(current.y + current.height);
    for (const id of ['lane:documents', 'checkpoint:reports-export-to-csv', boardId(1)]) {
      const box = await canvasBox(page, id);
      const apart = box.x + box.width <= lane.x || lane.x + lane.width <= box.x || box.y + box.height <= lane.y || lane.y + lane.height <= box.y;
      expect(apart).toBe(true);
    }
    for (const title of ['Second note', 'Third note', 'A page']) await expect(canvas.getByRole('article', { name: title })).toBeVisible();
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

  test('brings a card into view when the keyboard reaches it', async ({ page }) => {
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
    await expect(far).not.toBeInViewport();
    await canvas.locator('#board-area .react-flow').focus();
    const stops: string[] = [];
    for (let press = 0; press < 12 && !(await node(page, boardId(1)).evaluate((element) => element === document.activeElement)); press += 1) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''));
    }
    await expect(node(page, boardId(1))).toBeFocused();
    expect(stops.at(-1)).toBe('A card far away');
    await expect.poll(() => isWithin(far, canvas.locator('#board-area .react-flow'))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(canvas.getByRole('button', { name: 'Open A card far away' })).toBeFocused();
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
    boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec', description: 'What a row looks like.' }),
    boardFileCard(2, 'overview.html', { title: 'Overview page', description: 'Start with the diagram.' }),
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
    await expect(board(page).locator('#board-area').getByRole('button', { name: 'Zoom in' })).toBeVisible();
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
    // On a small screen the card is out of sight below the checkpoints: the keyboard brings it into view.
    const button = opener(page, 'The CSV spec');
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

  test('moves the view only as far as it takes to keep the opened card in sight, and does not move the card', async ({ page }) => {
    // The card stands in the right of the view, where the reader will be.
    await openBoard(page, [boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec' })], { [boardId(1)]: { x: 1000, y: 330 } });
    await fitted(page);
    const canvas = board(page).locator('#board-area .react-flow');
    const [before, area] = await Promise.all([card(page, 'The CSV spec').boundingBox(), canvas.boundingBox()]);
    expect(before!.x + before!.width).toBeGreaterThan(area!.x + area!.width * 0.55);
    const place = await canvasPosition(page, boardId(1));
    const view = await transformOf(page);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    const free = (await reader(page).boundingBox())!;
    // The view glides there; it has arrived when the card is whole beside the reader.
    await expect.poll(async () => { const box = (await card(page, 'The CSV spec').boundingBox())!; return box.x + box.width <= free.x; }).toBe(true);
    await viewAtRest(page);
    const after = (await card(page, 'The CSV spec').boundingBox())!;
    expect(after.x).toBeGreaterThanOrEqual(area!.x);
    // Only the left-right place of the view changed, by as little as it took; the zoom and the card's own place did not.
    const moved = await transformOf(page);
    expect(moved.scale).toBeCloseTo(view.scale, 5);
    expect(moved.y).toBeCloseTo(view.y, 1);
    expect(moved.x).toBeLessThan(view.x);
    expect(await canvasPosition(page, boardId(1))).toEqual(place);
    // Closing does not move it back: the view is the user's.
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await viewAtRest(page);
    expect(await transformOf(page)).toEqual(moved);
  });

  test('leaves the view alone when the opened card is in sight beside the reader already', async ({ page }) => {
    await openBoard(page, [boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec' })], { [boardId(1)]: { x: 100, y: 330 } });
    await fitted(page);
    const view = await transformOf(page);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await frames(page);
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

  test('leaves the view where the user put it when a link in the reader opens another file', async ({ page }) => {
    await openBoard(page);
    await opener(page, 'Export requirements').click();
    await expect(reader(page).getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
    // The user pans away from the card that was opened, by dragging the empty canvas, until it is out of sight.
    const area = (await board(page).locator('#board-area .react-flow').boundingBox())!;
    await page.mouse.move(area.x + 60, area.y + area.height - 30);
    await page.mouse.down();
    await page.mouse.move(area.x + 60, area.y - 20, { steps: 8 });
    await page.mouse.up();
    await viewAtRest(page);
    expect(await isWithin(card(page, 'Export requirements'), board(page).locator('#board-area .react-flow'))).toBe(false);
    const moved = await transformOf(page);
    await reader(page).getByRole('link', { name: 'the design' }).click();
    await expect(readerTitle(page, 'design.md')).toBeVisible();
    await frames(page, 12);
    expect(await transformOf(page)).toEqual(moved);
  });

  test('moves the keyboard to the reader when the window narrows until it covers the canvas, and Escape still closes it', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    const button = opener(page, 'The CSV spec');
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

    test('moves the view to keep the card in sight when the window is docked over it', async ({ page }) => {
      // The card stands in the right of the view, where the dock will be.
      await openBoard(page, [boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec' })], { [boardId(1)]: { x: 1000, y: 330 } }, 'default');
      await fitted(page);
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const view = await transformOf(page);
      await sideBySide(page).click();
      const free = (await reader(page).boundingBox())!;
      await expect.poll(async () => { const box = (await card(page, 'The CSV spec').boundingBox())!; return box.x + box.width <= free.x; }).toBe(true);
      expect((await transformOf(page)).x).toBeLessThan(view.x);
    });

    test('offers no dock where the section is too narrow for both, and the window still fits', async ({ page }) => {
      await page.setViewportSize({ width: 820, height: 900 });
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'The CSV spec');
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
      await page.setViewportSize({ width: 1100, height: 900 });
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
      return openBoard(page, NOTES, PLACES);
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
      await node(page, boardId(1)).focus();
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

test.describe('Board, moving things', () => {
  /** A note with a place of its own, above the checkpoint that is under way. */
  const NOTE = { x: 352, y: -420 };
  const placedNote = (fields: Record<string, unknown> = {}) => boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory', ...fields })], positions: { [boardId(1)]: NOTE } });
  async function openWith(page: Page, content: ReturnType<typeof boardFile>, options: { fit?: boolean } = {}) {
    // The view takes a late part in at once, so a drag is measured from a view that is not about to move.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await routeBoard(page);
    const server = await routeMoves(page, content);
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/);
    if (options.fit !== false) await fitted(page);
    return server;
  }

  test('moves a card where it is dropped and keeps the place for a reload, without sending a revision', async ({ page }) => {
    const server = await openWith(page, placedNote());
    const card = board(page).getByRole('article', { name: 'Export leaks memory' });
    await expect(card).toBeInViewport();
    await expect(node(page, boardId(1))).toHaveClass(/draggable/);
    await expect(node(page, boardId(1))).toHaveCSS('cursor', 'grab');
    const { scale } = await transformOf(page);
    await dragBy(page, card, 120, 80);

    // It stays where it was dropped, in canvas units, whatever the zoom.
    const dropped = { x: NOTE.x + 120 / scale, y: NOTE.y + 80 / scale };
    await expect.poll(async () => nearTo(await canvasPosition(page, boardId(1)), dropped)).toBe(true);
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    // One move for the one node, as the user would send it. A place is independent of the rest, so no revision.
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0]).toEqual({ changes: [{ op: 'move', nodes: [{ id: boardId(1), x: expect.any(Number), y: expect.any(Number) }] }] });
    expect(server.posted[0]).not.toHaveProperty('revision');
    const saved = server.posted[0].changes[0].nodes[0];
    expect(nearTo(saved, dropped)).toBe(true);
    expect(Number.isInteger(saved.x) && Number.isInteger(saved.y)).toBe(true);
    // The card did not snap back when the answer came, and the place is the one that was saved.
    expect(await canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });

    // The place is in the board file now, so it is there after a reload.
    await page.reload();
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(board(page).getByRole('article', { name: 'Export leaks memory' })).toBeVisible();
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });
    expect(server.posted).toHaveLength(1);
  });

  test('pans the board when the empty canvas is dragged, and leaves the cards where they are', async ({ page }) => {
    const server = await openWith(page, placedNote());
    const area = (await board(page).locator('#board-area .react-flow').boundingBox())!;
    const spot = { x: area.x + 200, y: area.y + 40 };
    expect(await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest('.react-flow__node, .react-flow__controls, .react-flow__minimap'), spot)).toBe(true);
    const [viewBefore, noteAt, frameAt] = await Promise.all([transformOf(page), canvasPosition(page, boardId(1)), canvasPosition(page, 'checkpoint:reports-export-to-csv')]);
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.down();
    await page.mouse.move(spot.x + 90, spot.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await transformOf(page)).x).toBeGreaterThan(viewBefore.x + 80);
    const viewAfter = await transformOf(page);
    expect(viewAfter.x - viewBefore.x).toBeCloseTo(90, 0);
    expect(viewAfter.y - viewBefore.y).toBeCloseTo(30, 0);
    expect(await canvasPosition(page, boardId(1))).toEqual(noteAt);
    expect(await canvasPosition(page, 'checkpoint:reports-export-to-csv')).toEqual(frameAt);
    await expect(status(page)).toHaveText('');
    expect(server.posted).toEqual([]);
  });

  test('leaves a card alone that is put down where it was, or pressed on at its button, or only clicked', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardFileCard(1, 'docs/overview.html', { title: 'Overview page' })], positions: { [boardId(1)]: NOTE } }));
    const card = board(page).getByRole('article', { name: 'Overview page' });
    // A press on the button and a move is not a drag of the card.
    const open = (await card.getByRole('button', { name: 'Open Overview page' }).boundingBox())!;
    await page.mouse.move(open.x + open.width / 2, open.y + open.height / 2);
    await page.mouse.down();
    await page.mouse.move(open.x + open.width / 2 + 60, open.y + open.height / 2 + 40, { steps: 4 });
    await page.mouse.up();
    expect(await canvasPosition(page, boardId(1))).toEqual(NOTE);
    // A press that slips a pixel or two is a click.
    const body = (await card.boundingBox())!;
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
    await page.mouse.down();
    await page.mouse.move(body.x + body.width / 2 + 2, body.y + body.height / 2 + 1);
    await page.mouse.up();
    expect(await canvasPosition(page, boardId(1))).toEqual(NOTE);
    // Picked up and put down on the same spot: nothing to save.
    const from = await dragBy(page, card, 40, 30, { hold: true });
    await page.mouse.move(from.x, from.y, { steps: 4 });
    await page.mouse.up();
    expect(await canvasPosition(page, boardId(1))).toEqual(NOTE);
    // The one save that is sent is the one for the drag that moved it.
    await dragBy(page, card, 60, 0);
    await expect(status(page)).toContainText('Moved “Overview page”');
    expect(server.posted).toHaveLength(1);
  });

  test('puts a card back and says why when its place could not be saved', async ({ page }) => {
    const server = await openWith(page, placedNote());
    server.fail = { status: 409, error: 'Workspace "demo" is archived, so it cannot change the board. Its record stays readable; unarchive it (ctxspace unarchive demo) to work in it again.' };
    const canvas = board(page);
    await dragBy(page, canvas.getByRole('article', { name: 'Export leaks memory' }), 120, 80);
    // The backend's first sentence, in lower case after the colon; the rest is left out.
    await expect(status(page)).toHaveText('Could not save the place: workspace "demo" is archived, so it cannot change the board');
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual(NOTE);
    await expect(canvas.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    expect(server.posted).toHaveLength(1);
    // The message stays until it is put away, and it goes with a click.
    await canvas.getByRole('button', { name: 'Dismiss' }).click();
    await expect(status(page)).toHaveText('');
    // The card can be moved again once the board takes it.
    server.fail = null;
    await dragBy(page, canvas.getByRole('article', { name: 'Export leaks memory' }), 60, 0);
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
  });

  test('does not show the words of a server that failed, only that it did', async ({ page }) => {
    const server = await openWith(page, placedNote());
    server.fail = { status: 500, error: "EACCES: permission denied, open '/home/anna/work/contextspace-board.json'" };
    await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 120, 80);
    await expect(status(page)).toHaveText('Could not save the place: something went wrong on the server');
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual(NOTE);
  });

  test('takes a move back with Undo: to the place the card had before', async ({ page }) => {
    const server = await openWith(page, placedNote());
    const canvas = board(page);
    await dragBy(page, canvas.getByRole('article', { name: 'Export leaks memory' }), 120, 80);
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    expect((await canvasPosition(page, boardId(1))).x).toBeGreaterThan(NOTE.x + 100);
    await canvas.getByRole('button', { name: 'Undo' }).click();
    // The previous saved place is sent, and the card goes back to it; there is no Undo of an Undo.
    await expect.poll(() => server.posted.length).toBe(2);
    expect(server.posted[1]).toEqual({ changes: [{ op: 'move', nodes: [{ id: boardId(1), ...NOTE }] }] });
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual(NOTE);
    await expect(canvas.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expect(status(page)).toHaveText('');
  });

  test('offers Undo for about eight seconds', async ({ page }) => {
    await page.clock.install();
    await openWith(page, placedNote());
    const undo = board(page).getByRole('button', { name: 'Undo' });
    await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 120, 80);
    await expect(undo).toBeVisible();
    await page.clock.fastForward(7_000);
    await expect(undo).toBeVisible();
    await page.clock.fastForward(1_500);
    await expect(undo).toHaveCount(0);
    await expect(status(page)).toHaveText('');
  });

  /** Stops the page's clock where it is: what waits for time (a save that comes a moment after the last key) happens when the spec says. */
  const pauseClock = (page: Page) => page.clock.pauseAt(new Date(Date.now() + 1_000));

  test('moves a focused card with Shift and the arrow keys, and saves once, a moment after the last press', async ({ page }) => {
    await page.clock.install();
    const server = await openWith(page, placedNote());
    const canvas = board(page);
    const wrapper = node(page, boardId(1));
    // Named for what it is, and described by one hidden line that says how to move it: a stop of its own for the keyboard.
    await expect(wrapper).toHaveAttribute('aria-label', 'Export leaks memory');
    await expect(page.locator(`[id="${await wrapper.getAttribute('aria-describedby')}"]`)).toHaveText(/Press Shift and an arrow key to move it/);
    await pauseClock(page);
    await wrapper.focus();
    await expect(wrapper).toBeFocused();
    for (const key of ['Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowDown']) await page.keyboard.press(key);
    // Drawn at once, 24 units a press; saved when the presses have stopped for 400 ms, and not before.
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: NOTE.x + 72, y: NOTE.y + 24 });
    await page.clock.runFor(350);
    expect(server.posted).toHaveLength(0);
    await page.clock.runFor(100);
    await page.clock.resume();
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0]).toEqual({ changes: [{ op: 'move', nodes: [{ id: boardId(1), x: NOTE.x + 72, y: NOTE.y + 24 }] }] });
    await expect(wrapper).toBeFocused();

    // The same Undo as for a drag.
    await canvas.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual(NOTE);
    expect(server.posted).toHaveLength(2);
  });

  test('keeps the arrow keys panning from a card that was clicked, which has the keyboard; Shift and an arrow key move it instead', async ({ page }) => {
    const server = await openWith(page, placedNote());
    await board(page).getByRole('article', { name: 'Export leaks memory' }).click();
    await expect(node(page, boardId(1))).toBeFocused();
    const before = await transformOf(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await transformOf(page)).x).toBeLessThan(before.x);
    await page.keyboard.press('-');
    await expect.poll(async () => (await transformOf(page)).scale).toBeLessThan(before.scale);
    await page.keyboard.press('0');
    expect(await canvasPosition(page, boardId(1))).toEqual(NOTE);
    expect(server.posted).toHaveLength(0);
  });

  test('keeps the card in view when the keyboard moves it off the screen', async ({ page }) => {
    await page.clock.install();
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' })], positions: { [boardId(1)]: { x: 1300, y: -240 } } }), { fit: false });
    const canvas = board(page);
    const card = canvas.getByRole('article', { name: 'Export leaks memory' });
    await node(page, boardId(1)).focus();
    await expect.poll(() => isWithin(card, canvas.locator('#board-area .react-flow'))).toBe(true);
    await pauseClock(page);
    for (let press = 0; press < 40; press += 1) await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: 1300 + 40 * 24, y: -240 });
    await expect.poll(() => isWithin(card, canvas.locator('#board-area .react-flow'))).toBe(true);
    // Forty presses, one save, a moment after the last.
    await page.clock.runFor(350);
    expect(server.posted).toHaveLength(0);
    await page.clock.runFor(100);
    await page.clock.resume();
    await expect.poll(() => server.posted.length).toBe(1);
    expect(server.posted[0].changes[0].nodes[0]).toEqual({ id: boardId(1), x: 1300 + 40 * 24, y: -240 });
  });

  test('saves once when keys and a drag come within a moment of each other, and Undo goes back to the place from before both', async ({ page }) => {
    await page.clock.install();
    const server = await openWith(page, placedNote());
    await pauseClock(page);
    await node(page, boardId(1)).focus();
    await page.keyboard.press('Shift+ArrowRight');
    // The save of the drop is still out when the time for the keys comes.
    server.holdPosts = true;
    await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 100, 0);
    await expect.poll(() => server.posted.length).toBe(1);
    // The key press's timer would go off here if it were still waiting, and save the place the drop gave the card a second time.
    await page.clock.runFor(500);
    await page.clock.resume();
    await frames(page, 8);
    expect(server.posted).toHaveLength(1);
    server.holdPosts = false;
    for (const answer of server.heldPosts.splice(0)) await answer();
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    expect(server.posted).toHaveLength(1);
    await board(page).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.posted.length).toBe(2);
    expect(server.posted[1]).toEqual({ changes: [{ op: 'move', nodes: [{ id: boardId(1), ...NOTE }] }] });
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual(NOTE);
  });

  test('keeps a key press that a drag went on from: picked up and put down where the keys left it, it is still saved', async ({ page }) => {
    await page.clock.install();
    const server = await openWith(page, placedNote());
    await pauseClock(page);
    await node(page, boardId(1)).focus();
    await page.keyboard.press('Shift+ArrowRight');
    const from = await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 60, 0, { hold: true });
    await page.mouse.move(from.x, from.y, { steps: 3 });
    await page.mouse.up();
    await page.clock.runFor(500);
    await page.clock.resume();
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0].changes[0].nodes[0]).toEqual({ id: boardId(1), x: NOTE.x + 24, y: NOTE.y });
  });

  test('can move a card, in the band or not, and nothing else: not a checkpoint, a document, a commit, a lane or the plan\'s own frame', async ({ page }) => {
    await openWith(page, boardFile({ revision: 4, cards: [boardNote(1)] }));
    await expect(node(page, boardId(1))).toHaveClass(/draggable/);
    // The card stands in the band, and is still moved.
    expect(await node(page, boardId(1)).evaluate((element) => Boolean(element.closest('.react-flow')?.querySelector('[data-id="lane:board"]')))).toBe(true);
    // Inside the stepped area, all lanes and frames are open.
    for (const id of ['checkpoint:reports-export-to-csv', 'commit:billing api:a91f2e0c4d5b', 'document:export-requirements', 'lane:documents', 'lane:board', 'lane:commits:billing api']) {
      await expect(node(page, id), id).not.toHaveClass(/draggable/);
      await expect(node(page, id), id).not.toHaveAttribute('tabindex', /.*/);
    }
  });

  test('does not move a checkpoint, a document or a commit when it is dragged, or when Shift and an arrow key are pressed on it', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4 }));
    await fitted(page);
    const ids = ['checkpoint:reports-export-to-csv', 'commit:billing api:a91f2e0c4d5b', 'document:export-requirements'];
    const before = await Promise.all(ids.map((id) => canvasPosition(page, id)));
    const canvas = board(page);
    // A drag that starts on one of them is a drag of the canvas, so the whole board is brought into view for each.
    for (const name of ['Reports export to CSV', 'a91f2e0', 'Export requirements']) {
      await fitted(page);
      await dragBy(page, canvas.getByRole('article', { name }), 30, 160);
    }
    expect(await Promise.all(ids.map((id) => canvasPosition(page, id)))).toEqual(before);
    expect(server.posted).toEqual([]);
    await expect(status(page)).toHaveText('');
  });

  /** Where a node stands on the canvas, sampled on every frame from now until `stop`: a jump between two frames shows. */
  async function trackPlace(page: Page, id: string) {
    await page.evaluate((nodeId) => {
      const samples: Array<{ x: number; y: number }> = [];
      const state = { running: true, samples };
      (window as unknown as { __track: typeof state }).__track = state;
      const tick = () => {
        const element = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
        if (element) { const matrix = new DOMMatrix(getComputedStyle(element).transform); samples.push({ x: matrix.e, y: matrix.f }); }
        if (state.running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, id);
    return () => page.evaluate(() => { const state = (window as unknown as { __track: { running: boolean; samples: Array<{ x: number; y: number }> } }).__track; state.running = false; return state.samples; });
  }

  test('drags a card out of the lane and it stays exactly where it was dropped: through the save and the reread, and after a reload', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' }), boardNote(2, { title: 'Second note' })] }));
    const card = board(page).getByRole('article', { name: 'Export leaks memory' });
    // Both notes stand in the band under the checkpoints, with no place of their own.
    await expect(node(page, 'lane:board')).toBeAttached();
    const before = await canvasPosition(page, boardId(1));
    const { scale } = await transformOf(page);
    server.holdPosts = true;
    // Down and across, clear of the band: a drop over a group is put clear of it (see the specs for that).
    await dragBy(page, card, 50, -208, { hold: true });
    const dropped = { x: before.x + 50 / scale, y: before.y - 208 / scale };
    await expect.poll(async () => nearTo(await canvasPosition(page, boardId(1)), dropped)).toBe(true);
    // From before the card is let go: through the drop, the wait for the answer, the answer, and the layout that takes it out of the lane.
    const stop = await trackPlace(page, boardId(1));
    await page.mouse.up();
    await expect.poll(() => server.posted.length).toBe(1);
    await frames(page, 12);
    server.holdPosts = false;
    for (const answer of server.heldPosts.splice(0)) await answer();
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    await frames(page, 12);
    const saved = server.posted[0].changes[0].nodes[0];
    expect(server.posted[0]).not.toHaveProperty('revision');
    // The place that is saved is the one on the canvas, not the one in the lane.
    expect(nearTo(saved, dropped)).toBe(true);
    await expect.poll(async () => (await canvasPosition(page, boardId(1)))).toEqual({ x: saved.x, y: saved.y });
    await expect(node(page, boardId(2))).toBeAttached();
    // It did not jump, on any frame.
    const sampled = await stop();
    expect(sampled.length).toBeGreaterThan(20);
    for (const at of sampled) expect(nearTo(at, dropped), JSON.stringify(at)).toBe(true);

    await page.reload();
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(board(page).getByRole('article', { name: 'Export leaks memory' })).toBeVisible();
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });
    expect(server.posted).toHaveLength(1);
  });

  test('puts a card that was dragged out of the lane back in it with Undo', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' }), boardNote(2, { title: 'Second note' })] }));
    const before = await Promise.all([boardId(1), boardId(2)].map((id) => canvasPosition(page, id)));
    await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 150, -120);
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    // The cards left in the lane may close up around the gap.
    await board(page).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.posted.length).toBe(2);
    expect(server.posted[1]).toEqual({ changes: [{ op: 'move', nodes: [{ id: boardId(1), x: null, y: null }] }] });
    for (const [index, id] of [boardId(1), boardId(2)].entries()) await expect.poll(() => canvasPosition(page, id)).toEqual(before[index]);
  });

  test('moves a card of the lane with Shift and the arrow keys from where it stands on the canvas, and Undo puts it back', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' })] }));
    const before = await canvasPosition(page, boardId(1));
    await node(page, boardId(1)).focus();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowUp');
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: before.x + 48, y: before.y - 24 });
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0]).toEqual({ changes: [{ op: 'move', nodes: [{ id: boardId(1), x: Math.round(before.x + 48), y: Math.round(before.y - 24) }] }] });
    expect(await canvasPosition(page, boardId(1))).toEqual({ x: before.x + 48, y: before.y - 24 });
    await board(page).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.posted.length).toBe(2);
    expect(server.posted[1].changes[0].nodes[0]).toEqual({ id: boardId(1), x: null, y: null });
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual(before);
  });

  /** What is dragged is put clear of the groups before it is saved, so it snaps clear at once and the answer changes nothing. */
  test('puts a card dropped on an open group clear of it, saves that place, and does not move it when the answer comes', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' }), boardNote(2, { title: 'Second note' })] }));
    const canvas = board(page);
    const card = canvas.getByRole('article', { name: 'Export leaks memory' });
    const [from, onto] = await Promise.all([card.boundingBox(), canvas.getByRole('article', { name: 'Reports export to CSV' }).boundingBox()]);
    server.holdPosts = true;
    // Onto the middle of the frame that is open.
    await dragBy(page, card, onto!.x + onto!.width / 2 - (from!.x + from!.width / 2) - 6, onto!.y + 80 - (from!.y + from!.height / 2));
    await expect.poll(() => server.posted.length).toBe(1);
    const saved = server.posted[0].changes[0].nodes[0];
    const group = await canvasBox(page, 'checkpoint:reports-export-to-csv');
    // What is saved is clear of the group: below it, with the room between things, and no part of the card is over it.
    expect(saved.id).toBe(boardId(1));
    expect(saved.y).toBeGreaterThanOrEqual(group.y + group.height + 12);
    const box = { x: saved.x, y: saved.y, width: BOARD_CARD.width, height: BOARD_CARD.note };
    expect(group.x + group.width <= box.x || box.x + box.width <= group.x || group.y + group.height <= box.y || box.y + box.height <= group.y).toBe(true);
    // It snapped there when it was let go, before the answer.
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });
    const stop = await trackPlace(page, boardId(1));
    server.holdPosts = false;
    for (const answer of server.heldPosts.splice(0)) await answer();
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    await frames(page, 12);
    for (const at of await stop()) expect(at, JSON.stringify(at)).toEqual({ x: saved.x, y: saved.y });
    expect(await canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });
    // And it is the same after a reload.
    await page.reload();
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(canvas.getByRole('article', { name: 'Export leaks memory' })).toBeVisible();
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });
    expect(server.posted).toHaveLength(1);
  });

  test('puts a card dropped onto a lane below it, and saves that place', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' }), boardNote(2, { title: 'Second note' })] }));
    const canvas = board(page);
    const laneBox = await canvasBox(page, 'lane:commits:billing api');
    await fitted(page);
    const card = canvas.getByRole('article', { name: 'Export leaks memory' });
    const laneNode = node(page, 'lane:commits:billing api');
    const [from, onto] = await Promise.all([card.boundingBox(), laneNode.boundingBox()]);
    await dragBy(page, card, onto!.x + onto!.width / 2 - (from!.x + from!.width / 2) - 6, onto!.y + onto!.height / 2 - (from!.y + from!.height / 2));
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    const saved = server.posted[0].changes[0].nodes[0];
    expect(saved.y).toBe(laneBox.y + laneBox.height + 12);
    expect(await canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeVisible();
  });

  test('puts a card that is nudged into a group clear of it at once, saves that place, and saves nothing when it cannot move', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' })], positions: { [boardId(1)]: { x: 28, y: -170 } } }));
    const wrapper = node(page, boardId(1));
    const group = await canvasBox(page, 'checkpoint:reports-export-to-csv');
    const clear = { x: 28, y: group.y + group.height + 12 };
    await wrapper.focus();
    server.holdPosts = true;
    // One press moves it 24 units down, into the frame that is open: it is put just below the frame, not left over it.
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual(clear);
    await expect.poll(() => server.posted.length).toBe(1);
    expect(server.posted[0].changes[0].nodes[0]).toEqual({ id: boardId(1), ...clear });
    const stop = await trackPlace(page, boardId(1));
    server.holdPosts = false;
    for (const answer of server.heldPosts.splice(0)) await answer();
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    await frames(page, 12);
    for (const at of await stop()) expect(at, JSON.stringify(at)).toEqual(clear);
    // Pushed up against it, it would be put clear again, so nothing moves and nothing is saved.
    await page.keyboard.press('Shift+ArrowUp');
    await frames(page, 12);
    expect(await canvasPosition(page, boardId(1))).toEqual(clear);
    expect(server.posted).toHaveLength(1);
  });

  test('moves a note but not a commit: a commit is where its lane puts it', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' })] }));
    await viewAtRest(page);
    const canvas = board(page);
    const commit = canvas.getByRole('article', { name: 'a91f2e0' });
    const id = 'commit:billing api:a91f2e0c4d5b';
    const before = await Promise.all([canvasPosition(page, id), canvasPosition(page, 'lane:commits:billing api')]);
    await expect(node(page, id)).not.toHaveClass(/draggable/);
    // A drag that starts on the commit is a drag of the canvas: the view moves and the commit stays in its lane.
    const view = await transformOf(page);
    await dragBy(page, commit, 0, 120);
    await expect.poll(async () => (await transformOf(page)).y).toBeGreaterThan(view.y + 100);
    expect(await Promise.all([canvasPosition(page, id), canvasPosition(page, 'lane:commits:billing api')])).toEqual(before);
    await expect(node(page, 'lane:commits:billing api')).toBeAttached();
    expect(server.posted).toEqual([]);
    await expect(status(page)).toHaveText('');

    // A note, in the same board, can be.
    await fitted(page);
    const note = canvas.getByRole('article', { name: 'Export leaks memory' });
    const noteBefore = await canvasPosition(page, boardId(1));
    await dragBy(page, note, 90, -60);
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0].changes[0].nodes[0].id).toBe(boardId(1));
    expect(await canvasPosition(page, boardId(1))).not.toEqual(noteBefore);
    // The commit still stands where it did.
    expect(await canvasPosition(page, id)).toEqual(before[0]);
  });

  test('leaves a newer message alone when the answer to an Undo comes after it', async ({ page }) => {
    const server = await openWith(page, boardFile({
      revision: 4, cards: [boardNote(1, { title: 'Note one' }), boardNote(2, { title: 'Note two' })],
      positions: { [boardId(1)]: { x: 352, y: -420 }, [boardId(2)]: { x: 352, y: -230 } },
    }));
    await dragBy(page, board(page).getByRole('article', { name: 'Note one' }), 100, 0);
    await expect(status(page)).toHaveText('Moved “Note one”');
    server.holdPosts = true;
    await board(page).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.posted.length).toBe(2);
    await dragBy(page, board(page).getByRole('article', { name: 'Note two' }), 100, 0);
    await expect.poll(() => server.posted.length).toBe(3);
    const [undone, moved] = server.heldPosts.splice(0);
    await moved!();
    await expect(status(page)).toHaveText('Moved “Note two”');
    await undone!();
    await frames(page, 12);
    await expect(status(page)).toHaveText('Moved “Note two”');
    await expect(board(page).getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  test('puts the keyboard back on the card after Undo and after Dismiss', async ({ page }) => {
    const server = await openWith(page, placedNote());
    const wrapper = node(page, boardId(1));
    await wrapper.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(status(page)).toContainText('Moved');
    await board(page).getByRole('button', { name: 'Undo' }).focus();
    await page.keyboard.press('Enter');
    await expect(wrapper).toBeFocused();
    await expect.poll(() => server.posted.length).toBe(2);
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual(NOTE);
    await expect(wrapper).toBeFocused();

    server.fail = { status: 409, error: 'The board is busy.' };
    await page.keyboard.press('Shift+ArrowRight');
    await expect(status(page)).toContainText('Could not save the place');
    await board(page).getByRole('button', { name: 'Dismiss' }).focus();
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveText('');
    await expect(wrapper).toBeFocused();
  });

  test('keeps the offer of Undo while the pointer or the keyboard is on it, and takes the move back with Control or Command and Z', async ({ page }) => {
    await page.clock.install();
    const server = await openWith(page, placedNote());
    const canvas = board(page);
    const undo = canvas.getByRole('button', { name: 'Undo' });
    const card = canvas.getByRole('article', { name: 'Export leaks memory' });
    await dragBy(page, card, 120, 80);
    await expect(undo).toBeVisible();
    // The pointer on it: it stays, however long, and goes a while after the pointer leaves.
    await undo.hover();
    await page.clock.fastForward(20_000);
    await expect(undo).toBeVisible();
    await page.mouse.move(300, 700);
    await page.clock.fastForward(7_000);
    await expect(undo).toBeVisible();
    await page.clock.fastForward(1_500);
    await expect(undo).toHaveCount(0);

    // The keyboard on it, the same.
    await dragBy(page, card, -120, -80);
    await expect(undo).toBeVisible();
    await undo.focus();
    await page.clock.fastForward(20_000);
    await expect(undo).toBeVisible();
    await canvas.locator('#board-area .react-flow').focus();
    await page.clock.fastForward(8_500);
    await expect(undo).toHaveCount(0);

    // Control or Command and Z, from the board, while it is offered.
    await dragBy(page, card, 60, 30);
    await expect(undo).toBeVisible();
    await node(page, boardId(1)).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => server.posted.length).toBe(4);
    expect(server.posted[3].changes[0].nodes[0]).toEqual({ id: boardId(1), ...server.posted[1].changes[0].nodes[0] });
    await expect(undo).toHaveCount(0);
    await expect(node(page, boardId(1))).toBeFocused();
    // With nothing to take back it does nothing.
    await page.keyboard.press('ControlOrMeta+z');
    await frames(page, 8);
    expect(server.posted).toHaveLength(4);
  });

  test('does not take a move back for Control or Command and Z pressed in the dialog of a card', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    const server = await openWith(page, boardFile({
      revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' }), boardNote(2, { title: 'A long note', body })],
      positions: { [boardId(1)]: NOTE, [boardId(2)]: { x: 700, y: -240 } },
    }));
    await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 100, 60);
    await expect(status(page)).toContainText('Moved');
    await board(page).getByRole('button', { name: 'Read all of A long note' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'A long note' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+z');
    await frames(page, 8);
    expect(server.posted).toHaveLength(1);
    // The offer of Undo was not used up: it is still there when the dialog is closed.
    await page.keyboard.press('Escape');
    await expect(board(page).getByRole('button', { name: 'Undo' })).toBeVisible();
    expect(server.posted).toHaveLength(1);
  });

  test('has one live region, there before a move and the same element when it speaks, for what was saved and for what was not', async ({ page }) => {
    const server = await openWith(page, placedNote());
    const live = status(page);
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText('');
    await live.evaluate((element) => { (element as HTMLElement & { marked?: boolean }).marked = true; });
    await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 100, 0);
    await expect(live).toHaveText('Moved “Export leaks memory”');
    server.fail = { status: 409, error: 'The board is busy. Try again in a moment.' };
    await node(page, boardId(1)).focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(live).toHaveText('Could not save the place: the board is busy');
    // The words on the screen are for the eye; the live region says them once.
    await expect(board(page).getByRole('alert')).toHaveCount(0);
    expect(await live.evaluate((element) => Boolean((element as HTMLElement & { marked?: boolean }).marked))).toBe(true);
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
    await expect(stepped.getByRole('article', { name: 'Report rows load fast' })).toHaveCount(0);
    await expect(stepped.getByRole('article', { name: 'Rows note' })).toHaveCount(0);

    // Step out via back button
    await canvas.getByRole('button', { name: 'Board ›' }).click();
    await expect(canvas.locator('#board-area')).toHaveCount(0);
    await expect(overview.locator('button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
    await expect(overview.locator('button.board-area').filter({ hasText: 'Report rows load fast' })).toBeVisible();

    // Step into "Report rows load fast"
    await stepIntoArea(page, 'Report rows load fast');
    await expect(stepped).toBeVisible();
    await expect(stepped.getByRole('article', { name: 'Report rows load fast' })).toBeVisible();
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
      await expect(added).toBeVisible();
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
    await expect(page.locator('[role="region"][aria-label="Board"] article', { hasText: 'A long note' })).toBeAttached();
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
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
    await expect(board(page).getByRole('article', { name: 'Just added by claude' })).toBeVisible();
    expect(await feed.open()).toBe(1);
    // The board stops listening when another part is shown; the chat stays beside Docs, and its strip keeps the one connection.
    await workspaceNav(page).getByRole('link', { name: 'Docs' }).click();
    await expect(board(page)).toBeHidden();
    await expect(strip).toBeVisible();
    await afterSomeFrames(page);
    expect(await feed.open()).toBe(1);
  });

  test('does not move the card in the hand when the board is read again, and keeps the place it is put down at', async ({ page }) => {
    const feed = await holdFeed(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await routeBoard(page);
    const NOTE = { x: 352, y: -420 };
    const server = await routeMoves(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' })], positions: { [boardId(1)]: NOTE } }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    const card = canvas.getByRole('article', { name: 'Export leaks memory' });
    await expect(card).toBeVisible();
    await viewAtRest(page);
    await fitted(page);
    await expect.poll(() => feed.open()).toBe(1);
    await feed.connect();
    // Connecting reads the board; wait for that read, so the next one is the one the AI's change asks for.
    await expect.poll(() => server.reads).toBeGreaterThanOrEqual(2);
    const reads = server.reads;
    const { scale } = await transformOf(page);

    // The card is picked up and carried a little way.
    const start = await dragBy(page, card, 80, 50, { hold: true });
    const carried = { x: NOTE.x + 80 / scale, y: NOTE.y + 50 / scale };
    await expect.poll(async () => nearTo(await canvasPosition(page, boardId(1)), carried)).toBe(true);

    // Meanwhile an AI puts the same card somewhere else and adds a note.
    server.board = {
      ...server.board, revision: 5, positions: { ...server.board.positions, [boardId(1)]: { x: 1100, y: 300 } },
      cards: [...server.board.cards, boardNote(2, { title: 'Just added by claude', at: minutesAgo(0), updatedAt: minutesAgo(0) })],
    };
    await feed.send({ event: { id: 'b5', timestamp: new Date().toISOString(), harness: 'claude', event: 'board', payload: { revision: 5, changes: 2 } } });
    await expect.poll(() => server.reads).toBeGreaterThan(reads);
    await expect(canvas.getByRole('article', { name: 'Just added by claude' })).toBeVisible();
    // The card stayed in the hand, and still follows it.
    expect(nearTo(await canvasPosition(page, boardId(1)), carried)).toBe(true);
    await page.mouse.move(start.x + 120, start.y + 50, { steps: 4 });
    const dropped = { x: NOTE.x + 120 / scale, y: NOTE.y + 50 / scale };
    await expect.poll(async () => nearTo(await canvasPosition(page, boardId(1)), dropped)).toBe(true);
    await page.mouse.up();

    // The place it was put down at is the one that is saved and the one that stays.
    await expect(status(page)).toContainText('Moved “Export leaks memory”');
    const saved = server.posted[0].changes[0].nodes[0];
    expect(nearTo(saved, dropped)).toBe(true);
    expect(await canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });
    // Undo goes back to the place the card had when it was put down: the one the AI gave it.
    await canvas.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.posted.length).toBe(2);
    expect(server.posted[1]).toEqual({ changes: [{ op: 'move', nodes: [{ id: boardId(1), x: 1100, y: 300 }] }] });
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: 1100, y: 300 });
  });

  /** A board event, as the stream sends it. */
  const boardChanged = (revision: number) => ({ event: { id: `b${revision}`, timestamp: new Date().toISOString(), harness: 'claude', event: 'board', payload: { revision, changes: 1 } } });
  /** The Board open on a board with one card that has a place of its own, and the live feed connected and read. */
  async function openLive(page: Page) {
    const feed = await holdFeed(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await routeBoard(page);
    const NOTE = { x: 352, y: -420 };
    const server = await routeMoves(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' })], positions: { [boardId(1)]: NOTE } }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    await expect(board(page).getByRole('article', { name: 'Export leaks memory' })).toBeVisible();
    await viewAtRest(page);
    await fitted(page);
    await expect.poll(() => feed.open()).toBe(1);
    await feed.connect();
    await expect.poll(() => server.reads).toBeGreaterThanOrEqual(2);
    await frames(page, 10);
    return { feed, server, NOTE };
  }

  test('lets go of a card that went away while it was in the hand, so it is drawn where the board puts it when it comes back', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { feed, server } = await openLive(page);
    await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 80, 40, { hold: true });
    // An AI archives the card while it is in the hand: it is gone, and the drag is over without a drop.
    server.board = { ...server.board, revision: 5, cards: [boardNote(1, { title: 'Export leaks memory', archived: true })] };
    await feed.send(boardChanged(5));
    await expect(node(page, boardId(1))).toHaveCount(0);
    await page.mouse.move(700, 500, { steps: 3 });
    await page.mouse.up();
    // It comes back with a place of its own, and is drawn there, not where the hand left it.
    server.board = { ...server.board, revision: 6, cards: [boardNote(1, { title: 'Export leaks memory' })], positions: { [boardId(1)]: { x: 1100, y: 300 } } };
    await feed.send(boardChanged(6));
    await expect(node(page, boardId(1))).toHaveCount(1);
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: 1100, y: 300 });
    expect(server.posted).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('shows the change of an AI whose read was cancelled for a move that was then refused', async ({ page }) => {
    const { feed, server } = await openLive(page);
    // An AI adds a card, and the read that is asked for is slow.
    server.board = { ...server.board, revision: 5, cards: [...server.board.cards, boardNote(2, { title: 'Added by the AI', at: minutesAgo(0), updatedAt: minutesAgo(0) })] };
    server.holdGets = true;
    const reads = server.reads;
    await feed.send(boardChanged(5));
    await expect.poll(() => server.reads).toBeGreaterThan(reads);
    // A card is dropped while that read is out, and the move is refused: nothing else will say that the board changed.
    server.fail = { status: 409, error: 'The board is busy.' };
    await dragBy(page, board(page).getByRole('article', { name: 'Export leaks memory' }), 100, 0);
    await expect(status(page)).toContainText('Could not save the place');
    server.holdGets = false;
    for (const answer of server.heldGets.splice(0)) await answer();
    await expect(board(page).getByRole('article', { name: 'Added by the AI' })).toBeVisible();
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: 352, y: -420 });
  });

  test('puts the keyboard on the canvas when the message is put away after the card has gone', async ({ page }) => {
    const { feed, server } = await openLive(page);
    server.fail = { status: 409, error: 'The board is busy.' };
    await node(page, boardId(1)).focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(status(page)).toContainText('Could not save the place');
    server.board = { ...server.board, revision: 5, cards: [boardNote(1, { title: 'Export leaks memory', archived: true })] };
    await feed.send(boardChanged(5));
    await expect(node(page, boardId(1))).toHaveCount(0);
    await board(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(board(page).locator('#board-area .react-flow')).toBeFocused();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
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
      const server = await routeMoves(page, boardFile({
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
      await expect(canvas.getByRole('article', { name: 'Export flow' }).getByRole('img', { name: 'Export flow' })).toBeAttached();
      await expect(canvas.getByRole('button', { name: 'Read all of Export leaks memory' })).toBeVisible();
      await expect(canvas.locator('#board-area .react-flow__edge')).toHaveCount(2);
      await expectNoSeriousViolations(page, '[aria-label="Board"]');

      await canvas.locator('#board-area').getByRole('button', { name: 'Archived (2)' }).click();
      await expect(canvas.getByRole('article', { name: 'The spec' })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');

      // A card moved with the keyboard, with Undo over the canvas; and the message when it could not be saved.
      await node(page, boardId(2)).focus();
      await page.keyboard.press('Shift+ArrowRight');
      await expect(canvas.getByRole('button', { name: 'Undo' })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
      server.fail = { status: 409, error: 'The board is busy. Try again in a moment.' };
      await page.keyboard.press('Shift+ArrowRight');
      await expect(status(page)).toHaveText('Could not save the place: the board is busy');
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
