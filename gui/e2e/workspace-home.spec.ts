import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planItem, planView } from './planData';

/**
 * A workspace opens on its plan, with the sessions one click away: start a tool on a ready item from its row, see what
 * runs now as tabs, and continue a saved conversation in the chat, which is the one place sessions start.
 * Old links to the chat and the sessions still open them.
 */
const workspace = { id: 'feature-x', branchName: 'feature-x', name: 'Reports CSV export', description: 'Add CSV export to reports', repos: [], assistants: [], workspacePath: '/tmp/feature-x', createdAt: '2026-09-20T00:00:00Z' };
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1440, height: 950 } });

const SHOTS = process.env.HOME_SHOTS_DIR;
const SAVED = '123e4567-e89b-42d3-a456-426614174000';
type Terminal = { id: string; workspace: string; target: string; label: string; cwd: string; state: 'running' | 'exited'; startedAt: string; lastOutputAt?: string };
const terminal = (id: string, target: string): Terminal => ({ id, workspace: 'feature-x', target, label: target, cwd: '/tmp/feature-x', state: 'running', startedAt: '2026-10-10T10:00:00.000Z' });
const TARGETS = ['claude', 'codex', 'antigravity', 'pi', 'copilot', 'shell'].map((id) => ({ id, name: id, available: true, reason: null }));

function plan(startedBy?: string) {
  return planView([
    planItem({ id: 'M1', title: 'Database query for report rows', status: 'done', resolution: 'Passed its check' }),
    planItem({ id: 'M2', title: 'CSV export endpoint', ...(startedBy ? { status: 'in_progress', history: [{ at: '2026-10-10T10:00:00.000Z', by: startedBy, action: 'started' }] } : {}) }),
    planItem({ id: 'M3', title: 'Export button in the UI', waitsFor: [{ id: 'M2', label: 'M2 CSV export endpoint', status: startedBy ? 'in_progress' : 'todo' }] }),
  ], { ready: startedBy ? [] : ['M2 CSV export endpoint'] });
}

async function mockServer(page: Page, { running = [] as Terminal[], saved = false, startedBy = undefined as string | undefined } = {}) {
  const server = { terminals: [...running], created: [] as Array<Record<string, unknown>>, attached: [] as string[] };
  await page.route('**/api/workspace/feature-x/plan/items', (route) => route.fulfill({ json: plan(startedBy) }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({ json: { available: true, sessions: server.terminals, targets: TARGETS } }));
  await page.route('**/api/terminals/running', (route) => route.fulfill({ json: { sessions: server.terminals.map((entry) => ({ ...entry, attached: false, lastOutputAt: new Date().toISOString() })) } }));
  await page.route('**/api/terminals/feature-x/create', async (route) => {
    const body = route.request().postDataJSON() as { target: string };
    server.created.push(body);
    const created = terminal(`t-${body.target}-${server.created.length}`, body.target);
    server.terminals.push(created);
    await route.fulfill({ json: { terminal: created } });
  });
  await page.route('**/api/workspace/feature-x/sessions*', (route) => route.fulfill({ json: { sessions: saved && route.request().url().includes('claude') ? [{
    id: SAVED, assistant: 'claude', title: 'Plan the CSV export', createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T11:00:00.000Z',
    messageCount: 12, workspacePath: '/tmp/feature-x', recordedCwd: '/tmp/feature-x',
  }] : [] } }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type !== 'attach') return;
      server.attached.push(parsed.id);
      socket.send(JSON.stringify({ type: 'ready', terminal: server.terminals.find((entry) => entry.id === parsed.id), truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  return server;
}

const FIRST_MESSAGE = 'Work on M2 CSV export endpoint. Read the plan with `ctxspace plan` first. If it is not started yet, start it with `ctxspace plan start M2`.';

test('opens on the plan, with no second place to start a session: that is the chat', async ({ page }) => {
  await mockServer(page, { saved: true });
  await page.goto('/#/workspaces/feature-x');
  await expect(page.getByRole('region', { name: 'The plan', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Start a session' })).toHaveCount(0);
  const tabs = page.getByLabel('Plan and sessions');
  await expect(tabs.getByText('Plan', { exact: true })).toBeVisible();
  await expect(tabs.getByRole('button', { name: /New session/ })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/home-no-session.png` });
});

test('starts the last-used tool on a ready item from its row, with a first message that names it', async ({ page }) => {
  const server = await mockServer(page);
  await page.goto('/#/workspaces/feature-x');
  await page.getByRole('button', { name: 'Start a session on M2 CSV export endpoint' }).click();
  await expect.poll(() => server.created).toEqual([expect.objectContaining({ target: 'claude', prompt: FIRST_MESSAGE })]);
});

test('shows the running sessions beside the plan, named after what they work on, and brings one on screen', async ({ page }) => {
  const server = await mockServer(page, { running: [terminal('t-claude', 'claude')], startedBy: 'claude' });
  await page.goto('/#/workspaces/feature-x');
  const tabs = page.getByLabel('Plan and sessions');
  const session = tabs.getByRole('button', { name: /Show CSV export endpoint in Claude Code/ });
  await expect(session).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/home-running.png` });
  await session.click();
  await expect(page).toHaveURL(/#\/workspaces\/feature-x\/chat$/);
  await expect.poll(() => server.attached).toContain('t-claude');
  expect(server.created).toEqual([]);
});

test('continues a saved conversation from the chat, where sessions start', async ({ page }) => {
  const server = await mockServer(page, { saved: true });
  await page.goto('/#/workspaces/feature-x/chat');
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const saved = chat.getByRole('region', { name: 'Continue a conversation' }).getByTestId('resume-session-row').filter({ hasText: 'Plan the CSV export' });
  await saved.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => server.created).toEqual([expect.objectContaining({ target: 'claude', sessionId: SAVED })]);
  expect(server.created[0]).not.toHaveProperty('prompt');
});

test('the session tabs have a Plan tab, and old links to the chat and the sessions still open them', async ({ page }) => {
  await mockServer(page, { running: [terminal('t-claude', 'claude')] });
  await page.goto('/#/workspaces/feature-x/chat');
  await expect(page.getByRole('region', { name: 'CLI Chat', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Plan', exact: true }).first().click();
  await expect(page).toHaveURL(/#\/workspaces\/feature-x\/plan$/);
  await expect(page.getByRole('region', { name: 'The plan', exact: true })).toBeVisible();
  await page.goto('/#/workspaces/feature-x/sessions');
  await expect(page.getByRole('heading', { name: 'AI Sessions & History' })).toBeVisible();
});
