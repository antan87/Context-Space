import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * The width of the expanded sidebar is the person's to set: dragged from its edge or moved with the keys, saved, and
 * given back on the next visit. The rails and the phone-width sheet keep their own widths.
 */
const workspace = (name: string) => ({
  id: name, branchName: name, description: `${name} workspace`, repos: [], assistants: [], workspacePath: `/tmp/${name}`, createdAt: '2026-09-24T00:00:00Z',
});

test.use({ workspacesData: [['alpha', 'beta'].map(workspace), { option: true }], viewport: { width: 1365, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: { content: '# Plan' } }));
});

const DEFAULT = 256;
const MIN = 224;
const MAX = 480;

const sidebar = (page: Page) => page.locator('aside.context-sidebar');
const handle = (page: Page) => page.getByRole('separator', { name: 'Resize sidebar' });
const widthOf = async (locator: Locator) => Math.round((await locator.boundingBox())!.width);

/** Drags the sidebar's edge by dx pixels the way a mouse does. */
async function drag(page: Page, dx: number) {
  const edge = (await handle(page).boundingBox())!;
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test.describe('the sidebar width', () => {
  test('starts at the usual width, with an edge that can be grabbed', async ({ page }) => {
    await page.goto('/#/overview');
    await expect(handle(page)).toBeVisible();
    expect(await widthOf(sidebar(page))).toBe(DEFAULT);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', String(DEFAULT));
    await expect(handle(page)).toHaveAttribute('aria-valuemin', String(MIN));
  });

  test('follows a drag of its edge, and the page beside it gives way', async ({ page }) => {
    await page.goto('/#/overview');
    const mainBefore = (await page.locator('main').boundingBox())!;
    await drag(page, 100);
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 100);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', String(DEFAULT + 100));
    const mainAfter = (await page.locator('main').boundingBox())!;
    expect(Math.round(mainAfter.x - mainBefore.x)).toBe(100);
    expect(Math.round(mainBefore.width - mainAfter.width)).toBe(100);
  });

  test('is kept after a reload, and shown from the first paint', async ({ page }) => {
    await page.goto('/#/overview');
    await drag(page, 120);
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 120);
    await page.reload();
    await expect(handle(page)).toBeVisible();
    expect(await widthOf(sidebar(page))).toBe(DEFAULT + 120);
  });

  test('stops at the smallest and the largest width', async ({ page }) => {
    await page.goto('/#/overview');
    await drag(page, 2000);
    await expect.poll(() => widthOf(sidebar(page))).toBe(MAX);
    await drag(page, -2000);
    await expect.poll(() => widthOf(sidebar(page))).toBe(MIN);
  });

  test('is moved by the keys once the edge has focus, and reset with Enter or a double click', async ({ page }) => {
    await page.goto('/#/overview');
    await handle(page).focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 16);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 16 + 48);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 48);
    await page.keyboard.press('End');
    await expect.poll(() => widthOf(sidebar(page))).toBe(MAX);
    await page.keyboard.press('Home');
    await expect.poll(() => widthOf(sidebar(page))).toBe(MIN);
    await page.keyboard.press('Enter');
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT);

    await drag(page, 90);
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 90);
    await handle(page).dblclick();
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT);
    // Back at the default it is no longer a saved choice.
    expect(await page.evaluate(() => localStorage.getItem('ctxspace_sidebar_width'))).toBeNull();
  });

  test('does not take a key the page uses elsewhere: the others still reach the page', async ({ page }) => {
    await page.goto('/#/overview');
    await handle(page).focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('a');
    expect(await widthOf(sidebar(page))).toBe(DEFAULT);
  });

  test('ignores a saved width that is not one', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctxspace_sidebar_width', 'very wide'));
    await page.goto('/#/overview');
    expect(await widthOf(sidebar(page))).toBe(DEFAULT);
  });

  test('pulls a saved width that is out of range back into range', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctxspace_sidebar_width', '99999'));
    await page.goto('/#/overview');
    expect(await widthOf(sidebar(page))).toBe(MAX);
  });

  test('never takes more than 45% of a smaller window, though a wider one was saved', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctxspace_sidebar_width', '480'));
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto('/#/overview');
    expect(await widthOf(sidebar(page))).toBe(450);
    await page.setViewportSize({ width: 1600, height: 800 });
    await expect.poll(() => widthOf(sidebar(page))).toBe(MAX);
  });

  test('leaves the collapsed rail as narrow as ever, and is there again when it expands', async ({ page }) => {
    await page.goto('/#/overview');
    await drag(page, 100);
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 100);
    await page.getByRole('button', { name: /^Collapse/ }).click();
    await expect(handle(page)).toHaveCount(0);
    await expect.poll(() => widthOf(sidebar(page))).toBe(56);
    await page.getByRole('button', { name: /^Expand/ }).click();
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 100);
  });

  test('is not offered in a narrow window, whose rail expands to the usual width', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctxspace_sidebar_width', '400'));
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/#/overview');
    await expect(handle(page)).toHaveCount(0);
    await page.getByRole('button', { name: /Expand/ }).click();
    // It eases open, so wait for it to arrive.
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT);
    await expect(handle(page)).toHaveCount(0);
  });

  test('is not offered on a phone, where the sidebar is the whole width', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ctxspace_sidebar_width', '400'));
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto('/#/overview');
    await expect(handle(page)).toBeHidden();
  });
});

test.describe('the chat beside a resized sidebar', () => {
  test('keeps filling the space the sidebar leaves', async ({ page }) => {
    await page.routeWebSocket('**/ws/terminal', (socket) => {
      socket.onMessage((message) => {
        const parsed = JSON.parse(String(message));
        if (parsed.type !== 'attach') return;
        const terminal = { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: `/tmp/${parsed.workspace}`, state: 'running' };
        socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      });
    });
    await page.goto('/#/workspaces/alpha/chat');
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    const slot = page.getByTestId('chat-dock-slot');
    await expect(chat).toBeVisible();
    const box = async (locator: Locator) => { const b = (await locator.boundingBox())!; return { x: Math.round(b.x), width: Math.round(b.width) }; };
    const before = await box(chat);

    await drag(page, 110);
    await expect.poll(() => widthOf(sidebar(page))).toBe(DEFAULT + 110);
    await expect.poll(async () => JSON.stringify(await box(chat))).toBe(JSON.stringify(await box(slot)));
    const after = await box(chat);
    expect(after.x - before.x).toBe(110);
    expect(before.width - after.width).toBe(110);
  });
});
