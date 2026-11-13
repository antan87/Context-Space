import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  boardFile,
  boardFileCard,
  boardId,
  boardLink,
  boardNote,
  checkpoint,
  decision,
  planFile,
  step,
  whatsNew,
} from "./planData";
import {
  workspace,
  minutesAgo,
  document,
  routeWork,
  routeBoard,
  routeCards,
  PICTURE,
  routePictures,
  board,
  node,
  stepIntoArea,
  canvasPosition,
  canvasBox,
  transformOf,
  isWithin,
  viewAtRest,
  reveal,
  revealAll,
  frames,
  nodesAtRest,
  dragBy,
} from "./boardHelpers";

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

test.describe('Board cards', () => {
  // A large window: these specs put several cards, and often a document and a commit too, on screen at once, which a laptop-sized
  // canvas shows as folded rows and "+N more" (specs for that are under "Board, rows by step").
  test.use({ viewport: { width: 1800, height: 1200 } });

  test('draws a note with its title, its text, who wrote it and when', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [
      boardNote(1, { title: 'Export leaks memory', body: 'Seen in the CSV writer.', by: 'claude', at: minutesAgo(12), updatedAt: minutesAgo(12) }),
      boardNote(2, { title: 'Ask finance about time zones', body: 'Before we ship.', by: 'user', updatedBy: 'user', at: minutesAgo(90), updatedAt: minutesAgo(90) }),
    ] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    const note = canvas.getByRole('article', { name: 'Export leaks memory' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('Seen in the CSV writer.');
    await expect(note).toContainText('by claude');
    await expect(note.locator('time')).toHaveCount(0);
    await expect(note).toContainText('12 min ago');
    await expect(note.getByRole('button')).toHaveCount(0);
    // A person's own note says "you".
    const mine = canvas.getByRole('article', { name: 'Ask finance about time zones' });
    await expect(mine).toContainText('by you');
    await expect(mine).toContainText('2 h ago');
    await expect(mine).not.toContainText('by user');
  });

  test('lets a long note be read whole, and puts the focus back on the button when it closes', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardNote(1, { title: 'A long note', body })] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const card = board(page).getByRole('article', { name: 'A long note' });
    await expect(card).toContainText('Line 1 of a long note.');
    // The card shows the start only, and says there is more: the button is only there when the text is cut.
    const readAll = card.getByRole('button', { name: 'Read A long note' });
    await readAll.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toContainText('Line 30 of a long note.');
    await expect(dialog).toContainText('by claude');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(readAll).toBeFocused();
  });

  test('draws a picture file as a thumbnail from the documents file address, named for those who cannot see it', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    const requested: string[] = [];
    await page.route('**/api/workspace/demo/documents/file**', (route) => { requested.push(new URL(route.request().url()).searchParams.get('name') ?? ''); return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }); });
    await routeCards(page, boardFile({
      cards: [
        boardFileCard(1, 'docs/export flow.png', { title: 'Export flow', description: 'How a report becomes a CSV file.' }),
        boardFileCard(2, 'shots/screen.JPG', { title: 'screen.JPG', description: 'The export button, in its new place.' }),
      ],
      positions: { [boardId(1)]: { x: 1060, y: 330 }, [boardId(2)]: { x: 1060, y: 650 } },
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    const flow = canvas.getByRole('article', { name: 'Export flow' });
    await expect(flow).toContainText('How a report becomes a CSV file.');
    await expect(flow).toContainText('by claude');
    // The title names the picture; when the title is only the file's name, the description does.
    const picture = flow.getByRole('img', { name: 'Export flow' });
    await expect(picture).toHaveAttribute('src', /\/api\/workspace\/demo\/documents\/file\?name=docs%2Fexport%20flow\.png$/);
    await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(canvas.getByRole('article', { name: 'screen.JPG' }).getByRole('img', { name: 'The export button, in its new place.' })).toBeAttached();
    expect(requested).toContain('docs/export flow.png');
  });

  test('shows a kind of file, not a picture, for pages, PDFs, Markdown and the rest, and falls back to it for a picture that will not load', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/documents/file**', (route) => route.fulfill({ status: 404, json: { error: 'No such file.' } }));
    await routeCards(page, boardFile({
      cards: [
        boardFileCard(1, 'docs/overview.html', { title: 'Overview page' }), boardFileCard(2, 'docs/spec.pdf', { title: 'The spec' }),
        boardFileCard(3, 'docs/notes.md', { title: 'Notes in Markdown' }), boardFileCard(4, 'docs/deck.pptx', { title: 'The deck' }),
        boardFileCard(5, 'docs/gone.png', { title: 'A picture that is gone' }),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await revealAll(page);
    for (const [title, kind, path] of [['Overview page', 'HTML page', 'docs/overview.html'], ['The spec', 'PDF', 'docs/spec.pdf'], ['Notes in Markdown', 'Markdown', 'docs/notes.md'], ['The deck', 'File', 'docs/deck.pptx']]) {
      const card = canvas.getByRole('article', { name: title });
      await expect(card).toContainText(kind);
      await expect(card).toContainText(path);
      await expect(card.getByRole('img')).toHaveCount(0);
      await expect(card.getByRole('button', { name: `Open ${title}` })).toBeVisible();
    }
    // The picture is tried, fails, and the card still says what the file is.
    const gone = canvas.getByRole('article', { name: 'A picture that is gone' });
    await expect(gone).toContainText('Picture');
    await expect(gone.getByRole('img')).toHaveCount(0);
  });

  test('marks a pinned card, and keeps an archived one out of sight until it is asked for', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [
      boardNote(1, { title: 'Keep this in front', pinned: true }),
      boardNote(2, { title: 'Done with this', archived: true }),
      boardFileCard(3, 'docs/old.pdf', { title: 'An old PDF', archived: true }),
      boardNote(4, { title: 'Just a note' }),
    ] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Keep this in front' })).toContainText('Pinned');
    await expect(canvas.getByRole('article', { name: 'Just a note' })).not.toContainText('Pinned');
    await expect(canvas.getByRole('article', { name: 'Done with this' })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'An old PDF' })).toHaveCount(0);

    const toggle = canvas.locator('#board-area').getByRole('button', { name: 'Archived (2)' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await reveal(page, canvas.getByRole('article', { name: 'An old PDF' }));
    for (const title of ['Done with this', 'An old PDF']) {
      const card = canvas.getByRole('article', { name: title });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Archived');
    }
    await reveal(page, canvas.getByRole('article', { name: 'Just a note' }));
    await expect(canvas.getByRole('article', { name: 'Just a note' })).not.toContainText('Archived');
    await toggle.click();
    await expect(canvas.getByRole('article', { name: 'Done with this' })).toHaveCount(0);
  });

  test('has no archived toggle when nothing is archived', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardNote(1)] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    await expect(board(page).getByRole('article', { name: 'Note 1' })).toBeVisible();
    await expect(board(page).locator('#board-area').getByRole('button', { name: /^Archived/ })).toHaveCount(0);
  });

  test('is the first stop for the keyboard, ahead of the cards', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardNote(1, { archived: true }), boardFileCard(2, 'docs/a.html')] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const toggle = board(page).locator('#board-area').getByRole('button', { name: 'Archived (1)' });
    await expect(toggle).toBeVisible();
    // It comes before the canvas in the tab order, so a keyboard user does not tab through every card to reach it: only the pane's icons, at the end of the heading, are between.
    await board(page).locator('#board-area .react-flow').focus();
    const paneIcons = await board(page).locator('#board-area header').getByRole('button', { name: /chat|Close this panel/ }).count();
    expect(paneIcons).toBeGreaterThan(0);
    for (let icon = 0; icon < paneIcons; icon += 1) await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    for (let stop = 0; stop <= paneIcons; stop += 1) await page.keyboard.press('Tab');
    await expect(board(page).locator('#board-area .react-flow')).toBeFocused();
  });

  test('draws a line between a card and a checkpoint with its label, and none to a thing that is not on the board', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({
      cards: [boardNote(1, { title: 'Export leaks memory' }), boardFileCard(2, 'docs/flow.png', { title: 'Export flow' })],
      links: [
        boardLink(1, boardId(1), 'checkpoint:reports-export-to-csv', 'found while'),
        boardLink(2, boardId(2), 'commit:billing api:a91f2e0'),
        boardLink(3, boardId(1), 'checkpoint:was-renamed', 'gone'),
        boardLink(4, boardId(2), `document:${boardId(99)}`),
        boardLink(5, boardId(1), boardId(2)),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Export leaks memory' })).toBeVisible();
    const edges = canvas.locator('#board-area .react-flow__edge');
    await expect(edges).toHaveCount(3);
    // Named by what they join, with the label, not by ids. The commit lane is already open inside the area, so the line goes directly to the commit.
    await expect(canvas.getByRole('img', { name: 'Link from Export leaks memory to Reports export to CSV: found while' })).toBeAttached();
    await expect(canvas.getByRole('img', { name: 'Link from Export flow to commit a91f2e0' })).toBeAttached();
    await expect(canvas.getByRole('img', { name: 'Link from Export leaks memory to Export flow' })).toBeAttached();
    await expect(canvas.locator('#board-area .react-flow__edge-text')).toHaveText(['found while']);
    await expect(canvas.getByRole('img', { name: /gone/ })).toHaveCount(0);
  });

  test('routes cards to areas by card.area, link, or fallback, with previews and cross-area edges at Level 0', async ({ page }) => {
    await routeBoard(page);
    await routePictures(page);
    await routeCards(page, boardFile({
      cards: [
        boardNote(1, { title: 'First note', area: 'checkpoint:report-rows-load-fast' }),
        boardNote(2, { title: 'Plan note', area: 'plan:own' }),
        boardFileCard(3, 'docs/flow.png', { title: 'Export flow', area: 'checkpoint:reports-export-to-csv' }),
        boardNote(4, { title: 'Linked note' }),
        boardNote(5, { title: 'Fresh fallback note', area: 'checkpoint:was-renamed', at: minutesAgo(0), updatedAt: minutesAgo(0) }),
      ],
      links: [
        boardLink(1, boardId(4), 'checkpoint:report-rows-load-fast', 'related'),
        boardLink(2, boardId(1), boardId(3), 'cross link'),
      ],
    }));
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const canvas = board(page);

    // Level 0: 3 areas (Report rows load fast is done and in Tier 5 fold)
    const fold = canvas.locator('#board-overview button.board-area-fold');
    if (await fold.count()) await fold.click();

    const fastArea = canvas.locator('.board-overview-plane button.board-area').filter({ hasText: 'Report rows load fast' });
    const planArea = canvas.locator('.board-overview-plane button.board-area').filter({ hasText: 'Plan' });
    const currentAreaNode = canvas.locator('.board-overview-plane .react-flow__node-area').filter({ hasText: 'Reports export to CSV' });
    const currentArea = currentAreaNode.locator('button.board-area');

    await expect(fastArea).toBeVisible();
    await expect(planArea).toBeVisible();
    await expect(currentArea).toBeVisible();

    // Fast area has 2 notes (1 explicit + 4 linked)
    await expect(fastArea).toHaveAttribute('aria-label', /2 notes/);
    // Plan area has 1 note (2 explicit)
    await expect(planArea).toHaveAttribute('aria-label', /1 note/);
    // Current area has 1 note (5 fallback) and 1 file (3 explicit)
    await expect(currentAreaNode).toContainText('1 note');
    await expect(currentAreaNode).toContainText('1 picture');

    // Picture preview on currentArea
    const previewImg = currentAreaNode.locator('img');
    await expect(previewImg).toHaveAttribute('src', /\/api\/workspace\/demo\/documents\/file\?name=docs%2Fflow\.png$/);

    // Fresh glow on currentArea node (card 5 is fresh!)
    await expect(canvas.locator('#board-overview .react-flow__node').filter({ hasText: 'Reports export to CSV' }).locator('.board-fresh')).toBeAttached();

    // Cross-area edge at Level 0 between the two checkpoints
    const crossEdge = canvas.locator('#board-overview .react-flow__edge');
    await expect(crossEdge).toHaveCount(1);
    await expect(canvas.locator('#board-overview').getByRole('img', { name: /cross link/ })).toBeAttached();

    // Step into Report rows load fast
    await stepIntoArea(page, /Report rows load fast/);
    await expect(canvas.getByRole('article', { name: 'First note' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'Linked note' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'Plan note' })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'Export flow' })).toHaveCount(0);
    await expect(canvas.getByRole('article', { name: 'Fresh fallback note' })).toHaveCount(0);

    // Step out
    await canvas.getByRole('button', { name: 'Board ›' }).click();
    await viewAtRest(page);

    // Step into current area
    await stepIntoArea(page, /Reports export to CSV/);
    await expect(canvas.getByRole('article', { name: 'Export flow' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'Fresh fallback note' })).toBeVisible();
    await expect(canvas.getByRole('article', { name: 'First note' })).toHaveCount(0);
  });

  test('ignores a saved place inside an Area: cards stand on their step row, the others under "Not tied to a step", clear of each other', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({
      cards: [boardNote(1, { title: 'Placed note' }), boardNote(2, { title: 'Second note', step: undefined }), boardNote(3, { title: 'Third note', step: 'no-such-step' }), boardFileCard(4, 'docs/a.html', { title: 'A page', step: undefined })],
      positions: { [boardId(1)]: { x: 2300, y: 333 }, 'checkpoint:reports-export-to-csv': { x: 700, y: 520 }, 'commit:billing api:a91f2e0': { x: 2000, y: 90 } },
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await expect(canvas.getByRole('article', { name: 'Placed note' })).toBeVisible();
    // The saved place is kept in the file but not used: the card is on the row of its step, under the step's header
    const [head, placed] = await Promise.all([canvasBox(page, 'row:step:background-job-queue-for-large-exports'), canvasBox(page, boardId(1))]);
    expect(placed.y).toBeGreaterThanOrEqual(head.y + head.height);
    expect(placed.x).toBeLessThan(400);
    expect(await canvasPosition(page, 'checkpoint:reports-export-to-csv')).toEqual({ x: 0, y: 0 });
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeVisible();
    // The cards with no step, or a step this Area does not have, stand in a row of their own, clear of everything beside it
    const band = canvas.getByRole('button', { name: /Not tied to a step/ });
    await expect(band).toBeVisible();
    const lane = await canvasBox(page, 'lane:board');
    expect(lane.y).toBeGreaterThan(placed.y + placed.height);
    for (const id of ['lane:documents', 'checkpoint:reports-export-to-csv', boardId(1)]) {
      const box = await canvasBox(page, id);
      const apart = box.x + box.width <= lane.x || lane.x + lane.width <= box.x || box.y + box.height <= lane.y || lane.y + lane.height <= box.y;
      expect(apart).toBe(true);
    }
    for (const title of ['Second note', 'Third note', 'A page']) {
      // The loose row has a Media tab (the page) and a Notes tab (the notes): each card is shown on its own tab
      await canvas.getByRole('tab', { name: title === 'A page' ? /^Media/ : /^Notes/ }).click();
      await expect(canvas.getByRole('article', { name: title })).toBeVisible();
      expect((await canvasBox(page, title === 'Second note' ? boardId(2) : title === 'Third note' ? boardId(3) : boardId(4))).y).toBeGreaterThanOrEqual(lane.y + lane.height);
    }
  });

  test('highlights what an AI made or changed in the last minute, and nothing else, and does not animate for those who ask for less motion', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [
      boardNote(1, { title: 'Just made by claude', at: minutesAgo(0), updatedAt: minutesAgo(0) }),
      boardNote(2, { title: 'Changed by codex', at: minutesAgo(30), updatedBy: 'codex', updatedAt: minutesAgo(0) }),
      boardNote(3, { title: 'Made by you', by: 'user', updatedBy: 'user', at: minutesAgo(0), updatedAt: minutesAgo(0) }),
      boardNote(4, { title: 'Made a while ago', at: minutesAgo(5), updatedAt: minutesAgo(5) }),
      boardNote(5, { title: 'Changed by you since', at: minutesAgo(30), updatedBy: 'user', updatedAt: minutesAgo(0) }),
    ] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    await revealAll(page);
    await expect(canvas.getByRole('article', { name: 'Made a while ago' })).toBeVisible();
    const glow = (title: string) => canvas.getByRole('article', { name: title }).locator('.board-fresh');
    await expect(glow('Just made by claude')).toHaveCount(1);
    await expect(glow('Changed by codex')).toHaveCount(1);
    for (const title of ['Made by you', 'Made a while ago', 'Changed by you since']) await expect(glow(title)).toHaveCount(0);
    await expect(glow('Just made by claude')).toHaveCSS('animation-name', 'board-fresh');
    await expect(glow('Just made by claude')).toHaveCSS('pointer-events', 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(glow('Just made by claude')).toHaveCSS('animation-name', 'board-fresh-still');
  });

  test('highlights documents and commits new since you looked from workspace news', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
      json: whatsNew({
        documents: { items: [{ name: 'Export requirements', kind: 'markdown', change: 'changed', at: minutesAgo(5) }], more: 0 },
        commits: [{ repo: 'billing api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the CSV writer', at: minutesAgo(5) }] }],
      }),
    }));
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');

    // Level 0: The Area containing the fresh document and commit glows
    const currentArea = board(page).locator('#board-overview .react-flow__node').filter({ hasText: 'Reports export to CSV' });
    await expect(currentArea.locator('.board-fresh')).toHaveCount(1);

    // Step into Area:
    await stepIntoArea(page);
    const canvas = board(page);

    const docCard = canvas.getByRole('article', { name: 'Export requirements' });
    await expect(docCard.locator('.board-fresh')).toHaveCount(1);
    await expect(docCard.getByText('New since you looked.')).toBeAttached();

    const commitCard = canvas.getByRole('article', { name: 'a91f2e0' });
    await expect(commitCard.locator('.board-fresh')).toHaveCount(1);
    await expect(commitCard.getByText('New since you looked.')).toBeAttached();
  });

  test('does not highlight cards when workspace news is empty (all seen)', async ({ page }) => {
    await routeBoard(page);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
      json: whatsNew({ empty: true, documents: { items: [], more: 0 }, commits: [] }),
    }));
    await routeCards(page, boardFile({ cards: [] }));
    await page.goto('/#/workspaces/demo/board');

    // Level 0: Area is not glowing
    const currentArea = board(page).locator('#board-overview .react-flow__node').filter({ hasText: 'Reports export to CSV' });
    await expect(currentArea.locator('.board-fresh')).toHaveCount(0);

    // Step into Area:
    await stepIntoArea(page);
    const canvas = board(page);
    const docCard = canvas.getByRole('article', { name: 'Export requirements' });
    await expect(docCard.locator('.board-fresh')).toHaveCount(0);
    await expect(docCard.getByText('New since you looked.')).toHaveCount(0);
  });

  test('keeps every card in view whatever place it was given, and the keyboard reaches its buttons', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({
      cards: [boardFileCard(1, 'docs/far.html', { title: 'A card far away' })],
      positions: { [boardId(1)]: { x: 4200, y: 1800 } },
    }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    const canvas = board(page);
    const far = canvas.getByRole('article', { name: 'A card far away' });
    await expect(far).toBeVisible();
    await expect.poll(() => isWithin(far, canvas.locator('#board-area .react-flow'))).toBe(true);
    await canvas.getByRole('button', { name: 'Open A card far away' }).focus();
    await expect(canvas.getByRole('button', { name: 'Open A card far away' })).toBeFocused();
    await expect.poll(() => isWithin(far, canvas.locator('#board-area .react-flow'))).toBe(true);
  });

  test('draws nothing of its own for a card with a path that leaves the workspace', async ({ page }) => {
    await routeBoard(page);
    await routeCards(page, boardFile({ cards: [boardFileCard(1, '../../etc/passwd', { title: 'Sneaky' }), boardFileCard(2, '/etc/passwd', { title: 'Sneakier' }), boardNote(3, { title: 'Fine' })] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page);
    await expect(board(page).getByRole('article', { name: 'Fine' })).toBeVisible();
    await expect(board(page).getByRole('article', { name: /Sneak/ })).toHaveCount(0);
  });
});

test.describe('Board, nothing to drag inside an Area', () => {
  test('keeps every node where the layout put it when dragged, and shows no draggable cursor', async ({ page }) => {
    await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed'); });
    await routeBoard(page);
    await routeCards(page, boardFile({ revision: 4, cards: [boardNote(1, { title: 'Export leaks memory', area: 'checkpoint:reports-export-to-csv', step: 'background-job-queue-for-large-exports' })], positions: { [boardId(1)]: { x: 352, y: -420 } } }));
    const posted: unknown[] = [];
    await page.route('**/api/workspace/demo/board/changes', (route) => { posted.push(route.request().postDataJSON()); return route.fulfill({ json: boardFile() }); });
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/);
    const card = board(page).getByRole('article', { name: 'Export leaks memory' });
    await expect(card).toBeVisible();
    // A saved place is not used inside an Area: the card is on its step row
    const before = await canvasBox(page, boardId(1));
    expect(before.y).toBeGreaterThanOrEqual(0);
    await dragBy(page, card, 120, 90);
    await frames(page, 8);
    expect(await canvasBox(page, boardId(1))).toEqual(before);
    await page.keyboard.press('Shift+ArrowRight');
    await frames(page, 4);
    expect(await canvasBox(page, boardId(1))).toEqual(before);
    expect(posted).toHaveLength(0);
    expect(await node(page, boardId(1)).evaluate((element) => element.classList.contains('draggable'))).toBe(false);
    expect(await node(page, boardId(1)).evaluate((element) => getComputedStyle(element).cursor)).not.toBe('grab');
    await expect(board(page).locator('#board-area .react-flow__node.draggable')).toHaveCount(0);
  });
});

test.describe('Board, rows by step', () => {
  const inArea = (page: Page) => board(page).locator('#board-area');
  const rowButton = (page: Page, name: RegExp | string) => inArea(page).getByRole('button', { name });
  const flow = (page: Page) => inArea(page).locator('.react-flow');
  const OPEN_STEP = (i: number) => `Open step ${i} that says something long about board polish and other things to do`;
  const DONE_STEP = (i: number) => `Done step ${i}`;
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ago = (m: number) => ({ at: minutesAgo(m), updatedAt: minutesAgo(m) });

  /**
   * The workspace of the real board, as the work on this very feature looks: a checkpoint with 13 open steps and 12 done ones, two decisions
   * that wait, a repository with commits, 10 cards that are tied to no step, 2 on an open step, 3 on done steps. And another checkpoint after it.
   */
  async function openReal(page: Page, options: { size?: { width: number; height: number }; nav?: boolean; area?: RegExp | string; onSteps?: boolean } = {}) {
    await page.addInitScript((nav) => { window.localStorage.setItem('contextspace_board_nav_open_v1', nav ? 'open' : 'closed'); }, Boolean(options.nav));
    if (options.size) await page.setViewportSize(options.size);
    const open = Array.from({ length: 13 }, (_, i) => step(OPEN_STEP(i)));
    const done = Array.from({ length: 12 }, (_, i) => step(DONE_STEP(i), true));
    // The work is on the step with the newest cards (or the first open one when it has none): someone said so
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ title: 'Real', now: { key: key(OPEN_STEP(options.onSteps === false ? 0 : 3)), by: 'claude', at: new Date().toISOString() }, checkpoints: [
      checkpoint('Concept', { done: true, steps: [step('Drew the idea', true)] }),
      checkpoint('A Board tab shows the real work', { steps: [...done, ...open], decisions: [decision('Which time zone?'), decision('Which delimiter?')] }),
      checkpoint('Later work', { steps: [step('Plan the later work'), step('Do the later work')] }),
    ] }) }));
    await routeWork(page, []);
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'NexusFlow', more: 0, commits: Array.from({ length: 5 }, (_, i) => ({ sha: `a91f2e0c4d5${i}`, author: 'Anna', subject: `Commit ${i}`, at: minutesAgo(30 + i) })) }] }) }));
    await routePictures(page);
    const area = 'checkpoint:a-board-tab-shows-the-real-work';
    await routeCards(page, boardFile({ cards: [
      ...Array.from({ length: 9 }, (_, i) => boardFileCard(10 + i, `board-pictures/p${i}.png`, { title: `Picture ${i}`, step: undefined, area, ...ago(i + 5) })),
      boardNote(19, { title: 'A loose note', step: undefined, area, ...ago(40) }),
      ...(options.onSteps === false ? [] : [boardNote(20, { title: 'Newest on an open step', body: Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the note.`).join('\n'), step: key(OPEN_STEP(3)), ...ago(1) }), boardNote(21, { title: 'Older on an open step', step: key(OPEN_STEP(3)), ...ago(3) })]),
      ...(options.onSteps === false ? [] : [
        boardNote(26, { title: 'Starts with code', body: '```\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n```\nsee [the plan](PLAN.md) after the code.', step: key(DONE_STEP(2)), ...ago(53) }),
        boardNote(27, { title: 'Starts with a table', body: '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n\nand then some words after the table.', step: key(DONE_STEP(2)), ...ago(54) }),
      ]),
      boardNote(22, { title: 'On a done step', step: key(DONE_STEP(2)), ...ago(50) }),
      boardNote(23, { title: 'On another done step', step: key(DONE_STEP(5)), ...ago(51) }),
      boardNote(24, { title: 'On a third done step', step: key(DONE_STEP(9)), ...ago(52) }),
      boardNote(25, { title: 'Later note', step: key('Plan the later work'), area: 'checkpoint:later-work', ...ago(2) }),
    ] }));
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, options.area ?? /A Board tab shows the real work/);
    return area;
  }

  /** Every node is whole inside the canvas, and none is under the attribution link or any other control of the canvas. */
  async function expectClearOfControls(page: Page) {
    await nodesAtRest(page);
    const canvas = (await flow(page).boundingBox())!;
    const controls = await inArea(page).locator('.react-flow__attribution, .react-flow__controls, .react-flow__minimap').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    const nodes = await inArea(page).locator('.react-flow__node').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-id'), x: r.x, y: r.y, width: r.width, height: r.height }; }));
    for (const { id, ...box } of nodes) {
      expect(box.x >= canvas.x - 0.5 && box.y >= canvas.y - 0.5 && box.x + box.width <= canvas.x + canvas.width + 0.5 && box.y + box.height <= canvas.y + canvas.height + 0.5, `${id} is outside the canvas`).toBe(true);
      for (const control of controls) {
        const apart = box.x + box.width <= control.x || control.x + control.width <= box.x || box.y + box.height <= control.y || control.y + control.height <= box.y;
        expect(apart, `${id} is under a control`).toBe(true);
      }
    }
    // No card grows out of itself: what is cut stays inside the card, so its byline and Read all are not pushed out
    const grown = await inArea(page).locator('.react-flow__node article').evaluateAll((els) => els.filter((el) => el.scrollHeight > el.clientHeight + 1).map((el) => `${el.getAttribute('aria-labelledby') ?? el.className}: ${el.scrollHeight} > ${el.clientHeight}`));
    expect(grown, 'cards that grow out of themselves').toEqual([]);
    // The control the keyboard is on is whole inside the canvas too, so the person can see where it is
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || !element.closest('#board-area .react-flow__node')) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, label: element.getAttribute('aria-label') ?? element.tagName };
    });
    if (focused) expect(focused.x >= canvas.x - 0.5 && focused.y >= canvas.y - 0.5 && focused.x + focused.width <= canvas.x + canvas.width + 0.5 && focused.y + focused.height <= canvas.y + canvas.height + 0.5, `the focused ${focused.label} is outside the canvas`).toBe(true);
  }

  const SIZES = [
    { name: '1280x800', size: { width: 1280, height: 800 }, canvasWidth: [800, 1100] },
    { name: '1100x700', size: { width: 1100, height: 700 }, canvasWidth: [600, 900] },
    // The Board in a narrow pane beside the chat: about 420 px of canvas
    { name: 'a narrow pane', size: { width: 480, height: 960 }, canvasWidth: [330, 520] },
    { name: 'a short narrow pane', size: { width: 480, height: 800 }, canvasWidth: [330, 520] },
  ] as const;

  for (const { name, size, canvasWidth } of SIZES) {
    test(`shows the current step with its cards and some more cards, all inside the canvas, at ${name}`, async ({ page }) => {
      await openReal(page, { size });
      const width = (await flow(page).boundingBox())!.width;
      expect(width).toBeGreaterThan(canvasWidth[0]);
      expect(width).toBeLessThan(canvasWidth[1]);
      // The current step is the open step with the newest card; its cards are drawn; so are some of the cards tied to no step
      const current = rowButton(page, new RegExp(`^Now: ${OPEN_STEP(3)}`));
      await expect(current).toBeVisible();
      await expect(inArea(page).getByRole('article', { name: 'Newest on an open step' })).toBeVisible();
      expect(await inArea(page).locator('.react-flow__node-note, .react-flow__node-file').count()).toBeGreaterThanOrEqual(1);
      await expect(rowButton(page, /^Show \d+ more|Not tied to a step/).first()).toBeVisible();
      await expect(rowButton(page, /more open steps/)).toBeVisible();
      await expect(rowButton(page, /12 done steps/)).toBeVisible();
      await expect(inArea(page).getByRole('article', { name: 'Reports export to CSV' })).toHaveCount(0);
      await expect(inArea(page).getByRole('article', { name: 'Waits for you' })).toBeVisible();
      await expectClearOfControls(page);
      // Panning and zooming are off: the view is where the layout put it
      expect((await transformOf(page)).scale).toBeCloseTo(0.9, 5);
      await expect(inArea(page).getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
      await expect(inArea(page).locator('.react-flow__minimap')).toHaveCount(0);
    });

    test(`never moves the view when rows are opened, closed or paged, and Escape gives back the exact view, at ${name}`, async ({ page }) => {
      test.slow();
      await openReal(page, { size });
      const before = await transformOf(page);
      const same = async () => { await frames(page, 6); expect(await transformOf(page)).toEqual(before); };
      for (const label of [/^Now:/, /more open steps/, /12 done steps/, /Not tied to a step/]) {
        const button = rowButton(page, label).first();
        await button.click();
        await same();
        await expectClearOfControls(page);
        const older = inArea(page).getByRole('button', { name: 'Older cards' });
        // A row that has more than one page is paged all the way through
        while (await older.count() && await older.isEnabled()) {
          await older.click();
          await same();
          await expectClearOfControls(page);
        }
        await page.keyboard.press('Escape');
        await same();
        await expect(inArea(page)).toBeVisible();
      }
      expect(await transformOf(page)).toEqual(before);
    });
  }

  test('fills the canvas with cards: at least 4 pictures with the index open at 1280x800, 2 in the narrow pane, most of them on a big screen', async ({ page }) => {
    // The real board has no cards on the open steps: its pictures are all tied to no step
    const pictures = () => inArea(page).locator('.react-flow__node-file').count();
    await openReal(page, { size: { width: 1280, height: 800 }, nav: true, onSteps: false });
    expect(await pictures()).toBeGreaterThanOrEqual(4);
    await expectClearOfControls(page);
    await page.goto('about:blank');
    await openReal(page, { size: { width: 480, height: 960 }, onSteps: false });
    expect(await pictures()).toBeGreaterThanOrEqual(2);
    await expectClearOfControls(page);
    await page.goto('about:blank');
    await openReal(page, { size: { width: 1920, height: 1080 }, onSteps: false });
    expect(await pictures()).toBeGreaterThanOrEqual(7);
    await expectClearOfControls(page);
  });

  test('keeps the card the reader shows drawn when the reader docks beside the canvas, from a page that is not the first, and gives the keyboard back to it when the reader closes', async ({ page }) => {
    await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_reader_layout_v1', 'side'); });
    // 760 px high, as the canvas was before the board lost its title row: the pages hold as many cards as the test counts on
    await openReal(page, { size: { width: 1280, height: 760 } });
    await rowButton(page, /Not tied to a step/).first().click();
    const older = inArea(page).getByRole('button', { name: 'Older cards' });
    // As far as the pages go, up to two: the cards fill the line, so a wide canvas has fewer pages
    for (let turn = 0; turn < 2 && await older.isEnabled(); turn += 1) { await older.click(); await frames(page, 4); }
    await expect(inArea(page).getByRole('navigation', { name: /Pages of/ })).toContainText(/^\d+–\d+ of 9$/);
    // Not the first page: that is what this test is about
    await expect(inArea(page).getByRole('navigation', { name: /Pages of/ })).not.toContainText(/^1–/);
    const open = inArea(page).getByRole('button', { name: /^Open Picture/ }).first();
    const label = (await open.getAttribute('aria-label'))!;
    const wide = (await flow(page).boundingBox())!;
    await open.click();
    const reading = board(page).getByRole('region', { name: 'Reader', exact: true });
    await expect(reading).toBeVisible();
    // The canvas is what the reader leaves, the rows are laid out for it again, and the card is still drawn beside the reader
    await expect.poll(async () => (await flow(page).boundingBox())!.width).toBeLessThan(wide.width);
    const card = inArea(page).getByRole('article', { name: label.replace(/^Open /, '') });
    await expect(card).toBeVisible();
    const free = (await reading.boundingBox())!;
    await expect.poll(async () => { const box = (await card.boundingBox())!; return box.x + box.width <= free.x + 1; }).toBe(true);
    await expectClearOfControls(page);
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    await expect(inArea(page).getByRole('button', { name: label })).toBeFocused();
    await expectClearOfControls(page);
  });

  test('puts the cards tied to no step in a row that opens into pages, with a count, newest first, and every card reachable by a button', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /Not tied to a step/).first().click();
    const pager = inArea(page).getByRole('navigation', { name: /Pages of/ });
    const more = rowButton(page, /Show \d+ more for Not tied/);
    await expect(more).toHaveCount(0);
    const seen = new Set<string>();
    const collect = async () => { for (const label of await inArea(page).locator('.react-flow__node-note h2, .react-flow__node-file h2').allTextContents()) if (/^(Picture|A loose note)/.test(label)) seen.add(label); };
    // The row has a Media tab (9 pictures) and a Notes tab (1 note): every card is reachable on one of them, each tab paged by itself
    for (const [tab, total] of [[/^Media/, 9], [/^Notes/, 1]] as const) {
      await inArea(page).getByRole('tab', { name: tab }).click();
      await frames(page, 4);
      await collect();
      if (await pager.count()) {
        await expect(pager).toContainText(new RegExp(`1–\\d+ of ${total}`));
        const older = inArea(page).getByRole('button', { name: 'Older cards' });
        const newer = inArea(page).getByRole('button', { name: 'Newer cards' });
        await expect(newer).toBeDisabled();
        while (await older.isEnabled()) { await older.click(); await frames(page, 4); await collect(); }
        await expect(older).toBeDisabled();
        await expect(pager).toContainText(new RegExp(`of ${total}`));
      }
    }
    expect(seen.size).toBe(10);
  });

  test('does the card\'s main action for a press anywhere on the brick, but not for a press on its own buttons or for a text selection', async ({ page }) => {
    await openReal(page, { size: { width: 1920, height: 1080 } });
    const reading = board(page).getByRole('region', { name: 'Reader', exact: true });
    const picture = inArea(page).getByRole('article', { name: 'Picture 0' });
    await expect(picture).toBeVisible();
    await expect(picture).toHaveCSS('cursor', 'pointer');
    // The press on the title opens the picture in the reader, as Open does
    await picture.getByRole('heading', { name: 'Picture 0' }).click();
    await expect(reading).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    // Selecting text by dragging over the description does not open it, and one drag selects all of it, also right after the reader has closed
    // (the keyboard is put back on the card that opened it, which must not happen in the middle of a drag: the focus moves and the selection stops)
    const selectText = async (target: Locator) => {
      const wanted = (await target.textContent())!.trim();
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      const box = (await target.boundingBox())!;
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      expect((await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim()).toBe(wanted);
    };
    await selectText(picture.getByText('The file 10.'));
    await frames(page, 6);
    await expect(reading).toHaveCount(0);
    // A selection in another card does not stop a press on this one: the thumbnail opens the picture
    const other = inArea(page).getByRole('article', { name: 'Picture 1' });
    await selectText(other.getByText('The file 11.'));
    await picture.locator('img').click();
    await expect(reading).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    // A note whose text is cut: a press on it reads it whole, and so does its title button by itself
    const note = inArea(page).getByRole('article', { name: 'Newest on an open step' });
    await note.getByRole('heading', { name: 'Newest on an open step' }).click();
    await expect(page.getByRole('dialog', { name: 'Newest on an open step' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await note.getByRole('button', { name: 'Read Newest on an open step' }).click();
    await expect(page.getByRole('dialog', { name: 'Newest on an open step' })).toBeVisible();
    await page.keyboard.press('Escape');
    // A note that shows all of its text is not a brick: nothing happens, and it does not look pressable
    const short = inArea(page).getByRole('article', { name: 'Older on an open step' });
    await expect(short).toHaveCSS('cursor', 'default');
    await short.getByRole('heading').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(reading).toHaveCount(0);
    // A commit opens in the Code window on that commit, not in the reader
    await rowButton(page, /NexusFlow/).first().click();
    await inArea(page).getByRole('article', { name: /^a91f2e0/ }).first().click();
    const code = page.getByRole('region', { name: 'Code window' });
    await expect(code).toBeVisible();
    await expect(code.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Commits' })).toHaveAttribute('aria-pressed', 'true');
    await expect(reading).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(code).toBeHidden();
  });

  test('shows no Open or Read all button on a card: the title is the one control, a press on the card does what it does, and the keyboard opens it', async ({ page }) => {
    await openReal(page, { size: { width: 1920, height: 1080 } });
    const reading = board(page).getByRole('region', { name: 'Reader', exact: true });
    const picture = inArea(page).getByRole('article', { name: 'Picture 0' });
    const note = inArea(page).getByRole('article', { name: 'Newest on an open step' });
    await expect(picture).toBeVisible();
    await expect(note).toBeVisible();
    // No button says "Open" or "Read all": what a card's buttons say is its title
    for (const text of await inArea(page).locator('.react-flow__node-note button, .react-flow__node-file button, .react-flow__node-document button').allTextContents()) {
      expect(text.trim(), 'a button of a card that is not its title').not.toMatch(/^(Open|Read all)$/);
    }
    await expect(inArea(page).getByText('Read all', { exact: true })).toHaveCount(0);
    await expect(inArea(page).getByText('Open', { exact: true })).toHaveCount(0);
    // Its title is a button named for what it does; a note whose text is cut reads, one whose text is whole has no button
    const open = picture.getByRole('button', { name: 'Open Picture 0' });
    await expect(open).toHaveText('Picture 0');
    await expect(note.getByRole('button', { name: 'Read Newest on an open step' })).toHaveText('Newest on an open step');
    await expect(inArea(page).getByRole('article', { name: 'Older on an open step' }).getByRole('button')).toHaveCount(0);
    // The keyboard reaches the title and opens the card with Enter; the card shows a ring all round it while the title has the keyboard
    const before = await picture.evaluate((element) => getComputedStyle(element).boxShadow);
    await open.focus();
    await expect(open).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(open).toBeFocused();
    const ring = await picture.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(ring, 'a ring round the whole card, that was not there before').not.toBe(before);
    expect(await open.evaluate((element) => getComputedStyle(element).outlineStyle), 'no second outline round the title').toBe('none');
    await page.keyboard.press('Enter');
    await expect(reading).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    await expect(open).toBeFocused();
    const read = note.getByRole('button', { name: 'Read Newest on an open step' });
    await read.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog', { name: 'Newest on an open step' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(read).toBeFocused();
  });

  test('says who made a card last with a small mark, "you" or "AI", and the whole byline is its description', async ({ page }) => {
    await openReal(page, { size: { width: 1920, height: 1080 } });
    const picture = inArea(page).getByRole('article', { name: 'Picture 0' });
    await expect(picture.getByText('AI', { exact: true })).toBeVisible();
    await expect(picture).toHaveAccessibleDescription(/^by \w+ · \d+ (min|h)/);
    const mark = picture.locator('[title^="by "]');
    await expect(mark).toHaveAttribute('title', /^by \w+ · /);
    await expect(mark).toHaveCSS('font-size', '12.5px');
  });

  test('says "Now" with a dot for the current step, and puts the page buttons and "+N more" on the line of the row\'s header', async ({ page }) => {
    // 760 px high: the 9 pictures of the Media tab need more than one page
    await openReal(page, { size: { width: 1280, height: 760 } });
    const now = rowButton(page, /^Now:/);
    await expect(now).toContainText('Now');
    await expect(now).not.toContainText(/current step/i);
    await expect(now.locator('.board-now-dot')).toHaveCount(1);
    // "+N more" is a quiet button on the line of its row's header, to the right of it
    const more = rowButton(page, /^Show \d+ more for/).first();
    await expect(more).toBeVisible();
    await expect(more).toHaveText(/^\+\d+ more$/);
    const moreRow = (await more.getAttribute('data-row-control'))!;
    const head = inArea(page).locator(`[data-row-control="${moreRow}"]`).first();
    const moreBox = (await more.boundingBox())!;
    const headBox = (await inArea(page).locator(`.react-flow__node[data-id="${moreRow}"]`).boundingBox())!;
    expect(Math.abs((moreBox.y + moreBox.height / 2) - (headBox.y + headBox.height / 2))).toBeLessThan(2);
    expect(moreBox.x).toBeGreaterThanOrEqual(headBox.x + headBox.width - 1);
    await expect(head).toBeVisible();
    // The page buttons of an opened row are on its line too, as small icon buttons, and no card is on that line
    await rowButton(page, /Not tied to a step/).first().click();
    const pager = inArea(page).getByRole('navigation', { name: /Pages of/ });
    await expect(pager).toBeVisible();
    await frames(page, 30);
    await expect(pager).toContainText(/^\d+–\d+ of 9$/);
    const rowHead = (await inArea(page).locator('.react-flow__node[data-id="lane:board"]').boundingBox())!;
    const pagerBox = (await pager.boundingBox())!;
    expect(Math.abs((pagerBox.y + pagerBox.height / 2) - (rowHead.y + rowHead.height / 2))).toBeLessThan(2);
    expect(pagerBox.x).toBeGreaterThanOrEqual(rowHead.x + rowHead.width - 1);
    for (const button of await pager.getByRole('button').all()) expect((await button.boundingBox())!.width).toBeLessThanOrEqual(32);
    for (const card of await inArea(page).locator('.react-flow__node-file, .react-flow__node-note').all()) {
      const box = (await card.boundingBox())!;
      expect(box.y + box.height <= rowHead.y + 1 || box.y >= rowHead.y + rowHead.height - 1, 'a card on the line of the header').toBe(true);
    }
  });

  test('says the waiting decisions without the Area\'s title, and the Area\'s header does not say it twice', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    const waiting = inArea(page).getByRole('article', { name: 'Waits for you' });
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText('Which time zone?');
    await expect(waiting).not.toContainText('A Board tab shows the real work');
    const header = inArea(page).locator('header').first();
    await expect(header).toContainText('A Board tab shows the real work');
    await expect(header).not.toContainText(/wait/i);
    await expect(inArea(page)).toContainText('Now');
  });

  test('keeps a compact note whose text starts with code or a table inside its card, with its mark and its title button', async ({ page }) => {
    await openReal(page, { size: { width: 1920, height: 1080 } });
    await rowButton(page, /12 done steps/).click();
    await expectClearOfControls(page);
    for (const title of ['Starts with code', 'Starts with a table']) {
      const note = inArea(page).getByRole('article', { name: title });
      await expect(note).toBeVisible();
      await expect(note.getByRole('button', { name: `Read ${title}` })).toBeVisible();
      await expect(note).toHaveCSS('cursor', 'pointer');
      // The code and the table are drawn at 11 px or more on the screen as well
      const sizes = await note.locator('pre, pre *, th, td').evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize) * 0.9));
      expect(sizes.filter((size) => size < 11), "code and table sizes").toEqual([]);
      // No band above the code and no half line: the text starts at the top of its box and its last visible line is whole
      const fit = await note.locator('.board-text-compact').evaluate((body) => {
        const box = body.getBoundingClientRect();
        const first = body.querySelector('pre, table');
        const zoom = box.height / (body as HTMLElement).offsetHeight;
        const top = first ? (first.getBoundingClientRect().top - box.top) / zoom : 0;
        return { top, lines: Math.floor((body as HTMLElement).offsetHeight / 17), height: box.height };
      });
      expect(fit.top, 'a band above the first block').toBeLessThanOrEqual(1);
      expect(fit.lines, 'two whole lines').toBeGreaterThanOrEqual(2);
      await note.getByRole('heading', { name: title }).click();
      await expect(page.getByRole('dialog', { name: title })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });

  test('draws every text of the rows at 11 px or more on the screen', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    for (const open of [null, /^Now:/, /Not tied to a step/, /12 done steps/]) {
      if (open) await rowButton(page, open).first().click();
      const scale = (await transformOf(page)).scale;
      const small = await inArea(page).locator('.react-flow__node').evaluateAll((els, zoom) => {
        const found: string[] = [];
        for (const el of els) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            const parent = t.parentElement;
            if (!parent || !t.textContent?.trim() || parent.closest('.sr-only')) continue;
            const size = parseFloat(getComputedStyle(parent).fontSize);
            if (size * zoom < 11 - 0.01) found.push(`${t.textContent.trim().slice(0, 30)}: ${size * zoom}`);
          }
        }
        return found;
      }, scale);
      expect(small, "texts under 11 px").toEqual([]);
      if (open) await page.keyboard.press('Escape');
    }
  });

  test('moves the keyboard to the header of the row when a live change takes the pager away', async ({ page }) => {
    await page.clock.install();
    await openReal(page, { size: { width: 1280, height: 760 } });
    await rowButton(page, /Not tied to a step/).first().click();
    const older = inArea(page).getByRole('button', { name: 'Older cards' });
    await older.focus();
    await expect(older).toBeFocused();
    // The cards are fewer (a live change): the row fits on one page, and the pager is gone
    await routeCards(page, boardFile({ cards: [boardNote(19, { title: 'A loose note', step: undefined, area: 'checkpoint:a-board-tab-shows-the-real-work', ...ago(40) })] }));
    await page.clock.fastForward(31_000);
    await expect(inArea(page).getByRole('navigation', { name: /Pages of/ })).toHaveCount(0);
    await expect(inArea(page).locator('[data-row-control="lane:board"]')).toBeFocused();
  });

  test('moves the keyboard to the other page button when the one it was on has no page left', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 760 } });
    await rowButton(page, /Not tied to a step/).first().click();
    const older = inArea(page).getByRole('button', { name: 'Older cards' });
    const newer = inArea(page).getByRole('button', { name: 'Newer cards' });
    await older.focus();
    for (let turn = 0; turn < 12 && await older.isEnabled(); turn += 1) { await page.keyboard.press('Enter'); await frames(page, 4); }
    await expect(older).toBeDisabled();
    await expect(newer).toBeFocused();
    for (let turn = 0; turn < 12 && await newer.isEnabled(); turn += 1) { await page.keyboard.press('Enter'); await frames(page, 4); }
    await expect(newer).toBeDisabled();
    await expect(older).toBeFocused();
  });

  test('says "Next" and never "Now" in an Area that is not the current one', async ({ page }) => {
    await openReal(page, { area: /Later work/ });
    await expect(rowButton(page, /^Next: Plan the later work/)).toBeVisible();
    await expect(rowButton(page, /^Now/)).toHaveCount(0);
    await expect(inArea(page).getByText('Now', { exact: true })).toHaveCount(0);
    await expect(inArea(page).getByRole('article', { name: 'Later note' })).toBeVisible();
  });

  test('opens the done row with a press: the done steps with cards head them, the rest are listed; a second press closes it and the keyboard stays on the button', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    const done = rowButton(page, /12 done steps/);
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    await expect(inArea(page).getByRole('article', { name: 'On a done step' })).toHaveCount(0);
    await done.click();
    const open = rowButton(page, /12 done steps/);
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(open).toBeFocused();
    // The done steps are many: the opened row pages through them
    await expect(inArea(page).getByText(DONE_STEP(0), { exact: true }).first()).toBeVisible();
    const older = inArea(page).getByRole('button', { name: 'Older cards' });
    for (let page_ = 0; page_ < 6 && !(await inArea(page).getByRole('article', { name: 'On a done step' }).count()) && await older.count() && await older.isEnabled(); page_ += 1) await older.click();
    await expect(inArea(page).getByRole('article', { name: 'On a done step' })).toBeVisible();
    // One row is open at a time: the others are folded to one line
    await expect(rowButton(page, /^Now/)).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    await expect(rowButton(page, /12 done steps/)).toHaveAttribute('aria-expanded', 'false');
    await expect(rowButton(page, /12 done steps/)).toBeFocused();
    await expect(inArea(page).getByRole('article', { name: 'On a done step' })).toHaveCount(0);
  });

  test('lists the open steps that have no cards in one opened line, wrapping into columns', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /12 more open steps/).click();
    await expect(inArea(page).getByText(OPEN_STEP(0), { exact: true })).toBeVisible();
    const first = (await inArea(page).locator('.react-flow__node-step', { hasText: OPEN_STEP(0) }).first().boundingBox())!;
    const second = (await inArea(page).locator('.react-flow__node-step', { hasText: OPEN_STEP(1) }).first().boundingBox())!;
    expect(Math.abs(first.y - second.y) < 2 || first.x === second.x).toBe(true);
    await expectClearOfControls(page);
  });

  test('closes things innermost first with Escape: a dialog, the reader, the open row, then the Area', async ({ page }) => {
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({ status: 404, json: { error: 'No such document.' } }));
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /Not tied to a step/).first().click();
    await expect(rowButton(page, /Not tied to a step/).first()).toHaveAttribute('aria-expanded', 'true');
    const reading = board(page).getByRole('region', { name: 'Reader', exact: true });
    // A dialog first
    await inArea(page).getByRole('button', { name: 'Read A loose note' }).or(inArea(page).getByRole('button', { name: /^Open Picture/ }).first()).first().click();
    await expect(reading.or(page.getByRole('dialog'))).toBeVisible();
    if (await page.getByRole('dialog').count()) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else {
      await page.keyboard.press('Escape');
      await expect(reading).toHaveCount(0);
    }
    await expect(rowButton(page, /Not tied to a step/).first()).toHaveAttribute('aria-expanded', 'true');
    // The reader, over the open row
    await inArea(page).getByRole('button', { name: /^Open Picture/ }).first().click();
    await expect(reading).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reading).toHaveCount(0);
    await expect(rowButton(page, /Not tied to a step/).first()).toHaveAttribute('aria-expanded', 'true');
    // The open row
    await page.keyboard.press('Escape');
    await expect(rowButton(page, /Not tied to a step/).first()).toHaveAttribute('aria-expanded', 'false');
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
    // The Area
    await page.keyboard.press('Escape');
    await expect(inArea(page)).toHaveCount(0);
  });

  test('reaches a card button with the Tab key, and the card is in view', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    await board(page).getByRole('button', { name: 'Board ›' }).focus();
    let reached: string | null = null;
    for (let press = 0; press < 40 && !reached; press += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        return element?.closest('#board-area article') && /^(Open|Read) /.test(element.getAttribute('aria-label') ?? '') ? (element.getAttribute('aria-label') ?? null) : null;
      });
    }
    expect(reached, 'Tab never reached a card button').not.toBeNull();
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
    expect(await isWithin(focused, flow(page))).toBe(true);
  });

  test('lets the Board index reach every item by a jump, with the card in view, highlighted and focused, including one on a later page', async ({ page }) => {
    test.slow();
    await openReal(page, { size: { width: 1280, height: 800 }, nav: true });
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await expect(inArea(page)).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Board index' });
    const wanted = /^(Picture|A loose note|Newest on|Older on|On a|On another|On a third|Commit|Later note)/;
    const rows = nav.locator('ul li');
    const labels: string[] = [];
    for (const row of await rows.all()) {
      const text = ((await row.locator('button').first().textContent()) ?? '').trim();
      if (wanted.test(text) && await row.isVisible()) labels.push(text);
    }
    expect(labels.length).toBeGreaterThanOrEqual(15);
    for (const label of labels) {
      await nav.locator('ul li').filter({ hasText: label }).locator('button').first().click();
      await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
      const highlighted = inArea(page).locator('.react-flow__node[data-highlighted="true"]');
      await expect(highlighted, label).toHaveCount(1);
      await expect.poll(() => highlighted.evaluate((element) => element.contains(document.activeElement)), { message: label }).toBe(true);
      await expect.poll(() => isWithin(highlighted, flow(page)), { message: label }).toBe(true);
      await expectClearOfControls(page);
      const focused = page.locator(':focus');
      expect(await isWithin(focused, flow(page)), `${label}: the focused control is outside the canvas`).toBe(true);
      // The keyboard is on something that can be seen and pressed: the topmost thing at its centre is it, or inside it
      expect(await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const r = element.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return Boolean(top && (top === element || element.contains(top)));
      }), `${label}: the focused control is hidden`).toBe(true);
    }
  });

  test('lets go of an open row that a live change took away, so Escape leaves the Area on the first press', async ({ page }) => {
    await page.clock.install();
    await openReal(page, { size: { width: 1280, height: 800 } });
    await rowButton(page, /12 done steps/).click();
    await expect(rowButton(page, /12 done steps/)).toHaveAttribute('aria-expanded', 'true');
    // The plan loses its done steps (a live change): the row is not there any more
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ title: 'Real', checkpoints: [
      checkpoint('Concept', { done: true, steps: [step('Drew the idea', true)] }),
      checkpoint('A Board tab shows the real work', { steps: [step(OPEN_STEP(0))] }),
    ] }) }));
    // The plan is read again every half minute
    await page.clock.fastForward(31_000);
    await expect(rowButton(page, /done steps/)).toHaveCount(0);
    await expect(inArea(page).locator('.react-flow__node-step button[aria-expanded="true"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(inArea(page)).toHaveCount(0);
  });

  test('folds the rows with the least priority first when the canvas is short, and a press opens one', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 672 } });
    // (32 px taller than before: the Now line takes that much of the pane)
    // Something is folded (commits, then what is tied to no step ...), and the current step and the waiting decisions never are
    await expect(rowButton(page, /^Now/)).toBeVisible();
    await expect(inArea(page).getByRole('article', { name: 'Waits for you' })).toBeVisible();
    const folded = inArea(page).locator('.react-flow__node-fold');
    expect(await folded.count()).toBeGreaterThanOrEqual(2);
    await expectClearOfControls(page);
    await folded.first().getByRole('button').click();
    await expect(inArea(page).locator('.react-flow__node-step button[aria-expanded="true"]')).toHaveCount(1);
    await expectClearOfControls(page);
    await page.keyboard.press('Escape');
    await expect(inArea(page).locator('.react-flow__node-step button[aria-expanded="true"]')).toHaveCount(0);
  });

  test('has no serious accessibility violations, in light and dark, with folded rows, "+N more" and a row open', async ({ page }) => {
    await openReal(page, { size: { width: 1280, height: 800 } });
    const axe = async () => {
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      const results = await new AxeBuilder({ page }).include('[aria-label="Board"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.html.slice(0, 100)}`).join(' | ')}`);
      expect(serious, serious.join('\n')).toEqual([]);
    };
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await axe();
    }
    await rowButton(page, /Not tied to a step/).first().click();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await axe();
    }
  });
});
