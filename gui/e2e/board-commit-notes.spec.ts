import { test, expect, type Page } from './fixtures';
import { boardFile, boardLink, boardNote, checkpoint, planFile, step, whatsNew } from './planData';

const now = Date.now();
const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const WORKSPACE = {
  id: 'demo',
  branchName: 'demo',
  name: 'Reports CSV export',
  description: 'Add CSV export',
  repos: [],
  assistants: [],
  workspacePath: '/tmp/demo',
  createdAt: '2026-10-01T00:00:00Z',
};

const SHA_1 = '1111111222222333333444444555555666666777';
const SHA_2 = '2222222333333444444555555666666777777888';
const SHA_3 = '3333333444444555555666666777777888888999';
const SHA_IN = '9999999aaaaaabbbbbbccccccddddddeeeeeeff0';

const STEP_RV2 = 'RV2: One list in Commits with short step badge';
const PLAN = planFile({
  title: 'Reports CSV export',
  checkpoints: [checkpoint('Reports export to CSV', { steps: [step(STEP_RV2, false)] })],
});

const LONG_DESCRIPTION = Array.from({ length: 70 }, (_, i) => `Description line ${i + 1} explains the change in some detail.`).join('\n');
const LONG_NOTE = Array.from({ length: 60 }, (_, i) => `Long note line ${i + 1}`).join('\n');
const PLAIN_BODY = ['Merge kept both sides', 'The conflict in boardRows.ts kept both lists.', 'Not bold: <b>raw</b> and **stars** and <script>window.__injected = 1</script>.', '', 'Last line after a blank line.'].join('\n');

const detailOf = (sha: string, fields: Record<string, unknown>) => ({
  repo: 'billing', sha, shortSha: sha.slice(0, 7), author: 'Ada Lovelace', at: minsAgo(20), subject: 'a commit', body: '', parents: [],
  files: [{ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }], moreFiles: 0, additions: 2, deletions: 1, pushed: false, forge: null, webUrl: null, ...fields,
});

const DETAILS = [
  detailOf(SHA_1, { subject: 'feat: merge the export branches', body: LONG_DESCRIPTION }),
  detailOf(SHA_2, { subject: 'refactor: tidy diff header', author: 'Grace Hopper', at: minsAgo(90), pushed: true, body: 'Short description.' }),
  detailOf(SHA_3, { subject: 'fix: preserve step focus', author: 'Alan Turing', at: minsAgo(180), pushed: true, body: 'Another short one.' }),
  detailOf(SHA_IN, { subject: 'Stream CSV chunks', author: 'Maria', at: minsAgo(8), pushed: true, forge: 'azure', webUrl: 'https://dev.azure.com/org/billing/commit/x' }),
];

const RECENT_LIST = [
  { sha: SHA_1.slice(0, 7), subject: 'feat: merge the export branches', author: 'Ada Lovelace', at: minsAgo(20), pushed: false, fileCount: 1 },
  { sha: SHA_2.slice(0, 7), subject: 'refactor: tidy diff header', author: 'Grace Hopper', at: minsAgo(90), pushed: true, fileCount: 1 },
  { sha: SHA_3.slice(0, 7), subject: 'fix: preserve step focus', author: 'Alan Turing', at: minsAgo(180), pushed: true, fileCount: 1 },
];

const commitNote = (n: number, sha: string, fields: Record<string, unknown> = {}) => boardNote(n, {
  step: undefined, about: `commit:billing:${sha}`, by: 'claude', ...fields,
});

const NOTE_OLD = commitNote(10, SHA_1, { title: 'Merge kept both sides', body: PLAIN_BODY, at: minsAgo(30), updatedAt: minsAgo(30) });
const NOTE_NEW = commitNote(11, SHA_1, { title: 'Tests still red', body: LONG_NOTE, by: 'ai', at: minsAgo(2), updatedAt: minsAgo(2) });
const NOTE_IN = commitNote(12, SHA_IN, { title: 'Check the retry before merging', body: 'Check the retry before merging\nIt has no backoff yet.', at: minsAgo(5), updatedAt: minsAgo(5) });

test.use({ workspacesData: [[WORKSPACE], { option: true }], sidebarDocked: false });

let writes: string[] = [];
let boardPayload: ReturnType<typeof boardFile>;
let newsPayload: ReturnType<typeof whatsNew>;

const boardWith = (notes: Array<ReturnType<typeof boardNote>>) => {
  const rv2 = PLAN.checkpoints[0]!.steps[0]!.key;
  return boardFile({
    cards: [boardNote(1, { title: 'RV2 Note', step: rv2 }), ...notes],
    links: [
      boardLink(1, `commit:billing:${SHA_1.slice(0, 7)}`, rv2),
      boardLink(2, `commit:billing:${SHA_2.slice(0, 7)}`, rv2),
      boardLink(3, `commit:billing:${SHA_3.slice(0, 7)}`, rv2),
      ...notes.map((note, index) => boardLink(20 + index, note.id as string, (note.about as string))),
    ],
  });
};

/** The page's live stream, held open by the spec so it says when a board event arrives. */
async function holdFeed(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const feeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> = [];
    (window as unknown as { __feeds: typeof feeds }).__feeds = feeds;
    class Held {
      closed = false; readyState = 0; listeners: Record<string, Array<(event: { data?: string; lastEventId: string }) => void>> = {};
      constructor(url: string) {
        if (!url.includes('/screen-events')) return new Native(url) as unknown as Held;
        feeds.push(this);
      }
      addEventListener(type: string, listener: (event: { data?: string; lastEventId: string }) => void) { (this.listeners[type] ??= []).push(listener); }
      close() { this.closed = true; this.readyState = 2; }
      emit(type: string, data?: string) { for (const listener of this.listeners[type] ?? []) listener({ data, lastEventId: '' }); }
    }
    (window as unknown as { EventSource: unknown }).EventSource = Held;
  });
  type Feeds = { __feeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> };
  return {
    open: () => page.evaluate(() => (window as unknown as Feeds).__feeds.filter((feed) => !feed.closed).length),
    connect: () => page.evaluate(() => { for (const feed of (window as unknown as Feeds).__feeds.filter((entry) => !entry.closed)) { feed.readyState = 1; feed.emit('open'); } }),
    boardChanged: (revision: number) => page.evaluate((data) => { for (const feed of (window as unknown as Feeds).__feeds.filter((entry) => !entry.closed)) feed.emit('screen', data); }, JSON.stringify({ type: 'screen', event: { id: `b${revision}`, timestamp: new Date().toISOString(), harness: 'claude', event: 'board', payload: { revision, changes: 1 } } })),
  };
}

test.beforeEach(async ({ page }) => {
  writes = [];
  boardPayload = boardWith([NOTE_OLD, NOTE_NEW, NOTE_IN]);
  newsPayload = whatsNew();

  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: PLAN }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: newsPayload }));
  await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({
    json: { at: new Date().toISOString(), from: minsAgo(4000), commits: [{ repo: 'billing', more: 0, commits: RECENT_LIST }] },
  }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardPayload }));
  await page.route('**/api/workspace/demo/changes**', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({
    json: { repositories: [{ name: 'billing', access: 'isolated', editable: true, path: '/tmp/billing', sourcePath: '/tmp/billing', branch: 'feat/rv2', expectedBranch: 'feat/rv2', onExpectedBranch: true, baseBranch: 'main', headSha: SHA_1, dirty: false, changedFiles: [], ahead: 1, behind: 0, remoteUrl: 'git@github.com:org/billing.git' }] },
  }));
  await page.route('**/api/workspace/demo/incoming**', (route) => route.fulfill({
    json: {
      at: new Date().toISOString(),
      repos: [{
        repo: 'billing', remote: 'origin', branch: 'main', host: { kind: 'azure', name: 'Azure DevOps' }, lastFetchAt: minsAgo(2), fetching: false, state: 'ok', message: null, behind: 1,
        commits: [{ sha: SHA_IN.slice(0, 7), author: 'Maria', subject: 'Stream CSV chunks', at: minsAgo(8), fileCount: 1, incoming: true, webUrl: 'https://dev.azure.com/org/billing/commit/x' }],
        more: 0,
      }],
    },
  }));
  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const url = new URL(route.request().url());
    const [, sha = ''] = (url.pathname.split('/commits/')[1] ?? '').split('/').map(decodeURIComponent);
    if (url.pathname.endsWith('/diff')) return route.fulfill({ json: { diff: '', fileContent: '', originalContent: '' } });
    const found = DETAILS.find((entry) => entry.sha.startsWith(sha) || sha.startsWith(entry.sha)) ?? DETAILS[0]!;
    return route.fulfill({ json: found });
  });
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'no writes expected' } });
  });
});

test.afterEach(() => {
  expect(writes, 'unexpected write route').toEqual([]);
});

const reviewRegion = (page: Page) => page.getByRole('region', { name: 'Review', exact: true });
const commitCard = (page: Page, sha: string) => page.locator('#board-area .react-flow__node-commit', { hasText: sha.slice(0, 7) });

async function stepIntoCommits(page: Page, options: { goto?: boolean } = {}) {
  if (options.goto !== false) await page.goto('/#/workspaces/demo/board');
  await page.locator('#board-overview button.board-area', { hasText: 'Reports export to CSV' }).click();
  const area = page.locator('#board-area');
  await expect(area).toBeVisible();
  const fold = area.locator('button[data-row-control^="lane:commits"]').first();
  if (await fold.getAttribute('aria-expanded') === 'false') await fold.click();
  await expect(commitCard(page, SHA_1)).toBeVisible();
}

/** How far down the window the top of the Notes is. Pressed from a marker or a line it is brought up; opened by the card it stays where the page puts it. */
const notesTop = async (target: ReturnType<Page['locator']>) => (await target.boundingBox())!.y;

const inView = async (page: Page, target: ReturnType<Page['locator']>) => {
  const box = await target.boundingBox();
  const view = page.viewportSize()!;
  return Boolean(box && box.y >= 0 && box.y + Math.min(box.height, 40) <= view.height && box.x >= 0 && box.x + box.width <= view.width + 1);
};

test('a commit card with notes shows "2 notes" as its own button that opens Review on the notes; a card without notes is as before', async ({ page }) => {
  // Short enough that the Notes are below the fold unless the press brings them into view
  await page.setViewportSize({ width: 1440, height: 560 });
  await stepIntoCommits(page);

  const card = commitCard(page, SHA_1);
  const marker = card.getByTestId('commit-note-marker');
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveText('2 notes');
  // The latest note's title is its title; it is a button of its own, never inside another button
  await expect(marker).toHaveAttribute('title', 'Tests still red');
  expect(await marker.evaluate((el) => el.tagName)).toBe('BUTTON');
  await expect(marker.locator('xpath=ancestor::button')).toHaveCount(0);
  // In CSS pixels: the Board's own zoom makes the drawn size a little smaller
  expect(await marker.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(24);
  expect(await marker.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  // It sits in the meta line, which still holds the sha, who and when
  await expect(card).toContainText(SHA_1.slice(0, 7));
  await expect(card).toContainText('Ada Lovelace');

  // Cards without notes carry nothing of it
  for (const sha of [SHA_2, SHA_3]) {
    await expect(commitCard(page, sha)).toBeVisible();
    await expect(commitCard(page, sha).getByTestId('commit-note-marker')).toHaveCount(0);
    await expect(commitCard(page, sha)).not.toContainText(/\bnotes?\b/);
  }

  await marker.click();
  const win = reviewRegion(page);
  await expect(win).toBeVisible();
  await expect(win.getByRole('heading', { level: 2, name: 'feat: merge the export branches' })).toBeVisible();
  const notes = win.getByTestId('commit-notes');
  await expect(notes).toBeVisible();
  // The description is 70 lines, so the Notes only come into view because the press asked for them
  await expect.poll(() => inView(page, notes)).toBe(true);
  await expect.poll(() => notesTop(notes)).toBeLessThan(300);
  // The press of the marker is not the press of the card: the card's own press still opens the commit without scrolling to notes
  await win.getByRole('button', { name: 'Back to the Board' }).click();
  await expect(win).toBeHidden();
  // The keyboard returns to the marker that was pressed, not to the card's subject button
  await expect(commitCard(page, SHA_1).getByTestId('commit-note-marker')).toBeFocused();
  await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
  await expect(reviewRegion(page).getByTestId('commit-notes')).toBeVisible();
  expect(await notesTop(reviewRegion(page).getByTestId('commit-notes'))).toBeGreaterThan(380);
});

test('the Review list marks a commit that has notes with its count, as text, and only that commit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stepIntoCommits(page);
  await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
  const win = reviewRegion(page);
  const tree = win.getByRole('tree', { name: 'Commits' });
  const items = tree.locator('[data-testid="commit-tree-item"]');
  const first = items.filter({ hasText: SHA_1.slice(0, 7) });
  const mark = first.getByTestId('commit-item-notes');
  await expect(mark).toHaveText('2 notes');
  // Text, not a control: the item is the control
  await expect(mark.locator('xpath=ancestor-or-self::button')).toHaveCount(0);
  expect(await mark.evaluate((el) => el.querySelectorAll('button, a, [role="button"]').length)).toBe(0);
  expect(await mark.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  await expect(items.filter({ hasText: SHA_2.slice(0, 7) }).getByTestId('commit-item-notes')).toHaveCount(0);
  await expect(items.filter({ hasText: SHA_3.slice(0, 7) }).getByTestId('commit-item-notes')).toHaveCount(0);
  // The mark sits after the sha and age
  const text = (await first.innerText()).replace(/\s+/g, ' ');
  expect(text.indexOf(SHA_1.slice(0, 7))).toBeLessThan(text.indexOf('2 notes'));
});

for (const size of [{ width: 1280, height: 800 }, { width: 1100, height: 700 }]) {
  test(`the Notes section lists notes newest first with who and when, plain text and a scrolling long body, at ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await stepIntoCommits(page);
    await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
    const win = reviewRegion(page);
    const notes = win.getByTestId('commit-notes');
    await expect(notes).toBeVisible();
    await expect(notes.getByRole('heading', { name: /Notes/ })).toBeVisible();

    const items = notes.getByTestId('commit-note');
    await expect(items).toHaveCount(2);
    // Newest first: the AI's "Tests still red" (2 min ago), then Claude's older one
    await expect(items.nth(0).getByTestId('commit-note-title')).toHaveText('Tests still red');
    await expect(items.nth(0).getByTestId('commit-note-by')).toHaveText('AI');
    await expect(items.nth(0)).toContainText('2 min ago');
    await expect(items.nth(1).getByTestId('commit-note-title')).toHaveText('Merge kept both sides');
    await expect(items.nth(1).getByTestId('commit-note-by')).toHaveText('Claude');
    await expect(items.nth(1)).toContainText('30 min ago');
    expect(await items.nth(1).getByTestId('commit-note-title').evaluate((el) => Number(getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600);

    // Plain text: what an AI wrote is never read as HTML or Markdown, and line breaks are kept
    const body = items.nth(1).getByTestId('commit-note-body');
    await expect(body).toContainText('<b>raw</b> and **stars** and <script>window.__injected = 1</script>.');
    expect(await body.evaluate((el) => el.querySelectorAll('b, strong, script, em, a').length)).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();
    expect(await body.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
    expect(await body.innerText()).toContain('The conflict in boardRows.ts kept both lists.\nNot bold');
    // The title is not said twice
    expect((await body.innerText()).startsWith('Merge kept both sides')).toBe(false);

    // A long body scrolls inside the section: no "More", and the section does not grow past the window
    await expect(notes.getByRole('button', { name: /more/i })).toHaveCount(0);
    const list = notes.getByRole('list');
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const listBox = (await list.boundingBox())!;
    expect(listBox.height).toBeLessThan(size.height * 0.5);
    const winBox = (await win.boundingBox())!;
    expect(listBox.x).toBeGreaterThanOrEqual(winBox.x);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(winBox.x + winBox.width + 1);
    await expect(notes.getByText('Long note line 60')).toBeAttached();
  });
}

test('a note on a commit that others pushed (not in your copy yet) shows the same way, in the list and in the commit view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stepIntoCommits(page);
  await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
  const win = reviewRegion(page);
  const tree = win.getByRole('tree', { name: 'Commits' });
  const incoming = tree.getByTestId('commit-tree-item').filter({ hasText: 'Stream CSV chunks' });
  await expect(incoming.getByTestId('commit-item-notes')).toHaveText('1 note');
  await incoming.click();
  await expect(win.getByTestId('commit-pushed')).toContainText('not in your copy yet');
  const notes = win.getByTestId('commit-notes');
  await expect(notes.getByTestId('commit-note')).toHaveCount(1);
  await expect(notes.getByTestId('commit-note-title')).toHaveText('Check the retry before merging');
  await expect(notes.getByTestId('commit-note-body')).toHaveText('It has no backoff yet.');
  await expect(notes.getByTestId('commit-note-by')).toHaveText('Claude');
});

test('a note on a commit that is no longer anywhere breaks nothing: not in the list, nothing in the way', async ({ page }) => {
  boardPayload = boardWith([NOTE_OLD, commitNote(13, 'abcdef0123456789abcdef0123456789abcdef01', { title: 'Rebased away', body: 'Rebased away' })]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await stepIntoCommits(page);
  await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
  const win = reviewRegion(page);
  await expect(win.getByTestId('commit-notes').getByTestId('commit-note')).toHaveCount(1);
  await expect(win.getByRole('tree', { name: 'Commits' })).not.toContainText('Rebased away');
  await expect(win.getByRole('tree', { name: 'Commits' })).not.toContainText('abcdef0');
  await expect(win.getByTestId('commit-item-notes')).toHaveCount(1);
});

test('What\'s new: the Notes line opens Review on that commit with the Notes in view, and Back closes Review', async ({ page }) => {
  newsPayload = whatsNew({
    empty: false,
    notes: {
      items: [{ id: NOTE_NEW.id as string, repo: 'billing', sha: SHA_1, shortSha: SHA_1.slice(0, 7), title: 'Tests still red', body: LONG_NOTE, by: 'ai', at: minsAgo(2) }],
      more: 0,
    },
  });
  await page.setViewportSize({ width: 1440, height: 560 });
  await page.goto('/#/workspaces/demo/board');
  const news = page.getByTestId('board-now-news');
  await expect(news).toBeVisible();
  await news.click();
  const line = page.getByTestId('board-news-list').getByRole('button', { name: /AI note on 1111111 \(billing\): Tests still red/ });
  await line.click();
  const win = reviewRegion(page);
  await expect(win).toBeVisible();
  await expect(win.getByRole('heading', { level: 2, name: 'feat: merge the export branches' })).toBeVisible();
  const notes = win.getByTestId('commit-notes');
  await expect(notes).toBeVisible();
  await expect.poll(() => inView(page, notes)).toBe(true);
  await expect.poll(() => notesTop(notes)).toBeLessThan(300);
  await win.getByRole('button', { name: 'Back to the Board' }).click();
  await expect(win).toBeHidden();
  await expect(page.getByTestId('board-now-news')).toBeVisible();
});

test('a note the AI adds while Review is open on that commit appears there live, without resetting the open commit, scroll or focus', async ({ page }) => {
  const feed = await holdFeed(page);
  boardPayload = boardWith([NOTE_OLD]);
  await page.setViewportSize({ width: 1280, height: 560 });
  await stepIntoCommits(page);
  await expect.poll(() => feed.open()).toBe(1);
  await feed.connect();
  await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
  const win = reviewRegion(page);
  await expect(win.getByTestId('commit-note')).toHaveCount(1);

  // Scroll the description and put the keyboard on the list's item
  const overview = win.getByTestId('commit-header').locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]');
  await overview.evaluate((el) => { el.scrollTop = 120; });
  const item = win.getByTestId('commit-tree-item').filter({ hasText: SHA_1.slice(0, 7) });
  await item.focus();
  await expect(item).toBeFocused();
  const scrollBefore = await overview.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(50);

  boardPayload = boardWith([NOTE_OLD, NOTE_NEW]);
  await feed.boardChanged(2);
  await expect(win.getByTestId('commit-note')).toHaveCount(2);
  await expect(win.getByTestId('commit-note').nth(0).getByTestId('commit-note-title')).toHaveText('Tests still red');
  // Nothing was reset: the same commit is open, the scroll is where it was, and the keyboard is where it was
  await expect(win.getByRole('heading', { level: 2, name: 'feat: merge the export branches' })).toBeVisible();
  expect(await overview.evaluate((el) => el.scrollTop)).toBe(scrollBefore);
  await expect(item).toBeFocused();
  await expect(item.getByTestId('commit-item-notes')).toHaveText('2 notes');

  // A commit with no notes yet gets its first one the same way
  await win.getByTestId('commit-tree-item').filter({ hasText: SHA_2.slice(0, 7) }).click();
  await expect(win.getByRole('heading', { level: 2, name: 'refactor: tidy diff header' })).toBeVisible();
  await expect(win.getByTestId('commit-notes')).toHaveCount(0);
  const second = win.getByTestId('commit-tree-item').filter({ hasText: SHA_2.slice(0, 7) });
  await second.focus();
  boardPayload = boardWith([NOTE_OLD, NOTE_NEW, commitNote(14, SHA_2, { title: 'Needs a second look', body: 'Needs a second look\nThe header test is flaky.', at: minsAgo(0), updatedAt: minsAgo(0) })]);
  await feed.boardChanged(3);
  await expect(win.getByTestId('commit-notes').getByTestId('commit-note-title')).toHaveText('Needs a second look');
  await expect(win.getByRole('heading', { level: 2, name: 'refactor: tidy diff header' })).toBeVisible();
  await expect(second).toBeFocused();
});

test('there is no way to write a note from the app: nothing to add, edit or delete', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stepIntoCommits(page);
  await commitCard(page, SHA_1).getByTestId('commit-note-marker').click();
  const notes = reviewRegion(page).getByTestId('commit-notes');
  await expect(notes).toBeVisible();
  await expect(notes.getByRole('button')).toHaveCount(0);
  await expect(notes.getByRole('textbox')).toHaveCount(0);
});

for (const size of [{ width: 1280, height: 800 }, { width: 420, height: 800 }]) {
  test(`Back from the marker puts the keyboard on the marker, at ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await stepIntoCommits(page);
    const marker = commitCard(page, SHA_1).getByTestId('commit-note-marker');
    await marker.focus();
    await page.keyboard.press('Enter');
    const win = reviewRegion(page);
    await expect(win.getByTestId('commit-notes')).toBeVisible();
    await win.getByRole('button', { name: /^Back to the/ }).click();
    await expect(win).toBeHidden();
    await expect(marker).toBeFocused();
  });
}

const newsWithNote = () => whatsNew({
  empty: false,
  notes: {
    items: [{ id: NOTE_NEW.id as string, repo: 'billing', sha: SHA_1, shortSha: SHA_1.slice(0, 7), title: 'Tests still red', body: LONG_NOTE, by: 'ai', at: minsAgo(2) }],
    more: 0,
  },
});

async function pressNewsLine(page: Page) {
  await page.getByTestId('board-now-news').click();
  await page.getByTestId('board-news-list').getByRole('button', { name: /AI note on 1111111 \(billing\): Tests still red/ }).click();
}

test('open by the card, Back, then the Notes line: the Notes are still brought into view', async ({ page }) => {
  newsPayload = newsWithNote();
  await page.setViewportSize({ width: 1280, height: 560 });
  await stepIntoCommits(page);
  await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
  const win = reviewRegion(page);
  await expect(win.getByTestId('commit-notes')).toBeVisible();
  await win.getByRole('button', { name: /^Back to the/ }).click();
  await expect(win).toBeHidden();
  await pressNewsLine(page);
  await expect(win).toBeVisible();
  await expect(win.getByTestId('commit-notes')).toBeVisible();
  await expect.poll(() => notesTop(win.getByTestId('commit-notes'))).toBeLessThan(300);
  // and it stays there once the read of the commit has settled
  await page.waitForTimeout(500);
  expect(await notesTop(win.getByTestId('commit-notes'))).toBeLessThan(300);
});

test('the Notes line, Back, then the marker: the Notes are still brought into view', async ({ page }) => {
  newsPayload = newsWithNote();
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto('/#/workspaces/demo/board');
  await pressNewsLine(page);
  const win = reviewRegion(page);
  await expect(win.getByTestId('commit-notes')).toBeVisible();
  await win.getByRole('button', { name: /^Back to the/ }).click();
  await expect(win).toBeHidden();
  await stepIntoCommits(page, { goto: false });
  await commitCard(page, SHA_1).getByTestId('commit-note-marker').click();
  await expect(win.getByTestId('commit-notes')).toBeVisible();
  await expect.poll(() => notesTop(win.getByTestId('commit-notes'))).toBeLessThan(300);
  await page.waitForTimeout(500);
  expect(await notesTop(win.getByTestId('commit-notes'))).toBeLessThan(300);
});

test('the notes heading says the count once, titles and bodies lay out by their own direction, and the list is a keyboard stop only when it scrolls', async ({ page }) => {
  boardPayload = boardWith([NOTE_OLD]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await stepIntoCommits(page);
  await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
  const notes = reviewRegion(page).getByTestId('commit-notes');
  await expect(notes).toBeVisible();
  await expect(notes.getByRole('heading')).toHaveText(/^Notes\s*·\s*1$/);
  await expect(notes.getByTestId('commit-note-title')).toHaveAttribute('dir', 'auto');
  await expect(notes.getByTestId('commit-note-body')).toHaveAttribute('dir', 'auto');
  // One short note fits: no tab stop
  await expect(notes.getByRole('list')).not.toHaveAttribute('tabindex', /.*/);
});

test('a long note list scrolls and is then a keyboard stop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stepIntoCommits(page);
  await commitCard(page, SHA_1).getByRole('button', { name: /^Open feat: merge/ }).click();
  await expect(reviewRegion(page).getByTestId('commit-notes').getByRole('list')).toHaveAttribute('tabindex', '0');
});
