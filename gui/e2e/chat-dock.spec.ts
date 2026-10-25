import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planFile } from './planData';
import { openMenuFor } from './menus';

/**
 * The chat docked as the centre of the workspace. The promise is that it behaves like a place,
 * not a window: the address says which chat is showing, and leaving it for the plan or the
 * changes does not disconnect it.
 */
const workspace = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name, branchName: name, description: `${name} workspace`, repos: [], assistants: [], workspacePath: `/tmp/${name}`, createdAt: '2026-09-24T00:00:00Z', ...extra,
});
const names = ['alpha', 'beta', 'gamma'];

test.use({ workspacesData: [[...names.map((name) => workspace(name)), workspace('old', { archivedAt: '2026-09-01T00:00:00Z' })], { option: true }], viewport: { width: 1365, height: 900 } });

/** How many times each workspace's terminal has attached, so a remount shows up as a second attach. */
let attaches: Record<string, number> = {};

test.beforeEach(async ({ page }) => {
  attaches = {};
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    const terminal = { id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' };
    return route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } });
  });
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planFile() }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type !== 'attach') return;
      attaches[parsed.workspace] = (attaches[parsed.workspace] ?? 0) + 1;
      const terminal = { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: `/tmp/${parsed.workspace}`, state: 'running' };
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
});

const chatOf = (page: Page) => page.getByRole('region', { name: 'CLI Chat', exact: true });
const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
const sidebar = (page: Page) => page.locator('aside.context-sidebar');
/** An open chat is a session in the sidebar, in the order it was opened, with the one on screen marked as the current page. */
const session = (page: Page, name: string) => sidebar(page).locator(`[data-sidebar-session="${name}"]`);
const sessions = (page: Page) => sidebar(page).locator('[data-sidebar-session]');
/** Opens a chat the way a link to it does: by its address. */
const openChat = async (page: Page, name: string) => {
  await page.goto(`/#/workspaces/${name}/chat`);
  await expect(session(page, name)).toBeVisible();
};
/** Opens a chat from the sidebar's Resume button, which asks the dock to show it, so the dock moves the address itself. */
const addChat = async (page: Page, name: string) => {
  await sidebar(page).getByRole('button', { name: `Resume CLI chat for ${name}` }).click();
  // The address moves at once, but the page takes a moment to catch up with it. A link clicked in between is judged
  // against the old location and replaces the history entry instead of adding one, so wait until the page shows it.
  await expect(session(page, name)).toHaveAttribute('aria-current', 'page', { timeout: 20_000 });
};
/** The state of the terminal on screen. While it runs the word is for screen readers only, so the pane is what is visible. */
const shownState = (page: Page) => chatOf(page).getByTestId('terminal-pane').filter({ visible: true }).getByTestId('terminal-state');
/** A terminal takes focus once it has attached, and a key pressed then belongs to the terminal, so wait for the one in front to settle first. */
const settled = (page: Page) => expect(shownState(page)).toHaveText('Running', { timeout: 20_000 });
/** Closes a session the accessible way: the Delete key on its focused link. */
const closeSession = async (page: Page, name: string) => {
  await settled(page);
  await session(page, name).focus();
  await page.keyboard.press('Delete');
};
/** Closes a session with its cross. */
const clickCross = async (page: Page, name: string) => {
  await settled(page);
  await sidebar(page).getByRole('button', { name: `Close session ${name}` }).click();
};
const current = (page: Page, name: string) => expect(session(page, name)).toHaveAttribute('aria-current', 'page');

test.describe('the chat is the centre of a workspace', () => {
  test('a workspace opens on its plan, with its sessions one click away', async ({ page }) => {
    await page.goto('/#/workspaces/alpha');
    await expect(page.getByRole('region', { name: 'The plan', exact: true })).toBeVisible();
    // Nothing runs, so the plan is shown instead of a chat; sessions start in the chat, not in a card beside the plan.
    await expect(chatOf(page)).toBeHidden();
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(0);
    await expect(page.getByLabel('Plan and sessions')).toBeVisible();
    await expect(workspaceNav(page).getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'page');
    // The address is left as it was given: no section is the plan.
    await expect(page).toHaveURL(/#\/workspaces\/alpha$/);
  });

  test('a link to a workspace chat opens that chat, even when another was open before', async ({ page }) => {
    await openChat(page, 'alpha');
    await current(page, 'alpha');
    await openChat(page, 'gamma');
    await current(page, 'gamma');
    // Both chats are open as sessions, and the one in the address is the current one.
    await expect(sessions(page)).toHaveCount(2);
  });

  test('the chat is hidden, not closed, on every other destination', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page)).toBeVisible();
    for (const section of ['overview', 'plan', 'changes', 'sessions']) {
      await page.goto(`/#/workspaces/alpha/${section}`);
      await expect(chatOf(page)).toBeHidden();
    }
    await page.getByRole('button', { name: 'Close this panel and give the chat the whole screen' }).click();
    await expect(chatOf(page)).toBeVisible();
  });

  test('keeps the same terminal connected while you read the plan and come back', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    expect(attaches.alpha).toBe(1);

    await workspaceNav(page).getByRole('link', { name: 'Plan' }).click();
    await expect(chatOf(page)).toBeHidden();
    await workspaceNav(page).getByRole('link', { name: /^Code/ }).click();
    await expect(page).toHaveURL(/\/changes$/);
    await page.getByRole('button', { name: 'Close this panel and give the chat the whole screen' }).click();

    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    // Still one connection: the terminal was never torn down and reattached.
    expect(attaches.alpha).toBe(1);
  });

  test('keeps other workspaces connected while one is in front, and while you leave the workspace page', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    // Both chats are mounted, one in front, so look only at the terminal that is showing.
    const showing = shownState(page);
    await expect(showing).toHaveText('Running');
    await session(page, 'alpha').waitFor();
    await addChat(page, 'beta');
    await current(page, 'beta');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await expect(showing).toHaveText('Running');

    await page.goto('/#/overview');
    await expect(chatOf(page)).toBeHidden();
    await page.goto('/#/workspaces/alpha/chat');
    await expect(showing).toHaveText('Running');
    expect(attaches).toEqual({ alpha: 1, beta: 1 });
  });

  test('unmounts inactive workspace DOM nodes beyond recent limit when visiting a third workspace', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(shownState(page)).toHaveText('Running');
    await addChat(page, 'beta');
    await expect(shownState(page)).toHaveText('Running');
    await addChat(page, 'gamma');
    await expect(shownState(page)).toHaveText('Running');

    // alpha, beta, gamma all in openTabs, but alpha (oldest) has been unmounted from DOM
    await expect(sessions(page)).toHaveCount(3);
    const mountedPanes = chatOf(page).getByTestId('terminal-pane');
    await expect(mountedPanes).toHaveCount(2);

    // Switching back to alpha remounts it
    await session(page, 'alpha').click();
    await expect(shownState(page)).toHaveText('Running');
    await expect(mountedPanes).toHaveCount(2);
  });
});

test.describe('the address says which chat is showing', () => {
  test('choosing a session goes to that chat, and back returns to the one before', async ({ page }) => {
    await openChat(page, 'alpha');
    await addChat(page, 'beta');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);

    await session(page, 'alpha').click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await current(page, 'alpha');

    await page.goBack();
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await current(page, 'beta');
  });

  test('closing the session in front brings up the one before it and its address', async ({ page }) => {
    await openChat(page, 'alpha');
    await addChat(page, 'beta');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);

    await closeSession(page, 'beta');
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await current(page, 'alpha');
    await expect(session(page, 'beta')).toHaveCount(0);
  });

  test('the cross closes a session with the mouse, and the Delete key does the same from the keyboard', async ({ page }) => {
    await openChat(page, 'alpha');
    await addChat(page, 'beta');
    await addChat(page, 'gamma');
    await expect(page).toHaveURL(/#\/workspaces\/gamma\/chat$/);

    await clickCross(page, 'gamma');
    // The session before it comes to the front.
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await expect(sessions(page)).toHaveCount(2);

    await closeSession(page, 'alpha');
    await expect(session(page, 'alpha')).toHaveCount(0);
    await expect(sessions(page)).toHaveCount(1);
  });

  test('closing a session from the keyboard does not drop focus to the page', async ({ page }) => {
    await openChat(page, 'alpha');
    await addChat(page, 'beta');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await closeSession(page, 'beta');
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    // Focus moves to the session that took its place in the list, or on into its terminal, never back to <body>.
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[aria-label="CLI Chat"], aside.context-sidebar')))).toBe(true);
  });

  test('lists the open chats as a group of links that say Delete closes them', async ({ page }) => {
    await openChat(page, 'alpha');
    await addChat(page, 'beta');
    const list = sidebar(page).getByRole('group', { name: 'Open sessions list' });
    await expect(list.locator('a[data-sidebar-session]')).toHaveCount(2);
    await expect(session(page, 'alpha')).toHaveAttribute('aria-keyshortcuts', 'Delete');
    // The cross is a button of its own, for the mouse and for touch.
    await expect(list.getByRole('button', { name: /^Close session/ })).toHaveCount(2);
  });

  test('closing a session that is not in front leaves the screen as it is', async ({ page }) => {
    await openChat(page, 'alpha');
    await addChat(page, 'beta');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);

    await closeSession(page, 'alpha');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await expect(sessions(page)).toHaveCount(1);
  });

  test('a reload stays on the same chat and does not navigate by itself', async ({ page }) => {
    await openChat(page, 'alpha');
    await addChat(page, 'beta');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await page.reload();
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await current(page, 'beta');
    await expect(sessions(page)).toHaveCount(2);
  });

  test('asking to see a chat from elsewhere in the app goes to it', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/plan');
    await page.goto('/#/workspaces/beta/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await current(page, 'beta');
  });

  test('an archived workspace has no chat: its address shows its record', async ({ page }) => {
    await page.goto('/#/workspaces/old/chat');
    await expect(chatOf(page)).toBeHidden();
    await expect(workspaceNav(page).getByRole('link', { name: /^Chat/ })).toHaveCount(0);
    // With no section, an archived workspace opens on its record, not on the plan where an active one opens.
    await page.goto('/#/workspaces/old');
    await expect(chatOf(page)).toBeHidden();
    await expect(workspaceNav(page).getByRole('link', { name: 'Record' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(0);
  });

  test('an old link to a section that no longer exists lands on the overview, not the chat', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/diff');
    await expect(chatOf(page)).toBeHidden();
    await expect(page.getByRole('region', { name: 'Overview', exact: true })).toBeVisible();
    await expect(workspaceNav(page).locator('[aria-current="page"]')).toHaveCount(0);
  });
});

test.describe('on a slow machine', () => {
  // The address bar changes at once, but the app applies its own copy of the location a moment later when the
  // page is busy. The user can act in between, so what they did last must win.
  // Everything is slow here, including the page rendering what the test waits for, so waits are generous.
  test.setTimeout(120_000);
  // Waiting for the page to catch up is the point of these tests, so their assertions wait longer.
  const slow = expect.configure({ timeout: 20_000 });
  test.beforeEach(async ({ page }) => {
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  });

  test('closing a tab straight after opening it does not bring it back', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await slow(session(page, 'alpha')).toHaveAttribute('aria-current', 'page');
    await addChat(page, 'beta');
    await slow(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await closeSession(page, 'beta');

    // Settle: wherever the app ends up, it is the chat that is still open, and it agrees with the address.
    await slow(page).toHaveURL(/#\/workspaces\/alpha\/chat$/, { timeout: 15_000 });
    await slow(session(page, 'alpha')).toHaveAttribute('aria-current', 'page');
    await slow(sessions(page)).toHaveCount(1);
    await page.waitForTimeout(1500);
    await slow(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await slow(sessions(page)).toHaveCount(1);
  });

  test('opening two chats quickly and closing the one in front lands on the one before it, and stays there', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await slow(session(page, 'alpha')).toHaveAttribute('aria-current', 'page');
    await addChat(page, 'beta');
    await addChat(page, 'gamma');
    await slow(page).toHaveURL(/#\/workspaces\/gamma\/chat$/);
    await clickCross(page, 'gamma');

    await slow(page).toHaveURL(/#\/workspaces\/beta\/chat$/, { timeout: 15_000 });
    // A late landing from the quick opens must neither bring gamma back nor move the screen away.
    await page.waitForTimeout(2000);
    await slow(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    await slow(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
    await slow(sessions(page)).toHaveCount(2);
    await slow(session(page, 'gamma')).toHaveCount(0);
    await slow(session(page, 'alpha')).not.toHaveAttribute('aria-current', 'page');
  });

  test('choosing a session and then closing the other does not bring it back', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await slow(session(page, 'alpha')).toBeVisible();
    await addChat(page, 'beta');
    await slow(page).toHaveURL(/#\/workspaces\/beta\/chat$/, { timeout: 15_000 });
    await slow(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
    await session(page, 'alpha').click();
    await closeSession(page, 'beta');

    await slow(page).toHaveURL(/#\/workspaces\/alpha\/chat$/, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await slow(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await slow(sessions(page)).toHaveCount(1);
    await slow(session(page, 'alpha')).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('the dock sits exactly over its slot', () => {
  const box = async (locator: ReturnType<typeof chatOf>) => {
    const b = await locator.boundingBox();
    if (!b) throw new Error('no box');
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  };

  test('fills the space under the header and beside the rail, and follows the window and the sidebar', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page)).toBeVisible();
    const slot = page.getByTestId('chat-dock-slot');

    const header = await page.locator('header').first().boundingBox();
    const rail = await workspaceNav(page).boundingBox();
    const first = await box(chatOf(page));
    // Right under the header and left of the rail, over neither.
    expect(first.y).toBeGreaterThanOrEqual(Math.round(header!.y + header!.height) - 1);
    expect(first.x + first.width).toBeLessThanOrEqual(Math.round(rail!.x) + 1);
    expect(first).toEqual(await box(slot));

    await page.setViewportSize({ width: 1100, height: 760 });
    await expect.poll(async () => JSON.stringify(await box(chatOf(page)))).toBe(JSON.stringify(await box(slot)));
    const narrower = await box(chatOf(page));
    expect(narrower.width).toBeLessThan(first.width);
    expect(narrower.height).toBeLessThan(first.height);

    // The sidebar collapsing gives the chat its room. (The `z` shortcut would type into the terminal, which has focus.)
    await page.getByRole('button', { name: /^Collapse/ }).click();
    await expect.poll(async () => (await box(chatOf(page))).width).toBeGreaterThan(narrower.width);
    // The sidebar slides; the chat follows it to the end.
    await expect.poll(async () => JSON.stringify(await box(chatOf(page))) === JSON.stringify(await box(slot))).toBe(true);
  });

  test('reaches the bottom of the window with no page scroll of its own', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page)).toBeVisible();
    const b = await box(chatOf(page));
    expect(b.y + b.height).toBeGreaterThanOrEqual(900 - 2);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  });

  test('keeps its header short: the facts live in the strip, not above it', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Task status' })).toHaveCount(0);
    await page.goto('/#/workspaces/alpha/plan');
    await expect(page.getByRole('group', { name: 'Task status' })).toBeVisible();
  });
});

test.describe('a menu opened over the chat stays above it', () => {
  test('the menu for docking a second workspace is not hidden behind the dock', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page)).toBeVisible();
    const item = page.getByRole('menuitem', { name: /beta/ });
    await openMenuFor(page.getByRole('button', { name: 'Dock a second workspace' }), item);
    // Visible and clickable: nothing sits on top of it.
    await item.click({ trial: true });
  });
});
