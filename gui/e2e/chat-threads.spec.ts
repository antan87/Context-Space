import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planFile } from './planData';

/**
 * Every open chat says what it is working on without being opened: its row in the sidebar shows the goal, or the question
 * its AI is waiting on, and the progress behind it is read while the full sidebar is showing.
 */
const workspace = (id: string, extra: Record<string, unknown> = {}) => ({
  id, branchName: id, description: `${id} workspace`, repos: [], assistants: [], workspacePath: `/tmp/${id}`, createdAt: '2026-09-24T00:00:00Z', ...extra,
});

test.use({
  workspacesData: [[
    workspace('alpha', { name: 'Faster search' }),
    workspace('beta', { name: 'Importer' }),
    workspace('gamma', { description: 'Release notes for 2.32\nWith the changelog' }),
    // Not open in the chat.
    workspace('delta', { name: 'Login bug', description: 'Sessions expire after a refresh' }),
  ], { option: true }],
  viewport: { width: 1440, height: 900 },
});

const CHAT_KEY = 'contextspace_floating_chat_state_v1';

const milestone = (id: string, title: string, state: string) => ({ id, title, state, verified: false, reopenCount: 0, dependsOn: [] });
const FACTS: Record<string, { milestones: ReturnType<typeof milestone>[]; current?: string }> = {
  alpha: { milestones: [milestone('m1', 'Measure the slow queries', 'done'), milestone('m2', 'Index the titles', 'in_progress')], current: 'm2' },
  beta: { milestones: [milestone('m1', 'Write the importer', 'in_progress'), milestone('m2', 'Map the fields', 'upcoming')], current: 'm1' },
  gamma: { milestones: [milestone('m1', 'Collect the changes', 'done'), milestone('m2', 'Write the notes', 'done')] },
};
const OBJECTIVES: Record<string, string> = { alpha: 'Make search answer in under 100 ms' };

function factsOf(workspaceId: string) {
  const { milestones, current } = FACTS[workspaceId] ?? { milestones: [] };
  const count = (state: string) => milestones.filter((entry) => entry.state === state).length;
  return {
    workspaceId, generatedAt: '2026-10-03T12:00:00.000Z', milestones, currentMilestoneId: current,
    counts: { total: milestones.length, done: count('done'), inProgress: count('in_progress'), reopened: count('reopened'), blocked: count('blocked'), upcoming: count('upcoming') },
    openQuestions: [], changes: { repos: [], files: 0, additions: 0, deletions: 0 },
    verification: { status: 'never', freshness: 'unknown' }, unavailable: [],
  };
}

const idOf = (url: string) => new URL(url).pathname.split('/')[3] ?? '';

async function mockChats(page: Page, { waiting = ['beta'], failing = [] as string[] } = {}) {
  const factsReads: string[] = [];
  await page.route('**/api/workspace/*/progress-facts', (route) => {
    const id = idOf(route.request().url());
    factsReads.push(id);
    if (failing.includes(id)) return route.fulfill({ status: 500, json: { error: 'The plan could not be read' } });
    return route.fulfill({ json: { facts: factsOf(id) } });
  });
  await page.route('**/api/workspace/*/work', (route) => route.fulfill({ json: {
    guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', documents: [],
      assignment: { stage: 'implement', objective: OBJECTIVES[idOf(route.request().url())] ?? '', expectedOutput: '', stopCondition: '' } },
    lifecycle: null, assignment: '', sharedDocuments: [],
  } }));
  await page.route('**/api/attention?*', (route) => {
    const wanted = new URL(route.request().url()).searchParams.get('workspaces')?.split(',') ?? [];
    return route.fulfill({ json: { requests: waiting.filter((id) => wanted.includes(id)).map((workspaceId) => ({
      workspaceId, id: `q-${workspaceId}`, timestamp: '2026-10-03T11:00:00.000Z', harness: 'claude', message: 'Which file format?',
    })) } });
  });
  return factsReads;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ chatKey }) => {
    try {
      if (sessionStorage.getItem('seeded')) return;
      localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 62 }));
      localStorage.setItem(chatKey, JSON.stringify({ openTabs: ['alpha', 'beta', 'gamma'], activeTab: 'alpha', modes: {} }));
      sessionStorage.setItem('seeded', '1');
    } catch { /* Storage can be unavailable. */ }
  }, { chatKey: CHAT_KEY });
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    return route.fulfill({ json: { available: true, sessions: [{ id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' }], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } });
  });
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

const sidebar = (page: Page) => page.locator('aside.context-sidebar');
/** An open chat is a session in the sidebar, above the list of workspaces. */
const session = (page: Page, branch: string) => sidebar(page).locator(`[data-sidebar-session="${branch}"]`);

test.describe('each open session says what its chat is working on', () => {
  test('shows a goal line, read from the assignment, the plan or the description', async ({ page }) => {
    await mockChats(page);
    await page.goto('/#/workspaces/alpha/chat');
    await expect(session(page, 'alpha')).toContainText('Faster search');
    await expect(session(page, 'alpha')).toContainText('Make search answer in under 100 ms');
    // While the AI waits, the row shows what it asked rather than the goal.
    await expect(session(page, 'beta')).toContainText('Waiting for you');
    await expect(session(page, 'beta')).toContainText('Which file format?');
    // Only the first line of a description, so a row stays one short line.
    await expect(session(page, 'gamma')).toContainText('Release notes for 2.32');
    await expect(session(page, 'gamma')).not.toContainText('changelog');
  });

  test('a chat whose progress cannot be read still says what it is for, and guesses no state', async ({ page }) => {
    await mockChats(page, { waiting: [], failing: ['beta'] });
    await page.goto('/#/workspaces/alpha/chat');
    await expect(session(page, 'alpha')).toContainText('Make search answer in under 100 ms');
    await expect(session(page, 'beta')).toContainText('beta workspace');
    await expect(session(page, 'beta').locator('.state-chip')).toHaveCount(0);
  });

  test('reads the open chats while the full sidebar is showing, on any page', async ({ page }) => {
    const reads = await mockChats(page);
    await page.goto('/#/guide');
    await expect(sidebar(page)).toBeVisible();
    await expect.poll(() => [...new Set(reads)].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('does not read them for the collapsed sidebar, which shows no summaries', async ({ page }) => {
    // A narrow window shows the sidebar as a rail.
    await page.setViewportSize({ width: 900, height: 900 });
    const reads = await mockChats(page);
    await page.goto('/#/guide');
    await expect(page.locator('aside.context-sidebar.w-14')).toBeVisible();
    await page.waitForTimeout(1500);
    expect(reads).toEqual([]);
  });
});

test.describe('a chat with no goal anywhere', () => {
  test.use({ workspacesData: [[workspace('alpha', { name: 'Faster search' }), workspace('zeta', { description: '' })], { option: true }] });

  test('says how many repositories it has instead, so every row has a second line', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ openTabs: ['alpha', 'zeta'], activeTab: 'alpha', modes: {} })), CHAT_KEY);
    await mockChats(page, { waiting: [] });
    await page.goto('/#/workspaces/alpha/chat');
    await expect(session(page, 'zeta')).toContainText('0 repos');
    await expect(session(page, 'alpha')).toContainText('Make search answer in under 100 ms');
  });
});

test.describe('the sidebar', () => {
  test('says what each open chat is working on and which needs you, and leaves the other workspaces as they were', async ({ page }) => {
    await mockChats(page);
    await page.goto('/#/workspaces/alpha/chat');
    const importer = sidebar(page).getByRole('link', { name: /^Importer/ });
    await expect(importer).toContainText('Waiting for you');
    // What it asked, rather than the goal, while it waits.
    await expect(importer).toContainText('Which file format?');
    await expect(sidebar(page).getByRole('link', { name: /^Faster search/ })).toContainText('Make search answer in under 100 ms');
    await expect(sidebar(page).getByRole('link', { name: /^Faster search/ })).not.toContainText('In progress');
    const login = sidebar(page).getByRole('link', { name: /^Login bug/ });
    await expect(login).toContainText('delta');
    await expect(login).toContainText('0 repos');
    // It shows what it last read, and keeps showing it on another page.
    await page.goto('/#/guide');
    await expect(importer).toContainText('Which file format?');
  });
});
