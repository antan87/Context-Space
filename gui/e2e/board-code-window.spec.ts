import { test, expect, type Page } from './fixtures';
import { boardFile, boardNote, checkpoint, planFile, step, whatsNew } from './planData';

/**
 * The Code window: one window over the whole workspace content (Board, Split and Terminal), opened by the Board's Code button,
 * by the uncommitted card in the commits row, by a path pressed in the terminal and by the old /changes address.
 * Everything is faked here, and every write is refused: nothing in this file may commit, push, revert or sync.
 */
const workspace = { id: 'demo', branchName: 'demo', name: 'Reports CSV export', description: 'Add CSV export', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
const other = { ...workspace, id: 'other', branchName: 'other', name: 'Other work', workspacePath: '/tmp/other' };
test.use({ workspacesData: [[workspace, other], { option: true }], sidebarDocked: false });

const FILES = [
  { file: 'src/server/handler.ts', type: 'modified', additions: 12, deletions: 3 },
  { file: 'src/server/routes.ts', type: 'modified', additions: 30, deletions: 8 },
  { file: 'README.md', type: 'added', additions: 5, deletions: 0 },
];
const LISTING = [{ repoName: 'api', repoPath: '/tmp/api', files: FILES }];
const ALL_FILES = [...FILES, { file: 'src/server/config.ts', type: 'clean', additions: 0, deletions: 0 }];
const ALL_LISTING = [{ repoName: 'api', repoPath: '/tmp/api', files: ALL_FILES }];

/** A 20-line file; the new version changes line 10 and adds a line after 12. */
const original = (name: string) => Array.from({ length: 20 }, (_, i) => `// ${name} line ${i + 1}`).join('\n') + '\n';
const modified = (name: string) => {
  const lines = original(name).trimEnd().split('\n');
  lines[9] = `// ${name} line 10 CHANGED ${'and this line is long enough to be cut off at the right edge without wrapping '.repeat(3)}`;
  lines.splice(12, 0, `// ${name} inserted`);
  return lines.join('\n') + '\n';
};
const patch = (name: string) => {
  const o = original(name).trimEnd().split('\n');
  const m = modified(name).trimEnd().split('\n');
  return [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, '@@ -8,7 +8,8 @@',
    ` ${o[7]}`, ` ${o[8]}`, `-${o[9]}`, `+${m[9]}`, ` ${o[10]}`, ` ${o[11]}`, `+${m[12]}`, ` ${o[12]}`, ` ${o[13]}`, ''].join('\n');
};

let writes: string[] = [];
let termTarget: 'claude' | 'shell' = 'claude';
let typed: string[] = [];
let noSession = false;

test.beforeEach(async ({ page }) => {
  writes = []; typed = []; termTarget = 'claude'; noSession = false;
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    if (noSession) return route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } });
    const terminal = { id: `term-${id}`, workspace: id, target: termTarget, label: termTarget, cwd: `/tmp/${id}`, state: 'running' };
    return route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: termTarget, name: termTarget, available: true, reason: null }] } });
  });
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
    json: planFile({ title: 'Reports CSV export', checkpoints: [checkpoint('Reports export to CSV', { steps: [step('Write the CSV writer', true), step('Background job queue')] })] }),
  }));
  await page.route('**/api/workspace/*/news', (route) => route.fulfill({
    json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [{ sha: 'abc1234def', subject: 'Add the writer', author: 'A', at: new Date(Date.now() - 3_600_000).toISOString() }, { sha: 'def5678abc', subject: 'Add the reader', author: 'A', at: new Date(Date.now() - 7_200_000).toISOString() }] }], empty: false }),
  }));
  await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [boardNote(1, { title: 'A note' })] }) }));
  await page.route('**/api/workspace/*/changes', (route) => route.fulfill({ json: { changes: LISTING } }));
  await page.route('**/api/workspace/*/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/*/changes?include=all', (route) => route.fulfill({ json: { changes: ALL_LISTING } }));
  await page.route('**/api/workspace/*/changes/diff?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file')!;
    if (name === 'src/server/config.ts') {
      return route.fulfill({ json: { diff: '', fileContent: '// config file\nconst port = 3000;\n' } });
    }
    return route.fulfill({ json: { diff: patch(name), fileContent: modified(name), originalContent: original(name) } });
  });
  await page.route('**/api/workspace/*/repositories', (route) => route.fulfill({ json: { repositories: [{
    name: 'api', access: 'isolated', editable: true, path: '/tmp/api', sourcePath: '/tmp/api', branch: 'feat/x', expectedBranch: 'feat/x', onExpectedBranch: true, baseBranch: 'main',
    headSha: 'abc1234def', dirty: true, changedFiles: FILES.map((f) => ({ code: ' M', path: f.file })), ahead: 0, behind: 0, remoteUrl: null,
  }] } }));
  await page.route('**/api/workspace/*/progression', (route) => route.fulfill({ json: { ready: true, blockers: [], repos: [] } }));
  await page.route('**/api/workspace/*/lifecycle', (route) => route.fulfill({ json: { lifecycle: { steps: [] }, report: null } }));
  await page.route('**/api/workspace/*/finish/last', (route) => route.fulfill({ json: { lastFinish: null } }));
  // Nothing here may write. A test that fakes a write registers its own route, which is looked at first.
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    // The terminal's token, status and list are asked with POST and write nothing; the routes above fake every one of them
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type === 'input') typed.push(parsed.data);
      if (parsed.type !== 'attach') return;
      const terminal = { id: parsed.id, workspace: parsed.workspace, target: termTarget, label: termTarget, cwd: `/tmp/${parsed.workspace}`, state: 'running' };
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'output', data: 'edited src/server/routes.ts:12\r\n' }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await page.route('**/api/workspace/*/files/reference?*', (route) => {
    const wanted = new URL(route.request().url()).searchParams.get('path');
    return wanted === 'src/server/routes.ts'
      ? route.fulfill({ json: { status: 'found', target: { origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' }, file: 'src/server/routes.ts', viewer: 'code' } } })
      : route.fulfill({ json: { status: 'not-found', reason: 'missing' } });
  });
});
test.afterEach(() => { expect(writes, 'no test here may write').toEqual([]); });

const windowOf = (page: Page) => page.getByRole('region', { name: 'Code window' });
const openName = (page: Page) => windowOf(page).locator('p[title]').first();
async function openBoard(page: Page, mode: 'board' | 'split') {
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 })); });
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId(mode === 'board' ? 'view-mode-board' : 'view-mode-split').click();
  await expect(page.getByTestId(mode === 'board' ? 'view-mode-board' : 'view-mode-split')).toHaveAttribute('aria-pressed', 'true');
}
const stepIntoArea = async (page: Page) => {
  await page.locator('.board-overview-plane button.board-area').first().click();
  await expect(page.getByRole('button', { name: 'Board ›' })).toBeVisible();
};

for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 700 }]) {
  for (const mode of ['split', 'board'] as const) {
    test.describe(`${size.width}x${size.height} in ${mode}`, () => {
      test.use({ viewport: size });

      test('the button counts the changes; the card opens the first file with tree and code side by side; the window closes three ways and gives the keyboard back', async ({ page }) => {
        await openBoard(page, mode);
        // Level 0 and inside an Area both have the button, with the count
        const button = page.getByRole('button', { name: 'Code, 3 files changed' });
        await expect(button).toBeVisible();
        await expect(button).toContainText('3');
        await stepIntoArea(page);
        await expect(button).toBeVisible();
        const card = page.locator('[data-uncommitted]');
        await expect(card).toBeVisible();
        await expect(card).toContainText('3 files changed');
        await expect(card).toContainText('+47 −11');
        await expect(card).toContainText('handler.ts');
        await expect(card).not.toContainText('abc1234');
        await expect(page.locator('.react-flow__node-commit')).toHaveCount(2);

        await card.getByRole('button', { name: /3 files changed in Code/ }).click();
        const win = windowOf(page);
        await expect(win).toBeVisible();
        await expect(openName(page)).toHaveText('src/server/handler.ts');
        // The window covers the workspace content (both panes in Split) at the reader's large proportions
        const covered = await page.evaluate(() => {
          const rect = (document.querySelector('[data-code-window]') as HTMLElement).getBoundingClientRect();
          const back = (document.querySelector('[data-code-window-backdrop]') as HTMLElement).getBoundingClientRect();
          return { w: rect.width / back.width, h: rect.height / back.height, backW: back.width, vw: window.innerWidth };
        });
        expect(covered.w).toBeCloseTo(0.92, 1);
        expect(covered.h).toBeCloseTo(0.88, 1);
        if (mode === 'split') expect(covered.backW).toBeGreaterThan(size.width * 0.75);
        // Tree and code are on screen together, side by side
        const tree = win.getByRole('tree', { name: 'api changed files' });
        const code = win.locator('.monaco-diff-editor, [data-testid="code-file-viewer"]').first();
        await expect(tree).toBeVisible();
        await expect(code).toBeVisible();
        const [t, c] = [await tree.boundingBox(), await code.boundingBox()];
        expect(t!.x + t!.width).toBeLessThanOrEqual(c!.x + 1);
        expect(c!.width).toBeGreaterThan(300);
        // The numbers: per file and in total
        await expect(win.getByTestId('search-match-count')).toHaveText('3 changed files');
        await expect(win.getByTestId('change-totals')).toHaveText(' · +47 −11');
        await expect(win.getByRole('treeitem', { name: /handler\.ts/ })).toContainText('+12 −3');
        // "Change 1 of 1" stays on one line
        const change = win.getByRole('button', { name: /Change 1 of 1/ });
        await expect(change).toBeVisible();
        expect((await change.boundingBox())!.height).toBeLessThan(30);

        // Escape closes; the keyboard returns to the card's button
        await page.keyboard.press('Escape');
        await expect(win).toBeHidden();
        await expect(card.getByRole('button', { name: /in Code/ })).toBeFocused();
        // The × closes
        await button.click();
        await expect(win).toBeVisible();
        await win.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(win).toBeHidden();
        await expect(button).toBeFocused();
        // A press outside (on the dimmed area) closes
        await button.click();
        await expect(win).toBeVisible();
        await page.locator('[data-code-window-backdrop]').click({ position: { x: 4, y: 4 } });
        await expect(win).toBeHidden();
        await expect(button).toBeFocused();
      });

      test('reopening keeps the chosen file, and ] and [ move between files', async ({ page }) => {
        await openBoard(page, mode);
        await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
        const win = windowOf(page);
        await expect(openName(page)).toHaveText('src/server/handler.ts');
        await win.getByRole('treeitem', { name: /routes\.ts/ }).click();
        await expect(openName(page)).toHaveText('src/server/routes.ts');
        await win.getByRole('treeitem', { name: /routes\.ts/ }).focus();
        await page.keyboard.press(']');
        await expect(openName(page)).toHaveText('README.md');
        await page.keyboard.press('[');
        await expect(openName(page)).toHaveText('src/server/routes.ts');
        await page.keyboard.press('Escape');
        await expect(win).toBeHidden();
        await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
        await expect(win).toBeVisible();
        await expect(openName(page)).toHaveText('src/server/routes.ts');
      });
    });
  }
}

const codeFontSizeOf = async (page: Page) => {
  const line = page.locator('[data-code-window] .monaco-editor .view-line').first();
  await expect(line).toBeVisible();
  return line.evaluate((el) => window.getComputedStyle(el).fontSize);
};

for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 700 }]) {
  test.describe(`larger code and full screen at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test('code font size is 14 px by default, Larger and Smaller change it live in diff and Files, are disabled at ends, and survive reload', async ({ page }) => {
      await openBoard(page, 'board');
      await page.evaluate(() => localStorage.removeItem('contextspace.code-panel.font-size'));
      await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
      const win = windowOf(page);
      await expect(win.locator('.monaco-diff-editor')).toBeVisible();

      // Default is 14 px
      await expect.poll(() => codeFontSizeOf(page)).toBe('14px');

      const smaller = win.getByRole('button', { name: 'Smaller code' });
      const larger = win.getByRole('button', { name: 'Larger code' });
      await expect(smaller).toBeEnabled();
      await expect(larger).toBeEnabled();

      // Step up live
      await larger.click();
      await expect.poll(() => codeFontSizeOf(page)).toBe('15px');

      // Step down live
      await smaller.click();
      await expect.poll(() => codeFontSizeOf(page)).toBe('14px');

      // Step down to minimum (11 px)
      for (let i = 0; i < 3; i++) {
        await smaller.click();
      }
      await expect.poll(() => codeFontSizeOf(page)).toBe('11px');
      await expect(smaller).toBeDisabled();

      // Step up to maximum (20 px)
      for (let i = 0; i < 9; i++) {
        await larger.click();
      }
      await expect.poll(() => codeFontSizeOf(page)).toBe('20px');
      await expect(larger).toBeDisabled();

      // Step back to 16 px
      for (let i = 0; i < 4; i++) {
        await smaller.click();
      }
      await expect.poll(() => codeFontSizeOf(page)).toBe('16px');

      // Files view also has the controls and follows font size
      await win.getByRole('button', { name: 'Files' }).click();
      await win.getByRole('treeitem', { name: /config\.ts/ }).click();
      await expect.poll(() => codeFontSizeOf(page)).toBe('16px');

      await smaller.click();
      await expect.poll(() => codeFontSizeOf(page)).toBe('15px');
      await larger.click();
      await expect.poll(() => codeFontSizeOf(page)).toBe('16px');

      // Survives reload
      await page.reload();
      await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
      await expect(win.locator('.monaco-diff-editor')).toBeVisible();
      await expect.poll(() => codeFontSizeOf(page)).toBe('16px');
    });

    test('full screen fills the viewport, double press on toolbar toggles it, Escape returns to window then closes, reopening starts in normal window, selection is kept', async ({ page }) => {
      await openBoard(page, 'board');
      await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
      const win = windowOf(page);
      await expect(win.locator('.monaco-diff-editor')).toBeVisible();

      // Choose a file
      await win.getByRole('treeitem', { name: /routes\.ts/ }).click();
      await expect(openName(page)).toHaveText('src/server/routes.ts');

      // Normal window does not fill viewport
      const normalBounds = await win.boundingBox();
      expect(normalBounds!.width).toBeLessThan(size.width - 20);
      expect(normalBounds!.height).toBeLessThan(size.height - 20);

      // Full screen button
      const fullScreenBtn = win.getByRole('button', { name: 'Full screen', exact: true });
      await expect(fullScreenBtn).toBeVisible();
      await fullScreenBtn.click();

      // Fills viewport and toggle button stays focused
      const exitBtn = win.getByRole('button', { name: 'Exit full screen' });
      await expect(exitBtn).toBeVisible();
      await expect(exitBtn).toBeFocused();

      const fullBounds = await win.boundingBox();
      expect(fullBounds!.x).toBe(0);
      expect(fullBounds!.y).toBe(0);
      expect(fullBounds!.width).toBe(size.width);
      expect(fullBounds!.height).toBe(size.height);

      // Selected file is kept
      await expect(openName(page)).toHaveText('src/server/routes.ts');

      // Double press on empty part of toolbar toggles back to normal window
      const toolbar = win.getByRole('toolbar', { name: 'Code' });
      await toolbar.dblclick({ position: { x: 300, y: 15 } });
      await expect(win.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
      const backBounds = await win.boundingBox();
      expect(backBounds!.width).toBeLessThan(size.width - 20);

      // Double press toggles to full screen again
      await toolbar.dblclick({ position: { x: 300, y: 15 } });
      await expect(win.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
      const fullAgainBounds = await win.boundingBox();
      expect(fullAgainBounds!.width).toBe(size.width);

      // First Escape steps back to normal window
      await page.keyboard.press('Escape');
      await expect(win).toBeVisible();
      await expect(win.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
      const escBounds = await win.boundingBox();
      expect(escBounds!.width).toBeLessThan(size.width - 20);
      await expect(openName(page)).toHaveText('src/server/routes.ts');

      // Second Escape closes the window
      await page.keyboard.press('Escape');
      await expect(win).toBeHidden();

      // Reopening starts in the normal window
      await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
      await expect(win).toBeVisible();
      await expect(win.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
      const reopenBounds = await win.boundingBox();
      expect(reopenBounds!.width).toBeLessThan(size.width - 20);
      expect(reopenBounds!.height).toBeLessThan(size.height - 20);
    });

    test('in full screen, filter gets Escape first, next Escape leaves full screen, next Escape closes window', async ({ page }) => {
      await openBoard(page, 'board');
      await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
      const win = windowOf(page);
      await expect(win.locator('.monaco-diff-editor')).toBeVisible();

      // Enter full screen
      await win.getByRole('button', { name: 'Full screen', exact: true }).click();
      await expect(win.getByRole('button', { name: 'Exit full screen' })).toBeVisible();

      // Type a filter
      const filterInput = win.getByLabel('Filter files');
      await filterInput.fill('routes');
      await expect(filterInput).toHaveValue('routes');

      // Press a file in the tree (moves focus to the treeitem)
      const treeItem = win.getByRole('treeitem', { name: /routes\.ts/ });
      await treeItem.click();

      // Press Escape: filter clears and window stays in full screen
      await page.keyboard.press('Escape');
      await expect(filterInput).toHaveValue('');
      await expect(win.getByRole('button', { name: 'Exit full screen' })).toBeVisible();

      // Next Escape: leaves full screen
      await page.keyboard.press('Escape');
      await expect(win.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
      await expect(win).toBeVisible();

      // Next Escape: closes the window
      await page.keyboard.press('Escape');
      await expect(win).toBeHidden();
    });

    test('a double press on a disabled Review & commit does not toggle full screen', async ({ page }) => {
      await page.route('**/api/workspace/*/changes', (route) => route.fulfill({ json: { changes: [] } }));
      await openBoard(page, 'board');
      await page.getByTestId('board-code-button').click();
      const win = windowOf(page);
      await expect(win).toBeVisible();

      const reviewBtn = win.getByRole('button', { name: 'Review & commit' });
      await expect(reviewBtn).toBeDisabled();

      // Double press on disabled Review & commit
      await reviewBtn.dblclick({ force: true });

      // Does not toggle full screen: still normal window, button is still "Full screen"
      await expect(win.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
      await expect(win.getByRole('button', { name: 'Exit full screen' })).toHaveCount(0);
    });
  });
}

test.describe('full screen at narrow 700 px viewport', () => {
  test.use({ viewport: { width: 700, height: 700 } });

  test('Exit full screen and Close buttons are not covered by the narrow header and work', async ({ page }) => {
    await openBoard(page, 'board');
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    const win = windowOf(page);
    await expect(win.locator('.monaco-diff-editor')).toBeVisible();

    // Enter full screen
    await win.getByRole('button', { name: 'Full screen', exact: true }).click();
    const exitBtn = win.getByRole('button', { name: 'Exit full screen' });
    const closeBtn = win.getByRole('toolbar', { name: 'Code' }).getByRole('button', { name: 'Close', exact: true });
    await expect(exitBtn).toBeVisible();
    await expect(closeBtn).toBeVisible();

    // elementFromPoint on Exit full screen and Close buttons returns those buttons
    const exitTarget = await exitBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit?.closest('button') === el;
    });
    expect(exitTarget).toBe(true);

    const closeTarget = await closeBtn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit?.closest('button') === el;
    });
    expect(closeTarget).toBe(true);

    // They work: clicking Exit full screen steps back to normal window
    await exitBtn.click();
    await expect(win.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();

    // And clicking Close closes the window
    await closeBtn.click();
    await expect(win).toBeHidden();
  });
});

test.describe('the editor follows the app theme', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  const editorBackground = (page: Page) => page.locator('[data-code-window] .monaco-editor .margin, [data-code-window] .monaco-editor-background').first()
    .evaluate((element) => {
      const [r, g, b] = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)!.map(Number) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    });

  for (const scheme of ['light', 'dark'] as const) {
    test(`is ${scheme} in ${scheme} mode, and follows a switch made while the file is open`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openBoard(page, 'board');
      await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
      await expect(windowOf(page).locator('.monaco-diff-editor')).toBeVisible();
      await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /dark/ : /^(?!.*dark)/);
      await expect.poll(() => editorBackground(page)).toBeGreaterThan(scheme === 'light' ? 200 : -1);
      expect(await editorBackground(page) > 128).toBe(scheme === 'light');
      // The app switches theme by the class on the page
      await page.evaluate((to) => document.documentElement.classList.toggle('dark', to === 'dark'), scheme === 'light' ? 'dark' : 'light');
      await expect.poll(async () => (await editorBackground(page)) > 128).toBe(scheme !== 'light');
    });
  }
});

test.describe('keys inside the window', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Escape in the commit text field, in a menu and in the Ask AI form is theirs; the window stays', async ({ page }) => {
    await openBoard(page, 'board');
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    const win = windowOf(page);
    await expect(openName(page)).toHaveText('src/server/handler.ts');
    // a menu
    await win.getByRole('button', { name: 'More code actions' }).click();
    await expect(page.locator('[data-slot="menu-popup"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="menu-popup"]')).toHaveCount(0);
    await expect(win).toBeVisible();
    // the Ask AI form
    await win.getByRole('button', { name: 'Ask AI' }).click();
    const askForm = page.getByRole('dialog', { name: 'Ask AI about this change' });
    await expect(askForm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(askForm).toHaveCount(0);
    await expect(win).toBeVisible();
    // the commit form: its file list is there, and Escape in the message field does not close the window
    await win.getByRole('button', { name: 'Review & commit' }).click();
    const panel = win.getByRole('region', { name: 'Review commit' });
    await expect(panel.getByRole('checkbox', { name: 'Include api/src/server/handler.ts' })).toHaveAttribute('aria-checked', 'true');
    await expect(panel.getByRole('checkbox', { name: 'Include api/README.md' })).toBeVisible();
    await panel.getByLabel('Commit message').fill('draft');
    await page.keyboard.press('Escape');
    await expect(win).toBeVisible();
    await expect(panel.getByLabel('Commit message')).toHaveValue('draft');
    await page.screenshot({ path: `${process.env.PICS ?? 'test-results'}/commit-form-1280.png` });
    // The editor ships without a find box in this build, so its Escape is the window's: with the keyboard in the editor and nothing open, it closes
    await win.getByRole('button', { name: 'Review & commit' }).click();
    await win.locator('.monaco-diff-editor .modified .view-lines').first().click();
    // and then, with nothing open, Escape in the editor closes the window
    await page.keyboard.press('Escape');
    await expect(win).toBeHidden();
  });

  test('[ does not collapse the sidebar while the window is open', async ({ page }) => {
    await page.addInitScript(() => { if (window === window.top) localStorage.setItem('ctxspace_sidebar_docked_v1', 'true'); });
    await openBoard(page, 'board');
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    await expect(openName(page)).toHaveText('src/server/handler.ts');
    const docked = () => page.evaluate(() => localStorage.getItem('ctxspace_sidebar_docked_v1'));
    await windowOf(page).getByRole('treeitem', { name: /handler\.ts/ }).focus();
    await page.keyboard.press('[');
    expect(await docked()).toBe('true');
  });
});

test.describe('other ways in', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const clickOutputRow = async (page: Page) => {
    const pane = page.getByTestId('terminal-pane');
    await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
    const screen = pane.locator('.xterm-screen');
    const cell = await screen.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const first = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
      return { x: bounds.x + 80, y: (first?.y ?? bounds.y) + (first?.height ?? 17) * 0.5 };
    });
    await page.mouse.move(cell.x, cell.y);
    await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
    await page.mouse.click(cell.x, cell.y);
  };

  for (const mode of ['split', 'terminal'] as const) {
    test(`a file path pressed in the terminal opens that file at that line, in ${mode}`, async ({ page }) => {
      if (mode === 'split') await openBoard(page, 'split');
      else await page.goto('/#/workspaces/demo/chat');
      await clickOutputRow(page);
      await expect(windowOf(page)).toBeVisible();
      await expect(openName(page)).toHaveText('src/server/routes.ts:12');
      await expect(windowOf(page).getByRole('tree', { name: 'api changed files' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(windowOf(page)).toBeHidden();
      // the keyboard goes back to the terminal that was pressed
      await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
      expect(new URL(page.url()).hash).toBe(mode === 'split' ? '#/workspaces/demo/board' : '#/workspaces/demo/chat');
    });
  }

  test('the old /changes address opens the board with the window over it, and closing leaves the address on the board', async ({ page }) => {
    await page.goto('/#/workspaces/demo/changes');
    await expect(windowOf(page)).toBeVisible();
    await expect(openName(page)).toHaveText('src/server/handler.ts');
    await expect(page.getByRole('region', { name: 'Board' })).toBeAttached();
    expect(new URL(page.url()).hash).toBe('#/workspaces/demo/board');
    await page.keyboard.press('Escape');
    await expect(windowOf(page)).toBeHidden();
    expect(new URL(page.url()).hash).toBe('#/workspaces/demo/board');
  });

  test('Code stays out of the rail', async ({ page }) => {
    await page.goto('/#/workspaces/demo/board');
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Code' })).toHaveCount(0);
  });
});

test.describe('Ask AI', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const ask = async (page: Page) => {
    await openBoard(page, 'split');
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    const win = windowOf(page);
    await expect(win.locator('.monaco-diff-editor')).toBeVisible();
    await win.getByRole('button', { name: 'Ask AI' }).click();
    const form = page.getByRole('dialog', { name: 'Ask AI about this change' });
    await form.getByRole('textbox').fill('make it shorter');
    await form.getByRole('button', { name: 'Send to AI' }).click();
    return win;
  };

  test('types the request into the AI session and closes the window so the terminal shows', async ({ page }) => {
    await ask(page);
    await expect(windowOf(page)).toBeHidden();
    await expect.poll(() => typed.join('')).toContain('Regarding api/src/server/handler.ts at line');
    expect(typed.join('')).toContain('make it shorter');
    expect(typed.join('')).not.toContain('\r');
  });

  test('refuses a bare shell: nothing is typed, the window stays, and the request is copied', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin });
    termTarget = 'shell';
    await ask(page);
    await expect(page.getByText(/No AI session is open to take it/)).toBeVisible({ timeout: 8000 });
    await expect(windowOf(page)).toBeVisible();
    expect(typed.join('')).not.toContain('Regarding');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('make it shorter');
  });
});

test.describe('commit from the window', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('lists the files, sends the chosen files and the message, and shows the result', async ({ page }) => {
    let body: unknown;
    await page.route('**/api/workspace/*/commit', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ json: { skipped: [], results: [{ repoName: 'api', success: true, committed: true, pushed: false, branch: 'feat/x', commitHash: 'aaa1111', filesChanged: 2, message: 'ok' }] } });
    });
    await openBoard(page, 'board');
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    const win = windowOf(page);
    await win.getByRole('button', { name: 'Review & commit' }).click();
    const panel = win.getByRole('region', { name: 'Review commit' });
    await panel.getByRole('checkbox', { name: 'Include api/README.md' }).click();
    await panel.getByLabel('Commit message').fill('feat: the writer');
    await panel.getByRole('button', { name: /Commit/ }).last().click();
    await expect.poll(() => body).toBeTruthy();
    expect(body).toMatchObject({ message: 'feat: the writer', files: { api: ['src/server/handler.ts', 'src/server/routes.ts'] } });
    await expect(win.getByText('Commit results', { exact: true })).toBeVisible();
  });
});

test.describe('keys belong to the window while it is open', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('an unticked file stays unticked across opening a file, ] , closing the form and closing the window', async ({ page }) => {
    await openBoard(page, 'board');
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    const win = windowOf(page);
    await win.getByRole('button', { name: 'Review & commit' }).click();
    const panel = win.getByRole('region', { name: 'Review commit' });
    await panel.getByRole('checkbox', { name: 'Include api/README.md' }).click();
    await expect(panel.getByRole('checkbox', { name: 'Include api/README.md' })).toHaveAttribute('aria-checked', 'false');
    await expect(panel.getByTestId('commit-review-summary')).toContainText('Commit 2 files');
    // pressing a file in the tree closes the form; ] with focus on a checkbox too
    await panel.getByRole('checkbox', { name: 'Include api/src/server/handler.ts' }).focus();
    await page.keyboard.press(']');
    await expect(panel).toHaveCount(0);
    await win.getByRole('treeitem', { name: /routes\.ts/ }).click();
    await page.keyboard.press('Escape');
    await expect(win).toBeHidden();
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    await win.getByRole('button', { name: 'Review & commit' }).click();
    const again = win.getByRole('region', { name: 'Review commit' });
    await expect(again.getByRole('checkbox', { name: 'Include api/README.md' })).toHaveAttribute('aria-checked', 'false');
    await expect(again.getByTestId('commit-review-summary')).toContainText('Commit 2 files');
  });

  test('Escape after the last file closes the window and leaves the Area open; focus never falls to the page', async ({ page }) => {
    await openBoard(page, 'board');
    await stepIntoArea(page);
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    const win = windowOf(page);
    await expect(openName(page)).toHaveText('src/server/handler.ts');
    const next = win.locator('button[aria-keyshortcuts="Alt+ArrowDown"]');
    await next.click(); await next.click();
    await expect(openName(page)).toHaveText('README.md');
    await expect(next).toBeDisabled();
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-code-window]')))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(win).toBeHidden();
    await expect(page.getByRole('button', { name: 'Board ›' })).toBeVisible();
  });

  test('Escape with the keyboard on the page body closes the window, not the board behind it', async ({ page }) => {
    await openBoard(page, 'board');
    await stepIntoArea(page);
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    await expect(openName(page)).toHaveText('src/server/handler.ts');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(windowOf(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Board ›' })).toBeVisible();
  });

  test('Ask AI with no session leaves the keyboard on the Ask AI button', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin });
    termTarget = 'shell';
    await openBoard(page, 'split');
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    const win = windowOf(page);
    await expect(win.locator('.monaco-diff-editor')).toBeVisible();
    await win.getByRole('button', { name: 'Ask AI' }).click();
    const form = page.getByRole('dialog', { name: 'Ask AI about this change' });
    await form.getByRole('textbox').fill('x');
    await form.getByRole('button', { name: 'Send to AI' }).click();
    await expect(page.getByText(/No AI session is open to take it/)).toBeVisible({ timeout: 8000 });
    await expect(win.getByRole('button', { name: 'Ask AI' })).toBeFocused();
  });

  test('[ still works for the sidebar after the window has been opened and closed', async ({ page }) => {
    await page.addInitScript(() => { if (window === window.top) localStorage.setItem('ctxspace_sidebar_docked_v1', 'true'); });
    await openBoard(page, 'board');
    await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
    await expect(openName(page)).toHaveText('src/server/handler.ts');
    await page.keyboard.press('Escape');
    await expect(windowOf(page)).toBeHidden();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('[');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('ctxspace_sidebar_docked_v1'))).not.toBe('true');
  });

  for (const mode of ['split'] as const) {
    test(`/ filters the window's files, not the saved sessions behind it, with no session started (${mode})`, async ({ page }) => {
      noSession = true;
      if (mode === 'split') await openBoard(page, 'split');
      else await page.goto('/#/workspaces/demo/chat');
      await expect(page.getByRole('textbox', { name: /Search saved sessions/ })).toBeVisible({ timeout: 20000 });
      // the Code button lives on the board; from the terminal the window is opened by the old address
      if (mode === 'split') await page.getByRole('button', { name: 'Code, 3 files changed' }).click();
      else await page.evaluate(() => { location.hash = '#/workspaces/demo/changes'; });
      const win = windowOf(page);
      await expect(openName(page)).toHaveText('src/server/handler.ts');
      await win.getByRole('treeitem', { name: /handler\.ts/ }).focus();
      await page.keyboard.press('/');
      await expect(win.getByRole('searchbox', { name: 'Filter files' })).toBeFocused();
      await page.keyboard.type('rout');
      await expect(page.getByRole('textbox', { name: /Search saved sessions/ })).toHaveValue('');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(win).toBeHidden();
    });
  }

  test('with a reader open behind the window, ] and Escape belong to the window', async ({ page }) => {
    await openBoard(page, 'split');
    await stepIntoArea(page);
    await page.getByRole('button', { name: 'Open Add the writer' }).click();
    const reader = page.getByRole('region', { name: 'Reader' });
    await expect(reader).toBeVisible();
    const title = await reader.locator('h2').first().textContent();
    // a path pressed in the terminal (outside the board pane, so the reader stays) opens the window over it
    const pane = page.getByTestId('terminal-pane');
    await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
    const cell = await pane.locator('.xterm-screen').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const first = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
      return { x: bounds.x + 80, y: (first?.y ?? bounds.y) + (first?.height ?? 17) * 0.5 };
    });
    await page.mouse.move(cell.x, cell.y);
    await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
    await page.mouse.click(cell.x, cell.y);
    const win = windowOf(page);
    await expect(win).toBeVisible();
    await expect(reader).toBeAttached();
    await win.getByRole('treeitem', { name: /handler\.ts/ }).click();
    await win.getByRole('treeitem', { name: /handler\.ts/ }).focus();
    await page.keyboard.press(']');
    await expect(openName(page)).toHaveText('src/server/routes.ts');
    await expect(reader.locator('h2').first()).toHaveText(title!);
    await page.keyboard.press('Escape');
    await expect(win).toBeHidden();
    await expect(reader).toBeVisible();
  });

  for (const delayed of [false, true]) test(`a path pressed in a docked second workspace terminal opens the window for that workspace (${delayed ? 'delayed' : 'fast'})`, async ({ page }) => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    if (delayed) await page.route('**/api/workspace/*/files/reference?*', async route => {
      await ready;
      await route.fulfill({ json: { status: 'found', target: { origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' }, file: 'src/server/routes.ts', viewer: 'code' } } });
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
      localStorage.setItem('contextspace_floating_chat_state_v1', JSON.stringify({ openTabs: ['demo', 'other'], activeTab: 'demo', splitTab: 'other', splitRatio: 50, modes: { demo: 'cli', other: 'cli' }, harnesses: {}, terminalLaunches: {}, drafts: {} }));
    });
    await page.goto('/#/workspaces/demo/chat');
    const panes = page.getByTestId('terminal-pane');
    await expect(panes).toHaveCount(2, { timeout: 20000 });
    const pane = panes.nth(1);
    await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
    const cellOf = () => pane.locator('.xterm-screen').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const first = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
      return { x: bounds.x + 80, y: (first?.y ?? bounds.y) + (first?.height ?? 17) * 0.5 };
    });
    let cell = await cellOf();
    // xterm finds the link under the pointer a moment after it arrives, and the rows may still be settling: measure again each try
    await expect(async () => {
      cell = await cellOf();
      await page.mouse.move(cell.x - 3, cell.y);
      await page.mouse.move(cell.x, cell.y);
      await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1, { timeout: 1500 });
    }).toPass({ timeout: 20000 });
    await page.mouse.click(cell.x, cell.y);
    await expect(windowOf(page)).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/workspaces/other/board');
    if (delayed) {
      await expect(page.getByTestId('code-reference-notice')).toContainText('Looking for');
      release();
    }
    await expect(openName(page)).toHaveText('src/server/routes.ts:12');
  });
});

test.describe('the commit form is kept per workspace', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('leaving a workspace and coming back finds its form as it was, and nothing of it shows in the other one', async ({ page }) => {
    const posts: Record<string, any> = {};
    for (const id of ['demo', 'other']) {
      await page.route(`**/api/workspace/${id}/commit`, async (route) => {
        posts[id] = route.request().postDataJSON();
        await route.fulfill({ json: { skipped: [], results: [{ repoName: 'api', success: true, committed: true, pushed: false, branch: 'feat/x', commitHash: 'aaa1111', filesChanged: 2, message: 'ok' }] } });
      });
    }
    // The workspace's own page must be drawn before its Code button is pressed: until then the visible button is still the last workspace's.
    const go = async (id: string) => {
      await page.evaluate((to) => { location.hash = `#/workspaces/${to}/board`; }, id);
      await expect(page.getByRole('button', { name: `Copy branch name ${id}` })).toBeVisible();
    };
    const form = () => windowOf(page).getByRole('region', { name: 'Review commit' });
    const include = (file: string) => form().getByRole('checkbox', { name: `Include api/${file}` });
    const code = () => page.locator('[data-testid="board-code-button"]:visible').first();
    const summary = () => form().getByTestId('commit-review-summary');
    const openForm = async () => {
      await code().click();
      const review = windowOf(page).getByRole('button', { name: 'Review & commit' });
      await expect(review).toBeEnabled();
      if ((await review.getAttribute('aria-pressed')) !== 'true') await review.click();
      await expect(form()).toBeVisible();
    };

    await openBoard(page, 'board');
    // demo: untick a file, push off, write a message
    await openForm();
    await include('README.md').click();
    await form().getByRole('checkbox', { name: 'Push after committing' }).click();
    await form().getByLabel('Commit message').fill('demo message');
    await expect(summary()).toContainText('Commit 2 files');
    await expect(summary()).toContainText('without pushing');
    await windowOf(page).getByRole('toolbar', { name: 'Code' }).getByRole('button', { name: 'Close', exact: true }).click();

    // other: starts with its own state: form closed, empty message, everything ticked, push on
    await go('other');
    await code().click();
    await expect(windowOf(page)).toBeVisible();
    await expect(form()).toHaveCount(0);
    await windowOf(page).getByRole('button', { name: 'Review & commit' }).click();
    await expect(form().getByLabel('Commit message')).toHaveValue('');
    await expect(include('README.md')).toHaveAttribute('aria-checked', 'true');
    await expect(summary()).toContainText('Commit 3 files');
    await expect(summary()).toContainText('then push');
    await expect(form().getByRole('checkbox', { name: 'Push after committing' })).toHaveAttribute('aria-checked', 'true');
    // leave something of its own there
    await include('src/server/handler.ts').click();
    await form().getByLabel('Commit message').fill('other message');
    await windowOf(page).getByRole('toolbar', { name: 'Code' }).getByRole('button', { name: 'Close', exact: true }).click();

    // back in demo: exactly what was left
    await go('demo');
    await code().click();
    await expect(form()).toBeVisible();
    await expect(form().getByLabel('Commit message')).toHaveValue('demo message');
    await expect(include('README.md')).toHaveAttribute('aria-checked', 'false');
    await expect(include('src/server/handler.ts')).toHaveAttribute('aria-checked', 'true');
    await expect(summary()).toContainText('Commit 2 files');
    await expect(summary()).toContainText('without pushing');
    await windowOf(page).getByRole('toolbar', { name: 'Code' }).getByRole('button', { name: 'Close', exact: true }).click();

    // and in other: what was left there
    await go('other');
    await code().click();
    await expect(form().getByLabel('Commit message')).toHaveValue('other message');
    await expect(include('src/server/handler.ts')).toHaveAttribute('aria-checked', 'false');
    await expect(summary()).toContainText('Commit 2 files');
    await expect(summary()).toContainText('then push');
    await form().getByRole('button', { name: /^Commit/ }).last().click();
    await expect.poll(() => posts.other).toBeTruthy();
    expect(posts.other).toEqual({ message: 'other message', noPush: false, files: { api: ['src/server/routes.ts', 'README.md'] } });
    await windowOf(page).getByRole('toolbar', { name: 'Code' }).getByRole('button', { name: 'Close', exact: true }).click();

    // a commit in other cleared only other: demo still has its own
    await go('demo');
    await code().click();
    await expect(form().getByLabel('Commit message')).toHaveValue('demo message');
    await form().getByRole('button', { name: /^Commit/ }).last().click();
    await expect.poll(() => posts.demo).toBeTruthy();
    expect(posts.demo).toEqual({ message: 'demo message', noPush: true, files: { api: ['src/server/handler.ts', 'src/server/routes.ts'] } });
  });
});

test.describe('two repositories in one workspace', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('board shows changes across both repos, Code window tree navigates both, and commit form commits both', async ({ page }) => {
    let commitPayload: any = null;
    let committed = false;
    const newCommits = [
      { repo: 'api', more: 0, commits: [{ sha: 'aaa1111def', subject: 'New API commit', author: 'A', at: new Date().toISOString() }] },
      { repo: 'web', more: 0, commits: [{ sha: 'bbb2222abc', subject: 'New web commit', author: 'B', at: new Date().toISOString() }] },
    ];

    const TWO_REPO_CHANGES = [
      {
        repoName: 'api',
        repoPath: '/tmp/api',
        files: [
          { file: 'src/server/handler.ts', type: 'modified', additions: 12, deletions: 3 },
          { file: 'README.md', type: 'added', additions: 5, deletions: 0 },
        ],
      },
      {
        repoName: 'web',
        repoPath: '/tmp/web',
        files: [
          { file: 'src/client/App.tsx', type: 'modified', additions: 20, deletions: 4 },
          { file: 'package.json', type: 'modified', additions: 1, deletions: 1 },
        ],
      },
    ];

    const TWO_REPOSITORIES = [
      {
        name: 'api',
        access: 'read-write',
        editable: true,
        path: '/tmp/api',
        sourcePath: '/tmp/api',
        branch: 'feat/two-repos',
        expectedBranch: 'feat/two-repos',
        onExpectedBranch: true,
        baseBranch: 'main',
        headSha: '1111111',
        dirty: true,
        changedFiles: [{ code: 'M', path: 'src/server/handler.ts' }, { code: 'A', path: 'README.md' }],
        ahead: 0,
        behind: 0,
        remoteUrl: 'git@github.com:org/api.git',
      },
      {
        name: 'web',
        access: 'read-write',
        editable: true,
        path: '/tmp/web',
        sourcePath: '/tmp/web',
        branch: 'feat/two-repos',
        expectedBranch: 'feat/two-repos',
        onExpectedBranch: true,
        baseBranch: 'main',
        headSha: '2222222',
        dirty: true,
        changedFiles: [{ code: 'M', path: 'src/client/App.tsx' }, { code: 'M', path: 'package.json' }],
        ahead: 0,
        behind: 0,
        remoteUrl: 'git@github.com:org/web.git',
      },
    ];

    await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: TWO_REPO_CHANGES } }));
    await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({ json: { repositories: TWO_REPOSITORIES } }));
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
      json: whatsNew({
        commits: committed ? newCommits : [
          { repo: 'api', more: 0, commits: [{ sha: 'abc1234def', subject: 'API commit', author: 'A', at: new Date().toISOString() }] },
          { repo: 'web', more: 0, commits: [{ sha: 'fed4321cba', subject: 'Web commit', author: 'B', at: new Date().toISOString() }] },
        ],
        empty: false,
      }),
    }));
    await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({
      json: { at: new Date().toISOString(), from: new Date(Date.now() - 86400000).toISOString(), commits: committed ? newCommits : [] },
    }));
    await page.route('**/api/workspace/demo/changes/diff?**', (route) => {
      const url = new URL(route.request().url());
      const repo = url.searchParams.get('repo') ?? 'api';
      const file = url.searchParams.get('file') ?? 'test.ts';
      return route.fulfill({
        json: {
          original: `// original ${repo} ${file}`,
          modified: `// modified ${repo} ${file}`,
          patch: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-// original\n+// modified`,
        },
      });
    });
    await page.route('**/api/workspace/demo/commit', async (route) => {
      commitPayload = route.request().postDataJSON();
      committed = true;
      await route.fulfill({
        json: {
          skipped: [],
          results: [
            { repoName: 'api', success: true, committed: true, pushed: false, branch: 'feat/two-repos', commitHash: 'aaa1111', filesChanged: 2, message: 'ok' },
            { repoName: 'web', success: true, committed: true, pushed: false, branch: 'feat/two-repos', commitHash: 'bbb2222', filesChanged: 1, message: 'ok' },
          ],
        },
      });
    });

    await openBoard(page, 'board');

    // 1. Board header Code button shows total changes across both repos (2 in api + 2 in web = 4 files)
    const codeBtn = page.getByTestId('board-code-button');
    await expect(codeBtn).toBeVisible();
    await expect(codeBtn).toContainText('4');
    await expect(codeBtn).toHaveAttribute('aria-label', 'Code, 4 files changed');

    // 2. Open an Area to verify uncommitted cards for both repos
    await page.locator('button.board-area').first().click();
    await expect(page.locator('#board-area')).toBeVisible();

    // Verify uncommitted cards for both repos exist
    const uncommittedApi = page.locator('[data-uncommitted^="uncommitted:api"]');
    const uncommittedWeb = page.locator('[data-uncommitted^="uncommitted:web"]');
    await expect(uncommittedApi).toBeVisible();
    await expect(uncommittedWeb).toBeVisible();
    await expect(uncommittedApi).toContainText('2 files changed');
    await expect(uncommittedWeb).toContainText('2 files changed');

    // 3. Clicking web's uncommitted card opens CodeWindow directly on web's first file
    await uncommittedWeb.getByRole('button', { name: /Open .* in Code/ }).click();
    const win = windowOf(page);
    await expect(win).toBeVisible();
    await expect(openName(page)).toContainText('src/client/App.tsx');

    // 4. File tree shows both repos with their file counts
    await expect(win.getByRole('button', { name: 'api 2' })).toBeVisible();
    await expect(win.getByRole('button', { name: 'web 2' })).toBeVisible();
    await expect(win.getByRole('tree', { name: 'api changed files' })).toBeVisible();
    await expect(win.getByRole('tree', { name: 'web changed files' })).toBeVisible();

    // Step navigation between files across repos with [ and ]
    await page.keyboard.press(']');
    await expect(openName(page)).toContainText('package.json');

    // 5. Review & commit form shows both repos
    await win.getByRole('button', { name: 'Review & commit' }).click();
    const form = win.getByRole('region', { name: 'Review commit' });
    await expect(form).toBeVisible();

    const repoApiSection = form.getByTestId('commit-repo-api');
    const repoWebSection = form.getByTestId('commit-repo-web');
    await expect(repoApiSection).toBeVisible();
    await expect(repoWebSection).toBeVisible();

    // Untick one file in web (package.json)
    await repoWebSection.getByRole('checkbox', { name: 'Include web/package.json' }).click();

    // Summary counts updated: 4 total - 1 excluded = 3 files in 2 repositories
    const summary = form.getByTestId('commit-review-summary');
    await expect(summary).toContainText('Commit 3 files');

    // Commit both repos with message
    await form.getByLabel('Commit message').fill('feat: two repo commit');
    await form.getByRole('button', { name: /^Commit/ }).last().click();

    await expect.poll(() => commitPayload).toBeTruthy();
    expect(commitPayload).toEqual({
      message: 'feat: two repo commit',
      noPush: false,
      files: {
        api: ['src/server/handler.ts', 'README.md'],
        web: ['src/client/App.tsx'],
      },
    });
    await win.locator('button[title="Close"]').click();
    await expect(page.locator('.react-flow__node-commit').filter({ hasText: 'New API commit' })).toBeVisible();
    await expect(page.locator('.react-flow__node-commit').filter({ hasText: 'New web commit' })).toBeVisible();
  });

  test('with one editable repo and one read-only reference repo, only editable repo is committable', async ({ page }) => {
    let commitPayload: any = null;

    const TWO_REPO_CHANGES = [
      {
        repoName: 'api',
        repoPath: '/tmp/api',
        files: [{ file: 'src/server/handler.ts', type: 'modified', additions: 12, deletions: 3 }],
      },
      {
        repoName: 'ref-docs',
        repoPath: '/tmp/ref-docs',
        files: [{ file: 'guide.md', type: 'modified', additions: 5, deletions: 1 }],
      },
    ];

    const TWO_REPOSITORIES = [
      {
        name: 'api',
        access: 'read-write',
        editable: true,
        path: '/tmp/api',
        sourcePath: '/tmp/api',
        branch: 'feat/two-repos',
        expectedBranch: 'feat/two-repos',
        onExpectedBranch: true,
        baseBranch: 'main',
        headSha: '1111111',
        dirty: true,
        changedFiles: [{ code: 'M', path: 'src/server/handler.ts' }],
        ahead: 0,
        behind: 0,
        remoteUrl: 'git@github.com:org/api.git',
      },
      {
        name: 'ref-docs',
        access: 'read-only',
        editable: false,
        path: '/tmp/ref-docs',
        sourcePath: '/tmp/ref-docs',
        branch: 'main',
        expectedBranch: null,
        onExpectedBranch: true,
        baseBranch: 'main',
        headSha: '9999999',
        dirty: true,
        changedFiles: [{ code: 'M', path: 'guide.md' }],
        ahead: 0,
        behind: 0,
        remoteUrl: 'git@github.com:org/ref-docs.git',
      },
    ];

    await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: TWO_REPO_CHANGES } }));
    await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({ json: { repositories: TWO_REPOSITORIES } }));
    await page.route('**/api/workspace/demo/commit', async (route) => {
      commitPayload = route.request().postDataJSON();
      await route.fulfill({
        json: {
          skipped: [],
          results: [{ repoName: 'api', success: true, committed: true, pushed: false, branch: 'feat/two-repos', commitHash: 'aaa1111', filesChanged: 1, message: 'ok' }],
        },
      });
    });

    await openBoard(page, 'board');

    // Open Code window
    await page.getByTestId('board-code-button').click();
    const win = windowOf(page);
    await expect(win).toBeVisible();

    // Review & commit form
    await win.getByRole('button', { name: 'Review & commit' }).click();
    const form = win.getByRole('region', { name: 'Review commit' });
    await expect(form).toBeVisible();

    // api is committable with checkbox
    const repoApiSection = form.getByTestId('commit-repo-api');
    await expect(repoApiSection.getByRole('checkbox', { name: 'Commit changes in api' })).toBeVisible();

    // ref-docs shows read-only reference notice and no commit checkbox
    const refSection = form.getByTestId('commit-repo-ref-docs');
    await expect(refSection).toContainText('read-only reference');
    await expect(refSection.getByRole('checkbox')).toHaveCount(0);
    await expect(refSection).toContainText('Not committed: this is your own checkout. Prepare it for editing to work on it in this workspace.');

    // Only 1 file is selected for commit
    const summary = form.getByTestId('commit-review-summary');
    await expect(summary).toContainText('Commit 1 file');

    // Commit only api
    await form.getByLabel('Commit message').fill('feat: commit editable only');
    await form.getByRole('button', { name: /^Commit/ }).last().click();

    await expect.poll(() => commitPayload).toBeTruthy();
    expect(commitPayload).toEqual({
      message: 'feat: commit editable only',
      noPush: false,
      files: {
        api: ['src/server/handler.ts'],
      },
    });
  });
});
