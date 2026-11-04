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

const workspace = {
  id: 'demo',
  branchName: 'demo',
  name: 'Canvas Interaction Workspace',
  description: 'Testing reader fullscreen and element navigation',
  repos: [],
  assistants: [],
  workspacePath: '/tmp/demo',
  createdAt: '2026-10-01T00:00:00Z',
};

test.use({
  workspacesData: [[workspace], { option: true }],
  viewport: { width: 1280, height: 800 },
});

const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
const moreButton = (page: Page) => reader(page).getByRole('button', { name: 'More actions', exact: true });
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

async function setupReaderNavBoard(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
  });

  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        file: 'PLAN.md',
        source: 'file',
        title: 'Canvas Interaction Plan',
        checkpoints: [
          checkpoint('Canvas Navigation Feature', {
            steps: [
              step('Step 1: Reader split view and fullscreen', true),
              step('Step 2: Sequential navigation between elements'),
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
          documents: [
            {
              id: 'doc-brief',
              title: 'Feature Brief',
              role: 'requirements',
              status: 'current',
              filename: 'docs/brief.md',
              summary: 'Interactive board brief',
            },
          ],
        },
        lifecycle: null,
        assignment: '',
        sharedDocuments: [],
      },
    }),
  );

  await page.route('**/api/workspace/demo/board', (route) =>
    route.fulfill({
      json: boardFile({
        cards: [
          boardFileCard(1, 'board-pictures/screen-overview.png', {
            title: 'Overview Screenshot',
            description: 'The canvas overview',
            step: 'step-2-sequential-navigation-between-elements',
          }),
          boardFileCard(2, 'board-pictures/screen-detail.png', {
            title: 'Detail Screenshot',
            description: 'The zoomed view',
            step: 'step-2-sequential-navigation-between-elements',
          }),
        ],
      }),
    }),
  );

  await page.route('**/api/workspace/demo/news', (route) =>
    route.fulfill({ json: whatsNew() }),
  );

  // Mock document preview requests
  await page.route('**/api/workspace/demo/documents/preview**', (route) => {
    const url = new URL(route.request().url());
    const name = url.searchParams.get('name') ?? '';
    if (name.endsWith('.png')) {
      route.fulfill({
        json: { name, kind: 'image' },
      });
    } else {
      route.fulfill({
        json: { name, kind: 'markdown', content: `# Document Content for ${name}` },
      });
    }
  });

  await page.route('**/api/workspace/demo/work/documents/**', (route) =>
    route.fulfill({ json: { content: '# Feature Brief Content\n\nNavigation requirements.' } }),
  );

  await page.goto('/#/workspaces/demo/board');
  await expect(board(page)).toBeVisible();

  // Step into the Area
  const areaBtn = board(page).locator('.board-overview-plane button.board-area').filter({ hasText: 'Canvas Navigation Feature' });
  await areaBtn.click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
}

test.describe('Board Reader Fullscreen & Sequential Navigation', () => {
  test('toggles full screen for documents/pictures via button and double click, and exits back via Escape', async ({ page }) => {
    await setupReaderNavBoard(page);

    // 1. Open a picture card in the reader
    const picCard = board(page).locator('#board-area .react-flow__node-file').filter({ hasText: 'Overview Screenshot' });
    await picCard.getByRole('button', { name: 'Open Overview Screenshot' }).click();

    await expect(reader(page)).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'Overview Screenshot', level: 2 })).toBeVisible();

    // 2. Full screen toggle button is visible for picture card
    const fullscreenToggle = reader(page).locator('header').getByRole('button', { name: 'Full screen' });
    await expect(fullscreenToggle).toBeVisible();
    await expect(page.locator('[data-board-reader-fullscreen]')).toHaveCount(0);

    // 3. Switch to split view ("Show beside the board")
    await moreButton(page).click();
    await menuItem(page, 'Show beside the board').click();
    await expect(reader(page)).toHaveClass(/border-l/);

    // 4. Click Full screen toggle button from split view
    await fullscreenToggle.click();
    const fullscreenContainer = page.locator('[data-board-reader-fullscreen]');
    await expect(fullscreenContainer).toBeVisible();
    await expect(fullscreenContainer).toHaveClass(/fixed inset-0 z-\[100\]/);

    // 5. Press Escape to cleanly return to split view
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-board-reader-fullscreen]')).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
    await expect(reader(page)).toHaveClass(/border-l/);

    // 6. Double click header to toggle full screen
    const header = reader(page).locator('header');
    await header.dblclick();
    await expect(page.locator('[data-board-reader-fullscreen]')).toBeVisible();

    // 7. Click Exit full screen button to exit
    await page.locator('[data-board-reader-fullscreen]').getByRole('button', { name: 'Exit full screen' }).click();
    await expect(page.locator('[data-board-reader-fullscreen]')).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
  });

  test('navigates sequentially between elements using navigation buttons and [ / ] keys', async ({ page }) => {
    await setupReaderNavBoard(page);

    // 1. Open the first item (Feature Brief document)
    const docCard = board(page).locator('#board-area .react-flow__node-document').filter({ hasText: 'Feature Brief' });
    await docCard.getByRole('button', { name: 'Open Feature Brief' }).click();

    await expect(reader(page)).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'Feature Brief', level: 2 })).toBeVisible();

    // 2. Navigation pill shows position 1 of 3 (Brief + 2 Picture cards)
    const navGroup = reader(page).getByRole('group', { name: 'Item navigation' });
    await expect(navGroup).toBeVisible();
    await expect(navGroup).toContainText('1 / 3');

    const prevBtn = navGroup.getByRole('button', { name: /Previous/ });
    const nextBtn = navGroup.getByRole('button', { name: /Next/ });

    // Previous is disabled at position 1
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    // 3. Click next button to navigate to Overview Screenshot
    await nextBtn.click();
    await expect(reader(page).getByRole('heading', { name: 'Overview Screenshot', level: 2 })).toBeVisible();
    await expect(navGroup).toContainText('2 / 3');
    await expect(prevBtn).toBeEnabled();
    await expect(nextBtn).toBeEnabled();

    // 4. Press ']' key to navigate to Detail Screenshot
    await page.keyboard.press(']');
    await expect(reader(page).getByRole('heading', { name: 'Detail Screenshot', level: 2 })).toBeVisible();
    await expect(navGroup).toContainText('3 / 3');
    await expect(nextBtn).toBeDisabled();
    await expect(prevBtn).toBeEnabled();

    // 5. Press '[' key to navigate back to Overview Screenshot
    await page.keyboard.press('[');
    await expect(reader(page).getByRole('heading', { name: 'Overview Screenshot', level: 2 })).toBeVisible();
    await expect(navGroup).toContainText('2 / 3');

    // 6. Navigate back to position 1 using Alt+ArrowLeft
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(reader(page).getByRole('heading', { name: 'Feature Brief', level: 2 })).toBeVisible();
    await expect(navGroup).toContainText('1 / 3');
    await expect(prevBtn).toBeDisabled();
  });

  test('enlarges picture directly on click and restores down on click, exit button, or Escape', async ({ page }) => {
    await setupReaderNavBoard(page);

    // Open picture card in split view
    const picCard = board(page).locator('#board-area .react-flow__node-file').filter({ hasText: 'Overview Screenshot' });
    await picCard.getByRole('button', { name: 'Open Overview Screenshot' }).click();
    await expect(reader(page)).toBeVisible();

    // Switch to split view ("Show beside the board")
    await moreButton(page).click();
    await menuItem(page, 'Show beside the board').click();
    await expect(reader(page)).toHaveClass(/border-l/);

    // The image inside the reader has cursor-zoom-in and zoom tooltip
    const previewImage = reader(page).locator('img[alt="board-pictures/screen-overview.png"]');
    await expect(previewImage).toBeVisible();
    await expect(previewImage).toHaveClass(/cursor-zoom-in/);

    // Click directly on the picture to enlarge/maximize to fullscreen
    await previewImage.click();

    const fullscreenContainer = page.locator('[data-board-reader-fullscreen]');
    await expect(fullscreenContainer).toBeVisible();
    await expect(fullscreenContainer).toHaveClass(/fixed inset-0 z-\[100\]/);

    // While enlarged, image has cursor-zoom-out
    const enlargedImage = fullscreenContainer.locator('img[alt="board-pictures/screen-overview.png"]');
    await expect(enlargedImage).toHaveClass(/cursor-zoom-out/);

    // Click directly on the enlarged picture to restore down back to split view
    await enlargedImage.click();
    await expect(page.locator('[data-board-reader-fullscreen]')).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
    await expect(reader(page)).toHaveClass(/border-l/);
  });

  test('automatically unfolds row on the board and selects card when picture is opened, preserving visibility on return', async ({ page }) => {
    await setupReaderNavBoard(page);

    // 1. Fold the step row on the canvas by clicking its row control
    const rowControl = board(page).locator('#board-area [data-row-control]');
    if (await rowControl.count() > 0) {
      await rowControl.first().click();
    }

    // 2. Open the picture directly from a link or target (using onOpenFile / openLinked)
    // The reader opens the picture
    await page.evaluate(() => {
      // Trigger opening the picture via window navigation event or custom dispatch
      const openBtn = document.querySelector<HTMLButtonElement>('[data-card-main], button[aria-label*="Overview Screenshot"]');
      openBtn?.click();
    });

    await expect(reader(page)).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'Overview Screenshot', level: 2 })).toBeVisible();

    // 3. Verify that the card's row on the board is unfolded and the card node is active and highlighted
    const activeCard = board(page).locator('#board-area .react-flow__node-file').filter({ hasText: 'Overview Screenshot' });
    await expect(activeCard).toBeVisible();
    await expect(activeCard).toHaveAttribute('data-highlighted', 'true');

    // 4. Close the reader
    await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(reader(page)).toHaveCount(0);

    // 5. On return to the board: all pictures in the row remain visible and the clicked card remains highlighted
    await expect(activeCard).toBeVisible();
    await expect(activeCard).toHaveAttribute('data-highlighted', 'true');
    const siblingPic = board(page).locator('#board-area .react-flow__node-file').filter({ hasText: 'Detail Screenshot' });
    await expect(siblingPic).toBeVisible();
  });
});
