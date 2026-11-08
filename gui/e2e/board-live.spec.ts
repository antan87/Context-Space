import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  boardFile,
  boardNote,
} from "./planData";
import {
  workspace,
  minutesAgo,
  routeBoard,
  workspaceNav,
  board,
  stepIntoArea,
  reveal,
  boardEvent,
  nextEvent,
  PING,
  routeChanging,
  routeFacts,
  liveBoard,
} from "./boardHelpers";

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

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
    await expect(board(page).getByRole('article', { name: 'A long note' }).getByRole('button', { name: 'Read A long note' })).toBeVisible();
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
