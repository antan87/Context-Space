/**
 * Knowledge on the Board (slice KN): the workspace's decisions and gotchas open from the Board index, from its search and from
 * the news, in the reader, read only. Everything is faked, and every write is refused: nothing in this file may write.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardNote, checkpoint, planFile, step, whatsNew } from './planData';

const workspace = {
  id: 'demo', branchName: 'demo', name: 'The Board', description: 'The board', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z',
};
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const entry = (date: string, title: string, kind: 'Decision' | 'Gotcha', text: string) => `### ${date} — ${title}\n**${kind}:** ${text}\n\n`;
const FILLER = 'It was decided after a long session, and the reason is written here so that the next session does not have to find it again by trying.';
const decisions = [
  ['2026-11-13', 'Gemini 4 Hydrogen is a main builder'],
  ['2026-11-13', 'use-available-models-sonnet-builds-opus-reviews'],
  ['2026-11-12', 'flash-remains-a-regular-builder-option'],
  ['2026-11-12', 'terra-builds-routine-slices-sol-reviews'],
  ['2026-11-11', 'The Board will replace the Plan tab'],
  ['2026-11-10', 'big-picture-first-only-what-people-arrange-can-be-dragged'],
  ['2026-11-09', 'the-ai-changes-the-board-freely'],
] as const;
const gotchas = [
  ['2026-11-13', 'build-gui-to-scratch-while-preview-is-running'],
  ['2026-11-12', 'run-the-vite-dev-gui-on-localhost-not-127-0-0-1'],
  ['2026-11-11', 'answers-given-in-the-chat-do-not-clear-the-plan-tab'],
  ['2026-11-10', 'test-board-layouts-at-laptop-sizes-with-real-looking-data'],
  ['2026-11-09', 'run-playwright-with-playwright-html-open-never-in-gui'],
  ['2026-11-08', 'an-old-lesson-about-ports-that-sits-at-the-bottom'],
  ['2026-11-07', 'the-oldest-lesson-about-scrolling'],
] as const;
const FRESH = entry('2026-11-14', 'a-freshly-added-gotcha-about-refreshes', 'Gotcha', 'It arrived while the reader was open.');
const knowledgeFile = (extra = '') => `# Workspace Knowledge\n\n## Architecture Decisions\n\n${decisions.map(([date, title]) => entry(date, title, 'Decision', FILLER)).join('')}## Gotchas\n\n${gotchas.map(([date, title]) => entry(date, title, 'Gotcha', FILLER)).join('')}${extra}`;
const OLDEST = 'The oldest lesson about scrolling';

const newsOf = (withKnowledge: boolean, extra = false) => whatsNew({
  knowledge: withKnowledge ? { items: [
    { id: '2026-11-13-gemini-4-hydrogen-is-a-main-builder', title: 'Gemini 4 Hydrogen is a main builder', date: '2026-11-13', type: 'decision' },
    { id: '2026-11-07-the-oldest-lesson-about-scrolling', title: OLDEST, date: '2026-11-07', type: 'gotcha' },
    ...(extra ? [{ id: '2026-11-14-a-freshly-added-gotcha-about-refreshes', title: 'A freshly added gotcha about refreshes', date: '2026-11-14', type: 'gotcha' as const }] : []),
  ], more: 3 } : { items: [], more: 0 },
  commits: [{ repo: 'NexusFlow', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Claude', subject: 'feat(board): the Code window', at: minutesAgo(2) }] }],
});

interface State { content: string | null; status: number; extra: boolean; withNews: boolean; gets: number; writes: string[]; release: () => void }

/** The Board with its knowledge faked. `content` null answers the way a workspace without the file does (a short note). */
async function routeKnowledge(page: Page, options: { content?: string | null; status?: number; withNews?: boolean; gate?: boolean; terminal?: string } = {}): Promise<State> {
  const state: State = { content: options.content === undefined ? knowledgeFile() : options.content, status: options.status ?? 200, extra: false, withNews: options.withNews ?? true, gets: 0, writes: [], release: () => {} };
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  const session = { id: 'term-demo', workspace: 'demo', target: 'shell', label: 'shell', cwd: '/tmp/demo', state: 'running' };
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: options.terminal ? [session] : [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type !== 'attach') return;
      const terminal = { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'shell', cwd: '/tmp/demo', state: 'running' };
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      if (options.terminal) socket.send(JSON.stringify({ type: 'output', data: `opened ${options.terminal}\r\n` }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ title: 'The Board', checkpoints: [checkpoint('Reports export to CSV', { steps: [step('Write the CSV writer', true), step('Background job queue')] })] }) }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: newsOf(state.withNews, state.extra) }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile({ cards: [boardNote(1, { title: 'A note on the board' })] }) }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  await page.route('**/api/workspace/demo/knowledge', (route) => {
    state.gets += 1;
    if (state.status !== 200) return route.fulfill({ status: state.status, json: { error: 'knowledge is not available' } });
    return route.fulfill({ json: { content: state.content ?? '# Workspace Knowledge\n\nNo knowledge file yet.' } });
  });
  await page.route('**/api/workspace/demo/files/reference?*', (route) => route.fulfill({ json: { status: 'found', target: { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: new URL(route.request().url()).searchParams.get('path'), viewer: 'reader' } } }));
  const gate = new Promise<void>((resolve) => { state.release = resolve; });
  await page.route('**/api/workspace/*/screen-events**', async (route) => {
    if (!options.gate) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' });
    await gate;
    const at = new Date().toISOString();
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 60000\n\nevent: plan\nid: p1\ndata: ${JSON.stringify({ type: 'plan', timestamp: at })}\n\n` });
  });
  // Nothing here may write
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    state.writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
  return state;
}

async function openBoard(page: Page, split = false, indexOpen = true) {
  if (indexOpen) await page.addInitScript(() => { try { window.localStorage.setItem('contextspace_board_nav_open_v1', 'open'); } catch { /* no storage */ } });
  await page.goto('/#/workspaces/demo/board');
  if (split) {
    if (await page.getByTestId('view-mode-split').isDisabled()) await page.getByRole('button', { name: /^Collapse/ }).click();
    await page.getByTestId('view-mode-split').click();
  }
  await expect(page.getByTestId('board-now-line')).toBeVisible();
  await expect(page.locator('#board-overview button.board-area').first()).toBeVisible();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Board index' });
const entryButton = (page: Page) => nav(page).getByTestId('board-index-knowledge');
const reader = (page: Page) => page.locator('[data-board-reader]');
const scroller = (page: Page) => page.getByTestId('board-knowledge');
const rowOf = (page: Page, title: string) => scroller(page).locator('[data-knowledge-entry]').filter({ hasText: title });

/** Opens the index when it is a rail or a drawer; it is there already when it docks open. */
async function openIndex(page: Page) {
  if (!(await nav(page).isVisible())) await page.getByRole('button', { name: /^Board index/ }).click();
  await expect(nav(page)).toBeVisible();
}
const within = async (inner: Locator, outer: Locator) => {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  return Boolean(a && b && a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5);
};
const focusedIs = (locator: Locator) => locator.evaluate((element) => element === document.activeElement);

const SIZES = [
  { name: '1440x900 board', width: 1440, height: 900, split: false, scheme: 'light' as const },
  { name: '1100x700 split', width: 1100, height: 700, split: true, scheme: 'dark' as const },
  { name: '420 pane', width: 420, height: 800, split: false, scheme: 'light' as const },
];

for (const size of SIZES) {
  test.describe(`Knowledge in the index, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, colorScheme: size.scheme });

    test('the index has a Knowledge entry with its count and what is new, in both modes, in view and big enough to press', async ({ page }) => {
      const state = await routeKnowledge(page);
      await openBoard(page, size.split, size.width > 600);
      await openIndex(page);
      const button = entryButton(page);
      await expect(button).toContainText('Knowledge');
      await expect(button).toContainText('· 14 entries');
      await expect(button).toContainText('5 new');
      for (const mode of ['Category', 'Area'] as const) {
        await nav(page).getByRole('button', { name: mode, exact: true }).click();
        await expect(button).toBeVisible();
        expect(await within(button, nav(page)), `${mode}: the entry is inside the index`).toBe(true);
        const box = (await button.boundingBox())!;
        expect(box.height, 'a target of at least 24 px').toBeGreaterThanOrEqual(24);
        expect(box.y, 'above the sections, not below them').toBeLessThan((await nav(page).getByRole('heading').first().boundingBox())?.y ?? Infinity);
      }
      const sizes = await button.evaluate((element) => Array.from(element.querySelectorAll('span')).map((span) => parseFloat(getComputedStyle(span).fontSize)));
      expect(Math.min(...sizes), 'text of at least 12 px').toBeGreaterThanOrEqual(12);
      await expect(button.locator('button, a')).toHaveCount(0);
      expect(state.writes).toEqual([]);
    });

    test('pressing it opens Knowledge in the reader, read only, on one screen; Close and Escape give the keyboard back', async ({ page }) => {
      const state = await routeKnowledge(page);
      await openBoard(page, size.split, size.width > 600);
      await openIndex(page);
      const button = entryButton(page);
      await button.click();
      await expect(reader(page)).toBeVisible();
      await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
      await expect(reader(page)).toContainText('contextspace-knowledge.md');
      await expect(reader(page).getByRole('list', { name: 'Knowledge entries' }).getByRole('listitem')).toHaveCount(14);
      expect(await within(reader(page), page.locator('body'))).toBe(true);
      const readerBox = (await reader(page).boundingBox())!;
      expect(readerBox.y + readerBox.height).toBeLessThanOrEqual(size.height + 0.5);
      // Read only: a search box and the filter, and nothing to edit or save
      await expect(reader(page).getByRole('textbox')).toHaveCount(1);
      await expect(reader(page).getByRole('button', { name: /edit|save|add|delete/i })).toHaveCount(0);
      // Close gives the keyboard back to the entry that opened it (in the drawer, which comes back with it)
      await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
      await expect(reader(page)).toBeHidden();
      await expect(nav(page)).toBeVisible();
      await expect.poll(() => focusedIs(button)).toBe(true);
      // Escape does the same
      await button.click();
      await expect(reader(page)).toBeVisible();
      await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toBeHidden();
      await expect(nav(page)).toBeVisible();
      await expect.poll(() => focusedIs(button)).toBe(true);
      expect(state.writes).toEqual([]);
    });
  });
}

test('the index search finds knowledge by title, and the entry opens Knowledge on it, scrolled to and marked, with the search empty', async ({ page }) => {
  await routeKnowledge(page);
  await openBoard(page);
  const search = nav(page).getByPlaceholder('Search the board…');
  await search.fill('oldest lesson');
  const group = nav(page).getByRole('heading', { name: /^Knowledge \(1\)/ });
  await expect(group).toBeVisible();
  await expect(nav(page).locator('[aria-live="polite"]')).toHaveText('1 match');
  // Only the title is searched, and a search that finds nothing says so, knowledge or not
  await search.fill('so that the next session');
  await expect(nav(page).getByText('No matches found')).toBeVisible();
  await search.fill('oldest lesson');
  const found = nav(page).locator('[data-nav-knowledge]');
  await expect(found).toHaveCount(1);
  await expect(found).toContainText(OLDEST);
  await expect(found).toContainText('Gotcha · 2026-11-07');
  await found.click();
  await expect(reader(page)).toBeVisible();
  await expect(reader(page).getByRole('textbox', { name: 'Search the knowledge' })).toHaveValue('');
  const row = rowOf(page, OLDEST);
  await expect(row.locator('article')).toHaveAttribute('data-marked', 'true');
  // It was at the bottom of fourteen: it is in view now
  await expect.poll(async () => (await scroller(page).evaluate((element) => element.scrollTop))).toBeGreaterThan(300);
  expect(await within(row, scroller(page))).toBe(true);
  // The mark is brief
  await expect(row.locator('article')).not.toHaveAttribute('data-marked', 'true', { timeout: 6000 });
  // Closing returns the keyboard to the entry that was pressed, the search still in the index
  await page.keyboard.press('Escape');
  await expect(reader(page)).toBeHidden();
  await expect.poll(() => focusedIs(found)).toBe(true);
  await expect(search).toHaveValue('oldest lesson');
});

test('a news line for a knowledge entry opens Knowledge on it, and one that cannot name an entry opens it at the top', async ({ page }) => {
  const state = await routeKnowledge(page);
  await openBoard(page);
  const newsButton = page.getByTestId('board-now-news');
  await expect(newsButton).toHaveText('6 new');
  await newsButton.click();
  const list = page.getByTestId('board-news-list');
  await list.getByRole('button', { name: new RegExp(`gotcha “${OLDEST}”`) }).click();
  await expect(reader(page)).toBeVisible();
  await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(rowOf(page, OLDEST).locator('article')).toHaveAttribute('data-marked', 'true');
  expect(await within(rowOf(page, OLDEST), scroller(page))).toBe(true);
  // The news list fades out on its own: Escape is the reader's once it has gone
  await expect(list).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(reader(page)).toBeHidden();
  await expect.poll(() => focusedIs(newsButton)).toBe(true);
  // "and 3 more": no one entry, so the top
  await newsButton.click();
  await list.getByRole('button', { name: /^and 3 more$/ }).click();
  await expect(reader(page)).toBeVisible();
  await expect(scroller(page).locator('article[data-marked="true"]')).toHaveCount(0);
  expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(0);
  await expect(list).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(reader(page)).toBeHidden();
  // The entry of a decision that is not in the file any more cannot be named either: the top again
  state.content = knowledgeFile().replace(/### 2026-11-13 — Gemini 4 Hydrogen[^#]*/, '');
  await page.reload();
  await expect(page.getByTestId('board-now-news')).toHaveText('6 new');
  await page.getByTestId('board-now-news').click();
  await page.getByTestId('board-news-list').getByRole('button', { name: /decision “Gemini 4 Hydrogen is a main builder”/ }).click();
  await expect(reader(page)).toBeVisible();
  await expect(scroller(page).locator('article[data-marked="true"]')).toHaveCount(0);
  expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(0);
  expect(state.writes).toEqual([]);
});

test('a refresh while Knowledge is open keeps the scroll, the search, the filter and the keyboard', async ({ page }) => {
  const state = await routeKnowledge(page, { gate: true });
  await openBoard(page);
  await entryButton(page).click();
  await expect(reader(page)).toBeVisible();
  const search = reader(page).getByRole('textbox', { name: 'Search the knowledge' });
  await reader(page).getByRole('button', { name: /^Gotchas 7/ }).click();
  await search.fill('e');
  await scroller(page).evaluate((element) => { element.scrollTop = 220; });
  await expect.poll(() => scroller(page).evaluate((element) => element.scrollTop)).toBe(220);
  await search.focus();
  // What the reader is looking at: the first entry in view and where it stands
  const lookingAt = () => scroller(page).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const first = Array.from(element.querySelectorAll<HTMLElement>('[data-knowledge-entry]')).find((row) => row.getBoundingClientRect().bottom > top + 1)!;
    return { title: first.querySelector('h3')!.textContent, offset: Math.round(first.getBoundingClientRect().top - top) };
  });
  const before = await lookingAt();
  const reads = state.gets;
  state.content = knowledgeFile(FRESH);
  state.extra = true;
  state.release();
  // The new entry arrives (the filter counts it), and nothing else moved
  await expect(reader(page).getByRole('button', { name: /^Gotchas 8/ })).toBeVisible();
  expect(state.gets).toBeGreaterThan(reads);
  await expect(rowOf(page, 'A freshly added gotcha about refreshes')).toHaveCount(1);
  // The browser keeps what is being read where it was when an entry is added above it: the same entry, in the same place
  expect(await lookingAt()).toEqual(before);
  expect(await scroller(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(search).toHaveValue('e');
  await expect(reader(page).getByRole('button', { name: /^Gotchas 8/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(search).toBeFocused();
  expect(state.writes).toEqual([]);
});

test('keys typed in the Knowledge search belong to it, and Escape clears it before it closes the reader', async ({ page }) => {
  await routeKnowledge(page);
  await openBoard(page);
  await entryButton(page).click();
  const search = reader(page).getByRole('textbox', { name: 'Search the knowledge' });
  await search.focus();
  await page.keyboard.type('a[b]c/d e');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(search).toHaveValue('a[b]c/d e');
  await expect(search).toBeFocused();
  await expect(reader(page)).toBeVisible();
  // The index's search was not asked for by the "/"
  await expect(nav(page).getByPlaceholder('Search the board…')).not.toBeFocused();
  await expect(nav(page).getByPlaceholder('Search the board…')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(reader(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader(page)).toBeHidden();
});

test('a knowledge file with no entries is shown as written, without a search box', async ({ page }) => {
  await routeKnowledge(page, { content: '# Team notes\n\nWe pair on the terminal work.\n' });
  await openBoard(page);
  await expect(entryButton(page)).toContainText('No entries yet');
  await entryButton(page).click();
  await expect(reader(page)).toContainText('We pair on the terminal work.');
  await expect(reader(page).getByRole('textbox')).toHaveCount(0);
  await expect(reader(page).getByRole('alert')).toHaveCount(0);
});

for (const [what, missing] of [['the short note of a workspace without the file', { content: null as string | null }], ['an empty file', { content: '' }], ['a 404 from an older server', { status: 404 }]] as const) {
  test(`a missing knowledge file (${what}) is an honest empty state, not an error box`, async ({ page }) => {
    await routeKnowledge(page, { ...missing, withNews: false });
    await openBoard(page);
    await expect(entryButton(page)).toContainText('No entries yet');
    await expect(entryButton(page)).not.toContainText('new');
    await entryButton(page).click();
    await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
    await expect(reader(page).getByTestId('board-knowledge')).toContainText(/No knowledge (file )?yet/);
    await expect(reader(page).getByRole('alert')).toHaveCount(0);
  });
}

test('a knowledge file that cannot be read says so, with a way to try again', async ({ page }) => {
  const state = await routeKnowledge(page, { status: 500 });
  await openBoard(page);
  await expect(entryButton(page)).toBeVisible();
  await expect(entryButton(page)).not.toContainText('entries');
  await entryButton(page).click();
  await expect(reader(page).getByRole('alert')).toContainText('knowledge is not available');
  state.status = 200;
  await reader(page).getByRole('button', { name: 'Retry' }).click();
  await expect(reader(page).getByRole('list', { name: 'Knowledge entries' }).getByRole('listitem')).toHaveCount(14);
  await expect(entryButton(page)).toContainText('· 14 entries');
});

test('a terminal path to the knowledge file opens the same reader, titled Knowledge', async ({ page }) => {
  const state = await routeKnowledge(page, { terminal: 'contextspace-knowledge.md' });
  await openBoard(page, true);
  const pane = page.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  const cell = await pane.locator('.xterm-screen').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const first = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
    return { x: bounds.x + 80, y: (first?.y ?? bounds.y) + (first?.height ?? 17) * 0.5 };
  });
  await pane.locator('.xterm-helper-textarea').focus();
  await page.mouse.move(cell.x + 200, cell.y + 40);
  await page.mouse.move(cell.x, cell.y);
  await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
  await page.mouse.click(cell.x, cell.y);
  await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(reader(page).getByRole('list', { name: 'Knowledge entries' }).getByRole('listitem')).toHaveCount(14);
  // The menu offers no document actions that make no sense for it
  await reader(page).getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: /View source|Download/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Copy path' })).toBeVisible();
  expect(state.writes).toEqual([]);
});

/** The inside of the reader holds the keyboard: the focused element is the reader itself or something in it. */
const focusInReader = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('[data-board-reader]');
  return Boolean(root && document.activeElement && root.contains(document.activeElement));
});

/** The old Knowledge tab is gone: its address opens the Board with Knowledge in the reader, through the request a link to the knowledge file makes. */
test.describe('the old Knowledge address', () => {
  test('opens the Board with Knowledge in the reader, the keyboard in it, and writes nothing', async ({ page }) => {
    const state = await routeKnowledge(page);
    await page.goto('/#/workspaces/demo/knowledge');
    await expect(page.getByTestId('board-now-line')).toBeVisible();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
    await expect(reader(page).getByRole('list', { name: 'Knowledge entries' }).getByRole('listitem')).toHaveCount(14);
    await expect.poll(() => focusInReader(page)).toBe(true);
    // Read only: a search box and the filter, nothing to edit or save (the old tab had an editor)
    await expect(reader(page).getByRole('button', { name: /edit|save|add|delete/i })).toHaveCount(0);
    // Back does not return to the address that was replaced
    await page.goBack();
    await expect(page).not.toHaveURL(/\/knowledge$/);
    expect(state.writes).toEqual([]);
  });

  test('asked again later, opens Knowledge again', async ({ page }) => {
    await routeKnowledge(page);
    await page.goto('/#/workspaces/demo/knowledge');
    await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
    await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(reader(page)).toBeHidden();
    await page.goto('/#/workspaces/demo/overview');
    await page.goto('/#/workspaces/demo/knowledge');
    await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
    await expect.poll(() => focusInReader(page)).toBe(true);
  });
});

test.describe('the old Knowledge address, in an archived workspace', () => {
  test.use({ workspacesData: [[{ ...workspace, archivedAt: '2026-09-28T10:00:00.000Z' }], { option: true }] });

  test('opens the Board with Knowledge in the reader and the keyboard in it, read only', async ({ page }) => {
    const state = await routeKnowledge(page);
    await page.goto('/#/workspaces/demo/knowledge');
    await expect(page.getByTestId('board-now-line')).toBeVisible();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
    await expect(reader(page).getByRole('list', { name: 'Knowledge entries' }).getByRole('listitem')).toHaveCount(14);
    await expect.poll(() => focusInReader(page)).toBe(true);
    await expect(reader(page).getByRole('button', { name: /edit|save|add|delete/i })).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });

  test('the link under What stays readable on the record opens it', async ({ page }) => {
    await routeKnowledge(page);
    await page.goto('/#/workspaces/demo/overview');
    await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    await expect(reader(page).getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
    await expect.poll(() => focusInReader(page)).toBe(true);
  });
});

// Moved from the old Docs tab's docs-and-plan spec ("reads knowledge as entries you can search and filter"): the reading of a knowledge
// file is KnowledgeView, which the Board reader now draws.
const HAND_WRITTEN = `# Workspace Knowledge — demo

> Append with \`ctxspace knowledge add\`.

## Feature Goal

Invoices should load in under a second.

## Team notes

Ask before changing the cache keys.

## Architecture Decisions

### 2026-10-02 — cache-invoice-lookups
**Decision:** Cache invoice lookups per customer, because totals were read three times a page.
**Scope:** \`path:api/src/invoices\`

## Known Gotchas

### 2026-10-03 — totals-differ-after-midnight
**Gotcha:** Totals differ after midnight UTC: the cache key used local time.
**Evidence:** commit abc1234
`;

test('reads knowledge as entries with where they apply and their evidence, the goal and the team notes, and filters and searches them', async ({ page }) => {
  const state = await routeKnowledge(page, { content: HAND_WRITTEN });
  await openBoard(page);
  await openIndex(page);
  await entryButton(page).click();
  const entries = reader(page).getByRole('list', { name: 'Knowledge entries' }).getByRole('listitem');
  await expect(entries).toHaveCount(2);
  // Newest first, the title in words, with where it applies and the evidence
  await expect(entries.first()).toContainText('Gotcha');
  await expect(entries.first()).toContainText('Totals differ after midnight');
  await expect(entries.first()).toContainText('commit abc1234');
  await expect(entries.last()).toContainText('Applies to api/src/invoices');
  // The goal and what was written by hand are there too, not only the entries
  await expect(reader(page).getByRole('region', { name: 'Feature goal' })).toContainText('Invoices should load in under a second.');
  await expect(reader(page).getByRole('region', { name: 'Team notes' })).toContainText('Ask before changing the cache keys.');
  await reader(page).getByRole('button', { name: /^Decisions/ }).click();
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Cache invoice lookups');
  await reader(page).getByRole('button', { name: /^All/ }).click();
  await reader(page).getByLabel('Search the knowledge').fill('midnight');
  await expect(entries).toHaveCount(1);
  await reader(page).getByLabel('Search the knowledge').fill('nothing like this');
  await expect(reader(page).getByRole('status').filter({ hasText: 'Nothing matches.' })).toBeVisible();
  expect(state.writes).toEqual([]);
});
