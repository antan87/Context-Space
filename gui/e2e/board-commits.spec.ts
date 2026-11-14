import { routeWorkspaceDocumentReferences } from './boardHelpers';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  boardFile,
  boardFileCard,
  checkpoint,
  planFile,
  step,
  whatsNew,
} from './planData';
import type { CommitDetail, CommitFileDiff } from '../src/features/board/commitContext';

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

test.use({
  workspacesData: [[workspace], { option: true }],
  viewport: { width: 1280, height: 800 },
});

let writes: string[] = [];
test.afterEach(() => { expect(writes, 'no test here may write').toEqual([]); });

const CHANGES = [{ repoName: 'billing', repoPath: '/tmp/demo/billing', files: [{ file: 'src/export.ts', type: 'modified', additions: 1, deletions: 1 }] }];
const FULL_SHA = 'a91f2e0c4d5b1234567890123456789012345678';
const SHORT_SHA = 'a91f2e0c4d5b';

const PICTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function makeCommitDetail(overrides: Partial<CommitDetail> = {}): CommitDetail {
  return {
    repo: 'billing',
    sha: FULL_SHA,
    shortSha: SHORT_SHA,
    author: 'Anna',
    at: new Date(Date.now() - 30 * 60_000).toISOString(),
    subject: 'Write the CSV writer',
    body: LONG_BODY,
    parents: ['b2c3d4e5f6789012345678901234567890123456'],
    files: [
      { path: 'src/export.ts', status: 'modified', additions: 12, deletions: 4 },
      { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', additions: 5, deletions: 0 },
      { path: 'assets/sample.bin', status: 'added', additions: null, deletions: null },
      { path: 'unchanged.txt', status: 'modified', additions: 0, deletions: 0 },
    ],
    moreFiles: 0,
    additions: 17,
    deletions: 4,
    pushed: false,
    forge: null,
    webUrl: null,
    ...overrides,
  };
}

const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
const menuCheckboxItem = (page: Page, name: string) => page.getByRole('menuitemcheckbox', { name, exact: true });
/** Commits open in Review (its Commits mode), not in the reader. */
const win = (page: Page) => page.getByRole('region', { name: 'Review', exact: true });
const commitHeader = (page: Page) => win(page).getByTestId('commit-header');
const modeButton = (page: Page, name: string) => win(page).getByRole('group', { name: 'Show' }).getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });
const commitCardOf = (page: Page, subject: string) => board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: subject });
const commitButtonOf = (page: Page, subject: string) => commitCardOf(page, subject).getByRole('button', { name: `Open ${subject}` });
const openFileName = (page: Page) => win(page).locator('p[title]').filter({ hasText: /\w/ }).last();
/** The long description of a commit: several paragraphs, so it cannot fit in the three lines the header folds it to. */
const LONG_BODY = [
  'Implements CSV streaming for large datasets.',
  'Handles chunked encoding and gzip compression.',
  '',
  'Why: the old writer built the whole report in memory, which failed for reports with more than a million rows.',
  '',
  'How: rows are pulled in pages of 5000 and written as they arrive. The gzip stream is flushed per page.',
  '',
  'Rare case: an empty report still writes the header row.',
].join('\n');

async function stepIntoArea(page: Page, name: string | RegExp = /Reports export to CSV/) {
  const areaBtn = board(page).locator('.board-overview-plane button.board-area').filter({ hasText: name });
  await areaBtn.click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
}

function makeMockDiff(commit: CommitDetail, file: string): CommitFileDiff {
  if (file === 'src/export.ts') {
    return {
      repo: commit.repo,
      repoPath: `/tmp/demo/${commit.repo}`,
      sha: commit.sha,
      file,
      diff: [
        'diff --git a/src/export.ts b/src/export.ts',
        'index 1111111..2222222 100644',
        '--- a/src/export.ts',
        '+++ b/src/export.ts',
        '@@ -1,4 +1,12 @@',
        '-old export line 1',
        '-old export line 2',
        '-old export line 3',
        '-old export line 4',
        '+new export line 1',
        '+new export line 2',
        '+new export line 3',
        '+new export line 4',
        '+new export line 5',
        '+new export line 6',
        '+new export line 7',
        '+new export line 8',
        '+new export line 9',
        '+new export line 10',
        '+new export line 11',
        '+new export line 12',
      ].join('\n') + '\n',
      fileContent: Array.from({ length: 12 }, (_, i) => `new export line ${i + 1}`).join('\n') + '\n',
      originalContent: Array.from({ length: 4 }, (_, i) => `old export line ${i + 1}`).join('\n') + '\n',
      symbols: [],
    };
  }

  if (file === 'new.ts') {
    return {
      repo: commit.repo,
      repoPath: `/tmp/demo/${commit.repo}`,
      sha: commit.sha,
      file,
      oldFile: 'old.ts',
      diff: [
        'diff --git a/old.ts b/new.ts',
        'similarity index 80%',
        'rename from old.ts',
        'rename to new.ts',
        'index 3333333..4444444 100644',
        '--- a/old.ts',
        '+++ b/new.ts',
        '@@ -1,2 +1,7 @@',
        ' line 1',
        '+line 2',
        '+line 3',
        '+line 4',
        '+line 5',
        '+line 6',
        ' line 7',
      ].join('\n') + '\n',
      fileContent: Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
      originalContent: 'line 1\nline 7\n',
      symbols: [],
    };
  }

  if (file === 'assets/sample.bin') {
    return {
      repo: commit.repo,
      repoPath: `/tmp/demo/${commit.repo}`,
      sha: commit.sha,
      file,
      contentOmitted: 'binary',
      diff: 'Binary files a/assets/sample.bin and b/assets/sample.bin differ\n',
      fileContent: '',
      originalContent: '',
      symbols: [],
    };
  }

  if (file === 'unchanged.txt') {
    return {
      repo: commit.repo,
      repoPath: `/tmp/demo/${commit.repo}`,
      sha: commit.sha,
      file,
      diff: '',
      fileContent: 'unchanged line\n',
      originalContent: 'unchanged line\n',
      symbols: [],
    };
  }

  return {
    repo: commit.repo,
    repoPath: `/tmp/demo/${commit.repo}`,
    sha: commit.sha,
    file,
    diff: '',
    fileContent: '',
    originalContent: '',
    symbols: [],
  };
}

async function setupCommitBoard(
  page: Page,
  commitDetail: CommitDetail,
  extraCommits: CommitDetail[] = [],
  diffOverrides?: (file: string, commit: CommitDetail) => CommitFileDiff | undefined,
  opts: { recent?: { repo: string; commits: { sha: string; author: string; subject: string; at: string }[] }[]; cards?: unknown[]; finish?: boolean } = {},
) {
  await routeWorkspaceDocumentReferences(page, () => ['PLAN.md', 'board-pictures/export.png'], workspace.workspacePath);
  const allCommits = [commitDetail, ...extraCommits];
  const grouped = [...new Set(allCommits.map((c) => c.repo))].map((repo) => ({
    repo,
    more: 0,
    commits: allCommits.filter((c) => c.repo === repo).map((c) => ({ sha: c.sha, author: c.author, subject: c.subject, at: c.at })),
  }));
  writes = [];
  await page.addInitScript(() => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
    (window as unknown as { copied: string[] }).copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          (window as unknown as { copied: string[] }).copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });

  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        file: 'PLAN.md',
        source: 'file',
        title: 'Reports CSV export',
        checkpoints: [
          checkpoint('Report rows load fast', { done: true, steps: [step('Query the report rows', true)] }),
          checkpoint('Reports export to CSV', {
            steps: [
              step(
                `Write the CSV writer (${commitDetail.shortSha}). Pictures: \`board-pictures/export.png\``,
                true,
              ),
              step('Background job queue for large exports'),
            ],
            decisions: [],
          }),
        ],
        steps: [],
      }),
    }),
  );

  await page.route('**/api/workspace/demo/work', (route) =>
    route.fulfill({
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
    }),
  );

  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: grouped }) }));
  await page.route('**/api/workspace/demo/recent-commits', (route) =>
    route.fulfill({ json: { at: new Date().toISOString(), from: new Date(Date.now() - 3 * 86_400_000).toISOString(), commits: opts.recent ?? grouped } }),
  );
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile({ cards: opts.cards ?? [], links: [] }) }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: CHANGES } }));
  await page.route('**/api/workspace/demo/changes?*', (route) => route.fulfill({ json: { changes: CHANGES } }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/demo/changes/diff?*', (route) => route.fulfill({ json: { diff: '', fileContent: '// working tree\n' } }));
  if (opts.finish) {
    await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({ json: { repositories: [{
      name: 'billing', access: 'isolated', editable: true, path: '/tmp/billing', sourcePath: '/tmp/billing', branch: 'feat/x', expectedBranch: 'feat/x', onExpectedBranch: true, baseBranch: 'main',
      headSha: 'abc1234def', dirty: true, changedFiles: [{ code: ' M', path: 'src/export.ts' }], ahead: 0, behind: 0, remoteUrl: null,
    }] } }));
    await page.route('**/api/workspace/demo/progression', (route) => route.fulfill({ json: { ready: true, blockers: [], repos: [] } }));
    await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle: { steps: [] }, report: null } }));
    await page.route('**/api/workspace/demo/finish/last', (route) => route.fulfill({ json: { lastFinish: null } }));
  }

  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const parsed = new URL(route.request().url());
    const parts = parsed.pathname.split('/commits/')[1]!.split('/').map(decodeURIComponent);
    const [repo, sha] = parts;
    const matched = allCommits.find((c) => c.repo === repo && (c.sha === sha || c.sha.startsWith(sha!) || sha!.startsWith(c.sha))) ?? commitDetail;
    if (parsed.pathname.endsWith('/diff')) {
      const file = parsed.searchParams.get('file') ?? '';
      const custom = diffOverrides?.(file, matched);
      return route.fulfill({ json: custom ?? makeMockDiff(matched, file) });
    }
    return route.fulfill({ json: matched });
  });

  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name === 'PLAN.md') {
      return route.fulfill({
        json: {
          name: 'PLAN.md',
          kind: 'markdown',
          content: '# Reports CSV export\n\nPlan documentation content.',
          size: 100,
          modifiedAt: new Date().toISOString(),
        },
      });
    }
    if (name.endsWith('.png')) {
      return route.fulfill({
        json: {
          name,
          kind: 'image',
          size: PICTURE_PNG.length,
          modifiedAt: new Date().toISOString(),
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Document not found' } });
  });

  await page.route('**/api/workspace/demo/documents/file?*', (route) => {
    return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE_PNG });
  });

  // The terminal in the chat pane is faked: no session, and no real socket.
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.routeWebSocket('**/ws/terminal', (socket) => { socket.onMessage(() => undefined); });

  // Nothing here may write: the specs read commits and never commit, push, revert or sync. Registered last, so it is looked at first.
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    // The terminal's token and status are asked with POST and write nothing; the routes above fake every one of them
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });

  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const SHA_B = 'b2c3d4e5f6789012345678901234567890123456';
const SHA_C = 'c3d4e5f6a7b89012345678901234567890123456';
/** Three commits of one row, newest first: the order the Board's commits row shows them. */
const rowOfThree = () => {
  const first = makeCommitDetail({ at: minutesAgo(10) });
  const second = makeCommitDetail({ sha: SHA_B, shortSha: 'b2c3d4e', subject: 'Add CSV stream formatter', author: 'Bob', at: minutesAgo(20), body: 'Streams rows through the formatter.', files: [{ path: 'src/stream.ts', status: 'added', additions: 30, deletions: 0 }], additions: 30, deletions: 0 });
  const third = makeCommitDetail({ sha: SHA_C, shortSha: 'c3d4e5f', subject: 'Test the CSV formatter', author: 'Carol', at: minutesAgo(30), body: '', files: [{ path: 'src/stream.test.ts', status: 'added', additions: 12, deletions: 0 }], additions: 12, deletions: 0 });
  return { first, second, third };
};

test.describe('Commit cards open the Code window on that commit', () => {
  test('a commit card opens Commits mode: the description stays in view while a later file\'s diff is shown, and the reader is not used', async ({ page }) => {
    const detail = makeCommitDetail();
    await setupCommitBoard(page, detail);

    const card = commitCardOf(page, 'Write the CSV writer');
    // Surface press (the top line of the card), as the old reader test did
    await card.locator('article').click({ position: { x: 12, y: 12 } });

    await expect(win(page)).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
    await expect(modeButton(page, 'Commits')).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton(page, 'Not committed')).toHaveAttribute('aria-pressed', 'false');
    // Review & commit, Finish and Sync belong to uncommitted work, not to a past commit
    await expect(win(page).getByRole('button', { name: 'Review & commit' })).toHaveCount(0);
    await expect(win(page).getByRole('button', { name: 'Finish…' })).toHaveCount(0);
    await expect(win(page).getByRole('button', { name: 'More code actions' })).toHaveCount(0);

    // The header: subject, byline, short sha, repository, pushed or not, the step it belongs to
    const header = commitHeader(page);
    await expect(header.getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await expect(header).toContainText(`by ${detail.author}`);
    await expect(header.getByRole('button', { name: `Copy SHA ${detail.shortSha}` })).toBeVisible();
    await expect(header.getByTestId('commit-repo')).toHaveText('billing');
    await expect(header.getByTestId('commit-pushed')).toHaveText('not pushed');
    await expect(header.getByRole('link')).toHaveCount(0);
    await expect(header.getByTestId('commit-steps')).toContainText('Reports export to CSV');
    await expect(header.getByTestId('commit-body')).toContainText('Implements CSV streaming for large datasets.');
    await expect(header.getByTestId('commit-body')).toBeInViewport();

    // The tree lists this commit's files with the numbers and the status; it opens on the first one
    const tree = win(page).getByRole('tree', { name: 'Files changed in this commit' });
    await expect(tree).toBeVisible();
    await expect(win(page).getByTestId('commit-file-count')).toHaveText('4 files changed');
    await expect(tree.getByRole('treeitem', { name: /export\.ts/ })).toContainText('+12 −4');
    await expect(tree.getByRole('treeitem', { name: /new\.ts/ })).toContainText('+5');
    await expect(tree.getByRole('treeitem', { name: /sample\.bin/ })).toContainText('binary');
    await expect(tree.getByRole('treeitem', { name: /new\.ts/ })).toContainText('R');
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('1 / 4');

    // A later file's diff is shown with the whole header still on the first screen
    await tree.getByRole('treeitem', { name: /export\.ts/ }).click();
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('2 / 4');
    await expect(win(page).locator('.monaco-diff-editor, [data-testid="fallback-diff"]').first()).toBeVisible();
    await expect(header.getByTestId('commit-subject')).toBeInViewport();
    await expect(header.getByTestId('commit-body')).toBeInViewport();
    const [headerBox, diffBox] = [await header.boundingBox(), await win(page).locator('.monaco-diff-editor, [data-testid="fallback-diff"]').first().boundingBox()];
    expect(diffBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);
    // The diff keeps real room: more than a third of the window's height
    expect(diffBox!.height).toBeGreaterThan(200);
  });

  test('pointer, keyboard and browser Back: Escape, Back to the Board and Back return the keyboard to the card that opened it', async ({ page }) => {
    await setupCommitBoard(page, makeCommitDetail());
    const button = commitButtonOf(page, 'Write the CSV writer');

    await button.focus();
    await page.keyboard.press('Enter');
    await expect(win(page)).toBeVisible();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await page.keyboard.press('Escape');
    await expect(win(page)).toBeHidden();
    await expect(button).toBeFocused();

    await button.click();
    await expect(win(page)).toBeVisible();
    await win(page).getByRole('button', { name: 'Back to the Board' }).click();
    await expect(win(page)).toBeHidden();
    await expect(button).toBeFocused();

    await button.click();
    await expect(win(page)).toBeVisible();
    await page.goBack();
    await expect(win(page)).toBeHidden();
    await expect(button).toBeFocused();
  });

  test('a long description folds to a few lines with More, and the file list and diff keep their room', async ({ page }) => {
    await setupCommitBoard(page, makeCommitDetail());
    await commitButtonOf(page, 'Write the CSV writer').click();
    const body = commitHeader(page).getByTestId('commit-body');
    const more = commitHeader(page).getByRole('button', { name: 'More', exact: true });
    await expect(more).toBeVisible();
    const folded = await body.boundingBox();
    expect(folded!.height).toBeLessThan(70);
    await more.click();
    await expect(commitHeader(page).getByRole('button', { name: 'Less', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toContainText('Rare case: an empty report still writes the header row.');
    // Still inside the window: the header never grows past what leaves the diff a place
    const [header, window] = [await commitHeader(page).boundingBox(), await win(page).boundingBox()];
    expect(header!.height).toBeLessThan(window!.height * 0.5);
  });

  test('[ and ] move through the commits of the row in the order it shows them, and stop at the ends', async ({ page }) => {
    const { first, second, third } = rowOfThree();
    await setupCommitBoard(page, first, [second, third]);

    await commitButtonOf(page, 'Add CSV stream formatter').click();
    const subject = commitHeader(page).getByTestId('commit-subject');
    const position = commitHeader(page).getByTestId('commit-position');
    await expect(subject).toHaveText('Add CSV stream formatter');
    await expect(position).toHaveText('2 of 3 · Reports export to CSV');
    await expect(win(page).getByTestId('commit-file-count')).toHaveText('1 file changed');
    await expect(win(page).getByTestId('commit-file-position')).toHaveCount(0);
    await expect(openFileName(page)).toContainText('stream.ts');

    await page.keyboard.press(']');
    await expect(subject).toHaveText('Test the CSV formatter');
    await expect(position).toHaveText('3 of 3 · Reports export to CSV');
    await expect(commitHeader(page).getByRole('button', { name: 'Next commit' })).toBeDisabled();
    // At the end ] does nothing, and the keyboard stays in the window
    await page.keyboard.press(']');
    await expect(subject).toHaveText('Test the CSV formatter');
    await expect(win(page)).toBeVisible();

    await page.keyboard.press('[');
    await page.keyboard.press('[');
    await expect(subject).toHaveText('Write the CSV writer');
    await expect(position).toHaveText('1 of 3 · Reports export to CSV');
    await expect(commitHeader(page).getByRole('button', { name: 'Previous commit' })).toBeDisabled();
    await page.keyboard.press('[');
    await expect(subject).toHaveText('Write the CSV writer');
    // Each move opens that commit's own first file
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('1 / 4');

    // The visible buttons do the same
    await commitHeader(page).getByRole('button', { name: 'Next commit' }).click();
    await expect(subject).toHaveText('Add CSV stream formatter');

    // Neither key moves the Board or a reader behind the window
    await page.keyboard.press('Escape');
    await expect(win(page)).toBeHidden();
    await expect(reader(page)).toHaveCount(0);
    await expect(commitButtonOf(page, 'Add CSV stream formatter')).toBeFocused();
  });

  test('the list opens another commit, with the row first and the other recent commits of each repository after it', async ({ page }) => {
    const { first, second } = rowOfThree();
    const other = makeCommitDetail({ repo: 'api', sha: 'e5f6a7b8c9d012345678901234567890123456ab', shortSha: 'e5f6a7b', subject: 'Add the export endpoint', author: 'Dana', at: minutesAgo(15), body: 'The endpoint streams CSV.', files: [{ path: 'api/endpoint.ts', status: 'added', additions: 8, deletions: 0 }], additions: 8, deletions: 0 });
    // The api commit is in the recent commits only (not in the Board's row)
    await setupCommitBoard(page, first, [second, other], undefined, {
      recent: [
        { repo: 'billing', commits: [first, second].map((c) => ({ sha: c.sha, author: c.author, subject: c.subject, at: c.at })) },
        { repo: 'api', commits: [{ sha: other.sha, author: other.author, subject: other.subject, at: other.at }] },
      ],
    });
    // the Board draws the news too, so make the api commit visible only to the list
    await page.unroute('**/api/workspace/demo/news');
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'billing', more: 0, commits: [first, second].map((c) => ({ sha: c.sha, author: c.author, subject: c.subject, at: c.at })) }] }) }));
    await page.reload();
    await stepIntoArea(page, /Reports export to CSV/);

    await commitButtonOf(page, 'Write the CSV writer').click();
    const subject = commitHeader(page).getByTestId('commit-subject');
    await expect(subject).toHaveText('Write the CSV writer');

    await commitHeader(page).getByRole('button', { name: 'Choose a commit' }).click();
    const choices = page.getByTestId('commit-choice');
    await expect(page.getByRole('menu')).toContainText('Reports export to CSV');
    await expect(choices.first()).toContainText('Write the CSV writer');
    await expect(page.getByRole('menu')).toContainText('Other recent commits in api');
    await choices.filter({ hasText: 'Add the export endpoint' }).click();
    await expect(subject).toHaveText('Add the export endpoint');
    await expect(commitHeader(page).getByTestId('commit-repo')).toHaveText('api');
    await expect(win(page).getByTestId('commit-file-count')).toHaveText('1 file changed');
    // A commit chosen from the list moves through its repository's recent commits
    await expect(commitHeader(page).getByTestId('commit-position')).toHaveText('1 of 1 · api');
    await expect(commitHeader(page).getByRole('button', { name: 'Next commit' })).toBeDisabled();
  });

  test('opened without a row (the Commits button of the Code window), it lists recent commits and opens the newest; Changes and Files are unchanged', async ({ page }) => {
    const { first, second, third } = rowOfThree();
    await setupCommitBoard(page, first, [second, third]);

    await page.getByTestId('board-code-button').click();
    await expect(win(page)).toBeVisible();
    // The Code button opens on the uncommitted work, as before
    await expect(modeButton(page, 'Not committed')).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton(page, 'Commits')).toHaveAttribute('aria-pressed', 'false');
    await expect(win(page).getByRole('button', { name: 'Review & commit' })).toBeVisible();
    await expect(win(page).getByRole('tree', { name: 'billing changed files' })).toBeVisible();

    await modeButton(page, 'Commits').click();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await expect(commitHeader(page).getByTestId('commit-position')).toHaveText('1 of 3 · billing');
    await page.keyboard.press(']');
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Add CSV stream formatter');

    // Back to Not committed: the working tree and its actions
    await modeButton(page, 'Not committed').click();
    await expect(win(page).getByRole('button', { name: 'Review & commit' })).toBeVisible();
    await expect(win(page).getByRole('tree', { name: 'billing changed files' })).toBeVisible();
    // and Commits again finds the commit where it was left
    await modeButton(page, 'Commits').click();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Add CSV stream formatter');

    // Closing and pressing the Review button again opens the working tree, not the commit
    await page.keyboard.press('Escape');
    await expect(win(page)).toBeHidden();
    await page.getByTestId('board-code-button').click();
    await expect(modeButton(page, 'Not committed')).toHaveAttribute('aria-pressed', 'true');
    await expect(win(page).getByRole('button', { name: 'Review & commit' })).toBeVisible();
  });

  test('a refresh of the board and the news while a commit is open keeps the commit, the file, the mode and the keyboard', async ({ page }) => {
    await page.clock.install();
    const { first, second, third } = rowOfThree();
    await setupCommitBoard(page, first, [second, third]);

    await commitButtonOf(page, 'Write the CSV writer').click();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await win(page).getByRole('treeitem', { name: /export\.ts/ }).click();
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('2 / 4');
    const next = commitHeader(page).getByRole('button', { name: 'Next commit' });
    await next.focus();
    await expect(next).toBeFocused();

    // The news, the recent commits and the board change (a newer commit arrives, so the row is longer); every query is stale and asked again
    const newest = makeCommitDetail({ sha: 'd4e5f6a7b8c901234567890123456789012345ab', shortSha: 'd4e5f6a', subject: 'A newer commit that arrived meanwhile', at: minutesAgo(1) });
    const all = [newest, first, second, third].map((c) => ({ sha: c.sha, author: c.author, subject: c.subject, at: c.at }));
    await page.unroute('**/api/workspace/demo/news');
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'billing', more: 0, commits: all }] }) }));
    await page.unroute('**/api/workspace/demo/recent-commits');
    await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({ json: { at: new Date().toISOString(), from: minutesAgo(4000), commits: [{ repo: 'billing', more: 0, commits: all }] } }));
    const asked = Promise.all([page.waitForResponse('**/api/workspace/demo/news'), page.waitForResponse('**/api/workspace/demo/recent-commits')]);
    await page.clock.fastForward('02:00');
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); });
    await asked;
    // Let the page take the answers in
    await page.clock.fastForward('00:05');

    await expect(win(page)).toBeVisible();
    await expect(modeButton(page, 'Commits')).toHaveAttribute('aria-pressed', 'true');
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('2 / 4');
    // The row it was opened from is kept as it was, and so is the keyboard
    await expect(commitHeader(page).getByTestId('commit-position')).toHaveText('1 of 3 · Reports export to CSV');
    await expect(next).toBeFocused();
    // The list now knows the new commit (the one list that is meant to follow the news)
    await commitHeader(page).getByRole('button', { name: 'Choose a commit' }).click();
    await expect(page.getByRole('menu')).toContainText('A newer commit that arrived meanwhile');
  });

  test('text typed in the Finish form (and the commit message) in Changes survives a trip to Commits and back', async ({ page }) => {
    const { first, second } = rowOfThree();
    await setupCommitBoard(page, first, [second], undefined, { finish: true });

    await page.getByTestId('board-code-button').click();
    await expect(win(page)).toBeVisible();
    await win(page).getByRole('button', { name: 'Finish…' }).click();
    const message = win(page).locator('#finish-message');
    await expect(message).toBeVisible();
    await message.fill('Ship the CSV export');
    // Typing [ and ] in a form is typing: it never moves anything
    await message.pressSequentially(' [] ok');
    await modeButton(page, 'Commits').click();
    await expect(commitHeader(page).getByTestId('commit-subject')).toBeVisible();
    await expect(win(page).locator('#finish-message')).toHaveCount(0);
    await modeButton(page, 'Not committed').click();
    await expect(win(page).locator('#finish-message')).toHaveValue('Ship the CSV export [] ok');

    // The commit message of the commit form is kept the same way
    await win(page).getByRole('button', { name: 'Review & commit' }).click();
    const commitMessage = win(page).getByRole('textbox').first();
    await commitMessage.fill('feat: the writer');
    await modeButton(page, 'Commits').click();
    await modeButton(page, 'Not committed').click();
    await expect(win(page).getByRole('textbox').first()).toHaveValue('feat: the writer');
  });

  const finishReport = (fields: Record<string, unknown>) => ({
    policy: { ready: true, repos: [], blockers: [] }, blocked: false, dryRun: false, repos: [], safeToCleanup: false, ...fields,
  });
  const billingRepo = (fields: Record<string, unknown> = {}) => ({ name: 'billing', committed: true, commitHash: 'abc1234', pushed: true, branch: 'feat/x', remoteUrl: null, ...fields });

  for (const scenario of [
    { name: 'a refused finish (409, blocked)', status: 409, report: finishReport({ blocked: true, policy: { ready: false, repos: [], blockers: ['Verification failed.'] } }), kept: true },
    { name: 'a partial finish where a repository failed (200 with an error)', status: 200, report: finishReport({ repos: [billingRepo({ committed: false, pushed: false, error: 'commit failed' })] }), kept: true },
    { name: 'a finish that committed everything', status: 200, report: finishReport({ repos: [billingRepo()] }), kept: false },
  ]) {
    test(`Finish text after ${scenario.name} is ${scenario.kept ? 'kept for the next try' : 'cleared'}`, async ({ page }) => {
      const { first, second } = rowOfThree();
      await setupCommitBoard(page, first, [second], undefined, { finish: true });
      await page.route('**/api/workspace/demo/finish', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: scenario.status, json: scenario.report }) : route.fallback()));
      await page.getByTestId('board-code-button').click();
      await win(page).getByRole('button', { name: 'Finish…' }).click();
      const message = win(page).locator('#finish-message');
      await message.fill('Ship the CSV export');
      const answered = page.waitForResponse((r) => r.url().endsWith('/finish') && r.request().method() === 'POST');
      await win(page).getByRole('button', { name: 'Finish', exact: true }).click();
      await answered;
      await expect(win(page).getByRole('region', { name: 'Review commit' })).toHaveCount(0);
      await page.waitForTimeout(600);
      if (scenario.kept) await expect(message).toHaveValue('Ship the CSV export');
      else await expect(message).toHaveValue('');
      // and it is the same after a trip to Commits and back
      await modeButton(page, 'Commits').click();
      await modeButton(page, 'Not committed').click();
      await expect(win(page).locator('#finish-message')).toHaveValue(scenario.kept ? 'Ship the CSV export' : '');
    });
  }

  test('after a push the commit header says pushed and shows the forge link, without moving commit or file', async ({ page }) => {
    const unpushed = makeCommitDetail({ pushed: false, webUrl: null, forge: null });
    await setupCommitBoard(page, unpushed, [], undefined, { finish: true });
    await commitButtonOf(page, 'Write the CSV writer').click();
    await expect(commitHeader(page).getByTestId('commit-pushed')).toHaveText('not pushed');
    await win(page).getByRole('treeitem', { name: /export\.ts/ }).click();
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('2 / 4');
    // The commit gets pushed (a Finish elsewhere); the server now answers pushed
    const pushed = makeCommitDetail({ pushed: true, forge: 'github', webUrl: `https://github.com/org/billing/commit/${FULL_SHA}` });
    await page.route('**/api/workspace/demo/commits/billing/*', (route) => (route.request().url().includes('/diff') ? route.fallback() : route.fulfill({ json: pushed })));
    await page.route('**/api/workspace/demo/finish', (route) => (route.request().method() === 'POST' ? route.fulfill({ json: finishReport({ repos: [billingRepo()] }) }) : route.fallback()));
    await modeButton(page, 'Not committed').click();
    await win(page).getByRole('button', { name: 'Finish…' }).click();
    await win(page).locator('#finish-message').fill('Ship it');
    const answered = page.waitForResponse((r) => r.url().endsWith('/finish') && r.request().method() === 'POST');
    await win(page).getByRole('button', { name: 'Finish', exact: true }).click();
    await answered;
    await page.waitForTimeout(600);
    await modeButton(page, 'Commits').click();
    await expect(commitHeader(page).getByTestId('commit-pushed')).toHaveText('pushed');
    await expect(commitHeader(page).getByRole('link', { name: 'Open commit on GitHub' })).toBeVisible();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('2 / 4');
  });

  test('after a push made outside the app (the AI in the terminal), reopening the commit says pushed', async ({ page }) => {
    const detail = makeCommitDetail();
    await setupCommitBoard(page, detail);
    const button = commitButtonOf(page, 'Write the CSV writer');
    await button.click();
    await expect(commitHeader(page).getByTestId('commit-pushed')).toHaveText('not pushed');
    await page.keyboard.press('Escape');
    await expect(win(page)).toBeHidden();
    // Pushed from the terminal: nothing in the app was told
    detail.pushed = true; detail.forge = 'github'; detail.webUrl = `https://github.com/org/billing/commit/${detail.sha}`;
    await button.click();
    await expect(commitHeader(page).getByTestId('commit-pushed')).toHaveText('pushed');
    await expect(commitHeader(page).getByRole('link', { name: 'Open commit on GitHub' })).toBeVisible();
  });

  test('a failed fresh read of a commit that is already shown keeps showing it', async ({ page }) => {
    await setupCommitBoard(page, makeCommitDetail());
    const button = commitButtonOf(page, 'Write the CSV writer');
    await button.click();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await page.keyboard.press('Escape');
    await expect(win(page)).toBeHidden();
    let failed = 0;
    await page.route('**/api/workspace/demo/commits/billing/*', (route) => {
      if (route.request().url().includes('/diff')) return route.fallback();
      failed += 1;
      return route.fulfill({ status: 500, json: { error: 'Could not read this commit.' } });
    });
    await button.click();
    await expect(win(page)).toBeVisible();
    await expect.poll(() => failed).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await expect(win(page).getByRole('alert')).toHaveCount(0);
  });

  test('after [ and ] Escape returns the keyboard to the card of the commit shown, when it is drawn; else to the card that opened the window', async ({ page }) => {
    const { first, second, third } = rowOfThree();
    await setupCommitBoard(page, first, [second, third]);
    await commitButtonOf(page, 'Add CSV stream formatter').click();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Add CSV stream formatter');
    await page.keyboard.press(']');
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Test the CSV formatter');
    await page.keyboard.press('Escape');
    await expect(win(page)).toBeHidden();
    await expect(commitButtonOf(page, 'Test the CSV formatter')).toBeFocused();
    // Back on the commit it was opened from: the opener
    await commitButtonOf(page, 'Add CSV stream formatter').click();
    await page.keyboard.press(']');
    await page.keyboard.press('[');
    await page.keyboard.press('Escape');
    await expect(commitButtonOf(page, 'Add CSV stream formatter')).toBeFocused();
  });

  test('the reader\'s [ and ] skip commits: only the pictures and documents of the Area are in its sequence', async ({ page }) => {
    const { first, second } = rowOfThree();
    await setupCommitBoard(page, first, [second], undefined, {
      cards: [boardFileCard(1, 'board-pictures/export.png', { title: 'Export picture' })],
    });
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({ json: { name: 'board-pictures/export.png', kind: 'image', size: PICTURE_PNG.length, modifiedAt: new Date().toISOString() } }));
    await board(page).locator('#board-area').getByRole('button', { name: /Export picture/ }).first().click();
    await expect(reader(page)).toBeVisible();
    // One picture and two commits in the Area: before this change the reader counted three; now it has one thing to read
    await expect(reader(page).getByRole('group', { name: 'Item navigation' })).toHaveCount(0);
    await page.keyboard.press(']');
    await expect(reader(page).getByRole('heading', { level: 2 })).toHaveText('Export picture');
  });

  test('the same short SHA in two repositories stays two commits: each card opens its own', async ({ page }) => {
    const billing = makeCommitDetail({ at: minutesAgo(10) });
    const api = makeCommitDetail({ repo: 'api', subject: 'Add the API route', author: 'Dana', at: minutesAgo(12), body: 'Route for the API.', files: [{ path: 'api/route.ts', status: 'added', additions: 9, deletions: 0 }], additions: 9, deletions: 0 });
    // Same SHA, different repository
    expect(api.sha).toBe(billing.sha);
    await setupCommitBoard(page, billing, [api]);

    await commitButtonOf(page, 'Add the API route').click();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Add the API route');
    await expect(commitHeader(page).getByTestId('commit-repo')).toHaveText('api');
    await expect(win(page).getByTestId('commit-file-count')).toHaveText('1 file changed');
    // The row it came from holds only its own repository's commit
    await expect(commitHeader(page).getByTestId('commit-position')).toHaveText('1 of 1 · Reports export to CSV');
    await page.keyboard.press('Escape');
    await expect(win(page)).toBeHidden();

    await commitButtonOf(page, 'Write the CSV writer').click();
    await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Write the CSV writer');
    await expect(commitHeader(page).getByTestId('commit-repo')).toHaveText('billing');
    await expect(win(page).getByTestId('commit-file-count')).toHaveText('4 files changed');
  });

  test('a pushed commit has a forge link; the sha copies and says so; an unpushed one has no link', async ({ page }) => {
    const forges: Array<{ kind: CommitDetail['forge']; name: string; url: string }> = [
      { kind: 'github', name: 'GitHub', url: 'https://github.com/org/billing/commit/' + FULL_SHA },
      { kind: 'gitlab', name: 'GitLab', url: 'https://gitlab.com/org/billing/-/commit/' + FULL_SHA },
      { kind: 'azure', name: 'Azure DevOps', url: 'https://dev.azure.com/org/billing/_git/commit/' + FULL_SHA },
      { kind: 'bitbucket', name: 'Bitbucket', url: 'https://bitbucket.org/org/billing/commits/' + FULL_SHA },
    ];
    await setupCommitBoard(page, makeCommitDetail({ pushed: false, webUrl: null, forge: null }));
    const open = commitButtonOf(page, 'Write the CSV writer');
    await open.click();
    await expect(commitHeader(page).getByTestId('commit-pushed')).toHaveText('not pushed');
    await expect(commitHeader(page).getByRole('link')).toHaveCount(0);
    await commitHeader(page).getByRole('button', { name: `Copy SHA ${SHORT_SHA}` }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([FULL_SHA]);
    await expect(commitHeader(page).getByRole('status')).toHaveText('SHA copied');

    for (const forge of forges) {
      const pushed = makeCommitDetail({ pushed: true, forge: forge.kind, webUrl: forge.url });
      await page.route('**/api/workspace/demo/commits/billing/*', (route) => (route.request().url().includes('/diff') ? route.fallback() : route.fulfill({ json: pushed })));
      await page.keyboard.press('Escape');
      await expect(win(page)).toBeHidden();
      // A fresh page, so the commit is read again
      await page.reload();
      await stepIntoArea(page, /Reports export to CSV/);
      await commitButtonOf(page, 'Write the CSV writer').click();
      const link = commitHeader(page).getByRole('link', { name: `Open commit on ${forge.name}` });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', forge.url);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(commitHeader(page).getByTestId('commit-pushed')).toHaveText('pushed');
    }
  });

  test('a commit that cannot be read says so with Retry, and the other commits still open', async ({ page }) => {
    const { first, second } = rowOfThree();
    await setupCommitBoard(page, first, [second]);
    await page.route(`**/api/workspace/demo/commits/billing/${SHA_B}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', json: { error: 'Could not read this commit.' } }));

    await commitButtonOf(page, 'Add CSV stream formatter').click();
    const alert = win(page).getByRole('alert');
    await expect(alert).toContainText('Could not read this commit.');
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(modeButton(page, 'Commits')).toHaveAttribute('aria-pressed', 'true');
    await expect(win(page).getByRole('button', { name: 'Back to the Board' })).toBeVisible();
    // Review is still usable: the Not committed mode and the other commit
    await modeButton(page, 'Not committed').click();
    await expect(win(page).getByRole('tree', { name: 'billing changed files' })).toBeVisible();
  });

  test('plain patch, binary files and oversized diffs in Commits mode; Next file moves down the tree', async ({ page }) => {
    const detail = makeCommitDetail();
    await setupCommitBoard(page, detail, [], (file) => {
      if (file === 'unchanged.txt') {
        return { repo: 'billing', repoPath: '/tmp/demo/billing', sha: FULL_SHA, file: 'unchanged.txt', diff: '', fileContent: '', originalContent: '', symbols: [], diffOmitted: true, contentOmitted: 'too-large' };
      }
      return undefined;
    });
    await commitButtonOf(page, 'Write the CSV writer').click();
    const tree = win(page).getByRole('tree', { name: 'Files changed in this commit' });

    await tree.getByRole('treeitem', { name: /export\.ts/ }).click();
    const diffToolbar = win(page).getByRole('toolbar', { name: 'Diff' });
    await expect(diffToolbar).toBeVisible();
    await expect(diffToolbar).toContainText('Change 1 of 1');

    // A menu of the diff takes Escape for itself: the window stays
    await diffToolbar.getByRole('button', { name: 'More diff options' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(win(page)).toBeVisible();
    await diffToolbar.getByRole('button', { name: 'More diff options' }).click();
    await menuCheckboxItem(page, 'Plain patch view').click();
    await page.keyboard.press('Escape');
    const fallbackDiff = win(page).getByTestId('fallback-diff');
    await expect(fallbackDiff).toContainText('old export line 1');
    await expect(fallbackDiff).toContainText('new export line 1');
    await expect(fallbackDiff.locator('[data-diff-marker="-"]').first()).toBeVisible();
    await expect(fallbackDiff.locator('[data-diff-marker="+"]').first()).toBeVisible();

    // The viewer's Next file steps down the tree and opens that file
    await diffToolbar.getByRole('button', { name: 'Next file' }).click();
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('3 / 4');

    await tree.getByRole('treeitem', { name: /sample\.bin/ }).click();
    await expect(win(page).getByRole('note')).toHaveText(/binary file/i);
    await expect(win(page).getByText(/Binary files.*differ/)).toBeVisible();
    await expect(win(page).getByRole('toolbar', { name: 'Diff' })).toHaveCount(0);

    await tree.getByRole('treeitem', { name: /unchanged\.txt/ }).click();
    await expect(win(page).getByRole('note')).toHaveText(/diff is too large to display/i);
    await expect(win(page).getByRole('toolbar', { name: 'Diff' })).toHaveCount(0);
  });

  test('Commits mode fills the full frame with no Full screen button, and Escape returns to the commit card', async ({ page }) => {
    await setupCommitBoard(page, makeCommitDetail());
    await commitButtonOf(page, 'Write the CSV writer').click();
    await win(page).getByRole('treeitem', { name: /export\.ts/ }).click();
    await expect(win(page).getByTestId('commit-file-position')).toHaveText('2 / 4');
    await expect(win(page).getByRole('button', { name: /Full screen|Exit full screen/i })).toHaveCount(0);
    await expect(commitHeader(page).getByTestId('commit-subject')).toBeInViewport();
    const coverBox = await page.locator('[data-code-window-backdrop]').boundingBox();
    const winBox = await win(page).boundingBox();
    expect(winBox!.width).toBeCloseTo(coverBox!.width, 0);
    expect(winBox!.height).toBeCloseTo(coverBox!.height, 0);
    await page.keyboard.press('Escape');
    await expect(win(page)).toBeHidden();
    await expect(commitButtonOf(page, 'Write the CSV writer')).toBeFocused();
  });
});
