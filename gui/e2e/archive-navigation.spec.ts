import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planFile } from './planData';
import { openMenuFor } from './menus';

const base = { mode: 'in-place', repos: ['/dev/api'], assistants: [], createdAt: '2026-06-01T00:00:00.000Z' };
const OLD = {
  ...base, id: 'old', branchName: 'old', name: 'Old invoice work', description: 'Finished last quarter', workspacePath: '/ws/old',
  archivedAt: '2026-09-28T10:00:00.000Z',
  archive: { archivedAt: '2026-09-28T10:00:00.000Z', previousMode: 'in-place', parked: false, repos: [] },
};
const LIVE = { ...base, id: 'live', branchName: 'live', name: 'Live billing work', description: 'In progress now', workspacePath: '/ws/live' };

async function mockTwoWorkspaces(page: Page) {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [OLD, LIVE] }));
  await page.route(/\/api\/workspace\/(old|live)\/plan$/, (route) => route.fulfill({ json: planFile() }));
  await page.route(/\/api\/workspace\/(old|live)\/documents$/, (route) => route.fulfill({ json: { documents: [] } }));
  await page.route(/\/api\/workspace\/(old|live)\/work$/, (route) => route.fulfill({ json: {
    guidance: { version: 1, revision: 0, workType: 'general', size: 'standard', documents: [],
      assignment: { stage: 'implement', objective: 'Ship it', expectedOutput: '', stopCondition: '' } },
    lifecycle: null, assignment: '', sharedDocuments: [],
  } }));
}

/** A shell that attaches and answers, so a workspace's chat can be open as a session while the test reads another page. */
async function mockShells(page: Page) {
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    const terminal = { id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' };
    return route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } });
  });
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type !== 'attach') return;
      const terminal = { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: `/tmp/${parsed.workspace}`, state: 'running' };
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
}

/** Deleting asks for the workspace's name to be typed first. */
async function confirmDelete(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: 'Delete workspace' });
  await dialog.getByPlaceholder(name).fill(name);
  await dialog.getByRole('button', { name: 'Delete workspace' }).click();
}

const sidebarOf = (page: Page) => page.getByRole('complementary').first();
const archivedNotice = (page: Page) => page.getByRole('status').filter({ hasText: 'Archived on' });

test('from an archived record, an active workspace is one click away', async ({ page }) => {
  await mockTwoWorkspaces(page);
  await page.goto('/#/workspaces/old');
  const sidebar = sidebarOf(page);
  await expect(archivedNotice(page)).toBeVisible();

  // The list follows the record on screen, and both lists are always in view at its top.
  await expect(sidebar.getByRole('button', { name: 'Archived (1)' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar.getByRole('button', { name: 'Active (1)' })).toHaveAttribute('aria-pressed', 'false');

  await sidebar.getByRole('button', { name: 'Active (1)' }).click();
  await sidebar.getByRole('link', { name: /Live billing work/ }).click();

  await expect(page).toHaveURL(/#\/workspaces\/live$/);
  await expect(archivedNotice(page)).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Active (1)' })).toHaveAttribute('aria-pressed', 'true');
});

test('the list switches itself when the address moves between an archived record and an active workspace', async ({ page }) => {
  await mockTwoWorkspaces(page);
  await page.goto('/#/workspaces/old');
  const sidebar = sidebarOf(page);
  await expect(sidebar.getByRole('button', { name: 'Archived (1)' })).toHaveAttribute('aria-pressed', 'true');

  // Going to an active workspace by any other way (a link, Back, a typed address) shows the active list again.
  await page.evaluate(() => { window.location.hash = '#/workspaces/live'; });
  await expect(sidebar.getByRole('button', { name: 'Active (1)' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar.getByText('Archived workspaces')).toHaveCount(0);

  await page.evaluate(() => { window.location.hash = '#/workspaces/old'; });
  await expect(sidebar.getByRole('button', { name: 'Archived (1)' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar.getByText('Archived workspaces')).toBeVisible();

  // A page that is not a workspace shows the active list too.
  await page.evaluate(() => { window.location.hash = '#/overview'; });
  await expect(sidebar.getByRole('button', { name: 'Active (1)' })).toHaveAttribute('aria-pressed', 'true');
});

test('a search finds an active workspace while the archived list is showing', async ({ page }) => {
  await mockTwoWorkspaces(page);
  await page.goto('/#/workspaces/old');
  const sidebar = sidebarOf(page);
  await expect(archivedNotice(page)).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /Live billing work/ })).toHaveCount(0);

  await sidebar.getByPlaceholder('Filter...').fill('billing');
  await expect(sidebar.getByRole('link', { name: /Live billing work/ })).toBeVisible();
  await expect(sidebar.getByText('No workspaces match')).toHaveCount(0);

  await sidebar.getByRole('link', { name: /Live billing work/ }).click();
  await expect(page).toHaveURL(/#\/workspaces\/live$/);
});

test('an open session is reached from an archived record on its own home, the plan', async ({ page }) => {
  await mockTwoWorkspaces(page);
  await mockShells(page);
  // Opening the chat makes the workspace an open session, which then stays in the sidebar on every page.
  await page.goto('/#/workspaces/live/chat');
  const sidebar = sidebarOf(page);
  await expect(sidebar.locator('[data-sidebar-session="live"]')).toBeVisible();

  // The record's own address, which is what its "Record" item on the rail opens.
  await page.goto('/#/workspaces/old/overview');
  await expect(archivedNotice(page)).toBeVisible();
  await sidebar.locator('[data-sidebar-session="live"]').click();

  // Not /overview, which an active workspace has no place for on its rail: its home, the plan.
  await expect(page).toHaveURL(/#\/workspaces\/live(\/plan)?$/);
  await expect(archivedNotice(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Plan' })).toHaveAttribute('aria-current', 'page');
});

test.describe('deleting the workspace on screen', () => {
  const second = { ...LIVE, id: 'next', branchName: 'next', name: 'Next billing work', workspacePath: '/ws/next' };

  test('leaves for a workspace that is still there, and its session goes with it', async ({ page }) => {
    let remaining = [OLD, LIVE, second];
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: remaining }));
    await page.route(/\/api\/workspace\/(old|live|next)\/plan$/, (route) => route.fulfill({ json: planFile() }));
    await page.route(/\/api\/workspace\/(old|live|next)\/documents$/, (route) => route.fulfill({ json: { documents: [] } }));
    await page.route(/\/api\/workspace\/(old|live|next)\/work$/, (route) => route.fulfill({ json: {
      guidance: { version: 1, revision: 0, workType: 'general', size: 'standard', documents: [],
        assignment: { stage: 'implement', objective: 'Ship it', expectedOutput: '', stopCondition: '' } },
      lifecycle: null, assignment: '', sharedDocuments: [],
    } }));
    await mockShells(page);
    await page.route('**/api/workspace/live', (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      remaining = [OLD, second];
      return route.fulfill({ json: { success: true } });
    });

    // Both workspaces are open sessions; "live" is the one on screen.
    await page.goto('/#/workspaces/next/chat');
    await expect(sidebarOf(page).locator('[data-sidebar-session="next"]')).toBeVisible();
    await page.goto('/#/workspaces/live/chat');
    await expect(sidebarOf(page).locator('[data-sidebar-session="live"]')).toBeVisible();
    await page.goto('/#/workspaces/live/plan');

    await openMenuFor(page.getByRole('button', { name: 'Workspace actions' }), page.getByRole('menuitem', { name: 'Delete workspace…' }));
    await page.getByRole('menuitem', { name: 'Delete workspace…' }).click();
    await confirmDelete(page, 'live');

    // Not back on the address that no longer exists, and no row left for it in the sidebar.
    await expect(page).toHaveURL(/#\/workspaces\/next(\/[a-z]+)?$/);
    await expect(sidebarOf(page).locator('[data-sidebar-session="live"]')).toHaveCount(0);
    await expect(sidebarOf(page).locator('[data-sidebar-session="next"]')).toBeVisible();
    await expect(page.getByText('Workspace not found')).toHaveCount(0);
  });

  test('goes to Start a workspace when nothing active is left, and never to an archived record', async ({ page }) => {
    let remaining = [OLD, LIVE];
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: remaining }));
    await page.route(/\/api\/workspace\/(old|live)\/(plan|documents|work)$/, (route) => route.fulfill({ json: { ...planFile(), documents: [], guidance: { version: 1, revision: 0, workType: 'general', size: 'standard', documents: [], assignment: { stage: 'implement', objective: 'x', expectedOutput: '', stopCondition: '' } }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
    await page.route('**/api/workspace/live', (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      remaining = [OLD];
      return route.fulfill({ json: { success: true } });
    });

    await page.goto('/#/workspaces/live/plan');
    await openMenuFor(page.getByRole('button', { name: 'Workspace actions' }), page.getByRole('menuitem', { name: 'Delete workspace…' }));
    await page.getByRole('menuitem', { name: 'Delete workspace…' }).click();
    await confirmDelete(page, 'live');

    await expect(page).toHaveURL(/#\/new/);
    await expect(archivedNotice(page)).toHaveCount(0);
  });
});

test.describe('archiving a workspace that has a session', () => {
  const next = { ...LIVE, id: 'next', branchName: 'next', name: 'Next billing work', workspacePath: '/ws/next' };
  const third = { ...LIVE, id: 'third', branchName: 'third', name: 'Third billing work', workspacePath: '/ws/third' };
  const archivedLive = { ...LIVE, archivedAt: '2026-09-28T10:00:00.000Z', archive: { archivedAt: '2026-09-28T10:00:00.000Z', previousMode: 'in-place', parked: false, repos: [] } };
  const archiveReport = { workspacePath: '/ws/live', workspaceId: 'live', dryRun: false, alreadyArchived: false, ready: true, blockers: [], repos: [], kept: [], notes: [], errors: [], archived: true, branches: [] };

  async function mockThree(page: Page, list: () => unknown[]) {
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: list() }));
    await page.route(/\/api\/workspace\/(old|live|next|third)\/plan$/, (route) => route.fulfill({ json: planFile() }));
    await page.route(/\/api\/workspace\/(old|live|next|third)\/documents$/, (route) => route.fulfill({ json: { documents: [] } }));
    await page.route(/\/api\/workspace\/(old|live|next|third)\/work$/, (route) => route.fulfill({ json: {
      guidance: { version: 1, revision: 0, workType: 'general', size: 'standard', documents: [],
        assignment: { stage: 'implement', objective: 'Ship it', expectedOutput: '', stopCondition: '' } },
      lifecycle: null, assignment: '', sharedDocuments: [],
    } }));
    await mockShells(page);
  }

  test('stops its terminal, closes its tab, leaves you on its record, and the Alt keys skip it', async ({ page }) => {
    let current: unknown[] = [LIVE, next, third];
    const stopped: string[] = [];
    await mockThree(page, () => current);
    await page.route('**/api/terminals/*/*/stop', (route) => {
      stopped.push(route.request().url().split('/api/terminals/')[1]!.replace('/stop', ''));
      return route.fulfill({ json: { success: true } });
    });
    await page.route('**/api/workspace/live/archive', (route) => {
      const body = route.request().postDataJSON() as { dryRun?: boolean };
      if (body.dryRun) return route.fulfill({ json: { ...archiveReport, dryRun: true, archived: false } });
      current = [archivedLive, next, third];
      return route.fulfill({ json: archiveReport });
    });

    // Three sessions in tab order: next, live, third. "live" is the one archived.
    for (const id of ['next', 'live', 'third']) {
      await page.goto(`/#/workspaces/${id}/chat`);
      await expect(sidebarOf(page).locator(`[data-sidebar-session="${id}"]`)).toBeVisible();
    }
    await page.goto('/#/workspaces/live/plan');

    await openMenuFor(page.getByRole('button', { name: 'Workspace actions' }), page.getByRole('menuitem', { name: 'Archive workspace…' }));
    await page.getByRole('menuitem', { name: 'Archive workspace…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive workspace' });
    await expect(dialog).toContainText('any assistant running in it stops');
    await dialog.getByRole('button', { name: 'Archive workspace' }).click();
    await expect(dialog).toBeHidden();

    // Its terminal was stopped, and only its terminal.
    await expect.poll(() => stopped).toEqual(['live/term-live']);
    // The person stays where they were: on the record, not thrown into another workspace's chat.
    await expect(archivedNotice(page)).toBeVisible();
    await expect(page).toHaveURL(/#\/workspaces\/live(\/[a-z]+)?$/);
    await expect(sidebarOf(page).locator('[data-sidebar-session="live"]')).toHaveCount(0);
    await expect(sidebarOf(page).locator('[data-sidebar-session="next"]')).toBeVisible();
    await expect(sidebarOf(page).locator('[data-sidebar-session="third"]')).toBeVisible();

    // Alt+Up from "third" goes to "next", not to the archived record that used to sit between them.
    await page.goto('/#/workspaces/third/chat');
    await expect(sidebarOf(page).locator('[data-sidebar-session="third"]')).toBeVisible();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page).toHaveURL(/#\/workspaces\/next\/chat$/);
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page).toHaveURL(/#\/workspaces\/third\/chat$/);
    // The second slot is "third" now; before, it was the archived workspace.
    await page.keyboard.press('Alt+1');
    await expect(page).toHaveURL(/#\/workspaces\/next\/chat$/);
    await page.keyboard.press('Alt+2');
    await expect(page).toHaveURL(/#\/workspaces\/third\/chat$/);
  });

  test('says so when its terminal could not be stopped, and still archives', async ({ page }) => {
    let current: unknown[] = [LIVE, next];
    await mockThree(page, () => current);
    await page.route('**/api/terminals/*/*/stop', (route) => route.fulfill({ status: 400, json: { error: 'Terminal not found.' } }));
    await page.route('**/api/workspace/live/archive', (route) => {
      const body = route.request().postDataJSON() as { dryRun?: boolean };
      if (body.dryRun) return route.fulfill({ json: { ...archiveReport, dryRun: true, archived: false } });
      current = [archivedLive, next];
      return route.fulfill({ json: archiveReport });
    });
    await page.goto('/#/workspaces/live/chat');
    await expect(sidebarOf(page).locator('[data-sidebar-session="live"]')).toBeVisible();

    await openMenuFor(page.getByRole('button', { name: 'Workspace actions' }), page.getByRole('menuitem', { name: 'Archive workspace…' }));
    await page.getByRole('menuitem', { name: 'Archive workspace…' }).click();
    await page.getByRole('dialog', { name: 'Archive workspace' }).getByRole('button', { name: 'Archive workspace' }).click();

    // The workspace is archived either way; the message says one session may still be running.
    await expect(page.getByText(/Archived live, but a running session could not be stopped and may still be running/)).toBeVisible();
    await expect(archivedNotice(page)).toBeVisible();
    await expect(sidebarOf(page).locator('[data-sidebar-session="live"]')).toHaveCount(0);
  });

  test('a window reloaded after the workspace was archived elsewhere drops its stale tab', async ({ page }) => {
    // The saved tabs still hold "live", which the list now says is archived.
    await page.addInitScript(() => localStorage.setItem('contextspace_floating_chat_state_v1', JSON.stringify({ openTabs: ['next', 'live', 'third'], activeTab: 'next', modes: {}, harnesses: {}, splitRatio: 50 })));
    await mockThree(page, () => [archivedLive, next, third]);
    await page.goto('/#/workspaces/next/plan');
    const sidebar = sidebarOf(page);
    await expect(sidebar.locator('[data-sidebar-session="next"]')).toBeVisible();
    await expect(sidebar.locator('[data-sidebar-session="third"]')).toBeVisible();
    await expect(sidebar.locator('[data-sidebar-session="live"]')).toHaveCount(0);

    // From "next", the way on is "third": the archived record is not a session to land on.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page).toHaveURL(/#\/workspaces\/third\/plan$/);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page).toHaveURL(/#\/workspaces\/next\/plan$/);
  });
});
