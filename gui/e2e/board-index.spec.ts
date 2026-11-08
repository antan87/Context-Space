import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  boardFile,
  boardFileCard,
  boardId,
  boardLink,
  boardNote,
  } from "./planData";
import {
  workspace,
  document,
  routeWork,
  routeBoard,
  routeCards,
  routePictures,
  workspaceNav,
  board,
  node,
  stepIntoArea,
  viewAtRest,
} from "./boardHelpers";

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

test.describe('Board index sidebar', () => {
  /** Whether the keyboard is on a card of the Area, or on something inside it. */
  const cardHasFocus = (page: Page, id: string) => node(page, id).evaluate((element) => element.contains(document.activeElement));

  test.beforeEach(async ({ page }, testInfo) => {
    if (!testInfo.title.includes('starts closed') && !testInfo.title.includes('narrow viewports') && !testInfo.title.includes('outside the Board')) {
      await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'open'); });
    }
  });

  test('starts closed on rail, expands on click, and remembers preference in storage', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeHidden();
    const railButton = page.getByRole('button', { name: 'Board index' });
    await expect(railButton).toHaveAttribute('aria-expanded', 'false');
    await expect(railButton).toHaveAccessibleName('Board index, 1 waits for you');

    // Expand sidebar
    await railButton.click();
    await expect(nav).toBeVisible();
    const toggle = nav.getByRole('button', { name: 'Board index' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Reload page to verify persistence (user choice is remembered)
    await page.reload();
    await viewAtRest(page);
    await expect(page.getByRole('navigation', { name: 'Board index' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Board index' })).toHaveAttribute('aria-expanded', 'true');

    // Collapse back to rail
    await nav.getByRole('button', { name: 'Board index' }).click();
    await expect(nav).toBeHidden();
    await expect(page.getByRole('button', { name: 'Board index' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('switches between Category and Area modes, remembering preference', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    // Default category mode has category headers
    await expect(nav.getByRole('heading', { name: /Waiting for you/ })).toBeVisible();
    await expect(nav.getByRole('heading', { name: /Areas/ })).toBeVisible();

    await expect(nav.getByRole('button', { name: 'Category', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(nav.getByRole('button', { name: 'Area', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Switch to Area mode
    await nav.getByRole('button', { name: 'Area', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'Area', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(nav.getByRole('heading', { name: /Reports export to CSV/ })).toBeVisible();
    await expect(nav.getByRole('heading', { name: /Report rows load fast/ })).toBeVisible();

    // Reload to verify persistence
    await page.reload();
    await viewAtRest(page);
    const navAfter = page.getByRole('navigation', { name: 'Board index' });
    await expect(navAfter.getByRole('heading', { name: /Reports export to CSV/ })).toBeVisible();

    // Switch back to Category mode
    await navAfter.getByRole('button', { name: 'Category', exact: true }).click();
    await expect(navAfter.getByRole('heading', { name: /Waiting for you/ })).toBeVisible();
  });

  test('filters items across titles, descriptions, and authors, with Escape and clear button clearing search', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Export memory leak note', body: 'Investigate streaming buffer' }),
        boardFileCard(2, 'docs/flow.png', { title: 'Architecture picture', description: 'Flow diagram' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    const search = nav.getByPlaceholder('Search the board…');

    await search.fill('Architecture');
    await expect(nav.getByRole('button', { name: 'Architecture picture Picture' })).toBeVisible();
    await expect(nav.getByRole('button', { name: /Export memory leak note/ })).toBeHidden();
    // The number of matches is announced, and the section headings stay open (and cannot be folded) while searching
    await expect(nav.locator('[aria-live="polite"]')).toHaveText('1 match');
    await expect(nav.getByRole('button', { name: /^Pictures & pages/ })).toBeDisabled();
    await expect(nav.getByRole('button', { name: /^Pictures & pages/ })).toHaveAttribute('aria-expanded', 'true');

    // By a word of the description
    await search.fill('diagram');
    await expect(nav.getByRole('button', { name: 'Architecture picture Picture' })).toBeVisible();
    await expect(nav.getByRole('button', { name: /Export memory leak note/ })).toBeHidden();

    // By an author: the commit that Anna wrote
    await search.fill('Anna');
    await expect(nav.getByRole('button', { name: /^Write the CSV writer/ })).toBeVisible();
    await expect(nav.getByRole('button', { name: /Architecture picture/ })).toBeHidden();
    await expect(nav.getByRole('button', { name: /Export memory leak note/ })).toBeHidden();

    // By a step in an Area: shows why the Area matched
    await search.fill('Query the report rows');
    await expect(nav.getByRole('button', { name: /^Report rows load fast/ })).toBeVisible();
    await expect(nav.getByText('Matched step: Query the report rows')).toBeVisible();

    await search.fill('nothing like this');
    await expect(nav.locator('[aria-live="polite"]')).toHaveText('No matches');

    // Press Escape inside input to clear search
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(nav.getByRole('button', { name: /Export memory leak note/ })).toBeVisible();

    // Clear search with clear button
    await search.fill('leak');
    await expect(nav.getByRole('button', { name: 'Clear search' })).toBeVisible();
    await nav.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
  });

  test('jumps directly to an Area and card in one click, highlighting the card', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Important note on export', body: 'Must handle UTF-8 BOM' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    // Currently at Level 0
    await expect(board(page).locator('.board-overview-plane')).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Board index' });
    // Click the note item in the sidebar
    await nav.getByRole('button', { name: /Important note on export/ }).click();

    // Should step into area
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();

    // The note card node should have data-highlighted="true", and the keyboard is on it
    const noteNode = board(page).locator(`.react-flow:not([inert] *) .react-flow__node[data-id="${boardId(1)}"]`);
    await expect(noteNode).toHaveAttribute('data-highlighted', 'true');
    await expect.poll(() => cardHasFocus(page, boardId(1))).toBe(true);
  });

  test('jumps from inside one Area to a card of another, and opens no reader later', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Important note on export', body: 'Must handle UTF-8 BOM' }),
        boardFileCard(2, 'docs/flow.png', { title: 'Architecture picture', description: 'Flow diagram' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    await stepIntoArea(page, /Report rows load fast/);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    const areaTitle = board(page).locator('#board-area > header').getByRole('heading', { level: 2 });
    const reader = board(page).getByRole('region', { name: 'Reader', exact: true });

    // The note is in another Area than the one stepped into: the card is highlighted and has the keyboard, and nothing else opens
    await nav.getByRole('button', { name: /Important note on export/ }).click();
    await expect(areaTitle).toHaveText('Reports export to CSV');
    await expect(node(page, boardId(1))).toHaveAttribute('data-highlighted', 'true');
    await expect.poll(() => cardHasFocus(page, boardId(1))).toBe(true);
    await expect(reader).toHaveCount(0);

    // Back to the first Area, and a jump that asks for the reader: it opens then, once
    await nav.getByRole('button', { name: /^Report rows load fast/ }).click();
    await expect(areaTitle).toHaveText('Report rows load fast');
    await expect(reader).toHaveCount(0);
    await nav.getByRole('button', { name: 'Read Architecture picture in reader' }).click();
    await expect(areaTitle).toHaveText('Reports export to CSV');
    await expect(reader).toBeVisible();
    // (The canvas is behind the reader's large window now, so the card is looked for there and not as a stop)
    await expect(board(page).locator(`#board-area .react-flow__node[data-id="${boardId(2)}"]`)).toHaveAttribute('data-highlighted', 'true');

    // Stepping out and back in later opens no reader of its own
    await reader.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(reader).toHaveCount(0);
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(reader).toHaveCount(0);
  });

  test('closes the reader before it jumps to a card in the Area it is open over', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'Important note on export', body: 'Must handle UTF-8 BOM' }),
        boardFileCard(2, 'docs/flow.png', { title: 'Architecture picture', description: 'Flow diagram' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    await nav.getByRole('button', { name: 'Read Architecture picture in reader' }).click();
    const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
    await expect(reader).toBeVisible();
    await viewAtRest(page);

    // The reader's large window covers the canvas: the jump takes it away to show the card
    await nav.getByRole('button', { name: /Important note on export/ }).click();
    await expect(reader).toHaveCount(0);
    await expect(node(page, boardId(1))).toHaveAttribute('data-highlighted', 'true');
    await expect.poll(() => cardHasFocus(page, boardId(1))).toBe(true);
  });

  test('puts focus on the Back button when an Area entry is pressed with the reader open', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [boardFileCard(2, 'docs/flow.png', { title: 'Architecture picture', description: 'Flow diagram' })],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    await nav.getByRole('button', { name: 'Read Architecture picture in reader' }).click();
    const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
    await expect(reader).toBeVisible();
    await viewAtRest(page);

    // The jump closes the reader and changes the Area in one go: the opener of the old Area must not keep the focus
    await nav.getByRole('button', { name: /^Report rows load fast/ }).first().click();
    await expect(reader).toHaveCount(0);
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeFocused();
  });

  test('opens reader directly from quick reader icon button without extra steps', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await routeWork(page, [
      document('Export requirements', { role: 'requirements', filename: 'contextspace-document-1.md', summary: 'Customers export their reports as CSV.' }),
    ]);
    await page.route('**/api/workspace/demo/work/documents/*', (route) => route.fulfill({ json: {
      document: document('Export requirements', { filename: 'contextspace-document-1.md' }),
      location: '/tmp/demo/contextspace-document-1.md',
      content: '# Export requirements\n\nCustomers export reports as CSV.\n',
    } }));

    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    // Quick reader button has aria-label="Read Export requirements in reader"
    const readerBtn = nav.getByRole('button', { name: 'Read Export requirements in reader' });
    await expect(readerBtn).toBeVisible();
    await readerBtn.click();

    // Stepped in and reader open
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
    const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
    await expect(reader.getByRole('heading', { name: 'Export requirements', level: 1 })).toBeVisible();
  });

  test('operates as an overlay drawer on narrow viewports, closing on backdrop click or Escape', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    // Narrow viewport (<960px): overlay mode, collapsed rail visible by default
    const openBtn = page.getByRole('button', { name: 'Board index' });
    await expect(openBtn).toHaveAttribute('aria-expanded', 'false');

    // Click to open narrow drawer overlay: the keyboard goes to its search box
    await openBtn.click();
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();
    await expect(nav.getByPlaceholder('Search the board…')).toBeFocused();
    const backdrop = board(page).locator('[data-sidebar-backdrop="true"]');
    await expect(backdrop).toBeVisible();

    // Press Escape to close narrow overlay: the keyboard goes back to the toggle
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(backdrop).toBeHidden();
    await expect(openBtn).toBeFocused();

    // Open again and click backdrop to close
    await openBtn.click();
    await expect(nav).toBeVisible();
    await expect(nav.getByPlaceholder('Search the board…')).toBeFocused();
    await backdrop.click({ position: { x: 350, y: 200 } });
    await expect(nav).toBeHidden();
    await expect(openBtn).toBeFocused();
  });

  test('leaves an Escape that is pressed outside the Board to the page, with the drawer open', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    await page.getByRole('button', { name: 'Board index' }).click();
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();

    // Something outside the Board has the keyboard
    const outside = workspaceNav(page).getByRole('link').first();
    await outside.focus();
    await expect(outside).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(nav).toBeVisible();
  });

  test('keeps the keyboard on a toggle when the index folds into its rail and opens again', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);

    const nav = page.getByRole('navigation', { name: 'Board index' });
    const toggle = page.getByRole('button', { name: 'Board index' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(nav).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(nav).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
  });

  test('follows the thread: selecting a card lights up connected chain and dims the rest, clearing on Escape or canvas click', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'First connected note', area: 'checkpoint:reports-export-to-csv', step: 'step-1' }),
        // a note, not a picture: a picture would stand on the Media tab of the row, apart from the notes
        boardNote(2, { title: 'Second connected picture', area: 'checkpoint:reports-export-to-csv', step: 'step-1' }),
        boardNote(3, { title: 'Unrelated note', area: 'checkpoint:reports-export-to-csv', step: 'step-2' }),
      ],
      links: [
        boardLink(1, boardId(1), boardId(2), 'related'),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    await stepIntoArea(page, /Reports export to CSV/);

    const canvas = board(page);
    const flow = canvas.locator('#board-area-flow');
    const note1Node = canvas.locator(`.react-flow__node[data-id="${boardId(1)}"]`);
    const note2Node = canvas.locator(`.react-flow__node[data-id="${boardId(2)}"]`);
    const unrelatedNode = canvas.locator(`.react-flow__node[data-id="${boardId(3)}"]`);

    // Initially thread is not active
    await expect(flow).not.toHaveAttribute('data-thread-active', 'true');

    // Click note 1 to follow thread
    await note1Node.click();
    await expect(flow).toHaveAttribute('data-thread-active', 'true');
    await expect(note1Node).toHaveAttribute('data-thread-selected', 'true');
    await expect(note1Node).toHaveAttribute('data-thread', 'active');
    await expect(note2Node).toHaveAttribute('data-thread', 'active');
    await expect(note2Node).not.toHaveAttribute('data-thread-selected', 'true');
    await expect(unrelatedNode).not.toHaveAttribute('data-thread', 'active');

    // Press Escape to clear thread
    await page.keyboard.press('Escape');
    await expect(flow).not.toHaveAttribute('data-thread-active', 'true');
    await expect(note1Node).not.toHaveAttribute('data-thread', 'active');

    // Jump from sidebar to note 1 also activates thread
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await nav.getByRole('button', { name: /First connected note/ }).click();
    await expect(flow).toHaveAttribute('data-thread-active', 'true');
    await expect(note1Node).toHaveAttribute('data-thread-selected', 'true');
    await expect(note2Node).toHaveAttribute('data-thread', 'active');
    await expect(unrelatedNode).not.toHaveAttribute('data-thread', 'active');

    // Click canvas pane to clear
    await flow.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
    await expect(flow).not.toHaveAttribute('data-thread-active', 'true');
  });
});
