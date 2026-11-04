import { test, expect } from './fixtures';
import { boardFile, boardNote, checkpoint, decision, planFile, step, whatsNew } from './planData';

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

    const decisionAskBtn = page.locator('button[title*="Which time zone"]');
    await expect(decisionAskBtn).toBeVisible();
    await decisionAskBtn.click();

    await expect(splitBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-dock-slot')).toBeVisible();
    await expect.poll(() => typedInputs.at(-1)).toBe('Regarding Which time zone should export timestamps use?: ');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  });
});
