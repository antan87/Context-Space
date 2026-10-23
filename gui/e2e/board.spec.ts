import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardFileCard, boardId, boardLink, boardNote, checkpoint, decision, planFile, step, whatsNew } from './planData';
import type { WorkDocument } from '../src/types.ts';

/**
 * The Board: the workspace's plan, documents and commits on a canvas you can pan and zoom, and the notes and files that
 * people and AIs put on it. Each part is drawn from what the Plan, Docs and "Since you last looked" already read, and a
 * part that fails does not hide the rest. It opens on the work under way, and shows an AI's changes as the screen feed
 * reports them. Cards, checkpoints, documents and commits can be dragged where you want them; the place is kept in the board file.
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

/** A one-pixel PNG, for the pictures of file cards. */
const PICTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function routePictures(page: Page) {
  await page.route('**/api/workspace/demo/documents/file**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
}

const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const node = (page: Page, id: string) => board(page).locator(`.react-flow__node[data-id="${id}"]`);
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
const transformOf = (page: Page) => board(page).locator('.react-flow__viewport').evaluate((element) => {
  const matrix = new DOMMatrix(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f, scale: matrix.a };
});
/** Whether the whole of `inner` is inside `outer` on the screen. */
async function isWithin(inner: Locator, outer: Locator) {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  return Boolean(a && b && a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height);
}

/** Waits until every part has arrived and the view has stopped moving: it moves by itself to take in a part that comes late, and a drag is measured from rest. */
async function viewAtRest(page: Page) {
  await expect(board(page).getByText(/^Still loading/)).toHaveCount(0);
  let seen = JSON.stringify(await transformOf(page));
  await expect.poll(async () => { const now = JSON.stringify(await transformOf(page)); const still = now === seen; seen = now; return still; }, { intervals: [120] }).toBe(true);
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
  await board(page).getByRole('button', { name: 'Fit the board in view' }).click();
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
const nearTo = (at: { x: number; y: number }, expected: { x: number; y: number }) => Math.abs(at.x - expected.x) <= 1 && Math.abs(at.y - expected.y) <= 1;

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
    // In plan order, left to right: by where they stand on the canvas, which does not change while the view moves to the work.
    const [lane, loose, first, second] = await Promise.all(['lane:documents', 'plan:own', 'checkpoint:report-rows-load-fast', 'checkpoint:reports-export-to-csv'].map((id) => canvasPosition(page, id)));
    expect(lane.x).toBeLessThan(loose.x);
    expect(loose.x).toBeLessThan(first.x);
    expect(first.x).toBeLessThan(second.x);

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
    expect((await canvasPosition(page, 'lane:commits:billing api')).x).toBeGreaterThan(second.x);
  });

  test('opens on the checkpoint under way, at a readable zoom, with zoom controls and a minimap', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    const current = canvas.getByRole('article', { name: 'Reports export to CSV' });
    await expect(current).toBeVisible();
    // The first checkpoint that is not done, whole and in the middle of the canvas, with its neighbours beside it.
    await expect.poll(() => isWithin(current, canvas.locator('.react-flow'))).toBe(true);
    const [frame, area] = await Promise.all([current.boundingBox(), canvas.locator('.react-flow').boundingBox()]);
    expect(Math.abs(frame!.x + frame!.width / 2 - (area!.x + area!.width / 2))).toBeLessThan(area!.width / 4);
    await expect(canvas.getByRole('article', { name: 'Report rows load fast' })).toBeInViewport();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeInViewport();
    // At a zoom you can read, not the one that fits every column in the window: the documents are off to the left.
    const { scale } = await transformOf(page);
    expect(scale).toBeGreaterThanOrEqual(0.8);
    expect(scale).toBeLessThanOrEqual(1);
    await expect(canvas.getByRole('article', { name: 'Export requirements' })).not.toBeInViewport();
    await expect(canvas.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Zoom out' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Fit the board in view' })).toBeVisible();
    await expect(canvas.getByRole('img', { name: 'Board overview' })).toBeVisible();
  });

  test('opens on the last checkpoint when every checkpoint is done', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({
      title: 'Reports CSV export',
      checkpoints: ['Report rows load fast', 'Reports export to CSV', 'Background queue', 'Download link', 'Release notes'].map((title) => checkpoint(title, { done: true })),
    }) }));
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    const last = canvas.getByRole('article', { name: 'Release notes' });
    await expect(last).toBeVisible();
    await expect.poll(() => isWithin(last, canvas.locator('.react-flow'))).toBe(true);
    await expect(canvas.getByRole('article', { name: 'Report rows load fast' })).not.toBeInViewport();
  });

  test('zooms and pans with the controls and the keyboard, and fits the whole board on request', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeInViewport();
    const opened = await transformOf(page);

    await canvas.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(async () => (await transformOf(page)).scale).toBeGreaterThan(opened.scale);
    // One click puts everything in view, documents on the left to commits on the right.
    await canvas.getByRole('button', { name: 'Fit the board in view' }).click();
    await expect.poll(async () => (await transformOf(page)).scale).toBeLessThan(opened.scale);
    const area = canvas.locator('.react-flow');
    for (const name of ['Export requirements', 'Reports export to CSV', 'a91f2e0']) await expect.poll(() => isWithin(canvas.getByRole('article', { name }), area)).toBe(true);
    const fitted = await transformOf(page);

    // The canvas is one keyboard stop: arrows pan, plus and minus zoom, zero fits.
    await canvas.getByRole('application').focus();
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
    const canvas = board(page);
    await expect(canvas.getByText('No new commits since you last looked.')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Commits', exact: true })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toHaveCount(0);
  });

  test('does not say there are no new commits next to a repository that could not be read', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'gone', more: 0, commits: [], problem: 'The folder is missing.' }] }) }));
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('heading', { name: 'gone' })).toBeVisible();
    await expect(canvas.getByText('Could not be read: The folder is missing.')).toBeVisible();
    await expect(canvas.getByText(/No new commits/)).toHaveCount(0);
    // With one repository that could be read and one that could not, it speaks of the others.
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'gone', more: 0, commits: [], problem: 'The folder is missing.' }, { repo: 'api', more: 0, commits: [] }] }) }));
    await page.reload();
    await expect(canvas.getByText('No new commits in the other repositories since you last looked.')).toBeVisible();
  });

  test('moves to the work again, without being rebuilt, when a part arrives after the board opened', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the CSV writer', at: minutesAgo(30) }] }] }) });
    });
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    // The canvas drawn for the first parts is the one that stays: its controls are marked now and must still be marked later.
    await canvas.locator('.react-flow__controls').evaluate((element) => { (element as HTMLElement & { marked?: boolean }).marked = true; });
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeVisible();
    // Untouched, the view moves to take in the new lane beside the work: the commit ends up whole on screen.
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'a91f2e0' }), canvas.locator('.react-flow'))).toBe(true);
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'Reports export to CSV' }), canvas.locator('.react-flow'))).toBe(true);
    expect(await canvas.locator('.react-flow__controls').evaluate((element) => (element as HTMLElement & { marked?: boolean }).marked)).toBe(true);
  });

  /** The commits, a second and a half late, so the board is open and the user can act before they arrive. */
  async function routeLateCommits(page: Page) {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the CSV writer', at: minutesAgo(30) }] }] }) });
    });
  }
  /** Waits until the browser has drawn a few frames, which is when a move of the view that was going to start has started. */
  const afterSomeFrames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const tick = () => (++frames >= 6 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));

  test('leaves the view where the user put it when a part arrives after they moved it', async ({ page }) => {
    await routeLateCommits(page);
    const answered = page.waitForResponse('**/api/workspace/demo/news');
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    // Drag the empty canvas above the checkpoints.
    const area = (await canvas.locator('.react-flow').boundingBox())!;
    await page.mouse.move(area.x + 200, area.y + 40);
    await page.mouse.down();
    await page.mouse.move(area.x + 350, area.y + 70, { steps: 5 });
    await page.mouse.up();
    // Still before the commits: the user moved the view first.
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    const moved = await transformOf(page);
    await answered;
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeAttached();
    await afterSomeFrames(page);
    expect(await transformOf(page)).toEqual(moved);
  });

  test('keeps following the work after a press on a card\'s button or the archived toggle, which do not move the view', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    await routeLateCommits(page);
    // The long note stands in view above the checkpoints: when the focus comes back to its button, the card is not out of view.
    await routeCards(page, boardFile({ cards: [boardNote(1, { archived: true }), boardNote(2, { title: 'A long note', body })], positions: { [boardId(2)]: { x: 800, y: -200 } } }));
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    await canvas.getByRole('button', { name: 'Archived (1)' }).click();
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    // React Flow's pane wraps the cards, so a press on a card's own button must not be taken for a press on the canvas.
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'A long note' }), canvas.locator('.react-flow'))).toBe(true);
    await canvas.getByRole('button', { name: 'Read all of A long note' }).click();
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toContainText('Line 30 of a long note.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    // The view still moves to take in the commits that come: they end up whole on screen.
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'a91f2e0' }), canvas.locator('.react-flow'))).toBe(true);
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
    await expect(board(page).getByText('Nothing on the board yet. The plan, documents and commits of this workspace appear here, and so do the notes and files you and the AI add.')).toBeVisible();
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

  test('names the notes and files when they could not be read, and still draws the rest', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ status: 500, json: { error: 'The board file is not valid JSON.' } }));
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('alert')).toContainText('The notes and files could not be read: The board file is not valid JSON.', { timeout: 20_000 });
    await expect(canvas.getByRole('alert')).toHaveCount(1);
    await expect(canvas.getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeVisible();
  });

  test('does not read a reply that is not a board as an empty one', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: { hello: 'an older backend' } }));
    await page.goto('/#/workspaces/demo/board');
    // A failed read is tried again a few times before it is called a failure.
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

  test('opens a file where the app opens documents: in Docs', async ({ page }) => {
    await routeBoard(page);
    const documents = [{ name: 'overview.html', kind: 'html', size: 120, modifiedAt: '2026-10-22T00:00:00.000Z' }];
    const opened: string[] = [];
    await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents } }));
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
      const name = new URL(route.request().url()).searchParams.get('name') ?? '';
      opened.push(name);
      return route.fulfill({ json: { name, kind: 'html', size: 120, modifiedAt: '2026-10-22T00:00:00.000Z', content: '<!doctype html><html><body><h1>The overview</h1></body></html>' } });
    });
    await routeCards(page, boardFile({ cards: [boardFileCard(1, 'overview.html', { title: 'Overview page', description: 'Start with the diagram.' })] }));
    await page.goto('/#/workspaces/demo/board');
    // The card stands in the band under the checkpoints, which may be out of view: the keyboard reaches it all the same.
    await board(page).getByRole('article', { name: 'Overview page' }).getByRole('button', { name: 'Open Overview page' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/workspaces\/demo\/documents$/);
    await expect(page.getByTitle('Preview of overview.html')).toBeVisible();
    expect(opened).toContain('overview.html');
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
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Keep this in front' })).toContainText('Pinned');
    await expect(canvas.getByRole('article', { name: 'Just a note' })).not.toContainText('Pinned');
    await expect(canvas.getByRole('article', { name: 'Done with this' })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'An old PDF' })).toHaveCount(0);

    const toggle = canvas.getByRole('button', { name: 'Archived (2)' });
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
    await expect(board(page).getByRole('article', { name: 'Note 1' })).toBeVisible();
    await expect(board(page).getByRole('button', { name: /^Archived/ })).toHaveCount(0);
  });

  test('is the first stop for the keyboard, ahead of the cards', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardNote(1, { archived: true }), boardFileCard(2, 'docs/a.html')] }));
    await page.goto('/#/workspaces/demo/board');
    await expect(board(page).getByRole('button', { name: 'Archived (1)' })).toBeVisible();
    // It comes before the canvas in the tab order, so a keyboard user does not tab through every card to reach it.
    await board(page).getByRole('application').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(board(page).getByRole('button', { name: 'Archived (1)' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(board(page).getByRole('application')).toBeFocused();
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
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Export leaks memory' })).toBeVisible();
    const edges = canvas.locator('.react-flow__edge');
    await expect(edges).toHaveCount(3);
    // Named by what they join, with the label, not by ids.
    await expect(canvas.getByRole('img', { name: 'Link from Export leaks memory to Reports export to CSV: found while' })).toBeAttached();
    await expect(canvas.getByRole('img', { name: 'Link from Export flow to commit a91f2e0' })).toBeAttached();
    await expect(canvas.getByRole('img', { name: 'Link from Export leaks memory to Export flow' })).toBeAttached();
    await expect(canvas.locator('.react-flow__edge-text')).toHaveText(['found while']);
    // The commit is found by the shorter hash a card was linked with.
    await expect(canvas.getByRole('img', { name: /gone/ })).toHaveCount(0);
  });

  test('uses a saved place over the automatic one, and puts the cards with none by the plan, not over it', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({
      cards: [boardNote(1, { title: 'Placed note' }), boardNote(2, { title: 'Second note' }), boardNote(3, { title: 'Third note' }), boardFileCard(4, 'docs/a.html', { title: 'A page' })],
      positions: { [boardId(1)]: { x: 1111, y: 333 }, 'checkpoint:report-rows-load-fast': { x: 700, y: 520 }, 'commit:billing api:a91f2e0': { x: 2000, y: 90 } },
    }));
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Placed note' })).toBeVisible();
    // Saved places are used as they are, for a card and for the board's own checkpoint and commit.
    await expect(node(page, boardId(1))).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 1111, 333)');
    await expect(node(page, 'checkpoint:report-rows-load-fast')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 700, 520)');
    await expect(node(page, 'commit:billing api:a91f2e0c4d5b')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 2000, 90)');
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
    const canvas = board(page);
    const far = canvas.getByRole('article', { name: 'A card far away' });
    await expect(far).toBeVisible();
    await expect(far).not.toBeInViewport();
    await canvas.getByRole('application').focus();
    // What can be moved is a stop for the keyboard, in reading order (the two checkpoints, the commit, then the card), and then its buttons.
    for (const stop of ['checkpoint:report-rows-load-fast', 'checkpoint:reports-export-to-csv', 'commit:billing api:a91f2e0c4d5b', boardId(1)]) {
      await page.keyboard.press('Tab');
      await expect(node(page, stop)).toBeFocused();
    }
    await expect.poll(() => isWithin(far, canvas.locator('.react-flow'))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(canvas.getByRole('button', { name: 'Open A card far away' })).toBeFocused();
  });

  test('draws nothing of its own for a card with a path that leaves the workspace', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardFileCard(1, '../../etc/passwd', { title: 'Sneaky' }), boardFileCard(2, '/etc/passwd', { title: 'Sneakier' }), boardNote(3, { title: 'Fine' })] }));
    await page.goto('/#/workspaces/demo/board');
    await expect(board(page).getByRole('article', { name: 'Fine' })).toBeVisible();
    await expect(board(page).getByRole('article', { name: /Sneak/ })).toHaveCount(0);
  });
});

test.describe('Board, moving things', () => {
  /** A note with a place of its own, above the checkpoint that is under way. */
  const NOTE = { x: 1060, y: -240 };
  const placedNote = (fields: Record<string, unknown> = {}) => boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory', ...fields })], positions: { [boardId(1)]: NOTE } });
  async function openWith(page: Page, content: ReturnType<typeof boardFile>, options: { fit?: boolean } = {}) {
    // The view takes a late part in at once, so a drag is measured from a view that is not about to move.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await routeBoard(page);
    const server = await routeMoves(page, content);
    await page.goto('/#/workspaces/demo/board');
    await expect(board(page).getByRole('article', { name: 'Reports export to CSV' })).toBeVisible();
    await viewAtRest(page);
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
    await expect(board(page).getByRole('article', { name: 'Export leaks memory' })).toBeVisible();
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: saved.x, y: saved.y });
    expect(server.posted).toHaveLength(1);
  });

  test('pans the board when the empty canvas is dragged, and leaves the cards where they are', async ({ page }) => {
    const server = await openWith(page, placedNote());
    const area = (await board(page).locator('.react-flow').boundingBox())!;
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

  test('forgets the place with Undo when the thing had none, so it goes back to where the board puts it', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4 }));
    const canvas = board(page);
    const ids = ['checkpoint:report-rows-load-fast', 'checkpoint:reports-export-to-csv'];
    const before = await Promise.all(ids.map((id) => canvasPosition(page, id)));
    // A checkpoint stands on its own in the row of columns, so it can be dragged too.
    await dragBy(page, canvas.getByRole('article', { name: 'Report rows load fast' }), 40, 260);
    await expect(status(page)).toContainText('Moved “Report rows load fast”');
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0].changes[0].nodes[0]).toEqual({ id: ids[0], x: expect.any(Number), y: expect.any(Number) });
    // Its column closes up around the gap, as it does for a place an AI gave it.
    await expect.poll(async () => (await canvasPosition(page, ids[1])).x).toBeLessThan(before[1]!.x);

    await canvas.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => server.posted.length).toBe(2);
    expect(server.posted[1]).toEqual({ changes: [{ op: 'move', nodes: [{ id: ids[0], x: null, y: null }] }] });
    for (const [index, id] of ids.entries()) await expect.poll(() => canvasPosition(page, id)).toEqual(before[index]);
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
    await expect.poll(() => isWithin(card, canvas.locator('.react-flow'))).toBe(true);
    await pauseClock(page);
    for (let press = 0; press < 40; press += 1) await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: 1300 + 40 * 24, y: -240 });
    await expect.poll(() => isWithin(card, canvas.locator('.react-flow'))).toBe(true);
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

  test('can move a checkpoint, a commit and a card in a lane, and not a lane, the plan\'s own frame or what is no thing of the board\'s', async ({ page }) => {
    await openWith(page, boardFile({ revision: 4, cards: [boardNote(1)] }));
    for (const id of ['checkpoint:reports-export-to-csv', 'commit:billing api:a91f2e0c4d5b', boardId(1)]) await expect(node(page, id)).toHaveClass(/draggable/);
    // A card and a commit stand in a lane and are still moved; the lanes themselves are not, nor is the plan's own frame.
    expect(await node(page, boardId(1)).evaluate((element) => Boolean(element.closest('.react-flow')?.querySelector('[data-id="lane:board"]')))).toBe(true);
    for (const id of ['lane:documents', 'lane:board', 'lane:commits:billing api', 'plan:own']) {
      await expect(node(page, id)).not.toHaveClass(/draggable/);
      await expect(node(page, id)).not.toHaveAttribute('tabindex', /.*/);
    }
    // The mocked documents have no uuid for an id, so the board cannot keep a place for them.
    await expect(node(page, 'document:export-requirements')).not.toHaveClass(/draggable/);
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
    await dragBy(page, card, 150, -120, { hold: true });
    const dropped = { x: before.x + 150 / scale, y: before.y - 120 / scale };
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

  test('drags a commit out of its lane, which goes when it is empty, and Undo brings both back', async ({ page }) => {
    const server = await openWith(page, boardFile({ revision: 4 }));
    const id = 'commit:billing api:a91f2e0c4d5b';
    const before = await Promise.all([canvasPosition(page, id), canvasPosition(page, 'lane:commits:billing api')]);
    const { scale } = await transformOf(page);
    await dragBy(page, board(page).getByRole('article', { name: 'a91f2e0' }), 0, 200);
    await expect(status(page)).toContainText('Moved “commit a91f2e0”');
    const dropped = { x: before[0].x, y: before[0].y + 200 / scale };
    const saved = server.posted[0].changes[0].nodes[0];
    expect(saved.id).toBe(id);
    expect(nearTo(saved, dropped)).toBe(true);
    await expect.poll(() => canvasPosition(page, id)).toEqual({ x: saved.x, y: saved.y });
    // The only commit of the repository left, so its lane went with it.
    await expect(node(page, 'lane:commits:billing api')).toHaveCount(0);
    await board(page).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => canvasPosition(page, id)).toEqual(before[0]);
    await expect.poll(() => canvasPosition(page, 'lane:commits:billing api')).toEqual(before[1]);
  });

  test('leaves a newer message alone when the answer to an Undo comes after it', async ({ page }) => {
    const server = await openWith(page, boardFile({
      revision: 4, cards: [boardNote(1, { title: 'Note one' }), boardNote(2, { title: 'Note two' })],
      positions: { [boardId(1)]: { x: 1060, y: -240 }, [boardId(2)]: { x: 1060, y: -40 } },
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
    await canvas.getByRole('application').focus();
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
    const NOTE = { x: 1060, y: -240 };
    const server = await routeMoves(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' })], positions: { [boardId(1)]: NOTE } }));
    await page.goto('/#/workspaces/demo/board');
    const canvas = board(page);
    const card = canvas.getByRole('article', { name: 'Export leaks memory' });
    await expect(card).toBeInViewport();
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
      ...server.board, revision: 5, positions: { ...server.board.positions, [boardId(1)]: { x: 300, y: 300 } },
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
    expect(server.posted[1]).toEqual({ changes: [{ op: 'move', nodes: [{ id: boardId(1), x: 300, y: 300 }] }] });
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: 300, y: 300 });
  });

  /** A board event, as the stream sends it. */
  const boardChanged = (revision: number) => ({ event: { id: `b${revision}`, timestamp: new Date().toISOString(), harness: 'claude', event: 'board', payload: { revision, changes: 1 } } });
  /** The Board open on a board with one card that has a place of its own, and the live feed connected and read. */
  async function openLive(page: Page) {
    const feed = await holdFeed(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await routeBoard(page);
    const NOTE = { x: 1060, y: -240 };
    const server = await routeMoves(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory' })], positions: { [boardId(1)]: NOTE } }));
    await page.goto('/#/workspaces/demo/board');
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
    server.board = { ...server.board, revision: 6, cards: [boardNote(1, { title: 'Export leaks memory' })], positions: { [boardId(1)]: { x: 300, y: 300 } } };
    await feed.send(boardChanged(6));
    await expect(node(page, boardId(1))).toHaveCount(1);
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: 300, y: 300 });
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
    await expect.poll(() => canvasPosition(page, boardId(1))).toEqual({ x: 1060, y: -240 });
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
    await expect(board(page).getByRole('application')).toBeFocused();
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
      const canvas = board(page);
      await expect(canvas.getByRole('article', { name: 'Draft notes' })).toBeVisible();
      await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeVisible();
      await expect(canvas.getByRole('article', { name: 'Export flow' }).getByRole('img', { name: 'Export flow' })).toBeAttached();
      await expect(canvas.getByRole('button', { name: 'Read all of Export leaks memory' })).toBeVisible();
      await expect(canvas.locator('.react-flow__edge')).toHaveCount(2);
      await canvas.getByRole('button', { name: 'Archived (2)' }).click();
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
      await canvas.getByRole('button', { name: 'Read all of Export leaks memory' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Export leaks memory' })).toBeVisible();
      await expectNoSeriousViolations(page, '[role="dialog"]');
    });
  });
}
