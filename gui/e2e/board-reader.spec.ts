import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  boardFile,
  boardFileCard,
  boardId,
  boardNote,
  } from "./planData";
import {
  workspace,
  minutesAgo,
  document,
  routeWork,
  routeBoard,
  routeCards,
  routeLateCommits,
  workspaceNav,
  board,
  stepIntoArea,
  canvasPosition,
  transformOf,
  isWithin,
  viewAtRest,
  reveal,
  revealAll,
  frames,
} from "./boardHelpers";

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

test.describe('Board, reader', () => {
  // A large window: these specs put several cards, and often a document and a commit too, on screen at once, which a laptop-sized
  // canvas shows as folded rows and "+N more" (specs for that are under "Board, rows by step").
  test.use({ viewport: { width: 1800, height: 1200 } });

  const MODIFIED = '2026-10-22T00:00:00.000Z';
  /** The workspace folder, so a link can name a file by its full path. */
  const ROOT = workspace.workspacePath;
  const REQUIREMENTS = 'contextspace-document-1.md';
  const markdown = (content: string) => ({ kind: 'markdown', content });
  const FILES: Record<string, { kind: string; content?: string }> = {
    'docs/design.md': markdown('# The queue design\n\nLarge exports run in a background job.'),
    'docs/spec.md': markdown('# The CSV spec\n\nOne row per line.'),
    'overview.html': { kind: 'html', content: '<!doctype html><html><body><h1>The overview page</h1><script>window.unsafe = true</script></body></html>' },
    /** A page made for 1280 px, as a designer or an AI would write it: its width is in its own style. */
    'wide.html': { kind: 'html', content: '<!doctype html><html><head><style>body { margin: 0; } .page { width: 1280px; height: 240px; background: linear-gradient(90deg, #fde68a, #93c5fd); }</style></head><body><div class="page"><h1>A page made for 1280 px</h1></div></body></html>' },
    /** A page that gets its styling from a script on the internet, which the viewer says it runs. */
    'styled.html': { kind: 'html', content: '<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body><h1>The styled page</h1></body></html>' },
    'wide.svg': { kind: 'image' },
  };

  /** What the work route reads source documents as, by id: the text kept for them. */
  const SOURCES: Record<string, string> = {
    'export-requirements': '# Customers export reports\n\nUp to 50,000 rows as CSV.\n\nSee [the design](docs/design.md).',
  };

  const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
  const readerTitle = (page: Page, name: string) => reader(page).getByRole('heading', { name, level: 2, exact: true });
  const card = (page: Page, title: string) => board(page).getByRole('article', { name: title, exact: true });
  const opener = (page: Page, title: string) => card(page, title).getByRole('button', { name: `Open ${title}`, exact: true });
  /** The reader's header has two buttons: the menu of what can be done with what is open, and Close. The menu is drawn outside the reader (in a portal), so its items are found on the page. */
  const moreButton = (page: Page) => reader(page).getByRole('button', { name: 'More actions', exact: true });
  const closeButton = (page: Page) => reader(page).getByRole('button', { name: 'Close', exact: true });
  const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });
  async function openMenu(page: Page) {
    await moreButton(page).click();
    await expect(page.getByRole('menu')).toBeVisible();
  }
  async function chooseFromMenu(page: Page, name: string) {
    await openMenu(page);
    await menuItem(page, name).click();
  }
  /** The switch for scripts, the raw text button and the warning about scripts are gone: nothing of them is on the page. */
  async function expectNoScriptWords(page: Page) {
    for (const text of ['Stop scripts', 'Run scripts', 'Raw text', 'Rendered view', 'runs scripts', 'Scripts are stopped']) await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  }
  /** Whether the menu has an item, looked at with the menu open and left as it was. */
  async function expectMenuItem(page: Page, name: string, shown: boolean) {
    await openMenu(page);
    await expect(menuItem(page, name)).toHaveCount(shown ? 1 : 0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  }

  const FIT_INJECT = `<script>(function(){var frame=0,seen=new WeakSet(),watcher=window.ResizeObserver?new ResizeObserver(later):null;function watch(el){if(watcher&&!seen.has(el)){seen.add(el);watcher.observe(el)}}function fit(){var body=document.body,root=document.documentElement;if(!body)return;watch(root);watch(body);for(var i=0;i<body.children.length&&i<40;i++)watch(body.children[i]);body.style.zoom='';var room=root.clientWidth,wide=Math.max(root.scrollWidth,body.scrollWidth);if(room>0&&wide>room+1)body.style.zoom=String(Math.max(0.5,room/wide))}function later(){cancelAnimationFrame(frame);frame=requestAnimationFrame(fit)}addEventListener('resize',later);addEventListener('load',later,true);document.addEventListener('DOMContentLoaded',later);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(later);[150,600,1800].forEach(function(ms){setTimeout(later,ms)});addEventListener('keydown',function(event){if(event.key==='Escape'&&!event.defaultPrevented)parent.postMessage('contextspace:escape','*')})})()</script>`;

  /** The documents panel's preview request, answered from FILES; the names that were asked for are kept. */
  async function routeFiles(page: Page) {
    const asked: string[] = [];
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
      const name = new URL(route.request().url()).searchParams.get('name') ?? '';
      asked.push(name);
      const file = FILES[name];
      return file ? route.fulfill({ json: { name, size: 120, modifiedAt: MODIFIED, ...file } }) : route.fulfill({ status: 404, json: { error: 'No such document.' } });
    });
    await page.route('**/api/workspace/demo/documents/view-link', async (route) => {
      const postData = JSON.parse(route.request().postData() || '{}');
      const name = postData.name ?? '';
      asked.push(name);
      const file = FILES[name];
      if (!file) return route.fulfill({ status: 404, json: { error: 'No such file.' } });
      const token = 'mocktoken-' + encodeURIComponent(name);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token, url: `/view/${token}/${name}`, scope: '' }),
      });
    });
    await page.route('**/view/mocktoken-*/**', async (route) => {
      const url = new URL(route.request().url());
      const match = url.pathname.match(/^\/view\/mocktoken-([^/]+)\/(.+)$/);
      const name = match ? decodeURIComponent(match[2]) : '';
      const file = FILES[name];
      if (!file) return route.fulfill({ status: 404, body: 'Not found' });
      let html = file.content || '<!doctype html><html><body></body></html>';
      if (html.includes('<head>')) html = html.replace('<head>', `<head>${FIT_INJECT}`);
      else if (html.includes('<html>')) html = html.replace('<html>', `<html><head>${FIT_INJECT}</head>`);
      else html = `${FIT_INJECT}${html}`;
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=UTF-8',
        headers: {
          'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        },
        body: html,
      });
    });
    await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: Object.entries(FILES).map(([name, file]) => ({ name, kind: file.kind, size: 120, modifiedAt: MODIFIED })) } }));
    return asked;
  }
  /**
   * The work route that reads a source document through the storage port, answered from SOURCES; the ids that were asked for are kept.
   * A source document is not read from the folder by the preview request, which is for the files of the workspace.
   */
  async function routeSources(page: Page) {
    const read: string[] = [];
    await page.route('**/api/workspace/demo/work/documents/*', (route) => {
      const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
      read.push(id);
      const content = SOURCES[id];
      return content === undefined
        ? route.fulfill({ status: 400, json: { error: 'Source document not found.' } })
        : route.fulfill({ json: { document: document('Export requirements', { filename: REQUIREMENTS }), content, location: `${ROOT}/${REQUIREMENTS}` } });
    });
    return read;
  }
  /** What this browser remembers of how the reader is shown. */
  const LAYOUT_KEY = 'contextspace_board_reader_layout_v1';
  const storedLayout = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY);
  /** The viewer has chosen "Show beside the board", unless this browser has a choice already: the specs of the docked reader. */
  const dockReader = (page: Page) => page.addInitScript((key) => { if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, 'side'); }, LAYOUT_KEY);
  /**
   * The board of the specs: a source document that is kept as a file, and a few cards, one of each kind the reader opens. The reader is
   * docked beside the canvas, as the viewer may choose, except where `layout` is 'default': then nothing is chosen, and it is the large window.
   */
  async function openBoard(page: Page, cards: Array<Record<string, unknown>> = [], positions: Record<string, { x: number; y: number }> = FILE_PLACES, layout: 'side' | 'default' = 'side') {
    await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed'); });
    if (layout === 'side') await dockReader(page);
    await routeBoard(page);
    await routeWork(page, [
      document('Export requirements', { role: 'requirements', filename: REQUIREMENTS, summary: 'Customers export their reports as CSV.' }),
      document('Pricing sheet', { url: 'https://example.com/pricing', summary: 'Kept on the web.' }),
      document('Loose notes', { summary: 'Neither a file nor a link.' }),
    ]);
    await routeCards(page, boardFile({ cards, positions }));
    await routeSources(page);
    const asked = await routeFiles(page);
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/);
    return asked;
  }
  const FILE_CARDS = [
    boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec', description: 'What a row looks like.', at: minutesAgo(10), updatedAt: minutesAgo(10) }),
    boardFileCard(2, 'overview.html', { title: 'Overview page', description: 'Start with the diagram.', at: minutesAgo(11), updatedAt: minutesAgo(11) }),
  ];
  /** Under the checkpoints, in sight when the board opens: the first stands where the reader will not be, the second where it will. */
  const FILE_PLACES = { [boardId(1)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 } };

  test('opens a document card in a reader beside the board, with its content, and the board stays in view', async ({ page }) => {
    const asked = await openBoard(page, FILE_CARDS);
    const sources = await routeSources(page);
    await expect(reader(page)).toHaveCount(0);
    await opener(page, 'Export requirements').click();
    await expect(reader(page)).toBeVisible();
    await expect(readerTitle(page, 'Export requirements')).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
    await expect(reader(page)).toContainText('Up to 50,000 rows as CSV.');
    // A source document is read through the work route, as the rest of the app reads them, and not from the folder by the preview request.
    expect([...new Set(sources)]).toEqual(['export-requirements']);
    expect(asked).toEqual([]);
    await openMenu(page);
    await expect(menuItem(page, 'Download')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // It is on the right, about 45% of the section and not under 360 px; the canvas is still there, on its left.
    const [section, panel, canvas] = await Promise.all([board(page).locator('#board-area').boundingBox(), reader(page).boundingBox(), board(page).locator('#board-area .react-flow').boundingBox()]);
    expect(Math.abs(panel!.width - section!.width * 0.45)).toBeLessThanOrEqual(2);
    expect(panel!.width).toBeGreaterThanOrEqual(360);
    expect(Math.abs(panel!.x + panel!.width - (section!.x + section!.width))).toBeLessThanOrEqual(1);
    expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(panel!.x + 1);
    await expect(board(page).getByRole('article', { name: 'Waits for you' })).toBeVisible();
    // Inside an Area the view is fixed: no zoom controls and no map
    await expect(board(page).locator('#board-area').getByRole('button', { name: 'Zoom in' })).toHaveCount(0);
    await expect(board(page).locator('#board-area .react-flow__minimap')).toHaveCount(0);
  });

  test('opens a file card in the reader, and another card replaces what it shows', async ({ page }) => {
    const asked = await openBoard(page, FILE_CARDS);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
    // A file of the workspace can be downloaded; it is read by the documents panel's preview request.
    await openMenu(page);
    await expect(menuItem(page, 'Download')).toHaveAttribute('href', /name=docs%2Fspec\.md&download=1$/);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    // The second card may be out of sight beside the reader: the keyboard brings it into view.
    await opener(page, 'Overview page').focus();
    await page.keyboard.press('Enter');
    await expect(readerTitle(page, 'Overview page')).toBeVisible();
    await expect(readerTitle(page, 'The CSV spec')).toHaveCount(0);
    await expect(reader(page)).toHaveCount(1);
    expect([...new Set(asked)]).toEqual(['docs/spec.md', 'overview.html']);
  });

  test('shows the text of a file card under the file, where the card cuts it off, with its byline and links that work', async ({ page }) => {
    const description = [...Array.from({ length: 6 }, (_, index) => `Line ${index + 1} of what the file is.`), 'END-OF-TEXT, see [the overview](overview.html).'].join('\n');
    await openBoard(page, [boardFileCard(5, 'docs/spec.md', { title: 'Spec with notes', description })]);
    const card = board(page).getByRole('article', { name: 'Spec with notes' });
    // The card shows the start of it, and has no Read all: the end is read in the reader
    await expect(card.getByRole('button', { name: /Read all/ })).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'the overview' })).toHaveAttribute('tabindex', '-1');
    await opener(page, 'Spec with notes').click();
    const note = reader(page).locator('footer');
    // Closed it is one quiet row; More opens the cut end
    expect((await note.boundingBox())!.height).toBeLessThanOrEqual(36);
    await expect(note.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
    await note.getByRole('button', { name: 'More' }).click();
    await expect(note.getByRole('button', { name: 'Less' })).toBeVisible();
    await expect(note).toContainText('END-OF-TEXT');
    await expect(note).toContainText(/^[\s\S]*by claude/);
    const link = note.getByRole('link', { name: 'the overview' });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(readerTitle(page, 'overview.html')).toBeVisible();
    // The page opened by the link is not the card's: no text of it under the page
    await expect(reader(page).locator('footer')).toHaveCount(0);
  });

  test('keeps the reader footer one line: no hidden link by Tab, the start after Less, code and tables clamped, a wide note in a narrow pane', async ({ page }) => {
    const long = ['First words of the note, then more.', ...Array.from({ length: 8 }, (_, index) => `Filler ${index + 1} with [a link ${index + 1}](overview.html).`), 'END-OF-TEXT'].join('\n');
    const closedHeight = async () => (await reader(page).locator('footer').boundingBox())!.height;
    await openBoard(page, [
      boardFileCard(5, 'docs/spec.md', { title: 'Spec with notes', description: long, at: '2026-01-03T10:00:00.000Z', updatedAt: '2026-01-03T10:00:00.000Z' }),
      boardFileCard(6, 'docs/code.md', { title: 'Code first', at: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z', description: '```\nconst first = 1;\nconst second = 2;\n```\nafter the code' }),
      boardFileCard(7, 'docs/table.md', { title: 'Table first', at: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z', description: '| A | B |\n| - | - |\n| one | two |\n| three | four |\n\nafter the table' }),
    ]);
    await opener(page, 'Spec with notes').click();
    const note = reader(page).locator('footer');
    await expect(note.getByRole('button', { name: 'More' })).toBeVisible();
    // Closed, Tab never lands on a link in the hidden part
    await expect(note.getByRole('link')).toHaveCount(8);
    expect(await note.getByRole('link').evaluateAll((els) => els.map((el) => (el as HTMLElement).tabIndex))).toEqual(Array(8).fill(-1));
    await readerTitle(page, 'Spec with notes').focus();
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('footer') !== null && document.activeElement?.tagName === 'A'), 'Tab reached a hidden link').toBe(false);
    }
    // More, scroll to the end, Less: the first words show again
    await note.getByRole('button', { name: 'More' }).click();
    // Open, every link of the note is reachable by Tab
    await readerTitle(page, 'Spec with notes').focus();
    const reached = new Set<string>();
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      const text = await page.evaluate(() => (document.activeElement?.closest('footer') && document.activeElement?.tagName === 'A' ? document.activeElement.textContent : null));
      if (text) reached.add(text);
    }
    expect(reached.size).toBe(8);
    await note.locator('#board-reader-note').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await note.getByRole('button', { name: 'Less' }).click();
    expect(await note.locator('#board-reader-note').evaluate((el) => el.scrollTop)).toBe(0);
    await expect(note.locator('#board-reader-note')).toContainText('First words');
    // A code block or a table first is still one closed line, and More shows the rest
    for (const [title, rest] of [['Code first', 'after the code'], ['Table first', 'after the table']] as const) {
      await page.keyboard.press('Escape');
      await opener(page, title).click();
      expect(await closedHeight()).toBeLessThanOrEqual(36);
      await expect(reader(page).locator('footer').getByRole('button', { name: 'More' })).toBeVisible();
      await reader(page).locator('footer').getByRole('button', { name: 'More' }).click();
      await expect(reader(page).locator('footer').getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
      const restBox = reader(page).locator('footer').getByText(rest);
      await expect(restBox).toBeVisible();
      await expect(restBox).toBeInViewport({ ratio: 1 });
    }
    // In a narrow pane the note keeps most of the reader's width
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 480, height: 900 });
    await opener(page, 'Spec with notes').click();
    const widths = await reader(page).evaluate((el) => ({ reader: el.getBoundingClientRect().width, note: el.querySelector('#board-reader-note')!.getBoundingClientRect().width }));
    expect(widths.note).toBeGreaterThanOrEqual(widths.reader * 0.6);
    // Opened, the second row (Less and the byline) is whole inside the reader, and Less closes the note
    const footer = reader(page).locator('footer');
    await footer.getByRole('button', { name: 'More' }).click();
    const inside = async (locator: Locator) => {
      const [box, area] = [(await locator.boundingBox())!, (await reader(page).boundingBox())!];
      expect(box.y).toBeGreaterThanOrEqual(area.y - 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height + 0.5);
    };
    await inside(footer.getByRole('button', { name: 'Less' }));
    await inside(footer.getByText(/^by claude/));
    await footer.getByRole('button', { name: 'Less' }).click();
    await expect(footer.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('lets the keyboard reach the links of a note that fits on one line', async ({ page }) => {
    await openBoard(page, [boardFileCard(5, 'docs/spec.md', { title: 'Short note', description: 'See [the overview](overview.html).' })]);
    await opener(page, 'Short note').click();
    const footer = reader(page).locator('footer');
    await expect(footer.getByRole('button', { name: 'More' })).toHaveCount(0);
    const link = footer.getByRole('link', { name: 'the overview' });
    await expect(link).not.toHaveAttribute('tabindex', '-1');
    await readerTitle(page, 'Short note').focus();
    for (let step = 0; step < 40 && !(await link.evaluate((el) => el === document.activeElement)); step += 1) await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(readerTitle(page, 'overview.html')).toBeVisible();
  });

  test('keeps a page\'s HTML out of the board: it is drawn in the sandboxed frame', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await opener(page, 'Overview page').click();
    const frame = reader(page).locator('iframe[title="Preview of overview.html"]');
    await expect(frame).toBeVisible();
    // Its scripts run by default, and the frame never shares the app's origin.
    await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
    await expect(page.frameLocator('iframe[title="Preview of overview.html"]').getByRole('heading', { name: 'The overview page' })).toBeVisible();
    // Neither the page's text nor its script is in the board's own page.
    await expect(board(page).getByText('The overview page')).toHaveCount(0);
    expect(await page.evaluate(() => 'unsafe' in window)).toBe(false);
  });

  test('marks the card that is open in the reader, and only that one', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await expect(board(page).locator('[aria-current="true"]')).toHaveCount(0);
    await opener(page, 'The CSV spec').click();
    await expect(card(page, 'The CSV spec')).toHaveAttribute('aria-current', 'true');
    await expect(card(page, 'The CSV spec')).toHaveClass(/ring-2/);
    await opener(page, 'Overview page').focus();
    await page.keyboard.press('Enter');
    await expect(card(page, 'Overview page')).toHaveAttribute('aria-current', 'true');
    await expect(card(page, 'The CSV spec')).not.toHaveAttribute('aria-current', /.*/);
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await expect(board(page).locator('[aria-current="true"]')).toHaveCount(0);
  });

  test('opens a document that is a link on the web, and leaves one that is neither a file nor a link alone', async ({ page }) => {
    await openBoard(page);
    const link = card(page, 'Pricing sheet').getByRole('link', { name: 'Open Pricing sheet (opens outside the app)' });
    await expect(link).toHaveAttribute('href', 'https://example.com/pricing');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(card(page, 'Loose notes').getByRole('button')).toHaveCount(0);
    await expect(card(page, 'Loose notes').getByRole('link')).toHaveCount(0);
    await expect(card(page, 'Export requirements').getByRole('button', { name: 'Open Export requirements' })).toBeVisible();
  });

  test('takes the keyboard in when it opens, and gives it back to the card\'s button when Escape or Close closes it', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    const button = opener(page, 'The CSV spec');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(readerTitle(page, 'The CSV spec')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(button).toBeFocused();
    // The mouse opens it, and Close closes it.
    await button.click();
    await expect(reader(page)).toBeVisible();
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await expect(reader(page)).toHaveCount(0);
    await expect(button).toBeFocused();
    // Escape works from the board too, and from a button of the reader.
    await button.click();
    await board(page).locator('#board-area .react-flow').focus();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await button.click();
    await moreButton(page).focus();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('leaves Escape to a dialog that is open over the board', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    await openBoard(page, [FILE_CARDS[0], boardNote(3, { title: 'A long note', body })], { [boardId(1)]: FILE_PLACES[boardId(1)], [boardId(3)]: { x: 1100, y: 240 } });
    await opener(page, 'The CSV spec').click();
    await board(page).getByRole('button', { name: 'Read A long note' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
  });

  test('respects 3-layer Escape precedence: Read all dialog -> BoardReader -> Stepped-in Area -> Level 0 Board', async ({ page }) => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long note.`).join('\n');
    await openBoard(page, [FILE_CARDS[0], boardNote(3, { title: 'A long note', body })], { [boardId(1)]: FILE_PLACES[boardId(1)], [boardId(3)]: { x: 1100, y: 240 } });

    // 1. Area is stepped in
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();

    // 2. Open BoardReader
    await opener(page, 'The CSV spec').click();
    await expect(reader(page)).toBeVisible();

    // 3. Open Read all dialog over everything
    await board(page).getByRole('button', { name: 'Read A long note' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'A long note' });
    await expect(dialog).toBeVisible();

    // Layer 1: First Escape closes the dialog only
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();

    // Layer 2: Second Escape closes BoardReader only
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();

    // Layer 3: Third Escape steps out of the Area to Level 0 Overview
    await page.keyboard.press('Escape');
    await expect(board(page).getByRole('button', { name: 'Board ›' })).toHaveCount(0);
    await expect(board(page).locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
  });

  test('goes to the Docs tab with "Open in Docs", with the file open there, from the large window', async ({ page }) => {
    const asked = await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
    await opener(page, 'Overview page').click();
    await expect(readerTitle(page, 'Overview page')).toBeVisible();
    await chooseFromMenu(page, 'Open in Docs');
    await expect(page).toHaveURL(/#\/workspaces\/demo\/documents$/);
    await expect(page.getByTitle('Preview of overview.html').first()).toBeVisible();
    expect(asked).toContain('overview.html');
  });

  test('says why a file could not be read, and reads it again on request', async ({ page }) => {
    await openBoard(page, [boardFileCard(3, 'docs/gone.md', { title: 'A file that is gone' })], { [boardId(3)]: { x: 800, y: 240 } });
    let there = false;
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => (there
      ? route.fulfill({ json: { name: 'docs/gone.md', size: 12, modifiedAt: MODIFIED, ...markdown('# Back again') } })
      : route.fulfill({ status: 404, json: { error: 'No such document.' } })));
    await opener(page, 'A file that is gone').click();
    await expect(reader(page).getByRole('alert')).toContainText('No such document.');
    there = true;
    await reader(page).getByRole('button', { name: 'Retry preview' }).click();
    await expect(reader(page).getByRole('heading', { name: 'Back again', level: 1 })).toBeVisible();
    await expect(reader(page).getByRole('alert')).toHaveCount(0);
  });

  test('follows a link in the document to another file of the workspace, in the same reader', async ({ page }) => {
    const asked = await openBoard(page);
    await opener(page, 'Export requirements').click();
    await reader(page).getByRole('link', { name: 'the design' }).click();
    await expect(readerTitle(page, 'design.md')).toBeVisible();
    // The source document came from the work route; the file it links to is a plain file of the workspace.
    expect([...new Set(asked)]).toEqual(['docs/design.md']);
    await expect(reader(page).getByRole('heading', { name: 'The queue design', level: 1 })).toBeVisible();
    // The file followed is not a card: the card the trail began from stays marked (and only it); Escape steps back to it, and a second one closes with the keyboard on it.
    await expect(board(page).locator('[aria-current="true"]')).toHaveCount(1);
    await expect(board(page).locator('[aria-current="true"]')).toContainText('Export requirements');
    await page.keyboard.press('Escape');
    await expect(readerTitle(page, 'Export requirements')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(opener(page, 'Export requirements')).toBeFocused();
  });

  test('covers the canvas where the section is too narrow for both, and has a Close that gives it back', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 });
    await openBoard(page, FILE_CARDS);
    // On a small screen the row is too narrow for both cards: the second is behind "+N more"; the card comes first, newest first.
    const button = opener(page, 'The CSV spec');
    await reveal(page, card(page, 'The CSV spec'));
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    const [body, panel] = await Promise.all([board(page).locator('#board-area .react-flow').boundingBox(), reader(page).boundingBox()]);
    expect(Math.abs(panel!.width - body!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel!.x - body!.x)).toBeLessThanOrEqual(1);
    // The canvas waits under it, out of the keyboard's reach.
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await expect(reader(page)).toHaveCount(0);
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(card(page, 'The CSV spec')).toBeInViewport();
  });

  test('keeps the view fixed when the reader docks: the rows are laid out again for the canvas it leaves, and the opened card stays whole beside it', async ({ page }) => {
    await openBoard(page, [boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec' })], {});
    const view = await transformOf(page);
    expect(view.scale).toBeCloseTo(0.9, 5);
    const flow = board(page).locator('#board-area .react-flow');
    const wide = (await flow.boundingBox())!;
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    const free = (await reader(page).boundingBox())!;
    await expect.poll(async () => { const box = (await card(page, 'The CSV spec').boundingBox())!; return box.x + box.width <= free.x; }).toBe(true);
    await expect.poll(async () => (await flow.boundingBox())!.width).toBeLessThan(wide.width);
    await viewAtRest(page);
    expect(await transformOf(page)).toEqual(view);
    await expect.poll(() => isWithin(card(page, 'The CSV spec'), flow)).toBe(true);
    // Closing gives the canvas back, and the view is where it was
    await reader(page).getByRole('button', { name: 'Close' }).click();
    await viewAtRest(page);
    expect(await transformOf(page)).toEqual(view);
  });

  test('is not the user taking the view: it still follows a part that arrives after the reader opened and closed', async ({ page }) => {
    const release = await routeLateCommits(page);
    await dockReader(page);
    await routeCards(page, boardFile({ cards: [FILE_CARDS[0]], positions: { [boardId(1)]: { x: 800, y: 240 } } }));
    await routeFiles(page);
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, /Reports export to CSV/, { allowLoading: true });
    const canvas = board(page);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    await expect.poll(() => isWithin(card(page, 'The CSV spec'), canvas.locator('#board-area .react-flow'))).toBe(true);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(canvas.getByRole('status').filter({ hasText: 'Still loading' })).toContainText('Still loading: commits');
    release();
    await expect(canvas.getByRole('article', { name: 'a91f2e0' })).toBeAttached();
    await expect.poll(() => isWithin(canvas.getByRole('article', { name: 'a91f2e0' }), canvas.locator('#board-area .react-flow'))).toBe(true);
  });

  test('cannot be panned by a drag on the empty canvas, so a link in the reader opening another file leaves the view where it is', async ({ page }) => {
    await openBoard(page);
    await opener(page, 'Export requirements').click();
    await expect(reader(page).getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
    const before = await transformOf(page);
    const area = (await board(page).locator('#board-area .react-flow').boundingBox())!;
    await page.mouse.move(area.x + 60, area.y + area.height - 30);
    await page.mouse.down();
    await page.mouse.move(area.x + 60, area.y - 20, { steps: 8 });
    await page.mouse.up();
    await page.mouse.wheel(0, 300);
    await viewAtRest(page);
    expect(await transformOf(page)).toEqual(before);
    await reader(page).getByRole('link', { name: 'the design' }).click();
    await expect(readerTitle(page, 'design.md')).toBeVisible();
    await frames(page, 12);
    expect(await transformOf(page)).toEqual(before);
  });

  test('moves the keyboard to the reader when the window narrows until it covers the canvas, and Escape still closes it', async ({ page }) => {
    await openBoard(page, [FILE_CARDS[0]!]);
    const button = opener(page, 'The CSV spec');
    await reveal(page, card(page, 'The CSV spec'));
    await button.click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    // The keyboard is on the card again (the reader took it when it opened).
    await button.focus();
    await expect(button).toBeFocused();
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
    // The canvas is out of reach under the reader: the card that had the keyboard cannot keep it.
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
    await expect(readerTitle(page, 'The CSV spec')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('leaves the keyboard where it is when the canvas comes to be covered while it is outside the board', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    // The sidebar's field goes when the window narrows; the workspace header stays.
    const field = page.getByRole('button', { name: /^Copy branch name/ });
    await field.focus();
    await expect(field).toBeFocused();
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
    await frames(page, 30);
    await expect(field).toBeFocused();
    await expect(readerTitle(page, 'The CSV spec')).not.toBeFocused();
  });

  test('does not take the keyboard from the reader when the canvas comes to be covered while it is on one of its buttons', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await opener(page, 'The CSV spec').click();
    const docs = moreButton(page);
    await docs.focus();
    await page.setViewportSize({ width: 820, height: 900 });
    await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
    await expect(docs).toBeFocused();
  });

  test('closes with Escape when the keyboard has dropped to the page itself', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    const button = opener(page, 'The CSV spec');
    await reveal(page, card(page, 'The CSV spec'));
    await button.click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator('body')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
  });

  test('does not close the reader behind another section when Escape is pressed there', async ({ page }) => {
    await openBoard(page, FILE_CARDS);
    await opener(page, 'The CSV spec').click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
    await workspaceNav(page).getByRole('link', { name: 'Plan' }).click();
    await expect(board(page)).toBeHidden();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    // The board stays mounted behind the other sections, with its reader as it was.
    await workspaceNav(page).getByRole('link', { name: 'Board' }).click();
    await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
  });

  test.describe('in a large window', () => {
    /** The dimmed board the window stands on: it fills the Board section, under the window. */
    const behind = (page: Page) => reader(page).locator('xpath=..');
    /** The documents panel's file request, answered with a picture that is wider than any window. */
    async function routeWidePicture(page: Page) {
      await page.route('**/api/workspace/demo/documents/file**', (route) => route.fulfill({
        contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="900"><rect width="2400" height="900" fill="#93c5fd"/></svg>',
      }));
    }
    /** The frame of an HTML page in the reader: its document, which the board cannot measure but the browser's tools can. */
    async function pageFrame(page: Page, name: string) {
      const frame = await reader(page).locator(`iframe[title="Preview of ${name}"]`).elementHandle();
      return (await frame!.contentFrame())!;
    }
    const fit = (frame: Awaited<ReturnType<typeof pageFrame>>) => frame.evaluate(() => ({
      width: document.documentElement.scrollWidth, room: document.documentElement.clientWidth, zoom: Number(document.body.style.zoom || 1),
    }));

    test('opens a file in a large window over the board: about 92% by 88% of the section, centred, with the board dimmed but in sight all round it', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await expect(reader(page)).toHaveCount(0);
      const view = await transformOf(page);
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      await expect(moreButton(page)).toBeVisible();
      const [area, win, canvas] = await Promise.all([behind(page).boundingBox(), reader(page).boundingBox(), board(page).locator('#board-area .react-flow').boundingBox()]);
      expect(Math.abs(win!.width / area!.width - 0.92)).toBeLessThan(0.005);
      expect(Math.abs(win!.height / area!.height - 0.88)).toBeLessThan(0.005);
      // Centred, and the dimmed board shows on every side of it.
      expect(Math.abs((win!.x - area!.x) - (area!.x + area!.width - win!.x - win!.width))).toBeLessThanOrEqual(1);
      expect(Math.abs((win!.y - area!.y) - (area!.y + area!.height - win!.y - win!.height))).toBeLessThanOrEqual(1);
      expect(win!.x - canvas!.x).toBeGreaterThan(40);
      expect(win!.y - canvas!.y).toBeGreaterThan(20);
      expect(canvas!.x + canvas!.width - (win!.x + win!.width)).toBeGreaterThan(40);
      expect(canvas!.y + canvas!.height - (win!.y + win!.height)).toBeGreaterThan(20);
      // The board is still drawn under the dimming, where it was: the view did not move, and the card that was opened is marked.
      await expect(board(page).getByRole('article', { name: 'Waits for you' })).toBeVisible();
      await expect(card(page, 'The CSV spec')).toHaveAttribute('aria-current', 'true');
      expect(await transformOf(page)).toEqual(view);
      // A press beside the window lands on the dimmed board and not on the canvas under it, which waits out of the keyboard's reach.
      expect(await behind(page).evaluate((element, spot) => document.elementFromPoint(spot.x, spot.y) === element, { x: area!.x + 8, y: area!.y + 8 })).toBe(true);
      await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
      await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    });

    test('opens a source document in the large window too, and a link in a note', async ({ page }) => {
      await openBoard(page, [boardNote(1, { title: 'Links', body: 'See [the spec](docs/spec.md).' })], { [boardId(1)]: { x: 800, y: 240 } }, 'default');
      await board(page).getByRole('article', { name: 'Links' }).getByRole('link', { name: 'the spec' }).click();
      await expect(readerTitle(page, 'spec.md')).toBeFocused();
      await expect(behind(page)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(board(page).getByRole('article', { name: 'Links' }).getByRole('link', { name: 'the spec' })).toBeFocused();
      await opener(page, 'Export requirements').click();
      await expect(reader(page).getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
      expect(Math.abs((await reader(page).boundingBox())!.width / (await behind(page).boundingBox())!.width - 0.92)).toBeLessThan(0.005);
    });

    test('closes with Escape, with Close and with a click on the board behind it, and gives the keyboard back to the card', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'The CSV spec');
      // Escape.
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(readerTitle(page, 'The CSV spec')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
      await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
      // Close.
      await button.click();
      await expect(closeButton(page)).toBeVisible();
      await closeButton(page).click();
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
      // A click on the dimmed board behind the window, which is beside it and not in it.
      await button.click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const area = (await behind(page).boundingBox())!;
      await page.mouse.click(area.x + 10, area.y + 10);
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
      // Escape from a button of the window works as well.
      await button.click();
      await moreButton(page).focus();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('stays open for a press or a drag in the window, even one that ends on the board behind it', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await opener(page, 'The CSV spec').click();
      const heading = reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 });
      await heading.click();
      await expect(reader(page)).toBeVisible();
      // Selecting text from inside the window out to the board behind it is not a click on the board.
      const [text, area] = await Promise.all([heading.boundingBox(), behind(page).boundingBox()]);
      await page.mouse.move(text!.x + 4, text!.y + text!.height / 2);
      await page.mouse.down();
      await page.mouse.move(area!.x + 6, area!.y + 6, { steps: 6 });
      await page.mouse.up();
      await frames(page);
      await expect(reader(page)).toBeVisible();
    });

    test('stays open for a press that begins on the board behind the window and ends in it', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const [area, text] = await Promise.all([behind(page).boundingBox(), reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 }).boundingBox()]);
      await page.mouse.move(area!.x + 8, area!.y + 8);
      await page.mouse.down();
      await page.mouse.move(text!.x + 10, text!.y + text!.height / 2, { steps: 6 });
      await page.mouse.up();
      await frames(page);
      await expect(reader(page)).toBeVisible();
      // And a press and a release that are both on the board close it, as before (the text the first drag selected is let go of, or a press on it starts dragging it).
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.mouse.move(area!.x + 8, area!.y + 8);
      await page.mouse.down();
      await page.mouse.move(area!.x + 14, area!.y + area!.height - 8, { steps: 4 });
      await page.mouse.up();
      await expect(reader(page)).toHaveCount(0);
    });

    test('closes with Escape pressed in the HTML page itself, and gives the keyboard back to the card', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'Overview page');
      await button.click();
      const inside = page.frameLocator('iframe[title="Preview of overview.html"]');
      await expect(inside.getByRole('heading', { name: 'The overview page' })).toBeVisible();
      // The keyboard is in the page, where a key never reaches the board.
      await inside.getByRole('heading', { name: 'The overview page' }).click();
      await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toBeFocused();
      // Another window, or the board's own page, saying the same words is not Escape.
      await page.evaluate(() => window.postMessage('contextspace:escape', '*'));
      await frames(page, 6);
      await expect(reader(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('takes the whole height of the window for a page, which scrolls by itself: nothing scrolls twice', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await openBoard(page, [boardFileCard(3, 'wide.html', { title: 'Wide page' }), FILE_CARDS[0]], { [boardId(3)]: { x: 800, y: 240 }, [boardId(1)]: { x: 1100, y: 240 } }, 'default');
      await opener(page, 'Wide page').click();
      const frame = reader(page).locator('iframe[title="Preview of wide.html"]');
      await expect(frame).toBeVisible();
      const holder = frame.locator('xpath=..');
      // The body of the window does not scroll, and the frame fills what is left of it, inside the body's padding.
      await expect.poll(async () => {
        const [inner, shown] = await Promise.all([holder.evaluate((element) => ({ top: element.getBoundingClientRect().top, height: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY })), frame.boundingBox()]);
        return inner.overflow === 'hidden' && inner.scroll <= inner.height && Math.abs(shown!.height - inner.height) <= 2;
      }).toBe(true);
      // A frame that fills it is taller than the share of the screen it had before.
      expect((await frame.boundingBox())!.height).toBeGreaterThan(700);
      // A document that is not a page still scrolls in the body.
      await closeButton(page).click();
      await opener(page, 'The CSV spec').click();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      expect(await reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 }).evaluate((element) => {
        let holder = element.parentElement;
        while (holder && getComputedStyle(holder).overflowY !== 'auto') holder = holder.parentElement;
        return Boolean(holder);
      })).toBe(true);
    });

    test('docks beside the board with "Show beside the board", comes back with "Show large", and remembers the choice after a reload', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      expect(await storedLayout(page)).toBeNull();
      await opener(page, 'The CSV spec').click();
      await expectMenuItem(page, 'Show large', false);
      await chooseFromMenu(page, 'Show beside the board');
      // Beside the canvas, as before: about 45% of the section on its right, the canvas free again, and Close where it was.
      await expectMenuItem(page, 'Show large', true);
      await expect(reader(page).getByRole('button', { name: 'Close', exact: true })).toBeVisible();
      await expect(board(page).locator('#board-area [inert]')).toHaveCount(0);
      const [section, panel] = await Promise.all([board(page).locator('#board-area').boundingBox(), reader(page).boundingBox()]);
      expect(Math.abs(panel!.width - section!.width * 0.45)).toBeLessThanOrEqual(2);
      expect(Math.abs(panel!.x + panel!.width - (section!.x + section!.width))).toBeLessThanOrEqual(1);
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      expect(await storedLayout(page)).toBe('side');
      // Kept for the next visit.
      await page.reload();
      await stepIntoArea(page, /Reports export to CSV/);
      await opener(page, 'The CSV spec').click();
      await expectMenuItem(page, 'Show large', true);
      expect(Math.abs((await reader(page).boundingBox())!.width - (await board(page).locator('#board-area').boundingBox())!.width * 0.45)).toBeLessThanOrEqual(2);
      // And back to the window, kept the same way.
      await chooseFromMenu(page, 'Show large');
      await expectMenuItem(page, 'Show beside the board', true);
      await expect(closeButton(page)).toBeVisible();
      await expect(board(page).locator('#board-area [inert]')).toHaveCount(1);
      expect(await storedLayout(page)).toBe('large');
      await page.reload();
      await stepIntoArea(page, /Reports export to CSV/);
      await opener(page, 'The CSV spec').click();
      await expect(closeButton(page)).toBeVisible();
    });

    test('keeps what is open, and where the keyboard is, when it changes between the window and the dock', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'The CSV spec');
      await button.click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      await chooseFromMenu(page, 'Show beside the board');
      await expect(moreButton(page)).toBeFocused();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      await chooseFromMenu(page, 'Show large');
      await expect(moreButton(page)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('lays the rows out again for the canvas the dock leaves, without moving the view', async ({ page }) => {
      await openBoard(page, [boardFileCard(1, 'docs/spec.md', { title: 'The CSV spec' })], {}, 'default');
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const view = await transformOf(page);
      await chooseFromMenu(page, 'Show beside the board');
      const free = (await reader(page).boundingBox())!;
      await expect.poll(async () => { const box = (await card(page, 'The CSV spec').boundingBox())!; return box.x + box.width <= free.x; }).toBe(true);
      await viewAtRest(page);
      expect(await transformOf(page)).toEqual(view);
    });

    test('offers no dock where the section is too narrow for both, and the window still fits', async ({ page }) => {
      await page.setViewportSize({ width: 820, height: 900 });
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'The CSV spec');
      await reveal(page, card(page, 'The CSV spec'));
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(readerTitle(page, 'The CSV spec')).toBeFocused();
      await expectMenuItem(page, 'Show beside the board', false);
      await expect(closeButton(page)).toBeVisible();
      expect(Math.abs((await reader(page).boundingBox())!.width / (await behind(page).boundingBox())!.width - 0.92)).toBeLessThan(0.005);
      await closeButton(page).click();
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('fits an HTML page that is wider than the window to its width, and again when the window changes size', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openBoard(page, [boardFileCard(3, 'wide.html', { title: 'Wide page' })], { [boardId(3)]: { x: 800, y: 240 } }, 'default');
      await opener(page, 'Wide page').click();
      const frameBox = reader(page).locator('iframe[title="Preview of wide.html"]');
      await expect(frameBox).toBeVisible();
      const frame = await pageFrame(page, 'wide.html');
      // The page is 1280 px wide and the window is not: it is scaled down to fit and not scrolled sideways.
      expect((await frameBox.boundingBox())!.width).toBeLessThan(1280);
      await expect.poll(async () => { const now = await fit(frame); return now.width <= now.room && now.zoom < 1; }).toBe(true);
      const first = await fit(frame);
      expect(first.zoom).toBeGreaterThan(0.4);
      // Nothing in the window scrolls sideways either.
      expect(await reader(page).evaluate((element) => Array.from(element.querySelectorAll<HTMLElement>('*'))
        .filter((node) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowX)).every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
      // A narrower window scales it further.
      await page.setViewportSize({ width: 1150, height: 900 });
      await expect.poll(async () => { const now = await fit(frame); return now.width <= now.room && now.zoom < first.zoom; }).toBe(true);
      // Never smaller than half: a page that is more than twice the window's width is scaled to half and left to scroll.
      await page.setViewportSize({ width: 700, height: 900 });
      await expect.poll(async () => (await frameBox.boundingBox())!.width).toBeLessThan(640);
      await expect.poll(async () => { const now = await fit(frame); return now.zoom === 0.5 && now.width > now.room; }).toBe(true);
      // One that is wider than the page leaves it as it was made.
      await page.setViewportSize({ width: 2000, height: 900 });
      await expect.poll(async () => { const now = await fit(frame); return now.zoom === 1 && now.width <= now.room; }).toBe(true);
    });

    test('leaves a page that fits as it is', async ({ page }) => {
      await openBoard(page, [FILE_CARDS[1]], { [boardId(2)]: { x: 1100, y: 240 } }, 'default');
      await opener(page, 'Overview page').click();
      await expect(page.frameLocator('iframe[title="Preview of overview.html"]').getByRole('heading', { name: 'The overview page' })).toBeVisible();
      await frames(page, 8);
      expect((await fit(await pageFrame(page, 'overview.html'))).zoom).toBe(1);
    });

    test('fits a picture to the window', async ({ page }) => {
      await routeWidePicture(page);
      await openBoard(page, [boardFileCard(3, 'wide.svg', { title: 'Wide picture' })], { [boardId(3)]: { x: 800, y: 240 } }, 'default');
      await opener(page, 'Wide picture').click();
      const picture = reader(page).getByRole('img', { name: 'wide.svg' });
      await expect(picture).toBeVisible();
      await expect.poll(async () => (await picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth))).toBe(2400);
      const [win, shown] = await Promise.all([reader(page).boundingBox(), picture.boundingBox()]);
      expect(shown!.width).toBeLessThan(2400);
      expect(shown!.x).toBeGreaterThanOrEqual(win!.x);
      expect(shown!.x + shown!.width).toBeLessThanOrEqual(win!.x + win!.width);
      expect(await picture.evaluate((image) => {
        let holder = image.parentElement;
        while (holder && !['auto', 'scroll'].includes(getComputedStyle(holder).overflowX)) holder = holder.parentElement;
        return holder ? holder.scrollWidth <= holder.clientWidth : true;
      })).toBe(true);
    });

    test('runs the scripts of an HTML page, in a frame apart from the app, with no switch and no warning about it', async ({ page }) => {
      await openBoard(page, [boardFileCard(3, 'styled.html', { title: 'Styled page' }), FILE_CARDS[1]], { [boardId(3)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 } }, 'default');
      await opener(page, 'Styled page').click();
      const frame = reader(page).locator('iframe[title="Preview of styled.html"]');
      await expect(frame).toBeVisible();
      // The script of the internet is in the page, and the frame is still an opaque origin.
      await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
      await expect(frame).toHaveAttribute('src', /\/view\//);
      await expect(page.frameLocator('iframe[title="Preview of styled.html"]').getByRole('heading', { name: 'The styled page' })).toBeVisible();
      await expectNoScriptWords(page);
      await openMenu(page);
      for (const name of ['Stop scripts', 'Run scripts']) await expect(menuItem(page, name)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await closeButton(page).click();
      await opener(page, 'Overview page').click();
      await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toHaveAttribute('sandbox', /allow-scripts/);
      await expectNoScriptWords(page);
    });

    test('has one quiet header line: the title and its path, a menu and Close, and nothing else to press', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const header = reader(page).locator('header');
      await expect(header.getByRole('button', { name: 'More actions' })).toBeVisible();
      await expect(header.getByRole('button', { name: 'Close' })).toBeVisible();
      await expect(header.getByRole('button', { name: /Full screen/ })).toBeVisible();
      await expect(header.getByRole('button')).toHaveCount(5);
      await expect(header.getByRole('link')).toHaveCount(0);
      await expect(header).toContainText('docs/spec.md');
      // Nothing of the viewer's own row is left in the window: no path row, no second pair of buttons.
      for (const name of ['Back to board', 'Open in Docs', 'Large', 'Side by side', 'Expand document', 'Download', 'Copy path', 'Raw text']) await expect(reader(page).getByRole('button', { name, exact: false })).toHaveCount(0);
      await expect(reader(page).getByRole('link', { name: 'Download' })).toHaveCount(0);
      expect((await header.boundingBox())!.height).toBeLessThanOrEqual(52);
    });

    test('has a menu that works by keyboard, and Escape closes only the menu', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      const button = opener(page, 'Overview page');
      await button.click();
      await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toBeVisible();
      await moreButton(page).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      const names = async () => (await page.getByRole('menuitem').allTextContents()).map((name) => name.trim());
      expect(await names()).toEqual(['Show beside the board', 'Open in Docs', 'Open in browser', 'View source', 'Copy path', 'Download']);
      await expect(menuItem(page, 'Open in browser')).toHaveAttribute('href', /\/view\//);
      await expect(menuItem(page, 'Open in browser')).toHaveAttribute('target', '_blank');
      await expect(menuItem(page, 'Open in browser')).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(menuItem(page, 'Download')).toHaveAttribute('href', /\/view\/.*download=1/);
      // The arrows move through it, and Escape closes the menu only: the reader stays, and the keyboard is back on the menu button.
      await expect(menuItem(page, 'Show beside the board')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menuItem(page, 'Open in Docs')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      await expect(menuItem(page, 'Open in Docs')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(reader(page)).toBeVisible();
      await expect(moreButton(page)).toBeFocused();
      // View source, by keyboard, and back to the page.
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'View source' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toHaveCount(0);
      await expect(reader(page).locator('pre')).toContainText('<h1>');
      await page.keyboard.press('Enter');
      await expect(menuItem(page, 'View source')).toHaveCount(0);
      await page.getByRole('menuitem', { name: 'View page' }).focus();
      await page.keyboard.press('Enter');
      await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toBeVisible();
      // Show beside the board, and Show large, by keyboard; the choice is kept.
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Show beside the board' }).focus();
      await page.keyboard.press('Enter');
      expect(await storedLayout(page)).toBe('side');
      await expectMenuItem(page, 'Show large', true);
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Show large' }).focus();
      await page.keyboard.press('Enter');
      expect(await storedLayout(page)).toBe('large');
      // Escape with no menu closes the reader.
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(button).toBeFocused();
    });

    test('opens the menu with Space on the More actions button', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await opener(page, 'Overview page').click();
      await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toBeVisible();
      await moreButton(page).focus();
      await page.keyboard.press('Space');
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(page.getByRole('menu').getByRole('separator')).toHaveCount(1);
    });

    test('offers View source for a Markdown file, and not for a picture; Copy path copies the path; Download is a download of the file', async ({ page }) => {
      await page.addInitScript(() => {
        (window as unknown as { copied: string[] }).copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { (window as unknown as { copied: string[] }).copied.push(text); return Promise.resolve(); } } });
      });
      await routeWidePicture(page);
      await openBoard(page, [FILE_CARDS[0], boardFileCard(3, 'wide.svg', { title: 'Wide picture' })], { [boardId(1)]: { x: 800, y: 240 }, [boardId(3)]: { x: 1100, y: 240 } }, 'default');
      await opener(page, 'The CSV spec').click();
      await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
      await chooseFromMenu(page, 'View source');
      await expect(reader(page).locator('pre')).toContainText('# The CSV spec');
      await chooseFromMenu(page, 'Copy path');
      await expect.poll(() => page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual(['docs/spec.md']);
      await expect(reader(page).getByRole('status')).toHaveText('Path copied');
      await expect(moreButton(page).locator('svg.lucide-check')).toBeVisible();
      await expect(moreButton(page).locator('svg.lucide-check')).toHaveCount(0, { timeout: 5000 });
      await openMenu(page);
      const download = menuItem(page, 'Download');
      await expect(download).toHaveAttribute('href', /name=docs%2Fspec\.md&download=1$/);
      await expect(download).toHaveAttribute('download', 'spec.md');
      await page.keyboard.press('Escape');
      await closeButton(page).click();
      await opener(page, 'Wide picture').click();
      await expect(reader(page).getByRole('img', { name: 'wide.svg' })).toBeVisible();
      await openMenu(page);
      await expect(menuItem(page, 'View source')).toHaveCount(0);
      await expect(menuItem(page, 'Open in new window')).toHaveCount(0);
      await expect(menuItem(page, 'Download')).toHaveAttribute('href', /name=wide\.svg&download=1$/);
      await page.keyboard.press('Escape');
    });

    test('closes with one press outside the window, on the dimmed board, the Board index or the Area header, and the keyboard goes back to the card', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'open'); });
      await page.reload();
      await stepIntoArea(page, /Reports export to CSV/);
      const button = opener(page, 'The CSV spec');
      const nav = page.getByRole('navigation', { name: 'Board index' });
      await expect(nav).toBeVisible();
      for (const where of ['dimmed board', 'Board index', 'Area header']) {
        await button.click();
        await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
        if (where === 'dimmed board') {
          const area = (await reader(page).locator('xpath=..').boundingBox())!;
          await page.mouse.click(area.x + 10, area.y + area.height - 10);
        } else {
          const box = (await (where === 'Board index' ? nav : board(page).locator('#board-area > header')).boundingBox())!;
          await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
        }
        await expect(reader(page), where).toHaveCount(0);
        await expect(button, where).toBeFocused();
      }
    });

    test('does not close for a menu that is dismissed by a press outside it, nor for a drag that starts in the window and ends outside it', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'default');
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      await openMenu(page);
      await expect(page.getByRole('menu')).toBeVisible();
      const area = (await reader(page).locator('xpath=..').boundingBox())!;
      await page.mouse.click(area.x + 10, area.y + area.height - 10);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(reader(page)).toBeVisible();
      // A drag from the window out of it.
      const heading = reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 });
      const text = (await heading.boundingBox())!;
      await page.mouse.move(text.x + 4, text.y + text.height / 2);
      await page.mouse.down();
      await page.mouse.move(area.x + 6, area.y + area.height - 6, { steps: 6 });
      await page.mouse.up();
      await frames(page);
      await expect(reader(page)).toBeVisible();
    });

    test('shows no "Stop scripts", "Raw text" or warning anywhere in the reader, for a page, a note or a picture', async ({ page }) => {
      await openBoard(page, [boardFileCard(3, 'styled.html', { title: 'Styled page' }), FILE_CARDS[0]], { [boardId(3)]: { x: 800, y: 240 }, [boardId(1)]: { x: 1100, y: 240 } }, 'default');
      for (const title of ['Styled page', 'The CSV spec']) {
        await opener(page, title).click();
        await expect(readerTitle(page, title)).toBeVisible();
        await expectNoScriptWords(page);
        await closeButton(page).click();
      }
    });
  });

  test.describe('in the dock', () => {
    test('where it covers the canvas (1100x700), a press on the Area header or on the index rail closes it, and the keyboard goes back to the card', async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 700 });
      await openBoard(page, FILE_CARDS, FILE_PLACES, 'side');
      const button = opener(page, 'The CSV spec');
      // The index is the 40 px rail here: a press on the empty part of it, below its toggle.
      const rail = page.getByRole('button', { name: /^Board index/ }).locator('xpath=..');
      for (const where of ['Area header', 'Index rail']) {
        await button.click();
        await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
        expect(await storedLayout(page)).toBe('side');
        await expect(board(page).locator('#board-area [inert]').first()).toBeAttached();
        const box = (await (where === 'Index rail' ? rail : board(page).locator('#board-area > header')).boundingBox())!;
        await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
        await expect(reader(page), where).toHaveCount(0);
        await expect(button, where).toBeFocused();
      }
    });

    test('closes with a press on empty board space, and opens another card with a press on that card', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES);
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      // A press on another card opens that one, and does not close the reader.
      await opener(page, 'Overview page').focus();
      await card(page, 'Overview page').click({ position: { x: 20, y: 12 } });
      await expect(readerTitle(page, 'Overview page')).toBeVisible();
      await expect(reader(page)).toHaveCount(1);
      // A press on empty space of the board closes it, and the keyboard goes back to the card.
      const canvas = (await board(page).locator('#board-area .react-flow').boundingBox())!;
      await page.mouse.click(canvas.x + 6, canvas.y + canvas.height - 6);
      await expect(reader(page)).toHaveCount(0);
      await expect(opener(page, 'Overview page')).toBeFocused();
    });

    // The reader beside the board: what it closes with, what stays marked, and nothing left dim
    const opacityOf = (locator: Locator) => locator.evaluate((el) => Number(getComputedStyle(el.closest('.react-flow__node')!).opacity));
    const dimmed = (page: Page) => page.evaluate(() => ({
      flow: document.querySelectorAll('#board-area .board-flow[data-thread-active]').length,
      selected: document.querySelectorAll('#board-area [data-thread-selected], #board-area [data-reader-open]').length,
      dim: Array.from(document.querySelectorAll('#board-area .react-flow__node-note, #board-area .react-flow__node-file, #board-area .react-flow__node-step')).filter((el) => Number(getComputedStyle(el).opacity) < 0.9).length,
    }));

    test('pressing the open card again closes it, the board is not dimmed while it is open, the open card stays marked, and nothing is left dim or selected', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES);
      for (const how of ['the open card again', 'the Close button', 'Escape', 'empty space']) {
        await card(page, 'The CSV spec').click({ position: { x: 20, y: 12 } });
        await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
        await frames(page, 20);
        // readable: the other card is at full strength, and the open one is marked
        expect(await opacityOf(card(page, 'Overview page')), how).toBe(1);
        expect((await dimmed(page)).dim, how).toBe(0);
        await expect(board(page).locator('#board-area .react-flow__node[data-reader-open="true"]')).toHaveCount(1);
        await expect(board(page).locator('#board-area .react-flow__node[data-reader-open="true"]')).toContainText('The CSV spec');
        if (how === 'the open card again') await card(page, 'The CSV spec').click({ position: { x: 20, y: 12 } });
        else if (how === 'the Close button') await closeButton(page).click();
        else if (how === 'Escape') await page.keyboard.press('Escape');
        else { const canvas = (await board(page).locator('#board-area .react-flow').boundingBox())!; await page.mouse.click(canvas.x + 6, canvas.y + canvas.height - 6); }
        await expect(reader(page), how).toHaveCount(0);
        await frames(page, 20);
        expect(await dimmed(page), how).toEqual({ flow: 0, selected: 0, dim: 0 });
        expect(await opacityOf(card(page, 'Overview page')), how).toBe(1);
        // the same card is in view, and the keyboard is on it
        await expect(card(page, 'The CSV spec'), how).toBeVisible();
        await expect(opener(page, 'The CSV spec'), how).toBeFocused();
      }
    });

    test('a press on a row header closes it and still toggles the row; another card switches it', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES);
      await opener(page, 'The CSV spec').click();
      await expect(readerTitle(page, 'The CSV spec')).toBeVisible();
      const control = board(page).locator('#board-area [data-row-control]:not([data-row-control="row:waiting"])').first();
      const was = await control.getAttribute('aria-expanded');
      await control.click();
      await expect(reader(page)).toHaveCount(0);
      await expect(control).toHaveAttribute('aria-expanded', was === 'true' ? 'false' : 'true');
      await expect(control).toBeFocused();
      expect((await dimmed(page)).dim).toBe(0);
    });

    test('[ moves the reader to the previous card each time, the sidebar does not take it, and Escape then closes the reader', async ({ page }) => {
      await openBoard(page, FILE_CARDS, FILE_PLACES);
      const position = async () => Number((await reader(page).getByLabel(/^Item \d+ of \d+$/).getAttribute('aria-label'))!.match(/Item (\d+)/)![1]);
      await opener(page, 'Export requirements').click();
      await expect(readerTitle(page, 'Export requirements')).toBeVisible();
      await page.keyboard.press(']');
      await expect.poll(position).toBe(2);
      await page.keyboard.press(']');
      await expect.poll(position).toBe(3);
      const start = 3;
      await page.keyboard.press('[');
      await expect.poll(position).toBe(start - 1);
      await page.keyboard.press('[');
      await expect.poll(position).toBe(start - 2);
      // the keyboard did not jump to the sidebar's search, and Escape closes the reader
      await expect(page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first()).not.toBeFocused();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
    });
  });

  test.describe('links in text', () => {
    const NOTES = [
      boardNote(1, { title: 'Links', body: 'Read [the CSV spec](https://example.com/spec) and [the file](docs/spec.md), or [by its full path](' + ROOT + '/docs/spec.md) or [as a file address](file://' + ROOT + '/docs/spec.md).' }),
      boardNote(2, { title: 'Not links', body: '[click me](javascript:alert(1)) [mail me](mailto:me@example.com) [data](data:text/html,hi) [ftp](ftp://example.com/x) [up](../../secret.md) [here](#top) ![chart](https://example.com/chart.png)' }),
      boardFileCard(3, 'docs/design.md', { title: 'The design', description: 'Per [the queue design](https://example.com/queue) and **bold** text.' }),
    ];
    const PLACES = { [boardId(1)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 }, [boardId(3)]: { x: 800, y: 560 } };
    async function openNotes(page: Page) {
      // A new tab is not the page: the context's routes cover it, and nothing reaches the network.
      await page.context().route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Example</title><p>An example page.</p>' }));
      const asked = await openBoard(page, NOTES, PLACES);
      await revealAll(page);
      return asked;
    }

    test('opens an https link in a new tab, safely, without moving the card or the view', async ({ page }) => {
      await openNotes(page);
      const link = card(page, 'Links').getByRole('link', { name: /the CSV spec/ });
      await expect(link).toHaveAttribute('href', 'https://example.com/spec');
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      // A press on it is neither a drag nor a pan.
      await expect(link).toHaveClass(/nodrag/);
      await expect(link).toHaveClass(/nopan/);
      const place = await canvasPosition(page, boardId(1));
      const view = await transformOf(page);
      const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      expect(popup.url()).toBe('https://example.com/spec');
      // The tab was answered by the test's own route: nothing went to the network.
      await expect(popup).toHaveTitle('Example');
      await popup.close();
      expect(await canvasPosition(page, boardId(1))).toEqual(place);
      expect(await transformOf(page)).toEqual(view);
      await expect(reader(page)).toHaveCount(0);
      // The link on a file card's description works the same way.
      await expect(card(page, 'The design').getByRole('link', { name: /the queue design/ })).toHaveAttribute('href', 'https://example.com/queue');
      await expect(card(page, 'The design').locator('strong')).toHaveText('bold');
    });

    test('does not drag the card when a link is pressed and the pointer moves a little', async ({ page }) => {
      await openNotes(page);
      const link = card(page, 'Links').getByRole('link', { name: /the CSV spec/ });
      const place = await canvasPosition(page, boardId(1));
      const box = (await link.boundingBox())!;
      await page.mouse.move(box.x + 4, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 24, box.y + box.height / 2 + 20, { steps: 4 });
      await page.mouse.up();
      await frames(page);
      expect(await canvasPosition(page, boardId(1))).toEqual(place);
    });

    test('opens a link to a file of the workspace in the reader, by a relative path, a full path or a file address', async ({ page }) => {
      const asked = await openNotes(page);
      for (const text of ['the file', 'by its full path', 'as a file address']) {
        await card(page, 'Links').getByRole('link', { name: text }).click();
        await expect(readerTitle(page, 'spec.md')).toBeVisible();
        await expect(reader(page).getByRole('heading', { name: 'The CSV spec', level: 1 })).toBeVisible();
        await reader(page).getByRole('button', { name: 'Close' }).click();
        await expect(reader(page)).toHaveCount(0);
      }
      expect(new Set(asked)).toEqual(new Set(['docs/spec.md']));
      // The keyboard went back to the link that was pressed.
      await expect(card(page, 'Links').getByRole('link', { name: 'as a file address' })).toBeFocused();
    });

    test('opens a link from the keyboard, with Enter', async ({ page }) => {
      await openNotes(page);
      const link = card(page, 'Links').getByRole('link', { name: 'the file' });
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(readerTitle(page, 'spec.md')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(link).toBeFocused();
    });

    test('does not make a link of any other scheme, of a path out of the workspace, or of a picture', async ({ page }) => {
      await openNotes(page);
      const note = card(page, 'Not links');
      await expect(note).toContainText('click me');
      await expect(note).toContainText('mail me');
      await expect(note.getByRole('link')).toHaveCount(0);
      await expect(note.locator('a')).toHaveCount(0);
      await expect(note.locator('img')).toHaveCount(0);
      await expect(note).toContainText('[image: chart]');
      await expect(board(page).locator('a[href^="javascript:" i], a[href^="mailto:" i], a[href^="data:" i], a[href^="ftp:" i], a[href^="#"]')).toHaveCount(0);
      // Pressing the words does nothing.
      await note.getByText('click me').click();
      await expect(reader(page)).toHaveCount(0);
      await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
    });

    test('shows the whole text with working links, and a link to a file gives the dialog\'s place to the reader', async ({ page }) => {
      const long = Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of what was seen.`).join('\n');
      await page.context().route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Example</title>' }));
      await openBoard(page, [boardNote(1, { title: 'A long note', body: `${long}\nThen [the spec](docs/spec.md) and [the web](https://example.com/end).` })], { [boardId(1)]: { x: 800, y: 240 } });
      const readAll = board(page).getByRole('button', { name: 'Read A long note' });
      await readAll.click();
      const dialog = page.getByRole('dialog', { name: 'A long note' });
      await expect(dialog).toContainText('Line 12 of what was seen.');
      const web = dialog.getByRole('link', { name: /the web/ });
      await expect(web).toHaveAttribute('href', 'https://example.com/end');
      await expect(web).toHaveAttribute('target', '_blank');
      await expect(web).toHaveAttribute('rel', 'noopener noreferrer');
      await dialog.getByRole('link', { name: 'the spec' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(readerTitle(page, 'spec.md')).toBeVisible();
      await expect(readerTitle(page, 'spec.md')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(reader(page)).toHaveCount(0);
      await expect(readAll).toBeFocused();
    });

    test('keeps the links of a card whose text is cut off out of the keyboard\'s way, and Read all has them all', async ({ page }) => {
      const body = [...Array.from({ length: 6 }, (_, index) => `Line ${index + 1}.`), 'Last line: [the hidden link](https://example.com/hidden)'].join('\n');
      await openBoard(page, [boardNote(1, { title: 'Cut note', body }), boardNote(2, { title: 'Short note', body: 'One [short link](https://example.com/short).' })], { [boardId(1)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 } });
      const cut = card(page, 'Cut note');
      const readAll = cut.getByRole('button', { name: 'Read Cut note' });
      await expect(readAll).toBeVisible();
      // Some of its links may be where they cannot be seen, so none is a stop; a card that shows all of its text keeps its links as stops.
      await expect(cut.getByRole('link', { name: /the hidden link/ })).toHaveAttribute('tabindex', '-1');
      await expect(card(page, 'Short note').getByRole('link', { name: /short link/ })).not.toHaveAttribute('tabindex', /.*/);
      await readAll.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(cut.getByRole('link', { name: /the hidden link/ })).not.toBeFocused();
      await page.keyboard.press('Tab');
      await expect(readAll).toBeFocused();
      // The whole text is one press away, with every link a stop.
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Cut note' });
      await expect(dialog.getByRole('link', { name: /the hidden link/ })).not.toHaveAttribute('tabindex', /.*/);
    });

    test('keeps the clamp and the Read all button on a note written in Markdown', async ({ page }) => {
      const body = ['# Findings', '', ...Array.from({ length: 10 }, (_, index) => `- point ${index + 1}`)].join('\n');
      await openBoard(page, [boardNote(1, { title: 'Findings', body })], { [boardId(1)]: { x: 800, y: 240 } });
      const note = card(page, 'Findings');
      await expect(note.locator('li').first()).toBeVisible();
      await expect(note.getByRole('button', { name: 'Read Findings' })).toBeVisible();
      // The card shows four lines of text at most: the clamp holds with lists in it.
      const lines = await note.locator('.board-text').evaluate((element) => Math.round(element.clientHeight / 18));
      expect(lines).toBeLessThanOrEqual(4);
      await expect(note.getByRole('heading')).toHaveCount(1);
    });
  });
});
