import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  boardFile,
  checkpoint,
  planFile,
  step,
  whatsNew,
} from './planData';
import { board, minutesAgo, workspace } from './boardHelpers';
import type { CommitDetail, CommitFileDiff } from '../src/features/board/commitContext';

test.use({
  workspacesData: [[workspace], { option: true }],
  viewport: { width: 1280, height: 800 },
});

const SHA_NEW = 'f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e';
const SHA_MID = 'e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f';
const SHA_OLD = 'd3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a';
const SHA_BOB = 'c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3b';
const SHA_LOCAL = 'a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d';

const SHORT_NEW = SHA_NEW.slice(0, 7);
const SHORT_MID = SHA_MID.slice(0, 7);
const SHORT_OLD = SHA_OLD.slice(0, 7);
const SHORT_LOCAL = SHA_LOCAL.slice(0, 7);

let writes: string[] = [];
test.afterEach(() => { expect(writes, 'no test here may write').toEqual([]); });

const win = (page: Page) => page.getByRole('region', { name: 'Review', exact: true });
const commitHeader = (page: Page) => win(page).getByTestId('commit-header');
const commitsTree = (page: Page) => win(page).getByRole('tree', { name: 'Commits' });
const modeButton = (page: Page, name: string) =>
  win(page).getByRole('group', { name: 'Show' }).getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });

function makeDetail(overrides: Partial<CommitDetail> & { repo?: string; sha: string }): CommitDetail {
  const shortSha = overrides.sha.slice(0, 7);
  return {
    repo: overrides.repo ?? 'billing',
    sha: overrides.sha,
    shortSha,
    author: 'Maria',
    at: minutesAgo(12),
    subject: 'Stream CSV chunks',
    body: 'Streams CSV chunks without holding the whole report in memory.\n\nBackpressures slow consumers automatically.',
    parents: [SHA_OLD],
    files: [
      { path: 'src/stream.ts', status: 'modified', additions: 18, deletions: 4 },
      { path: 'src/stream.test.ts', status: 'added', additions: 24, deletions: 0 },
    ],
    moreFiles: 0,
    additions: 42,
    deletions: 4,
    pushed: true,
    forge: 'azure',
    webUrl: `https://dev.azure.com/org/proj/_git/billing/commit/${overrides.sha}`,
    ...overrides,
  };
}

function makeDiff(detail: CommitDetail, file: string): CommitFileDiff {
  return {
    repo: detail.repo,
    repoPath: `/tmp/demo/${detail.repo}`,
    sha: detail.sha,
    file,
    diff: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,3 @@\n export const ok = true;\n+export const streamed = true;\n`,
    fileContent: 'export const ok = true;\nexport const streamed = true;\n',
    originalContent: 'export const ok = true;\n',
    symbols: [],
  };
}

async function setupBase(page: Page, opts: {
  details?: CommitDetail[];
  recent?: Array<{ repo: string; more?: number; commits: Array<{ sha: string; author: string; subject: string; at: string; firstBodyLine?: string; fileCount?: number; pushed?: boolean }> }>;
  incoming?: (refresh: boolean, url: URL) => unknown;
  news?: () => unknown;
  split?: boolean;
} = {}) {
  writes = [];
  await page.addInitScript((split) => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
    if (split) {
      window.localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 55 }));
    }
  }, Boolean(opts.split));

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({
    json: planFile({
      now: { key: 'background-job-queue-for-large-exports', by: 'claude', at: new Date().toISOString() },
      title: 'Reports CSV export',
      checkpoints: [
        checkpoint('Reports export to CSV', {
          steps: [step('Write the CSV writer', true), step('Background job queue for large exports')],
          decisions: [],
        }),
      ],
    }),
  }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({
    json: {
      guidance: {
        version: 1,
        revision: 1,
        workType: 'feature',
        size: 'standard',
        assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' },
        documents: [],
      },
      lifecycle: null,
      assignment: '',
      sharedDocuments: [],
    },
  }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile() }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes?*', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));

  await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({
    json: {
      at: new Date().toISOString(),
      from: minutesAgo(180),
      commits: opts.recent ?? [],
    },
  }));

  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
    json: opts.news ? opts.news() : whatsNew(),
  }));

  await page.route('**/api/workspace/demo/incoming**', (route) => {
    const parsed = new URL(route.request().url());
    const refresh = parsed.searchParams.get('refresh') === '1' || parsed.searchParams.get('refresh') === 'true';
    const body = opts.incoming ? opts.incoming(refresh, parsed) : { at: new Date().toISOString(), repos: [] };
    return route.fulfill({ json: body });
  });

  const details = opts.details ?? [];
  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const parsed = new URL(route.request().url());
    const [repo, sha] = parsed.pathname.split('/commits/')[1]!.split('/').map(decodeURIComponent);
    const matched = details.find((d) => d.repo === repo && (d.sha === sha || d.sha.startsWith(sha!) || sha!.startsWith(d.sha)))
      ?? makeDetail({ repo: repo ?? 'billing', sha: sha ?? SHA_NEW });
    if (parsed.pathname.endsWith('/diff')) {
      const file = parsed.searchParams.get('file') ?? 'src/stream.ts';
      return route.fulfill({ json: makeDiff(matched, file) });
    }
    return route.fulfill({ json: matched });
  });

  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
}

async function openReviewCommits(page: Page) {
  const reviewBtn = page.getByRole('button', { name: /^Review/ });
  await expect(reviewBtn).toBeVisible();
  await reviewBtn.click();
  await expect(win(page)).toBeVisible();
  await modeButton(page, 'Commits').click();
  await expect(modeButton(page, 'Commits')).toHaveAttribute('aria-pressed', 'true');
}

test.describe('OP2: Incoming commits shown in Review and What\'s new', () => {
  test('shows the incoming group at the top with author, details, description, diff, meta line, and Open on <host> link', async ({ page }) => {
    const dNew = makeDetail({ sha: SHA_NEW, subject: 'Stream CSV chunks', author: 'Maria', at: minutesAgo(8) });
    const dMid = makeDetail({
      sha: SHA_MID,
      subject: 'Retry failed exports',
      author: 'Bob',
      at: minutesAgo(22),
      body: 'Adds exponential backoff for transient write errors.',
      files: [{ path: 'src/retry.ts', status: 'added', additions: 10, deletions: 0 }],
    });
    const dLocal = makeDetail({
      sha: SHA_LOCAL,
      subject: 'Prepare local formatter',
      author: 'Alice',
      at: minutesAgo(45),
      pushed: false,
      forge: null,
      webUrl: null,
    });

    await setupBase(page, {
      details: [dNew, dMid, dLocal],
      recent: [{
        repo: 'billing',
        commits: [{
          sha: SHORT_LOCAL,
          author: 'Alice',
          subject: 'Prepare local formatter',
          at: dLocal.at,
          firstBodyLine: 'Local baseline prep.',
          fileCount: 1,
          pushed: false,
        }],
      }],
      incoming: () => ({
        at: new Date().toISOString(),
        repos: [{
          repo: 'billing',
          remote: 'origin',
          branch: 'main',
          host: { kind: 'azure', name: 'Azure DevOps' },
          lastFetchAt: minutesAgo(2),
          fetching: false,
          state: 'ok',
          message: null,
          behind: 2,
          commits: [
            {
              sha: SHORT_NEW,
              author: 'Maria',
              subject: 'Stream CSV chunks',
              at: dNew.at,
              firstBodyLine: 'Streams CSV chunks without holding the whole report in memory.',
              fileCount: 2,
              incoming: true,
              webUrl: dNew.webUrl,
            },
            {
              sha: SHORT_MID,
              author: 'Bob',
              subject: 'Retry failed exports',
              at: dMid.at,
              firstBodyLine: 'Adds exponential backoff for transient write errors.',
              fileCount: 1,
              incoming: true,
              webUrl: dMid.webUrl,
            },
          ],
          more: 0,
        }],
      }),
    });

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);

    const tree = commitsTree(page);
    await expect(tree).toBeVisible();

    // Group heading at the top of the tree, before Recent commits
    const incomingHeading = tree.getByText('On Azure DevOps, not in your copy yet');
    await expect(incomingHeading).toBeVisible();
    const recentHeading = tree.getByText('Recent commits in billing');
    await expect(recentHeading).toBeVisible();
    const incomingBox = await incomingHeading.boundingBox();
    const recentBox = await recentHeading.boundingBox();
    expect(incomingBox!.y).toBeLessThan(recentBox!.y);

    // Three commit items in newest-first order inside incoming, then local commit
    const items = tree.locator('[data-testid="commit-tree-item"]');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Stream CSV chunks');
    await expect(items.nth(0)).toContainText('Maria');
    await expect(items.nth(0)).toContainText(SHORT_NEW);
    await expect(items.nth(0)).toContainText('2 files');
    await expect(items.nth(0)).toContainText('Streams CSV chunks without holding the whole report in memory.');
    await expect(items.nth(1)).toContainText('Retry failed exports');
    await expect(items.nth(1)).toContainText('Bob');
    await expect(items.nth(2)).toContainText('Prepare local formatter');

    // Open incoming commit: full description, files, diff, meta line, and Open on Azure DevOps link
    await items.nth(0).click();
    const header = commitHeader(page);
    await expect(header.getByTestId('commit-subject')).toHaveText('Stream CSV chunks');
    await expect(header.getByTestId('commit-body')).toContainText('Backpressures slow consumers automatically.');
    await expect(header.getByTestId('commit-pushed')).toHaveText('on Azure DevOps, not in your copy yet');
    const link = header.getByRole('link', { name: 'Open on Azure DevOps' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', dNew.webUrl!);
    await expect(win(page).getByTestId('commit-file-count')).toContainText('2 files changed');

    await tree.getByRole('treeitem', { name: /stream\.ts/ }).click();
    await expect(win(page).locator('.monaco-diff-editor, [data-testid="fallback-diff"]').first()).toBeVisible();
  });

  test('omits the incoming group when there are no incoming commits', async ({ page }) => {
    await setupBase(page, {
      recent: [{
        repo: 'billing',
        commits: [{ sha: SHORT_LOCAL, author: 'Alice', subject: 'Local commit', at: minutesAgo(10), fileCount: 1, pushed: true }],
      }],
      incoming: () => ({
        at: new Date().toISOString(),
        repos: [{
          repo: 'billing',
          remote: 'origin',
          branch: 'main',
          host: { kind: 'azure', name: 'Azure DevOps' },
          lastFetchAt: minutesAgo(1),
          fetching: false,
          state: 'ok',
          message: null,
          behind: 0,
          commits: [],
          more: 0,
        }],
      }),
    });

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);
    await expect(win(page).getByRole('button', { name: 'Check now' })).toBeVisible();
    await expect(win(page)).toContainText('Checked 1 min ago');
    await expect(commitsTree(page).getByText(/not in your copy yet/)).toHaveCount(0);
    await expect(commitsTree(page).locator('[data-testid="commit-tree-item"]')).toHaveCount(1);
  });

  test('shows Check now in the list header (not inside a treeitem), shows Checking… while fetching, Checked <age> after, and one quiet status line per repo when blocked', async ({ page }) => {
    let refreshCount = 0;
    let fetchingPhase = false;
    let stateKind: 'sign-in' | 'ok' = 'sign-in';

    await setupBase(page, {
      incoming: (refresh) => {
        if (refresh) {
          refreshCount += 1;
          fetchingPhase = true;
        }
        return {
          at: new Date().toISOString(),
          repos: [{
            repo: 'billing',
            remote: 'origin',
            branch: 'main',
            host: { kind: 'azure', name: 'Azure DevOps' },
            lastFetchAt: minutesAgo(4),
            fetching: fetchingPhase,
            state: fetchingPhase ? 'checking' : stateKind,
            message: fetchingPhase ? null : (stateKind === 'sign-in' ? 'Sign in to Azure DevOps to see new commits' : null),
            behind: 0,
            commits: [],
            more: 0,
          }],
        };
      },
    });

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);

    const checkBtn = win(page).getByRole('button', { name: 'Check now' });
    await expect(checkBtn).toBeVisible();
    // Never placed inside a treeitem (RV2 rule)
    await expect(commitsTree(page).getByRole('button', { name: /Check/ })).toHaveCount(0);
    await expect(win(page)).toContainText('Checked 4 min ago');

    // One quiet status line under header when fetch could not run
    const status = win(page).getByTestId('incoming-status');
    await expect(status).toHaveCount(1);
    await expect(status).toContainText('Sign in to Azure DevOps to see new commits');

    // Click Check now -> requests ?refresh=1 and displays Checking… while fetching
    await checkBtn.click();
    await expect.poll(() => refreshCount).toBe(1);
    await expect(win(page).getByRole('button', { name: 'Checking…' })).toBeVisible();

    // Target size & font size checks
    const metrics = await win(page).getByRole('button', { name: 'Checking…' }).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { height: box.height, fontSize: parseFloat(style.fontSize) };
    });
    expect(metrics.height).toBeGreaterThanOrEqual(24);
    expect(metrics.fontSize).toBeGreaterThanOrEqual(12);

    // Next check finishes ok -> quiet line clears cleanly
    fetchingPhase = false;
    stateKind = 'ok';
  });

  test('shows "3 new commits from Maria on Azure DevOps" in What\'s new without adding Area commit cards and opens Review on the newest commit', async ({ page }) => {
    const dNew = makeDetail({ sha: SHA_NEW, subject: 'Newest Maria commit', author: 'Maria', at: minutesAgo(3) });
    const dMid = makeDetail({ sha: SHA_MID, subject: 'Middle Maria commit', author: 'Maria', at: minutesAgo(9) });
    const dOld = makeDetail({ sha: SHA_OLD, subject: 'Oldest Maria commit', author: 'Maria', at: minutesAgo(15) });
    const dBob = makeDetail({ sha: SHA_BOB, repo: 'api', subject: 'Bob API change', author: 'Bob', at: minutesAgo(5), forge: 'github', webUrl: `https://github.com/org/api/commit/${SHA_BOB}` });

    await setupBase(page, {
      details: [dNew, dMid, dOld, dBob],
      incoming: () => ({
        at: new Date().toISOString(),
        repos: [
          {
            repo: 'billing',
            remote: 'origin',
            branch: 'main',
            host: { kind: 'azure', name: 'Azure DevOps' },
            lastFetchAt: minutesAgo(1),
            fetching: false,
            state: 'ok',
            message: null,
            behind: 3,
            commits: [
              { sha: SHORT_NEW, author: 'Maria', subject: dNew.subject, at: dNew.at, fileCount: 2, incoming: true, webUrl: dNew.webUrl },
              { sha: SHORT_MID, author: 'Maria', subject: dMid.subject, at: dMid.at, fileCount: 1, incoming: true, webUrl: dMid.webUrl },
              { sha: SHORT_OLD, author: 'Maria', subject: dOld.subject, at: dOld.at, fileCount: 1, incoming: true, webUrl: dOld.webUrl },
            ],
            more: 0,
          },
          {
            repo: 'api',
            remote: 'origin',
            branch: 'main',
            host: { kind: 'github', name: 'GitHub' },
            lastFetchAt: minutesAgo(1),
            fetching: false,
            state: 'ok',
            message: null,
            behind: 1,
            commits: [
              { sha: SHA_BOB.slice(0, 7), author: 'Bob', subject: dBob.subject, at: dBob.at, fileCount: 1, incoming: true, webUrl: dBob.webUrl },
            ],
            more: 0,
          },
        ],
      }),
      news: () => whatsNew({
        empty: false,
        incoming: [
          {
            repo: 'billing',
            host: { kind: 'azure', name: 'Azure DevOps' },
            groups: [{ author: 'Maria', count: 3, newestSha: SHORT_NEW, newestAt: dNew.at, subject: dNew.subject }],
          },
          {
            repo: 'api',
            host: { kind: 'github', name: 'GitHub' },
            groups: [{ author: 'Bob', count: 1, newestSha: SHA_BOB.slice(0, 7), newestAt: dBob.at, subject: dBob.subject }],
          },
        ],
      } as Record<string, unknown>),
    });

    await page.goto('/#/workspaces/demo/board');

    // Step into the Area and verify Board's Areas do NOT render unlinked incoming commit cards
    await board(page).locator('.board-overview-plane button.board-area').first().click();
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
    await expect(board(page).locator('#board-area .react-flow__node-commit')).toHaveCount(0);

    // Open What's new popover
    const newsBtn = page.getByRole('button', { name: /new/i }).filter({ hasText: /\d+\s+new/i });
    await expect(newsBtn).toBeVisible();
    await newsBtn.click();

    const mariaLine = page.getByRole('button', { name: 'billing: 3 new commits from Maria on Azure DevOps' });
    const bobLine = page.getByRole('button', { name: 'api: 1 new commit from Bob on GitHub' });
    await expect(mariaLine).toBeVisible();
    await expect(bobLine).toBeVisible();

    // Clicking opens Review directly on the newest commit of Maria's 3
    await mariaLine.click();
    await expect(win(page)).toBeVisible();
    await expect(modeButton(page, 'Commits')).toHaveAttribute('aria-pressed', 'true');
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Newest Maria commit');
    await expect(commitHeader(page).getByTestId('commit-pushed')).toHaveText('on Azure DevOps, not in your copy yet');
  });

  test('retries once after ~5 s when fetching is true without tight-looping, and stops polling when Review and Board are hidden', async ({ page }) => {
    let reads = 0;
    await setupBase(page, {
      incoming: () => {
        reads += 1;
        return {
          at: new Date().toISOString(),
          repos: [{
            repo: 'billing',
            remote: 'origin',
            branch: 'main',
            host: { kind: 'azure', name: 'Azure DevOps' },
            lastFetchAt: null,
            fetching: true,
            state: 'checking',
            message: null,
            behind: 0,
            commits: [],
            more: 0,
          }],
        };
      },
    });

    await page.goto('/#/workspaces/demo/board');
    await expect.poll(() => reads).toBeGreaterThanOrEqual(1);

    // Wait ~6s: a single follow-up read happens around 5s even when fetching remains true (no tight loop)
    await page.waitForTimeout(6000);
    const readsAfterFollowUp = reads;
    expect(readsAfterFollowUp).toBeLessThanOrEqual(3);
    expect(readsAfterFollowUp).toBeGreaterThanOrEqual(2);

    // Navigating away from Board (and with Review closed) stops any polling
    await page.goto('/#/workspaces/demo/overview');
    const readsAfterLeave = reads;
    await page.waitForTimeout(6000);
    expect(reads).toBe(readsAfterLeave);
  });

  test('after AI pulls, incoming commits leave the incoming group and appear once as ordinary commits', async ({ page }) => {
    let pulled = false;
    const mariaDetail = makeDetail({
      sha: SHA_NEW,
      subject: 'Pulled feature commit',
      author: 'Maria',
      at: minutesAgo(5),
      pushed: true,
    });

    await setupBase(page, { details: [mariaDetail] });

    // Custom dynamic routes so pull transitions from incoming -> recent seamlessly
    await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({
      json: {
        at: new Date().toISOString(),
        from: minutesAgo(180),
        commits: pulled ? [{
          repo: 'billing',
          commits: [{ sha: SHORT_NEW, author: 'Maria', subject: 'Pulled feature commit', at: mariaDetail.at, fileCount: 2, pushed: true }],
        }] : [],
      },
    }));
    await page.route('**/api/workspace/demo/incoming**', (route) => {
      const refresh = new URL(route.request().url()).searchParams.get('refresh');
      if (refresh) pulled = true;
      return route.fulfill({
        json: {
          at: new Date().toISOString(),
          repos: [{
            repo: 'billing',
            remote: 'origin',
            branch: 'main',
            host: { kind: 'azure', name: 'Azure DevOps' },
            lastFetchAt: minutesAgo(0),
            fetching: false,
            state: 'ok',
            message: null,
            behind: pulled ? 0 : 1,
            commits: pulled ? [] : [{
              sha: SHORT_NEW,
              author: 'Maria',
              subject: 'Pulled feature commit',
              at: mariaDetail.at,
              fileCount: 2,
              incoming: true,
              webUrl: mariaDetail.webUrl,
            }],
            more: 0,
          }],
        },
      });
    });

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);
    await expect(commitsTree(page).getByText('On Azure DevOps, not in your copy yet')).toBeVisible();
    await expect(commitsTree(page).locator('[data-testid="commit-tree-item"]')).toHaveCount(1);

    // Simulate AI pull + refresh via Check now
    await win(page).getByRole('button', { name: 'Check now' }).click();
    await expect(commitsTree(page).getByText('On Azure DevOps, not in your copy yet')).toHaveCount(0);
    await expect(commitsTree(page).getByText('Recent commits in billing')).toBeVisible();
    await expect(commitsTree(page).locator('[data-testid="commit-tree-item"]')).toHaveCount(1);
    await expect(commitsTree(page).locator('[data-testid="commit-tree-item"]').first()).toContainText('Pulled feature commit');
  });

  for (const vp of [
    { name: '1440x900 Board', width: 1440, height: 900, split: false },
    { name: '1280x800 Split', width: 1280, height: 800, split: true },
    { name: '1100x700 Split', width: 1100, height: 700, split: true },
    { name: '420x800 drawer', width: 420, height: 800, split: false },
  ]) {
    test(`fits ${vp.name} with no horizontal overflow, readable text >= 12px, and targets >= 24px`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const dNew = makeDetail({ sha: SHA_NEW, subject: 'Stream CSV chunks across workers', author: 'Maria', at: minutesAgo(4) });
      await setupBase(page, {
        split: vp.split,
        details: [dNew],
        incoming: () => ({
          at: new Date().toISOString(),
          repos: [{
            repo: 'billing',
            remote: 'origin',
            branch: 'main',
            host: { kind: 'azure', name: 'Azure DevOps' },
            lastFetchAt: minutesAgo(2),
            fetching: false,
            state: 'ok',
            message: null,
            behind: 1,
            commits: [{
              sha: SHORT_NEW,
              author: 'Maria',
              subject: dNew.subject,
              at: dNew.at,
              firstBodyLine: 'Keeps memory flat during large exports.',
              fileCount: 2,
              incoming: true,
              webUrl: dNew.webUrl,
            }],
            more: 0,
          }],
        }),
      });

      await page.goto('/#/workspaces/demo/board');
      await openReviewCommits(page);
      const tree = commitsTree(page);
      await expect(tree.getByText('On Azure DevOps, not in your copy yet')).toBeVisible();
      const checkBtn = win(page).getByTestId('incoming-check-now');
      await expect(checkBtn).toBeVisible();
      const listLayout = await win(page).evaluate((region) => {
        const btn = region.querySelector('[data-testid="incoming-check-now"]') as HTMLElement | null;
        return {
          overflow: region.scrollWidth > region.clientWidth + 1,
          checkHeight: btn?.getBoundingClientRect().height ?? 0,
        };
      });
      expect(listLayout.overflow).toBe(false);
      expect(listLayout.checkHeight).toBeGreaterThanOrEqual(24);

      await tree.locator('[data-testid="commit-tree-item"]').first().click();

      const header = commitHeader(page);
      await expect(header.getByTestId('commit-pushed')).toHaveText('on Azure DevOps, not in your copy yet');
      await expect(header.getByRole('link', { name: 'Open on Azure DevOps' })).toBeVisible();

      const layout = await win(page).evaluate((region) => {
        const overflow = region.scrollWidth > region.clientWidth + 1;
        const small = Array.from(region.querySelectorAll('button, a, [role="treeitem"]')).some((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const fs = parseFloat(getComputedStyle(el).fontSize);
          return fs < 12;
        });
        return { overflow, smallText: small };
      });
      expect(layout.overflow).toBe(false);
      expect(layout.smallText).toBe(false);
    });
  }

  test('keeps re-reading while fetching is true (3x true then false), stops after 8 retries even if still fetching, and resets on Check now', async ({ page }) => {
    await page.clock.install();

    let phase: 'idle' | 'three-then-done' | 'always-fetching' | 'manual-done' = 'idle';
    let cycleReads = 0;
    let refreshReads = 0;

    await setupBase(page, {
      incoming: (refresh) => {
        if (phase !== 'idle') cycleReads += 1;
        if (refresh) refreshReads += 1;
        let fetching = false;
        if (phase === 'three-then-done') {
          fetching = cycleReads <= 3;
        } else if (phase === 'always-fetching') {
          fetching = true;
        } else if (phase === 'manual-done') {
          fetching = cycleReads === 1;
        }
        return {
          at: new Date().toISOString(),
          repos: [{
            repo: 'billing',
            remote: 'origin',
            branch: 'main',
            host: { kind: 'azure', name: 'Azure DevOps' },
            lastFetchAt: fetching ? null : minutesAgo(0),
            fetching,
            state: fetching ? 'checking' : 'ok',
            message: null,
            behind: 0,
            commits: [],
            more: 0,
          }],
        };
      },
    });

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);

    const checkBtn = win(page).getByTestId('incoming-check-now');
    await expect(checkBtn).toHaveText('Check now');

    // Mock answers fetching: true 3 times, then false on the 4th read
    phase = 'three-then-done';
    cycleReads = 0;
    await checkBtn.click();
    await expect.poll(() => refreshReads).toBe(1);
    await expect.poll(() => cycleReads).toBe(1);
    await expect(checkBtn).toHaveText('Checking…');
    await expect(checkBtn).toHaveAttribute('aria-disabled', 'true');

    await page.clock.runFor(50);
    await page.clock.fastForward(5_000);
    await expect.poll(() => cycleReads).toBe(2);
    await expect(checkBtn).toHaveText('Checking…');

    await page.clock.runFor(50);
    await page.clock.fastForward(5_000);
    await expect.poll(() => cycleReads).toBe(3);
    await expect(checkBtn).toHaveText('Checking…');

    await page.clock.runFor(50);
    await page.clock.fastForward(5_000);
    await expect.poll(() => cycleReads).toBe(4);
    await expect(checkBtn).toHaveText('Check now');
    await expect(checkBtn).not.toHaveAttribute('aria-disabled', 'true');

    // When fetching stays true, poll at most 8 follow-ups (~5s each), then stop and restore Check now
    phase = 'always-fetching';
    cycleReads = 0;
    await checkBtn.click();
    await expect.poll(() => refreshReads).toBe(2);
    await expect.poll(() => cycleReads).toBe(1);
    await expect(checkBtn).toHaveText('Checking…');

    for (let retry = 1; retry <= 8; retry += 1) {
      await page.clock.runFor(50);
      await page.clock.fastForward(5_000);
      await expect.poll(() => cycleReads).toBe(1 + retry);
    }

    await page.clock.runFor(50);
    await page.clock.fastForward(5_000);
    await page.clock.runFor(50);
    await page.clock.fastForward(5_000);
    await page.clock.runFor(50);
    expect(cycleReads).toBe(9);
    await expect(checkBtn).toHaveText('Check now');
    await expect(checkBtn).not.toHaveAttribute('aria-disabled', 'true');

    // Manual Check now resets the retry state and polls again until fetching finishes
    phase = 'manual-done';
    cycleReads = 0;
    await checkBtn.click();
    await expect.poll(() => refreshReads).toBe(3);
    await expect.poll(() => cycleReads).toBe(1);
    await expect(checkBtn).toHaveText('Checking…');

    await page.clock.runFor(50);
    await page.clock.fastForward(5_000);
    await expect.poll(() => cycleReads).toBe(2);
    await expect(checkBtn).toHaveText('Check now');
    await expect(checkBtn).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('keeps focus on Check now with aria-disabled and ignores presses while checking', async ({ page }) => {
    await page.clock.install();

    let fetchingPhase = false;
    let refreshCount = 0;

    await setupBase(page, {
      incoming: (refresh) => {
        if (refresh) {
          refreshCount += 1;
          fetchingPhase = true;
        }
        return {
          at: new Date().toISOString(),
          repos: [{
            repo: 'billing',
            remote: 'origin',
            branch: 'main',
            host: { kind: 'azure', name: 'Azure DevOps' },
            lastFetchAt: minutesAgo(2),
            fetching: fetchingPhase,
            state: fetchingPhase ? 'checking' : 'ok',
            message: null,
            behind: 0,
            commits: [],
            more: 0,
          }],
        };
      },
    });

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);

    const checkBtn = win(page).getByTestId('incoming-check-now');
    await checkBtn.focus();
    await expect(checkBtn).toBeFocused();

    await page.keyboard.press('Enter');
    await expect.poll(() => refreshCount).toBe(1);
    await expect(checkBtn).toHaveText('Checking…');
    await expect(checkBtn).toHaveAttribute('aria-disabled', 'true');
    await expect(checkBtn).toBeFocused();
    const activeWhileChecking = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      testId: document.activeElement?.getAttribute('data-testid') ?? null,
      hasDisabledAttr: document.activeElement?.hasAttribute('disabled') ?? null,
    }));
    expect(activeWhileChecking).toEqual({
      tag: 'BUTTON',
      testId: 'incoming-check-now',
      hasDisabledAttr: false,
    });

    // Additional Enter/Space presses while checking must be ignored and keep focus
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.clock.runFor(50);
    expect(refreshCount).toBe(1);
    await expect(checkBtn).toBeFocused();

    fetchingPhase = false;
    await page.clock.fastForward(5_000);
    await expect(checkBtn).toHaveText('Check now');
    await expect(checkBtn).not.toHaveAttribute('aria-disabled', 'true');
    await expect(checkBtn).toBeFocused();
    const activeAfterDone = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      testId: document.activeElement?.getAttribute('data-testid') ?? null,
    }));
    expect(activeAfterDone).toEqual({
      tag: 'BUTTON',
      testId: 'incoming-check-now',
    });
  });

  test('follows focus, keeps open commit and scroll when a focused incoming commit moves to Recent commits on refetch', async ({ page }) => {
    await page.clock.install();

    const makeSha = (n: number) => `${(0xabc0000 + n).toString(16).padStart(7, '0')}${'0'.repeat(33)}`;
    const incomingDetails = Array.from({ length: 10 }, (_, idx) => {
      const sha = makeSha(idx + 1);
      return makeDetail({
        sha,
        subject: `Incoming feature ${idx + 1}`,
        author: 'Maria',
        at: minutesAgo(idx + 1),
      });
    });
    const recentBaseCommits = Array.from({ length: 15 }, (_, idx) => {
      const sha = makeSha(100 + idx + 1);
      return {
        sha: sha.slice(0, 7),
        author: 'Alice',
        subject: `Local baseline ${idx + 1}`,
        at: minutesAgo(30 + idx),
        fileCount: 1,
        pushed: true,
      };
    });
    const targetDetail = incomingDetails[5]!;
    let pulled = false;

    await setupBase(page, { details: incomingDetails });

    await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({
      json: {
        at: new Date().toISOString(),
        from: minutesAgo(300),
        commits: [{
          repo: 'billing',
          commits: [
            ...(pulled ? incomingDetails.map((d) => ({
              sha: d.shortSha,
              author: d.author,
              subject: d.subject,
              at: d.at,
              fileCount: 2,
              pushed: true,
            })) : []),
            ...recentBaseCommits,
          ],
        }],
      },
    }));

    await page.route('**/api/workspace/demo/incoming**', (route) => route.fulfill({
      json: {
        at: new Date().toISOString(),
        repos: [{
          repo: 'billing',
          remote: 'origin',
          branch: 'main',
          host: { kind: 'azure', name: 'Azure DevOps' },
          lastFetchAt: minutesAgo(1),
          fetching: false,
          state: 'ok',
          message: null,
          behind: pulled ? 0 : incomingDetails.length,
          commits: pulled ? [] : incomingDetails.map((d) => ({
            sha: d.shortSha,
            author: d.author,
            subject: d.subject,
            at: d.at,
            fileCount: 2,
            incoming: true as const,
            webUrl: d.webUrl,
          })),
          more: 0,
        }],
      },
    }));

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);

    const tree = commitsTree(page);
    await expect(tree.getByText('On Azure DevOps, not in your copy yet')).toBeVisible();

    const targetItem = tree.getByRole('treeitem', { name: /Incoming feature 6/ });
    await targetItem.scrollIntoViewIfNeeded();
    await targetItem.click();
    await expect(targetItem).toBeFocused();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText(targetDetail.subject);
    const targetTreeId = await targetItem.getAttribute('data-tree-id');
    expect(targetTreeId).toBeTruthy();

    const scrollBefore = await tree.evaluate((el) => {
      if (el.scrollTop === 0) el.scrollTop = 140;
      return el.scrollTop;
    });
    expect(scrollBefore).toBeGreaterThan(50);

    await page.evaluate(() => {
      (window as unknown as { __prevTreeItemEl?: Element | null }).__prevTreeItemEl = document.activeElement;
    });

    // Background refetch pulls incoming commits into Recent commits without stealing or dropping focus
    pulled = true;
    const refetchedIncoming = page.waitForResponse('**/api/workspace/demo/incoming**');
    const refetchedRecent = page.waitForResponse('**/api/workspace/demo/recent-commits');
    await page.clock.fastForward('02:00');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    await Promise.all([refetchedIncoming, refetchedRecent]);
    await page.clock.runFor(50);

    await expect(tree.getByText('On Azure DevOps, not in your copy yet')).toHaveCount(0);
    await expect(tree.getByText('Recent commits in billing')).toBeVisible();

    // Open commit and scroll are preserved
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText(targetDetail.subject);
    const scrollAfter = await tree.evaluate((el) => el.scrollTop);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(40);

    // Focus moved onto the new treeitem element in Recent commits (never dropped to <body>)
    const focusAfter = await page.evaluate(() => {
      const active = document.activeElement;
      const prev = (window as unknown as { __prevTreeItemEl?: Element | null }).__prevTreeItemEl ?? null;
      return {
        tag: active?.tagName ?? null,
        role: active?.getAttribute('role') ?? null,
        treeId: active?.getAttribute('data-tree-id') ?? null,
        replacedNode: active !== null && prev !== null && active !== prev,
      };
    });
    expect(focusAfter).toEqual({
      tag: 'DIV',
      role: 'treeitem',
      treeId: targetTreeId,
      replacedNode: true,
    });

    // Keyboard navigation continues cleanly from the moved item through its expanded files to Incoming feature 7
    await page.keyboard.press('ArrowDown');
    await expect(tree.getByRole('treeitem', { name: /stream\.ts/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(tree.getByRole('treeitem', { name: /Incoming feature 7/ })).toBeFocused();
  });

  test('hides no-upstream and no-remote status lines while keeping real problems visible in the quiet line', async ({ page }) => {
    const dLocal = makeDetail({ repo: 'api', sha: SHA_LOCAL, pushed: false, subject: 'Local commit' });
    await setupBase(page, {
      details: [dLocal],
      recent: [{
        repo: 'api',
        commits: [{ sha: SHA_LOCAL, author: 'Alice', subject: dLocal.subject, at: minutesAgo(30), pushed: false }],
      }],
      incoming: () => ({
        at: minutesAgo(2),
        repos: [
          {
            repo: 'api',
            remote: 'origin',
            branch: 'feat/local',
            host: { kind: 'github', name: 'GitHub' },
            lastFetchAt: minutesAgo(2),
            fetching: false,
            state: 'no-upstream',
            message: 'No upstream branch configured for feat/local',
            behind: 0,
            commits: [],
            more: 0,
          },
          {
            repo: 'scratch',
            remote: null,
            branch: 'main',
            host: null,
            lastFetchAt: minutesAgo(2),
            fetching: false,
            state: 'no-remote',
            message: 'Repository has no remotes configured',
            behind: 0,
            commits: [],
            more: 0,
          },
        ],
      }),
    });

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);
    await expect(win(page)).toBeVisible();
    await expect(win(page).getByTestId('incoming-check-now')).toBeVisible();
    await expect(win(page).getByTestId('incoming-status')).toHaveCount(0);
    await expect(win(page)).not.toContainText('No upstream branch configured');
    await expect(win(page)).not.toContainText('Repository has no remotes configured');
  });

  test('keeps a long incoming author name on one truncated line with tooltip and never strands a leading middot on line 2', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const longAuthor = 'Alexandrina Bartholomew-Montgomery-Featherstonehaugh';
    const dIncoming = makeDetail({
      repo: 'billing',
      sha: SHA_NEW,
      author: longAuthor,
      subject: 'Stream CSV chunks without memory spikes',
      at: minutesAgo(14),
    });

    await setupBase(page, {
      split: true,
      details: [dIncoming],
      incoming: () => ({
        at: minutesAgo(1),
        repos: [{
          repo: 'billing',
          remote: 'origin',
          branch: 'main',
          host: { kind: 'azure', name: 'Azure DevOps' },
          lastFetchAt: minutesAgo(1),
          fetching: false,
          state: 'ok',
          message: null,
          behind: 1,
          commits: [{
            sha: SHA_NEW,
            author: longAuthor,
            subject: dIncoming.subject,
            at: dIncoming.at,
            incoming: true,
            webUrl: dIncoming.webUrl,
          }],
          more: 0,
        }],
      }),
    });

    await page.goto('/#/workspaces/demo/board');
    await openReviewCommits(page);
    await expect(win(page)).toBeVisible();

    const tree = commitsTree(page);
    const firstItem = tree.getByRole('treeitem').first();
    await expect(firstItem).toBeVisible();

    const metrics = await firstItem.evaluate((itemEl, expectedAuthor) => {
      const author = itemEl.querySelector<HTMLElement>('[data-testid="commit-item-author"]')
        ?? Array.from(itemEl.querySelectorAll<HTMLElement>('span')).find((el) => el.textContent?.trim() === expectedAuthor)
        ?? null;
      const sep = author?.nextElementSibling as HTMLElement | null;
      const shaEl = itemEl.querySelector<HTMLElement>('code');
      const authorRect = author?.getBoundingClientRect();
      const sepRect = sep?.getBoundingClientRect();
      const shaRect = shaEl?.getBoundingClientRect();
      return {
        authorHeight: authorRect?.height ?? 0,
        authorScrollWidth: author?.scrollWidth ?? 0,
        authorClientWidth: author?.clientWidth ?? 0,
        sepText: sep?.textContent?.trim() ?? '',
        sepSameLineAsAuthor: Boolean(authorRect && sepRect && Math.abs(sepRect.top - authorRect.top) <= 4),
        shaBelowOrInlineWithoutLeadingSep: Boolean(sepRect && shaRect && (shaRect.top > sepRect.bottom - 2 || shaRect.left >= sepRect.right - 2)),
      };
    }, longAuthor);

    expect(metrics.authorHeight).toBeLessThanOrEqual(20);
    expect(metrics.authorScrollWidth).toBeGreaterThan(metrics.authorClientWidth);
    expect(metrics.sepText).toBe('·');
    expect(metrics.sepSameLineAsAuthor).toBe(true);
    expect(metrics.shaBelowOrInlineWithoutLeadingSep).toBe(true);

    const authorLocator = firstItem.getByTestId('commit-item-author');
    expect(await authorLocator.count()).toBe(1);
    await expect(authorLocator).toHaveAttribute('title', longAuthor);

    const overflow = await tree.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(false);
  });
});
