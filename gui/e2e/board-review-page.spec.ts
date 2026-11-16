import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { board, minutesAgo, PING, stepIntoArea, STREAM_HEAD, workspace, workspaceNav } from './boardHelpers';
import { boardFile, boardFileCard, boardNote, checkpoint, planFile, step, whatsNew } from './planData';

const wsAlpha = workspace;
const wsBeta = { ...workspace, id: 'beta', branchName: 'beta', name: 'Beta workspace', workspacePath: '/tmp/beta' };

test.use({ workspacesData: [[wsAlpha, wsBeta], { option: true }] });

const CHANGES = [
  {
    repoName: 'api',
    repoPath: '/tmp/demo/api',
    files: [
      { file: 'src/server/handler.ts', type: 'modified', additions: 14, deletions: 3 },
      { file: 'src/server/routes.ts', type: 'modified', additions: 5, deletions: 1 },
      { file: 'README.md', type: 'added', additions: 20, deletions: 0 },
    ],
  },
];

const DIFF = [
  'diff --git a/src/server/handler.ts b/src/server/handler.ts',
  '--- a/src/server/handler.ts',
  '+++ b/src/server/handler.ts',
  '@@ -1,2 +1,4 @@',
  ' export const ok = true;',
  '+export const reviewed = true;',
  '+export const clean = true;',
].join('\n') + '\n';

const COMMIT_DETAIL = {
  sha: 'a91f2e0c4d5b1111222233334444555566667777',
  shortSha: 'a91f2e0',
  author: 'Anna',
  subject: 'Write the CSV writer',
  body: 'Streams CSV rows incrementally.',
  at: minutesAgo(30),
  repo: 'api',
  pushed: false,
  url: null,
  files: [{ path: 'src/server/handler.ts', status: 'modified', additions: 14, deletions: 3 }],
  additions: 14,
  deletions: 3,
};

async function routeReviewWorkspace(page: Page, options: {
  ws?: typeof wsAlpha;
  areaTitle?: string;
  changes?: typeof CHANGES;
  delayedDiff?: { wait: Promise<void> };
} = {}) {
  const target = options.ws ?? wsAlpha;
  const id = target.branchName;
  const areaTitle = options.areaTitle ?? 'Reports export to CSV';
  const changed = options.changes ?? CHANGES;

  await page.route(`**/api/workspace/${id}/plan`, (route) => route.fulfill({
    json: planFile({
      now: { key: 'background-job-queue-for-large-exports', by: 'claude', at: new Date().toISOString() },
      title: 'Reports CSV export',
      checkpoints: [
        checkpoint('Report rows load fast', { done: true, steps: [step('Query the report rows', true)] }),
        checkpoint(areaTitle, {
          steps: [
            step(`Write the CSV writer (${COMMIT_DETAIL.shortSha})`, true),
            step('Background job queue for large exports'),
          ],
          decisions: [],
        }),
      ],
    }),
  }));
  await page.route(`**/api/workspace/${id}/work`, (route) => route.fulfill({
    json: {
      guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] },
      lifecycle: null,
      assignment: '',
      sharedDocuments: [],
    },
  }));
  await page.route(`**/api/workspace/${id}/news`, (route) => route.fulfill({
    json: whatsNew({
      commits: [{ repo: 'api', more: 0, commits: [{ sha: COMMIT_DETAIL.sha, author: COMMIT_DETAIL.author, subject: COMMIT_DETAIL.subject, at: COMMIT_DETAIL.at }] }],
    }),
  }));
  await page.route(`**/api/workspace/${id}/board`, (route) => route.fulfill({
    json: boardFile({ cards: [boardNote(1, { title: 'Export note' }), boardFileCard(2, 'docs/guide.md', { title: 'Export guide' })] }),
  }));
  await page.route(`**/api/workspace/${id}/documents/preview?*`, (route) => route.fulfill({
    json: { name: 'docs/guide.md', kind: 'markdown', content: '# Export guide\n\nSee implementation.', size: 32, modifiedAt: new Date().toISOString() },
  }));
  await page.route(`**/api/workspace/${id}/changes`, (route) => route.fulfill({ json: { changes: changed } }));
  await page.route(`**/api/workspace/${id}/changes?*`, (route) => route.fulfill({ json: { changes: changed } }));
  await page.route(`**/api/workspace/${id}/changes/symbols`, (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route(`**/api/workspace/${id}/changes/diff?*`, async (route) => {
    if (options.delayedDiff) await options.delayedDiff.wait;
    const file = new URL(route.request().url()).searchParams.get('file') ?? '';
    await route.fulfill({ json: { diff: DIFF, fileContent: `// ${file}\nexport const reviewed = true;\n`, originalContent: `// ${file}\n` } });
  });
  await page.route(`**/api/workspace/${id}/recent-commits`, (route) => route.fulfill({
    json: { at: new Date().toISOString(), from: new Date(Date.now() - 86_400_000).toISOString(), commits: [{ repo: 'api', commits: [COMMIT_DETAIL] }] },
  }));
  await page.route(`**/api/workspace/${id}/commits/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/diff')) {
      return route.fulfill({ json: { repo: 'api', repoPath: '/tmp/demo/api', sha: COMMIT_DETAIL.sha, file: 'src/server/handler.ts', diff: DIFF, fileContent: 'export const reviewed = true;\n', originalContent: '', symbols: [] } });
    }
    return route.fulfill({ json: COMMIT_DETAIL });
  });
}

const reviewRegion = (page: Page) => page.getByRole('region', { name: 'Review', exact: true });
const reviewToolbar = (page: Page) => page.getByRole('toolbar', { name: 'Review', exact: true });
const backToBoardButton = (page: Page) => reviewRegion(page).getByRole('button', { name: 'Back to the Board', exact: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window === window.top) window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
  });
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: false, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/screen-events**', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: STREAM_HEAD + PING }));
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    return route.fulfill({ status: 500, json: { error: 'Writes blocked in RV1 spec' } });
  });
});

test.describe('full-frame sizing, chrome and naming across viewports', () => {
  for (const layout of [
    { name: '1440x900 Board', width: 1440, height: 900, split: false },
    { name: '1280x800 Split', width: 1280, height: 800, split: true },
    { name: '1100x700 Split', width: 1100, height: 700, split: true },
    { name: '420x800 pane', width: 420, height: 800, split: false },
  ]) {
    test(`fills the workspace area cleanly with no fullscreen/close cross and one non-wrapping top bar at ${layout.name}`, async ({ page }) => {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      if (layout.split) {
        await page.addInitScript(() => {
          if (window === window.top) localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 55 }));
        });
      }
      await routeReviewWorkspace(page);
      await page.goto('/#/workspaces/demo/board');

      const reviewBtn = page.getByRole('button', { name: 'Review, 3 files changed', exact: true });
      await expect(reviewBtn).toBeVisible();
      await expect(reviewBtn).toContainText('Review');
      await expect(page.getByRole('region', { name: 'Review', exact: true })).toHaveCount(0);

      await reviewBtn.click();
      const review = reviewRegion(page);
      await expect(review).toBeVisible();

      // Fills cover space completely with zero border/radius/shadow and leaves WorkspaceHeader uncovered above
      const metrics = await page.evaluate(() => {
        const panel = document.querySelector('[data-code-window]') as HTMLElement | null;
        const header = document.querySelector('header') as HTMLElement | null;
        if (!panel) return null;
        const p = panel.getBoundingClientRect();
        const h = header?.getBoundingClientRect();
        const style = getComputedStyle(panel);
        const toolbar = panel.querySelector('[role="toolbar"]') as HTMLElement | null;
        const tBox = toolbar?.getBoundingClientRect();
        const buttons = Array.from(toolbar?.querySelectorAll('button') ?? []).filter((b) => getComputedStyle(b).display !== 'none');
        const nestedButtons = toolbar?.querySelectorAll('button button').length ?? 0;
        const buttonMetrics = buttons.map((b) => {
          const r = b.getBoundingClientRect();
          const bs = getComputedStyle(b);
          return { text: b.textContent?.trim() ?? '', height: r.height, top: r.top, bottom: r.bottom, fontSize: parseFloat(bs.fontSize), visible: r.width > 0 && r.height > 0 };
        });
        return {
          p,
          headerBottom: h?.bottom ?? 0,
          winW: window.innerWidth,
          borderRadius: style.borderRadius,
          borderTopWidth: style.borderTopWidth,
          boxShadow: style.boxShadow,
          toolbarHeight: tBox?.height ?? 0,
          toolbarScrollW: toolbar?.scrollWidth ?? 0,
          toolbarClientW: toolbar?.clientWidth ?? 0,
          nestedButtons,
          buttonMetrics,
        };
      });

      expect(metrics).not.toBeNull();
      expect(metrics!.p.top).toBeGreaterThanOrEqual(metrics!.headerBottom - 1);
      expect(metrics!.p.left + metrics!.p.width).toBeGreaterThanOrEqual(metrics!.winW - (layout.width >= 768 ? 60 : 2));
      expect(metrics!.borderRadius).toBe('0px');
      expect(metrics!.borderTopWidth).toBe('0px');
      expect(metrics!.boxShadow).toBe('none');
      expect(metrics!.toolbarHeight).toBeLessThanOrEqual(48);
      expect(metrics!.toolbarScrollW).toBeLessThanOrEqual(metrics!.toolbarClientW + 1);
      expect(metrics!.nestedButtons).toBe(0);
      for (const btn of metrics!.buttonMetrics) {
        if (!btn.visible) continue;
        expect(btn.height).toBeGreaterThanOrEqual(24);
        expect(btn.fontSize).toBeGreaterThanOrEqual(12);
      }

      // No Full screen, Exit full screen, or old X Close button
      await expect(review.getByRole('button', { name: 'Full screen' })).toHaveCount(0);
      await expect(review.getByRole('button', { name: 'Exit full screen' })).toHaveCount(0);
      await expect(review.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);

      // Left "← Board" button with accessible name "Back to the Board"
      const backBtn = backToBoardButton(page);
      await expect(backBtn).toBeVisible();
      await expect(backBtn).toContainText('Board');
      if (layout.width >= 1100) {
        await expect(backBtn.locator('kbd')).toHaveText('Esc');
      }

      // Mode buttons ordered: Not committed · Commits · Files
      const group = reviewToolbar(page).getByRole('group', { name: 'Show' });
      const labels = await group.locator('button').allInnerTexts();
      expect(labels.map((t) => t.replace(/\d+/g, '').trim())).toEqual(['Not committed', 'Commits', 'Files']);
      if (layout.width >= 1100) {
        await expect(group.getByRole('button', { name: /Not committed/ })).toContainText('3');
      }

      // Double clicking toolbar does not resize or toggle anything
      const before = await review.boundingBox();
      await reviewToolbar(page).dblclick({ position: { x: Math.min(200, Math.floor(before!.width / 2)), y: 12 } });
      await expect(review).toBeVisible();
      const after = await review.boundingBox();
      expect(after!.width).toBeCloseTo(before!.width, 1);
      expect(after!.height).toBeCloseTo(before!.height, 1);
    });
  }
});

test('shows Area name in breadcrumb when opened inside an Area (truncated with ellipsis) and omits it from Overview', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const longArea = 'Investigate why the nightly pipeline fails when twenty workers compete';
  await routeReviewWorkspace(page, { areaTitle: longArea });
  await page.goto('/#/workspaces/demo/board');

  // From Overview: Board > Review (no Area)
  await page.getByRole('button', { name: 'Review, 3 files changed' }).click();
  const toolbar = reviewToolbar(page);
  const crumbOverview = toolbar.getByTestId('review-breadcrumb');
  await expect(crumbOverview).toBeVisible();
  await expect(crumbOverview).toContainText('Board');
  await expect(crumbOverview).toContainText('Review');
  await expect(crumbOverview).not.toContainText(longArea);
  await backToBoardButton(page).click();
  await expect(reviewRegion(page)).toBeHidden();

  // From Area (uncommitted card & commit card & Review button): Board > <Area> > Review
  await stepIntoArea(page, new RegExp(longArea.slice(0, 20)));
  const uncommitted = board(page).locator('#board-area').getByRole('button', { name: /Open 3 files changed in Review/ });
  await expect(uncommitted).toBeVisible();
  await uncommitted.click();

  const crumbArea = reviewToolbar(page).getByTestId('review-breadcrumb');
  await expect(crumbArea).toBeVisible();
  await expect(crumbArea).toContainText(longArea);
  await expect(crumbArea).toContainText('Review');
  const overflowStyle = await crumbArea.evaluate((el) => {
    const target = el.querySelector<HTMLElement>('.truncate') ?? el;
    const s = getComputedStyle(target);
    return { textOverflow: s.textOverflow, whiteSpace: s.whiteSpace, overflow: s.overflow, truncated: target.scrollWidth > target.clientWidth };
  });
  expect(overflowStyle.whiteSpace).toBe('nowrap');
  expect(overflowStyle.textOverflow).toBe('ellipsis');
  expect(overflowStyle.truncated).toBe(true);
});

test('← Board, Escape and browser Back close Review, preserve Area/Reader/transform/focus, and manage history strictly', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeReviewWorkspace(page);

  // Start at overview so history has [overview] before board
  await page.goto('/#/workspaces/demo/overview');
  await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
  await stepIntoArea(page, /Reports export to CSV/);

  // Open Reader on a file card inside the Area and follow a code link from inside it: Reader stays open behind Review!
  await page.route('**/api/workspace/demo/files/reference?*', (route) => {
    const file = new URL(route.request().url()).searchParams.get('path') ?? '';
    return route.fulfill({
      json: file === 'src/server/handler.ts'
        ? { status: 'found', target: { origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/demo/api' }, file, viewer: 'code' } }
        : { status: 'not-found', reason: 'missing' },
    });
  });
  await page.unroute('**/api/workspace/demo/documents/preview?*');
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({
    json: { name: 'docs/guide.md', kind: 'markdown', content: '# Export guide\n\nSee [handler](../src/server/handler.ts).\n', size: 48, modifiedAt: new Date().toISOString() },
  }));
  const fileCardBtn = board(page).locator('#board-area').getByRole('button', { name: 'Open Export guide' });
  await fileCardBtn.click();
  const docReader = page.locator('[data-board-reader]');
  await expect(docReader.getByRole('heading', { name: 'Export guide', level: 1 })).toBeVisible();
  const codeLink = docReader.getByRole('link', { name: 'handler' });
  const freshLenBefore = await page.evaluate(() => window.history.length);
  await codeLink.click();
  await expect(reviewRegion(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.history.length)).toBe(freshLenBefore + 1);
  await expect(reviewToolbar(page).getByTestId('review-breadcrumb')).toContainText('Reports export to CSV');
  // "← Board" keeps Reader open behind it and returns focus to the document link
  await backToBoardButton(page).click();
  await expect(reviewRegion(page)).toBeHidden();
  await expect(docReader).toBeVisible();
  await expect(codeLink).toBeFocused();
  await docReader.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(docReader).toHaveCount(0);

  // Open a commit card via keyboard focus so we also check opener focus return
  const commitBtn = board(page).locator('#board-area').getByRole('button', { name: /Write the CSV writer/ });
  await commitBtn.focus();

  const idxBeforeOpen = await page.evaluate(() => (window.history.state as { idx?: number } | null)?.idx ?? 0);
  await page.keyboard.press('Enter');
  await expect(reviewRegion(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window.history.state as { idx?: number } | null)?.idx ?? 0)).toBe(idxBeforeOpen + 1);

  // 1) "← Board" closes Review, restores focus & Area, removes entry so subsequent Back goes to Overview (never reopens Review)
  await backToBoardButton(page).click();
  await expect(reviewRegion(page)).toBeHidden();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
  await expect(commitBtn).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/overview$/);
  await expect(reviewRegion(page)).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(reviewRegion(page)).toBeHidden();

  // Reopen -> Escape removes entry cleanly too (Area stays stepped open!)
  const areaReviewBtn = board(page).locator('#board-area header').getByRole('button', { name: /Review/ });
  await expect(areaReviewBtn).toBeVisible();
  await areaReviewBtn.focus();
  await page.keyboard.press('Enter');
  await expect(reviewRegion(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reviewRegion(page)).toBeHidden();
  await expect(areaReviewBtn).toBeFocused();
  // Pressing Back after Escape goes to overview, does NOT reopen Review
  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/overview$/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);

  // 2) Browser Back closes Review cleanly, keeping stepped Area + focus; pressing Back twice from Review stays inside workspace (lands on overview)
  await board(page).locator('#board-area header').getByRole('button', { name: /Review/ }).click();
  await expect(reviewRegion(page)).toBeVisible();

  await page.goBack();
  await expect(reviewRegion(page)).toBeHidden();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
  await expect(board(page).locator('#board-area header').getByRole('button', { name: /Review/ })).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/overview$/);
});

test('old /changes link opens Review over Board cleanly and reload closes Review without leaving reopening history', async ({ page }) => {
  await routeReviewWorkspace(page);
  await page.goto('/#/workspaces/demo/overview');
  await page.goto('/#/workspaces/demo/changes');
  await expect(reviewRegion(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);

  // Reloading while Review is open lands cleanly on Board with Review closed
  await page.reload();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(reviewRegion(page)).toBeHidden();
  await page.goBack();
  await expect(reviewRegion(page)).toHaveCount(0);
});

test('preserves drafts across close/reopen, ignores late responses after close, and never reopens across workspace switch', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    if (window === window.top) {
      window.localStorage.setItem('ctxspace_sidebar_docked_v1', 'true');
      window.localStorage.setItem('contextspace_floating_chat_v1', JSON.stringify({ openTabs: ['demo', 'beta'], activeTab: 'demo', modes: {} }));
    }
  });
  let releaseLateDiff: () => void = () => {};
  const lateDiff = new Promise<void>((resolve) => { releaseLateDiff = resolve; });
  await routeReviewWorkspace(page, { ws: wsAlpha, delayedDiff: { wait: lateDiff } });
  await routeReviewWorkspace(page, { ws: wsBeta, areaTitle: 'Beta work', changes: [] });

  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: 'Review, 3 files changed' }).click();
  const review = reviewRegion(page);
  await expect(review).toBeVisible();

  // Type draft filter and commit message while diff is still loading
  const filter = review.getByRole('searchbox', { name: 'Filter files' });
  await filter.fill('routes');
  await review.getByRole('button', { name: 'Review & commit' }).click();
  const panel = review.getByRole('region', { name: 'Review commit' });
  await panel.getByLabel('Commit message').fill('wip: preserve draft');

  // Close with ← Board while diff request is still pending; resolving it afterwards must NOT reopen Review
  await backToBoardButton(page).click();
  await expect(review).toBeHidden();
  releaseLateDiff();
  await page.waitForTimeout(100);
  await expect(review).toBeHidden();

  // Reopen preserves typed drafts
  await page.getByRole('button', { name: 'Review, 3 files changed' }).click();
  await expect(review).toBeVisible();
  await expect(filter).toHaveValue('routes');
  await expect(panel.getByLabel('Commit message')).toHaveValue('wip: preserve draft');

  // Switch workspaces with Review open -> closed in old, closed in new, Back does NOT reopen Review in old
  const sidebar = page.locator('aside.context-sidebar');
  if (!(await sidebar.isVisible())) {
    await page.getByRole('button', { name: /Show workspaces/ }).click();
  }
  await sidebar.getByRole('link', { name: /Beta workspace|\bbeta\b/i }).first().click();
  await expect(page).toHaveURL(/#\/workspaces\/beta(?:\/|$)/);
  await expect(reviewRegion(page)).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\//);
  await expect(reviewRegion(page)).toBeHidden();
});

test('Ask AI under 1000 px lands in chat with Review closed and Back returns to Board; at >= 1000 px stays on Board in Split', async ({ page }) => {
  const typed: string[] = [];
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
  });
  await routeReviewWorkspace(page);
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    const terminal = { id: `term-${id}`, workspace: id, target: 'claude', label: 'claude', cwd: `/tmp/${id}`, state: 'running' };
    return route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } });
  });
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type === 'input') typed.push(parsed.data);
      if (parsed.type !== 'attach') return;
      const terminal = { id: parsed.id, workspace: parsed.workspace, target: 'claude', label: 'claude', cwd: `/tmp/${parsed.workspace}`, state: 'running' };
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });

  // Under 1000 px: Ask AI navigates to /chat, closes Review without popping /chat, and Back returns to Board
  await page.setViewportSize({ width: 850, height: 700 });
  await page.goto('/#/workspaces/demo/chat');
  await expect(page.getByTestId('terminal-pane')).toBeVisible();
  await expect(page.getByTestId('terminal-pane').getByTestId('terminal-state')).toHaveText('Running');
  await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);

  await page.getByTestId('board-code-button').click();
  const win = reviewRegion(page);
  await expect(win).toBeVisible();
  await expect(win.locator('.monaco-diff-editor')).toBeVisible();

  await win.getByRole('button', { name: 'Ask AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask AI about this change' });
  await dialog.getByRole('textbox').fill('make it shorter');
  await dialog.getByRole('button', { name: 'Send to AI' }).click();

  await expect.poll(() => typed.join('')).toContain('make it shorter');
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
  await expect(win).toBeHidden();
  await expect(page.getByTestId('terminal-pane')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(win).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);

  // >= 1000 px (chat beside): Ask AI keeps Split on Board, closes Review, and sends to terminal
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/workspaces/demo/overview');
  await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await page.getByTestId('view-mode-split').click();
  await expect(page.getByTestId('terminal-pane').getByTestId('terminal-state')).toHaveText('Running');
  const idxBeforeReview = await page.evaluate(() => window.history.state?.idx);

  await page.getByTestId('board-code-button').click();
  await expect(win).toBeVisible();
  await expect(win.locator('.monaco-diff-editor')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    idx: window.history.state?.idx,
    hasReview: Boolean(window.history.state?.usr?.__review),
  }))).toEqual({
    idx: idxBeforeReview + 1,
    hasReview: true,
  });

  await win.getByRole('button', { name: 'Ask AI' }).click();
  await dialog.getByRole('textbox').fill('keep beside');
  await dialog.getByRole('button', { name: 'Send to AI' }).click();

  await expect.poll(() => typed.join('')).toContain('keep beside');
  await expect(win).toBeHidden();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(page.getByTestId('terminal-pane')).toBeVisible();
  await expect(page.getByTestId('board-code-button')).not.toBeFocused();
  await expect.poll(() => page.evaluate(() => ({
    idx: window.history.state?.idx,
    hasReview: Boolean((window.history.state as { usr?: { __review?: unknown } } | null)?.usr?.__review),
  }))).toEqual({ idx: idxBeforeReview, hasReview: false });
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.history.state?.idx)).toBe(idxBeforeReview - 1);
  await expect(win).toBeHidden();
});

test('leaving Review by Terminal button, Ctrl+3, or rail link closes Review and retires its history entry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeReviewWorkspace(page);
  await page.goto('/#/workspaces/demo/overview');
  await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);

  const win = reviewRegion(page);

  // 1) WorkspaceHeader Terminal button
  await page.getByTestId('board-code-button').click();
  await expect(win).toBeVisible();
  await page.getByTestId('view-mode-terminal').click();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
  await expect(win).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(win).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);

  // 2) Ctrl+3 shortcut
  await page.getByTestId('board-code-button').click();
  await expect(win).toBeVisible();
  await page.keyboard.press('Control+3');
  await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
  await expect(win).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(win).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);

  // 3) Left rail link while Review is open
  await page.getByTestId('board-code-button').click();
  await expect(win).toBeVisible();
  await page.getByRole('complementary').getByRole('link', { name: /Skills & agents/ }).click();
  await expect(page).toHaveURL(/#\/skills$/);
  await expect(win).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(win).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(/#\/skills$/);
});

test('double close (double-click ← Board, fast double Escape, or Escape then ← Board) steps back once and stays on Board', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeReviewWorkspace(page);
  await page.goto('/#/workspaces/demo/overview');
  await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);

  const reviewBtn = page.getByRole('button', { name: 'Review, 3 files changed', exact: true });
  const win = reviewRegion(page);

  // 1) Double-click on ← Board before popstate settles
  await reviewBtn.focus();
  await reviewBtn.click();
  await expect(win).toBeVisible();
  await backToBoardButton(page).evaluate((btn: HTMLButtonElement) => {
    btn.click();
    btn.click();
  });
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(win).toBeHidden();
  await expect(reviewBtn).toBeFocused();

  // 2) Fast double Escape before popstate settles
  await reviewBtn.click();
  await expect(win).toBeVisible();
  await page.evaluate(() => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(win).toBeHidden();
  await expect(reviewBtn).toBeFocused();

  // 3) Escape then ← Board button before popstate settles
  await reviewBtn.click();
  await expect(win).toBeVisible();
  await page.evaluate(() => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector<HTMLButtonElement>('[aria-label="Back to the Board"]')?.click();
  });
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
  await expect(win).toBeHidden();
  await expect(reviewBtn).toBeFocused();
});

test('workspace menu calls the Review item Review with its count and opens Review', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeReviewWorkspace(page);
  await page.goto('/#/workspaces/demo/board');

  await page.getByRole('button', { name: /Workspace actions/ }).click();
  const reviewItem = page.getByRole('menuitem', { name: /^Review\s+\S+/ });
  await expect(reviewItem).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Changes\b/ })).toHaveCount(0);

  await reviewItem.click();
  await expect(reviewRegion(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
});
