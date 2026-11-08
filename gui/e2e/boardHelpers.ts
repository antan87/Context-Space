import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect } from "./fixtures";
import { boardFile, boardNote, checkpoint, decision, planFile, step, whatsNew } from "./planData";
import type { WorkDocument } from "../src/types.ts";

export const workspace = { id: 'demo', branchName: 'demo', name: 'Reports CSV export', description: 'Add CSV export to reports', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
// A laptop-sized window, as the Board is used; a spec that needs more or less sets its own size and says why.

export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const document = (title: string, fields: Partial<WorkDocument> = {}): WorkDocument => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title, role: 'design', status: 'approved', scope: {}, summary: `About ${title}.`,
  createdAt: minutesAgo(5000), updatedAt: minutesAgo(3000), ...fields,
});

export async function routeWork(page: Page, documents: WorkDocument[]) {
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: {
    guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents },
    lifecycle: null, assignment: '', sharedDocuments: [],
  } }));
}

export async function routeBoard(page: Page) {
  // Someone said the work is on the queue step: that is the Now of the board (the plan's order alone says Next up)
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({
    now: { key: 'background-job-queue-for-large-exports', by: 'claude', at: new Date().toISOString() },
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
export async function routeCards(page: Page, board: ReturnType<typeof boardFile>) {
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: board }));
}

/**
 * A board that things can be moved on: GET answers with the board as it is, and every change that is POSTed is kept in
 * `posted`, applied as the backend applies a move (a place set, or forgotten with null) and answered with the new board.
 * While `fail` is set the answer is that error instead, and the board stays as it was. While `holdPosts` (or `holdGets`)
 * is set the answers wait in `heldPosts` (`heldGets`) until the spec sends them, in the order it likes.
 */
export async function routeMoves(page: Page, board: ReturnType<typeof boardFile>) {
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
export async function routeLateCommits(page: Page) {
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
export const PICTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export async function routePictures(page: Page) {
  await page.route('**/api/workspace/demo/documents/file**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
}

export const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
export const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
export const node = (page: Page, id: string) => board(page).locator(`.react-flow:not([inert] *) .react-flow__node[data-id="${id}"]`);

export async function stepIntoArea(page: Page, name: string | RegExp = /Reports export to CSV/, options: { allowLoading?: boolean } = {}) {
  await viewAtRest(page, options);
  const areaBtn = board(page).locator('.board-overview-plane button.board-area').filter({ hasText: name });
  if (!(await areaBtn.isVisible())) {
    const fold = board(page).locator('#board-overview button.board-area-fold');
    if (await fold.isVisible()) {
      await fold.click();
      await viewAtRest(page, options);
    }
  }
  await areaBtn.click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
  await viewAtRest(page, options);
}
/** Where a node stands on the canvas (not on the screen): its own place, or its lane's for a card in one. */
export const canvasPosition = (page: Page, id: string) => node(page, id).evaluate((element) => {
  const matrix = new DOMMatrix(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f };
});
/** A node's place and size on the canvas, in canvas units: they do not change when the view moves or is still moving. */
export const canvasBox = (page: Page, id: string) => node(page, id).evaluate((element) => {
  const matrix = new DOMMatrix(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f, width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight };
});
export const transformOf = async (page: Page) => {
  const stepped = board(page).locator('#board-area .react-flow__viewport');
  const count = await stepped.count();
  const chosen = count > 0 ? stepped : board(page).locator('#board-overview .react-flow__viewport');
  return chosen.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
};
/** Whether the whole of `inner` is inside `outer` on the screen. */
export async function isWithin(inner: Locator, outer: Locator) {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  return Boolean(a && b && a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height);
}

/**
 * Waits until every part has arrived and the view has stopped moving: it moves by itself to take in a part that comes late, and a drag is
 * measured from rest. A move shows over the frames that are drawn, so the view is read before and after a few of them: two reads one
 * after the other can both come before a move that is about to start.
 */
export async function viewAtRest(page: Page, options: { allowLoading?: boolean } = {}) {
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
export async function reveal(page: Page, target: Locator) {
  const more = board(page).locator('#board-area').locator('.react-flow__node-more button, .react-flow__node-fold button');
  // Which row holds the card is not known, and it may not have arrived yet: each row that has more than fits is opened in turn, and closed again when the card is not in it
  await expect.poll(async () => {
    if (await target.isVisible()) return true;
    // The rows slide to their places when the cards change (a late answer): they are looked at when they have stopped, and not while they move
    await nodesAtRest(page);
    if (await target.isVisible()) return true;
    const rows = await more.count();
    for (let index = 0; index < rows; index += 1) {
      await more.nth(index).click();
      await frames(page, 6);
      // The row may have pages: each is looked at
      const older = board(page).locator('#board-area').getByRole('button', { name: 'Older cards' });
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
export async function revealAll(page: Page) {
  const more = board(page).locator('#board-area').getByRole('button', { name: /^Show \d+ more for Background job queue/ });
  await frames(page, 4);
  if (await more.count()) await more.click();
  await viewAtRest(page);
}
/** Waits until the browser has drawn that many frames: whatever was going to happen in them has happened. */
export const frames = (page: Page, count = 6) => page.evaluate((total) => new Promise<void>((resolve) => {
  let drawn = 0;
  const tick = () => (++drawn >= total ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), count);
/** Waits until no node of the Area is sliding to its place (they slide when a row opens or the canvas changes size). */
export const nodesAtRest = async (page: Page) => {
  // A slide starts about 100 ms after a click or a resize: still for 8 frames in a row, so this cannot pass before it begins.
  await page.waitForFunction(() => {
    const w = window as unknown as { __nodesStill?: number };
    const nodes = Array.from(document.querySelectorAll('#board-area .react-flow__node'));
    const still = nodes.length > 0 && nodes.every((node) => node.getAnimations().length === 0);
    w.__nodesStill = still ? (w.__nodesStill ?? 0) + 1 : 0;
    return w.__nodesStill >= 8;
  }, undefined, { polling: 'raf', timeout: 10_000 });
  await page.evaluate(() => { delete (window as unknown as { __nodesStill?: number }).__nodesStill; });
};
/**
 * Drags from the middle of `target` by that many screen pixels with the mouse, and lets go unless told to hold on. React
 * Flow starts a drag at the first move of a few pixels and counts from there, so a short move starts it and the rest is
 * the distance asked for. Gives the spot the drag counts from.
 */
export async function dragBy(page: Page, target: Locator, dx: number, dy: number, options: { hold?: boolean } = {}) {
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

/** The AI's live stream and the board it changes: what the screen feed tells the board, with or without the chat. */
export const terminal = { id: '0199a213-81c0-7800-8aa1-bbab2a035a50', workspace: 'demo', target: 'shell', label: 'bash', cwd: workspace.workspacePath, state: 'running' };
export const frame = (type: string, body: Record<string, unknown>, id: string) => `event: ${type}\nid: ${id}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
export const boardEvent = (revision: number, at = new Date().toISOString()) => frame('screen', { event: { id: `b${revision}`, timestamp: at, harness: 'claude', event: 'board', payload: { revision, changes: 1 } } }, at);
export const nextEvent = (title: string) => frame('screen', { event: { id: 'n1', timestamp: new Date().toISOString(), harness: 'claude', event: 'next', payload: { title, reason: 'It has no tests yet' } } }, new Date().toISOString());
export const PING = 'event: ping\ndata: {}\n\n';
/** A stream does not reconnect for a minute, so what it sends is sent once. */
export const STREAM_HEAD = 'retry: 60000\n\n';

/**
 * What GET /board answers and how often it was asked. Before `released` it is the board as it was. After it, the read
 * that is number `newFromRead` since then, and every one after, has the new card in it: so a card only shows when the
 * board has been read that many times since the stream opened, which is what the specs check. (In development React reads
 * once more when the board opens, so a count of reads from the start would say nothing.)
 */
export async function routeChanging(page: Page, newFromRead: number, added: Record<string, unknown> = boardNote(2, { title: 'Just added by claude', at: minutesAgo(0), updatedAt: minutesAgo(0) })) {
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
export async function routeFacts(page: Page) {
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
export async function liveBoard(page: Page, state: { released: boolean }, events: string, chat: 'none' | 'hidden' | 'beside') {
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