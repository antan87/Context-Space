import { test, expect, type Page } from './fixtures';
import { board, minutesAgo, node, PICTURE, routeBoard, routeCards, stepIntoArea, viewAtRest, workspace } from './boardHelpers';
import { boardFile, checkpoint, planFile, step, whatsNew } from './planData';

/**
 * The Questions space: each `explain/*.md` answer is an Area of text, code, picture and diagram cards, with each copied code block
 * checked against the real file. Everything is faked here (the backend reads and checks; it never writes), and every write is refused.
 */
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 }, sidebarDocked: false });

type Check = { status: string; start?: number; end?: number; current?: string };
const code = (where: string, copy: string, check: Check, lines = '12-14') => {
  const [start, end] = lines.split('-').map(Number) as [number, number];
  const [repo, ...rest] = where.split('/');
  const inRepo = repo === 'NexusFlow';
  return {
    kind: 'code', language: 'ts', copy, where, start, end, check,
    ...(inRepo ? { repo, repoPath: '/tmp/NexusFlow', file: rest.join('/') } : { file: where }),
  };
};

const SECURITY = {
  path: 'explain/how-do-we-enforce-security.md',
  question: 'How do we enforce security in this project?',
  summary: 'Every request is **checked** before it reaches a handler.',
  modifiedAt: minutesAgo(5),
  parts: [
    { title: 'In short', heading: null, cards: [{ kind: 'text', text: 'Every request is **checked** before it reaches a handler.' }] },
    {
      title: 'Sign-in is checked on every request', heading: 'Sign-in is checked on every request',
      cards: [
        { kind: 'text', text: 'The **middleware** runs first.\n\n- it reads the token\n- it refuses the rest' },
        code('NexusFlow/src/http/auth.ts', 'export function check(req) {\n  return token(req);\n}', { status: 'matches' }),
        code('NexusFlow/src/http/session.ts', 'const SESSION_MS = 60_000;\nconst MAX = 3;', { status: 'moved', start: 52, end: 53 }, '10-11'),
      ],
    },
    {
      title: 'Where secrets live', heading: 'Where secrets live',
      cards: [
        code('NexusFlow/src/core/secrets.ts', 'const KEY = read();\nuse(KEY);', { status: 'changed', current: 'const KEY = readFrom(env);\nuse(KEY);' }, '3-4'),
        code('NexusFlow/src/core/old.ts', 'gone();', { status: 'gone' }, '1-1'),
        code('Billing/src/pay.ts', 'charge(card);', { status: 'not-in-workspace' }, '8-8'),
        { kind: 'code', language: 'bash', copy: 'npm test', check: { status: 'none' } },
      ],
    },
    {
      title: 'What you see', heading: 'What you see',
      cards: [
        { kind: 'picture', alt: 'The sign-in screen', path: '../board-pictures/signin.png', src: 'board-pictures/signin.png' },
        { kind: 'picture', alt: 'A missing picture', path: '../board-pictures/missing.png', src: null },
        { kind: 'diagram', source: 'graph TD\n  A[Request] --> B[Check]\n  B --> C[Handler]' },
      ],
    },
  ],
};

const OTHER = {
  path: 'explain/how-are-releases-made.md',
  question: 'How are releases made?',
  summary: 'With one command.',
  modifiedAt: minutesAgo(90),
  parts: [
    { title: 'In short', heading: null, cards: [{ kind: 'text', text: 'With one command.' }] },
    { title: 'The command', heading: 'The command', cards: [code('NexusFlow/package.json', '"release:ship": "node ship.js"', { status: 'matches' }, '40-40')] },
  ],
};

const SECURITY_MD = [
  '# How do we enforce security in this project?', '', 'Every request is checked before it reaches a handler.', '',
  '## Sign-in is checked on every request', ...Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1} about sign-in.\n`), '',
  '## Where secrets live', ...Array.from({ length: 40 }, (_, i) => `Secret paragraph ${i + 1}.\n`), '',
  '## What you see', 'The pictures.',
].join('\n');

let writes: string[] = [];
let answers: unknown[] = [SECURITY, OTHER];
let reads = 0;
let brokenPicture = false;

const FILES_LISTING = [
  { path: 'explain/how-do-we-enforce-security.md', modifiedAt: minutesAgo(5), size: 900 },
  { path: 'explain/how-are-releases-made.md', modifiedAt: minutesAgo(90), size: 400 },
  { path: 'docs/notes.md', modifiedAt: minutesAgo(200), size: 100 },
];

test.beforeEach(async ({ page }) => {
  writes = []; answers = [SECURITY, OTHER]; reads = 0; brokenPicture = false;
  await routeBoard(page);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/questions', (route) => { reads += 1; return route.fulfill({ json: { answers } }); });
  await page.route('**/api/workspace/demo/files', (route) => route.fulfill({ json: { files: FILES_LISTING, truncated: false, errors: [] } }));
  await page.route('**/api/workspace/demo/documents/file?*', (route) => (brokenPicture
    ? route.fulfill({ status: 404, json: { error: 'no such file' } })
    : route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE })));
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name.endsWith('.png')) return route.fulfill({ json: { name, kind: 'image', modifiedAt: minutesAgo(5), size: 100 } });
    return route.fulfill({ json: { name, kind: 'markdown', modifiedAt: minutesAgo(5), size: SECURITY_MD.length, content: name.includes('security') ? SECURITY_MD : `# ${name}` } });
  });
  // The Code window: one repository holding the files the cards point at
  const file = (name: string) => ({ file: name, type: 'clean', additions: 0, deletions: 0 });
  const listing = [{ repoName: 'NexusFlow', repoPath: '/tmp/NexusFlow', files: ['src/http/auth.ts', 'src/http/session.ts', 'src/core/secrets.ts'].map(file) }];
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: listing } }));
  await page.route('**/api/workspace/demo/changes?include=all', (route) => route.fulfill({ json: { changes: listing } }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/demo/changes/diff?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file') ?? '';
    const text = Array.from({ length: 80 }, (_, i) => `// ${name} line ${i + 1}`).join('\n') + '\n';
    return route.fulfill({ json: { diff: '', fileContent: text, originalContent: text } });
  });
  await page.route('**/api/workspace/demo/repositories', (route) => route.fulfill({ json: { repositories: [{
    name: 'NexusFlow', access: 'isolated', editable: true, path: '/tmp/NexusFlow', sourcePath: '/tmp/NexusFlow', branch: 'feat/x', expectedBranch: 'feat/x', onExpectedBranch: true, baseBranch: 'main',
    headSha: 'abc1234def', dirty: false, changedFiles: [], ahead: 0, behind: 0, remoteUrl: null,
  }] } }));
  await page.route('**/api/workspace/demo/incoming**', (route) => route.fulfill({ json: { at: new Date().toISOString(), repos: [] } }));
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD' || new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    if (route.request().url().endsWith('/documents/view-link')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
  await page.routeWebSocket('**/ws/terminal', () => {});
});
test.afterEach(() => { expect(writes, 'nothing here may write').toEqual([]); });

const SECURITY_AREA = 'question:explain/how-do-we-enforce-security.md';
const readerOf = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
const codeWindow = (page: Page) => page.getByRole('region', { name: 'Review', exact: true });
/** The header button of a row (the "+N more" button of the same row comes after it). */
const rowControl = (page: Page, row: string) => board(page).locator(`#board-area button[data-row-control="${row}"][aria-expanded]`).first();
const nodeIds = (page: Page) => board(page).locator('#board-overview .react-flow__node').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));

async function stepIntoAnswer(page: Page, name: string | RegExp = /How do we enforce security/) {
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, name);
}

test('each answer is an Area of its own, after the plan Areas and before Workspace files, newest first, with its question, first line and counts', async ({ page }) => {
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  const ids = (await nodeIds(page)).filter((id): id is string => Boolean(id));
  const at = (id: string) => ids.indexOf(id);
  expect(at(SECURITY_AREA)).toBeGreaterThan(at('checkpoint:reports-export-to-csv'));
  expect(at('question:explain/how-are-releases-made.md')).toBeGreaterThan(at(SECURITY_AREA));
  expect(at('files:workspace')).toBeGreaterThan(at('question:explain/how-are-releases-made.md'));

  const area = node(page, SECURITY_AREA);
  await expect(area).toBeVisible();
  await expect(area).toContainText('How do we enforce security in this project?');
  // The first line of the short answer, as plain words
  await expect(area).toContainText('Every request is checked before it reaches a handler.');
  await expect(area).not.toContainText('**');
  // The counts, in words, with "changed since" in the warning colour apart from the others
  await expect(area).toContainText('3 parts · 6 code blocks · 2 pictures · Out of date · 2 copies');
  const colour = (locator: ReturnType<Page['locator']>) => locator.evaluate((el) => getComputedStyle(el).color);
  expect(await colour(area.getByText(/Out of date · 2 copies$/))).not.toBe(await colour(area.getByText(/^3 parts/)));
  // On one line: the counts are cut before "changed since" is
  expect(await area.getByText(/Out of date · 2 copies$/).evaluate((el) => (el as HTMLElement).getBoundingClientRect().height)).toBeLessThan(24);
  // The whole card steps into the answer
  await area.locator('button.board-area').click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
  await expect(board(page).locator('#board-area').getByRole('heading', { name: 'How do we enforce security in this project?' })).toBeVisible();
});

test('on the card, the count line is a button of its own for each count: it steps into the answer on the row of the first card counted', async ({ page }) => {
  // Alone on the board the answer is the big card
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew() }));
  answers = [SECURITY];
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  const area = node(page, SECURITY_AREA);
  await expect(area.getByRole('button', { name: 'Show the 3 parts', exact: true })).toBeVisible();
  await expect(area.getByRole('button', { name: 'Show the 6 code blocks', exact: true })).toBeVisible();
  await expect(area.getByRole('button', { name: 'Show the 2 pictures', exact: true })).toBeVisible();
  const changed = area.getByRole('button', { name: 'Show the Out of date · 2 copies', exact: true });
  await expect(changed).toBeVisible();
  const colour = (locator: ReturnType<Page['locator']>) => locator.evaluate((el) => getComputedStyle(el).color);
  expect(await colour(changed)).not.toBe(await colour(area.getByRole('button', { name: 'Show the 3 parts', exact: true })));
  expect(await changed.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(24);
  expect(await changed.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  await changed.click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
  await viewAtRest(page);
  // The row with the changed card is open and shows it
  await expect(rowControl(page, 'row:q:2')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'qcard:explain/how-do-we-enforce-security.md#5')).toContainText('Changed since');
});

test('a workspace with no answers shows no Questions box, and the answers are not listed twice as files', async ({ page }) => {
  answers = [];
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  expect((await nodeIds(page)).filter((id) => id?.startsWith('question:'))).toEqual([]);
  await expect(board(page)).not.toContainText('Questions');

  // With answers, Workspace files holds only what is not an answer
  answers = [SECURITY, OTHER];
  await page.reload();
  await stepIntoArea(page, /Workspace files/);
  await expect(board(page).locator('#board-area')).toContainText('notes.md');
  await expect(board(page).locator('#board-area')).not.toContainText('how-do-we-enforce-security');
  await expect(board(page).locator('#board-area')).not.toContainText('how-are-releases-made');
});

test('stepping into an answer shows "In short" and a row for each part with its cards in order; nothing can be added, dragged or saved', async ({ page }) => {
  await stepIntoAnswer(page);
  const area = board(page).locator('#board-area');
  await expect(area.locator('.react-flow__node-step').filter({ hasText: 'In short' })).toBeVisible();
  const rowTitles = await area.locator('.react-flow__node-step, .react-flow__node-fold').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()));
  expect(rowTitles[0]).toContain('In short');
  expect(rowTitles[1]).toContain('Sign-in is checked on every request');
  expect(rowTitles[2]).toContain('Where secrets live');
  expect(rowTitles[3]).toContain('What you see');

  // The cards of the first parts, in order, by kind
  const kinds = await area.locator('[data-answer-card]').evaluateAll((els) => els.map((el) => `${el.closest('.react-flow__node')?.getAttribute('data-id')}=${el.getAttribute('data-answer-card')}`));
  expect(kinds.slice(0, 4)).toEqual([
    'qcard:explain/how-do-we-enforce-security.md#1=text',
    'qcard:explain/how-do-we-enforce-security.md#2=text',
    'qcard:explain/how-do-we-enforce-security.md#3=code',
    'qcard:explain/how-do-we-enforce-security.md#4=code',
  ]);
  await expect(board(page).getByRole('button', { name: 'Add a step' })).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: 'Add a note' })).toHaveCount(0);
  // A card does not move when it is dragged
  const first = node(page, 'qcard:explain/how-do-we-enforce-security.md#2');
  const before = await first.boundingBox();
  await page.mouse.move(before!.x + 20, before!.y + 20);
  await page.mouse.down();
  await page.mouse.move(before!.x + 160, before!.y + 120, { steps: 6 });
  await page.mouse.up();
  const after = await first.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeLessThan(2);
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  // Text is at least 12 px and each card is its one button
  for (const el of await area.locator('[data-answer-card] [data-card-main]').all()) {
    expect(await el.evaluate((e) => e.tagName)).toBe('BUTTON');
    expect(await el.evaluate((e) => (e as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(24);
  }
  expect(await area.locator('[data-answer-card="code"] pre').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  await expect(area.locator('[data-answer-card] button button')).toHaveCount(0);
});

test('each code card says what the check found, and what to do when the place is not here', async ({ page }) => {
  await stepIntoAnswer(page);
  // Open the row that holds the statuses, so every card is on show
  await rowControl(page, 'row:q:2').click();
  await viewAtRest(page);
  const status = (id: number) => node(page, `qcard:explain/how-do-we-enforce-security.md#${id}`);
  await expect(status(5)).toContainText('NexusFlow/src/core/secrets.ts · 3–4');
  await expect(status(5)).toContainText('Changed since');
  await expect(status(6)).toContainText('File gone');
  await expect(status(7)).toContainText('Not in this workspace');
  await expect(status(7)).toContainText('Add Billing to the workspace to check it');
  // A code card with no place has nothing to check
  await expect(status(8)).toContainText('npm test');
  await expect(status(8).locator('[data-status]')).toHaveCount(0);
  await expect(status(5).locator('pre')).toContainText('const KEY = read();');
  // The earlier row: matches, and a copy that moved follows its new lines
  await rowControl(page, 'row:q:1').click();
  await viewAtRest(page);
  await expect(status(3)).toContainText('Matches');
  await expect(status(4)).toContainText('Moved to 52–53');
  await expect(status(4)).toContainText('NexusFlow/src/http/session.ts · 52–53');
});

test('a text card opens the answer in the reader at its part; Escape gives the keyboard back to the card', async ({ page }) => {
  await stepIntoAnswer(page);
  const card = node(page, 'qcard:explain/how-do-we-enforce-security.md#2');
  // Plain words, no raw marks
  await expect(card).toContainText('The middleware runs first.');
  await expect(card).not.toContainText('**');
  const button = card.getByRole('button', { name: 'Read Sign-in is checked on every request' });
  await button.click();
  await expect(readerOf(page)).toBeVisible();
  await expect(readerOf(page)).toContainText('Paragraph 1 about sign-in.');

  // The part's heading is at the top of what is read
  const heading = readerOf(page).getByRole('heading', { name: 'Sign-in is checked on every request' });
  await expect(heading).toBeVisible();
  const top = async () => {
    const [h, region] = await Promise.all([heading.boundingBox(), readerOf(page).locator('[data-reader-doc], .overflow-auto').first().boundingBox()]);
    return h!.y - region!.y;
  };
  await expect.poll(async () => (await top()) < 260).toBe(true);

  // Another part of the same answer is another place in it
  await page.keyboard.press('Escape');
  await expect(readerOf(page)).toBeHidden();
  await expect(button).toBeFocused();

  const second = node(page, 'qcard:explain/how-do-we-enforce-security.md#1').getByRole('button', { name: /^Read In short/ });
  await second.click();
  await expect(readerOf(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(second).toBeFocused();
});

test('a card that matches opens the real file in the Code window at its first line; a copy that moved opens at its new lines; Escape returns to the card', async ({ page }) => {
  await stepIntoAnswer(page);
  const matches = node(page, 'qcard:explain/how-do-we-enforce-security.md#3').getByRole('button', { name: /^Open NexusFlow\/src\/http\/auth\.ts · 12–14, Matches/ });
  await matches.click();
  await expect(codeWindow(page)).toBeVisible();
  await expect(codeWindow(page).locator('p[title]').first()).toHaveText('src/http/auth.ts:12');
  await page.keyboard.press('Escape');
  await expect(codeWindow(page)).toBeHidden();
  await expect(matches).toBeFocused();

  const moved = node(page, 'qcard:explain/how-do-we-enforce-security.md#4').getByRole('button', { name: /^Open NexusFlow\/src\/http\/session\.ts · 52–53, Moved to 52–53/ });
  await moved.click();
  await expect(codeWindow(page).locator('p[title]').first()).toHaveText('src/http/session.ts:52');
  await page.keyboard.press('Escape');
  await expect(moved).toBeFocused();
});

test('a card that changed since opens both versions, with the lines that differ marked; "Open the file" goes to those lines; focus comes back to the card', async ({ page }) => {
  await stepIntoAnswer(page);
  await rowControl(page, 'row:q:2').click();
  await viewAtRest(page);
  const card = node(page, 'qcard:explain/how-do-we-enforce-security.md#5');
  const button = card.getByRole('button', { name: /^Compare NexusFlow\/src\/core\/secrets\.ts · 3–4, Changed since/ });
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'In the answer' })).toContainText('const KEY = read();');
  await expect(dialog.getByRole('region', { name: 'Now' })).toContainText('const KEY = readFrom(env);');
  await expect(dialog.locator('[data-differs="true"]')).toHaveCount(2);
  // The line that did not change is not marked
  await expect(dialog.getByRole('region', { name: 'Now' }).locator('div', { hasText: 'use(KEY);' }).first()).not.toHaveAttribute('data-differs', 'true');
  // Nothing in the answer card was written over
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();

  await button.click();
  await page.getByTestId('answer-open-file').click();
  await expect(dialog).toBeHidden();
  await expect(codeWindow(page)).toBeVisible();
  await expect(codeWindow(page).locator('p[title]').first()).toHaveText('src/core/secrets.ts:3');
  await page.keyboard.press('Escape');
  await expect(codeWindow(page)).toBeHidden();
  await expect(button).toBeFocused();
});

test('a card for a file that is gone or not in this workspace shows the copy in the reader', async ({ page }) => {
  await stepIntoAnswer(page);
  await rowControl(page, 'row:q:2').click();
  await viewAtRest(page);
  for (const [id, label] of [[6, /^Read NexusFlow\/src\/core\/old\.ts · 1, File gone/], [7, /^Read Billing\/src\/pay\.ts · 8, Not in this workspace/]] as const) {
    const button = node(page, `qcard:explain/how-do-we-enforce-security.md#${id}`).getByRole('button', { name: label });
    await button.click();
    await expect(readerOf(page)).toBeVisible();
    await expect(codeWindow(page)).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
  }
});

test('a picture card shows the picture and opens it; a picture that is missing says so and never shows a broken image', async ({ page }) => {
  await stepIntoAnswer(page);
  await rowControl(page, 'row:q:3').click();
  await viewAtRest(page);
  const picture = node(page, 'qcard:explain/how-do-we-enforce-security.md#9');
  await expect(picture.locator('img')).toBeVisible();
  expect(await picture.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(picture).toContainText('The sign-in screen');
  const open = picture.getByRole('button', { name: 'Open The sign-in screen' });
  await open.click();
  await expect(readerOf(page)).toBeVisible();
  await expect(readerOf(page)).toContainText('board-pictures/signin.png');
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();

  // A picture the answer names that is not there: its path, not a broken image
  const missing = node(page, 'qcard:explain/how-do-we-enforce-security.md#10');
  await expect(missing).toContainText('Picture not found: ../board-pictures/missing.png');
  await expect(missing.locator('img')).toHaveCount(0);

  // One that is there but cannot be loaded says the same
  brokenPicture = true;
  await page.reload();
  await stepIntoArea(page, /How do we enforce security/);
  await rowControl(page, 'row:q:3').click();
  await viewAtRest(page);
  await expect(node(page, 'qcard:explain/how-do-we-enforce-security.md#9')).toContainText('Picture not found: ../board-pictures/signin.png');
  await expect(node(page, 'qcard:explain/how-do-we-enforce-security.md#9').locator('img')).toHaveCount(0);
});

test('a diagram card shows its source as text and opens it in the reader', async ({ page }) => {
  await stepIntoAnswer(page);
  await rowControl(page, 'row:q:3').click();
  await viewAtRest(page);
  const diagram = node(page, 'qcard:explain/how-do-we-enforce-security.md#11');
  await expect(diagram).toContainText('Diagram');
  await expect(diagram.locator('pre')).toContainText('graph TD');
  await diagram.getByRole('button', { name: 'Read the diagram' }).click();
  await expect(readerOf(page)).toBeVisible();
  await expect(readerOf(page).getByRole('heading', { name: 'What you see' })).toBeVisible();
});

test('answers read again on focus: an open reader, the keyboard and an opened row stay as they are while the Area behind changes', async ({ page }) => {
  await stepIntoAnswer(page);
  const control = rowControl(page, 'row:q:3');
  await control.click();
  await viewAtRest(page);
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  const reading = node(page, 'qcard:explain/how-do-we-enforce-security.md#11').getByRole('button', { name: 'Read the diagram' });
  await reading.click();
  await expect(readerOf(page)).toBeVisible();
  await expect(readerOf(page).getByRole('heading', { name: 'What you see' })).toBeVisible();
  const scroller = readerOf(page).locator('.overflow-auto').first();
  await scroller.evaluate((el) => { el.scrollTop += 40; });
  const scrolled = await scroller.evaluate((el) => el.scrollTop);

  // The copy now matches, and a new answer has arrived
  const fixed = JSON.parse(JSON.stringify(SECURITY));
  fixed.parts[2].cards[0].check = { status: 'matches' };
  answers = [{ ...OTHER, path: 'explain/brand-new.md', question: 'A brand new question?', modifiedAt: minutesAgo(0) }, fixed, OTHER];
  const before = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBeGreaterThan(before);
  await page.waitForTimeout(400);
  await expect(readerOf(page)).toBeVisible();
  await expect(readerOf(page).getByRole('heading', { name: 'What you see' })).toBeVisible();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);
  await page.keyboard.press('Escape');
  await expect(readerOf(page)).toBeHidden();
  // The keyboard is back on the card that was read, and the row is as it was left
  await expect(reading).toBeFocused();
  await expect(control).toHaveAttribute('aria-expanded', 'true');
  // The Area behind has caught up: the copy matches now
  await rowControl(page, 'row:q:2').click();
  await viewAtRest(page);
  await expect(node(page, 'qcard:explain/how-do-we-enforce-security.md#5')).toContainText('Matches');
  await expect(node(page, 'qcard:explain/how-do-we-enforce-security.md#5')).not.toContainText('Changed since');
  // And the overview has the new answer first
  await board(page).getByRole('button', { name: 'Board ›' }).click();
  await viewAtRest(page);
  const ids = (await nodeIds(page)).filter((id): id is string => Boolean(id));
  expect(ids.indexOf('question:explain/brand-new.md')).toBeGreaterThan(-1);
  expect(ids.indexOf('question:explain/brand-new.md')).toBeLessThan(ids.indexOf(SECURITY_AREA));
});

test('the Board index lists answers under Questions in both modes, and in the 420 px pane', async ({ page }) => {
  await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'open'); });
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await expect(nav.getByRole('heading', { name: /Questions/ })).toBeVisible();
  await expect(nav.getByRole('heading', { name: /^Areas/ })).toBeVisible();
  const entry = nav.getByRole('button', { name: /How do we enforce security in this project\?/ }).first();
  await expect(entry).toBeVisible();
  await expect(nav).toContainText('3 parts · 6 code blocks · 2 pictures · Out of date · 2 copies');
  // Search finds an answer by its words, and a part's name
  await nav.getByRole('searchbox').or(nav.getByPlaceholder(/search/i)).first().fill('secrets');
  await expect(nav.getByRole('button', { name: /How do we enforce security/ }).first()).toBeVisible();
  await expect(nav).not.toContainText('How are releases made?');
  await nav.getByRole('searchbox').or(nav.getByPlaceholder(/search/i)).first().fill('');

  await nav.getByRole('button', { name: 'Area', exact: true }).click();
  await expect(nav).toContainText('Questions');
  await expect(nav.getByRole('heading', { name: /How are releases made\?/ })).toBeVisible();
  await nav.getByRole('button', { name: 'Step into How are releases made?' }).click();
  await expect(board(page).locator('#board-area').getByRole('heading', { name: 'How are releases made?' })).toBeVisible();
});

test('in the 420 px pane the answers are listed in the drawer and an answer fits without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  await board(page).getByRole('button', { name: /Board index/ }).first().click();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await expect(nav.getByRole('heading', { name: /Questions/ })).toBeVisible();
  await nav.getByRole('button', { name: /How do we enforce security in this project\?/ }).first().click();
  await expect(board(page).locator('#board-area')).toBeVisible();
  await viewAtRest(page);
  const first = node(page, 'qcard:explain/how-do-we-enforce-security.md#1');
  await expect(first).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await first.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(420);
});

test('a refresh that turns "Changed since" into "Matches" keeps the compare view open, with focus inside it; Escape puts focus on the card', async ({ page }) => {
  await stepIntoAnswer(page);
  await rowControl(page, 'row:q:2').click();
  await viewAtRest(page);
  const card = node(page, 'qcard:explain/how-do-we-enforce-security.md#5');
  await card.getByRole('button', { name: /^Compare / }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const fixed = JSON.parse(JSON.stringify(SECURITY));
  fixed.parts[2].cards[0].check = { status: 'matches' };
  answers = [fixed, OTHER];
  const before = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(card.getByRole('button', { name: /Matches/, includeHidden: true })).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('The copy matches the file again');
  await expect(dialog.getByRole('button', { name: 'Open the file' })).toBeVisible();
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(card.getByRole('button', { name: /Matches/ })).toBeFocused();
});

test('"Open the file" from a compare view that a refresh turned into "Matches": closing the Code window gives the keyboard back to the card', async ({ page }) => {
  await stepIntoAnswer(page);
  await rowControl(page, 'row:q:2').click();
  await viewAtRest(page);
  const card = node(page, 'qcard:explain/how-do-we-enforce-security.md#5');
  await card.getByRole('button', { name: /^Compare / }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const fixed = JSON.parse(JSON.stringify(SECURITY));
  fixed.parts[2].cards[0].check = { status: 'matches' };
  answers = [fixed, OTHER];
  const before = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(dialog).toContainText('The copy matches the file again');
  await dialog.getByRole('button', { name: 'Open the file' }).click();
  await expect(codeWindow(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(codeWindow(page)).toBeHidden();
  await expect(card.getByRole('button', { name: /Matches/ })).toBeFocused();
});

test('a refresh that turns the card into "File gone" says so in the open compare view, and offers no file to open', async ({ page }) => {
  await stepIntoAnswer(page);
  await rowControl(page, 'row:q:2').click();
  await viewAtRest(page);
  const card = node(page, 'qcard:explain/how-do-we-enforce-security.md#5');
  await card.getByRole('button', { name: /^Compare / }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (const [status, words] of [['gone', 'The file is gone'], ['unreadable', 'The file can no longer be read'], ['not-in-workspace', 'The file is no longer in this workspace']] as const) {
    const flipped = JSON.parse(JSON.stringify(SECURITY));
    flipped.parts[2].cards[0].check = { status };
    answers = [flipped, OTHER];
    const before = reads;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(dialog).toContainText(words);
    await expect(dialog).not.toContainText('matches');
    await expect(dialog.getByRole('button', { name: 'Open the file' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close' }).first()).toBeVisible();
  }
});

test.describe('in a Split', () => {
  test.use({ viewport: { width: 1100, height: 700 } });
  test('the code of the first part is on show without pressing anything, and a folded part says what its checks found', async ({ page }) => {
    await page.addInitScript(() => { if (window === window.top) localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 })); });
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await expect(page.getByTestId('view-mode-split')).toHaveAttribute('aria-pressed', 'true');
    await stepIntoArea(page, /How do we enforce security/);
    // "In short" is never folded; the parts that do not fit are one line each, with their checks and their own words
    await expect(node(page, 'qcard:explain/how-do-we-enforce-security.md#1')).toBeVisible();
    const area = board(page).locator('#board-area');
    await expect(area).toContainText('4 cards · 1 changed since');
    // "changed since" is in the warning colour on a folded line too, apart from the words around it
    const fold = area.locator('.react-flow__node-fold', { hasText: '1 changed since' }).first();
    const colour = (el: ReturnType<Page['locator']>) => el.evaluate((e) => getComputedStyle(e).color);
    expect(await colour(fold.getByText(/1 changed since/))).not.toBe(await colour(fold.getByText(/secrets\.ts/)));
    await expect(area).toContainText('The middleware runs first.');
    await expect(area.locator('.react-flow__node-fold', { hasText: 'Sign-in is checked on every request' })).not.toContainText(/Sign-in is checked on every request.*Sign-in is checked on every request/);
    // A shorter answer shows "In short" and its code together, without pressing anything
    await board(page).getByRole('button', { name: 'Board ›' }).click();
    await stepIntoArea(page, /How are releases made/);
    const code = node(page, 'qcard:explain/how-are-releases-made.md#2');
    await expect(node(page, 'qcard:explain/how-are-releases-made.md#1')).toBeVisible();
    await expect(code).toBeVisible();
    await expect(code).toContainText('Matches');
    const view = page.viewportSize()!;
    const box = await code.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(view.height);
    await expect(board(page).locator('#board-area button[data-row-control]', { hasText: /more/ })).toHaveCount(0);
  });
});

// ─── E2: an answer beside the Area it is about, linked both ways ───────────────────────────────────────────────────────────────

const HOST = 'checkpoint:reports-export-to-csv';
const HOST_TITLE = 'Reports export to CSV';
const about = (entry: typeof SECURITY, area: string, extra: Record<string, unknown> = {}) => ({ ...entry, area, ...extra });
const focusKind = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-count-kind') ?? '');
const focusTest = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? '');
const questionButton = (page: Page, id = HOST) => node(page, id).getByRole('button', { name: /^Open (the answer|the newest of the)/ });
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('beside its Area, at 1440 Board', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('an answer about an Area stands right after it, with "1 question" on the Area card, and the others stay where they were', async ({ page }) => {
    answers = [about(SECURITY, HOST), OTHER];
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const ids = (await nodeIds(page)).filter((id): id is string => Boolean(id));
    expect(ids.indexOf(SECURITY_AREA)).toBe(ids.indexOf(HOST) + 1);
    // The answer with no Area is where it was: after the plan's Areas, before Workspace files
    expect(ids.indexOf('question:explain/how-are-releases-made.md')).toBeGreaterThan(ids.indexOf(SECURITY_AREA));
    expect(ids.indexOf('files:workspace')).toBeGreaterThan(ids.indexOf('question:explain/how-are-releases-made.md'));
    const button = questionButton(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveText('1 question');
    expect(await button.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(24);
    expect(await button.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
    await expect(questionButton(page, 'plan:own')).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });

  test('"1 question" opens the answer, which says what it is about; Escape puts the keyboard back on "1 question"', async ({ page }) => {
    answers = [about(SECURITY, HOST), OTHER];
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    await questionButton(page).click();
    const area = board(page).locator('#board-area');
    await expect(area.getByRole('heading', { name: 'How do we enforce security in this project?' })).toBeVisible();
    await expect(area.getByTestId('board-about-button')).toHaveText(`About: ${HOST_TITLE}`);
    await viewAtRest(page);
    await page.keyboard.press('Escape');
    await expect(board(page).locator('#board-area')).toHaveCount(0);
    await viewAtRest(page);
    await expect(questionButton(page)).toBeFocused();
    expect(await focusKind(page)).toBe('question');
  });

  test('"About: …" steps into the Area; Escape returns the keyboard to the answer\'s header button; Back says where it goes', async ({ page }) => {
    answers = [about(SECURITY, HOST), OTHER];
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    await questionButton(page).click();
    await viewAtRest(page);
    await board(page).locator('#board-area').getByTestId('board-about-button').click();
    await expect(board(page).locator('#board-area').getByRole('heading', { name: HOST_TITLE })).toBeVisible();
    await expect(board(page).getByTestId('board-back-button')).toContainText('How do we enforce security');
    await viewAtRest(page);
    await page.keyboard.press('Escape');
    await expect(board(page).locator('#board-area').getByRole('heading', { name: 'How do we enforce security in this project?' })).toBeVisible();
    await viewAtRest(page);
    await expect(board(page).getByTestId('board-about-button')).toBeFocused();
    expect(await focusTest(page)).toBe('board-about-button');
  });

  test('an answer whose Area does not exist stays where it was, with no "question" button and no "About"', async ({ page }) => {
    answers = [about(SECURITY, 'checkpoint:no-longer-in-the-plan'), OTHER];
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const ids = (await nodeIds(page)).filter((id): id is string => Boolean(id));
    expect(ids.indexOf(SECURITY_AREA)).toBeGreaterThan(ids.indexOf('plan:own'));
    expect(ids.indexOf(SECURITY_AREA)).toBeGreaterThan(ids.indexOf(HOST) + 1);
    await expect(board(page).locator('button[data-count-kind="question"]')).toHaveCount(0);
    await stepIntoArea(page, /How do we enforce security/);
    await expect(board(page).getByTestId('board-about-button')).toHaveCount(0);
  });

  test('an answer that names plan:own sits beside the Plan Area', async ({ page }) => {
    answers = [about(OTHER, 'plan:own')];
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const ids = (await nodeIds(page)).filter((id): id is string => Boolean(id));
    expect(ids.indexOf('question:explain/how-are-releases-made.md')).toBe(ids.indexOf('plan:own') + 1);
    await expect(questionButton(page, 'plan:own')).toHaveText('1 question');
  });

  test('two answers about one Area: "2 questions" opens the newest, and the index lists both under the Area and under Questions', async ({ page }) => {
    answers = [about(SECURITY, HOST), about(OTHER, HOST)];
    await page.addInitScript(() => { window.localStorage.setItem('contextspace_board_nav_open_v1', 'open'); });
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const ids = (await nodeIds(page)).filter((id): id is string => Boolean(id));
    expect(ids.slice(ids.indexOf(HOST), ids.indexOf(HOST) + 3)).toEqual([HOST, SECURITY_AREA, 'question:explain/how-are-releases-made.md']);
    await expect(questionButton(page)).toHaveText('2 questions');

    const nav = page.getByRole('navigation', { name: 'Board index' });
    await nav.getByRole('button', { name: 'Area', exact: true }).click();
    // Under the Area: one entry for each answer, in the list that follows the Area's own heading
    const under = nav.getByRole('listitem').filter({ hasText: /(How do we enforce security in this project\?|How are releases made\?)\s*\d+ parts?/ });
    await expect(under).toHaveCount(2);
    // And each answer has its own section under the Questions heading
    await expect(nav.getByRole('heading', { name: /^How do we enforce security in this project\? \(1\)/ })).toBeVisible();
    await expect(nav.getByRole('heading', { name: /^How are releases made\? \(1\)/ })).toBeVisible();
    await expect(nav).toContainText('Questions');

    await questionButton(page).click();
    await expect(board(page).locator('#board-area').getByRole('heading', { name: 'How do we enforce security in this project?' })).toBeVisible();
    await expect(board(page).locator('#board-area').getByRole('heading', { name: 'How are releases made?' })).toHaveCount(0);
  });

  test('a questions refresh that adds an answer for the Area does not leave the Area, move the keyboard or reset anything', async ({ page }) => {
    answers = [about(SECURITY, HOST)];
    await page.goto('/#/workspaces/demo/board');
    await stepIntoArea(page, HOST_TITLE);
    const heading = board(page).locator('#board-area').getByRole('heading', { name: HOST_TITLE });
    await expect(heading).toBeVisible();
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
    answers = [about(OTHER, HOST), about(SECURITY, HOST)];
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(heading).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.textContent ?? '')).toBe(focused);
  });
});

test.describe('beside its Area, in a Split at 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('the answer is on show next to its Area wherever the Area is, and "1 question" fits on the card', async ({ page }) => {
    answers = [about(SECURITY, HOST), OTHER];
    await page.addInitScript(() => { if (window === window.top) localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 })); });
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await expect(page.getByTestId('view-mode-split')).toHaveAttribute('aria-pressed', 'true');
    await viewAtRest(page);
    await expect(node(page, HOST)).toBeVisible();
    await expect(node(page, SECURITY_AREA)).toBeVisible();
    const button = questionButton(page);
    await expect(button).toBeVisible();
    const card = (await node(page, HOST).boundingBox())!;
    const b = (await button.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(card.x + card.width + 1);
    expect(await noSideways(page)).toBe(true);
    await button.click();
    await expect(board(page).locator('#board-area').getByTestId('board-about-button')).toBeVisible();
  });
});

// ─── The buttons for what is new beside "1 question": whole or not drawn ──────────────────────────────────────────────────────────

test.describe('"1 question" among the buttons for what is new', () => {
  const LONG_TITLE = 'The Board is powerful enough to be where the work happens, and it replaces the Plan tab';
  const HOST_LONG = `checkpoint:${checkpoint(LONG_TITLE).key}`;
  const shaOf = (n: number) => `${n + 1}a1b2c3d4e5f`;

  async function realShaped(page: Page) {
    const steps = Array.from({ length: 47 }, (_, i) => step(i < 4 ? `Ship board interaction ${i} (${shaOf(i).slice(0, 7)})` : `Area step ${i + 1}`, i < 44));
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Overlap', now: { key: 'focus-step-1', by: 'claude', at: minutesAgo(1) },
        checkpoints: [
          checkpoint('First Focus Area', { done: false, steps: [step('Focus step 1', false), step('Focus step 2', false)] }),
          checkpoint(LONG_TITLE, { done: false, steps: steps }),
          ...['Second Area', 'Third Area', 'Fourth Area', 'Fifth Area', 'Sixth Area', 'Seventh Area', 'Eighth Area', 'Ninth Area', 'Tenth Area', 'Eleventh Area'].map((title) => checkpoint(title, { done: false, steps: [step(`Step of ${title}`, false)] })),
        ],
      }),
    }));
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
      json: whatsNew({
        empty: false,
        commits: [{ repo: 'NexusFlow', more: 0, commits: [0, 1, 2, 3].map((n) => ({ sha: shaOf(n), author: 'Dev', subject: `feat: board layout ${n}`, at: minutesAgo(5 + n) })) }],
        plan: { items: steps.slice(0, 4).map((s, i) => ({ key: s.key, text: s.text, at: minutesAgo(2 + i) })), more: 0 },
      }),
    }));
    await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));
    answers = [about(SECURITY, HOST_LONG)];
  }

  /** Every count button on the card is whole, and the line has no sliver, no cut number and no stray comma. */
  async function expectWhole(page: Page, label: string) {
    const card = node(page, HOST_LONG);
    await expect(card, label).toBeVisible();
    const facts = await card.evaluate((el) => {
      const buttons = Array.from(el.querySelectorAll<HTMLElement>('button:not(.board-area)')).filter((b) => b.getBoundingClientRect().width > 0.5 && getComputedStyle(b).visibility !== 'hidden');
      const bad: string[] = [];
      for (const b of buttons) {
        const r = b.getBoundingClientRect();
        const text = b.querySelector<HTMLElement>('span') ?? b;
        if (text.scrollWidth > text.clientWidth + 1 || b.scrollWidth > b.clientWidth + 1) bad.push(`cut: "${b.textContent?.trim()}"`);
        if (r.height < 23.5) bad.push(`short: "${b.textContent?.trim()}" ${r.height}`);
        if (r.width < 20) bad.push(`sliver: "${b.textContent?.trim()}" ${Math.round(r.width)}px`);
      }
      // The line of buttons: separators only between two buttons
      const lines = new Set(buttons.map((b) => b.parentElement!).filter((parent) => !parent.classList.contains('board-area')));
      const stray: string[] = [];
      for (const line of lines) {
        const kids = Array.from(line.children) as HTMLElement[];
        kids.forEach((kid, i) => {
          const isSep = kid.tagName === 'SPAN' && /^[,·]$/.test(kid.textContent?.trim() ?? '');
          if (isSep && (i === 0 || i === kids.length - 1 || kids[i - 1]!.tagName !== 'BUTTON' || kids[i + 1]?.tagName !== 'BUTTON')) stray.push(`separator at ${i} of ${kids.length}`);
        });
      }
      return { texts: buttons.map((b) => b.textContent?.trim()), bad, stray };
    });
    expect(facts.bad, `${label} ${JSON.stringify(facts.texts)}`).toEqual([]);
    expect(facts.stray, `${label} ${JSON.stringify(facts.texts)}`).toEqual([]);
    expect(facts.texts.some((t) => t === '1 question'), `${label}: "1 question" stays ${JSON.stringify(facts.texts)}`).toBe(true);
  }

  test.describe('1440 Board', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test('no count button is cut or squeezed and no comma hangs', async ({ page }) => {
      await realShaped(page);
      await page.goto('/#/workspaces/demo/board');
      await viewAtRest(page);
      await expectWhole(page, '1440 Board');
    });
  });

  test.describe('1100 Split', () => {
    test.use({ viewport: { width: 1100, height: 700 } });
    test('no count button is cut or squeezed and no comma hangs', async ({ page }) => {
      await realShaped(page);
      await page.addInitScript(() => { if (window === window.top) localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 })); });
      await page.goto('/#/workspaces/demo/board');
      await page.getByTestId('view-mode-split').click();
      await viewAtRest(page);
      await expectWhole(page, '1100 Split');
    });
  });
});


test('out-of-date answer refreshes live and returns focus to its title', async ({ page }) => {
  await stepIntoAnswer(page);
  const area = board(page).locator('#board-area');
  await expect(area.getByText('Out of date · 2 copies', { exact: true }).first()).toBeVisible();
  const refresh = area.getByRole('button', { name: 'Refresh this answer' });
  await expect(refresh).toBeVisible();
  await refresh.focus();
  answers = [OTHER];
  const matching = structuredClone(SECURITY);
  for (const part of matching.parts) for (const card of part.cards) {
    if (card.kind === 'code' && (card.check.status === 'changed' || card.check.status === 'gone')) card.check = { status: 'matches' };
  }
  answers = [matching, OTHER];
  const before = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(refresh).toHaveCount(0);
  await expect(area.getByRole('heading', { name: SECURITY.question, exact: true })).toBeFocused();
});

test('answer news opens its Area and Escape returns to its line', async ({ page }) => {
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ empty: false, answers: { items: [{ path: SECURITY.path, question: SECURITY.question, change: 'out-of-date', copies: 2, at: minutesAgo(1) }], more: 0 } }) }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId('board-now-news').click();
  const line = page.getByRole('button', { name: /Answer out of date: How do we enforce security/ });
  await line.click();
  await expect(board(page).locator('#board-area').getByRole('heading', { name: SECURITY.question })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(line).toBeFocused();
});

test('refresh sends the request through Ask in CLI without submitting', async ({ page }) => {
  const typed: string[] = [];
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [{ id: 'term-demo', workspace: 'demo', target: 'shell', label: 'bash', cwd: '/tmp/demo', state: 'running' }], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type === 'input') typed.push(parsed.data);
      if (parsed.type === 'attach') {
        socket.send(JSON.stringify({ type: 'ready', terminal: { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: '/tmp/demo', state: 'running' }, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      }
    });
  });
  await stepIntoAnswer(page);
  await board(page).getByRole('button', { name: 'Refresh this answer' }).click();
  const request = 'Refresh the answer explain/how-do-we-enforce-security.md ("How do we enforce security in this project?"): these copies no longer match: NexusFlow/src/core/secrets.ts:3-4 (changed), NexusFlow/src/core/old.ts:1 (gone). Follow the contextspace-explain skill and run ctxspace explain until all copies match.';
  await expect.poll(() => typed.at(-1)).toBe(`Regarding ${request}: `);
  expect(typed.join('')).not.toContain('\r');
});

test('a matching answer has no refresh button', async ({ page }) => {
  answers = [OTHER];
  await stepIntoAnswer(page, /How are releases made/);
  await expect(board(page).getByRole('button', { name: 'Refresh this answer' })).toHaveCount(0);
});

test('new answer news refetches questions immediately on a live event', async ({ page }) => {
  answers = [OTHER];
  let fresh = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/workspace/*/screen-events**', async (route) => {
    await gate;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 60000\n\nevent: plan\nid: p1\ndata: ${JSON.stringify({ type: 'plan', timestamp: new Date().toISOString() })}\n\n` });
  });
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: fresh ? whatsNew({ empty: false, answers: { items: [{ path: SECURITY.path, question: SECURITY.question, change: 'added', copies: 0, at: new Date().toISOString() }], more: 0 } }) : whatsNew() }));
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  const before = reads;
  answers = [SECURITY, OTHER]; fresh = true; release();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await page.getByTestId('board-now-news').click();
  await page.getByRole('button', { name: /New answer: How do we enforce security/ }).click();
  await expect(board(page).locator('#board-area').getByRole('heading', { name: SECURITY.question })).toBeVisible();
});

test('answer news returns focus after its age changes', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ empty: false, answers: { items: [{ path: OTHER.path, question: OTHER.question, change: 'added', copies: 0, at: new Date().toISOString() }, { path: SECURITY.path, question: SECURITY.question, change: 'out-of-date', copies: 2, at: new Date(Date.now() - 60_000).toISOString() }], more: 0 } }) }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId('board-now-news').click();
  const line = page.getByRole('button', { name: /Answer out of date: How do we enforce security/ });
  const oldText = await line.textContent();
  await line.click();
  await expect(board(page).locator('#board-area').getByRole('heading', { name: SECURITY.question })).toBeVisible();
  await page.clock.fastForward('02:00');
  await page.keyboard.press('Escape');
  await expect(line).not.toHaveText(oldText!);
  await expect(line).toBeFocused();
});

const focusInfo = (page: Page) => page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName} ${(a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 70)}` : 'none'; });

test('R2a stale origin: open from news, leave by Board ›, re-enter from the card, Escape', async ({ page }) => {
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ empty: false, answers: { items: [{ path: SECURITY.path, question: SECURITY.question, change: 'out-of-date', copies: 2, at: minutesAgo(1) }], more: 0 } }) }));
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  await page.getByTestId('board-now-news').click();
  await page.getByRole('button', { name: /Answer out of date: How do we enforce security/ }).click();
  await expect(board(page).locator('#board-area').getByRole('heading', { name: SECURITY.question })).toBeVisible();
  await board(page).getByRole('button', { name: 'Board ›' }).click();
  await viewAtRest(page);
  await stepIntoArea(page, /How do we enforce security/);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const listOpen = await page.getByTestId('board-news-list').isVisible().catch(() => false);
  console.log('R2a newsListOpen=', listOpen, 'focus=', await focusInfo(page));
  expect(listOpen).toBe(false);
});

test('R2b Escape after the answer line vanished: where is focus, and does the popover pop later?', async ({ page }) => {
  test.setTimeout(120_000);
  let phase = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let n = 0;
  await page.route('**/api/workspace/*/screen-events**', async (route) => {
    await gate;
    n += 1;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 1500\n\nevent: plan\nid: p${n}\ndata: ${JSON.stringify({ type: 'plan', timestamp: new Date().toISOString() })}\n\n` });
  });
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: phase === 0
    ? whatsNew({ empty: false, answers: { items: [{ path: SECURITY.path, question: SECURITY.question, change: 'out-of-date', copies: 2, at: minutesAgo(1) }], more: 0 } })
    : phase === 1 ? whatsNew() : whatsNew({ empty: false, answers: { items: [{ path: OTHER.path, question: OTHER.question, change: 'changed', copies: 0, at: minutesAgo(0) }], more: 0 } }) }));
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  await page.getByTestId('board-now-news').click();
  await page.getByRole('button', { name: /Answer out of date: How do we enforce security/ }).click();
  await expect(board(page).locator('#board-area').getByRole('heading', { name: SECURITY.question })).toBeVisible();
  phase = 1; release();
  await expect(page.getByTestId('board-now-news')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  console.log('R2b after Escape focus=', await focusInfo(page));
  phase = 2;
  await expect(page.getByTestId('board-now-news')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800);
  const listOpen = await page.getByTestId('board-news-list').isVisible().catch(() => false);
  console.log('R2b later news: popover open by itself =', listOpen, 'focus=', await focusInfo(page));
  expect(listOpen).toBe(false);
});


test('answer header shows one freshness warning', async ({ page }) => {
  await stepIntoAnswer(page);
  const header = board(page).locator('#board-area').getByRole('heading', { name: SECURITY.question }).locator('..');
  expect((await header.innerText()).match(/Out of date · 2 copies/g)).toHaveLength(1);
});

test('answer refresh control has readable text', async ({ page }) => {
  await stepIntoAnswer(page);
  const refresh = board(page).getByRole('button', { name: 'Refresh this answer' });
  expect(await refresh.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
});

test('answer title stays in place and exposes the full question', async ({ page }) => {
  await stepIntoAnswer(page);
  const area = board(page).locator('#board-area');
  const title = area.getByRole('heading', { name: SECURITY.question });
  await expect(title).toHaveAttribute('title', SECURITY.question);
  await title.click();
  await expect(title).toBeVisible();
  await expect(title.locator('button')).toHaveCount(0);
});
