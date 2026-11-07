import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { checkpoint, planFile, step } from './planData.js';

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

interface MockCard {
  id: string;
  kind: 'note' | 'file';
  title: string;
  body: string;
  pinned: boolean;
  archived: boolean;
  by: string;
  at: string;
  updatedBy: string;
  updatedAt: string;
  area?: string;
  step?: string;
}

interface MockBoardState {
  board: {
    version: 1;
    revision: number;
    cards: MockCard[];
    links: any[];
    positions: Record<string, { x: number; y: number }>;
  };
  changesReceived: any[];
}

async function setupBoardRoutes(page: Page, initialCards: MockCard[] = []): Promise<MockBoardState> {
  const state: MockBoardState = {
    board: {
      version: 1,
      revision: 1,
      cards: [...initialCards],
      links: [],
      positions: {},
    },
    changesReceived: [],
  };

  const samplePlan = planFile({
    title: 'Reports CSV export',
    checkpoints: [
      checkpoint('Report rows load fast', { done: true, steps: [step('Query the report rows', true)] }),
      checkpoint('Reports export to CSV', {
        steps: [
          step('Write the CSV writer', true),
          step('Background job queue for large exports'),
          step('Download link in the report page'),
        ],
      }),
    ],
  });

  await page.route('**/api/workspace/demo/plan', (route) => {
    return route.fulfill({ json: samplePlan });
  });

  await page.route('**/api/workspace/demo/work', (route) => {
    return route.fulfill({
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
    });
  });

  await page.route('**/api/workspace/demo/news', (route) => {
    return route.fulfill({ json: { version: 1, revision: 1, commits: [] } });
  });

  await page.route('**/api/workspace/demo/board', (route) => {
    return route.fulfill({ json: state.board });
  });

  await page.route('**/api/workspace/demo/board/changes', async (route) => {
    const body = route.request().postDataJSON();
    state.changesReceived.push(body);
    const results: any[] = [];

    for (const change of body.changes) {
      if (change.op === 'add_card') {
        const id = change.id || `00000000-0000-4000-8000-${String(state.board.cards.length + 1).padStart(12, '0')}`;
        const now = new Date().toISOString();
        const newCard: MockCard = {
          id,
          kind: change.kind || 'note',
          title: change.title,
          body: change.body || '',
          pinned: Boolean(change.pinned),
          archived: false,
          by: 'user',
          at: now,
          updatedBy: 'user',
          updatedAt: now,
          ...(change.area ? { area: change.area } : {}),
          ...(change.step ? { step: change.step } : {}),
        };
        state.board.cards.push(newCard);
        results.push({ op: 'add_card', id });
      } else if (change.op === 'update_card') {
        const card = state.board.cards.find((c) => c.id === change.id);
        if (card) {
          if (change.title !== undefined) card.title = change.title;
          if (change.body !== undefined) card.body = change.body;
          if (change.pinned !== undefined) card.pinned = change.pinned;
          if (change.archived !== undefined) card.archived = change.archived;
          if (change.area !== undefined) card.area = change.area;
          if (change.step === null) delete card.step;
          else if (change.step !== undefined) card.step = change.step;
          card.updatedBy = 'user';
          card.updatedAt = new Date().toISOString();
        }
        results.push({ op: 'update_card', id: change.id });
      } else if (change.op === 'remove_card') {
        state.board.cards = state.board.cards.filter((c) => c.id !== change.id);
        results.push({ op: 'remove_card', id: change.id });
      }
    }

    state.board.revision += 1;
    return route.fulfill({
      status: 200,
      json: {
        ...state.board,
        results,
      },
    });
  });

  return state;
}

test.describe('Canvas Note Creation & In-Place Editing (Milestone 2, Slice 2.1)', () => {
  test('+ Note button creates a new note on the canvas with markdown and byline', async ({ page }) => {
    const state = await setupBoardRoutes(page);
    await page.goto('/#/workspaces/demo/board');

    // Click "+ Note" button in toolbar
    const noteBtn = page.getByRole('button', { name: /note/i }).first();
    await expect(noteBtn).toBeVisible();
    await noteBtn.click();

    // Verify dialog opens with accessible labels and elements
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'New note' })).toBeVisible();

    const titleInput = dialog.getByPlaceholder('Note title...');
    await expect(titleInput).toBeFocused();

    // Fill title and markdown body
    await titleInput.fill('Architecture Decisions');
    const bodyTextarea = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await bodyTextarea.fill('### Important considerations\n\n- Stream CSV rows\n- Avoid buffering large files');

    // Capture screenshot of Note Dialog

    // Submit dialog via Add note button
    const submitBtn = dialog.getByRole('button', { name: 'Add note' });
    await submitBtn.click();
    await expect(dialog).toHaveCount(0);

    // Verify backend received op: 'add_card'
    expect(state.changesReceived.length).toBeGreaterThan(0);
    const lastRequest = state.changesReceived[state.changesReceived.length - 1];
    expect(lastRequest.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'add_card',
          kind: 'note',
          title: 'Architecture Decisions',
          body: '### Important considerations\n\n- Stream CSV rows\n- Avoid buffering large files',
        }),
      ]),
    );

    // The board steps into the Area containing the new note by itself
    const areaRegion = page.locator('#board-area');
    await expect(areaRegion).toBeVisible();

    // Verify note card rendered on canvas with markdown and byline
    const noteCard = areaRegion.locator('article').filter({ hasText: 'Architecture Decisions' });
    await expect(noteCard).toBeVisible();
    await expect(noteCard.getByText('Stream CSV rows')).toBeVisible();
    await expect(noteCard.getByText('you', { exact: true })).toBeVisible();
    await expect(noteCard.locator('[title*="by you"]')).toBeVisible();

    // Capture screenshot of note rendered on the board canvas
  });

  test('editing an existing note updates title and markdown immediately', async ({ page }) => {
    const initialNote: MockCard = {
      id: '11111111-2222-4000-8000-333333333333',
      kind: 'note',
      title: 'Original Title',
      body: 'Original markdown content with items',
      pinned: false,
      archived: false,
      area: 'checkpoint:reports-export-to-csv',
      by: 'user',
      at: '2026-10-23T10:00:00.000Z',
      updatedBy: 'user',
      updatedAt: '2026-10-23T10:00:00.000Z',
    };

    const state = await setupBoardRoutes(page, [initialNote]);
    await page.goto('/#/workspaces/demo/board');

    // Step into checkpoint area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();
    const areaRegion = page.locator('#board-area');
    await expect(areaRegion).toBeVisible();

    const card = areaRegion.locator('article').filter({ hasText: 'Original Title' });
    await expect(card).toBeVisible();

    // Double clicking the note card opens the edit dialog
    await card.dblclick();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Edit note' })).toBeVisible();

    const titleInput = dialog.getByPlaceholder('Note title...');
    await expect(titleInput).toHaveValue('Original Title');
    const bodyInput = dialog.getByPlaceholder('Write Markdown, lists, notes, or links...');
    await expect(bodyInput).toHaveValue('Original markdown content with items');

    // Change title and body
    await titleInput.fill('Updated Title');
    await bodyInput.fill('Updated markdown body text');

    // Save changes
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toHaveCount(0);

    // Verify backend received op: 'update_card'
    const updateRequest = state.changesReceived.find((req) =>
      req.changes.some((c: any) => c.op === 'update_card' && c.id === initialNote.id),
    );
    expect(updateRequest).toBeDefined();
    const updateChange = updateRequest.changes.find((c: any) => c.op === 'update_card');
    expect(updateChange.title).toBe('Updated Title');
    expect(updateChange.body).toBe('Updated markdown body text');

    // Verify canvas updates immediately
    await expect(areaRegion.locator('article').filter({ hasText: 'Updated Title' })).toBeVisible();
    await expect(areaRegion.locator('article').filter({ hasText: 'Updated markdown body text' })).toBeVisible();
  });

  test('pinning and archiving a note via card actions menu', async ({ page }) => {
    const initialNote: MockCard = {
      id: '22222222-3333-4000-8000-444444444444',
      kind: 'note',
      title: 'Config Notes',
      body: 'Check database connection parameters',
      pinned: false,
      archived: false,
      area: 'checkpoint:reports-export-to-csv',
      by: 'user',
      at: '2026-10-23T10:00:00.000Z',
      updatedBy: 'user',
      updatedAt: '2026-10-23T10:00:00.000Z',
    };

    const state = await setupBoardRoutes(page, [initialNote]);
    await page.goto('/#/workspaces/demo/board');

    // Step into checkpoint area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();
    const areaRegion = page.locator('#board-area');
    await expect(areaRegion).toBeVisible();

    const card = areaRegion.locator('article').filter({ hasText: 'Config Notes' });
    await expect(card).toBeVisible();

    // Hover card and open actions menu
    await card.hover();
    const menuBtn = card.getByRole('button', { name: /actions for/i });
    await menuBtn.click();

    // Pin note
    const pinMenuItem = page.getByRole('menuitem', { name: 'Pin note' });
    await expect(pinMenuItem).toBeVisible();
    await pinMenuItem.click();

    // Verify backend update received pinned: true
    const pinRequest = state.changesReceived.find((req) =>
      req.changes.some((c: any) => c.op === 'update_card' && c.pinned === true),
    );
    expect(pinRequest).toBeDefined();

    // Archive note
    await card.hover();
    await menuBtn.click();
    const archiveMenuItem = page.getByRole('menuitem', { name: 'Archive note' });
    await expect(archiveMenuItem).toBeVisible();
    await archiveMenuItem.click();

    // Verify backend update received archived: true
    const archiveRequest = state.changesReceived.find((req) =>
      req.changes.some((c: any) => c.op === 'update_card' && c.archived === true),
    );
    expect(archiveRequest).toBeDefined();
  });

  test('note creation inside an Area inherits the active Area ID', async ({ page }) => {
    const state = await setupBoardRoutes(page);
    await page.goto('/#/workspaces/demo/board');

    // Step into checkpoint area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const areaRegion = page.locator('#board-area');
    await expect(areaRegion).toBeVisible();

    // Click "+ Note" in Area header
    const areaNoteBtn = areaRegion.locator('header').getByRole('button', { name: /note/i });
    await areaNoteBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Verify Area select defaults to the active checkpoint ID
    const areaSelect = dialog.locator('select').first();
    await expect(areaSelect).toHaveValue('checkpoint:reports-export-to-csv');

    // Fill title and save
    await dialog.getByPlaceholder('Note title...').fill('Area Specific Note');
    await dialog.getByPlaceholder('Write Markdown, lists, notes, or links...').fill('Content for this area');
    await dialog.getByRole('button', { name: 'Add note' }).click();
    await expect(dialog).toHaveCount(0);

    // Verify payload sent with active area
    const lastRequest = state.changesReceived[state.changesReceived.length - 1];
    expect(lastRequest.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'add_card',
          area: 'checkpoint:reports-export-to-csv',
          title: 'Area Specific Note',
        }),
      ]),
    );
  });

  test('double-clicking a compact note card with long cut text opens the edit dialog without being intercepted by ReadAll', async ({ page }) => {
    const longNote: MockCard = {
      id: '33333333-4444-4000-8000-555555555555',
      kind: 'note',
      title: 'Long Note Title That Is Very Descriptive',
      body: 'Line 1: Detailed specification requirements\n\nLine 2: Additional design considerations\n\nLine 3: Edge cases and failure modes\n\nLine 4: Implementation details',
      pinned: false,
      archived: false,
      area: 'checkpoint:reports-export-to-csv',
      by: 'user',
      at: '2026-10-23T10:00:00.000Z',
      updatedBy: 'user',
      updatedAt: '2026-10-23T10:00:00.000Z',
    };

    await setupBoardRoutes(page, [longNote]);
    await page.goto('/#/workspaces/demo/board');

    // Step into checkpoint area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();
    const areaRegion = page.locator('#board-area');
    await expect(areaRegion).toBeVisible();

    const card = areaRegion.locator('article').filter({ hasText: 'Long Note Title' });
    await expect(card).toBeVisible();

    // Double click the compact card with cut text
    await card.dblclick();

    // Verify Edit note dialog opens directly (not ReadAll dialog)
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Edit note' })).toBeVisible();
    await expect(dialog.getByPlaceholder('Note title...')).toHaveValue('Long Note Title That Is Very Descriptive');

    // Dismiss with Escape key
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('pressing Enter on note edit trigger opens the edit dialog and unassigning step sends step null', async ({ page }) => {
    const steppedNote: MockCard = {
      id: '44444444-5555-4000-8000-666666666666',
      kind: 'note',
      title: 'Step Note',
      body: 'Note tied to a step',
      pinned: false,
      archived: false,
      area: 'checkpoint:reports-export-to-csv',
      step: 'step:write-the-csv-writer',
      by: 'user',
      at: '2026-10-23T10:00:00.000Z',
      updatedBy: 'user',
      updatedAt: '2026-10-23T10:00:00.000Z',
    };

    const state = await setupBoardRoutes(page, [steppedNote]);
    await page.goto('/#/workspaces/demo/board');

    // Step into area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();
    const areaRegion = page.locator('#board-area');
    await expect(areaRegion).toBeVisible();

    const card = areaRegion.locator('article').filter({ hasText: 'Step Note' });
    await expect(card).toBeVisible();

    // Hover to reveal edit button and press Enter on it
    await card.hover();
    const editBtn = card.getByRole('button', { name: 'Edit Step Note' });
    await editBtn.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Edit note' })).toBeVisible();

    // Select "(None / General Area)" for step
    const stepSelect = dialog.locator('select').nth(1);
    await stepSelect.selectOption('');

    // Save changes
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toHaveCount(0);

    // Verify backend received update_card with step: null
    const updateRequest = state.changesReceived.find((req) =>
      req.changes.some((c: any) => c.op === 'update_card' && c.id === steppedNote.id && c.step === null),
    );
    expect(updateRequest).toBeDefined();
  });
});

test.describe('what is typed in the note dialog survives the clock and the board changing', () => {
  const focusWindow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const NOTE: MockCard = {
    id: '11111111-2222-4000-8000-333333333333', kind: 'note', title: 'Original Title', body: 'Original markdown content', pinned: false, archived: false,
    area: 'checkpoint:reports-export-to-csv', by: 'user', at: '2026-10-23T10:00:00.000Z', updatedBy: 'user', updatedAt: '2026-10-23T10:00:00.000Z',
  };

  test('a new note keeps its title and text past a minute and a window focus', async ({ page }) => {
    await page.clock.install({ time: new Date() });
    await setupBoardRoutes(page);
    await page.goto('/#/workspaces/demo/board');
    await page.getByRole('button', { name: /note/i }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Note title...').fill('A draft I am writing');
    await dialog.getByPlaceholder('Write Markdown, lists, notes, or links...').fill('Half of a long thought');
    await page.clock.fastForward('01:05');
    await focusWindow(page);
    await page.clock.fastForward('01:00');
    await expect(dialog.getByPlaceholder('Note title...')).toHaveValue('A draft I am writing');
    await expect(dialog.getByPlaceholder('Write Markdown, lists, notes, or links...')).toHaveValue('Half of a long thought');
  });

  test('an edit keeps what was changed, not the saved text, past a minute and a window focus', async ({ page }) => {
    await page.clock.install({ time: new Date() });
    await setupBoardRoutes(page, [NOTE]);
    await page.goto('/#/workspaces/demo/board');
    await page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' }).click();
    await page.locator('#board-area').locator('article').filter({ hasText: 'Original Title' }).dblclick();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit note' })).toBeVisible();
    await dialog.getByPlaceholder('Note title...').fill('Changed but not saved');
    await dialog.getByPlaceholder('Write Markdown, lists, notes, or links...').fill('Changed body');
    await page.clock.fastForward('01:05');
    await focusWindow(page);
    await page.clock.fastForward('01:00');
    await expect(dialog.getByPlaceholder('Note title...')).toHaveValue('Changed but not saved');
    await expect(dialog.getByPlaceholder('Write Markdown, lists, notes, or links...')).toHaveValue('Changed body');
  });

  test('a live change to the board while typing leaves the text, in a new note and in an edit', async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const state = await setupBoardRoutes(page, [NOTE]);
    let reads = 0;
    await page.route('**/api/workspace/demo/board', (route) => { reads += 1; return route.fulfill({ json: state.board }); });
    await page.goto('/#/workspaces/demo/board');
    await page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' }).click();
    await page.locator('#board-area').locator('article').filter({ hasText: 'Original Title' }).dblclick();
    const dialog = page.getByRole('dialog');
    const title = dialog.getByPlaceholder('Note title...');
    await title.fill('Mid-sentence in an edit');
    const before = reads;
    // the AI changes the very note and adds another while the dialog is open
    state.board = { ...state.board, revision: state.board.revision + 1, cards: [{ ...NOTE, title: 'Changed by the AI', body: 'New body from the AI', updatedBy: 'claude', updatedAt: new Date().toISOString() }, { ...NOTE, id: '11111111-2222-4000-8000-444444444444', title: 'A second note by the AI' }] };
    await page.clock.fastForward('00:35');
    await expect.poll(() => reads).toBeGreaterThan(before);
    await page.clock.fastForward('00:35');
    await expect(title).toHaveValue('Mid-sentence in an edit');
    await expect(dialog.getByPlaceholder('Write Markdown, lists, notes, or links...')).toHaveValue('Original markdown content');
  });
});
