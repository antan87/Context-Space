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
  viewport: { width: 1280, height: 800 },
});

const typedInputs: string[] = [];

test.beforeEach(async ({ page }) => {
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
  await page.route('**/api/workspace/*/plan', (route) =>
    route.fulfill({
      json: planFile({
        title: 'Reports CSV export',
        checkpoints: [
          checkpoint('Reports export to CSV', {
            steps: [step('Write the CSV writer', true), step('Background job queue for large exports')],
            decisions: [decision('Which time zone should export timestamps use?')],
          }),
        ],
      }),
    })
  );
  await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
  await page.route('**/api/workspace/*/board', (route) =>
    route.fulfill({
      json: boardFile({
        cards: [
          boardNote(1, { title: 'Architecture note', body: 'Design notes for the CSV export pipeline.' }),
        ],
      }),
    })
  );
  typedInputs.length = 0;
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type === 'input') {
        typedInputs.push(parsed.data);
        socket.send(JSON.stringify({ type: 'output', data: parsed.data }));
      }
      if (parsed.type === 'attach') {
        const terminal = { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: `/tmp/${parsed.workspace}`, state: 'running' };
        socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      }
    });
  });
});

test.describe('Board & Terminal Unified Co-Working', () => {
  test('switches seamlessly between Board (100%), Split (50/50), and Terminal (100%)', async ({ page }) => {
    await page.goto('/#/workspaces/demo/board');

    const boardBtn = page.getByTestId('view-mode-board');
    const splitBtn = page.getByTestId('view-mode-split');
    const terminalBtn = page.getByTestId('view-mode-terminal');

    await expect(boardBtn).toBeVisible();
    await expect(splitBtn).toBeVisible();
    await expect(terminalBtn).toBeVisible();

    // 1. Switch to Split mode
    await splitBtn.click();
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-dock-slot')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Board' })).toBeVisible();

    // 2. Switch to Board mode (100% full viewport)
    await boardBtn.click();
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Board' })).toBeVisible();
    await expect(page.getByTestId('chat-dock-slot')).toHaveCount(0);

    // 3. Switch to Terminal mode (100% full viewport)
    await terminalBtn.click();
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
    await expect(page.getByTestId('chat-dock-slot')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Board' })).toBeHidden();

    // 4. Return to Board via Mode Switcher
    await boardBtn.click();
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Board' })).toBeVisible();
    await expect(page.getByTestId('chat-dock-slot')).toHaveCount(0);
  });

  test('supports keyboard shortcuts for mode switching and toggle', async ({ page }) => {
    await page.goto('/#/workspaces/demo/board');

    const boardBtn = page.getByTestId('view-mode-board');
    const splitBtn = page.getByTestId('view-mode-split');
    const terminalBtn = page.getByTestId('view-mode-terminal');

    // First ensure we are in Board mode
    await boardBtn.click();
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');

    // Ctrl+2 -> Split mode
    await page.keyboard.press('Control+2');
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-dock-slot')).toBeVisible();

    // Ctrl+1 -> Board mode
    await page.keyboard.press('Control+1');
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-dock-slot')).toHaveCount(0);

    // Ctrl+3 -> Terminal mode
    await page.keyboard.press('Control+3');
    await expect(terminalBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);

    // Ctrl+` -> Toggle Board/Split (from Terminal switches to Split)
    await page.keyboard.press('Control+`');
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true');

    // Toggle again -> Board
    await page.keyboard.press('Control+`');
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');

    // Cmd+J (Meta+J) -> Toggle Board/Split
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true })));
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true');

    // Toggle again -> Board
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true })));
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');

    // Ctrl+j (without Meta) must NOT toggle (avoids hijacking terminal newline / browser downloads)
    await page.keyboard.press('Control+j');
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('clicking "Ask in CLI ↗" on a card switches to split view and prefills the prompt', async ({ page }) => {
    await page.goto('/#/workspaces/demo/board');

    // Step into the area so cards are rendered on the canvas
    const areaBtn = page.locator('.board-overview-plane button.board-area').first();
    await expect(areaBtn).toBeVisible();
    await areaBtn.click();
    await expect(page.getByRole('button', { name: 'Board ›' })).toBeVisible();

    // Switch to Board mode (chat hidden)
    const boardBtn = page.getByTestId('view-mode-board');
    await boardBtn.click();
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-dock-slot')).toHaveCount(0);

    // Open the note actions menu on the note card
    const actionsBtn = page.getByRole('button', { name: /Actions for Architecture note/ });
    await expect(actionsBtn).toBeVisible();
    await actionsBtn.click();

    // Click "Ask in CLI"
    const askMenuItem = page.getByRole('menuitem', { name: /Ask in CLI/ });
    await expect(askMenuItem).toBeVisible();
    await askMenuItem.click();

    // Should automatically switch to split view
    const splitBtn = page.getByTestId('view-mode-split');
    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-dock-slot')).toBeVisible();

    // The terminal should receive the prefilled prompt over the wire and be focused
    await expect.poll(() => typedInputs.at(-1)).toBe('Regarding Architecture note: ');
    const terminalPane = page.getByTestId('terminal-pane');
    await expect(terminalPane).toBeVisible();
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await expect(page.locator('.xterm-rows')).toContainText('Regarding Architecture note: ');

    // Return to board mode and test "Ask in CLI ↗" on the decision card
    await boardBtn.click();
    await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-dock-slot')).toHaveCount(0);

    // "Ask in CLI" is in the dialog that the quiet button at the end of the card's answers opens
    await page.getByTestId('decision-more-answers').click();
    const decisionAskBtn = page.getByTestId('decision-dialog').locator('button[title*="Which time zone"]');
    await expect(decisionAskBtn).toBeVisible();
    await decisionAskBtn.click();

    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-dock-slot')).toBeVisible();
    await expect.poll(() => typedInputs.at(-1)).toBe('Regarding Which time zone should export timestamps use?: ');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  });
});

test.describe('Board overview in Split mode: small cards', () => {
  // The app's sidebar on its slim rail, as the app starts, so the stage has the room beside the terminal
  test.use({ sidebarDocked: false });
  const TITLES = [
    'Board opens on the work under way', 'The plan is the first thing a person reads', 'Commits read as sentences, not hashes', 'Documents open in a reader beside the board',
    'Areas stay readable at every window size', 'Pictures are told apart from files', 'The AI says what it needs from you', 'Notes keep who wrote them',
    'Decisions wait in one place', 'The index finds a card in one click', 'Release notes say what changed',
  ];
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const PICTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

  /** The stage the board has in Split mode at the default 50 % share, with the app's sidebar on its rail (measured). */
  const SPLIT = [
    { window: { width: 1440, height: 900 }, stage: { width: 652, height: 824 } },
    { window: { width: 1280, height: 800 }, stage: { width: 572, height: 724 } },
    { window: { width: 1100, height: 700 }, stage: { width: 482, height: 624 } },
  ];

  /** Opens the board in Split mode with `count` Areas (the first `done` finished), at rest. */
  async function openSplit(page: import('@playwright/test').Page, size: { width: number; height: number }, options: { count?: number; done?: number; percent?: number; pictureOn?: number; questionOn?: number; split?: boolean } = {}) {
    const count = options.count ?? 11;
    const done = options.done ?? 0;
    const percent = options.percent ?? 50;
    const pictureOn = options.pictureOn ?? Math.min(8, count - 1);
    const questionOn = options.questionOn ?? 0;
    const titles = Array.from({ length: count }, (_, i) => TITLES[i] ?? `Checkpoint ${i + 1}: the work of one slice`);
    // e2e/fixtures.ts:205 writes percent: 62 when no key is stored, so the spec stores the real default of 50 %; a fresh real profile gives 652x824, 572x724 and 482x624 (the Now line takes 32 px of the pane's height)
    await page.addInitScript((share) => { try { localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: share })); } catch { /* no storage */ } }, percent);
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Reports CSV export',
        checkpoints: titles.map((title, i) => checkpoint(title, {
          done: i < done,
          steps: [step(`First step of ${title}`, i <= done), step(`Second step of ${title}`, i < done), step(`Third step of ${title}`, i < done)],
          ...(i === questionOn ? { decisions: [decision('Which size is the least a person can read?')] } : {}),
        })),
      }),
    }));
    await page.route('**/api/workspace/*/documents/file**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({
      json: boardFile({ cards: [boardFileCard(2, 'board-pictures/a.png', { title: 'The overview', step: undefined, area: `checkpoint:${slug(titles[pictureOn]!)}` })] }),
    }));
    // The size is set after every route is in place: a resize can mount a card's <img>, and a request with no route fails for good
    await page.setViewportSize(size);
    await page.goto('/#/workspaces/demo/board');
    if (options.split === false) {
      await page.getByTestId('view-mode-board').click();
      await expect(page.getByTestId('chat-dock-slot')).toHaveCount(0);
    } else {
      await page.getByTestId('view-mode-split').click();
      await expect(page.getByTestId('chat-dock-slot')).toBeVisible();
    }
    const board = page.getByRole('region', { name: 'Board', exact: true });
    await expect(board.locator('#board-overview .react-flow__node[class*="react-flow__node-area"]').first()).toBeVisible({ timeout: 15000 });
    await atRest(page);
    return board;
  }

  const overviewTransform = (page: import('@playwright/test').Page) =>
    page.locator('#board-overview .react-flow__viewport').evaluate((element) => getComputedStyle(element).transform);
  const cardBoxes = (page: import('@playwright/test').Page) =>
    page.locator('#board-overview button.board-area').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));

  /** The view has stopped moving: the same transform over a few frames. */
  async function atRest(page: import('@playwright/test').Page) {
    let last = '';
    await expect.poll(async () => {
      const now = await overviewTransform(page).catch(() => '');
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
      const still = now !== '' && now === last;
      last = now;
      return still;
    }, { intervals: [200], timeout: 15000 }).toBe(true);
  }

  for (const { window: size, stage: expected } of SPLIT) {
    test(`draws 11 Areas as small cards at ${size.width}x${size.height}, and a press steps in and back to the same card`, async ({ page }) => {
      const board = await openSplit(page, size);
      const fold = board.locator('#board-overview button.board-area-fold');
      const isFolded = await fold.isVisible();
      const cards = board.locator('#board-overview button.board-area');
      if (isFolded) {
        await expect(fold).toHaveText('4 more');
        await expect(cards).toHaveCount(7);
      } else {
        await expect(cards).toHaveCount(11);
        await expect(board.locator('#board-overview .react-flow__node-area')).toHaveCount(1);
        await expect(board.locator('#board-overview .react-flow__node-areaMini')).toHaveCount(10);
      }
      await atRest(page);

      const facts = await board.locator('#board-overview').evaluate((overview) => {
        const stage = overview.querySelector('.react-flow')!.getBoundingClientRect();
        const boxes = Array.from(overview.querySelectorAll<HTMLElement>('button.board-area')).map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
        const small: string[] = [];
        for (const el of Array.from(overview.querySelectorAll<HTMLElement>('button.board-area *'))) {
          const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent?.trim() ?? '').join('');
          if (own && parseFloat(getComputedStyle(el).fontSize) < 12) small.push(own);
        }
        return { stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height }, boxes, small };
      });
      const { stage, boxes } = facts;
      // The sizes people really see in Split mode at the default share
      expect(Math.round(stage.width)).toBe(expected.width);
      expect(Math.round(stage.height)).toBe(expected.height);
      const miniBoxes = boxes.slice(1);
      expect(new Set(miniBoxes.map((box) => Math.round(box.x))).size, 'two columns').toBe(2);
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(stage.x - 0.5);
        expect(box.y).toBeGreaterThanOrEqual(stage.y - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
        expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height + 0.5);
        expect(box.height).toBeGreaterThanOrEqual(75.5);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!; const b = boxes[j]!;
        expect(a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5, `card ${i} overlaps card ${j}`).toBe(true);
      }
      expect(facts.small, 'text under 12 px').toEqual([]);

      if (isFolded) {
        await fold.click();
        await atRest(page);
      }

      // A picture shows where the card is wide and high enough, and only there
      const picCard = cards.filter({ hasText: TITLES[8]! });
      const picBox = (await picCard.boundingBox())!;
      const withPicture = cards.filter({ has: page.locator('img') });
      const wide = picBox.width >= 240 && picBox.height >= 92;
      await expect(withPicture).toHaveCount(wide ? 1 : 0);
      if (wide) await expect(withPicture).toHaveAttribute('aria-label', new RegExp(TITLES[8]!));

      // A press steps into the Area, and stepping back returns to the same card
      const target = cards.filter({ hasText: TITLES[4]! });
      await target.focus();
      await page.keyboard.press('Enter');
      await expect(board.getByRole('button', { name: 'Board ›' })).toBeVisible();
      await board.getByRole('button', { name: 'Board ›' }).click();
      await expect(board.locator('#board-area')).toHaveCount(0);
      await expect(target).toBeFocused();
    });
  }

  test('does not move the view for an index jump to an Area and back, nor for Tab across the cards, with no fold open (1100x700)', async ({ page }) => {
    const board = await openSplit(page, { width: 1100, height: 700 });
    const fold = board.locator('#board-overview button.board-area-fold');
    const cards = board.locator('#board-overview button.board-area');
    await expect(cards).toHaveCount(7);
    await expect(fold).toHaveText('4 more');
    const before = await overviewTransform(page);
    // An index jump to a visible Area and back
    await page.getByRole('button', { name: /^Board index/ }).click();
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();
    await nav.getByRole('button', { name: new RegExp(TITLES[6]!) }).first().click();
    await expect(board.getByRole('button', { name: 'Board ›' })).toBeVisible();
    await board.getByRole('button', { name: 'Board ›' }).click();
    await expect(board.locator('#board-area')).toHaveCount(0);
    await atRest(page);
    expect(await overviewTransform(page), 'after an index jump and back').toBe(before);
    expect(await cardBoxes(page)).toHaveLength(7);

    // Tab across the cards: each one gets focus and the view stays
    await cards.first().focus();
    await expect(cards.first()).toBeFocused();
    const heroSteps = board.locator('#board-overview .react-flow__node-area button:not(.board-area)');
    const stepCount = await heroSteps.count();
    for (let s = 0; s < stepCount; s++) {
      await page.keyboard.press('Tab');
      await expect(heroSteps.nth(s)).toBeFocused();
    }
    for (let i = 1; i < 7; i++) {
      await page.keyboard.press('Tab');
      await expect(cards.nth(i)).toBeFocused();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await overviewTransform(page), `Tab to card ${i}`).toBe(before);
    }
    await page.keyboard.press('Tab');
    await expect(fold).toBeFocused();
    expect(await overviewTransform(page), 'Tab to fold').toBe(before);
  });

  test('with a fold open, Tab through the rows below the stage keeps x, and each focused card ends whole in view (1100x700)', async ({ page }) => {
    const board = await openSplit(page, { width: 1100, height: 700 }, { count: 25, done: 15 });
    const overview = board.locator('#board-overview');
    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toBeVisible();
    await fold.click();
    await expect(fold).toHaveText('Show fewer');
    await expect(overview.locator('button.board-area')).toHaveCount(25);
    await atRest(page);
    const x0 = (await overviewTransform(page)).match(/matrix\(([^)]*)\)/)![1]!.split(',').map(Number)[4];
    const cards = overview.locator('button.board-area');
    // Some of the cards are below the stage, so the Tab has something to bring in
    const hidden = await overview.evaluate((root) => {
      const stage = root.querySelector('.react-flow')!.getBoundingClientRect();
      return Array.from(root.querySelectorAll('button.board-area')).filter((el) => el.getBoundingClientRect().bottom > stage.bottom).length;
    });
    expect(hidden).toBeGreaterThan(0);
    await cards.first().focus();
    const heroSteps = board.locator('#board-overview .react-flow__node-area button:not(.board-area)');
    const stepCount = await heroSteps.count();
    for (let s = 0; s < stepCount; s++) {
      await page.keyboard.press('Tab');
      await expect(heroSteps.nth(s)).toBeFocused();
    }
    for (let i = 1; i < 25; i++) {
      await page.keyboard.press('Tab');
      await expect(cards.nth(i)).toBeFocused();
      await atRest(page);
      const x = (await overviewTransform(page)).match(/matrix\(([^)]*)\)/)![1]!.split(',').map(Number)[4];
      expect(x, `x after Tab to card ${i}`).toBe(x0);
      const whole = await overview.evaluate((root, index) => {
        const stage = root.querySelector('.react-flow')!.getBoundingClientRect();
        const r = Array.from(root.querySelectorAll('button.board-area'))[index]!.getBoundingClientRect();
        return r.x >= stage.x - 0.5 && r.y >= stage.y - 0.5 && r.x + r.width <= stage.x + stage.width + 0.5 && r.y + r.height <= stage.y + stage.height + 0.5;
      }, i);
      expect(whole, `card ${i} whole in view`).toBe(true);
    }
    await page.keyboard.press('Tab');
    await expect(fold).toBeFocused();
  });

  const matrix = async (page: import('@playwright/test').Page) => (await overviewTransform(page)).match(/matrix\(([^)]*)\)/)![1]!.split(',').map(Number);
  const stageBox = (page: import('@playwright/test').Page) => page.locator('#board-overview .react-flow').evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });

  /** Where a card stands in the stage, and whether a press on its title would reach the card (the pane's icons are over the stage's top edge). */
  const titleHit = (card: import('@playwright/test').Locator) => card.evaluate((el) => {
    const stage = el.closest('.react-flow')!.getBoundingClientRect();
    const own = (node: Element) => Array.from(node.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
    const text = Array.from(el.querySelectorAll('*')).find(own) ?? el;
    const box = text.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const card = el.getBoundingClientRect();
    return { inCard: Boolean(hit && el.contains(hit)), hit: hit ? `${hit.tagName} ${(hit.textContent ?? '').trim().slice(0, 24)}` : 'nothing', top: card.y - stage.y, bottom: stage.bottom - card.bottom };
  });

  test('a card moved into view never lands under the pane icons: Shift+Tab back to the top with a fold open (1100x520, 35 % share)', async ({ page }) => {
    const board = await openSplit(page, { width: 1100, height: 520 }, { count: 25, done: 15, percent: 35 });
    const overview = board.locator('#board-overview');
    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toBeVisible();
    await fold.click();
    await expect(fold).toHaveText('Show fewer');
    const cards = overview.locator('button.board-area');
    await expect(cards).toHaveCount(25);
    await cards.last().focus();
    await atRest(page);
    for (let i = 24; i > 1; i--) {
      await page.keyboard.press('Shift+Tab');
      if (i - 1 === 18) {
        await expect(overview.locator('button[aria-label="The overview"]')).toBeFocused();
        await page.keyboard.press('Shift+Tab');
      }
      await expect(cards.nth(i - 1)).toBeFocused();
    }
    const heroSteps = board.locator('#board-overview .react-flow__node-area button:not(.board-area)');
    const stepCount = await heroSteps.count();
    for (let s = stepCount - 1; s >= 0; s--) {
      await page.keyboard.press('Shift+Tab');
      await expect(heroSteps.nth(s)).toBeFocused();
    }
    await page.keyboard.press('Shift+Tab');
    await expect(cards.first()).toBeFocused();
    await atRest(page);
    const where = await titleHit(cards.first());
    expect(where.top, 'the first card is below the inset').toBeGreaterThanOrEqual(44 - 0.5);
    expect(where.inCard, `a press on its title hits ${where.hit}`).toBe(true);
  });

  test('a card focused after a pan is moved to the inset, not under the pane icons (1100x700)', async ({ page }) => {
    const board = await openSplit(page, { width: 1100, height: 700 });
    const fold = board.locator('#board-overview button.board-area-fold');
    if (await fold.isVisible()) await fold.click();
    const cards = board.locator('#board-overview button.board-area');
    await expect(cards).toHaveCount(11);
    // A pan by hand: the grid up by 40 px, so the top row is at y=4 and still whole in view
    const stage = await stageBox(page);
    await page.mouse.move(stage.x + 8, stage.y + 300);
    await page.mouse.down();
    await page.mouse.move(stage.x + 8, stage.y + 280, { steps: 4 });
    await page.mouse.move(stage.x + 8, stage.y + 260, { steps: 4 });
    await page.mouse.up();
    await atRest(page);
    expect((await matrix(page))[5]).toBe(4);
    const boxes = await cardBoxes(page);
    const index = boxes.reduce((best, box, i) => (box.y < boxes[best]!.y - 1 || (Math.abs(box.y - boxes[best]!.y) <= 1 && box.x > boxes[best]!.x) ? i : best), 0);
    await cards.nth(index).focus();
    await atRest(page);
    const where = await titleHit(cards.nth(index));
    expect(where.top).toBeGreaterThanOrEqual(44 - 0.5);
    expect(where.inCard, `a press on its title hits ${where.hit}`).toBe(true);
  });

  test('after an index jump to a card below the stage and back, a taller window keeps the view (fold open, 1100x520)', async ({ page }) => {
    const board = await openSplit(page, { width: 1100, height: 520 }, { count: 25, done: 15, percent: 35 });
    const overview = board.locator('#board-overview');
    const fold = overview.locator('button.board-area-fold');
    await fold.click();
    await expect(fold).toHaveText('Show fewer');
    await atRest(page);
    const last = overview.locator('button.board-area').filter({ hasText: /Checkpoint 25/ });
    await page.getByRole('button', { name: /^Board index/ }).click();
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();
    await nav.getByRole('button', { name: /Checkpoint 25/ }).first().click();
    await expect(board.getByRole('button', { name: 'Board ›' })).toBeVisible();
    await board.getByRole('button', { name: 'Board ›' }).click();
    await expect(board.locator('#board-area')).toHaveCount(0);
    await atRest(page);
    const before = await matrix(page);
    const whole = async () => {
      const stage = await stageBox(page);
      const box = (await last.boundingBox())!;
      return box.y >= stage.y - 0.5 && box.y + box.height <= stage.y + stage.height + 0.5;
    };
    expect(await whole(), 'the card of the jump is whole in view').toBe(true);
    await page.setViewportSize({ width: 1100, height: 526 });
    await atRest(page);
    expect((await matrix(page))[5], 'the view stays where the person has it').toBe(before[5]);
    expect(await whole(), 'and the card is still whole in view').toBe(true);
  });

  test('a card stepped back to is whole in the stage when the divider turned the small cards into rows while inside the Area (fold open, 1100x430, 35 % share)', async ({ page }) => {
    const board = await openSplit(page, { width: 1100, height: 430 }, { count: 25, done: 15, percent: 35 });
    const overview = board.locator('#board-overview');
    const fold = overview.locator('button.board-area-fold');
    await fold.click();
    await expect(fold).toHaveText('Show fewer');
    const cards = overview.locator('button.board-area');
    await expect(cards).toHaveCount(25);
    await cards.last().focus();
    await page.keyboard.press('Enter');
    await expect(board.getByRole('button', { name: 'Board ›' })).toBeVisible();
    // The divider moves while the person is inside the Area; the overview behind it changes form and starts from the plan's view
    const divider = page.getByRole('separator', { name: 'Resize the workspace panes' });
    await divider.focus();
    const before = await overview.locator('.react-flow__node-areaMini').count();
    for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', '75');
    await board.getByRole('button', { name: 'Board ›' }).click();
    await expect(board.locator('#board-area')).toHaveCount(0);
    await atRest(page);
    expect(before, 'the cards were small cards before').toBe(24);
    await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(0);
    await expect(cards.last()).toBeFocused();
    expect((await matrix(page))[0], 'rows are at life size').toBe(1);
    const stage = await stageBox(page);
    const box = (await cards.last().boundingBox())!;
    expect(box.y, 'the card is not above the stage').toBeGreaterThanOrEqual(stage.y - 0.5);
    expect(box.y + box.height, 'and not below it').toBeLessThanOrEqual(stage.y + stage.height + 0.5);
  });

  test('the form of the overview changes with the index: the view goes back to the plan\'s, at zoom 1 for small cards (Board mode 1200x720)', async ({ page }) => {
    const board = await openSplit(page, { width: 1200, height: 752 }, { split: false });
    const overview = board.locator('#board-overview');
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);
    const fold = overview.locator('button.board-area-fold');
    if (await fold.isVisible()) await fold.click();
    await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(10);
    const boxesBefore = await cardBoxes(page);
    const stage = await stageBox(page);
    await page.mouse.move(stage.x + 4, stage.y + 300);
    await page.mouse.down();
    await page.mouse.move(stage.x + 4, stage.y + 280, { steps: 4 });
    await page.mouse.up();
    await atRest(page);
    await page.getByRole('button', { name: /^Board index/ }).click();
    await expect(page.getByRole('navigation', { name: 'Board index' })).toBeVisible();
    await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(10);
    await atRest(page);
    const [zoom, , , , , y] = await matrix(page);
    expect(zoom, 'small cards are at life size').toBe(1);
    expect(y, 'and at the plan\'s top').toBe(44);
    const boxesAfter = await cardBoxes(page);
    expect(boxesAfter[1]!.width, 'opening the index changes card layout').not.toBe(boxesBefore[1]!.width);
    for (let i = 0; i < boxesAfter.length; i++) {
      for (let j = i + 1; j < boxesAfter.length; j++) {
        const a = boxesAfter[i]!;
        const b = boxesAfter[j]!;
        expect(a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5, `card ${i} overlaps card ${j}`).toBe(true);
      }
    }
  });

  test('a picture shows on a card with a status only where the status has a line of its own (240 x 96 and up)', async ({ page }) => {
    // The picture is on an Area which also waits for an answer (status); stage gives small cards of about 93 px, then about 103 px
    for (const { height, shows } of [{ height: 736, shows: false }, { height: 760, shows: true }]) {
      const board = await openSplit(page, { width: 1280, height: height }, { count: 8, pictureOn: 2, questionOn: 2 });
      const card = board.locator('#board-overview button.board-area').filter({ hasText: TITLES[2]! });
      const box = (await card.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(240);
      if (shows) expect(box.height).toBeGreaterThanOrEqual(96); else { expect(box.height).toBeGreaterThanOrEqual(92); expect(box.height).toBeLessThan(96); }
      await expect(card.locator('img')).toHaveCount(shows ? 1 : 0);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });

  test('Tab at rest does not take the view: a window that changes still lays the cards out again (Board mode 1200x720)', async ({ page }) => {
    const board = await openSplit(page, { width: 1200, height: 752 }, { split: false });
    const fold = board.locator('#board-overview button.board-area-fold');
    if (await fold.isVisible()) await fold.click();
    const cards = board.locator('#board-overview button.board-area');
    await expect(cards).toHaveCount(11);
    await cards.first().focus();
    await expect(cards.first()).toBeFocused();
    const heroSteps = board.locator('#board-overview .react-flow__node-area button:not(.board-area)');
    const stepCount = await heroSteps.count();
    for (let s = 0; s < stepCount; s++) {
      await page.keyboard.press('Tab');
      await expect(heroSteps.nth(s)).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(cards.nth(1)).toBeFocused();
    await atRest(page);
    const resting = await matrix(page);
    expect(resting[5], 'at 1200x720 the cards stand at the top').toBe(44);
    const boxBefore = (await cards.nth(1).boundingBox())!;
    // A taller window: the cards are laid out again, and the view follows because Tab did not move it
    await page.setViewportSize({ width: 1200, height: 832 });
    await atRest(page);
    expect((await cards.nth(1).boundingBox())!.height, 'the cards are laid out again').not.toBe(boxBefore.height);
    expect((await matrix(page))[5], 'and the cards still stand at the top').toBe(44);
  });
});
