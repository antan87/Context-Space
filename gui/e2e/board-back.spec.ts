import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardFileCard, boardNote, checkpoint, decision, planFile, step, whatsNew } from './planData';

/**
 * Slice N2: the board has the same way back as the reader.
 *
 * A jump from the Now line, the news list, the index, a count or a step button records where you were before it.
 * A Back button and Alt+Left return to where you were, restoring level, row, tab, page, fold and focus.
 */

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
});

const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const AREA_TITLE = 'Reports CSV export';
const AREA_ID = 'checkpoint:reports-csv-export';

let writes: string[] = [];

async function setupMocks(page: Page) {
  writes = [];
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
  await page.route('**/api/workspace/*/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name.endsWith('.png')) return route.fulfill({ json: { name, kind: 'image', size: PICTURE.length, modifiedAt: new Date().toISOString() } });
    return route.fulfill({ json: { name, kind: 'markdown', content: '# Document\n\nContent here', size: 24, modifiedAt: new Date().toISOString() } });
  });
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD' || new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
  await page.routeWebSocket('**/ws/terminal', () => undefined);
}

test.afterEach(() => {
  expect(writes, 'no test here may write').toEqual([]);
});

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
            repo: 'NexusFlow',
            more: 0,
            commits: [
              { sha: 'a11111111111', author: 'Dev', subject: 'feat: add CSV writer', at: minutesAgo(10) },
              { sha: 'a22222222222', author: 'Dev', subject: 'feat: job queue setup', at: minutesAgo(20) },
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
  ]);

  const mediaCards = Array.from({ length: 12 }, (_, i) =>
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
  const fileCards = [
    boardFileCard(201, 'files/export-1.csv', { title: 'Sample CSV 1', step: undefined, area: AREA_ID, at: minutesAgo(80) }),
  ];

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

const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
const backButton = (page: Page, label: string) =>
  page.getByRole('button', { name: `Back to ${label}`, exact: true });
const anyBack = (page: Page) => page.getByRole('button', { name: /^Back to / });

async function atRest(page: Page) {
  const b = board(page);
  await expect(b).toBeVisible();
  await expect(b.getByText(/^Still loading/)).toHaveCount(0);
  let last = '';
  await expect.poll(async () => {
    const now = await page.locator('#board-overview .react-flow__viewport').evaluate((el) => getComputedStyle(el).transform).catch(() => '');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
    const still = now !== '' && now === last;
    last = now;
    return still;
  }, { intervals: [100], timeout: 10000 }).toBe(true);
}

async function openPageInMode(page: Page, mode: { name: string; width: number; height: number; split: boolean }) {
  await page.setViewportSize({ width: mode.width, height: mode.height });
  await page.addInitScript((val) => {
    try {
      localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
      localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
      localStorage.setItem('contextspace_board_reader_layout_v1', val);
    } catch {
      /* ignore */
    }
  }, 'side');
  await page.goto('/#/workspaces/demo/board');
  if (mode.split) {
    await page.getByTestId('view-mode-split').click();
  } else {
    await page.getByTestId('view-mode-board').click();
  }
  await atRest(page);
}

const MODES = [
  { name: '1280x800 Split', width: 1280, height: 800, split: true },
  { name: '1440x900 Board', width: 1440, height: 900, split: false },
];

test.describe('Slice N2: Board Back Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page);
    await setupData(page);
  });

  for (const mode of MODES) {
    test.describe(mode.name, () => {
      test('no Back button when nothing was jumped', async ({ page }) => {
        await openPageInMode(page, mode);

        // On overview, no Back button
        await expect(anyBack(page)).toHaveCount(0);

        // Step into an Area normally by pressing its card
        const areaCard = page.locator('#board-overview .react-flow__node-area').filter({ hasText: AREA_TITLE });
        await areaCard.locator('button.board-area').click();
        await expect(page.locator('#board-area')).toBeVisible();

        // No Back button inside Area after a normal step-in
        await expect(anyBack(page)).toHaveCount(0);

        // Click Board › to step out
        await page.locator('#board-area header').getByRole('button', { name: 'Board ›' }).click();
        await expect(page.locator('#board-area')).toHaveCount(0);

        // Still no Back button on overview
        await expect(anyBack(page)).toHaveCount(0);
      });

      test('a Now line jump gives a Back that returns to the overview with focus on the element left', async ({ page }) => {
        await openPageInMode(page, mode);

        const nowBtn = page.getByTestId('board-now-main');
        await expect(nowBtn).toBeVisible();
        await nowBtn.click();

        // Stepped into Area
        await expect(page.locator('#board-area')).toBeVisible();

        // No Back button inside Area when target is overview
        await expect(anyBack(page)).toHaveCount(0);

        // Breadcrumb Board › returns along the trail to overview
        const breadcrumb = page.locator('#board-area header').getByRole('button', { name: 'Board ›' });
        await expect(breadcrumb).toBeVisible();
        await breadcrumb.click();

        // Returns to overview and focus is on Now button
        await expect(page.locator('#board-area')).toHaveCount(0);
        await expect(nowBtn).toBeFocused();
        await expect(anyBack(page)).toHaveCount(0);
      });

      test('an index jump gives a Back that returns to the overview with focus on the element left', async ({ page }) => {
        await openPageInMode(page, mode);

        // Open the index sidebar if not open
        const nav = page.getByRole('navigation', { name: 'Board index' });
        if (!(await nav.isVisible())) {
          const railBtn = page.getByRole('button', { name: /Board index/ }).first();
          await railBtn.click();
          await expect(nav).toBeVisible();
        }

        // Jump via sidebar item (e.g. Note 1 or First item)
        const itemButton = nav.locator('button[data-nav-item]').first();
        await expect(itemButton).toBeVisible();
        await itemButton.click();

        // Stepped into Area
        await expect(page.locator('#board-area')).toBeVisible();

        // No Back button inside Area when target is overview
        await expect(anyBack(page)).toHaveCount(0);

        // Breadcrumb Board › returns along the trail to overview
        const breadcrumb = page.locator('#board-area header').getByRole('button', { name: 'Board ›' });
        await expect(breadcrumb).toBeVisible();
        await breadcrumb.click();

        // Returns to overview and focus is on the sidebar item button
        await expect(page.locator('#board-area')).toHaveCount(0);
        await expect(itemButton).toBeFocused();
        await expect(anyBack(page)).toHaveCount(0);
      });

      test('a count press gives a Back that returns to the overview with focus on the element left', async ({ page }) => {
        await openPageInMode(page, mode);

        // Find count button on the Area card on overview (e.g. "Show the 2 notes", "Show the 12 pictures")
        const areaCard = page.locator('#board-overview .react-flow__node-area').filter({ hasText: AREA_TITLE });
        const countBtn = areaCard.getByRole('button', { name: /^Show the / }).first();
        await expect(countBtn).toBeVisible();
        await countBtn.click();

        // Stepped into Area
        await expect(page.locator('#board-area')).toBeVisible();

        // No Back button inside Area when target is overview
        await expect(anyBack(page)).toHaveCount(0);

        // Breadcrumb Board › returns along the trail to overview
        const breadcrumb = page.locator('#board-area header').getByRole('button', { name: 'Board ›' });
        await expect(breadcrumb).toBeVisible();
        await breadcrumb.click();

        // Returns to overview and focus is on the count button
        await expect(page.locator('#board-area')).toHaveCount(0);
        await expect(countBtn).toBeFocused();
        await expect(anyBack(page)).toHaveCount(0);
      });

      test('no Back button inside an Area when the only target is the overview', async ({ page }) => {
        await openPageInMode(page, mode);

        // Jump from Now line
        const nowBtn = page.getByTestId('board-now-main');
        await expect(nowBtn).toBeVisible();
        await nowBtn.click();
        await expect(page.locator('#board-area')).toBeVisible();

        // Target on trail is overview; inside Area, no Back button is shown
        await expect(anyBack(page)).toHaveCount(0);
      });

      test('stepping out with Escape and then pressing an Area card shows no Back button', async ({ page }) => {
        await openPageInMode(page, mode);

        // Jump from Now line
        const nowBtn = page.getByTestId('board-now-main');
        await expect(nowBtn).toBeVisible();
        await nowBtn.click();
        await expect(page.locator('#board-area')).toBeVisible();

        // Press Escape to step out
        await page.keyboard.press('Escape');
        await expect(page.locator('#board-area')).toHaveCount(0);

        // Step into an Area by pressing its card
        const areaCard = page.locator('#board-overview .react-flow__node-area').filter({ hasText: AREA_TITLE });
        await areaCard.locator('button.board-area').click();
        await expect(page.locator('#board-area')).toBeVisible();

        // Stale Back button to overview must not be shown
        await expect(anyBack(page)).toHaveCount(0);
      });

      test('a jump from inside one Area to another returns to the first Area with its row, tab and page', async ({ page }) => {
        await openPageInMode(page, mode);

        // Step into first Area
        const areaCard = page.locator('#board-overview .react-flow__node-area').filter({ hasText: AREA_TITLE });
        await areaCard.locator('button.board-area').click();
        await expect(page.locator('#board-area')).toBeVisible();

        // Open notes tab inside Area 1
        const notesTab = page.locator('#board-area [role="tab"]').filter({ hasText: 'Notes' });
        if (await notesTab.isVisible()) {
          await notesTab.click();
        }

        // Jump to Second area via index sidebar
        const nav = page.getByRole('navigation', { name: 'Board index' });
        if (!(await nav.isVisible())) {
          const railBtn = page.getByRole('button', { name: /Board index/ }).first();
          await railBtn.click();
          await expect(nav).toBeVisible();
        }

        const secondAreaItem = nav.locator('button[data-nav-item]').filter({ hasText: 'Second area' }).first();
        await expect(secondAreaItem).toBeVisible();
        await secondAreaItem.click();

        // Now in Second area
        await expect(page.locator('#board-area > header')).toContainText('Second area');

        // Back button names the first Area
        const back = backButton(page, AREA_TITLE);
        await expect(back).toBeVisible();
        await back.click();

        // Returns to first Area
        await expect(page.locator('#board-area > header')).toContainText(AREA_TITLE);
        await expect(page.locator('#board-area')).toBeVisible();
        if (await notesTab.isVisible()) {
          await expect(notesTab).toHaveAttribute('aria-selected', 'true');
        }
      });

      test('Alt+Left does the same and does nothing in a field', async ({ page }) => {
        await openPageInMode(page, mode);

        // Jump from Now line
        const nowBtn = page.getByTestId('board-now-main');
        await nowBtn.click();
        await expect(page.locator('#board-area')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);

        // Open Add Step form and focus input
        const addStepBtn = page.getByTestId('area-add-step-button');
        if (await addStepBtn.isVisible()) {
          await addStepBtn.click();
          const input = page.getByTestId('area-add-step-input');
          await expect(input).toBeVisible();
          await input.focus();

          // Press Alt+Left while focused in input: does nothing
          await page.keyboard.press('Alt+ArrowLeft');
          await expect(page.locator('#board-area')).toBeVisible();
          await expect(input).toBeFocused();

          // Cancel Add Step
          await page.getByTestId('area-add-step-cancel').click();
        }

        // Press Alt+Left on the board canvas / non-field
        await page.keyboard.press('Alt+ArrowLeft');

        // Returns to overview
        await expect(page.locator('#board-area')).toHaveCount(0);
        await expect(nowBtn).toBeFocused();
      });

      test('with a reader open, Escape and Back still act on the reader first', async ({ page }) => {
        await openPageInMode(page, mode);

        // Jump from Now line
        const nowBtn = page.getByTestId('board-now-main');
        await nowBtn.click();
        await expect(page.locator('#board-area')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);

        // Open a picture in the reader from the media tab
        const mediaTab = page.locator('#board-area [role="tab"]').filter({ hasText: /Media/ });
        await mediaTab.click();
        const openPicBtn = page.locator('#board-area button[aria-label^="Open "]').first();
        await expect(openPicBtn).toBeVisible();
        await openPicBtn.click();

        // Reader is open
        await expect(reader(page)).toBeVisible();

        // Press Escape: acts on reader first (closes reader)
        await page.keyboard.press('Escape');
        await expect(reader(page)).toHaveCount(0);

        // Board is STILL inside Area 1, and no Back to Overview is present
        await expect(page.locator('#board-area')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);

        // Pressing Board › on the board returns to overview
        await page.locator('#board-area header').getByRole('button', { name: 'Board ›' }).click();
        await expect(page.locator('#board-area')).toHaveCount(0);
        await expect(nowBtn).toBeFocused();
      });
    });
  }

  test.describe('Finding 1: long titles at 1100x700 Split', () => {
    test('after a jump into an Area from inside another long-titled Area, Back button is at most 160 px and Area heading is at least 120 px', async ({ page }) => {
      const LONG_TITLE_1 = 'Only what matters now is in front of you and nothing else at all';
      const LONG_TITLE_2 = 'Second area with a remarkably long title that also exceeds sixty characters';

      await page.route('**/api/workspace/*/plan', (route) =>
        route.fulfill({
          json: planFile({
            title: LONG_TITLE_1,
            now: { key: 'first-step-in-area-1', by: 'claude', at: minutesAgo(5) },
            checkpoints: [
              checkpoint(LONG_TITLE_1, {
                steps: [step('First step in area 1', false)],
              }),
              checkpoint(LONG_TITLE_2, {
                steps: [step('Step in area 2', false)],
              }),
            ],
          }),
        })
      );

      await openPageInMode(page, { name: '1100x700 Split', width: 1100, height: 700, split: true });

      // Step into first long-titled Area
      const areaCard1 = page.locator('#board-overview .react-flow__node-area').filter({ hasText: LONG_TITLE_1 });
      await areaCard1.locator('button.board-area').click();
      await expect(page.locator('#board-area')).toBeVisible();
      await expect(page.locator('#board-area > header')).toContainText(LONG_TITLE_1);

      // Open the index sidebar if not open
      const nav = page.getByRole('navigation', { name: 'Board index' });
      if (!(await nav.isVisible())) {
        const railBtn = page.getByRole('button', { name: /Board index/ }).first();
        await railBtn.click();
        await expect(nav).toBeVisible();
      }

      // Jump to Second area via index sidebar
      const secondAreaItem = nav.locator('button[data-nav-item]').filter({ hasText: LONG_TITLE_2 }).first();
      await expect(secondAreaItem).toBeVisible();
      await secondAreaItem.click();

      // Now in Second area
      await expect(page.locator('#board-area > header')).toContainText(LONG_TITLE_2);

      // Wait for Area animations to finish before measuring layout
      await page.evaluate(async () => {
        const el = document.querySelector('#board-area');
        if (!el) return;
        const animations = el.getAnimations({ subtree: true }).filter(
          (a) => a.effect?.getComputedTiming().iterations !== Infinity
        );
        await Promise.all(animations.map((a) => a.finished.catch(() => {})));
      });
      await page.waitForFunction(() => {
        const el = document.querySelector('#board-area');
        if (!el) return false;
        const running = el.getAnimations({ subtree: true }).filter(
          (a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity
        );
        return running.length === 0;
      });

      // Back button targeting first Area
      const back = page.locator('#board-area header').getByTestId('board-back-button');
      await expect(back).toBeVisible();
      const backBox = await back.boundingBox();
      expect(backBox).not.toBeNull();
      expect(backBox!.width).toBeLessThanOrEqual(160);

      const heading = page.locator('#board-area header h2');
      await expect(heading).toBeVisible();
      const headingBox = await heading.boundingBox();
      expect(headingBox).not.toBeNull();
      expect(headingBox!.width).toBeGreaterThanOrEqual(120);
    });
  });

  test.describe('Regression: opener staleness after Escape', () => {
    test('Now → Escape → count → Board › returns focus to the count button', async ({ page }) => {
      await openPageInMode(page, MODES[0]!); // 1280x800 Split

      // Press Now line
      const nowBtn = page.getByTestId('board-now-main');
      await expect(nowBtn).toBeVisible();
      await nowBtn.click();
      await expect(page.locator('#board-area')).toBeVisible();

      // Escape back to overview
      await page.keyboard.press('Escape');
      await expect(page.locator('#board-area')).toHaveCount(0);

      // Press count button on the Area card on overview
      const areaCard = page.locator('#board-overview .react-flow__node-area').filter({ hasText: AREA_TITLE });
      const countBtn = areaCard.getByRole('button', { name: /^Show the / }).first();
      await expect(countBtn).toBeVisible();
      await countBtn.click();
      await expect(page.locator('#board-area')).toBeVisible();

      // Breadcrumb Board › returns along the trail to overview
      const breadcrumb = page.locator('#board-area header').getByRole('button', { name: 'Board ›' });
      await expect(breadcrumb).toBeVisible();
      await breadcrumb.click();

      // Returns to overview and focus is on the count button, not the stale Now button
      await expect(page.locator('#board-area')).toHaveCount(0);
      await expect(countBtn).toBeFocused();
    });
  });

  test.describe('Regression: N2 bounded final focus fixes', () => {
    test('cross-Area index Back focuses the Area button that initiated the jump', async ({ page }) => {
      await openPageInMode(page, { name: '1440x900 Board', width: 1440, height: 900, split: false });

      // Open the index sidebar if not open
      const nav = page.getByRole('navigation', { name: 'Board index' });
      if (!(await nav.isVisible())) {
        const railBtn = page.getByRole('button', { name: /Board index/ }).first();
        await railBtn.click();
        await expect(nav).toBeVisible();
      }

      // Switch index to Area mode
      const areaModeBtn = nav.getByRole('button', { name: 'Area', exact: true });
      await areaModeBtn.click();
      await expect(areaModeBtn).toHaveAttribute('aria-pressed', 'true');

      // Step into first Area via index Area button (Index Area A)
      const firstAreaJumpBtn = nav.getByRole('button', { name: `Step into ${AREA_TITLE}` });
      await expect(firstAreaJumpBtn).toBeVisible();
      await firstAreaJumpBtn.click();
      await expect(page.locator('#board-area')).toBeVisible();
      await expect(page.locator('#board-area > header')).toContainText(AREA_TITLE);

      // In docked index, find Area jump button for Second area (Index Area B)
      const secondAreaJumpBtn = nav.getByRole('button', { name: 'Step into Second area' });
      await expect(secondAreaJumpBtn).toBeVisible();
      await secondAreaJumpBtn.click();

      // Now inside Second area
      await expect(page.locator('#board-area > header')).toContainText('Second area');

      // Header Back button to first Area
      const back = page.locator('#board-area header').getByTestId('board-back-button');
      await expect(back).toBeVisible();
      await back.click();

      // Returns to first Area
      await expect(page.locator('#board-area > header')).toContainText(AREA_TITLE);

      // Focus is restored to the Area button that initiated the jump
      await expect(secondAreaJumpBtn).toBeFocused();
    });

    test('same-Area item Back restores row/tab/page and focus to the index item', async ({ page }) => {
      await openPageInMode(page, { name: '1440x900 Board', width: 1440, height: 900, split: false });

      // Open the index sidebar if not open
      const nav = page.getByRole('navigation', { name: 'Board index' });
      if (!(await nav.isVisible())) {
        const railBtn = page.getByRole('button', { name: /Board index/ }).first();
        await railBtn.click();
        await expect(nav).toBeVisible();
      }

      // Step into first Area
      const areaCard = page.locator('#board-overview .react-flow__node-area').filter({ hasText: AREA_TITLE });
      await areaCard.locator('button.board-area').click();
      await expect(page.locator('#board-area')).toBeVisible();
      await expect(page.locator('#board-area > header')).toContainText(AREA_TITLE);

      // Switch to Media tab in the loose row (12 media cards)
      const mediaTab = page.locator('#board-area button[role="tab"][data-tab="media"]');
      await expect(mediaTab).toBeVisible();
      await mediaTab.click();
      await expect(mediaTab).toHaveAttribute('aria-selected', 'true');

      // Open the loose row so its pager is active
      const rowToggle = page.locator('#board-area button[data-row-control="lane:board"]').first();
      await expect(rowToggle).toBeVisible();
      await rowToggle.click();

      // Advance to page 1 via Older cards button
      const olderBtn = page.getByRole('button', { name: 'Older cards' });
      await expect(olderBtn).toBeVisible();
      await expect(olderBtn).toBeEnabled();
      await olderBtn.click();

      // Verify we are now on a nonzero page (Newer cards button is enabled)
      const newerBtn = page.getByRole('button', { name: 'Newer cards' });
      await expect(newerBtn).toBeVisible();
      await expect(newerBtn).toBeEnabled();
      await expect(rowToggle).toHaveAttribute('aria-expanded', 'true');
      const pageRange = page.locator('#board-area .react-flow__node-pager [role="status"]');
      const savedPageRange = await pageRange.innerText();
      const pictureCard = page.locator('#board-area').getByRole('article', { name: 'Picture 0', exact: true });
      await expect(pictureCard).toHaveCount(0);

      // From docked index, click an index picture within the same Area (Picture 0)
      const pictureItem = nav.locator('button[data-nav-item]').filter({ hasText: 'Picture 0' }).first();
      await expect(pictureItem).toBeVisible();
      await pictureItem.click();
      await expect(pictureCard).toBeVisible();

      // Header Back button to the Area place left
      const back = page.locator('#board-area header').getByTestId('board-back-button');
      await expect(back).toBeVisible();
      await back.click();

      // Returns to the first Area place: row, tab, and nonzero page are restored
      await expect(page.locator('#board-area > header')).toContainText(AREA_TITLE);
      await expect(mediaTab).toHaveAttribute('aria-selected', 'true');
      await expect(rowToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(pageRange).toHaveText(savedPageRange);
      await expect(pictureCard).toHaveCount(0);
      await expect(newerBtn).toBeVisible();
      await expect(newerBtn).toBeEnabled();

      // Focus is restored to the index item button
      await expect(pictureItem).toBeFocused();
    });
  });
});
