import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planFile } from './planData';

const workspace = (name: string) => ({
  id: name, branchName: name, description: `${name} workspace`, repos: [], assistants: [], workspacePath: `/tmp/${name}`, createdAt: '2026-09-24T00:00:00Z',
});
const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

test.use({ workspacesData: [names.map(workspace), { option: true }], viewport: { width: 1365, height: 900 } });

const CHAT_KEY = 'contextspace_floating_chat_state_v1';

type Request = { workspaceId: string; id: string; timestamp: string; harness: string; message: string };
let requests: Request[] = [];
let polls = 0;
let counter = 0;
/** Held back before each answer when a test needs the server to be slow. */
let answerDelayMs = 0;

const ask = (workspaceId: string, message: string, id = `req-${++counter}`): Request => ({
  workspaceId, id, timestamp: new Date().toISOString(), harness: 'claude', message,
});

/** Resolves once the app has polled again, so a change made now has been offered to it. */
async function nextPoll() {
  const before = polls;
  await expect.poll(() => polls, { timeout: 12_000 }).toBeGreaterThan(before);
}

/** Starts every load of the page with these chats open. Whether the chat is on screen depends on the address. */
async function chatState(page: Page, state: { tabs?: string[] } = {}) {
  const tabs = state.tabs ?? ['alpha', 'beta'];
  await page.addInitScript(([key, value]) => localStorage.setItem(key as string, value as string), [CHAT_KEY, JSON.stringify({
    openTabs: tabs, activeTab: tabs[0],
    modes: Object.fromEntries(tabs.map(tab => [tab, 'cli'])),
  })]);
}

/** Where the docked chat is on screen, with alpha in front. */
const CHAT_PAGE = '/#/workspaces/alpha/chat';

test.beforeEach(async ({ page }) => {
  requests = [];
  polls = 0;
  answerDelayMs = 0;
  await page.route('**/api/terminals/bootstrap', route => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', route => route.fulfill({ json: { available: true, sessions: [], targets: [] } }));
  await page.route('**/api/workspace/*/sessions', route => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', route => route.fulfill({ json: planFile() }));
  await page.route('**/api/attention?*', async route => {
    polls++;
    const wanted = new URL(route.request().url()).searchParams.get('workspaces')?.split(',') ?? [];
    const answer = { requests: requests.filter(request => wanted.includes(request.workspaceId)) };
    if (answerDelayMs > 0 && wanted.includes('gamma')) await new Promise(resolve => setTimeout(resolve, answerDelayMs));
    return route.fulfill({ json: answer });
  });
  // By default two chats are open with alpha in front. Seeded once, so a reload keeps whatever the app saved.
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify({
        openTabs: ['alpha', 'beta'], activeTab: 'alpha', modes: { alpha: 'cli', beta: 'cli' },
      }));
    }
  }, CHAT_KEY);
});

const chatOf = (page: Page) => page.getByRole('region', { name: 'CLI Chat' });
const alertsOf = (page: Page) => page.getByRole('status', { name: 'Chats waiting for you' });
/** An open chat is a session in the sidebar. While its AI waits, the row says so and shows the question. */
const session = (page: Page, branch: string) => page.locator(`aside.context-sidebar [data-sidebar-session="${branch}"]`);
const WAITING = 'Waiting for you';

test.describe('chat on screen', () => {
  test('flags the waiting chat in the sidebar, and choosing it goes there', async ({ page }) => {
    await page.goto(CHAT_PAGE);
    await expect(session(page, 'beta')).toBeVisible();
    await expect(session(page, 'beta')).not.toContainText(WAITING);

    requests.push(ask('beta', 'Which database should the migration target?'));

    // The session that needs the user says so and shows the question; the other does not.
    await expect(session(page, 'beta')).toContainText(`${WAITING}: Which database should the migration target?`, { timeout: 12_000 });
    await expect(session(page, 'alpha')).not.toContainText(WAITING);
    await expect(page).toHaveTitle(/^\(1\) /);
    // Floating cards would sit on the chat itself, so none are shown while it is open.
    await expect(alertsOf(page)).toHaveCount(0);

    await session(page, 'beta').click();

    await expect(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
    // Seen: the alerts stop. Not answered yet: the session still says so.
    await expect(page).not.toHaveTitle(/^\(\d+\) /);
    await expect(session(page, 'beta')).toContainText(WAITING);

    // Answered (the server no longer lists it): the mark goes.
    requests = [];
    await expect(session(page, 'beta')).not.toContainText(WAITING, { timeout: 12_000 });
  });

  test('does not alert for the chat the user is already looking at', async ({ page }) => {
    await page.goto(CHAT_PAGE);
    await page.bringToFront();
    await expect(session(page, 'alpha')).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.hasFocus())).toBe(true);

    requests.push(ask('alpha', 'Proceed with the rewrite?'));
    await nextPoll();
    await nextPoll();

    // No alert for what the user is looking at, but the session says the question is open until it is answered.
    await expect(session(page, 'alpha')).toContainText(`${WAITING}: Proceed with the rewrite?`);
    await expect(alertsOf(page)).toHaveCount(0);
    await expect(page).not.toHaveTitle(/^\(\d+\) /);
  });

  test('keeps the alert for the chat in front while the window is not focused, and clears it on return', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__focused = false;
      document.hasFocus = () => (window as any).__focused === true;
    });
    await page.goto(CHAT_PAGE);
    await expect(session(page, 'alpha')).toHaveAttribute('aria-current', 'page');

    requests.push(ask('alpha', 'Approve the schema change?'));

    // Nobody is looking, so the question is not seen: the window title counts it.
    await expect(page).toHaveTitle(/^\(1\) /, { timeout: 12_000 });
    await nextPoll();
    await expect(page).toHaveTitle(/^\(1\) /);

    await page.evaluate(() => {
      (window as any).__focused = true;
      window.dispatchEvent(new Event('focus'));
    });

    await expect(page).not.toHaveTitle(/^\(\d+\) /);
  });

  test('keeps showing the waiting chat while opening another chat waits on the server', async ({ page }) => {
    await page.goto(CHAT_PAGE);
    requests.push(ask('beta', 'Which database should the migration target?'));
    await expect(session(page, 'beta')).toContainText(WAITING, { timeout: 12_000 });

    // Opening a chat changes which chats are asked about; make the answer slow so a gap would show.
    answerDelayMs = 3000;
    const slowRequest = page.waitForRequest(request => /workspaces=[^&]*gamma/.test(decodeURIComponent(request.url())));
    await page.goto('/#/workspaces/gamma/chat');
    await slowRequest;
    await page.waitForTimeout(500);

    // Counted at once, not with a retrying assertion: that would wait out the slow answer and pass anyway.
    expect(await session(page, 'beta').filter({ hasText: WAITING }).count()).toBe(1);
    expect(await page.title()).toMatch(/^\(1\) /);
  });

  test('counts every waiting chat in the window title and marks each one', async ({ page }) => {
    await chatState(page, { tabs: ['alpha', 'beta', 'gamma', 'delta'] });
    await page.goto(CHAT_PAGE);
    requests.push(ask('beta', 'Question from beta'), ask('delta', 'Question from delta'));

    await expect(page).toHaveTitle(/^\(2\) /, { timeout: 12_000 });
    await expect(session(page, 'beta')).toContainText('Question from beta');
    await expect(session(page, 'delta')).toContainText('Question from delta');
    await expect(session(page, 'gamma')).not.toContainText(WAITING);
  });
});

test.describe('chat off screen', () => {
  test('shows a card with the question, and Open chat opens that chat', async ({ page }) => {
    await chatState(page);
    await page.goto('/#/overview');
    await expect(chatOf(page)).toBeHidden();

    requests.push(ask('beta', 'Which database should the migration target?'));

    const alerts = alertsOf(page);
    await expect(alerts).toContainText('beta is waiting for you', { timeout: 12_000 });
    await expect(alerts).toContainText('Which database should the migration target?');
    await expect(alerts).toContainText('Claude Code');
    await expect(page).toHaveTitle(/^\(1\) /);

    await alerts.getByRole('button', { name: 'Open chat' }).click();

    const chat = chatOf(page);
    await expect(chat).toBeVisible();
    await expect(session(page, 'beta')).toHaveAttribute('aria-current', 'page');
    await expect(alerts).toHaveCount(0);
    await expect(page).not.toHaveTitle(/^\(\d+\) /);
  });

  test('puts back only a window title it set itself', async ({ page }) => {
    await chatState(page);
    await page.goto('/#/overview');
    requests.push(ask('beta', 'Ready?'));
    await expect(page).toHaveTitle(/^\(1\) /, { timeout: 12_000 });

    // Something else renames the window while the alert is up.
    await page.evaluate(() => { document.title = 'Renamed elsewhere'; });
    await alertsOf(page).getByRole('button', { name: 'Dismiss the alert for beta' }).click();

    await expect(alertsOf(page)).toHaveCount(0);
    await expect(page).toHaveTitle('Renamed elsewhere');
  });

  test('a dismissed alert stays dismissed after a reload, and a new question raises it again', async ({ page }) => {
    await chatState(page);
    await page.goto('/#/overview');
    requests.push(ask('beta', 'First question?', 'q1'));
    await expect(alertsOf(page)).toContainText('beta is waiting for you', { timeout: 12_000 });

    await alertsOf(page).getByRole('button', { name: 'Dismiss the alert for beta' }).click();
    await expect(alertsOf(page)).toHaveCount(0);

    await page.reload();
    await nextPoll();
    await expect(chatOf(page)).toBeHidden();
    await expect(alertsOf(page)).toHaveCount(0);

    requests = [ask('beta', 'Second question?', 'q2')];
    await expect(alertsOf(page)).toContainText('Second question?', { timeout: 12_000 });
  });

  test('shows the agent text as plain text', async ({ page }) => {
    await chatState(page);
    await page.goto('/#/overview');
    requests.push(ask('beta', '<img src=x onerror="window.__pwned=1"> **not bold** <script>window.__pwned=2</script>'));

    const alerts = alertsOf(page);
    await expect(alerts).toContainText('**not bold**', { timeout: 12_000 });
    await expect(alerts).toContainText('<img src=x onerror="window.__pwned=1">');
    await expect(alerts.locator('img, script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  });

  test('lists at most four cards and says how many more are waiting', async ({ page }) => {
    await chatState(page, { tabs: names });
    await page.goto('/#/overview');
    requests.push(...names.map(name => ask(name, `Question from ${name}`)));

    const alerts = alertsOf(page);
    await expect(alerts.getByRole('button', { name: 'Open chat' })).toHaveCount(4, { timeout: 12_000 });
    await expect(alerts).toContainText('1 more chat is waiting');
    await expect(page).toHaveTitle(/^\(5\) /);
  });
});
