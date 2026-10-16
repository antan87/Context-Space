import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const alpha = { id: 'alpha', branchName: 'alpha', description: 'Alpha workspace', repos: [], assistants: [], workspacePath: '/tmp/alpha', createdAt: '2026-09-24T00:00:00Z' };
const beta = { id: 'beta', branchName: 'beta', description: 'Beta workspace', repos: [], assistants: [], workspacePath: '/tmp/beta', createdAt: '2026-09-24T00:00:00Z' };

test.use({ workspacesData: [[alpha, beta], { option: true }], viewport: { width: 1365, height: 900 } });

/** An open chat is a session in the sidebar; the one on screen is the current page. */
const session = (page: Page, branch: string) => page.locator(`aside.context-sidebar [data-sidebar-session="${branch}"]`);

test.beforeEach(async ({ page }) => {
  await page.route('**/api/terminals/bootstrap', route => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', route => route.fulfill({ json: { available: true, sessions: [], targets: [] } }));
  await page.route('**/api/workspace/*/sessions', route => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', route => route.fulfill({ json: { content: '# Plan' } }));
});

test('workspace actions open the selected CLI chat without starting a session', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('contextspace_floating_chat_state_v1', JSON.stringify({ modes: { alpha: 'chat' } }));
  });
  const launches: string[] = [];
  page.on('request', request => {
    if (/\/api\/terminals\/[^/]+\/create$/.test(request.url())) launches.push(request.url());
  });

  await page.goto('/#/overview');
  await page.locator('section[aria-labelledby="recent-heading"]')
    .getByRole('button', { name: 'View all CLI sessions for alpha' }).click();

  const chat = page.getByRole('region', { name: 'CLI Chat' });
  await expect(chat).toBeVisible();
  await expect(session(page, 'alpha')).toHaveAttribute('aria-current', 'page');
  await expect(chat.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0);

  // Leaving the chat hides it. Its sessions keep running, and the sidebar brings it back.
  await page.goto('/#/overview');
  await expect(chat).toBeHidden();

  await page.locator('aside.context-sidebar').getByRole('button', { name: 'Resume CLI chat for beta' }).click();
  await expect(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
  await expect(chat.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0);
  await expect(launches).toEqual([]);
});

test('creation from chat returns to the new workspace in CLI mode', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('contextspace_floating_chat_state_v1', JSON.stringify({ modes: { beta: 'chat' } }));
  });
  await page.route('**/api/workspace/create-stream/create-beta', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `event: progress\ndata: ${JSON.stringify({ status: 'completed', steps: [], workspacePath: beta.workspacePath, feature: beta })}\n\n`,
  }));

  // With every session closed the chat offers the workspaces to choose from.
  await page.goto('/#/workspaces/alpha/chat');
  const picker = page.getByRole('region', { name: 'CLI Chat' });
  await session(page, 'alpha').focus();
  await page.keyboard.press('Delete');
  await expect(picker.getByRole('heading', { name: 'Choose a workspace for CLI chat' })).toBeVisible();
  await picker.getByRole('button', { name: 'Create workspace for CLI chat' }).click();
  await expect(page).toHaveURL(/#\/new\?from=chat$/);

  await page.goto('/#/new?from=chat&job=create-beta');
  // The new workspace opens on its chat.
  await expect(page).toHaveURL(/#\/workspaces\/beta(\/chat)?$/);
  const chat = page.getByRole('region', { name: 'CLI Chat' });
  await expect(chat).toBeVisible();
  await expect(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
  // It waits on the start screen: nothing is started for the developer.
  await expect(chat.getByRole('region', { name: 'Start a CLI session' })).toBeVisible();
  await expect(chat.getByTestId('terminal-state')).toHaveCount(0);
});
