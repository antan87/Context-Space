import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  boardFile,
  checkpoint,
  planFile,
  step,
  whatsNew,
} from './planData';
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

test.use({
  workspacesData: [[workspace], { option: true }],
  viewport: { width: 1280, height: 800 },
});

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
    body: 'Implements CSV streaming for large datasets.\nHandles chunked encoding and gzip compression.',
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
const readerTitle = (page: Page, name: string) => reader(page).getByRole('heading', { name, level: 2, exact: true });
const moreButton = (page: Page) => reader(page).getByRole('button', { name: 'More actions', exact: true });
const closeButton = (page: Page) => reader(page).getByRole('button', { name: 'Close', exact: true });
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

async function stepIntoArea(page: Page, name: string | RegExp = /Reports export to CSV/) {
  const areaBtn = board(page).locator('.board-overview-plane button.board-area').filter({ hasText: name });
  await areaBtn.click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
}

async function setupCommitBoard(page: Page, commitDetail: CommitDetail, extraCommits: CommitDetail[] = []) {
  const allCommits = [commitDetail, ...extraCommits];
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

  await page.route('**/api/workspace/demo/news', (route) =>
    route.fulfill({
      json: whatsNew({
        commits: [
          {
            repo: 'billing',
            more: 0,
            commits: allCommits.map((c) => ({
              sha: c.sha,
              author: c.author,
              subject: c.subject,
              at: c.at,
            })),
          },
        ],
      }),
    }),
  );

  await page.route('**/api/workspace/demo/board', (route) =>
    route.fulfill({
      json: boardFile({
        cards: [],
        links: [],
      }),
    }),
  );

  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const url = route.request().url();
    const matched = allCommits.find((c) => url.endsWith(`/${c.sha}`) || url.endsWith(`/${c.repo}/${c.sha}`));
    return route.fulfill({ json: matched ?? commitDetail });
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

  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);
}

test.describe('Commit cards in quiet reader', () => {
  test('opens quiet reader on card click and keyboard with expected calm structure', async ({ page }) => {
    const detail = makeCommitDetail();
    await setupCommitBoard(page, detail);

    const commitCard = board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Write the CSV writer' });
    const commitButton = commitCard.getByRole('button', { name: 'Open Write the CSV writer' });
    const commitArticle = commitCard.locator('article');

    // 1. Surface click via brickPress (clicking top metadata area of the card)
    await commitArticle.click({ position: { x: 12, y: 12 } });

    await expect(reader(page)).toBeVisible();
    await expect(readerTitle(page, 'Write the CSV writer')).toBeVisible();
    await expect(commitArticle).toHaveAttribute('aria-current', 'true');

    // Verify reader header has ONLY 2 buttons and ZERO links
    const header = reader(page).locator('header');
    await expect(header.getByRole('button')).toHaveCount(2);
    await expect(header.getByRole('button').nth(0)).toHaveAccessibleName('More actions');
    await expect(header.getByRole('button').nth(1)).toHaveAccessibleName('Close');
    await expect(header.getByRole('link')).toHaveCount(0);
    await expect(header).toContainText(`billing · ${detail.shortSha.slice(0, 7)}`);

    // ZERO extra buttons anywhere in the entire reader
    await expect(reader(page).getByRole('button')).toHaveCount(2);

    // Verify commit byline, full subject, and multi-line body
    await expect(reader(page).getByText(`by ${detail.author}`)).toBeVisible();
    await expect(reader(page).locator('code', { hasText: detail.shortSha })).toBeVisible();
    await expect(reader(page).getByText('Implements CSV streaming for large datasets.')).toBeVisible();
    await expect(reader(page).getByText('Handles chunked encoding and gzip compression.')).toBeVisible();

    // Verify changed files section
    await expect(reader(page).getByRole('heading', { name: '4 files changed' })).toBeVisible();
    const filesList = reader(page).getByRole('list', { name: 'Changed files' });
    await expect(filesList).toBeVisible();

    // File 1: src/export.ts with +12 and −4
    await expect(filesList.getByText('src/export.ts')).toBeVisible();
    await expect(filesList.locator('li', { hasText: 'src/export.ts' }).getByText('+12')).toBeVisible();
    await expect(filesList.locator('li', { hasText: 'src/export.ts' }).getByText('−4')).toBeVisible();
    await expect(filesList.locator('li', { hasText: 'src/export.ts' })).not.toContainText('modified');

    // File 2: old.ts → new.ts, status renamed, +5
    await expect(filesList.getByText('old.ts → new.ts')).toBeVisible();
    await expect(filesList.locator('li', { hasText: 'old.ts → new.ts' }).getByText('renamed')).toBeVisible();
    await expect(filesList.locator('li', { hasText: 'old.ts → new.ts' }).getByText('+5')).toBeVisible();

    // File 3: assets/sample.bin, status added, binary
    await expect(filesList.getByText('assets/sample.bin')).toBeVisible();
    await expect(filesList.locator('li', { hasText: 'assets/sample.bin' }).getByText('added')).toBeVisible();
    await expect(filesList.locator('li', { hasText: 'assets/sample.bin' }).getByText('binary')).toBeVisible();

    // File 4: unchanged.txt, zero counts omitted
    await expect(filesList.getByText('unchanged.txt')).toBeVisible();
    const unchangedRow = filesList.locator('li', { hasText: 'unchanged.txt' });
    await expect(unchangedRow.getByText('+0')).toHaveCount(0);
    await expect(unchangedRow.getByText('−0')).toHaveCount(0);

    // Close reader and test keyboard open
    await closeButton(page).click();
    await expect(reader(page)).toHaveCount(0);

    await commitButton.focus();
    await page.keyboard.press('Enter');
    await expect(reader(page)).toBeVisible();
    await expect(readerTitle(page, 'Write the CSV writer')).toBeVisible();
    await expect(commitArticle).toHaveAttribute('aria-current', 'true');
  });

  test('plan step and picture links open in the reader', async ({ page }) => {
    const detail = makeCommitDetail();
    await setupCommitBoard(page, detail);

    const commitCard = board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Write the CSV writer' });
    const commitButton = commitCard.getByRole('button', { name: 'Open Write the CSV writer' });

    await commitButton.click();
    await expect(reader(page)).toBeVisible();

    // Verify step link and picture link exist
    const stepLink = reader(page).getByRole('link', { name: /Reports export to CSV/ });
    const pictureLink = reader(page).getByRole('link', { name: 'export.png', exact: true });
    await expect(stepLink).toBeVisible();
    await expect(pictureLink).toBeVisible();

    // Click picture link -> reader displays the image
    await pictureLink.click();
    await expect(readerTitle(page, 'export.png')).toBeVisible();
    await expect(reader(page).locator('img')).toBeVisible();

    // Close picture view and reopen commit card
    await closeButton(page).click();
    await expect(reader(page)).toHaveCount(0);
    await commitButton.click();
    await expect(readerTitle(page, 'Write the CSV writer')).toBeVisible();

    // Click plan step link -> reader displays PLAN.md
    await reader(page).getByRole('link', { name: /Reports export to CSV/ }).click();
    await expect(readerTitle(page, 'PLAN.md')).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'Reports CSV export', level: 1 })).toBeVisible();
  });

  test('handles unpushed vs pushed ⋯ menu (Copy sha and Open on <forge>)', async ({ page }) => {
    // 1. Unpushed commit
    const unpushedDetail = makeCommitDetail({ pushed: false, webUrl: null, forge: null });
    await setupCommitBoard(page, unpushedDetail);

    const commitCard = board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Write the CSV writer' });
    await commitCard.getByRole('button', { name: 'Open Write the CSV writer' }).click();
    await expect(reader(page)).toBeVisible();

    await moreButton(page).click();
    await expect(page.getByRole('menu')).toBeVisible();
    const menuItems = await page.getByRole('menuitem').allTextContents();
    const trimmedItems = menuItems.map((s) => s.trim());
    expect(trimmedItems).toEqual(['Show beside the board', 'Copy sha']);

    // Copy sha copies 40-char SHA and announces in role="status"
    await menuItem(page, 'Copy sha').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([FULL_SHA]);
    await expect(reader(page).getByRole('status')).toHaveText('SHA copied');
    await expect(moreButton(page).locator('svg.lucide-check')).toBeVisible();

    // 2. Test pushed forge variations
    const forges: Array<{ kind: CommitDetail['forge']; name: string; url: string }> = [
      { kind: 'github', name: 'Open on GitHub', url: 'https://github.com/org/billing/commit/' + FULL_SHA },
      { kind: 'gitlab', name: 'Open on GitLab', url: 'https://gitlab.com/org/billing/-/commit/' + FULL_SHA },
      { kind: 'azure', name: 'Open on Azure DevOps', url: 'https://dev.azure.com/org/billing/_git/commit/' + FULL_SHA },
      { kind: 'bitbucket', name: 'Open on Bitbucket', url: 'https://bitbucket.org/org/billing/commits/' + FULL_SHA },
    ];

    for (const forge of forges) {
      const pushedDetail = makeCommitDetail({ pushed: true, forge: forge.kind, webUrl: forge.url });
      await page.route('**/api/workspace/demo/commits/**', (route) => route.fulfill({ json: pushedDetail }));

      // Re-trigger commit fetch by closing and reopening
      await closeButton(page).click();
      await commitCard.getByRole('button', { name: 'Open Write the CSV writer' }).click();
      await expect(reader(page)).toBeVisible();

      await moreButton(page).click();
      await expect(page.getByRole('menu')).toBeVisible();
      const forgeItem = menuItem(page, forge.name);
      await expect(forgeItem).toBeVisible();
      await expect(forgeItem).toHaveAttribute('href', forge.url);
      await expect(forgeItem).toHaveAttribute('target', '_blank');
      await expect(forgeItem).toHaveAttribute('rel', 'noopener noreferrer');
      await page.keyboard.press('Escape');
    }
  });

  test('dismissal and focus restoration with Escape and outside click', async ({ page }) => {
    const detail = makeCommitDetail();
    await setupCommitBoard(page, detail);

    const commitCard = board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Write the CSV writer' });
    const commitButton = commitCard.getByRole('button', { name: 'Open Write the CSV writer' });

    await commitButton.click();
    await expect(reader(page)).toBeVisible();

    // Open More actions menu
    await moreButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();

    // Press Escape -> closes only menu and keeps focus on More actions
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
    await expect(moreButton(page)).toBeFocused();

    // Press Escape again -> closes reader and restores focus to commit card button
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(commitButton).toBeFocused();

    // Reopen and test clicking outside on dimmed overlay closes reader
    await commitButton.click();
    await expect(reader(page)).toBeVisible();

    const parentOverlay = reader(page).locator('xpath=..');
    const overlayBox = (await parentOverlay.boundingBox())!;
    await page.mouse.click(overlayBox.x + 10, overlayBox.y + overlayBox.height - 10);
    await expect(reader(page)).toHaveCount(0);
    await expect(commitButton).toBeFocused();
  });

  test('supports docked in-place switching between commits and handles route error', async ({ page }) => {
    const commit1 = makeCommitDetail({
      sha: FULL_SHA,
      shortSha: SHORT_SHA,
      subject: 'Write the CSV writer',
      author: 'Anna',
    });
    const commit2Sha = 'b2c3d4e5f6789012345678901234567890123456';
    const commit2 = makeCommitDetail({
      sha: commit2Sha,
      shortSha: 'b2c3d4e',
      subject: 'Add CSV stream formatter',
      author: 'Bob',
      files: [{ path: 'src/stream.ts', status: 'added', additions: 30, deletions: 0 }],
      additions: 30,
      deletions: 0,
    });
    const errorSha = 'c3d4e5f6a7b89012345678901234567890123456';
    const errorCommit = makeCommitDetail({
      sha: errorSha,
      shortSha: 'c3d4e5f',
      subject: 'Failing commit',
      author: 'Carol',
    });

    await setupCommitBoard(page, commit1, [commit2, errorCommit]);

    await page.route(`**/api/workspace/demo/commits/**/${errorSha}`, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        json: { error: 'Could not read this commit.' },
      }),
    );

    // 1. Open Commit 1
    const commit1Card = board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Write the CSV writer' });
    await commit1Card.getByRole('button', { name: 'Open Write the CSV writer' }).click();
    await expect(reader(page)).toBeVisible();
    await expect(readerTitle(page, 'Write the CSV writer')).toBeVisible();

    // 2. Switch to docked layout ("Show beside the board")
    await moreButton(page).click();
    await menuItem(page, 'Show beside the board').click();

    // 3. Trigger "Copy sha" on Commit 1 so checkmark is visible
    await moreButton(page).click();
    await menuItem(page, 'Copy sha').click();
    await expect(moreButton(page).locator('svg.lucide-check')).toBeVisible();

    // 4. In-place switch directly to Commit 2 on the board without closing reader first
    const commit2Card = board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Add CSV stream formatter' });
    await commit2Card.getByRole('button', { name: 'Open Add CSV stream formatter' }).click();

    // Verify Commit 2's details load and checkmark clears immediately on switch
    await expect(readerTitle(page, 'Add CSV stream formatter')).toBeVisible();
    await expect(moreButton(page).locator('svg.lucide-check')).toHaveCount(0);
    await expect(reader(page).getByText('by Bob')).toBeVisible();
    await expect(reader(page).getByText('src/stream.ts')).toBeVisible();

    // 5. Open failing commit (whose route returns HTTP 500)
    const errorCard = board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Failing commit' });
    await errorCard.getByRole('button', { name: 'Open Failing commit' }).click();

    // Verify role="alert" shows 'Could not read this commit.' and reader still has 2 buttons
    const alert = reader(page).getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText('Could not read this commit.');
    await expect(reader(page).getByRole('button')).toHaveCount(2);
  });
});
