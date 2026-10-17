import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/** An open chat is a session in the sidebar; the one on screen is the current page. */
const sidebarSession = (page: Page, branch: string) => page.locator(`aside.context-sidebar [data-sidebar-session="${branch}"]`);
const openSessions = (page: Page) => page.locator('aside.context-sidebar [data-sidebar-session]');

const feature = { id: 'feature-x', branchName: 'feature-x', description: 'Harness resume', repos: [], assistants: ['antigravity', 'codex'], workspacePath: 'C:/ws/feature-x', createdAt: '2026-09-20T00:00:00Z' };
const harnesses = ['codex', 'claude', 'antigravity', 'copilot', 'pi'];
const sessions = harnesses.map((assistant, i) => ({
  id: `0199a213-81c0-7800-8aa1-bbab2a035a5${i}`, assistant, title: `${assistant} saved conversation`,
  threadKind: i < 2 ? 'main' : 'unknown', workspacePath: feature.workspacePath,
  recordedCwd: feature.workspacePath,
  createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z', messageCount: 5,
}));
const child = { ...sessions[0], id: '0199a213-81c0-7800-8aa1-bbab2a035a59', title: 'Delegated code review', threadKind: 'subagent', parentSessionId: sessions[0].id };

test.use({ workspacesData: [feature], viewport: { width: 1365, height: 960 } });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/ai-detect', route => route.fulfill({ json: [
    { name: 'codex', displayName: 'Codex', detected: true }, { name: 'antigravity', displayName: 'Antigravity', detected: true },
  ] }));
  await page.route('**/api/adapters/status', route => route.fulfill({ json: [] }));
  await page.route('**/api/session-sources', route => route.fulfill({ json: { sources: [...harnesses, 'workspace'] } }));
  await page.route('**/api/workspace/feature-x/sessions*', route => route.fulfill({ json: { sessions: [...sessions, child] } }));
  await page.route('**/api/terminals/bootstrap', route => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: {
    available: true, sessions: [], targets: [...harnesses, 'shell'].map(id => ({ id, name: id, available: true, reason: null })),
  } }));
  // Verify dispatch without launching an AI process or altering a saved conversation.
  await page.route('**/api/terminals/feature-x/create', route => route.fulfill({ status: 400, json: { error: 'Test launch intercepted' } }));
});

test('overview and sidebar reopen the existing workspace CLI session', async ({ page }) => {
  await page.goto('/#/overview');
  const card = page.getByRole('article');
  await expect(card.getByRole('button', { name: 'Open codex saved conversation with Codex in CLI chat' })).toBeVisible();
  await card.getByRole('button', { name: 'View all CLI sessions for feature-x' }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  await expect(chat).toBeVisible();
  await expect(sidebarSession(page, 'feature-x')).toHaveCount(1);
  // The tools and the saved conversations are on one screen.
  await expect(chat.getByRole('group', { name: 'CLI tools' })).toBeVisible();
  await expect(chat.getByRole('region', { name: 'Continue a conversation' })).toBeVisible();
  // Leaving the chat hides it without ending anything.
  await page.goto('/#/overview');
  await expect(chat).toBeHidden();

  await page.locator('aside.context-sidebar').getByRole('button', { name: 'Resume CLI chat for feature-x' }).click();
  await expect(chat).toBeVisible();
  await expect(sidebarSession(page, 'feature-x')).toHaveCount(1);
  await expect(chat.getByRole('tablist', { name: 'CLI sessions' }).getByRole('tab')).toHaveCount(1);
});

test('saved conversations appear as their sources finish', async ({ page }) => {
  let releaseCodex!: () => void;
  const codexReady = new Promise<void>(resolve => { releaseCodex = resolve; });
  await page.route('**/api/workspace/feature-x/sessions?source=*', async route => {
    const source = new URL(route.request().url()).searchParams.get('source');
    if (source === 'codex') await codexReady;
    const result = source === 'claude' ? [sessions[1]] : source === 'codex' ? [sessions[0]] : [];
    await route.fulfill({ json: { sessions: result } });
  });
  try {
    await page.goto('/#/overview');
    await page.locator('aside.context-sidebar').getByRole('button', { name: 'Resume CLI chat for feature-x' }).click();
    const history = page.getByRole('region', { name: 'Continue a conversation' });
    await expect(history.getByText(sessions[1].title)).toBeVisible();
    await expect(history.getByText(sessions[0].title)).toHaveCount(0);
    await expect(history.getByRole('status')).toContainText('5 of 6 sources checked');
    releaseCodex();
    await expect(history.getByText(sessions[0].title)).toBeVisible();
    await expect(history.getByRole('status')).toHaveCount(0);
    await expect(history.getByTestId('resume-session-row')).toHaveCount(2);
  } finally {
    releaseCodex();
  }
});

test('overview loads previous sessions progressively and opens the selected CLI conversation', async ({ page }) => {
  let releaseClaude!: () => void;
  let releaseCodex!: () => void;
  const claudeReady = new Promise<void>(resolve => { releaseClaude = resolve; });
  const codexReady = new Promise<void>(resolve => { releaseCodex = resolve; });
  await page.route('**/api/workspace/feature-x/sessions?source=*', async route => {
    const source = new URL(route.request().url()).searchParams.get('source');
    if (source === 'claude') await claudeReady;
    if (source === 'codex') await codexReady;
    const result = source === 'claude' ? [sessions[1]] : source === 'codex'
      ? [{ ...sessions[0], updatedAt: '2026-09-22T00:00:00Z' }] : [];
    await route.fulfill({ json: { sessions: result } });
  });
  try {
    await page.goto('/#/overview');
    const preview = page.getByRole('region', { name: 'Recent CLI sessions for feature-x' });
    await expect(preview).toContainText('Finding saved conversations…');
    await expect(preview.getByRole('status')).toBeVisible();
    releaseClaude();
    await expect(preview.getByRole('button', { name: 'Open claude saved conversation with Claude Code in CLI chat' })).toBeVisible();
    await expect(preview.getByRole('status')).toContainText('5/6');
    releaseCodex();
    const codex = preview.getByRole('button', { name: 'Open codex saved conversation with Codex in CLI chat' });
    await expect(codex).toBeVisible();
    await expect(preview.getByRole('status')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/overview-recent-cli-sessions.png', fullPage: true });
    const request = page.waitForRequest('**/api/terminals/feature-x/create');
    await codex.click();
    expect((await request).postDataJSON()).toMatchObject({ target: 'codex', sessionId: sessions[0].id });
    await expect(page.getByRole('region', { name: 'CLI Chat' })).toBeVisible();
  } finally {
    releaseClaude();
    releaseCodex();
  }
});

test('overview shows Pi history with its harness icon and resumes the chosen session', async ({ page }) => {
  await page.route('**/api/workspace/feature-x/sessions?source=*', route => {
    const source = new URL(route.request().url()).searchParams.get('source');
    const result = source === 'pi' ? [{ ...sessions[4], updatedAt: '2026-09-22T00:00:00Z' }]
      : source === 'codex' ? [{ ...sessions[0], updatedAt: '2026-09-24T00:00:00Z' },
        { ...sessions[0], id: '0199a213-81c0-7800-8aa1-bbab2a035a61', updatedAt: '2026-09-23T00:00:00Z' }] : [];
    return route.fulfill({ json: { sessions: result } });
  });
  await page.goto('/#/overview');
  const preview = page.getByRole('region', { name: 'Recent CLI sessions for feature-x' });
  const pi = preview.getByRole('button', { name: 'Open pi saved conversation with Pi in CLI chat' });
  await expect(pi).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Open codex saved conversation with Codex in CLI chat' })).toHaveCount(1);
  await expect(pi.locator('svg')).toHaveCount(2);
  const request = page.waitForRequest('**/api/terminals/feature-x/create');
  await pi.click();
  expect((await request).postDataJSON()).toMatchObject({ target: 'pi', sessionId: sessions[4].id });
});

test('selecting an already running CLI session reuses its terminal', async ({ page }) => {
  const terminal = { id: '0199a213-81c0-7800-8aa1-bbab2a035a60', workspace: 'feature-x', target: 'codex', label: 'Codex', cwd: feature.workspacePath, sessionId: sessions[0].id, state: 'running' };
  let launches = 0;
  let releaseCreate!: () => void;
  const createReady = new Promise<void>(resolve => { releaseCreate = resolve; });
  await page.route('**/api/terminals/feature-x/create', async route => {
    launches++;
    await createReady;
    await route.fulfill({ json: { terminal } });
  });
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: {
    available: true, sessions: launches ? [terminal] : [], targets: harnesses.map(id => ({ id, name: id, available: true, reason: null })),
  } }));

  try {
    await page.goto('/#/overview');
    const session = page.getByRole('article').getByRole('button', { name: 'Open codex saved conversation with Codex in CLI chat' });
    await expect(session).toBeVisible();
    await session.click();
    const chat = page.getByRole('region', { name: 'CLI Chat' });
    // The pane toolbar replaced the "Resume session" toggle, so assert the reused
    // terminal itself. This fixture mocks the HTTP routes only, so the pane can
    // settle on either test id: a terminal is attached to the pane either way.
    const attached = chat.locator('[data-testid="terminal-state"], [data-testid="terminal-disconnected"]');
    await expect.poll(() => launches).toBe(1);
    await page.goto('/#/overview');
    await expect(chat).toBeHidden();
    await session.click();
    await expect(chat).toBeVisible();
    await page.waitForTimeout(150);
    expect(launches).toBe(1);
    releaseCreate();
    await expect(attached).toBeVisible();
    await page.goto('/#/overview');
    await expect(chat).toBeHidden();
    await session.click();
    await expect(chat).toBeVisible();
    await expect(attached).toBeVisible();
    expect(launches).toBe(1);
    await expect(sidebarSession(page, 'feature-x')).toHaveCount(1);
  } finally {
    releaseCreate();
  }
});

test.describe('workspace session selection', () => {
  const other = { ...feature, id: 'feature-y', branchName: 'feature-y', description: 'Other work', workspacePath: 'C:/ws/feature-y' };
  test.use({ workspacesData: [[feature, other], { scope: 'test' }] });

  test('resume action focuses an existing session without resetting it', async ({ page }) => {
    await page.goto('/#/overview');
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    await page.getByRole('article').filter({ hasText: 'Harness resume' }).getByRole('button', { name: 'View all CLI sessions for feature-x' }).click();
    // A second session tab, so returning shows whether the chat was reset.
    await chat.getByRole('button', { name: 'Start another CLI' }).click();
    await page.getByRole('menuitem', { name: 'Continue a saved conversation…' }).click();
    await expect(chat.getByRole('tablist', { name: 'CLI sessions' }).getByRole('tab')).toHaveCount(2);
    // The sidebar lists every workspace on pages outside a workspace; inside one it shows that workspace's worktrees.
    await page.goto('/#/overview');
    await page.locator('aside.context-sidebar').getByRole('button', { name: 'Resume CLI chat for feature-y' }).click();
    await expect(sidebarSession(page, 'feature-y')).toHaveAttribute('aria-current', 'page');

    await page.goto('/#/overview');
    await page.locator('aside.context-sidebar').getByRole('button', { name: 'Resume CLI chat for feature-x' }).click();
    await expect(sidebarSession(page, 'feature-x')).toHaveAttribute('aria-current', 'page');
    await expect(openSessions(page)).toHaveCount(2);
    await expect(chat.getByRole('tablist', { name: 'CLI sessions' }).getByRole('tab')).toHaveCount(2);
  });
});

test('resumes every indexed harness in the chat window using its recorded identity', async ({ page }) => {
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  // Every installed tool is one click away; nothing starts until one is chosen.
  await expect(chat.getByRole('group', { name: 'CLI tools' }).getByRole('button')).toHaveCount(6);
  await expect(chat.getByTestId('terminal-state')).toHaveCount(0);
  const history = chat.getByRole('region', { name: 'Continue a conversation' });
  await expect(history.getByTestId('resume-session-row')).toHaveCount(5);
  await expect(history.getByText(child.title)).toHaveCount(0);
  await expect(history.getByText('Main thread', { exact: true })).toHaveCount(2);
  await expect(history.getByText('Conversation', { exact: true })).toHaveCount(3);
  const firstRow = history.getByTestId('resume-session-row').first();
  await expect(firstRow.getByText(/^Last activity/).locator('time')).toHaveAttribute('datetime', '2026-09-21T00:00:00.000Z');
  await expect(firstRow.getByText(/^Started/).locator('time')).toHaveAttribute('datetime', '2026-09-20T00:00:00.000Z');
  await page.screenshot({ path: '../scratch/harness-ux/03-chat-after.png' });
  for (const session of sessions) {
    const request = page.waitForRequest('**/api/terminals/feature-x/create');
    await history.getByTestId('resume-session-row').filter({ hasText: session.title }).getByRole('button', { name: 'Continue', exact: true }).click();
    const launch = (await request).postDataJSON();
    expect(launch).toMatchObject({ target: session.assistant, sessionId: session.id });
    await expect(chat.getByRole('alert')).toContainText('Test launch intercepted');
    if (session === sessions[0]) {
      const retry = page.waitForRequest('**/api/terminals/feature-x/create');
      await chat.getByRole('button', { name: 'Retry launch' }).click();
      expect((await retry).postDataJSON()).toEqual(launch);
    }
  }
  await history.getByRole('checkbox', { name: /Include subagent/ }).check();
  const childRow = history.getByTestId('resume-session-row').filter({ hasText: child.title });
  await expect(childRow.getByText('Subagent', { exact: true })).toBeVisible();
  const parentRequest = page.waitForRequest('**/api/terminals/feature-x/create');
  await childRow.getByRole('button', { name: 'Main thread', exact: true }).click();
  expect((await parentRequest).postDataJSON()).toMatchObject({ target: 'codex', sessionId: sessions[0].id });
});

test('a tool that is not installed is not offered, the last one used is said to be missing, and the tool used stays with the workspace', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('contextspace_floating_chat_state_v1', JSON.stringify({ harnesses: { 'feature-x': 'codex' } }));
  });
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: {
    available: true, sessions: [], targets: [
      { id: 'codex', name: 'Codex', available: false, reason: 'Codex CLI is not installed' },
      { id: 'claude', name: 'Claude', available: true, reason: null },
    ],
  } }));
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const tools = chat.getByRole('group', { name: 'CLI tools' });
  await expect(tools.getByRole('button', { name: 'Start Claude Code' })).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Start Codex' })).toHaveCount(0);
  await expect(chat.getByRole('status').filter({ hasText: 'Codex, used last here, is not available' })).toContainText('Codex CLI is not installed');
  const request = page.waitForRequest('**/api/terminals/feature-x/create');
  await tools.getByRole('button', { name: 'Start Claude Code' }).click();
  expect((await request).postDataJSON()).toMatchObject({ target: 'claude' });
  await expect(chat.getByRole('alert')).toContainText('Test launch intercepted');
  await page.goto('/#/workspaces/feature-x/sessions');
  await expect(chat).toBeHidden();
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  // Claude Code is now the tool used last here: first, and nothing is said to be missing.
  await expect(tools.getByRole('button').first()).toHaveAccessibleName('Start Claude Code');
  await expect(tools.getByRole('button').first()).toHaveAttribute('title', /used last here/);
  await expect(chat.getByRole('status').filter({ hasText: 'is not available' })).toHaveCount(0);
});

test('Sessions tab defaults to conversations and can reveal delegated tasks', async ({ page }) => {
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: /Timeline/i }).click();
  await expect(page.getByText(sessions[0].title)).toBeVisible();
  await expect(page.getByText(/^Last activity/).first().locator('time')).toHaveAttribute('datetime', '2026-09-21T00:00:00.000Z');
  await expect(page.getByText(child.title)).toHaveCount(0);
  await page.getByRole('checkbox', { name: /Include subagent/ }).check();
  await expect(page.getByText(child.title)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Main thread', exact: true })).toBeVisible();
});

test('workspace creation shows harness choices without preselecting a provider', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByRole('button', { name: /More options/ }).click();
  const choices = page.getByRole('region', { name: 'AI harnesses' });
  await expect(choices).toBeVisible();
  const checkboxes = choices.getByRole('checkbox');
  await expect(checkboxes).toHaveCount(2);
  for (const checkbox of await checkboxes.all()) await expect(checkbox).not.toBeChecked();
  await expect(choices.getByText('Codex', { exact: true })).toBeVisible();
  await expect(choices.getByText('Antigravity', { exact: true })).toBeVisible();
  await choices.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '../scratch/harness-ux/04-create-after.png' });
});
