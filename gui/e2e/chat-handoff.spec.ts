import { test, expect } from './fixtures';

const feature = {
  id: 'feature-x',
  branchName: 'feature-x',
  description: 'Improve the local harness handoff',
  repos: ['C:/dev/nexusflow'],
  assistants: ['antigravity', 'claude', 'codex', 'copilot'],
  workspacePath: 'C:/ws/feature-x',
  createdAt: '2026-08-10T00:00:00.000Z',
};

test.describe('Multi-Harness Sessions and Launcher', () => {
  test.use({
    configData: {
      exists: true,
      config: {
        version: '0.2.19',
        devDir: 'C:/dev',
        workspacesDir: 'C:/ws',
        defaultAssistant: 'antigravity',
        scanDepth: 2,
      },
    },
    workspacesData: [feature],
    workspacesStatusData: {
      'feature-x': {
        id: 'feature-x',
        branchName: 'feature-x',
        changedFiles: 1,
        dirtyRepos: 1,
        runningServices: 0,
        syncStatus: 'up-to-date',
        pendingValidation: false,
      },
    },
  });

  test('displays sessions list and allows switching between AI harnesses', async ({ page }) => {
    const sessionId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
    await page.route('**/api/workspace/feature-x/sessions*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            {
              id: sessionId,
              assistant: 'codex',
              title: 'Finish the Desktop handoff',
              createdAt: '2026-08-15T00:00:00.000Z',
              updatedAt: '2026-08-16T00:00:00.000Z',
              messageCount: 6,
              workspacePath: feature.workspacePath,
              desktopHandoff: { targetId: 'codex-desktop', method: 'direct' },
            },
            {
              id: 'claude-session-1',
              assistant: 'claude',
              title: 'Refactor UI components',
              createdAt: '2026-08-14T00:00:00.000Z',
              updatedAt: '2026-08-14T10:00:00.000Z',
              messageCount: 4,
              workspacePath: feature.workspacePath,
            },
          ],
        }),
      });
    });

    // The full session history opens beside the chat from its saved conversations, and keeps its own address.
    await page.goto('/#/workspaces/feature-x/sessions');
    await expect(page.getByRole('heading', { name: 'feature-x' })).toBeVisible();

    // Switch to Timeline view so all sessions are listed
    await page.getByRole('button', { name: /Timeline/i }).click();

    // Check that recorded sessions appear on the page. The docked chat, hidden here, lists them too.
    const content = page.getByRole('main');
    await expect(content.getByText('Finish the Desktop handoff')).toBeVisible();
    await expect(content.getByText('Refactor UI components')).toBeVisible();
  });

  test('opens transcript dialog and copies CLI resume command', async ({ page }) => {
    const sessionId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
    await page.route('**/api/workspace/feature-x/sessions*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            {
              id: sessionId,
              assistant: 'codex',
              title: 'Implement feature workflow',
              createdAt: '2026-08-15T00:00:00.000Z',
              updatedAt: '2026-08-16T00:00:00.000Z',
              messageCount: 2,
              workspacePath: feature.workspacePath,
            },
          ],
        }),
      });
    });

    await page.route(`**/api/session/codex/${sessionId}/transcript*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'Please implement markdown rendering in the overview', timestamp: '2026-08-15T00:00:00.000Z' },
            { role: 'assistant', content: 'Here is the **Markdown** plan:\n\n1. Add ChatMarkdown\n2. Update tests', timestamp: '2026-08-15T00:01:00.000Z' },
          ],
        }),
      });
    });

    await page.goto('/#/workspaces/feature-x/sessions');

    // Switch to Timeline view so all sessions are listed
    await page.getByRole('button', { name: /Timeline/i }).click();

    // Click transcript view button (named Logs)
    await page.getByRole('button', { name: /Logs/i }).first().click();

    // Verify transcript modal appears with rich markdown
    await expect(page.getByText('Please implement markdown rendering in the overview')).toBeVisible();
    await expect(page.getByText('Here is the Markdown plan:')).toBeVisible();

    // Verify copy CLI command button is available
    await expect(page.getByRole('button', { name: /Copy CLI Command/i })).toBeVisible();
  });

  test('keeps the CLI entry visible while workspace Chat is hidden', async ({ page }) => {
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    await expect(chat).toBeVisible();
    await expect(chat.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0);
    // The chat opens on its tools, one click each; nothing starts by itself.
    await expect(chat.getByRole('region', { name: 'Start a CLI session' })).toBeVisible();
  });

});
