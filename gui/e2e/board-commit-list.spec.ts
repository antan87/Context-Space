import { test, expect, type Page } from './fixtures';
import { boardFile, boardLink, checkpoint, planFile, step, whatsNew } from './planData';

const now = Date.now();
const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const WORKSPACE = {
  id: 'demo',
  branchName: 'demo',
  name: 'Reports CSV export',
  description: 'Add CSV export',
  repos: [],
  assistants: [],
  workspacePath: '/tmp/demo',
  createdAt: '2026-10-01T00:00:00Z',
};

const SHA_1 = '1111111222222333333444444555555666666777';
const SHA_2 = '2222222333333444444555555666666777777888';
const SHA_3 = '3333333444444555555666666777777888888999';
const SHA_4 = '4444444555555666666777777888888999999000';

const LONG_BODY = [
  'First paragraph explains the commit change clearly.',
  '',
  'Second paragraph gives architectural context for why this list exists.',
  '',
  'Third paragraph covers keyboard movement and tree focus.',
  '',
  'Fourth paragraph verifies the full text renders without folding.',
].join('\n');

const originalText = (name: string) =>
  Array.from({ length: 12 }, (_, i) => `// ${name} line ${i + 1}`).join('\n') + '\n';

const modifiedText = (name: string) => {
  const lines = originalText(name).trimEnd().split('\n');
  lines[3] = `// ${name} line 4 UPDATED`;
  return lines.join('\n') + '\n';
};

const patchFor = (name: string) => {
  const o = originalText(name).trimEnd().split('\n');
  const m = modifiedText(name).trimEnd().split('\n');
  return [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -2,5 +2,5 @@',
    ` ${o[1]}`,
    ` ${o[2]}`,
    `-${o[3]}`,
    `+${m[3]}`,
    ` ${o[4]}`,
    '',
  ].join('\n');
};

const STEP_RV1 = 'RV1: One Review page with simple navigation across modes';
const STEP_RV2 = 'RV2: One list in Commits with short step badge';
const STEP_BASE = 'BASE1: Initial workspace setup';

const DEFAULT_PLAN = planFile({
  title: 'Reports CSV export',
  checkpoints: [
    checkpoint('Reports export to CSV', {
      steps: [
        step(STEP_RV1, true),
        step(STEP_RV2, false),
      ],
    }),
    checkpoint('Baseline setup', {
      steps: [
        step(STEP_BASE, true),
      ],
    }),
  ],
});

const DETAIL_MAP = new Map<string, any>([
  [SHA_1, {
    repo: 'billing',
    sha: SHA_1,
    shortSha: SHA_1.slice(0, 7),
    author: 'Ada Lovelace',
    at: minsAgo(20),
    subject: 'feat: add interactive commit list',
    body: LONG_BODY,
    parents: [SHA_2],
    files: [
      { path: 'src/features/changes/CommitsView.tsx', status: 'modified', additions: 140, deletions: 45 },
      { path: 'src/features/changes/commitsMode.ts', status: 'modified', additions: 38, deletions: 4 },
      { path: 'src/features/changes/oldHelper.ts', status: 'deleted', additions: 0, deletions: 22 },
      { path: 'docs/diagram.png', status: 'added', additions: null, deletions: null },
    ],
    moreFiles: 0,
    additions: 178,
    deletions: 71,
    pushed: false,
    forge: null,
    webUrl: null,
  }],
  [SHA_2, {
    repo: 'billing',
    sha: SHA_2,
    shortSha: SHA_2.slice(0, 7),
    author: 'Grace Hopper',
    at: minsAgo(90),
    subject: 'refactor: tidy diff header',
    body: '',
    parents: [SHA_3],
    files: [
      { path: 'src/features/changes/CodeWindow.tsx', status: 'modified', additions: 12, deletions: 8 },
      { path: 'src/features/changes/renamedFile.ts', oldPath: 'src/features/changes/prevFile.ts', status: 'renamed', additions: 3, deletions: 1 },
    ],
    moreFiles: 0,
    additions: 15,
    deletions: 9,
    pushed: true,
    forge: 'github',
    webUrl: `https://github.com/org/billing/commit/${SHA_2}`,
  }],
  [SHA_3, {
    repo: 'billing',
    sha: SHA_3,
    shortSha: SHA_3.slice(0, 7),
    author: 'Alan Turing',
    at: minsAgo(180),
    subject: 'fix: preserve step focus',
    body: `Implements ${SHA_3.slice(0, 7)} in RV1.`,
    parents: [SHA_4],
    files: [
      { path: 'src/features/board/BoardSection.tsx', status: 'modified', additions: 10, deletions: 2 },
    ],
    moreFiles: 0,
    additions: 10,
    deletions: 2,
    pushed: true,
    forge: 'github',
    webUrl: `https://github.com/org/billing/commit/${SHA_3}`,
  }],
  [SHA_4, {
    repo: 'billing',
    sha: SHA_4,
    shortSha: SHA_4.slice(0, 7),
    author: 'Margaret Hamilton',
    at: minsAgo(5 * 24 * 60),
    subject: 'chore: earlier baseline commit',
    body: 'Not tied to the first checkpoint row.',
    parents: [],
    files: [
      { path: 'README.md', status: 'modified', additions: 4, deletions: 1 },
    ],
    moreFiles: 0,
    additions: 4,
    deletions: 1,
    pushed: true,
    forge: 'github',
    webUrl: `https://github.com/org/billing/commit/${SHA_4}`,
  }],
]);

const RECENT_LIST = [
  { sha: SHA_1.slice(0, 7), subject: 'feat: add interactive commit list', author: 'Ada Lovelace', at: minsAgo(20), pushed: false, fileCount: 4, firstBodyLine: 'First paragraph explains the commit change clearly.' },
  { sha: SHA_2.slice(0, 7), subject: 'refactor: tidy diff header', author: 'Grace Hopper', at: minsAgo(90), pushed: true, fileCount: 2 },
  { sha: SHA_3.slice(0, 7), subject: 'fix: preserve step focus', author: 'Alan Turing', at: minsAgo(180), pushed: true, fileCount: 1, firstBodyLine: `Implements ${SHA_3.slice(0, 7)} in RV1.` },
  { sha: SHA_4.slice(0, 7), subject: 'chore: earlier baseline commit', author: 'Margaret Hamilton', at: minsAgo(5 * 24 * 60), pushed: true, fileCount: 1, firstBodyLine: 'Not tied to the first checkpoint row.' },
];

test.use({ workspacesData: [[WORKSPACE], { option: true }], sidebarDocked: false });

let detailRequests: string[] = [];
let writes: string[] = [];
let recentPayload: any;
let planPayload: any;

test.beforeEach(async ({ page }) => {
  detailRequests = [];
  writes = [];
  planPayload = DEFAULT_PLAN;
  recentPayload = {
    at: new Date().toISOString(),
    from: minsAgo(4000),
    commits: [{ repo: 'billing', more: 0, commits: RECENT_LIST }],
  };

  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planPayload }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
    json: whatsNew({
      commits: [{ repo: 'billing', more: 0, commits: RECENT_LIST.slice(0, 3) }],
      empty: false,
    }),
  }));
  await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({ json: recentPayload }));

  const rv2Key = DEFAULT_PLAN.checkpoints[0]!.steps[1]!.key;
  const rv1Key = DEFAULT_PLAN.checkpoints[0]!.steps[0]!.key;
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({
    json: boardFile({
      cards: [
        { id: '00000000-0000-4000-8000-000000000001', kind: 'note', title: 'RV2 Note', body: 'Notes', pinned: false, archived: false, by: 'claude', at: minsAgo(10), updatedBy: 'claude', updatedAt: minsAgo(10), step: rv2Key },
      ],
      links: [
        boardLink(1, `commit:billing:${SHA_1.slice(0, 7)}`, '00000000-0000-4000-8000-000000000001'),
        boardLink(2, `commit:billing:${SHA_3.slice(0, 7)}`, rv1Key),
        boardLink(3, `commit:billing:${SHA_4.slice(0, 7)}`, `checkpoint:${DEFAULT_PLAN.checkpoints[1]!.key}`),
      ],
    }),
  }));

  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes?include=all', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({
    json: { repositories: [{ name: 'billing', access: 'isolated', editable: true, path: '/tmp/billing', sourcePath: '/tmp/billing', branch: 'feat/rv2', expectedBranch: 'feat/rv2', onExpectedBranch: true, baseBranch: 'main', headSha: SHA_1, dirty: false, changedFiles: [], ahead: 1, behind: 0, remoteUrl: 'git@github.com:org/billing.git' }] },
  }));

  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const url = new URL(route.request().url());
    const after = url.pathname.split('/commits/')[1] ?? '';
    if (after.endsWith('/diff')) {
      const file = url.searchParams.get('file') ?? 'unknown.ts';
      return route.fulfill({ json: { diff: patchFor(file), fileContent: modifiedText(file), originalContent: originalText(file) } });
    }
    detailRequests.push(url.pathname);
    const shaPrefix = decodeURIComponent(after.split('/')[1] ?? '');
    const found = Array.from(DETAIL_MAP.values()).find((entry) => entry.sha.startsWith(shaPrefix)) ?? DETAIL_MAP.get(SHA_1)!;
    return route.fulfill({ json: found });
  });

  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'no writes expected' } });
  });
});

test.afterEach(() => {
  expect(writes, 'unexpected write route').toEqual([]);
});

const reviewRegion = (page: Page) => page.getByRole('region', { name: 'Review', exact: true });

async function openFirstCommitFromBoard(page: Page) {
  await page.goto('/#/workspaces/demo/board');
  await page.locator('#board-overview button.board-area', { hasText: 'Reports export to CSV' }).click();
  const area = page.locator('#board-area');
  await expect(area).toBeVisible();
  const fold = area.locator('button[data-row-control^="lane:commits"]').first();
  if (await fold.getAttribute('aria-expanded') === 'false') {
    await fold.click();
  }
  await area.locator('button', { hasText: 'feat: add interactive commit list' }).click();
  await expect(reviewRegion(page)).toBeVisible();
}

test('one left list in order with single open commit, commit-first right view, and slim file flow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openFirstCommitFromBoard(page);

  const win = reviewRegion(page);
  // Old 3-arrow controls are gone
  await expect(win.getByRole('button', { name: 'Previous commit' })).toHaveCount(0);
  await expect(win.getByRole('button', { name: 'Next commit' })).toHaveCount(0);
  await expect(win.getByRole('button', { name: 'Choose a commit' })).toHaveCount(0);
  await expect(win.getByTestId('commit-position')).toHaveCount(0);
  await expect(win.getByTestId('commit-file-position')).toHaveCount(0);

  // Left tree shows all 4 commits once, held row first, then Other recent commits
  const tree = win.getByRole('tree', { name: 'Commits' });
  await expect(tree).toBeVisible();
  await expect(tree).toContainText('Other recent commits');

  const commitItems = tree.locator('[role="treeitem"][aria-expanded]');
  await expect(commitItems).toHaveCount(4);
  await expect(commitItems.nth(0)).toContainText('feat: add interactive commit list');
  await expect(commitItems.nth(0)).toContainText(`${SHA_1.slice(0, 7)}`);
  await expect(commitItems.nth(0)).toContainText('4 files');
  await expect(commitItems.nth(0)).toContainText('not pushed');
  await expect(commitItems.nth(0)).toContainText('First paragraph explains the commit change clearly.');
  await expect(commitItems.nth(0)).toHaveAttribute('aria-expanded', 'true');

  // Second commit has no description and IS pushed -> no not-pushed badge, no extra blank line
  await expect(commitItems.nth(1)).toContainText('refactor: tidy diff header');
  await expect(commitItems.nth(1)).toContainText('2 files');
  await expect(commitItems.nth(1)).not.toContainText('not pushed');
  await expect(commitItems.nth(1)).toHaveAttribute('aria-expanded', 'false');

  // Right pane opens directly on full commit description (no More button, no line-clamp-3)
  await expect(win.getByRole('heading', { level: 2, name: 'feat: add interactive commit list' })).toBeVisible();
  await expect(win.getByText('Fourth paragraph verifies the full text renders without folding.')).toBeVisible();
  await expect(win.getByRole('button', { name: 'More' })).toHaveCount(0);

  // Files listed under open commit in list: name first, folder muted, status + stats or binary
  const fileItems = tree.locator('[role="treeitem"]:not([aria-expanded])');
  await expect(fileItems).toHaveCount(4);
  await expect(fileItems.nth(0)).toContainText('CommitsView.tsx');
  await expect(fileItems.nth(0)).toContainText('src/features/changes');
  await expect(fileItems.nth(0)).toContainText('+140');
  await expect(fileItems.nth(3)).toContainText('diagram.png');
  await expect(fileItems.nth(3)).toContainText('binary');

  // Press first file from list -> slim header ("Read the description" + "file 1 of 4") and "Next file" footer
  await fileItems.nth(0).click();
  await expect(win.getByRole('button', { name: /Read the description/i })).toBeVisible();
  await expect(win).toContainText('file 1 of 4');
  await expect(win.getByRole('button', { name: /Next file:.*commitsMode\.ts/i })).toBeVisible();

  // "Read the description" returns to commit view
  await win.getByRole('button', { name: /Read the description/i }).click();
  await expect(win.getByText('Fourth paragraph verifies the full text renders without folding.')).toBeVisible();

  // Clicking a file button in the right-side files grid opens it and navigates through to Next commit
  await win.locator('[data-testid="commit-files-grid"] button', { hasText: 'diagram.png' }).click();
  await expect(win).toContainText('file 4 of 4');
  await expect(win.getByRole('button', { name: /Next commit/i })).toBeVisible();
  await win.getByRole('button', { name: /Next commit/i }).click();
  await expect(win.getByRole('heading', { level: 2, name: 'refactor: tidy diff header' })).toBeVisible();
  await expect(commitItems.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(commitItems.nth(1)).toHaveAttribute('aria-expanded', 'true');
});

test('list keyboard (arrows, Home, End) and window shortcuts ([ ], Alt+Up/Down) respect find/fields', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openFirstCommitFromBoard(page);

  const win = reviewRegion(page);
  const tree = win.getByRole('tree', { name: 'Commits' });
  await expect(win.getByTestId('commit-list-keys')).toBeVisible();

  // Focus first commit item in tree
  const firstCommit = tree.locator('[role="treeitem"][aria-expanded]').nth(0);
  await firstCommit.focus();
  await expect(firstCommit).toBeFocused();

  // ArrowLeft collapses open commit; ArrowRight opens it again; 2nd ArrowRight enters first file
  await page.keyboard.press('ArrowLeft');
  await expect(firstCommit).toHaveAttribute('aria-expanded', 'false');
  await expect(firstCommit).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(firstCommit).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(win).toContainText('file 1 of 4');
  await expect(tree.locator('[role="treeitem"]:not([aria-expanded])').nth(0)).toBeFocused();

  // ArrowDown moves to 2nd file; ArrowLeft returns to commit view
  await page.keyboard.press('ArrowDown');
  await expect(win).toContainText('file 2 of 4');
  await page.keyboard.press('ArrowLeft');
  await expect(win.getByText('Fourth paragraph verifies the full text renders without folding.')).toBeVisible();
  await expect(firstCommit).toBeFocused();

  // End and Home jump to last and first item
  await page.keyboard.press('End');
  await expect(tree.locator('[role="treeitem"]').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(firstCommit).toBeFocused();

  // Window shortcuts: ] moves to next commit, Alt+ArrowDown steps into file
  await page.keyboard.press(']');
  await expect(win.getByRole('heading', { level: 2, name: 'refactor: tidy diff header' })).toBeVisible();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(win).toContainText('file 1 of 2');

  // Window keys stand down inside editor find box (Ctrl/Meta+F opens Monaco find widget)
  const monacoArea = win.locator('.monaco-diff-editor .inputarea').first();
  if (await monacoArea.count()) {
    await monacoArea.click();
    await page.keyboard.press('ControlOrMeta+f');
    const findInput = win.locator('.find-widget textarea, .find-widget input').first();
    if (await findInput.isVisible()) {
      await findInput.focus();
      await page.keyboard.press('[');
      await expect(win).toContainText('file 1 of 2');
    }
  }
});

test('Step short label in meta row jumps to the step row on the Board and lands focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openFirstCommitFromBoard(page);

  const win = reviewRegion(page);
  const stepBtn = win.getByRole('button', { name: /Step · RV2/i });
  await expect(stepBtn).toBeVisible();
  await expect(stepBtn).toContainText('Reports export to CSV');
  await expect(stepBtn).toHaveAttribute('title', new RegExp(STEP_RV2));

  // Verify 1 line height (no wrap)
  const box = (await stepBtn.boundingBox())!;
  expect(box.height).toBeLessThan(36);

  await stepBtn.click();
  await expect(win).toHaveCount(0);
  const area = page.locator('#board-area');
  await expect(area).toBeVisible();
  await expect(area.locator(':focus')).toBeVisible();
  const focusedText = await area.locator(':focus').evaluate((el) => el.closest('.react-flow__node')?.textContent ?? el.getAttribute('aria-label') ?? '');
  expect(focusedText).toContain('RV2');
});

test('narrow 420px drawer closes when choosing a commit or a file', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await openFirstCommitFromBoard(page);

  const win = reviewRegion(page);
  const tree = win.getByRole('tree', { name: 'Commits' });
  const toggleBtn = () => win.getByRole('button', { name: /Show the (?:file tree|commit list)|Hide the (?:file tree|commit list)/i });
  if (!(await tree.isVisible())) {
    await toggleBtn().click();
  }
  await expect(tree).toBeVisible();

  // Choosing a commit closes the drawer so its description shows
  await tree.locator('[role="treeitem"][aria-expanded]').nth(1).click();
  await expect(tree).not.toBeVisible();
  await expect(win.getByRole('heading', { level: 2, name: 'refactor: tidy diff header' })).toBeVisible();

  // Reopen drawer and choose a file -> drawer closes so diff shows
  await toggleBtn().click();
  await expect(tree).toBeVisible();
  await tree.locator('[role="treeitem"]:not([aria-expanded])').nth(0).click();
  await expect(tree).not.toBeVisible();
  await expect(win).toContainText('file 1 of 2');
});

test('narrow 420px drawer: arrows keep drawer open, Enter/Space close and focus commit or diff line, Escape returns to toggle', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await openFirstCommitFromBoard(page);

  const win = reviewRegion(page);
  const tree = win.getByRole('tree', { name: 'Commits' });
  const toggleBtn = () => win.getByRole('button', { name: /Show the (?:file tree|commit list)|Hide the (?:file tree|commit list)/i });
  if (!(await tree.isVisible())) {
    await toggleBtn().click();
  }
  await expect(tree).toBeVisible();

  // Arrow keys move/collapse/expand inside the drawer without closing it
  await tree.locator('[role="treeitem"][tabindex="0"]').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tree).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(tree).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(tree).toBeVisible();

  // Enter on the (already expanded) commit closes the drawer, keeps it open in tree, and focuses its heading (never <body>)
  await page.keyboard.press('Enter');
  await expect(tree).not.toBeVisible();
  const secondHeading = win.getByRole('heading', { level: 2, name: 'refactor: tidy diff header' });
  await expect(secondHeading).toBeVisible();
  await expect(secondHeading).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  // Reopen drawer, move down to a file, press Space -> closes drawer and focuses the diff's file line
  await toggleBtn().click();
  await expect(tree).toBeVisible();
  await tree.locator('[role="treeitem"][tabindex="0"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(tree).toBeVisible();
  await page.keyboard.press('Space');
  await expect(tree).not.toBeVisible();
  await expect(win).toContainText('file 1 of 2');
  const fileLine = win.getByTitle('src/features/changes/CodeWindow.tsx');
  await expect(fileLine).toBeVisible();
  await expect(fileLine).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  // Reopen drawer, focus a treeitem, press Escape -> closes drawer (not Review) and returns focus to the drawer toggle
  await toggleBtn().click();
  await expect(tree).toBeVisible();
  const currentItem = tree.locator('[role="treeitem"][tabindex="0"]');
  await currentItem.focus();
  await expect(currentItem).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(win).toBeVisible();
  await expect(tree).not.toBeVisible();
  await expect(toggleBtn()).toBeFocused();
});

test('Board commit cards cap at 10 per repository (matching HEAD) even when recent-commits returns 15', async ({ page }) => {
  const fifteen = Array.from({ length: 15 }, (_, i) => ({
    sha: (0x5000000 + i).toString(16).padStart(7, '0'),
    subject: `feat: recent item ${i + 1}`,
    author: 'Tester',
    at: minsAgo(i + 5),
    pushed: true,
    fileCount: 1,
  }));
  recentPayload = {
    at: new Date().toISOString(),
    from: minsAgo(4000),
    commits: [{ repo: 'billing', more: 0, commits: fifteen }],
  };
  await page.unroute('**/api/workspace/demo/news');
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
    json: whatsNew({
      commits: [{ repo: 'billing', more: 5, commits: fifteen.slice(0, 10) }],
      empty: false,
    }),
  }));

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/workspaces/demo/board');
  await expect(page.locator('#board-overview').getByRole('button', { name: 'Show the 10 commits' })).toBeVisible();
  await page.locator('#board-overview button.board-area', { hasText: 'Reports export to CSV' }).click();
  const area = page.locator('#board-area');
  await expect(area).toBeVisible();
  const fold = area.locator('button[data-row-control^="lane:commits"]').first();
  if (await fold.getAttribute('aria-expanded') === 'false') {
    await fold.click();
  }
  await expect(area.locator('.react-flow__node-commit')).toHaveCount(10);
  await expect(area).toContainText('feat: recent item 10');
  await expect(area.getByText('feat: recent item 11')).toHaveCount(0);
  await expect(area.getByRole('button', { name: /billing, 15 in the last 3 days/ })).toBeVisible();
});

test('opening Review from Terminal labels Back button and breadcrumb Terminal and returns to Terminal', async ({ page }) => {
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({
    json: { available: true, sessions: [{ id: 'term-demo', workspace: 'demo', target: 'claude', label: 'claude', cwd: '/tmp/demo', state: 'running' }], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] },
  }));
  await page.route('**/api/workspace/demo/files/reference?*', (route) => route.fulfill({
    json: { status: 'found', target: { origin: { kind: 'repository', repoName: 'billing', repoPath: '/tmp/billing' }, file: 'src/features/changes/CommitsView.tsx', viewer: 'code' } },
  }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({
    json: { changes: [{ repoName: 'billing', repoPath: '/tmp/billing', files: [{ file: 'src/features/changes/CommitsView.tsx', type: 'modified', additions: 5, deletions: 2 }] }] },
  }));
  await page.route('**/api/workspace/demo/changes/diff?*', (route) => route.fulfill({
    json: { diff: patchFor('src/features/changes/CommitsView.tsx'), fileContent: modifiedText('src/features/changes/CommitsView.tsx'), originalContent: originalText('src/features/changes/CommitsView.tsx') },
  }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal: { id: parsed.id, workspace: parsed.workspace, target: 'claude', label: 'claude', cwd: '/tmp/demo', state: 'running' }, truncated: false }));
      socket.send(JSON.stringify({ type: 'output', data: 'changed src/features/changes/CommitsView.tsx\r\n' }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/workspaces/demo/chat');
  const pane = page.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  const cell = await pane.locator('.xterm-screen').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const first = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
    return { x: bounds.x + 120, y: (first?.y ?? bounds.y) + (first?.height ?? 17) * 0.5 };
  });
  await pane.locator('.xterm-helper-textarea').focus();
  await page.mouse.move(cell.x, cell.y);
  await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
  await page.mouse.click(cell.x, cell.y);

  const win = reviewRegion(page);
  await expect(win).toBeVisible();
  const backBtn = win.getByRole('button', { name: 'Back to the Terminal', exact: true });
  await expect(backBtn).toBeVisible();
  await expect(backBtn).toContainText('Terminal');
  await expect(win.getByTestId('review-breadcrumb')).toContainText('Terminal');

  await backBtn.click();
  await expect(win).toHaveCount(0);
  await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
});

test('50 commits in list cause no detail request burst, and recent/plan refetch preserves state', async ({ page }) => {
  await page.clock.install();
  const fifty = Array.from({ length: 50 }, (_, i) => ({
    sha: (0x1000000 + i).toString(16).padStart(7, '0'),
    subject: `chore: commit item ${i + 1}`,
    author: 'Tester',
    at: minsAgo(i + 1),
    pushed: i > 0,
    fileCount: (i % 4) + 1,
    firstBodyLine: i % 2 === 0 ? `Summary line for commit ${i + 1}` : undefined,
  }));
  DETAIL_MAP.set(fifty[0]!.sha, {
    repo: 'billing',
    sha: fifty[0]!.sha.padEnd(40, '0'),
    shortSha: fifty[0]!.sha,
    author: 'Tester',
    at: fifty[0]!.at,
    subject: fifty[0]!.subject,
    body: 'Summary line for commit 1\n\nFull details here.',
    parents: [],
    files: [{ path: 'src/a.ts', status: 'modified', additions: 5, deletions: 1 }],
    moreFiles: 0,
    additions: 5,
    deletions: 1,
    pushed: false,
    forge: null,
    webUrl: null,
  });
  recentPayload = { at: new Date().toISOString(), from: minsAgo(4000), commits: [{ repo: 'billing', more: 0, commits: fifty }] };

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId('board-code-button').click();
  const win = reviewRegion(page);
  await win.getByRole('button', { name: /Commits/i }).click();

  const tree = win.getByRole('tree', { name: 'Commits' });
  await expect(tree.locator('[role="treeitem"][aria-expanded]')).toHaveCount(50);
  expect(detailRequests.length, 'must only fetch selected commit detail, never 50').toBeLessThanOrEqual(2);

  // Select file, scroll list far away from selected commit, then trigger a real refetch adding a commit
  await tree.locator('[role="treeitem"]:not([aria-expanded])').first().click();
  await expect(win).toContainText('file 1 of 1');
  const scrollBefore = await tree.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight;
    return el.scrollTop;
  });
  expect(scrollBefore).toBeGreaterThan(200);
  const lastCommitItem = tree.locator('[role="treeitem"][aria-expanded]').last();
  const lastTopBefore = (await lastCommitItem.boundingBox())!.y;

  const arrived = {
    sha: '9999999',
    subject: 'feat: newly arrived commit on refetch',
    author: 'Tester',
    at: minsAgo(0),
    pushed: false,
    fileCount: 1,
  };
  recentPayload = {
    at: new Date().toISOString(),
    from: minsAgo(4000),
    commits: [{ repo: 'billing', more: 0, commits: [arrived, ...fifty] }],
  };
  const refetched = page.waitForResponse('**/api/workspace/demo/recent-commits');
  await page.clock.fastForward('02:00');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  await refetched;
  await page.clock.fastForward('00:05');

  await expect(tree.locator('[role="treeitem"][aria-expanded]')).toHaveCount(51);
  await expect(tree).toContainText('feat: newly arrived commit on refetch');
  await expect(win).toContainText('file 1 of 1');
  const scrollAfter = await tree.evaluate((el) => el.scrollTop);
  const lastTopAfter = (await lastCommitItem.boundingBox())!.y;
  expect(scrollAfter).toBeGreaterThanOrEqual(scrollBefore);
  expect(Math.abs(lastTopAfter - lastTopBefore)).toBeLessThanOrEqual(2);

  // Check geometry: >= 12px text, >= 24px controls, no nested buttons
  const audit = await win.evaluate((el) => {
    const nested = el.querySelectorAll('button button').length;
    const smallTargets: string[] = [];
    for (const btn of Array.from(el.querySelectorAll('button'))) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24)) {
        smallTargets.push(`${btn.textContent?.trim().slice(0, 20)}:${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    const tinyText: string[] = [];
    for (const node of Array.from(el.querySelectorAll('*'))) {
      const own = Array.from(node.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent?.trim() ?? '').join('');
      if (own && parseFloat(getComputedStyle(node).fontSize) < 12) {
        tinyText.push(`${own.slice(0, 20)}:${getComputedStyle(node).fontSize}`);
      }
    }
    return { nested, smallTargets, tinyText };
  });
  expect(audit.nested).toBe(0);
  expect(audit.smallTargets).toEqual([]);
  expect(audit.tinyText).toEqual([]);
});

test('narrow 420px drawer: switching to Not committed and back to Commits does not replay an earlier focus request', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await openFirstCommitFromBoard(page);

  const win = reviewRegion(page);
  const tree = win.getByRole('tree', { name: 'Commits' });
  const toggleBtn = () => win.getByRole('button', { name: /Show the (?:file tree|commit list)|Hide the (?:file tree|commit list)/i });
  if (!(await tree.isVisible())) {
    await toggleBtn().click();
  }
  await expect(tree).toBeVisible();

  await tree.locator('[role="treeitem"][tabindex="0"]').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(tree).not.toBeVisible();

  const subject = win.getByTestId('commit-subject');
  await expect(subject).toHaveText('refactor: tidy diff header');
  await expect(subject).toBeFocused();

  const showGroup = win.getByRole('group', { name: 'Show' });
  await showGroup.getByRole('button', { name: /^Not committed/ }).click();
  await expect(win.getByText('No uncommitted changes.')).toBeVisible();

  const commitsBtn = showGroup.getByRole('button', { name: 'Commits', exact: true });
  await commitsBtn.click();
  await expect(tree).toBeVisible();
  await expect(subject).not.toBeFocused();

  const focusedOnCommitsOrList = await page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return false;
    if (active.closest('[role="tree"][aria-label="Commits"]')) return true;
    return active.tagName === 'BUTTON' && active.textContent?.trim() === 'Commits';
  });
  expect(focusedOnCommitsOrList).toBe(true);
});

test('narrow 420px Not committed: auto-selecting an appearing file does not steal focus from the header Terminal button', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await openFirstCommitFromBoard(page);

  const win = reviewRegion(page);
  const showGroup = win.getByRole('group', { name: 'Show' });
  await showGroup.getByRole('button', { name: /^Not committed/ }).click();
  await expect(win.getByText('No uncommitted changes.')).toBeVisible();

  const terminalBtn = page.getByTestId('view-mode-terminal');
  await terminalBtn.focus();
  await expect(terminalBtn).toBeFocused();

  await page.unroute('**/api/workspace/demo/changes');
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({
    json: {
      changes: [{
        repoName: 'billing',
        repoPath: '/tmp/billing',
        files: [{ file: 'src/appeared.ts', type: 'modified', additions: 3, deletions: 1 }],
      }],
    },
  }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/demo/changes/diff?*', (route) => route.fulfill({
    json: {
      diff: patchFor('src/appeared.ts'),
      fileContent: modifiedText('src/appeared.ts'),
      originalContent: originalText('src/appeared.ts'),
    },
  }));

  const nextPoll = page.waitForResponse('**/api/workspace/demo/changes');
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  await nextPoll;

  await expect(win.getByTitle('billing/src/appeared.ts')).toBeVisible();
  await expect(win.locator('.monaco-diff-editor')).toBeVisible();
  await expect(terminalBtn).toBeFocused();
});
