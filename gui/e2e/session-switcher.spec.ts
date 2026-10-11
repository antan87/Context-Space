import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Switching between workspaces from the sidebar. The promise: the open sessions keep the order they were opened in
 * whichever one is chosen, the one on screen is always marked, and the keyboard moves between them without taking keys
 * the CLI needs.
 */
const workspace = (name: string) => ({
  id: name, branchName: name, description: `${name} workspace`, repos: [], assistants: [], workspacePath: `/tmp/${name}`, createdAt: '2026-09-24T00:00:00Z',
});
const names = ['alpha', 'beta', 'gamma'];

test.use({ workspacesData: [names.map(workspace), { option: true }], viewport: { width: 1365, height: 900 } });

/** What the browser's terminals sent to their shells, so a test can tell a key the CLI got from one the app took. */
let sentToShell: string[] = [];

test.beforeEach(async ({ page }) => {
  sentToShell = [];
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    const terminal = { id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' };
    return route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } });
  });
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: { content: '# Plan' } }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type === 'input') sentToShell.push(String(parsed.data));
      if (parsed.type !== 'attach') return;
      const terminal = { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: `/tmp/${parsed.workspace}`, state: 'running' };
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
});

const sidebar = (page: Page) => page.locator('aside.context-sidebar');
const sessionLinks = (page: Page) => sidebar(page).locator('[data-sidebar-session]');
const session = (page: Page, name: string): Locator => sidebar(page).locator(`[data-sidebar-session="${name}"]`);
const order = (page: Page) => sessionLinks(page).evaluateAll((links) => links.map((link) => link.getAttribute('data-sidebar-session')));
const chatOf = (page: Page) => page.getByRole('region', { name: 'CLI Chat', exact: true });
/** A terminal takes focus once it has attached, and a key pressed then belongs to it, so wait for the one in front to settle. */
const settled = (page: Page) => expect(chatOf(page).getByTestId('terminal-pane').filter({ visible: true }).getByTestId('terminal-state')).toHaveText('Running', { timeout: 20_000 });

/** Opens the three chats in order, ending on the last, the way a user opens them one after another. */
async function openAll(page: Page) {
  for (const name of names) {
    await page.goto(`/#/workspaces/${name}/chat`);
    await expect(session(page, name)).toBeVisible();
  }
  await expect.poll(() => order(page)).toEqual(names);
}

test.describe('the open sessions in the sidebar', () => {
  test('keep the order they were opened in, whichever one is chosen', async ({ page }) => {
    await openAll(page);
    for (const name of ['gamma', 'alpha', 'beta', 'alpha', 'gamma']) {
      await session(page, name).click();
      await expect(page).toHaveURL(new RegExp(`#/workspaces/${name}/chat$`));
      await expect.poll(() => order(page)).toEqual(names);
    }
  });

  test('always mark the one on screen, and only that one', async ({ page }) => {
    await openAll(page);
    for (const name of ['beta', 'alpha', 'gamma']) {
      await session(page, name).click();
      await expect(sessionLinks(page).and(page.locator('[aria-current="page"]'))).toHaveCount(1);
      await expect(session(page, name)).toHaveAttribute('aria-current', 'page');
    }
  });

  test('are one step in the history each, so Back returns to the session before', async ({ page }) => {
    await openAll(page);
    const length = () => page.evaluate(() => history.length);
    const before = await length();
    await session(page, 'alpha').click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    expect(await length()).toBe(before + 1);
    await page.goBack();
    await expect(page).toHaveURL(/#\/workspaces\/gamma\/chat$/);
  });

  test('keep the part of the workspace being read when another one is chosen', async ({ page }) => {
    await openAll(page);
    await page.goto('/#/workspaces/alpha/plan');
    await session(page, 'beta').click();
    await expect(page).toHaveURL(/#\/workspaces\/beta\/plan$/);
  });

  test('are the same after a reload', async ({ page }) => {
    await openAll(page);
    await session(page, 'beta').click();
    await page.reload();
    await expect.poll(() => order(page)).toEqual(names);
    await expect(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
  });

  test('are labelled with the keys that go to them', async ({ page }) => {
    await openAll(page);
    for (const [index, name] of names.entries()) {
      await expect(session(page, name)).toContainText(new RegExp(`(Alt\\+|⌥)${index + 1}`));
    }
  });

  test('close with Delete, and focus goes to the session above', async ({ page }) => {
    await openAll(page);
    await settled(page);
    await session(page, 'beta').focus();
    await page.keyboard.press('Delete');
    await expect.poll(() => order(page)).toEqual(['alpha', 'gamma']);
    await expect(session(page, 'alpha')).toBeFocused();
  });

  test('close with their cross, which a keyboard user can reach', async ({ page }) => {
    await openAll(page);
    await settled(page);
    const row = sidebar(page).getByRole('group', { name: 'Open sessions list' }).locator('> div').nth(0);
    const cross = row.getByRole('button', { name: /^Close session/ });
    await cross.focus();
    await expect(cross).toBeVisible();
    await expect(cross).toHaveCSS('opacity', '1');
    await cross.press('Enter');
    await expect.poll(() => order(page)).toEqual(['beta', 'gamma']);
  });

  test('stay listed as initials in the collapsed sidebar, and can be closed there', async ({ page }) => {
    await openAll(page);
    await settled(page);
    // The button, not the z shortcut: a terminal that has focus would take the letter.
    await page.getByRole('button', { name: /^Collapse/ }).click();
    const rail = page.getByRole('group', { name: 'Open sessions', exact: true });
    await expect(rail.locator('[data-sidebar-session]')).toHaveCount(3);
    await expect(session(page, 'alpha')).toHaveText('AL');
    await rail.getByRole('button', { name: 'Close session beta' }).click({ force: true });
    await expect.poll(() => order(page)).toEqual(['alpha', 'gamma']);
  });
});

test.describe('the keyboard', () => {
  test('jumps to a session with Alt and its number, and cycles with Alt and the up and down arrows', async ({ page }) => {
    await openAll(page);
    await page.goto('/#/workspaces/gamma/plan');
    await settled(page).catch(() => undefined);
    await page.keyboard.press('Alt+2');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/plan$/);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page).toHaveURL(/#\/workspaces\/gamma\/plan$/);
    // Down from the last wraps to the first; up from the first wraps to the last.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/plan$/);
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page).toHaveURL(/#\/workspaces\/gamma\/plan$/);
    await expect(session(page, 'gamma')).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => order(page)).toEqual(names);
  });

  /** Puts focus in the terminal on screen, the way typing into a CLI does. */
  const focusTerminal = async (page: Page) => {
    await settled(page);
    await chatOf(page).getByTestId('terminal-pane').filter({ visible: true }).locator('.xterm-helper-textarea').focus();
  };

  test('leaves the keys the CLI uses to the CLI, and the keys that would do nothing', async ({ page }) => {
    await openAll(page);
    await focusTerminal(page);
    // Alt and the left and right arrows move by word in a shell, Alt and [ starts an escape sequence, Alt and a letter
    // is a shell binding, and there is no fourth session for Alt and 4: the app takes none of them.
    // On a Mac the terminal does not treat Option as Meta, so Option and a bracket, a digit or a letter types a special
    // character that never reaches the shell as a key. Only the arrows are checked there; the app takes none of them
    // either way, which the address below shows.
    const keys = ['Alt+ArrowLeft', 'Alt+ArrowRight', ...(process.platform === 'darwin' ? [] : ['Alt+BracketLeft', 'Alt+BracketRight', 'Alt+4', 'Alt+KeyB'])];
    for (const key of keys) {
      const before = sentToShell.length;
      await page.keyboard.press(key);
      await expect.poll(() => sentToShell.length, { message: `${key} should reach the shell` }).toBeGreaterThan(before);
    }
    // Pressed on every platform: wherever they go, the app does not take them.
    for (const key of ['Alt+BracketLeft', 'Alt+BracketRight', 'Alt+4', 'Alt+KeyB']) await page.keyboard.press(key);
    await expect(page).toHaveURL(/#\/workspaces\/gamma\/chat$/);
  });

  test('takes Alt and the arrows for the app, not the shell, while there is another session to go to', async ({ page }) => {
    await openAll(page);
    await focusTerminal(page);
    const before = sentToShell.length;
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page).toHaveURL(/#\/workspaces\/beta\/chat$/);
    expect(sentToShell.length).toBe(before);
  });

  test('gives Alt and the arrows to the shell when there is no other session to go to', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(session(page, 'alpha')).toBeVisible();
    await focusTerminal(page);
    const before = sentToShell.length;
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => sentToShell.length).toBeGreaterThan(before);
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
  });
});

test.describe('a session with a long name', () => {
  const longName = 'Better create workspace experience';
  test.use({ workspacesData: [[{ ...workspace('long'), name: longName }], { option: true }] });

  test('is read in full, wrapping onto a second line instead of being cut off', async ({ page }) => {
    await page.goto('/#/workspaces/long/chat');
    await expect(session(page, 'long')).toBeVisible();
    const title = session(page, 'long').getByText(longName, { exact: true });
    await expect(title).toBeVisible();
    const clipped = () => title.evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    expect(await clipped()).toBe(false);
    // The row's buttons float over its corner, so reaching for one never takes the name's room.
    await session(page, 'long').hover();
    expect(await clipped()).toBe(false);
  });
});
