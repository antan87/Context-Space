import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardFileCard, boardNote, checkpoint, decision, planFile, step, whatsNew } from './planData';

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
  sidebarDocked: false,
  viewport: { width: 1440, height: 900 },
});

const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const AREA_TITLE = 'Reports CSV export';
const AREA_ID = 'checkpoint:reports-csv-export';

async function setupMocks(page: Page) {
  await page.route('**/api/terminals/bootstrap', (route) =>
    route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } })
  );
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    const terminal = { id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' };
    return route.fulfill({
      json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] },
    });
  });
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/documents/file**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE })
  );
}

async function routeWork(page: Page, documents: any[]) {
  await page.route('**/api/workspace/demo/work', (route) =>
    route.fulfill({
      json: {
        guidance: {
          version: 1,
          revision: 1,
          workType: 'feature',
          size: 'standard',
          assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' },
          documents,
        },
        lifecycle: null,
        assignment: '',
        sharedDocuments: [],
      },
    })
  );
}

async function setupData(page: Page) {
  await page.route('**/api/workspace/*/plan', (route) =>
    route.fulfill({
      json: planFile({
        title: 'Reports CSV export',
        now: { key: 'write-the-csv-writer', by: 'claude', at: minutesAgo(5) },
        checkpoints: [
          checkpoint(AREA_TITLE, {
            steps: [
              step('Write the CSV writer', false),
              step('Background job queue for large exports', false),
              step('Download link in the report page', false),
            ],
            decisions: [
              decision('Which time zone should export timestamps use?'),
            ],
          }),
          checkpoint('Second area', {
            steps: [step('Step in second area', false)],
          }),
        ],
      }),
    })
  );

  await page.route('**/api/workspace/*/news', (route) =>
    route.fulfill({
      json: whatsNew({
        empty: false,
        commits: [
          {
            repo: 'empty-repo',
            more: 0,
            commits: [],
          },
          {
            repo: 'NexusFlow',
            more: 0,
            commits: [
              { sha: 'a11111111111', author: 'Dev', subject: 'feat: add CSV writer', at: minutesAgo(10) },
              { sha: 'a22222222222', author: 'Dev', subject: 'feat: job queue setup', at: minutesAgo(20) },
              { sha: 'a33333333333', author: 'Dev', subject: 'fix: streaming response', at: minutesAgo(30) },
            ],
          },
        ],
        plan: {
          items: [
            { key: 'background-job-queue-for-large-exports', text: 'Background job queue for large exports', at: minutesAgo(2) },
          ],
          more: 0,
        },
      }),
    })
  );

  await routeWork(page, [
    {
      id: 'doc-csv-spec',
      title: 'CSV Format Specification',
      role: 'requirements',
      status: 'approved',
      scope: {},
      summary: 'Spec for CSV export',
      filename: 'spec.md',
      createdAt: minutesAgo(100),
      updatedAt: minutesAgo(50),
    },
    {
      id: 'doc-queue-design',
      title: 'Queue Architecture',
      role: 'design',
      status: 'approved',
      scope: {},
      summary: 'Design for background queue',
      filename: 'queue.md',
      createdAt: minutesAgo(100),
      updatedAt: minutesAgo(50),
    },
    {
      id: 'doc-api-ref',
      title: 'API Reference',
      role: 'reference',
      status: 'approved',
      scope: {},
      summary: 'REST endpoints',
      filename: 'api.md',
      createdAt: minutesAgo(100),
      updatedAt: minutesAgo(50),
    },
  ]);

  const mediaCards = Array.from({ length: 38 }, (_, i) =>
    boardFileCard(100 + i, `board-pictures/pic-${i}.png`, {
      title: `Picture ${i}`,
      alt: `Picture ${i}`,
      description: `Visual snapshot description for picture ${i}`,
      step: undefined,
      area: AREA_ID,
      at: minutesAgo(15 + i),
    })
  );
  const noteCards = [
    boardNote(1, { title: 'Note 1', body: 'First note body', step: undefined, area: AREA_ID, at: minutesAgo(10) }),
    boardNote(2, { title: 'Note 2', body: 'Second note body', step: undefined, area: AREA_ID, at: minutesAgo(12) }),
  ];
  // 3 files placed older than the 38 pictures so pictures precede files on loose media lane
  const fileCards = [
    boardFileCard(201, 'files/export-1.csv', { title: 'Sample CSV 1', step: undefined, area: AREA_ID, at: minutesAgo(80) }),
    boardFileCard(202, 'files/export-2.csv', { title: 'Sample CSV 2', step: undefined, area: AREA_ID, at: minutesAgo(81) }),
    boardFileCard(203, 'files/export-3.csv', { title: 'Sample CSV 3', step: undefined, area: AREA_ID, at: minutesAgo(82) }),
  ];

  // Cards for Second Area so it has a picture, note (for tabs), and fresh status
  const secondAreaCards = [
    boardFileCard(301, 'board-pictures/second-pic.png', {
      title: 'Second Area Picture',
      alt: 'Second Area Picture',
      step: undefined,
      area: 'checkpoint:second-area',
      at: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    boardNote(302, {
      title: 'Second Area Note',
      body: 'Second Area Note Body',
      step: undefined,
      area: 'checkpoint:second-area',
      at: minutesAgo(5),
    }),
  ];

  await page.route('**/api/workspace/*/board', (route) =>
    route.fulfill({
      json: boardFile({
        cards: [...noteCards, ...fileCards, ...mediaCards, ...secondAreaCards],
      }),
    })
  );
}

async function atRest(page: Page) {
  const board = page.getByRole('region', { name: 'Board', exact: true });
  await expect(board).toBeVisible();
  await expect(board.getByText(/^Still loading/)).toHaveCount(0);
  let last = '';
  await expect.poll(async () => {
    const now = await page.locator('#board-overview .react-flow__viewport').evaluate((el) => getComputedStyle(el).transform).catch(() => '');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
    const still = now !== '' && now === last;
    last = now;
    return still;
  }, { intervals: [100], timeout: 10000 }).toBe(true);
}

test.describe('Slice I1: Everything you see on the board can be pressed', () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page);
    await setupData(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
        localStorage.setItem('contextspace_board_reader_layout_v1', 'side');
      } catch {
        /* no storage */
      }
    });
  });

  for (const mode of [
    { name: '1280x800 Split', width: 1280, height: 800, split: true },
    { name: '1440x900 Board', width: 1440, height: 900, split: false },
  ]) {
    test.describe(mode.name, () => {
      test('no button inside button in overview DOM', async ({ page }) => {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        // Outcome 3: Valid HTML, no nested buttons
        const nestedButtons = page.locator('#board-overview button button');
        await expect(nestedButtons).toHaveCount(0);
      });

      test('pressing thumbnail opens reader and Escape returns focus to thumbnail', async ({ page }) => {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        const heroNode = page.locator('#board-overview .react-flow__node-area');
        await expect(heroNode).toBeVisible();

        // Thumbnail buttons on focus card
        const thumbButtons = heroNode.locator('button[aria-label*="Picture"]');
        await expect(thumbButtons.first()).toBeVisible();
        const firstThumb = thumbButtons.first();

        // 1. Pressing thumbnail button opens picture in reader
        await firstThumb.click();
        const reader = page.locator('[data-board-reader]');
        await expect(reader).toBeVisible();

        // 2. Pressing Escape closes reader and returns focus to thumbnail
        await page.keyboard.press('Escape');
        await expect(reader).toHaveCount(0);
        await expect(firstThumb).toBeFocused();
      });

      test('each count opens what it counts: pictures, notes, files, commits, updates', async ({ page }) => {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        const heroNode = page.locator('#board-overview .react-flow__node-area');
        await expect(heroNode).toBeVisible();

        const stepOutToOverview = async () => {
          const stepOut = page.getByRole('button', { name: 'Board ›', exact: true });
          await expect(stepOut).toBeVisible();
          await stepOut.click();
          await atRest(page);
          await expect(page.locator('#board-overview')).toBeVisible();
        };

        // 1. "38 pictures" steps into Area with Media tab active
        const picturesBtn = heroNode.getByRole('button', { name: 'Show the 38 pictures' });
        await expect(picturesBtn).toBeVisible();
        await picturesBtn.click();
        const mediaTab = page.getByRole('tab', { name: /Media/i });
        await expect(mediaTab).toBeVisible();
        await expect(mediaTab).toHaveAttribute('aria-selected', 'true');
        await stepOutToOverview();

        // 2. "2 notes" steps into Area with Notes tab active
        const notesBtn = heroNode.getByRole('button', { name: 'Show the 2 notes' });
        await expect(notesBtn).toBeVisible();
        await notesBtn.click();
        const notesTab = page.getByRole('tab', { name: /Notes/i });
        await expect(notesTab).toBeVisible();
        await expect(notesTab).toHaveAttribute('aria-selected', 'true');
        await stepOutToOverview();

        // 3. "3 files" steps into Area on loose board Media tab on the page where files live
        const filesBtn = heroNode.getByRole('button', { name: 'Show the 3 files' });
        await expect(filesBtn).toBeVisible();
        await filesBtn.click();
        const mediaTabForFiles = page.getByRole('tab', { name: /Media/i });
        await expect(mediaTabForFiles).toBeVisible();
        await expect(mediaTabForFiles).toHaveAttribute('aria-selected', 'true');
        // File card is visible on its page
        await expect(page.locator('#board-area').getByText('Sample CSV 1')).toBeVisible();
        await stepOutToOverview();

        // 4. "3 documents" steps into Area on documents row
        const docsBtn = heroNode.getByRole('button', { name: 'Show the 3 documents' });
        await expect(docsBtn).toBeVisible();
        await docsBtn.click();
        const docsRow = page.locator('#board-area .react-flow__node[data-id="lane:documents"]');
        await expect(docsRow).toBeVisible();
        await stepOutToOverview();

        // 5. "3 commits" steps into Area on commits row (even when first repo has 0 commits)
        const commitsBtn = heroNode.getByRole('button', { name: 'Show the 3 commits' });
        await expect(commitsBtn).toBeVisible();
        await commitsBtn.click();
        const commitsRow = page.locator('#board-area .react-flow__node[data-id^="lane:commits"]');
        await expect(commitsRow).toBeVisible();
        await stepOutToOverview();

        // 6. "1 update" steps into Area on the updated step
        const updateBtn = heroNode.getByRole('button', { name: 'Show the 1 update' });
        await expect(updateBtn).toBeVisible();
        await updateBtn.click();
        const updatedStepRow = page.locator('#board-area .react-flow__node[data-id*="background-job-queue-for-large-exports"]');
        await expect(updatedStepRow).toBeVisible();
        await stepOutToOverview();
      });

      test('Tab reaches card, steps, thumbnails, and counts in visual order', async ({ page }) => {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        const heroNode = page.locator('#board-overview .react-flow__node-area');
        await expect(heroNode).toBeVisible();

        const cardBtn = heroNode.locator('button.board-area');
        const stepBtns = heroNode.locator('button[data-step-key]');
        const thumbBtns = heroNode.locator('button[aria-label*="Picture"]');
        const notesBtn = heroNode.getByRole('button', { name: 'Show the 2 notes' });
        const picturesBtn = heroNode.getByRole('button', { name: 'Show the 38 pictures' });
        const filesBtn = heroNode.getByRole('button', { name: 'Show the 3 files' });
        const docsBtn = heroNode.getByRole('button', { name: 'Show the 3 documents' });
        const commitsBtn = heroNode.getByRole('button', { name: 'Show the 3 commits' });
        const updateBtn = heroNode.getByRole('button', { name: 'Show the 1 update' });

        // Start by focusing the card button
        await cardBtn.focus();
        await expect(cardBtn).toBeFocused();

        // Tab through step buttons
        const stepCount = await stepBtns.count();
        for (let i = 0; i < stepCount; i++) {
          await page.keyboard.press('Tab');
          await expect(stepBtns.nth(i)).toBeFocused();
        }

        // Tab through thumbnail buttons
        const thumbCount = await thumbBtns.count();
        for (let i = 0; i < thumbCount; i++) {
          await page.keyboard.press('Tab');
          await expect(thumbBtns.nth(i)).toBeFocused();
        }

        // Tab through footer count buttons in order
        await page.keyboard.press('Tab');
        await expect(notesBtn).toBeFocused();

        await page.keyboard.press('Tab');
        await expect(picturesBtn).toBeFocused();

        await page.keyboard.press('Tab');
        await expect(filesBtn).toBeFocused();

        await page.keyboard.press('Tab');
        await expect(docsBtn).toBeFocused();

        await page.keyboard.press('Tab');
        await expect(commitsBtn).toBeFocused();

        await page.keyboard.press('Tab');
        await expect(updateBtn).toBeFocused();
      });

      test('counts on other Area cards (tier 3) are their own buttons and open their target', async ({ page }) => {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        // Find the second area card
        const secondCard = page.locator('#board-overview .react-flow__node').filter({ hasText: 'Second area' });
        await expect(secondCard).toBeVisible();

        // The count button on second area (Tier 3: 1 picture)
        const secondPicBtn = secondCard.getByRole('button', { name: 'Show the 1 picture' });
        await expect(secondPicBtn).toBeVisible();

        // Clicking the count button on the second area steps into Second Area with Media tab active
        await secondPicBtn.click();
        const secondAreaBoard = page.locator('#board-area');
        await expect(secondAreaBoard).toBeVisible();
        await expect(secondAreaBoard.getByRole('heading', { name: 'Second area', exact: true })).toBeVisible();
        const mediaTab = page.getByRole('tab', { name: /Media/i });
        await expect(mediaTab).toBeVisible();
        await expect(mediaTab).toHaveAttribute('aria-selected', 'true');
        await expect(secondAreaBoard.getByRole('button', { name: 'Open Second Area Picture' })).toBeVisible();
      });

      test('pressing thumbnail on small overview card (tier 3) opens reader with same target and Escape returns focus to thumbnail', async ({ page }) => {
        // Data shaped like the real case: a picture card that is not on the Area's first page or tab
        const AREA_THREE_TITLE = 'Feature Overview Area';
        const AREA_THREE_ID = 'checkpoint:feature-overview-area';
        await page.route('**/api/workspace/*/plan', (route) =>
          route.fulfill({
            json: planFile({
              title: AREA_TITLE,
              now: { key: 'write-the-csv-writer', by: 'claude', at: minutesAgo(5) },
              checkpoints: [
                checkpoint(AREA_TITLE, {
                  steps: [
                    step('Write the CSV writer', false),
                  ],
                }),
                checkpoint(AREA_THREE_TITLE, {
                  steps: [step('Step in feature area', false)],
                }),
              ],
            }),
          })
        );
        await page.route('**/api/workspace/*/news', (route) =>
          route.fulfill({
            json: whatsNew({ empty: false, commits: [], plan: { items: [], more: 0 } }),
          })
        );
        await routeWork(page, []);

        // 12 media cards and a newer note: inside the area, first tab is Notes, and picture is on page 2 of Media
        const mediaCardsArea3 = Array.from({ length: 12 }, (_, i) =>
          boardFileCard(500 + i, `board-pictures/feature-pic-${i}.png`, {
            title: `Feature Picture ${i}`,
            alt: `Feature Picture ${i}`,
            description: `Feature snapshot description ${i}`,
            step: undefined,
            area: AREA_THREE_ID,
            at: minutesAgo(40 + i),
            ...(i === 0 ? { updatedAt: new Date().toISOString() } : {}),
          })
        );
        const noteCardArea3 = boardNote(600, {
          title: 'Feature Planning Note',
          body: 'Note body for feature area',
          step: undefined,
          area: AREA_THREE_ID,
          at: minutesAgo(2),
        });

        await page.route('**/api/workspace/*/board', (route) =>
          route.fulfill({
            json: boardFile({
              cards: [...mediaCardsArea3, noteCardArea3],
            }),
          })
        );

        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        const smallCard = page.locator('#board-overview .react-flow__node').filter({ hasText: AREA_THREE_TITLE });
        await expect(smallCard).toBeVisible();

        // The thumbnail button on the small card (sits over the picture)
        const thumbBtn = smallCard.locator('button[data-path]');
        await expect(thumbBtn).toBeVisible();

        // 1. Pressing thumbnail button opens picture in reader directly on overview
        await thumbBtn.click();
        const reader = page.locator('[data-board-reader]');
        await expect(reader).toBeVisible();

        // Must NOT step into area
        await expect(page.locator('#board-area')).toHaveCount(0);

        // Reader shows same target as inside area: description text and title
        await expect(reader.getByText(/Feature snapshot description/i)).toBeVisible();

        // 2. Pressing Escape closes reader and returns focus to thumbnail
        await page.keyboard.press('Escape');
        await expect(reader).toHaveCount(0);
        await expect(thumbBtn).toBeFocused();
      });

      test('picture opened from overview has card text, 1 of N counter, and [ / ] navigation', async ({ page }) => {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        const heroNode = page.locator('#board-overview .react-flow__node-area');
        const firstThumb = heroNode.locator('button[aria-label*="Picture"]').first();
        await firstThumb.click();

        const reader = page.locator('[data-board-reader]');
        await expect(reader).toBeVisible();

        // 1. Has card description text matching the opened picture
        const thumbTitle = await firstThumb.getAttribute('title') || 'Picture 37';
        const picNum = thumbTitle.replace(/\D+/g, '');
        await expect(reader.getByText(new RegExp(`Visual snapshot description for picture ${picNum}`, 'i'))).toBeVisible();

        // 2. Has item counter
        const itemCounter = reader.getByLabel(/Item \d+ of \d+/);
        await expect(itemCounter).toBeVisible();
        const initialText = (await itemCounter.getAttribute('aria-label')) || '';
        const match = initialText.match(/Item (\d+) of (\d+)/);
        expect(match).not.toBeNull();
        const curIdx = parseInt(match![1], 10);
        const totIdx = parseInt(match![2], 10);

        // 3. Navigation with ] advances to next target
        await page.keyboard.press(']');
        await expect(reader.getByLabel(`Item ${curIdx + 1} of ${totIdx}`)).toBeVisible();

        // 4. Navigation with [ returns to previous target
        await page.keyboard.press('[');
        await expect(reader.getByLabel(`Item ${curIdx} of ${totIdx}`)).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(reader).toHaveCount(0);
      });

      test('side-by-side reader at Level 0 follows closing rules', async ({ page }) => {
        test.skip(mode.split, 'Side-by-side reader requires room for canvas and reader side by side (1440 Board mode)');
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        const heroNode = page.locator('#board-overview .react-flow__node-area');
        const firstThumb = heroNode.locator('button[aria-label*="Picture"]').first();
        await firstThumb.click();

        const reader = page.locator('[data-board-reader]');
        await expect(reader).toBeVisible();

        // 1. Panning on canvas (>8px drag) does NOT close the side-docked reader
        const boardStage = page.locator('#board-overview');
        const stageBox = (await boardStage.boundingBox())!;
        await page.mouse.move(stageBox.x + 20, stageBox.y + 20);
        await page.mouse.down();
        await page.mouse.move(stageBox.x + 80, stageBox.y + 80);
        await page.mouse.up();
        await expect(reader).toBeVisible();

        // 2. Clicking the open thumbnail closes the reader (does not re-open)
        await firstThumb.click();
        await expect(reader).toHaveCount(0);

        // 3. Stepping into an Area closes Level 0 reader
        await firstThumb.click();
        await expect(reader).toBeVisible();
        await heroNode.locator('button.board-area').click();
        await expect(reader).toHaveCount(0);
        await expect(page.locator('#board-area')).toBeVisible();
      });

      test('count buttons are never clipped under overflow-hidden', async ({ page }) => {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        const heroNode = page.locator('#board-overview .react-flow__node-area');
        const heroBox = (await heroNode.boundingBox())!;
        const countButtons = heroNode.locator('button').filter({ hasText: /(notes|pictures|files|documents|commits|update)/ });
        const count = await countButtons.count();
        expect(count).toBeGreaterThan(0);

        for (let i = 0; i < count; i++) {
          const btnBox = (await countButtons.nth(i).boundingBox())!;
          // Button must be within card's vertical boundary, not clipped at bottom
          expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(heroBox.y + heroBox.height + 0.5);
          expect(btnBox.height).toBeGreaterThanOrEqual(24);
        }
      });

      test('two-line titles and counts: no count button overlaps title box, and each is whole inside card', async ({ page }) => {
        const LONG_TITLE_1 = 'The Board is powerful enough to be where the work happens';
        const LONG_TITLE_2 = 'A Board tab in NexusFlow shows the real work';
        await page.route('**/api/workspace/*/plan', (route) =>
          route.fulfill({
            json: planFile({
              title: LONG_TITLE_1,
              now: { key: 'step-1', by: 'claude', at: minutesAgo(5) },
              checkpoints: [
                checkpoint(LONG_TITLE_1, {
                  steps: [
                    step('Step 1 in focus area', false),
                    step('Step 2 in focus area', false),
                  ],
                }),
                checkpoint(LONG_TITLE_2, {
                  steps: [
                    step('Step 1 in area two', false),
                    step('Step 2 in area two', false),
                  ],
                }),
                checkpoint('Plan', {
                  steps: [
                    step('Step in plan checkpoint', false),
                  ],
                }),
              ],
            }),
          })
        );

        await page.route('**/api/workspace/*/news', (route) =>
          route.fulfill({
            json: whatsNew({
              empty: false,
              commits: [
                {
                  repo: 'NexusFlow',
                  more: 0,
                  commits: [
                    { sha: 'c11111111111', author: 'Dev', subject: 'feat: add board view', at: minutesAgo(10) },
                    { sha: 'c22222222222', author: 'Dev', subject: 'fix: count buttons', at: minutesAgo(20) },
                  ],
                },
              ],
              plan: {
                items: [
                  { key: 'step-1-in-area-two', text: 'Step 1 in area two', at: minutesAgo(2) },
                  { key: 'step-in-plan-checkpoint', text: 'Step in plan checkpoint', at: minutesAgo(3) },
                ],
                more: 0,
              },
            }),
          })
        );

        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.goto('/#/workspaces/demo/board');
        if (mode.split) {
          await page.getByTestId('view-mode-split').click();
        } else {
          await page.getByTestId('view-mode-board').click();
        }
        await atRest(page);

        const overview = page.locator('#board-overview');
        const cards = overview.locator('.react-flow__node');
        const cardCount = await cards.count();
        expect(cardCount).toBeGreaterThanOrEqual(2);

        let checkedCountButtons = 0;
        for (let i = 0; i < cardCount; i++) {
          const card = cards.nth(i);
          const cardBox = (await card.boundingBox())!;
          const countButtons = card.getByRole('button', { name: /^Show the / });
          const btnCount = await countButtons.count();
          if (btnCount === 0) continue;

          const titleEl = card.locator('button.board-area [title], .board-area [title]').first();
          await expect(titleEl).toBeVisible();
          const titleBox = (await titleEl.boundingBox())!;

          for (let b = 0; b < btnCount; b++) {
            const btn = countButtons.nth(b);
            const btnBox = (await btn.boundingBox())!;
            checkedCountButtons++;

            // 1. No overlap between count button box and title box
            const overlap = !(
              btnBox.x + btnBox.width <= titleBox.x + 0.5 ||
              titleBox.x + titleBox.width <= btnBox.x + 0.5 ||
              btnBox.y + btnBox.height <= titleBox.y + 0.5 ||
              titleBox.y + titleBox.height <= btnBox.y + 0.5
            );
            expect(overlap, `count button "${await btn.innerText()}" overlaps title in card ${i}`).toBe(false);

            // 2. Button is whole inside its card
            expect(btnBox.x).toBeGreaterThanOrEqual(cardBox.x - 0.5);
            expect(btnBox.y).toBeGreaterThanOrEqual(cardBox.y - 0.5);
            expect(btnBox.x + btnBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
            expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
            expect(btnBox.height).toBeGreaterThanOrEqual(24);
          }
        }
        expect(checkedCountButtons).toBeGreaterThan(0);

        // 3. Verify no stray space before comma in any count summaries
        const planCard = overview.locator('.react-flow__node').filter({ hasText: 'Plan' });
        if (await planCard.count() > 0) {
          const commas = planCard.locator('span[aria-hidden="true"]').filter({ hasText: ',' });
          const commaCount = await commas.count();
          for (let c = 0; c < commaCount; c++) {
            const comma = commas.nth(c);
            const commaBox = (await comma.boundingBox())!;
            // Preceding button right edge should meet comma left edge (no gap before comma)
            const prevBtn = planCard.getByRole('button', { name: /^Show the / }).first();
            const prevBox = (await prevBtn.boundingBox())!;
            expect(commaBox.x).toBeLessThanOrEqual(prevBox.x + prevBox.width + 1.0);
          }
        }
      });
    });
  }
});
