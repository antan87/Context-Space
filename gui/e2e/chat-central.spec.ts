import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * The chat is the centre of the app. It takes most of the screen, the other parts of a workspace
 * (plan, changes, documents) open as a narrower panel beside it when asked for, workspaces are
 * switched from inside the chat, and the app opens on the chat you were last in.
 */
const workspace = (id: string, extra: Record<string, unknown> = {}) => ({
  id, branchName: id, description: `${id} workspace`, repos: [], assistants: [], workspacePath: `/tmp/${id}`, createdAt: '2026-09-24T00:00:00Z', ...extra,
});

test.use({
  workspacesData: [[workspace('alpha', { name: 'Faster search' }), workspace('beta'), workspace('old', { archivedAt: '2026-09-01T00:00:00Z' })], { option: true }],
  viewport: { width: 1440, height: 900 },
});

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
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: { content: '# Plan' } }));
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
  test('takes most of the width, with the part in a narrower panel beside it', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/plan');
    await expect(chatOf(page)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Goal', exact: true })).toBeVisible();
    const chat = await boxOf(chatOf(page));
    const panel = await boxOf(page.getByRole('region', { name: 'Goal', exact: true }));
    const body = 1440 - BODY_LEFT;
    expect(chat.width / body).toBeGreaterThan(0.55);
    expect(chat.width).toBeGreaterThan(panel.width);
    // The chat is on the left of the part it is beside.
    expect(chat.x + chat.width).toBeLessThanOrEqual(panel.x + 1);
    await expect(page.getByRole('separator', { name: 'Resize the chat' })).toBeVisible();
  });

  test('closing the part gives the chat the whole width back', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/plan');
    await expect(chatOf(page)).toBeVisible();
    const beside = await boxOf(chatOf(page));
    await page.getByRole('button', { name: 'Close this panel and give the chat the whole screen' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await expect.poll(async () => (await boxOf(chatOf(page))).width).toBeGreaterThan(beside.width + 100);
    // All of it, except the rail at the edge.
    expect((await boxOf(chatOf(page))).width).toBeGreaterThan(1440 - BODY_LEFT - RAIL - 4);
    await expect(page.getByRole('separator', { name: 'Resize the chat' })).toHaveCount(0);
  });

  test('opens another part from the rail without the chat leaving', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    await destinations(page).getByRole('link', { name: /^Code/ }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/changes$/);
    await expect(chatOf(page)).toBeVisible();
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    await destinations(page).getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/documents$/);
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
    await page.goto('/#/workspaces/alpha/plan');
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    await destinations(page).getByRole('link', { name: /^Code/ }).click();
    await destinations(page).getByRole('link', { name: 'Services' }).click();
    await expect(destinations(page).getByRole('link', { name: 'Services' })).toHaveAttribute('aria-current', 'page');
    // Choosing the open part again closes it.
    await destinations(page).getByRole('link', { name: 'Services' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    expect(attaches).toBe(1);
  });

  test('has no room for both on a narrow window, so the part gets the screen and the cross brings the chat back', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/#/workspaces/alpha/plan');
    await expect(page.getByRole('region', { name: 'Goal', exact: true })).toBeVisible();
    await expect(chatOf(page)).toBeHidden();
    await expect(page.getByRole('separator', { name: 'Resize the chat' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close this panel and give the chat the whole screen' }).click();
    await expect(chatOf(page)).toBeVisible();
  });

  test('an archived workspace has no chat beside its record', async ({ page }) => {
    await page.goto('/#/workspaces/old/plan');
    await expect(chatOf(page)).toBeHidden();
  });
});

test.describe('the chat can be hidden for a while, and given more or less room', () => {
  test('hides and shows the chat beside a part, and remembers it', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/plan');
    await expect(chatOf(page)).toBeVisible();
    await page.getByRole('button', { name: 'Hide the chat and give this the whole width' }).click();
    await expect(chatOf(page)).toBeHidden();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Goal', exact: true })).toBeVisible();
    await expect(chatOf(page)).toBeHidden();
    await page.getByRole('button', { name: 'Show the chat beside this' }).click();
    await expect(chatOf(page)).toBeVisible();
  });

  test('resizes with the arrow keys within limits, and remembers the width', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/plan');
    const divider = page.getByRole('separator', { name: 'Resize the chat' });
    await expect(divider).toHaveAttribute('aria-valuenow', '62');
    // A terminal takes focus once it has attached, so let it, then move to the divider.
    await expect(chatOf(page).getByTestId('terminal-state')).toHaveText('Running');
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', '59');
    const narrower = await boxOf(chatOf(page));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '65');
    expect((await boxOf(chatOf(page))).width).toBeGreaterThan(narrower.width);
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '80');
    await page.reload();
    await expect(page.getByRole('separator', { name: 'Resize the chat' })).toHaveAttribute('aria-valuenow', '80');
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
    await page.goto('/#/workspaces/alpha/plan');
    await expect(chatOf(page)).toBeVisible();
    await session(page, 'beta').click();
    await expect(page).toHaveURL(/#\/workspaces\/beta\/plan$/);
    await expect(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Goal', exact: true })).toBeVisible();
    await session(page, 'alpha').click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/plan$/);
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
    // What can open beside the chat; the chat itself, the overview and the session history have no place on it.
    // Knowledge is read in Docs, with the other files ContextSpace keeps.
    await expect(destinations(page).getByRole('link')).toHaveText(['Plan', 'Code', 'Docs', 'Skills', 'Services']);
  });

  test('marks the part that is open, names it above the panel, and closes it when chosen again', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/chat');
    await destinations(page).getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/documents$/);
    await expect(destinations(page).getByRole('link', { name: 'Docs' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Documents', exact: true })).toBeVisible();
    const rail = await boxOf(destinations(page));
    const panel = await boxOf(page.getByRole('region', { name: 'Documents', exact: true }));
    expect(panel.x + panel.width).toBeLessThanOrEqual(rail.x + 1);
    await destinations(page).getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/alpha\/chat$/);
    await expect(destinations(page).getByRole('link', { name: 'Docs' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('still opens an old address that has no place on the rail', async ({ page }) => {
    await page.goto('/#/workspaces/alpha/sessions');
    await expect(page.getByRole('region', { name: 'Sessions', exact: true })).toBeVisible();
    await expect(destinations(page).locator('[aria-current="page"]')).toHaveCount(0);
  });
});
