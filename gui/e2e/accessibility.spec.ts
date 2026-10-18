import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { planFile } from './planData';

/**
 * Automated WCAG 2.2 AA checks for the primary journey (setup → new work →
 * workspace → plan → changes) in both themes. Automated rules cover names,
 * roles, contrast and structure; keyboard and screen-reader behaviour is
 * checked by the journey tests and manually. This is not a conformance claim.
 */
const workspace = {
  id: 'demo', branchName: 'demo', name: 'Invoice speed-up', description: 'Make invoice totals load under a second',
  repos: ['/dev/api'], assistants: ['claude'], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z',
};

async function mockWorkspace(page: Page) {
  const lifecycle = { workspaceId: 'demo', flowType: 'feature', revision: 0, updatedAt: '', fleet: [], steps: [
    { id: 'cache', title: 'Cache invoice lookups', status: 'in_progress' },
  ] };
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
  await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle, report: { overallStatus: 'fail', canProgress: false, durationMs: 900, repos: [] } } }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: {
    guidance: { version: 1, revision: 0, workType: 'feature', size: 'standard', documents: [], assignment: { stage: 'implement', objective: 'Cache lookups', expectedOutput: '', stopCondition: '' } },
    lifecycle, sharedDocuments: [], assignment: '',
  } }));
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [{ repoName: 'api', repoPath: '/dev/api', files: [{ file: 'cache.ts', type: 'modified', additions: 4, deletions: 1 }] }] } }));
}

/**
 * The CLI chat on the demo workspace with the Where Are We strip showing every state at once: a question,
 * a blocked, a reopened, a finished and an unstarted milestone, a failing check, an AI proposal and a
 * suggested next step. Every colour the strip uses is on screen, so axe sees all of them.
 */
async function mockChatStrip(page: Page) {
  const terminal = { id: '0199a213-81c0-7800-8aa1-bbab2a035a50', workspace: 'demo', target: 'shell', label: 'bash', cwd: workspace.workspacePath, state: 'running' };
  const milestone = (id: string, title: string, state: string, extra: Record<string, unknown> = {}) => ({ id, title, state, verified: false, reopenCount: 0, waitingOn: [], ...extra });
  const milestones = [
    milestone('a', 'Cache invoice lookups', 'done', { verified: true, completedAt: '2026-10-02T09:00:00.000Z' }),
    milestone('b', 'Index the invoice table', 'reopened', { reopen: { at: '2026-10-02T11:00:00.000Z', reason: 'Misses the expiry case', by: 'user' }, reopenCount: 1 }),
    milestone('c', 'Call the billing API', 'blocked', { blockedReason: 'Waiting for an API key' }),
    milestone('d', 'Add cache tests', 'in_progress'),
    milestone('e', 'Document the cache', 'upcoming', { waitingOn: ['d'] }),
  ];
  const frame = (type: string, body: Record<string, unknown>, id: string) => `event: ${type}\nid: ${id}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
  const events = frame('screen', { event: { id: 'n1', timestamp: '2026-10-02T11:30:00.000Z', harness: 'claude', event: 'next', payload: { title: 'Cover the cache', reason: 'It has no tests' } } }, '2026-10-02T11:30:00.000Z')
    + frame('screen', { event: { id: 'p1', timestamp: '2026-10-02T11:40:00.000Z', harness: 'claude', event: 'milestone_proposal', payload: { stepId: 'a', proposal: 'reopen', reason: 'The expiry case is not covered' } } }, '2026-10-02T11:40:00.000Z');
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/demo/status', (route) => route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  // The same shell as a running terminal: a running session shows beside the plan.
  await page.route('**/api/terminals/running', (route) => route.fulfill({ json: { sessions: [{ ...terminal, startedAt: '2026-10-02T09:00:00.000Z', attached: true }] } }));
  await page.route('**/api/workspace/demo/progress-facts', (route) => route.fulfill({ json: { facts: {
    workspaceId: 'demo', generatedAt: '2026-10-02T12:00:00.000Z', milestones, currentMilestoneId: 'd',
    counts: { total: 5, done: 1, inProgress: 1, reopened: 1, blocked: 1, upcoming: 1 },
    openQuestions: [{ id: 'q1', timestamp: '2026-10-02T11:00:00.000Z', harness: 'claude', message: 'Which cache backend should we use?', options: ['Redis', 'In memory'] }],
    changes: { repos: [{ repoName: 'api', files: 1, additions: 4, deletions: 1 }], files: 1, additions: 4, deletions: 1 },
    verification: { status: 'fail', freshness: 'fresh', verifiedAt: '2026-10-02T11:00:00.000Z' }, unavailable: [],
  } } }));
  await page.route('**/api/workspace/demo/screen-events**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: events }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      if (JSON.parse(String(message)).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
}

/**
 * Opens the chat on the demo workspace, then the strip's panel, and checks the whole page with axe in both
 * states: the docked chat with the strip above the terminal, then the strip's panel open.
 */
/** The chat in the centre with a part open beside it: the header row, the chat's strip, the divider and the panel. */
async function checkChatBeside(page: Page, label: string) {
  // Beside, over the specs' default of hidden, once per tab.
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('layout-seeded')) { localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 62 })); sessionStorage.setItem('layout-seeded', '1'); }
    } catch { /* Storage can be unavailable. */ }
  });
  await mockWorkspace(page);
  await mockChatStrip(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/workspaces/demo/plan');
  await expect(page.getByRole('region', { name: 'Where are we', exact: true })).toContainText('Needs you');
  await expect(page.getByRole('separator', { name: 'Resize the chat' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Goal', exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, `${label} chat beside the plan`);
  await page.goto('/#/workspaces/demo/changes');
  await expect(page.getByRole('separator', { name: 'Resize the chat' })).toBeVisible();
  await expectNoSeriousViolations(page, `${label} chat beside the changes`);
}

async function checkChatStrip(page: Page, label: string) {
  await mockWorkspace(page);
  await mockChatStrip(page);
  // The AI in the demo chat waits on a question, so the sidebar shows it in amber, which is checked too.
  await page.route('**/api/attention?*', (route) => route.fulfill({ json: { requests: [
    { workspaceId: 'demo', id: 'q1', timestamp: '2026-10-02T11:00:00.000Z', harness: 'claude', message: 'Which cache backend should we use?', options: ['Redis', 'In memory'] },
  ] } }));
  // A CLI at work, so the open session's live marker is checked too.
  await page.route('**/api/terminals/running', (route) => route.fulfill({ json: { sessions: [{
    id: 't1', workspace: 'demo', target: 'claude', label: 'Claude Code', cwd: '/dev/demo', state: 'running', attached: true,
    startedAt: new Date(Date.now() - 60_000).toISOString(), lastOutputAt: new Date().toISOString(),
  }] } }));
  await page.goto('/#/workspaces/demo/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const strip = page.getByRole('region', { name: 'Where are we', exact: true });
  await expect(strip).toContainText('Needs you');
  await expect(strip.getByRole('button', { name: /^Next: / })).toBeVisible();
  await expect(page.getByRole('group', { name: 'The AI is waiting for your answer' })).toBeVisible();
  const openSession = page.locator('aside.context-sidebar [data-sidebar-session="demo"]');
  await expect(openSession.locator('.live-dot')).toHaveAttribute('data-state', 'waiting');
  await expect(openSession.getByText('Which cache backend should we use?')).toBeVisible();
  await expectNoSeriousViolations(page, `${label} strip`);
  await strip.getByRole('button', { expanded: false }).click();
  const detail = page.getByRole('region', { name: 'Progress details' });
  await expect(detail.getByText('The AI suggests reopening this')).toBeVisible();
  await expect(detail.getByText('Waiting for an API key').first()).toBeVisible();
  await expectNoSeriousViolations(page, `${label} strip panel`);
  // The open session in the sidebar, with its row actions showing.
  await page.keyboard.press('Escape');
  await openSession.hover();
  await expect(page.locator('aside.context-sidebar').getByRole('button', { name: /^Close session/ })).toHaveCSS('opacity', '1');
  await expectNoSeriousViolations(page, `${label} open session`);
}

/** A workspace chat with no CLI yet: the tool buttons and the saved conversations under them. */
async function checkStartScreen(page: Page, label: string) {
  await mockWorkspace(page);
  await mockChatStrip(page);
  await page.route('**/api/terminals/demo/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [
    { id: 'claude', name: 'Claude Code', available: true, reason: null }, { id: 'codex', name: 'Codex', available: true, reason: null }, { id: 'shell', name: 'Shell', available: true, reason: null },
  ] } }));
  await page.route('**/api/workspace/demo/sessions*', (route) => route.fulfill({ json: { sessions: [{
    id: '0199a213-81c0-7800-8aa1-bbab2a035a50', assistant: 'claude', title: 'Cache the invoice lookups', threadKind: 'main', workspacePath: '/dev/demo',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', messageCount: 12,
  }] } }));
  await page.goto('/#/workspaces/demo/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  await expect(chat.getByRole('group', { name: 'CLI tools' }).getByRole('button')).toHaveCount(3);
  await expect(chat.getByRole('region', { name: 'Continue a conversation' }).getByTestId('resume-session-row')).toHaveCount(1);
  await expectNoSeriousViolations(page, `${label} chat start screen`);
}

async function expectNoSeriousViolations(page: Page, label: string, scope?: string) {
  // Measure settled colours: a fade or an enabled/disabled transition caught
  // mid-way reports a contrast no user sees.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  const results = await (scope ? builder.include(scope) : builder)
    // Third-party code editors and terminals manage their own accessibility tree.
    .exclude('.monaco-editor')
    .exclude('.xterm')
    .analyze();
  const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  const summary = serious.map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.failureSummary?.split('\n').slice(1, 2).join('') ?? ''} ${node.html.slice(0, 120)}`).join(' | ')}`);
  expect(summary, `${label}: ${summary.join('\n')}`).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({
      colorScheme,
      workspacesData: [workspace],
      workspacesStatusData: { demo: { id: 'demo', branchName: 'demo', changedFiles: 1, dirtyRepos: 1, syncStatus: 'up-to-date', runningServices: 0 } },
      reposData: { data: [{ name: 'api', path: '/dev/api', defaultBranch: 'main' }] },
    });

    test('first-run setup', async ({ page }) => {
      await page.route('**/api/config', (route) => route.fulfill({ json: {
        exists: false, platform: 'linux', suggested: { devDir: '/home/me/dev', workspacesDir: '/home/me/dev/workspaces' },
        config: { version: '1.0.0', devDir: '', workspacesDir: '', defaultAssistant: null, scanDepth: 2 },
      } }));
      await page.route('**/api/config/validate', (route) => route.fulfill({ json: {
        ok: false,
        devDir: { path: '/home/me/dev', status: 'ok', message: '', repoCount: 1 },
        workspacesDir: { path: '/home/me/dev/workspaces', status: 'not-writable', message: "ContextSpace can't create workspaces here. Choose a folder you can write to." },
      } }));
      await page.goto('/');
      await expect(page.getByText("can't create workspaces here")).toBeVisible();
      await expectNoSeriousViolations(page, 'setup');
    });

    test('overview and new work', async ({ page }) => {
      await page.goto('/#/overview');
      await expect(page.getByRole('main')).toBeVisible();
      await expectNoSeriousViolations(page, 'overview');
      await page.goto('/#/new');
      await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
      await expectNoSeriousViolations(page, 'new work');
    });

    test('workspace destinations', async ({ page }) => {
      await mockWorkspace(page);
      for (const section of ['overview', 'plan', 'documents', 'changes']) {
        await page.goto(`/#/workspaces/demo/${section}`);
        await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
        await expect(page.getByRole('group', { name: 'Task status' })).toContainText('Checks failed');
        if (section === 'documents') await expect(page.getByText('No documents in the workspace root yet.', { exact: false })).toBeVisible();
        await expectNoSeriousViolations(page, `workspace ${section}`);
      }
    });

    test('chat with the Where Are We strip', async ({ page }) => {
      await checkChatStrip(page, `${colorScheme} chat`);
    });

    test('chat with a part open beside it', async ({ page }) => {
      await checkChatBeside(page, `${colorScheme}`);
    });

    test('chat start screen', async ({ page }) => {
      await checkStartScreen(page, `${colorScheme}`);
    });
  });
}

// The Dusk palette has its own surfaces, so axe checks them in both themes. Its tokens are also
// checked against WCAG ratios in src/features/progress/paletteContrast.test.ts.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`dusk palette, ${colorScheme} theme`, () => {
    test.use({
      colorScheme,
      workspacesData: [workspace],
      workspacesStatusData: { demo: { id: 'demo', branchName: 'demo', changedFiles: 1, dirtyRepos: 1, syncStatus: 'up-to-date', runningServices: 0 } },
      reposData: { data: [{ name: 'api', path: '/dev/api', defaultBranch: 'main' }] },
    });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        try { localStorage.setItem('contextspace-color-theme', 'dusk'); } catch { /* Storage can be unavailable. */ }
      });
    });

    test('is applied before first paint and keeps the app icon', async ({ page }) => {
      await page.goto('/#/overview');
      await expect(page.getByRole('main')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.dataset.colorTheme)).toBe('dusk');
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(colorScheme === 'dark');
      expect(await page.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute('href'))).toBe('/favicon.svg');
    });

    test('overview and new work', async ({ page }) => {
      await page.goto('/#/overview');
      await expect(page.getByRole('main')).toBeVisible();
      await expectNoSeriousViolations(page, `dusk ${colorScheme} overview`);
      await page.goto('/#/new');
      await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
      await expectNoSeriousViolations(page, `dusk ${colorScheme} new work`);
    });

    test('workspace destinations', async ({ page }) => {
      await mockWorkspace(page);
      for (const section of ['overview', 'plan', 'changes']) {
        await page.goto(`/#/workspaces/demo/${section}`);
        await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
        await expectNoSeriousViolations(page, `dusk ${colorScheme} workspace ${section}`);
      }
    });

    test('chat with the Where Are We strip', async ({ page }) => {
      await checkChatStrip(page, `dusk ${colorScheme} chat`);
    });

    test('chat with a part open beside it', async ({ page }) => {
      await checkChatBeside(page, `dusk ${colorScheme}`);
    });

    test('chat start screen', async ({ page }) => {
      await checkStartScreen(page, `dusk ${colorScheme}`);
    });
  });
}

test.describe('constrained windows', () => {
  test.use({ workspacesData: [workspace], viewport: { width: 900, height: 800 } });

  test('keep the task in view at 900×800 without horizontal scrolling', async ({ page }) => {
    await mockWorkspace(page);
    await page.goto('/#/workspaces/demo/plan');
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    // The sidebar starts as a rail, leaving the content most of the width.
    const main = await page.getByRole('main').boundingBox();
    expect(main!.width).toBeGreaterThanOrEqual(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
    for (const name of ['Plan', 'Code', 'Docs', 'Services']) {
      await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: new RegExp(`^${name}`) })).toBeInViewport();
    }
    // The rail still expands on request, by keyboard.
    await page.getByRole('button', { name: /Expand/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /^Collapse/ })).toBeVisible();
  });

  test('keep the full sidebar in a 1024-wide window', async ({ page }) => {
    // Windows CI clamps the desktop window to a 1024×768 screen; the rail is only for narrower windows.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/#/overview');
    await expect(page.getByText('ContextSpace', { exact: true }).first()).toBeVisible();
  });

  test('keep primary actions reachable at 200% zoom (720 CSS pixels)', async ({ page }) => {
    // 200% zoom of a 1440-wide window leaves 720 CSS pixels.
    await page.setViewportSize({ width: 720, height: 525 });
    await mockWorkspace(page);
    await page.goto('/#/workspaces/demo/overview');
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720);
    const nav = page.getByRole('navigation', { name: 'Workspace' });
    await nav.getByRole('link', { name: 'Services' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/services$/);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });
});
