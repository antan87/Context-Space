import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardFileCard, checkpoint, planFile, step } from './planData';

/**
 * The chat is the centre of the app. It takes most of the screen, the other parts of a workspace
 * (Board, Overview, Sessions) open beside it when asked for, workspaces are
 * switched from inside the chat, and the app opens on the chat you were last in.
 */
const workspace = (id: string, extra: Record<string, unknown> = {}) => ({
  id, branchName: id, description: `${id} workspace`, repos: [], assistants: [], workspacePath: `/tmp/${id}`, createdAt: '2026-09-24T00:00:00Z', ...extra,
});

test.use({
  workspacesData: [[workspace('alpha', { name: 'Faster search' }), workspace('beta'), workspace('old', { archivedAt: '2026-09-01T00:00:00Z' })], { option: true }],
  viewport: { width: 1440, height: 900 },
});

const SHOTS = process.env.PLAN_SHOTS_DIR;
const LAYOUT_KEY = 'contextspace_chat_layout_v1';
const CHAT_KEY = 'contextspace_floating_chat_state_v1';

test.beforeEach(async ({ page }) => {
  // The chat shows beside other parts here, unlike the fixture's default.
  // Seeded once per tab, over the fixture's default, so a reload keeps whatever the page saved.
  await page.addInitScript((key) => {
    try {
      if (!sessionStorage.getItem('layout-seeded')) { localStorage.setItem(key, JSON.stringify({ hidden: false, percent: 62 })); sessionStorage.setItem('layout-seeded', '1'); }
    } catch { /* Storage can be unavailable. */ }
  }, LAYOUT_KEY);
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    return route.fulfill({ json: { available: true, sessions: [{ id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' }], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } });
  });
  // The same shells, as this browser's running terminals: a running session shows beside the plan.
  await page.route('**/api/terminals/running', (route) => route.fulfill({ json: { sessions: ['alpha', 'beta'].map((id) => ({
    id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running', startedAt: '2026-09-24T00:00:00Z', attached: true,
  })) } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planFile() }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal: { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: `/tmp/${parsed.workspace}`, state: 'running' }, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
});

const chatOf = (page: Page) => page.getByRole('region', { name: 'CLI Chat', exact: true });
const destinations = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
/** An open chat is a session in the sidebar; the one on screen is the current page. */
const session = (page: Page, branch: string) => page.locator(`aside.context-sidebar [data-sidebar-session="${branch}"]`);
const boxOf = async (locator: ReturnType<typeof chatOf>) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box');
  return box;
};
const BODY_LEFT = 256;
/** The workspace rail along the right edge. */
const RAIL = 64;

test.describe('the app opens on the chat', () => {
  test('on the chat you were last in', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ openTabs: ['alpha', 'beta'], activeTab: 'beta', modes: {} })), CHAT_KEY);
    await page.goto('/');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await expect(chatOf(page)).toBeVisible();
    await expect(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
  });

  test('on the overview when no chat was open, and the overview is still one click away', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('aside.context-sidebar')).toBeVisible();
    await expect(page).not.toHaveURL(/workspaces/);
    await expect(chatOf(page)).toBeHidden();
    await page.goto('/#/workspaces/alpha/chat');
    await page.locator('aside.context-sidebar').getByRole('link', { name: /^Overview/ }).click();
    await expect(page).toHaveURL(/#\/overview$/);
  });

  test('on the overview when the chat you were in no longer exists', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ openTabs: ['deleted'], activeTab: 'deleted', modes: {} })), CHAT_KEY);
    await page.goto('/');
    await expect(page.locator('aside.context-sidebar')).toBeVisible();
    await expect(page).not.toHaveURL(/workspaces/);
    await expect(chatOf(page)).toBeHidden();
  });
});

test.describe('the chat is central, with other parts beside it', () => {
  test('keeps the chosen terminal share with the Board on the left', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/board');
    await expect(chatOf(page)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    const chat = await boxOf(chatOf(page));
    const panel = await boxOf(page.getByRole('region', { name: 'Board', exact: true }));
    const body = 1440 - BODY_LEFT;
    expect(chat.width / body).toBeGreaterThan(0.55);
    expect(chat.width).toBeGreaterThan(panel.width);
    // Board is on the left; the terminal keeps its chosen share.
    expect(panel.x + panel.width).toBeLessThanOrEqual(chat.x + 1);
    await expect(page.getByRole('separator', { name: 'Resize the workspace panes' })).toBeVisible();
  });

  // The app's own default is the slim sidebar; at 1100 px a docked one leaves no room for Split.
  test.describe('with the slim sidebar', () => {
  test.use({ sidebarDocked: false });
  for (const [width, height] of [[1100, 700], [1280, 800], [1440, 900]] as const) {
    test(`keeps the whole workspace rail on screen in Split at ${width}x${height}, also with the chat dragged wide`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/#/workspaces/alpha/board');
      await expect(chatOf(page)).toBeVisible();
      const board = page.getByRole('region', { name: 'Board', exact: true });
      await expect(board).toBeVisible();
      const check = async () => {
        const rail = (await destinations(page).boundingBox())!;
        expect(rail.x + rail.width).toBeLessThanOrEqual(width + 0.5);
        expect(rail.width).toBeGreaterThan(30);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const chat = await boxOf(chatOf(page));
        const panel = await boxOf(board);
        expect(panel.x + panel.width).toBeLessThanOrEqual(chat.x + 1);
        expect(chat.x + chat.width).toBeLessThanOrEqual(rail.x + 1);
        expect(panel.width).toBeGreaterThanOrEqual(340);
      };
      await check();
      // Drag the divider as far toward the Board as it goes, and then as far the other way.
      const divider = page.getByRole('separator', { name: 'Resize the workspace panes' });
      const handle = (await divider.boundingBox())!;
      await page.mouse.move(handle.x + 2, handle.y + 100);
      await page.mouse.down();
      await page.mouse.move(256, handle.y + 100, { steps: 6 });
      await page.mouse.up();
      await check();
      const wide = await divider.boundingBox();
      await page.mouse.move(wide!.x + 2, wide!.y + 100);
      await page.mouse.down();
      await page.mouse.move(width - 60, wide!.y + 100, { steps: 6 });
      await page.mouse.up();
      await check();
    });
  }

  test('an old saved chat width that no longer fits is clamped for the screen, not lost', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.addInitScript((key) => { try { localStorage.setItem(key, JSON.stringify({ hidden: false, percent: 75 })); } catch { /* Storage can be unavailable. */ } }, LAYOUT_KEY);
    await page.goto('/#/workspaces/alpha/board');
    await expect(chatOf(page)).toBeVisible();
    // The divider announces the maximum that fits here, not the saved 75.
    await expect(page.getByRole('separator', { name: 'Resize the workspace panes' })).toHaveAttribute('aria-valuemax', '60');
    const rail = (await destinations(page).boundingBox())!;
    expect(rail.x + rail.width).toBeLessThanOrEqual(1100.5);
    expect((await boxOf(page.getByRole('region', { name: 'Board', exact: true }))).width).toBeGreaterThanOrEqual(340);
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).percent, LAYOUT_KEY)).toBe(75);
  });

  });

  test('"Open plan & sources" on the overview opens the Board with the plan in view and the focus inside it', async ({ page }) => {
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planFile({ checkpoints: [checkpoint('Cache invoice lookups', { steps: [step('Cache the totals')] })] }) }));
    await page.goto('/#/workspaces/alpha/overview');
    await page.getByRole('button', { name: 'Open plan & sources' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/board$/);
    const board = page.getByRole('region', { name: 'Board', exact: true });
    await expect(board).toBeVisible();
    await expect(board.getByText('Cache invoice lookups').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const region = document.querySelector('[role="region"][aria-label="Board"]');
      return Boolean(region && region.contains(document.activeElement) && document.activeElement !== document.body);
    })).toBe(true);
  });

  test.describe('"Open plan & sources" when the Board was left in a deeper place', () => {
    const planWithSteps = () => planFile({ checkpoints: [checkpoint('Cache invoice lookups', { steps: [step('Cache the totals'), step('Expire them on change')] })] });
    const focusInBoard = (page: Page) => page.evaluate(() => {
      const region = document.querySelector('[role="region"][aria-label="Board"]');
      const active = document.activeElement;
      return Boolean(region && active && active !== document.body && region.contains(active) && !active.closest('[inert]'));
    });
    async function leaveAndPress(page: Page) {
      await destinations(page).getByRole('link', { name: 'Overview', exact: true }).click();
      await expect(page).toHaveURL(/#\/workspaces\/alpha\/overview$/);
      await page.getByRole('button', { name: 'Open plan & sources' }).click();
      await expect(page).toHaveURL(/#\/workspaces\/alpha\/board$/);
    }

    test('inside an Area, it steps out so the plan is in view, and the focus is on a card, not on the page', async ({ page }) => {
      await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planWithSteps() }));
      await page.goto('/#/workspaces/alpha/board');
      const card = page.locator('#board-overview button.board-area').first();
      await card.click();
      await expect(page.locator('#board-area')).toBeVisible();
      await leaveAndPress(page);
      await expect(page.locator('#board-area')).toHaveCount(0);
      await expect(page.locator('#board-overview button.board-area').first()).toBeVisible();
      await expect.poll(() => focusInBoard(page)).toBe(true);
    });

    test('inside an Area with a picture open in the reader, it closes the reader, steps out and puts the focus in the overview', async ({ page }) => {
      await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planWithSteps() }));
      await page.route('**/api/workspace/*/documents/file**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') }));
      await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [boardFileCard(2, 'board-pictures/a.png', { title: 'The overview', step: undefined, area: 'checkpoint:cache-invoice-lookups' })] }) }));
      await page.goto('/#/workspaces/alpha/board');
      await page.getByTestId('view-mode-board').click();
      // The picture's card is in an Area: step in, then open it in the reader.
      await page.locator('#board-overview button[aria-label^="Show the 1 picture"]').first().click();
      await page.locator('#board-area').getByRole('button', { name: 'Open The overview' }).click();
      await expect(page.locator('[data-board-reader]')).toBeVisible();
      await leaveAndPress(page);
      await expect(page.locator('[data-board-reader]')).toHaveCount(0);
      await expect(page.locator('#board-area')).toHaveCount(0);
      await expect(page.locator('#board-overview button.board-area').first()).toBeVisible();
      await expect.poll(() => focusInBoard(page)).toBe(true);
    });

    const inChat = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="region"][aria-label="CLI Chat"]')));
    async function focusChat(page: Page) {
      await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
      await chatOf(page).locator('textarea').first().focus();
      expect(await inChat(page)).toBe(true);
    }

    test('leaving the Board right after the press, or stepping into an Area, ends the wish: coming back with the keyboard in the chat leaves it there', async ({ page }) => {
      await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planWithSteps() }));
      for (const leave of ['rail', 'area'] as const) {
        await page.goto('/#/workspaces/alpha/overview');
        await page.getByRole('button', { name: 'Open plan & sources' }).click();
        if (leave === 'rail') await destinations(page).getByRole('link', { name: 'Skills' }).click();
        else await page.locator('#board-overview button.board-area').first().click();
        await expect(leave === 'rail' ? page.getByRole('region', { name: 'Board', exact: true }) : page.locator('#board-area')).toBeHidden({ timeout: 100 }).catch(() => undefined);
        if (leave === 'rail') await expect(destinations(page).getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');
        else await expect(page.locator('#board-area')).toBeVisible();
        await focusChat(page);
        if (leave === 'rail') {
          await page.keyboard.press('Control+2');
          await expect(page).toHaveURL(/#\/workspaces\/alpha\/board$/);
        }
        await page.waitForTimeout(800);
        expect(await inChat(page), `after leaving by ${leave}: ` + await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))).toBe(true);
      }
    });

    test('typing in the chat right after the press is not taken by the Board', async ({ page }) => {
      await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planWithSteps() }));
      await page.goto('/#/workspaces/alpha/overview');
      await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
      await page.getByRole('button', { name: 'Open plan & sources' }).click();
      // A press in the chat, which the terminal answers by taking the keyboard.
      await chatOf(page).click({ position: { x: 60, y: 120 } });
      await chatOf(page).locator('textarea').first().focus();
      for (const letter of 'hello') { await page.keyboard.type(letter); await page.waitForTimeout(40); expect(await inChat(page), `after typing ${letter}`).toBe(true); }
      await page.waitForTimeout(800);
      expect(await inChat(page)).toBe(true);
    });

    test('a later visit to the Board is not pulled into the canvas by an earlier press', async ({ page }) => {
      await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planWithSteps() }));
      await page.goto('/#/workspaces/alpha/overview');
      await page.getByRole('button', { name: 'Open plan & sources' }).click();
      await expect.poll(() => focusInBoard(page)).toBe(true);
      await destinations(page).getByRole('link', { name: 'Skills' }).click();
      await expect(page).toHaveURL(/#\/workspaces\/alpha\/skills$/);
      await expect(destinations(page).getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');
      const link = destinations(page).getByRole('link', { name: 'Board', exact: true });
      await link.click();
      await expect(page).toHaveURL(/#\/workspaces\/alpha\/board$/);
      await page.waitForTimeout(600);
      expect(await focusInBoard(page)).toBe(false);
    });
  });

  test('closing the part gives the chat the whole width back', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/board');
    await expect(chatOf(page)).toBeVisible();
    const beside = await boxOf(chatOf(page));
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await expect.poll(async () => (await boxOf(chatOf(page))).width).toBeGreaterThan(beside.width + 100);
    // All of it, except the rail at the edge.
    expect((await boxOf(chatOf(page))).width).toBeGreaterThan(1440 - BODY_LEFT - RAIL - 4);
    await expect(page.getByRole('separator', { name: 'Resize the workspace panes' })).toHaveCount(0);
  });

  test('opens another part from the rail without the chat leaving', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    await destinations(page).getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/overview$/);
    await expect(chatOf(page)).toBeVisible();
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    await destinations(page).getByRole('link', { name: 'Skills' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/skills$/);
    await expect(chatOf(page)).toBeVisible();
  });

  test('keeps the same terminal while the part beside it changes', async ({ page }) => {
    let attaches = 0;
    await page.routeWebSocket('**/ws/terminal', (socket) => {
      socket.onMessage((message) => {
        const parsed = JSON.parse(String(message));
        if (parsed.type !== 'attach') return;
        attaches += 1;
        socket.send(JSON.stringify({ type: 'ready', terminal: { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: '/tmp', state: 'running' }, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      });
    });
    await page.goto('/#/workspaces/alpha/board');
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    await destinations(page).getByRole('link', { name: 'Overview', exact: true }).click();
    await destinations(page).getByRole('link', { name: 'Skills' }).click();
    await expect(destinations(page).getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');
    // Choosing the open part again closes it.
    await destinations(page).getByRole('link', { name: 'Skills' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    expect(attaches).toBe(1);
  });

  test('has no room for both under 1000 px, and Terminal brings the chat back', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/#/workspaces/alpha/board');
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await expect(chatOf(page)).toBeHidden();
    await expect(page.getByRole('separator', { name: 'Resize the workspace panes' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(chatOf(page)).toBeVisible();
  });

  test('an archived workspace has no chat beside its record', async ({ page }) => {
    await page.goto('/#/workspaces/old/plan');
    await expect(chatOf(page)).toBeHidden();
  });
});

test.describe('the chat can be hidden for a while, and given more or less room', () => {
  test('hides and shows the chat beside a part, and remembers it', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/board');
    await expect(chatOf(page)).toBeVisible();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(chatOf(page)).toBeHidden();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await expect(chatOf(page)).toBeHidden();
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(chatOf(page)).toBeVisible();
  });

  test('resizes with the arrow keys within limits, and remembers the width', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/board');
    const divider = page.getByRole('separator', { name: 'Resize the workspace panes' });
    await expect(divider).toHaveAttribute('aria-valuenow', '62');
    // A terminal takes focus once it has attached, so let it, then move to the divider.
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    const initialWidth = (await boxOf(chatOf(page))).width;
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', '65');
    await expect.poll(async () => (await boxOf(chatOf(page))).width).toBeGreaterThan(initialWidth);
    const narrower = await boxOf(chatOf(page));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '59');
    await expect.poll(async () => (await boxOf(chatOf(page))).width).toBeLessThan(narrower.width);
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '25');
    await page.reload();
    await expect(page.getByRole('separator', { name: 'Resize the workspace panes' })).toHaveAttribute('aria-valuenow', '25');
  });
});

test.describe('workspaces are switched from inside the chat', () => {
  test('sessions are named by the workspace, with the branch as a detail', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(session(page, 'alpha')).toContainText('Faster search');
    await expect(session(page, 'alpha').getByText('Faster search', { exact: true })).toHaveAttribute('title', 'Faster search');
    // A workspace without a name is known by its branch.
    await page.goto('/#/workspaces/beta/chat');
    await expect(session(page, 'beta')).toContainText('beta');
  });

  test('switching keeps the part you are reading, now for the other workspace', async ({ page }) => {
    await page.goto('/#/workspaces/beta/chat');
    await expect(session(page, 'beta')).toBeVisible();
    await page.goto('/#/workspaces/alpha/board');
    await expect(chatOf(page)).toBeVisible();
    await session(page, 'beta').click();
    await expect(page).toHaveURL(/#\/workspaces\/beta\/board$/);
    await expect(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await session(page, 'alpha').click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/board$/);
    await expect(session(page, 'alpha')).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('the rail beside the panel opens the parts, and the header is one quiet row', () => {
  test('keeps the header to the title and actions, and puts the rail at the right edge', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    const header = page.locator('header').first();
    await expect(header.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(header.getByRole('navigation')).toHaveCount(0);
    const rail = await boxOf(destinations(page));
    expect(rail.x + rail.width).toBeGreaterThan(1440 - 2);
    expect(rail.width).toBeLessThanOrEqual(RAIL + 1);
    // What can open beside the chat: Overview, Plan, Board, Sessions, Code, Docs, Skills, Services.
    await expect(destinations(page).getByRole('link')).toHaveText(['Overview', 'Board', /^Sessions/, 'Skills']);
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/workspace-chat.png` });
  });

  test('has items for sessions and skills on the rail so they are directly accessible', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(destinations(page).getByRole('link')).toHaveCount(4);
    await expect(destinations(page).getByRole('link', { name: /^Sessions/ })).toBeVisible();
    await expect(destinations(page).getByRole('link', { name: /^Skills/ })).toBeVisible();
    // The way in is also in the chat's own toolbar, named for what it opens.
    await expect(chatOf(page).getByRole('button', { name: 'Session history' })).toBeVisible();
  });

  test('opens the session history beside the chat from its toolbar, and closes it from the same button', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    const history = chatOf(page).getByRole('button', { name: 'Session history' });
    await expect(history).toHaveAttribute('aria-pressed', 'false');
    await history.click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/sessions$/);
    const panel = page.getByRole('region', { name: 'Session history', exact: true });
    await expect(panel.getByRole('heading', { name: 'AI Sessions & History' })).toBeVisible();
    // The chat stays where it is, on the right, and the button says the history is open and keeps the keyboard.
    const [chat, beside] = [await boxOf(chatOf(page)), await boxOf(panel)];
    expect(beside.x + beside.width).toBeLessThanOrEqual(chat.x + 1);
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    await expect(history).toHaveAttribute('aria-pressed', 'true');
    await expect(history).toBeFocused();
    // Sessions is on the rail, so its link is marked.
    await expect(destinations(page).getByRole('link', { name: /^Sessions/ })).toHaveAttribute('aria-current', 'page');

    await history.click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await expect(history).toHaveAttribute('aria-pressed', 'false');
    await expect(history).toBeFocused();
  });

  test('opens the session history by keyboard and returns with Terminal', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    // The terminal takes the keyboard when it connects, so the button is reached once it has.
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    const history = chatOf(page).getByRole('button', { name: 'Session history' });
    await history.focus();
    await expect(history).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Session history', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
  });

  test('still opens the old address of the session history', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/sessions');
    await expect(page.getByRole('heading', { name: 'AI Sessions & History' })).toBeVisible();
    await expect(chatOf(page)).toBeVisible();
    await expect(chatOf(page).getByRole('button', { name: 'Session history' })).toHaveAttribute('aria-pressed', 'true');
    await expect(destinations(page).getByRole('link', { name: /^Sessions/ })).toHaveAttribute('aria-current', 'page');
  });

  test('marks the part that is open, names it above the panel, and closes it when chosen again', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await destinations(page).getByRole('link', { name: 'Skills' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/skills$/);
    await expect(destinations(page).getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Skills', exact: true })).toBeVisible();
    const rail = await boxOf(destinations(page));
    const panel = await boxOf(page.getByRole('region', { name: 'Skills', exact: true }));
    expect(panel.x + panel.width).toBeLessThanOrEqual(rail.x + 1);
    await destinations(page).getByRole('link', { name: 'Skills' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await expect(destinations(page).getByRole('link', { name: 'Skills' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('opens the overview section with its rail destination marked', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/overview');
    await expect(page.getByRole('region', { name: 'Overview', exact: true })).toBeVisible();
    await expect(destinations(page).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });
});
