import { devices, type Locator, type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardFileCard, checkpoint, planFile, step, whatsNew } from './planData';
import type { LineNote } from '../src/features/board/lineNotes';

const workspace = { id: 'demo', branchName: 'demo', name: 'Point and ask', description: 'Reader notes', repos: [], assistants: [], workspacePath: '/tmp/pa1-demo', createdAt: '2026-10-01T00:00:00Z' };
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1100, height: 700 } });
const code = Array.from({ length: 45 }, (_, i) => `const value${i + 1} = ${i + 1};`).join('\n');
const markdown = '# A short guide\n\nFirst paragraph.\nStill the first block.\n\n## Why this matters\n\nThe next paragraph.';
const sample = (overrides: Partial<LineNote> = {}): LineNote => ({ id: 'pa1-note', path: 'sample.ts', line: 2, endLine: 3, anchor: 'const value2 = 2;\nconst value3 = 3;', anchorCut: false, text: 'These two values configure the reader.', tag: 'question', harness: 'codex', createdAt: new Date().toISOString(), ...overrides });
const reader = (page: Page) => page.locator('[data-board-reader]').filter({ visible: true });

async function setup(page: Page, options: { notes?: LineNote[]; content?: string; markdownContent?: string; news?: boolean } = {}) {
  const typed: string[] = []; let notes = options.notes ?? []; let done = 0;
  await page.addInitScript(() => {
    localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
    localStorage.setItem('contextspace_board_reader_layout_v1', 'large');
  });
  await page.route('**/api/workspace/demo/plan', r => r.fulfill({ json: planFile({ checkpoints: [checkpoint('Reader work', { steps: [step('Read the samples')] })] }) }));
  await page.route('**/api/workspace/demo/board', r => r.fulfill({ json: boardFile({ cards: [boardFileCard(1, 'sample.ts', { title: 'Sample code', step: 'read-the-samples' }), boardFileCard(2, 'guide.md', { title: 'Source guide', step: 'read-the-samples' })] }) }));
  await page.route('**/api/workspace/demo/news', r => r.fulfill({ json: whatsNew({ lineNotes: { items: options.news ? notes : [], more: 0 }, empty: !options.news }) }));
  await page.route('**/api/workspace/demo/line-notes', r => r.fulfill({ json: { notes } }));
  await page.route('**/api/workspace/demo/line-notes/*/done', r => { done++; notes = []; return r.fulfill({ json: { ok: true } }); });
  await page.route('**/api/workspace/demo/documents/preview**', r => {
    const name = new URL(r.request().url()).searchParams.get('name');
    return r.fulfill({ json: { name, kind: name === 'guide.md' ? 'markdown' : 'text', content: name === 'guide.md' ? (options.markdownContent ?? markdown) : options.content ?? code } });
  });
  await page.route('**/api/terminals/bootstrap', r => r.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', r => r.fulfill({ json: { available: true, sessions: [{ id: 'term-demo', workspace: 'demo', target: 'shell', label: 'bash', cwd: '/tmp/pa1-demo', state: 'running' }], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  await page.routeWebSocket('**/ws/terminal', socket => socket.onMessage(message => {
    const parsed = JSON.parse(String(message));
    if (parsed.type === 'input') typed.push(parsed.data);
    if (parsed.type === 'attach') { socket.send(JSON.stringify({ type: 'ready', terminal: { id: parsed.id, workspace: 'demo', target: 'shell', label: 'bash', cwd: '/tmp/pa1-demo', state: 'running' }, truncated: false })); socket.send(JSON.stringify({ type: 'replayed' })); }
  }));
  await page.goto('/#/workspaces/demo/board');
  await expect(page.locator('.board-overview-plane button.board-area').filter({ hasText: 'Reader work' })).toBeVisible();
  return { typed, done: () => done };
}
async function open(page: Page, title = 'Sample code') {
  await page.locator('.board-overview-plane button.board-area').filter({ hasText: 'Reader work' }).click();
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click();
  await expect(reader(page).locator('[data-reader-lines]')).toBeVisible();
}
async function select(body: Locator, from: number, to: number) {
  await body.evaluate((el, { from, to }) => {
    const start = el.querySelector(`[data-source-line="${from}"]`)!;
    const end = el.querySelector(`[data-source-line="${to}"]`)!;
    // Select source text only; a margin pencil or open note is not part of the Markdown block.
    const textWalker = (block: Element) => document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('[data-line-note-ui]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const walker = textWalker(start); const a = walker.nextNode()!;
    const endWalker = textWalker(end); let b = endWalker.nextNode()!;
    if (start === end) { let next; while ((next = endWalker.nextNode())) b = next; }
    const range = document.createRange(); range.setStart(a, 0); range.setEnd(b, b.textContent!.length);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  }, { from, to });
}
for (const [file, from, to, title] of [['sample.ts', 2, 3, 'Sample code'], ['guide.md', 3, 3, 'Source guide']] as const) {
  test(`Ask ${file} uses source lines and never sends Enter`, async ({ page }) => {
    const state = await setup(page); await open(page, title);
    await select(reader(page), from, to);
    await reader(page).getByRole('button', { name: 'Ask', exact: true }).click();
    const end = file === 'guide.md' ? 4 : to;
    await expect.poll(() => state.typed.join('')).toBe(`About ${file} lines ${from}-${end} (when you answer, also pin a short answer to these lines with annotate_document): `);
    expect(state.typed.join('')).not.toMatch(/[\r\n]/);
  });
}
test('marker opens a note, polling preserves it, and Done saves and hides it', async ({ page }) => {
  const state = await setup(page, { notes: [sample()] }); await open(page);
  await reader(page).getByRole('button', { name: 'Note from codex on lines 2-3' }).click();
  await expect(reader(page).getByRole('region', { name: 'Note from codex', exact: true })).toContainText('These two values');
  await page.waitForResponse(r => r.url().endsWith('/line-notes') && r.request().method() === 'GET');
  await expect(reader(page).getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await reader(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(state.done).toBe(1);
  await expect(reader(page).locator('[data-note-marker]')).toHaveCount(0);
});
test('moved marker follows its text and changed note keeps the old text', async ({ page }) => {
  await setup(page, { notes: [sample()], content: `inserted\n${code}` }); await open(page);
  await expect(reader(page).locator('[data-note-marker="3"]')).toBeVisible();
  await reader(page).locator('[data-note-marker="3"]').click();
  await expect(reader(page).getByRole('region', { name: 'Note from codex' })).toContainText('moved');
  await page.route('**/api/workspace/demo/documents/preview**', r => r.fulfill({ json: { name: 'sample.ts', kind: 'text', content: code.replace('const value2 = 2;', 'edited();') } }));
  await page.reload(); await open(page);
  await reader(page).locator('[data-note-marker="2"]').click();
  await expect(reader(page).getByText('These lines changed since', { exact: true })).toBeVisible();
  await expect(reader(page).locator('[data-note-id] pre')).toContainText('const value2 = 2;');
});
test('news opens the file on its note and seeing it does not send Done', async ({ page }) => {
  const state = await setup(page, { notes: [sample({ path: 'guide.md', line: 3, endLine: 4, anchor: 'First paragraph.\nStill the first block.' })], news: true });
  await page.getByTestId('board-now-news').click();
  await page.getByRole('button', { name: /Note on guide.md lines 3-4/ }).click();
  await expect(reader(page).getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  expect(state.done()).toBe(0);
});
test('Escape dismisses Ask first; selection copy, Tab and source view work', async ({ page }) => {
  await setup(page); await open(page, 'Source guide');
  await select(reader(page), 3, 3);
  await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('First paragraph.');
  expect(await reader(page).getByRole('button', { name: 'Ask', exact: true }).evaluate(el => el.tabIndex)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
  await expect(reader(page)).toBeVisible();
  await reader(page).getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'View source', exact: true }).click();
  await select(reader(page), 3, 4);
  await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(reader(page)).toHaveCount(0);
});
test('Escape closes an open note before closing the reader', async ({ page }) => {
  await setup(page, { notes: [sample()] }); await open(page);
  await reader(page).locator('[data-note-marker="2"]').click();
  await page.keyboard.press('Escape');
  await expect(reader(page).getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  await expect(reader(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(reader(page)).toHaveCount(0);
});
for (const width of [1100, 420]) test(`Ask and note targets fit at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 700 });
  await setup(page, { notes: [sample()] });
  // Match board-overview's narrow fixture: a 420 px viewport in Board mode.
  // A divider drag is bounded by the Split layout's minimum pane widths.
  await page.getByTestId('view-mode-board').click();
  if (width === 420) await expect.poll(async () => Math.abs((await page.locator('[data-board-pane]').boundingBox())!.width - 420)).toBeLessThanOrEqual(10);
  await open(page);
  await reader(page).locator('[data-note-marker="2"]').click();
  const bounds = await reader(page).boundingBox(); expect(bounds).toBeTruthy();
  for (const name of ['Done', 'Close']) {
    const button = reader(page).getByRole('button', { name, exact: true }).last();
    const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
  }
});

test('selection must stay in the body and clears with selection or item changes', async ({ page }) => {
  await setup(page); await open(page);
  await reader(page).evaluate(el => {
    const range = document.createRange();
    range.setStart(el.querySelector('h2')!.firstChild!, 0);
    range.setEnd(el.querySelector('[data-source-line="3"] span')!.firstChild!, 5);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
  await select(reader(page), 2, 3);
  await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
  await select(reader(page), 2, 3);
  await reader(page).getByRole('button', { name: 'Ask', exact: true }).focus();
  await page.keyboard.press(']');
  await expect(reader(page).getByRole('heading', { level: 2 })).toHaveText('Source guide');
  await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
});
test('Code window and dialogs keep reader keys; Alt+Enter asks after they close', async ({ page }) => {
  const state = await setup(page, { notes: [sample()] }); await open(page);
  await select(reader(page), 2, 3);
  await reader(page).getByRole('button', { name: 'Ask', exact: true }).focus();
  for (const guard of ['code', 'dialog']) {
    await page.evaluate(kind => {
      const el = document.createElement('div'); el.id = 'pa1-key-guard';
      if (kind === 'dialog') el.setAttribute('role', 'dialog');
      else { el.setAttribute('data-code-window-backdrop', ''); el.innerHTML = '<div data-code-window></div>'; }
      document.body.append(el);
    }, guard);
    for (const key of ['Escape', '[', ']', '/', 'Alt+Enter']) await page.keyboard.press(key);
    await expect(reader(page).getByRole('heading', { level: 2 })).toHaveText('Sample code');
    await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
    expect(state.typed).toEqual([]);
    await page.evaluate(() => document.getElementById('pa1-key-guard')!.remove());
  }
  await page.keyboard.press('Alt+Enter');
  await expect.poll(() => state.typed.join('')).toBe('About sample.ts lines 2-3 (when you answer, also pin a short answer to these lines with annotate_document): ');
});

test('copying selected code keeps source newlines and excludes margin controls', async ({ page }) => {
  await setup(page, { notes: [sample()] }); await open(page);
  await reader(page).locator('[data-note-marker="2"]').click();
  await select(reader(page), 2, 3);
  const copied = await reader(page).locator('[data-reader-lines]').evaluate(el => {
    const data = new DataTransfer();
    el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
    return data.getData('text/plain');
  });
  // The range ends before the separate newline text node; native copy has no final newline.
  expect(copied).toBe('const value2 = 2;\nconst value3 = 3;');
});

async function setupCodeNotes(page: Page, options: { repo?: boolean; content?: string; dirty?: boolean; noTerminal?: boolean; note?: Partial<LineNote> } = {}) {
  const repo = options.repo !== false;
  const path = repo ? 'src/values.ts' : 'sample.ts';
  const note = sample({ path, ...(repo ? { repo: 'demo-repo' } : {}), ...options.note });
  const state = await setup(page, { notes: [note], news: true });
  const listing = repo ? [{ repoName: 'demo-repo', repoPath: '/tmp/pa1-demo-repo', files: [{ file: path, type: 'clean', additions: 0, deletions: 0 }] }] : [];
  await page.route('**/api/workspace/demo/changes**', r => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith('/diff')) return r.fulfill({ json: { diff: options.dirty ? '@@ -1 +1 @@\n-old\n+new' : '', fileContent: options.content ?? code, originalContent: code } });
    if (url.pathname.endsWith('/symbols')) return r.fulfill({ json: { symbols: [] } });
    return r.fulfill({ json: { changes: listing } });
  });
  await page.route('**/api/workspace/demo/files/read?*', r => r.fulfill({ json: { content: options.content ?? code } }));
  await page.route('**/api/workspace/demo/files/reference?*', r => r.fulfill({ json: { status: 'found', target: { file: path, viewer: 'code', origin: repo ? { kind: 'repository', repoName: 'demo-repo', repoPath: '/tmp/pa1-demo-repo' } : { kind: 'workspace', workspacePath: '/tmp/pa1-demo' } } } }));
  if (options.noTerminal) await page.route('**/api/terminals/*/status', r => r.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  // Reproduce the production reader boundary: TypeScript is never a reader document.
  const previews: string[] = [];
  await page.route('**/api/workspace/demo/documents/preview**', r => {
    previews.push(r.request().url()); return r.fulfill({ status: 400, json: { error: ".ts files can't be opened here" } });
  });
  await page.reload();
  await page.getByTestId('board-now-news').click();
  await page.getByRole('button', { name: new RegExp(`Note on ${repo ? 'demo-repo/' : ''}${path.replace('.', '\\.')} lines ${note.line}-${note.endLine}`) }).click();
  await expect(page.locator('[data-code-file-path]')).toBeVisible();
  await expect(page.locator('[data-code-line-note]')).toContainText('These two values');
  expect(previews).toEqual([]);
  return { ...state, note };
}
async function selectMonaco(page: Page, first = 2, last = 3) {
  const input = page.getByTestId('code-file-viewer').getByRole('textbox', { name: 'Editor content', exact: true });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await input.focus();
  await page.keyboard.press('Control+Home');
  for (let line = 1; line < first; line++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  for (let line = first; line < last; line++) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+End');
  await expect(page.getByRole('button', { name: `Ask about lines ${first}-${last}`, exact: true })).toBeVisible();
}
for (const repo of [true, false]) test(`Code note opens ${repo ? 'repository' : 'workspace'} file and Ask types exact text`, async ({ page }) => {
  const state = await setupCodeNotes(page, { repo });
  await selectMonaco(page);
  await page.getByRole('button', { name: 'Ask about lines 2-3', exact: true }).click();
  await expect.poll(() => state.typed.join('')).toBe(`About ${repo ? 'demo-repo/src/values.ts' : 'sample.ts'} lines 2-3 (when you answer, also pin a short answer to these lines with annotate_document): `);
  expect(state.typed.join('')).not.toMatch(/[\r\n]/);
  await expect(page.locator('[data-code-window-backdrop]:not([hidden])')).toHaveCount(0);
});
test('Code note uses file view even when the file has a diff; moved marker and changed anchor', async ({ page }) => {
  await setupCodeNotes(page, { dirty: true, content: `inserted\n${code}` });
  await expect(page.locator('[data-code-line-note]')).toContainText('lines 3-4');
  await expect(page.locator('[data-code-line-note]')).toContainText('moved');
  await expect(page.getByTestId('code-file-viewer').locator('.pa1-note-glyph')).toBeVisible();
  await page.route('**/api/workspace/demo/changes/diff?*', r => r.fulfill({ json: { diff: '', fileContent: code.replace('const value2 = 2;', 'edited();') } }));
  await page.reload();
  await page.getByTestId('board-now-news').click();
  await page.getByRole('button', { name: /Note on demo-repo\/src\/values.ts lines 2-3/ }).click();
  await expect(page.locator('[data-code-line-note]')).toContainText('These lines changed since');
  await expect(page.locator('[data-code-line-note] pre')).toContainText('const value2 = 2;');
});
test('Monaco selection, editor DOM and open note survive a notes poll; Escape closes Ask then note then window', async ({ page }) => {
  await setupCodeNotes(page);
  await page.getByTestId('code-file-viewer').locator('.monaco-editor').evaluate(el => el.setAttribute('data-pa1-witness', 'original'));
  await selectMonaco(page);
  await page.waitForResponse(r => r.url().endsWith('/line-notes') && r.request().method() === 'GET');
  await expect(page.locator('.monaco-editor[data-pa1-witness="original"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask about lines 2-3', exact: true })).toBeVisible();
  await expect(page.locator('[data-code-line-note]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Ask about lines 2-3', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-code-line-note]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-code-line-note]')).toHaveCount(0);
  await expect(page.locator('[data-code-window-backdrop]:not([hidden])')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-code-window-backdrop]:not([hidden])')).toHaveCount(0);
});
test('Code glyph and keyboard Notes list open the note; Done saves and removes the marker', async ({ page }) => {
  const state = await setupCodeNotes(page);
  await page.locator('[data-code-line-note]').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('code-file-viewer').locator('.pa1-note-glyph').click();
  await expect(page.locator('[data-code-line-note]')).toBeVisible();
  await page.locator('[data-code-line-note]').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('code-file-viewer').getByRole('textbox', { name: 'Editor content', exact: true }).focus();
  await page.keyboard.press('Alt+n');
  await page.getByRole('button', { name: 'Note from codex on lines 2-3', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-code-line-note]').getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(state.done).toBe(1);
  await expect(page.getByTestId('code-file-viewer').locator('.pa1-note-glyph')).toHaveCount(0);
});
test.describe('Linux native clipboard', () => {
  // Desktop Chrome's bundled descriptor advertises Windows even on the Linux runner.
  // Monaco intentionally copies CRLF on Windows. Use the runner's OS for the exact LF contract;
  // do not trim spaces or normalize the copied value to hide a source/selection error.
  test.use({ userAgent: devices['Desktop Chrome'].userAgent.replace('Windows NT 10.0; Win64; x64', 'X11; Linux x86_64') });
  test('Monaco copies its native selection without margin note text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupCodeNotes(page);
    await selectMonaco(page);
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('const value2 = 2;\nconst value3 = 3;');
    await page.locator('[data-code-line-note]').getByRole('button', { name: 'Close', exact: true }).click();
    await selectMonaco(page);
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('const value2 = 2;\nconst value3 = 3;');
  });

  test('Monaco preserves real trailing spaces in the selected source', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupCodeNotes(page, { content: code.replace('const value2 = 2;', 'const value2 = 2;    ') });
    await selectMonaco(page);
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('const value2 = 2;    \nconst value3 = 3;');
  });
});
for (const width of [1100, 420]) test(`Code file Ask and note controls fit at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 700 });
  await setupCodeNotes(page, { repo: false });
  await selectMonaco(page);
  const window = (await page.locator('[data-code-window]').boundingBox())!;
  for (const button of [page.getByRole('button', { name: 'Ask about lines 2-3', exact: true }), page.locator('[data-code-line-note]').getByRole('button', { name: 'Done', exact: true }), page.locator('[data-code-line-note]').getByRole('button', { name: 'Close', exact: true })]) {
    const rect = (await button.boundingBox())!;
    expect(rect.height).toBeGreaterThanOrEqual(24); expect(rect.width).toBeGreaterThanOrEqual(24);
    expect(rect.x + rect.width).toBeLessThanOrEqual(window.x + window.width + 1);
  }
  expect(await page.locator('[data-code-line-note]').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
});
test('Code note time ages while selection remains open', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  await setupCodeNotes(page);
  await expect(page.locator('[data-code-line-note]')).toContainText('just now');
  await selectMonaco(page);
  await page.clock.fastForward(120_000);
  await expect(page.locator('[data-code-line-note]')).not.toContainText('just now');
  await expect(page.getByRole('button', { name: 'Ask about lines 2-3', exact: true })).toBeVisible();
});

test('Code Ask uncovers the terminal when no session is running', async ({ page }) => {
  const state = await setupCodeNotes(page, { repo: false, noTerminal: true });
  await selectMonaco(page);
  await page.getByRole('button', { name: 'Ask about lines 2-3', exact: true }).click();
  await expect(page.locator('[data-code-window-backdrop]:not([hidden])')).toHaveCount(0);
  await expect(page.getByText('Start a CLI', { exact: true })).toBeVisible();
  expect(state.typed).toEqual([]);
});

test('Code window header focus still closes its note before the window', async ({ page }) => {
  await setupCodeNotes(page);
  await page.locator('[data-code-window]').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-code-line-note]')).toHaveCount(0);
  await expect(page.locator('[data-code-window-backdrop]:not([hidden])')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-code-window-backdrop]:not([hidden])')).toHaveCount(0);
});

async function expectReceivesPointer(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await expect.poll(() => button.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit === el || el.contains(hit);
  }), { message: 'the control centre must receive the pointer, without clipping or an intercepting layer' }).toBe(true);
}
for (const markdown of [false, true]) test(`Reader ${markdown ? 'Markdown' : 'plain text'} marker and Ask receive pointer hits`, async ({ page }) => {
  const line = markdown ? 3 : 2;
  const endLine = markdown ? 4 : 3;
  const note = sample(markdown ? { path: 'guide.md', line, endLine, anchor: 'First paragraph.\nStill the first block.' } : {});
  const state = await setup(page, { notes: [note] });
  await open(page, markdown ? 'Source guide' : 'Sample code');
  const marker = reader(page).getByRole('button', { name: `Note from codex on lines ${line}-${endLine}`, exact: true });
  await expectReceivesPointer(marker);
  await marker.click();
  await expect(reader(page).getByRole('region', { name: 'Note from codex', exact: true })).toBeVisible();
  await reader(page).getByRole('button', { name: 'Close', exact: true }).last().click();
  await select(reader(page), line, markdown ? line : endLine);
  const ask = reader(page).getByRole('button', { name: 'Ask', exact: true });
  await expectReceivesPointer(ask);
  await ask.click();
  await expect.poll(() => state.typed.join('')).toBe(`About ${note.path} lines ${line}-${endLine} (when you answer, also pin a short answer to these lines with annotate_document): `);
});

test('reader Escape leaves a focused Split terminal alone while its note stays open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await setup(page, { notes: [sample()] });
  await page.getByTestId('view-mode-split').click();
  await open(page);
  await reader(page).getByRole('button', { name: 'Note from codex on lines 2-3', exact: true }).click();
  const terminal = page.locator('.xterm-helper-textarea');
  await terminal.focus();
  await page.keyboard.press('Escape');
  await expect.poll(() => state.typed.join('')).toContain('\x1b');
  await expect(reader(page).getByRole('region', { name: 'Note from codex', exact: true })).toBeVisible();
});

test('rendered Markdown copy excludes an open annotation and retains native paragraph breaks', async ({ page }) => {
  const note = sample({ path: 'guide.md', line: 3, endLine: 4, anchor: 'First paragraph.\nStill the first block.', text: 'Only the annotation answer.' });
  await setup(page); await open(page, 'Source guide');
  await select(reader(page), 3, 8);
  const native = await page.evaluate(() => window.getSelection()!.toString());
  expect(native).toContain('First paragraph.'); expect(native).toContain('The next paragraph.');
  // Clear the baseline selection/Ask before pressing the arriving marker in that same gutter.
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await expect(reader(page).getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
  await page.route('**/api/workspace/demo/line-notes', r => r.fulfill({ json: { notes: [note] } }));
  const marker = reader(page).getByRole('button', { name: 'Note from codex on lines 3-4', exact: true });
  await expect(marker).toBeVisible({ timeout: 10000 });
  await marker.click();
  await select(reader(page), 3, 8);
  const copied = await reader(page).locator('[data-reader-lines]').evaluate(el => {
    const data = new DataTransfer(); const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data });
    const selection = window.getSelection()!;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
    el.dispatchEvent(event);
    return { text: data.getData('text/plain'), html: data.getData('text/html'), preserved: selection.anchorNode === anchorNode && selection.anchorOffset === anchorOffset && selection.focusNode === focusNode && selection.focusOffset === focusOffset };
  });
  expect(copied.text).toBe(native);
  expect(copied.preserved).toBe(true);
  for (const ui of ['Only the annotation answer.', 'codex', 'Done', 'Close']) {
    expect(copied.text).not.toContain(ui); expect(copied.html).not.toContain(ui);
  }
  // Deliberately selecting the answer still leaves native copying available.
  await reader(page).getByText('Only the annotation answer.', { exact: true }).evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  expect(await reader(page).locator('[data-reader-lines]').evaluate(el => {
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    el.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(false);
});

for (const changed of [false, true]) test(`Code note jump uses its ${changed ? 'changed clamped' : 'moved'} marker location`, async ({ page }) => {
  const note = { line: 12, endLine: 14, anchor: code.split('\n').slice(11, 14).join('\n') };
  const content = changed ? 'short\nfile' : `${Array.from({ length: 30 }, () => '// inserted').join('\n')}\n${code}`;
  await setupCodeNotes(page, { content, note });
  await expect(page.locator('[data-code-line-note]')).toContainText(changed ? 'lines 2-2' : 'lines 42-44');
  const viewer = page.getByTestId('code-file-viewer');
  const jump = viewer.locator('.pa1-jump-line');
  const marker = viewer.locator('.pa1-note-glyph');
  await expect(jump).toHaveCount(1); await expect(marker).toBeVisible();
  await expect.poll(async () => Math.abs((await jump.boundingBox())!.y - (await marker.boundingBox())!.y)).toBeLessThanOrEqual(2);
  const viewport = (await viewer.boundingBox())!; const glyph = (await marker.boundingBox())!;
  expect(glyph.y).toBeGreaterThanOrEqual(viewport.y);
  expect(glyph.y + glyph.height).toBeLessThanOrEqual(viewport.y + viewport.height);
});

test('news opens a reference-definition note beside its preceding rendered Markdown block', async ({ page }) => {
  const content = '# Title\n\nRead [the API][api].\n\n[api]: ./api.md';
  const note = sample({ path: 'guide.md', line: 5, endLine: 5, anchor: '[api]: ./api.md', text: 'This reference points to the API guide.' });
  const state = await setup(page, { notes: [note], news: true, markdownContent: content });
  await page.getByTestId('board-now-news').click();
  await page.getByRole('button', { name: /Note on guide\.md lines? 5/ }).click();
  const body = reader(page).locator('[data-reader-lines]');
  await expect(body.getByRole('heading', { name: 'Title', exact: true })).toBeVisible();
  await expect(body.locator('[data-source-single]')).toHaveCount(0);
  const block = body.locator('[data-source-line="3"][data-source-end="3"]');
  await expect(block.getByRole('button', { name: 'Note from codex on lines 5-5', exact: true })).toBeVisible();
  const panel = block.locator(`[data-note-id="${note.id}"]`);
  await expect(panel).toBeVisible(); await expect(panel).toContainText(note.text);
  await expect(panel).toContainText('lines 5-5');
  await expect(panel.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  expect(state.done()).toBe(0);
});
