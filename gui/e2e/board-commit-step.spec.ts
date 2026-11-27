import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, checkpoint, planFile, whatsNew } from './planData';
import type { CommitDetail } from '../src/features/board/commitContext';

const workspace = {
  id: 'demo',
  branchName: 'demo',
  name: 'Reports CSV export',
  description: 'Add CSV export to reports',
  repos: [],
  assistants: [],
  workspacePath: '/tmp/demo',
  createdAt: '2026-10-01T00:00:00Z',
};

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

let writes: string[] = [];
test.afterEach(() => { expect(writes, 'no test here may write').toEqual([]); });

// A workspace on the database: every plan item has an id, and a commit may name one with a Plan-Step trailer.
const CSV = { cp: 'c1csv0', writer: 's1wrt0', queue: 's2que0' };
const SHIP = { cp: 'c2shp0', deploy: 's3dpl0' };
const FULL_SHA = 'a91f2e0c4d5b1234567890123456789012345678';

const dbPlan = () => ({
  ...planFile({
    file: 'PLAN.md',
    source: 'file',
    title: 'Reports CSV export',
    checkpoints: [
      { ...checkpoint('Reports export to CSV', { steps: [
        { key: CSV.writer, text: 'Write the CSV writer', done: true },
        { key: CSV.queue, text: 'Background job queue for large exports', done: false },
      ] }), key: CSV.cp },
      { ...checkpoint('Ship it to customers', { steps: [{ key: SHIP.deploy, text: 'Deploy the export to production', done: false }] }), key: SHIP.cp },
    ],
    steps: [],
  }),
  store: 'database' as const,
  revision: 3,
  dbId: 'a1b2c3d4e5f60718',
});

const detail: CommitDetail = {
  repo: 'billing', sha: FULL_SHA, shortSha: FULL_SHA.slice(0, 7), author: 'Anna', at: new Date(Date.now() - 30 * 60_000).toISOString(),
  subject: 'Add the deploy script', body: 'Why it matters.', parents: [], files: [{ path: 'deploy.sh', status: 'added', additions: 3, deletions: 0 }],
  moreFiles: 0, additions: 3, deletions: 0, pushed: false, forge: null, webUrl: null,
};

const OTHER_SHA = 'b82e3f1d5c6a2345678901234567890123456789';

/** `steps` goes on the commit in both lists, as the real server sends it. `newsOnly` adds a second commit that only the news lists. */
async function setup(page: Page, steps?: string[], newsOnly?: string[]) {
  writes = [];
  await page.addInitScript(() => window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed'));
  const commits = [{ repo: 'billing', more: 0, commits: [{ sha: FULL_SHA, author: 'Anna', subject: detail.subject, at: detail.at, ...(steps ? { steps } : {}) }] }];
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: dbPlan() }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  const newsCommits = newsOnly
    ? [{ repo: 'billing', more: 0, commits: [...commits[0]!.commits, { sha: OTHER_SHA, author: 'Bob', subject: 'Old deploy fix', at: new Date(Date.now() - 5 * 86_400_000).toISOString(), steps: newsOnly }] }]
    : commits;
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: newsCommits }) }));
  await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({ json: { at: new Date().toISOString(), from: new Date(Date.now() - 3 * 86_400_000).toISOString(), commits } }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile() }));
  await page.route('**/api/workspace/demo/changes**', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/commits/**', (route) => route.fulfill({ json: detail }));
  // The terminal in the chat pane is faked: no session, and no real socket.
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.routeWebSocket('**/ws/terminal', (socket) => { socket.onMessage(() => undefined); });
  // Nothing here may write. Registered last, so it is looked at first.
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
  await page.goto('/#/workspaces/demo/board');
}

const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const commitCard = (page: Page) => board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: detail.subject });
async function stepIntoArea(page: Page, name: RegExp) {
  await board(page).locator('.board-overview-plane button.board-area').filter({ hasText: name }).click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
}

test.describe('a commit that names its plan step', () => {
  test('sits in the Area of that step, and its reader names the step', async ({ page }) => {
    await setup(page, [SHIP.deploy]);
    await stepIntoArea(page, /Ship it to customers/);
    await expect(commitCard(page)).toHaveCount(1);
    await commitCard(page).locator('article').click({ position: { x: 12, y: 12 } });
    const header = page.getByRole('region', { name: 'Review', exact: true }).getByTestId('commit-header');
    await expect(header.getByTestId('commit-steps')).toContainText('Deploy the export to production');
    await expect(header.getByTestId('commit-steps')).toContainText('Ship it to customers');
  });

  test('is not in the current Area when it names a step elsewhere', async ({ page }) => {
    await setup(page, [SHIP.deploy]);
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(commitCard(page)).toHaveCount(0);
  });

  test('without a trailer stays in the current Area, as before', async ({ page }) => {
    await setup(page);
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(commitCard(page)).toHaveCount(1);
  });

  test('without a trailer is not in the Area of a later checkpoint', async ({ page }) => {
    await setup(page);
    await stepIntoArea(page, /Ship it to customers/);
    await expect(commitCard(page)).toHaveCount(0);
  });

  test('a commit only the news lists is in its step\'s Area on first draw', async ({ page }) => {
    await setup(page, undefined, [SHIP.deploy]);
    await stepIntoArea(page, /Ship it to customers/);
    await expect(board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Old deploy fix' })).toHaveCount(1);
  });
});
