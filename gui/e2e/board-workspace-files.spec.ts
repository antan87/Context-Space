import { test, expect } from './fixtures';
import {
  board,
  boardEvent,
  document as boardDocument,
  frame,
  minutesAgo,
  node,
  PING,
  PICTURE,
  routeBoard,
  routeCards,
  routeWork,
  routeWorkspaceDocumentReferences,
  stepIntoArea,
  viewAtRest,
  workspace,
} from './boardHelpers';
import { boardFile, boardFileCard, checkpoint, planFile, whatsNew } from './planData';

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

const SVG_DATA = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#2563eb"/></svg>';

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

async function routeDocumentViews(
  page: import('@playwright/test').Page,
  htmlBodies: Record<string, string>,
  markdownBodies: Record<string, string> = {},
) {
  await page.route('**/api/workspace/demo/documents/file?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name.endsWith('.svg')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG_DATA });
    return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE });
  });
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name.endsWith('.html') || name.endsWith('.htm')) {
      return route.fulfill({
        json: { name, kind: 'html', modifiedAt: isoHoursAgo(1), size: 220, content: htmlBodies[name] ?? '<h1>HTML</h1>' },
      });
    }
    if (name.endsWith('.png') || name.endsWith('.svg')) {
      return route.fulfill({ json: { name, kind: 'image', modifiedAt: isoHoursAgo(1), size: 128 } });
    }
    return route.fulfill({
      json: { name, kind: name.endsWith('.md') ? 'markdown' : 'text', modifiedAt: isoHoursAgo(2), size: 150, content: markdownBodies[name] ?? `# File ${name}` },
    });
  });
  await page.route('**/api/workspace/demo/documents/view-link', async (route) => {
    const postData = route.request().postDataJSON() as { name?: string } | null;
    const name = postData?.name ?? '';
    return route.fulfill({
      json: { token: 'ws-view', url: `/view/ws-view/${name}`, scope: '' },
    });
  });
  await page.route('**/view/ws-view/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const match = pathname.match(/^\/view\/ws-view\/(.+)$/);
    const name = match ? decodeURIComponent(match[1]) : '';
    const body = htmlBodies[name] ?? '<!doctype html><html><body>Not found</body></html>';
    return route.fulfill({ status: 200, contentType: 'text/html; charset=UTF-8', body });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const isReadOnly = ['GET', 'HEAD'].includes(req.method()) || req.url().endsWith('/documents/view-link');
    return isReadOnly
      ? route.fallback()
      : route.fulfill({ status: 405, json: { error: 'Writes must not happen on Workspace files' } });
  });
});

test('shows Workspace files Area in an empty workspace with counts and up to 3 newest miniatures', async ({ page }) => {
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'PLAN.md', modifiedAt: isoHoursAgo(1), size: 120 },
          { path: 'docs/spec.txt', modifiedAt: isoHoursAgo(2), size: 90 },
          { path: 'AGENTS.md', modifiedAt: isoHoursAgo(0.1), size: 40 },
          { path: 'CLAUDE.md', modifiedAt: isoHoursAgo(0.1), size: 40 },
          { path: '.agents/skills/dev/SKILL.md', modifiedAt: isoHoursAgo(0.1), size: 40 },
          { path: '.claude/skills/dev/SKILL.md', modifiedAt: isoHoursAgo(0.1), size: 40 },
          { path: '.github/copilot-instructions.md', modifiedAt: isoHoursAgo(0.1), size: 40 },
          { path: 'contextspace-board.json', modifiedAt: isoHoursAgo(0.1), size: 40 },
          { path: 'pages/overview.html', modifiedAt: isoHoursAgo(1), size: 300 },
          { path: 'shots/oldest.png', modifiedAt: isoHoursAgo(6), size: 200 },
          { path: 'shots/older.jpg', modifiedAt: isoHoursAgo(4), size: 200 },
          { path: 'shots/newer.webp', modifiedAt: isoHoursAgo(2), size: 200 },
          { path: 'shots/newest.svg', modifiedAt: isoHoursAgo(0.5), size: 150 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await page.route('**/api/workspace/demo/documents/file?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name.endsWith('.svg')) {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG_DATA });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE });
  });

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  const area = node(page, 'files:workspace');
  await expect(area).toBeVisible();
  await expect(area.getByText('Workspace files')).toBeVisible();
  await expect(area.getByRole('button', { name: 'Show the 2 documents', exact: true })).toBeVisible();
  await expect(area.getByRole('button', { name: 'Show the 1 page', exact: true })).toBeVisible();
  await expect(area.getByRole('button', { name: 'Show the 4 pictures', exact: true })).toBeVisible();

  const thumbs = area.locator('button[data-path]');
  await expect(thumbs).toHaveCount(3);
  await expect(thumbs.nth(0)).toHaveAttribute('data-path', 'shots/newest.svg');
  await expect(thumbs.nth(1)).toHaveAttribute('data-path', 'shots/newer.webp');
  await expect(thumbs.nth(2)).toHaveAttribute('data-path', 'shots/older.jpg');
});

test('places Workspace files after plan Areas, deduplicates real file cards, steps in newest-first with read-only reader flow', async ({ page }) => {
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        checkpoints: [
          checkpoint('Reports export to CSV', { line: 4, steps: [{ key: 'export-step', line: 5, text: 'Build exporter', done: false, kind: 'step', indent: 0, current: true }] }),
        ],
      }),
    }),
  );
  await routeCards(page, boardFile({
    cards: [
      boardFileCard(1, 'docs/already-placed.md', { area: 'checkpoint:reports-export-to-csv', step: 'export-step', title: 'Placed doc' }),
    ],
  }));

  const lotsOfPics = Array.from({ length: 12 }, (_, idx) => ({
    path: `shots/pic-${String(idx + 1).padStart(2, '0')}.png`,
    modifiedAt: isoHoursAgo(12 - idx),
    size: 128,
  }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'docs/already-placed.md', modifiedAt: isoHoursAgo(0.2), size: 90 },
          { path: 'docs/early-notes.txt', modifiedAt: isoHoursAgo(5), size: 80 },
          { path: 'PLAN.md', modifiedAt: isoHoursAgo(2), size: 150 },
          { path: 'pages/mock.htm', modifiedAt: isoHoursAgo(1), size: 220 },
          ...lotsOfPics,
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {
    'pages/mock.htm': '<!doctype html><html><body><h1>Canvas HTML Page</h1></body></html>',
  });

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // Plan focus Area stays in Tier 1; Workspace files sits after plan Areas (not Hero).
  const planArea = node(page, 'checkpoint:reports-export-to-csv');
  const wsArea = node(page, 'files:workspace');
  await expect(planArea).toBeVisible();
  await expect(wsArea).toBeVisible();
  const planBox = await planArea.boundingBox();
  const wsBox = await wsArea.boundingBox();
  expect(wsBox!.y).toBeGreaterThan(planBox!.y);

  await stepIntoArea(page, /Workspace files/);

  // No write controls in Workspace files Area header.
  await expect(board(page).getByRole('button', { name: 'Add a step' })).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: 'Add a note' })).toHaveCount(0);

  // Three rows in exact order; deduped file absent; newest first; +N earlier on overflow.
  const rows = board(page).locator('#board-area .react-flow__node-step');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Documents');
  await expect(rows.nth(1)).toContainText('Pages');
  await expect(rows.nth(2)).toContainText('Pictures');

  const docBox = await rows.nth(0).boundingBox();
  const pagesBox = await rows.nth(1).boundingBox();
  const picsBox = await rows.nth(2).boundingBox();
  expect(docBox!.y).toBeLessThan(pagesBox!.y);
  expect(pagesBox!.y).toBeLessThan(picsBox!.y);

  await expect(board(page).locator('#board-area')).not.toContainText('already-placed.md');

  const docNode = node(page, 'wsfile:PLAN.md');
  const oldDocNode = node(page, 'wsfile:docs/early-notes.txt');
  const pageNode = node(page, 'wsfile:pages/mock.htm');

  await expect(docNode).toContainText('PLAN.md');
  await expect(docNode).toContainText('2 h ago');
  await expect(oldDocNode).toContainText('docs');
  await expect(oldDocNode).toContainText('5 h ago');
  await expect(pageNode).toContainText('mock.htm');
  await expect(pageNode).toContainText('pages');

  const planPos = await docNode.boundingBox();
  const oldPos = await oldDocNode.boundingBox();
  expect(planPos!.y).toBeLessThan(oldPos!.y);

  // Generated items stay strictly non-editable/non-draggable.
  await expect(docNode).not.toHaveClass(/react-flow__node-draggable/);
  await expect(docNode.getByRole('button', { name: /Actions|Edit|Archive|Pin/i })).toHaveCount(0);

  // "+N earlier" appears on the Pictures row when 12 pictures exceed one row.
  await expect(board(page).locator('#board-area .react-flow__node-more')).toContainText(/earlier/);

  // Open document -> navigate `[`/`]` -> page -> picture -> Escape closes cleanly.
  await docNode.getByRole('button', { name: 'Open PLAN.md' }).click();
  await expect(page.getByRole('heading', { name: 'File PLAN.md' })).toBeVisible();

  await page.keyboard.press(']');
  await expect(page.locator('pre').getByText('# File docs/early-notes.txt')).toBeVisible();

  await page.keyboard.press(']');
  await expect(page.frameLocator('iframe[title="Preview of pages/mock.htm"]').getByRole('heading', { name: 'Canvas HTML Page' })).toBeVisible();

  await page.keyboard.press(']');
  await expect(page.locator('img[alt="shots/pic-12.png"]')).toBeVisible();
  await expect(board(page).locator('#board-area .react-flow__node[data-id="wsfile:shots/pic-12.png"] article')).toHaveAttribute('aria-current', 'true');

  // Escape closes reader back to Area, and Escape again returns to overview.
  await page.keyboard.press('Escape');
  await expect(page.locator('img[alt="shots/pic-12.png"]')).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
});

test('refetches on open, window focus, and news document changes — not on Board poll — and preserves open reader state', async ({ page }) => {
  let fileRequests = 0;
  let boardRequests = 0;
  let files = [
    { path: 'pages/form.html', modifiedAt: isoHoursAgo(2), size: 300 },
    { path: 'shots/first.png', modifiedAt: isoHoursAgo(3), size: 120 },
  ];
  let currentNews = whatsNew({ documents: { items: [], more: 0 } });
  let nextSseEvent: 'ping' | 'board' | 'plan' = 'ping';

  await page.route('**/api/workspace/demo/files', (route) => {
    fileRequests++;
    return route.fulfill({ json: { files, truncated: false, errors: [] } });
  });
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: currentNews }));
  await page.route('**/api/workspace/demo/board', (route) => {
    boardRequests++;
    return route.fulfill({ json: boardFile({ cards: [] }) });
  });
  await routeDocumentViews(page, {
    'pages/form.html': '<!doctype html><html><body><label>Note<input id="html-input" type="text" /></label></body></html>',
  });
  await page.route('**/api/workspace/demo/screen-events**', (route) => {
    const kind = nextSseEvent;
    nextSseEvent = 'ping';
    const body =
      kind === 'plan'
        ? `retry: 150\n\n${frame('plan', { timestamp: new Date().toISOString() }, 'p1')}`
        : kind === 'board'
          ? `retry: 150\n\n${boardEvent(2)}`
          : `retry: 150\n\n${PING}`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Workspace files/);
  const initialFileRequests = fileRequests;
  expect(initialFileRequests).toBeGreaterThanOrEqual(1);
  const initialBoardRequests = boardRequests;

  // Open HTML page and type into the iframe input.
  await node(page, 'wsfile:pages/form.html').getByRole('button', { name: 'Open form.html' }).click();
  const previewFrame = page.frameLocator('iframe[title="Preview of pages/form.html"]');
  const input = previewFrame.locator('#html-input');
  await input.fill('keep this typed value');

  // A Board update triggers a board refetch, NOT a workspace files refetch.
  nextSseEvent = 'board';
  await expect.poll(() => boardRequests).toBeGreaterThan(initialBoardRequests);
  await page.waitForTimeout(400);
  expect(fileRequests).toBe(initialFileRequests);
  await expect(input).toHaveValue('keep this typed value');

  // Window focus triggers refetch without closing reader or losing typed iframe value.
  files = [
    ...files,
    { path: 'shots/focus-shot.png', modifiedAt: isoHoursAgo(0.1), size: 140 },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(board(page).locator('#board-area .react-flow__node[data-id="wsfile:shots/focus-shot.png"]')).toBeVisible();
  expect(fileRequests).toBe(initialFileRequests + 1);
  await expect(input).toHaveValue('keep this typed value');

  // News feed reporting a document change triggers refetch without window focus, keeping reader & focus intact.
  files = [
    ...files,
    { path: 'PLAN.md', modifiedAt: minutesAgo(1), size: 80 },
  ];
  currentNews = whatsNew({
    at: new Date().toISOString(),
    documents: { items: [{ name: 'PLAN.md', kind: 'plan', change: 'changed' }], more: 0 },
  });
  nextSseEvent = 'plan';
  await expect(board(page).locator('#board-area .react-flow__node[data-id="wsfile:PLAN.md"]')).toBeVisible();
  expect(fileRequests).toBe(initialFileRequests + 2);
  await expect(input).toHaveValue('keep this typed value');
});

test('shows compact docs (PLAN.md first), open pages & real picture thumbnails on first screen and untruncated mini overview with 3 thumbnails', async ({ page }) => {
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        checkpoints: [
          checkpoint('Reports export to CSV', { line: 4, steps: [{ key: 'export-step', line: 5, text: 'Build exporter', done: false, kind: 'step', indent: 0, current: true }] }),
        ],
      }),
    }),
  );
  await routeCards(page, boardFile({ cards: [] }));

  const docs = Array.from({ length: 24 }, (_, idx) => ({
    path: `design/evidence/run-${Math.floor(idx / 4)}/doc-${String(idx + 1).padStart(2, '0')}.md`,
    modifiedAt: isoHoursAgo(1 + idx * 0.2),
    size: 200,
  }));
  const pages = Array.from({ length: 10 }, (_, idx) => ({
    path: `pages/canvas-${String(idx + 1).padStart(2, '0')}.html`,
    modifiedAt: isoHoursAgo(1 + idx * 0.5),
    size: 320,
  }));
  const pics = Array.from({ length: 20 }, (_, idx) => ({
    path: `shots/pic-${String(idx + 1).padStart(2, '0')}.png`,
    modifiedAt: isoHoursAgo(1 + idx * 0.3),
    size: 180,
  }));

  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          // PLAN.md is deliberately older than all other docs, yet must still appear first.
          { path: 'PLAN.md', modifiedAt: isoHoursAgo(200), size: 300 },
          ...docs,
          ...pages,
          ...pics,
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {});

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // Overview mini card shows up to 3 newest picture miniatures and non-truncated counts.
  const wsArea = node(page, 'files:workspace');
  await expect(wsArea).toBeVisible();
  const miniThumbs = wsArea.locator('button[data-path] img');
  await expect(miniThumbs).toHaveCount(3);
  await expect(wsArea.getByText('25 docs · 10 pages · 20 pictures')).toBeVisible();
  const countTruncated = await wsArea.evaluate((el) => {
    const span = [...el.querySelectorAll('span')].find((s) => s.textContent?.includes('25 docs'));
    return span ? span.scrollWidth > span.clientWidth + 1 : true;
  });
  expect(countTruncated).toBe(false);

  // Step into Workspace files: all three rows open (no folds), docs compact with PLAN.md first, pictures as <img> thumbnails.
  await stepIntoArea(page, /Workspace files/);
  await expect(board(page).locator('#board-area .react-flow__node-fold')).toHaveCount(0);

  const planNode = node(page, 'wsfile:PLAN.md');
  await expect(planNode).toBeVisible();
  const newestDocNode = node(page, 'wsfile:design/evidence/run-0/doc-01.md');
  await expect(newestDocNode).toBeVisible();
  const planBox = await planNode.boundingBox();
  const doc1Box = await newestDocNode.boundingBox();
  expect(planBox!.height).toBeLessThan(50);
  expect(planBox!.y).toBeLessThan(doc1Box!.y);
  await expect(planNode).not.toContainText('Markdown');

  await expect(node(page, 'wsfile:pages/canvas-01.html')).toBeVisible();

  const newestPicImg = node(page, 'wsfile:shots/pic-01.png').locator('img');
  await expect(newestPicImg).toBeVisible();
  await expect.poll(() => newestPicImg.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // Clicking "+N earlier" on Documents opens the Documents row and reveals earlier documents.
  const docsMore = board(page).locator('#board-area .react-flow__node[data-id="row:ws:documents:more"] button');
  await expect(docsMore).toContainText(/earlier/);
  await docsMore.click();
  await expect(board(page).locator('#board-area .react-flow__node-pager')).toBeVisible();
});

test('places step-named files on open and done step rows, removes them and assigned documents from Workspace files, deduplicates real cards, and opens in reader', async ({ page }) => {
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(2) },
        checkpoints: [
          checkpoint('Step files checkpoint', {
            line: 4,
            steps: [
              {
                key: 's1',
                line: 5,
                text: 'Inspect PLAN.md, `design/packets/spec.md`, pages/step-page.html, and `./board-pictures/step-shot.png`.',
                done: false,
                kind: 'step',
                indent: 0,
                current: true,
              },
              {
                key: 's2',
                line: 6,
                text: 'Compare `board-pictures/step-shot.png` with docs/notes.txt.',
                done: false,
                kind: 'step',
                indent: 0,
              },
              {
                key: 's3',
                line: 7,
                text: 'Read docs/only-named.md',
                done: false,
                kind: 'step',
                indent: 0,
              },
              {
                key: 's5',
                line: 8,
                text: 'Review (PLAN.md, `./PLAN.md`) without creating a step row.',
                done: false,
                kind: 'step',
                indent: 0,
              },
              {
                key: 's4',
                line: 9,
                text: 'Done artifact `board-pictures/done-shot.png` and `pages/done-page.html`.',
                done: true,
                kind: 'step',
                indent: 0,
              },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, [
    boardDocument('Assigned Brief', {
      id: '11111111-1111-4111-8111-111111111111',
      role: 'design',
      status: 'approved',
      scope: { milestoneId: 'step-files-checkpoint' },
      summary: 'Assigned brief document',
      filename: 'docs/brief.md',
      createdAt: isoHoursAgo(5),
      updatedAt: isoHoursAgo(3),
    }),
  ]);
  await routeCards(page, boardFile({
    cards: [
      boardFileCard(1, 'docs/notes.txt', {
        area: 'checkpoint:step-files-checkpoint',
        step: 's2',
        title: 'Real notes card',
        description: 'Already placed by user',
      }),
    ],
  }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'PLAN.md', modifiedAt: isoHoursAgo(10), size: 300 },
          { path: 'design/packets/spec.md', modifiedAt: isoHoursAgo(2), size: 200 },
          { path: 'docs/notes.txt', modifiedAt: isoHoursAgo(3), size: 120 },
          { path: 'docs/only-named.md', modifiedAt: isoHoursAgo(1.5), size: 140 },
          { path: 'docs/brief.md', modifiedAt: isoHoursAgo(4), size: 240 },
          { path: 'pages/step-page.html', modifiedAt: isoHoursAgo(1), size: 320 },
          { path: 'pages/done-page.html', modifiedAt: isoHoursAgo(5), size: 320 },
          { path: 'board-pictures/step-shot.png', modifiedAt: isoHoursAgo(0.5), size: 250 },
          { path: 'board-pictures/done-shot.png', modifiedAt: isoHoursAgo(4), size: 250 },
          { path: 'board-pictures/unmentioned.png', modifiedAt: isoHoursAgo(6), size: 250 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {
    'pages/step-page.html': '<!doctype html><html><body><h1>Step Page</h1></body></html>',
    'pages/done-page.html': '<!doctype html><html><body><h1>Done Page</h1></body></html>',
  });

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // Overview: checkpoint Area counts & miniatures include step-named files; Workspace files only has unmentioned files.
  const cpArea = node(page, 'checkpoint:step-files-checkpoint');
  await expect(cpArea).toBeVisible();
  await expect(cpArea.locator('button[data-path="board-pictures/step-shot.png"]')).toBeVisible();
  await expect(cpArea.getByRole('button', { name: 'Show the 2 pictures', exact: true })).toBeVisible();

  const wsArea = node(page, 'files:workspace');
  await expect(wsArea).toBeVisible();
  await expect(wsArea.getByText('1 doc · 1 picture')).toBeVisible();
  await expect(wsArea.locator('button[data-path]')).toHaveCount(1);
  await expect(wsArea.locator('button[data-path="board-pictures/unmentioned.png"]')).toBeVisible();

  // Step into Workspace files: step-named files and assigned docs/brief.md must NOT be listed.
  await stepIntoArea(page, /Workspace files/);
  await expect(board(page).locator('#board-area')).not.toContainText('spec.md');
  await expect(board(page).locator('#board-area')).not.toContainText('brief.md');
  await expect(board(page).locator('#board-area')).not.toContainText('step-page.html');
  await expect(board(page).locator('#board-area')).not.toContainText('step-shot.png');
  await expect(node(page, 'wsfile:PLAN.md')).toBeVisible();
  await expect(node(page, 'wsfile:board-pictures/unmentioned.png')).toBeVisible();

  // Step back and enter the checkpoint Area.
  await page.keyboard.press('Escape');
  await viewAtRest(page);
  await stepIntoArea(page, /Step files checkpoint/);

  // s1 shows its 3 step-named files; s2 shows step-shot.png + real card for notes.txt (no duplicate wsfile); s3 is a visible step row; row:done stays folded.
  await expect(node(page, 'wsfile:step:s1:design/packets/spec.md')).toBeVisible();
  await expect(node(page, 'wsfile:step:s1:pages/step-page.html')).toBeVisible();
  await expect(node(page, 'wsfile:step:s1:board-pictures/step-shot.png')).toBeVisible();

  await expect(node(page, 'wsfile:step:s2:board-pictures/step-shot.png')).toBeVisible();
  await expect(board(page).locator('#board-area [data-id="wsfile:step:s2:docs/notes.txt"]')).toHaveCount(0);
  await expect(board(page).locator('#board-area').getByText('Real notes card')).toBeVisible();

  await expect(node(page, 'row:step:s3')).toBeVisible();
  await expect(node(page, 'wsfile:step:s3:docs/only-named.md')).toBeVisible();

  // Mentioning PLAN.md never places PLAN.md on a step row and does not give s5 its own step row.
  await expect(board(page).locator('#board-area [data-id^="wsfile:step:"][data-id$=":PLAN.md"]')).toHaveCount(0);
  await expect(board(page).locator('#board-area [data-id="row:step:s5"]')).toHaveCount(0);

  // Done step stays folded in row:done; opening row:done shows its step-named files.
  const doneRow = node(page, 'row:done');
  await expect(doneRow).toBeVisible();
  await expect(board(page).locator('#board-area [data-id="wsfile:step:s4:board-pictures/done-shot.png"]')).toHaveCount(0);
  await doneRow.locator('button[data-row-control="row:done"]').click();
  await expect(node(page, 'wsfile:step:s4:board-pictures/done-shot.png')).toBeVisible();
  await expect(node(page, 'wsfile:step:s4:pages/done-page.html')).toBeVisible();

  // Generated step-named items are read-only (not draggable, no Edit/Archive/Pin).
  const s1Pic = node(page, 'wsfile:step:s1:board-pictures/step-shot.png');
  await expect(s1Pic).not.toHaveClass(/react-flow__node-draggable/);
  await expect(s1Pic.getByRole('button', { name: /Actions|Edit|Archive|Pin/i })).toHaveCount(0);

  // Open picture from s1 in reader (scoped to s1's pictures), then open s1's HTML page and navigate with [ / Escape.
  await s1Pic.getByRole('button', { name: 'Open step-shot' }).click();
  await expect(page.locator('img[alt="board-pictures/step-shot.png"]')).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.locator('img[alt="board-pictures/step-shot.png"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('img[alt="board-pictures/step-shot.png"]')).toHaveCount(0);

  await node(page, 'wsfile:step:s1:pages/step-page.html').getByRole('button', { name: 'Open step-page.html' }).click();
  await expect(page.frameLocator('iframe[title="Preview of pages/step-page.html"]').getByRole('heading', { name: 'Step Page' })).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.getByRole('heading', { name: 'File design/packets/spec.md' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'File design/packets/spec.md' })).toHaveCount(0);
});

test('excludes assigned document when no step names it, opens step picture from overview count, and preserves open reader on plan refresh', async ({ page }) => {
  await routeBoard(page);
  let planData = planFile({
    now: { key: 's1', by: 'claude', at: minutesAgo(2) },
    checkpoints: [
      checkpoint('Brief checkpoint', {
        line: 4,
        steps: [
          {
            key: 's1',
            line: 5,
            text: 'Check `board-pictures/overview-pic.png`',
            done: false,
            kind: 'step',
            indent: 0,
            current: true,
          },
        ],
      }),
    ],
  });
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planData }));
  await routeWork(page, [
    boardDocument('Project Brief', {
      id: '22222222-2222-4222-8222-222222222222',
      role: 'design',
      status: 'approved',
      scope: { milestoneId: 'brief-checkpoint' },
      summary: 'Assigned brief',
      filename: 'docs/brief.md',
      createdAt: isoHoursAgo(4),
      updatedAt: isoHoursAgo(2),
    }),
  ]);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'docs/brief.md', modifiedAt: isoHoursAgo(2), size: 120 },
          { path: 'board-pictures/overview-pic.png', modifiedAt: isoHoursAgo(1), size: 220 },
          { path: 'PLAN.md', modifiedAt: isoHoursAgo(3), size: 300 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {});

  let nextEvent: 'ping' | 'plan' = 'ping';
  await page.route('**/api/workspace/demo/screen-events**', (route) => {
    const kind = nextEvent;
    nextEvent = 'ping';
    const body = kind === 'plan'
      ? `retry: 150\n\n${frame('plan', { timestamp: new Date().toISOString() }, 'p-refresh')}`
      : `retry: 150\n\n${PING}`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // Assigned docs/brief.md is excluded from Workspace files Area, leaving only PLAN.md.
  const wsArea = node(page, 'files:workspace');
  await expect(wsArea).toBeVisible();
  await expect(wsArea.getByText('1 doc')).toBeVisible();
  await expect(wsArea).not.toContainText('picture');

  // Clicking "Show the 1 picture" on the checkpoint card steps in and highlights the step picture.
  const cpArea = node(page, 'checkpoint:brief-checkpoint');
  await cpArea.getByRole('button', { name: 'Show the 1 picture', exact: true }).click();
  const picNode = node(page, 'wsfile:step:s1:board-pictures/overview-pic.png');
  await expect(picNode).toBeVisible();

  // Open picture in reader; a plan refresh keeps the reader open.
  await picNode.getByRole('button', { name: 'Open overview-pic' }).click();
  await expect(page.locator('img[alt="board-pictures/overview-pic.png"]')).toBeVisible();

  planData = planFile({
    now: { key: 's1', by: 'claude', at: minutesAgo(2) },
    checkpoints: [
      checkpoint('Brief checkpoint', {
        line: 4,
        steps: [
          {
            key: 's1',
            line: 5,
            text: 'Check `board-pictures/overview-pic.png` (refreshed)',
            done: false,
            kind: 'step',
            indent: 0,
            current: true,
          },
        ],
      }),
    ],
  });
  nextEvent = 'plan';
  await expect(board(page).locator('#board-area .react-flow__node[data-id="row:step:s1"]')).toContainText('(refreshed)');
  await expect(page.locator('img[alt="board-pictures/overview-pic.png"]')).toBeVisible();
});

test('PX1: names overview thumbnails and workspace pictures without folders or extensions and shows In step / In folder / Workspace root footers', async ({ page }) => {
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 'dc2', by: 'claude', at: minutesAgo(2) },
        title: 'ContextSpace',
        checkpoints: [
          checkpoint('Documents', {
            steps: [
              {
                key: 'dc2',
                line: 10,
                text: 'DC2: Add, upload and write documents in place (`63491df`, pushed, 26 Nov) [details](design/evidence/README.md) Packet: `design/packets/dc2.md`. Pictures: `board-pictures/dc2-conflict-1440-board-dark.png`, `board-pictures/dc2-preview-1440-board-dark.png`',
                done: false,
                kind: 'step',
                indent: 0,
                current: true,
              },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, []);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'board-pictures/dc2-conflict-1440-board-dark.png', modifiedAt: isoHoursAgo(0.2), size: 220 },
          { path: 'board-pictures/dc2-preview-1440-board-dark.png', modifiedAt: isoHoursAgo(0.5), size: 220 },
          { path: 'board-pictures/unmentioned.png', modifiedAt: isoHoursAgo(1), size: 220 },
          { path: 'root-shot.png', modifiedAt: isoHoursAgo(2), size: 180 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {});

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  const cpDocs = node(page, 'checkpoint:documents');
  const thumb = cpDocs.locator('button[data-path="board-pictures/dc2-conflict-1440-board-dark.png"]');
  await expect(thumb).toHaveAttribute('aria-label', 'dc2-conflict-1440-board-dark · DC2: Add, upload and write documents in place');
  await expect(thumb).toHaveAttribute('title', 'dc2-conflict-1440-board-dark · DC2: Add, upload and write documents in place');

  const wsThumb = node(page, 'files:workspace').locator('button[data-path="board-pictures/unmentioned.png"]');
  await expect(wsThumb).toHaveAttribute('aria-label', 'unmentioned');
  await expect(wsThumb).toHaveAttribute('title', 'unmentioned');

  // Opening overview thumbnail opens the picture as itself, in its step, with step-scoped 1 / 2 counter.
  await thumb.click();
  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.getByRole('heading', { name: 'dc2-conflict-1440-board-dark', level: 2, exact: true })).toBeVisible();
  await expect(reader.locator('footer')).toContainText('In step: DC2: Add, upload and write documents in place');
  await expect(reader.locator('footer')).not.toContainText(/^board-pictures$/);
  await expect(reader.getByText('1 / 2')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // Opening unattached pictures from Workspace files Area shows In folder / Workspace root.
  await stepIntoArea(page, /Workspace files/);
  await node(page, 'wsfile:board-pictures/unmentioned.png').getByRole('button', { name: 'Open unmentioned' }).click();
  await expect(reader.getByRole('heading', { name: 'unmentioned', level: 2, exact: true })).toBeVisible();
  await expect(reader.locator('footer')).toContainText('In folder: board-pictures');
  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 'root-shot', level: 2, exact: true })).toBeVisible();
  await expect(reader.locator('footer')).toContainText('Workspace root');
});

test('PX1: step picture navigation walks that step’s pictures only in order and survives plan refresh', async ({ page }) => {
  await routeBoard(page);
  let refreshed = false;
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(1) },
        title: 'Step seq test',
        checkpoints: [
          checkpoint('Step Pictures', {
            steps: [
              {
                key: 's1',
                line: 4,
                text: refreshed
                  ? 'First step refreshed: `docs/spec.md`, `board-pictures/s1-first.png`, `board-pictures/s1-second.png`, `board-pictures/s1-third.png`'
                  : 'First step: `docs/spec.md`, `board-pictures/s1-first.png`, `board-pictures/s1-second.png`, `board-pictures/s1-third.png`',
                done: false,
                kind: 'step',
                indent: 0,
                current: true,
              },
              {
                key: 's2',
                line: 5,
                text: 'Second step: `board-pictures/s2-other.png`',
                done: false,
                kind: 'step',
                indent: 0,
              },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, []);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'docs/spec.md', modifiedAt: isoHoursAgo(1), size: 120 },
          { path: 'board-pictures/s1-first.png', modifiedAt: isoHoursAgo(4), size: 220 },
          { path: 'board-pictures/s1-second.png', modifiedAt: isoHoursAgo(3), size: 220 },
          { path: 'board-pictures/s1-third.png', modifiedAt: isoHoursAgo(2), size: 220 },
          { path: 'board-pictures/s2-other.png', modifiedAt: isoHoursAgo(0.5), size: 220 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {});

  let nextEvent: 'ping' | 'plan' = 'ping';
  await page.route('**/api/workspace/demo/screen-events**', (route) => {
    const kind = nextEvent;
    nextEvent = 'ping';
    const body = kind === 'plan'
      ? `retry: 150\n\n${frame('plan', { timestamp: new Date().toISOString() }, 'px1-refresh')}`
      : `retry: 150\n\n${PING}`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Step Pictures/);

  await node(page, 'wsfile:step:s1:board-pictures/s1-second.png').getByRole('button', { name: 'Open s1-second' }).click();
  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.getByRole('heading', { name: 's1-second', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('2 / 3')).toBeVisible();
  await expect(reader.locator('footer')).toContainText('In step: First step:');

  // Live plan refresh keeps reader scoped to s1's 3 pictures at 2 / 3.
  refreshed = true;
  nextEvent = 'plan';
  await expect(board(page).locator('#board-area .react-flow__node[data-id="row:step:s1"]')).toContainText('First step refreshed');
  await expect(reader.getByText('2 / 3')).toBeVisible();
  await expect(reader.getByRole('heading', { name: 's1-second', level: 2, exact: true })).toBeVisible();

  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 's1-third', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('3 / 3')).toBeVisible();
  await expect(reader.getByRole('button', { name: /^Next/ })).toBeDisabled();

  await reader.getByRole('button', { name: /^Previous/ }).click();
  await expect(reader.getByRole('heading', { name: 's1-second', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('2 / 3')).toBeVisible();

  await page.keyboard.press('[');
  await expect(reader.getByRole('heading', { name: 's1-first', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('1 / 3')).toBeVisible();
  await expect(reader.getByRole('button', { name: /^Previous/ })).toBeDisabled();
});

test('PX1: duplicate picture path across two steps and two checkpoints opens and walks the clicked card and step', async ({ page }) => {
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(1) },
        title: 'Duplicate pics',
        checkpoints: [
          checkpoint('Alpha Checkpoint', {
            steps: [
              { key: 's1', line: 4, text: 'Step one: `board-pictures/shared.png` and `board-pictures/s1-only.png`', done: false, kind: 'step', indent: 0, current: true },
              { key: 's2', line: 5, text: 'Step two: `board-pictures/shared.png` and `board-pictures/s2-only.png`', done: false, kind: 'step', indent: 0 },
            ],
          }),
          checkpoint('Beta Checkpoint', {
            steps: [
              { key: 'b1', line: 8, text: 'Beta step: `board-pictures/shared.png` and `board-pictures/beta-only.png`', done: false, kind: 'step', indent: 0 },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, []);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'board-pictures/shared.png', modifiedAt: isoHoursAgo(1), size: 220 },
          { path: 'board-pictures/s1-only.png', modifiedAt: isoHoursAgo(2), size: 220 },
          { path: 'board-pictures/s2-only.png', modifiedAt: isoHoursAgo(3), size: 220 },
          { path: 'board-pictures/beta-only.png', modifiedAt: isoHoursAgo(4), size: 220 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {});

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // Overview thumbnail on Beta Checkpoint opens Beta's card & sequence, not Alpha's s1.
  const betaThumb = node(page, 'checkpoint:beta-checkpoint').locator('button[data-path="board-pictures/shared.png"]');
  await betaThumb.click();
  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.locator('footer')).toContainText('In step: Beta step:');
  await expect(reader.getByText('1 / 2')).toBeVisible();
  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 'beta-only', level: 2, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // Inside Alpha Checkpoint, clicking shared in Step two opens s2, highlights s2, and walks s2-only.
  await stepIntoArea(page, /Alpha Checkpoint/);
  const s1Shared = board(page).locator('#board-area .react-flow__node[data-id="wsfile:step:s1:board-pictures/shared.png"]');
  const s2Shared = board(page).locator('#board-area .react-flow__node[data-id="wsfile:step:s2:board-pictures/shared.png"]');
  await s2Shared.getByRole('button', { name: 'Open shared' }).click();

  await expect(s2Shared.locator('article')).toHaveAttribute('aria-current', 'true');
  await expect(s1Shared.locator('article')).not.toHaveAttribute('aria-current', 'true');
  await expect(reader.locator('footer')).toContainText('In step: Step two:');
  await expect(reader.getByText('1 / 2')).toBeVisible();

  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 's2-only', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('2 / 2')).toBeVisible();
});

test('PX1: Markdown picture in a Board reader document opens in reader and Back returns focus to that picture button', async ({ page }) => {
  await routeWorkspaceDocumentReferences(
    page,
    () => ['docs/guide.md', 'docs/linked-target.md', 'board-pictures/diagram.png', 'board-pictures/linked.png'],
    workspace.workspacePath,
  );
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(1) },
        title: 'Markdown pics',
        checkpoints: [
          checkpoint('Guide Checkpoint', {
            steps: [
              { key: 's1', line: 4, text: 'Inspect `docs/guide.md` and `board-pictures/diagram.png`', done: false, kind: 'step', indent: 0, current: true },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, []);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'docs/guide.md', modifiedAt: isoHoursAgo(1), size: 220 },
          { path: 'board-pictures/diagram.png', modifiedAt: isoHoursAgo(0.5), size: 220 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {}, {
    'docs/guide.md': [
      '# Architecture Guide',
      '',
      '![Architecture diagram](../board-pictures/diagram.png)',
      '',
      '[![Linked shot](../board-pictures/linked.png)](linked-target.md)',
      '',
      '![Remote](https://example.com/r.png)',
    ].join('\n'),
  });

  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Guide Checkpoint/);

  await node(page, 'wsfile:step:s1:docs/guide.md').getByRole('button', { name: 'Open guide.md' }).click();
  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.getByRole('heading', { name: 'Architecture Guide' })).toBeVisible();

  const picBtn = reader.getByRole('button', { name: 'Architecture diagram', exact: true });
  await expect(picBtn).toBeVisible();
  await expect(picBtn.locator('img')).toBeVisible();
  await expect(picBtn).toHaveClass(/focus-visible:ring/);
  await expect(reader.getByRole('link').filter({ has: page.locator('button') })).toHaveCount(0);
  await expect(reader.locator('img[src="https://example.com/r.png"]')).toBeVisible();

  await picBtn.focus();
  await picBtn.press('Enter');
  await expect(reader.getByRole('heading', { name: 'diagram', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'diagram', level: 2, exact: true })).toBeFocused();
  const backBtn = reader.getByRole('button', { name: /^Back to / });
  await expect(backBtn).toBeVisible();

  await backBtn.click();
  await expect(reader.getByRole('heading', { name: 'Architecture Guide' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Architecture diagram', exact: true })).toBeFocused();

  await reader.getByRole('button', { name: 'Architecture diagram', exact: true }).press('Enter');
  await expect(reader.getByRole('heading', { name: 'diagram', level: 2, exact: true })).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(reader.getByRole('heading', { name: 'Architecture Guide' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Architecture diagram', exact: true })).toBeFocused();
});

test('PX1 regression: svg step picture stays step-scoped, while commit picture thumbnail walks the full Area list', async ({ page }) => {
  const sha = 'abc1234def5678901234567890abcdef12345678';
  const commitList = [{ repo: 'app', more: 0, commits: [{ sha, author: 'Anna', subject: 'Add svg shot', at: minutesAgo(3) }] }];
  await routeWorkspaceDocumentReferences(
    page,
    () => ['design.md', 'board-pictures/one.png', 'board-pictures/two.svg'],
    workspace.workspacePath,
  );
  await routeBoard(page);
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: commitList }) }));
  await page.route('**/api/workspace/demo/recent-commits', (route) =>
    route.fulfill({ json: { at: new Date().toISOString(), from: isoHoursAgo(24), commits: commitList } }),
  );
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(1) },
        title: 'SVG & commit scope',
        checkpoints: [
          checkpoint('Media Checkpoint', {
            steps: [
              {
                key: 's1',
                line: 4,
                text: 'Capture screenshots (`abc1234`, 26 Nov) Pictures: `board-pictures/one.png`, `board-pictures/two.svg`',
                done: false,
                kind: 'step',
                indent: 0,
                current: true,
              },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, [
    boardDocument('Design spec', {
      filename: 'design.md',
      scope: { checkpoints: ['media-checkpoint'] },
    }),
  ]);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'design.md', modifiedAt: isoHoursAgo(2), size: 120 },
          { path: 'board-pictures/one.png', modifiedAt: isoHoursAgo(1), size: 220 },
          { path: 'board-pictures/two.svg', modifiedAt: isoHoursAgo(0.5), size: 140 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {}, { 'design.md': '# Design Spec\n\nOverview document.' });

  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Media Checkpoint/);

  // 1. Clicking an .svg step picture scopes [ / ] to that step's 2 pictures (skipping Design spec).
  await node(page, 'wsfile:step:s1:board-pictures/two.svg').getByRole('button', { name: 'Open two' }).click();
  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.getByRole('heading', { name: 'two', level: 2, exact: true })).toBeVisible();
  await expect(reader.locator('footer')).toContainText('In step: Capture screenshots');
  await expect(reader.getByText('2 / 2')).toBeVisible();
  await page.keyboard.press('[');
  await expect(reader.getByRole('heading', { name: 'one', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('1 / 2')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // 2. Clicking the commit picture thumbnail walks the full Area list (including Design spec: 2 / 3), not step-only.
  await board(page).locator('#board-area .react-flow__node-commit').getByRole('button', { name: 'View picture: one.png', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'one', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('2 / 3')).toBeVisible();
  await page.keyboard.press('[');
  await expect(reader.getByRole('heading', { name: 'Design spec', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('1 / 3')).toBeVisible();
});

test('PX1 regression: Back restores focus once across layout toggles, and clicking pic 1 after ] in side-by-side opens pic 1', async ({ page }) => {
  await routeWorkspaceDocumentReferences(
    page,
    () => ['docs/guide.md', 'board-pictures/diagram.png', 'board-pictures/first.png', 'board-pictures/second.png'],
    workspace.workspacePath,
  );
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(1) },
        title: 'Reader focus & thumb regression',
        checkpoints: [
          checkpoint('Reader Regression', {
            steps: [
              {
                key: 's1',
                line: 4,
                text: 'Inspect guide and shots Pictures: `board-pictures/first.png`, `board-pictures/second.png`',
                done: false,
                kind: 'step',
                indent: 0,
                current: true,
              },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, [
    boardDocument('Guide doc', {
      filename: 'docs/guide.md',
      scope: { checkpoints: ['reader-regression'] },
    }),
  ]);
  await page.route('**/api/workspace/demo/work/documents/**', (route) =>
    route.fulfill({ json: { content: '# Guide Body\n\n![Architecture diagram](../board-pictures/diagram.png)' } }),
  );
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'docs/guide.md', modifiedAt: isoHoursAgo(2), size: 220 },
          { path: 'board-pictures/diagram.png', modifiedAt: isoHoursAgo(1.5), size: 220 },
          { path: 'board-pictures/first.png', modifiedAt: isoHoursAgo(1), size: 220 },
          { path: 'board-pictures/second.png', modifiedAt: isoHoursAgo(0.5), size: 220 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {}, { 'docs/guide.md': '# Guide Body\n\n![Architecture diagram](../board-pictures/diagram.png)' });

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // 1. After Back restores focus to pic button, toggling to "Show beside the board" does not re-steal focus to pic button.
  await stepIntoArea(page, /Reader Regression/);
  await node(page, 'document:guide-doc').getByRole('button', { name: 'Open Guide doc' }).click();
  const reader = board(page).locator('[data-board-reader]');
  const picBtn = reader.getByRole('button', { name: 'Architecture diagram', exact: true });
  await picBtn.click();
  await expect(reader.getByRole('heading', { name: 'diagram', level: 2, exact: true })).toBeVisible();
  await reader.getByRole('button', { name: /^Back to / }).click();
  await expect(picBtn).toBeFocused();

  await reader.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show beside the board' }).click();
  await expect(reader).toHaveClass(/border-l/);
  await expect(picBtn).not.toBeFocused();
  await expect(reader.locator(':focus')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // 2. Side-by-side layout persists: click overview pic 1 -> press ] to pic 2 -> clicking overview pic 1 opens pic 1 (never closes reader).
  await board(page).getByRole('button', { name: 'Board ›', exact: true }).click();
  await viewAtRest(page);
  const cp = node(page, 'checkpoint:reader-regression');
  const firstThumb = cp.locator('button[data-path="board-pictures/first.png"]');
  await firstThumb.click();
  await expect(reader.getByRole('heading', { name: 'first', level: 2, exact: true })).toBeVisible();
  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 'second', level: 2, exact: true })).toBeVisible();
  await firstThumb.click();
  await expect(reader).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'first', level: 2, exact: true })).toBeVisible();
});

test('PX1 regression: unmatched repository and unindexed pictures from Files, terminal links, and Markdown images drop extensions and keep folder footers', async ({ page }) => {
  await routeWorkspaceDocumentReferences(
    page,
    () => ['docs/guide.md', 'assets/repo-shot.svg', 'unindexed/term-shot.png'],
    workspace.workspacePath,
  );
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(1) },
        title: 'Unmatched picture opens',
        checkpoints: [
          checkpoint('Repo & Files', {
            steps: [
              { key: 's1', line: 4, text: 'Check `board-pictures/indexed.png`', done: false, kind: 'step', indent: 0, current: true },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, []);
  await routeCards(page, boardFile({ cards: [] }));
  let filesCalls = 0;
  await page.route('**/api/workspace/demo/files', (route) => {
    filesCalls += 1;
    return route.fulfill({
      json: {
        files: filesCalls === 1
          ? [{ path: 'board-pictures/indexed.png', modifiedAt: isoHoursAgo(1), size: 220 }]
          : [
              { path: 'board-pictures/indexed.png', modifiedAt: isoHoursAgo(1), size: 220 },
              { path: 'unindexed/extra-shot.png', modifiedAt: isoHoursAgo(0.5), size: 220 },
            ],
        truncated: false,
        errors: [],
      },
    });
  });
  await page.route('**/api/workspace/demo/changes?include=all', (route) =>
    route.fulfill({
      json: {
        changes: [
          {
            repoName: 'api',
            repoPath: '/repos/api',
            files: [
              { file: 'assets/repo-shot.svg', type: 'unchanged' },
              { file: 'docs/guide.md', type: 'unchanged' },
            ],
          },
        ],
      },
    }),
  );
  await routeDocumentViews(page, {}, {
    'docs/guide.md': '# Repo Guide\n\n![Repo diagram](../assets/repo-shot.svg)',
  });
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [{ id: 'term-demo', workspace: 'demo', target: 'claude', label: 'claude', cwd: '/tmp/demo', state: 'running' }],
      targets: [{ id: 'claude', name: 'claude', available: true, reason: null }],
    },
  }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type !== 'attach') return;
      socket.send(JSON.stringify({
        type: 'ready',
        terminal: { id: parsed.id, workspace: parsed.workspace, target: 'claude', label: 'claude', cwd: '/tmp/demo', state: 'running' },
        truncated: false,
      }));
      socket.send(JSON.stringify({ type: 'output', data: 'opened unindexed/term-shot.png\r\n' }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await page.route('**/api/workspace/demo/files/reference?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const reqPath = query.get('path') ?? '';
    const cwd = query.get('cwd') ?? '';
    if (cwd === '/repos/api' || reqPath.includes('repo-shot.svg')) {
      return route.fulfill({
        json: { status: 'found', target: { origin: { kind: 'repository', repoName: 'api', repoPath: '/repos/api' }, file: 'assets/repo-shot.svg', viewer: 'reader' } },
      });
    }
    return route.fulfill({
      json: { status: 'found', target: { origin: { kind: 'workspace', workspacePath: workspace.workspacePath }, file: reqPath, viewer: 'reader' } },
    });
  });

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // 1. Open Board index -> Files: repository picture and unindexed workspace picture drop extensions and show folder footer.
  await page.getByRole('button', { name: 'Board index', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await nav.getByRole('button', { name: 'Files', exact: true }).click();

  await nav.getByRole('button', { name: 'assets/repo-shot.svg Repository · api', exact: true }).click();
  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.getByRole('heading', { name: 'repo-shot', level: 2, exact: true })).toBeVisible();
  await expect(reader.locator('footer')).toContainText('In folder: assets');
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  await nav.getByRole('button', { name: 'unindexed/extra-shot.png Workspace', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'extra-shot', level: 2, exact: true })).toBeVisible();
  await expect(reader.locator('footer')).toContainText('In folder: unindexed');
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // 2. Repository Markdown document -> clicking Markdown image button opens unmatched repo picture without .svg.
  await nav.getByRole('button', { name: 'docs/guide.md Repository · api', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Repo Guide' })).toBeVisible();
  const repoPicBtn = reader.getByRole('button', { name: 'Repo diagram', exact: true });
  await repoPicBtn.click();
  await expect(reader.getByRole('heading', { name: 'repo-shot', level: 2, exact: true })).toBeVisible();
  await expect(reader.locator('footer')).toContainText('In folder: assets');
  await reader.getByRole('button', { name: /^Back to / }).click();
  await expect(repoPicBtn).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // 3. Terminal link to unindexed picture opens via documentRequest without .png and shows folder footer.
  await page.getByTestId('view-mode-split').click();
  const pane = page.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  const cell = await pane.locator('.xterm-screen').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const first = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
    return { x: bounds.x + 80, y: (first?.y ?? bounds.y) + (first?.height ?? 17) * 0.5 };
  });
  await pane.locator('.xterm-helper-textarea').focus();
  await page.mouse.move(cell.x + 120, cell.y + 30);
  await page.mouse.move(cell.x, cell.y);
  await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
  await page.mouse.click(cell.x, cell.y);

  await expect(reader.getByRole('heading', { name: 'term-shot', level: 2, exact: true })).toBeVisible();
  await expect(reader.locator('footer')).toContainText('In folder: unindexed');
});

test('PX1 fix1: picture card with a stale step key keeps Area counter and working ] from overview, Board index, and Not tied to a step', async ({ page }) => {
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's-active', by: 'claude', at: minutesAgo(1) },
        title: 'Stale step cards',
        checkpoints: [
          checkpoint('Active Checkpoint', {
            steps: [
              { key: 's-active', line: 4, text: 'Active step', done: false, kind: 'step', indent: 0, current: true },
            ],
          }),
          checkpoint('Real Work Done', {
            done: true,
            steps: [
              { key: 's-done', line: 8, text: 'Current step key', done: true, kind: 'step', indent: 0 },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, []);
  await routeCards(page, boardFile({
    cards: [
      boardFileCard(1, 'board-pictures/commit-reader.png', {
        title: 'Commit reader',
        description: 'board-pictures',
        area: 'checkpoint:real-work-done',
        step: 'c1-deleted-step-key',
        at: minutesAgo(30),
        updatedAt: minutesAgo(30),
      }),
      boardFileCard(2, 'board-pictures/orphan-two.png', {
        title: 'Orphan two',
        description: 'Second orphan picture',
        area: 'checkpoint:real-work-done',
        step: 'c1-deleted-step-key-2',
        at: minutesAgo(20),
        updatedAt: minutesAgo(20),
      }),
      boardFileCard(3, 'board-pictures/loose-three.png', {
        title: 'Loose three',
        description: 'Third loose picture',
        area: 'checkpoint:real-work-done',
        step: undefined,
        at: minutesAgo(10),
        updatedAt: minutesAgo(10),
      }),
    ],
  }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({ json: { files: [], truncated: false, errors: [] } }),
  );
  await routeDocumentViews(page, {});

  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // 1. Expand the done fold and click the Commit reader overview thumbnail.
  await board(page).locator('#board-overview button.board-area-fold').click();
  const doneCard = node(page, 'checkpoint:real-work-done');
  await expect(doneCard).toBeVisible();
  const thumb = doneCard.locator('button[data-path="board-pictures/commit-reader.png"]');
  await expect(thumb).toHaveAttribute('aria-label', 'Commit reader');
  await thumb.click();

  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.getByRole('heading', { name: 'Commit reader', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('1 / 3')).toBeVisible();
  await expect(reader.locator('footer')).toContainText('Real Work Done');
  await expect(reader.locator('footer')).not.toContainText('In step:');
  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 'Orphan two', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('2 / 3')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // 2. Open Commit reader from Board index (Pictures & pages) -> keeps Area counter and working ].
  await page.getByRole('button', { name: 'Board index', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await nav.getByRole('button', { name: 'Read Commit reader in reader', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Commit reader', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('1 / 3')).toBeVisible();
  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 'Orphan two', level: 2, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  // 3. Inside the Area ("Not tied to a step"), opening Orphan two keeps the full Area sequence (2 / 3 -> 3 / 3).
  await board(page).locator('#board-area').getByRole('button', { name: 'Open Orphan two', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Orphan two', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('2 / 3')).toBeVisible();
  await expect(reader.getByRole('button', { name: /^Next/ })).toBeEnabled();
  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 'Loose three', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('3 / 3')).toBeVisible();
});

test('PX1 fix1: mixed step (2 cards + 1 step file) opens leftmost card at 1 / 3 and ] walks left to right', async ({ page }) => {
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(1) },
        title: 'Mixed step order',
        checkpoints: [
          checkpoint('Mixed Checkpoint', {
            steps: [
              {
                key: 's1',
                line: 4,
                text: 'Mixed step Pictures: `board-pictures/step-file.png`',
                done: false,
                kind: 'step',
                indent: 0,
                current: true,
              },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, []);
  await routeCards(page, boardFile({
    cards: [
      boardFileCard(1, 'board-pictures/older.png', {
        title: 'Older card',
        description: 'Older unpinned card',
        area: 'checkpoint:mixed-checkpoint',
        step: 's1',
        pinned: false,
        at: minutesAgo(30),
        updatedAt: minutesAgo(30),
      }),
      boardFileCard(2, 'board-pictures/pinned.png', {
        title: 'Pinned card',
        description: 'Newer pinned card',
        area: 'checkpoint:mixed-checkpoint',
        step: 's1',
        pinned: true,
        at: minutesAgo(10),
        updatedAt: minutesAgo(10),
      }),
    ],
  }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'board-pictures/step-file.png', modifiedAt: isoHoursAgo(1), size: 220 },
          { path: 'board-pictures/older.png', modifiedAt: isoHoursAgo(2), size: 220 },
          { path: 'board-pictures/pinned.png', modifiedAt: isoHoursAgo(3), size: 220 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {});

  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Mixed Checkpoint/);

  const rowOrder = await board(page).locator('#board-area .react-flow__node-file').evaluateAll((nodes) =>
    nodes
      .map((el) => ({
        id: el.getAttribute('data-id') ?? '',
        left: Math.round(el.getBoundingClientRect().left),
        title: el.querySelector('h2')?.textContent?.trim() ?? '',
      }))
      .sort((a, b) => a.left - b.left),
  );
  expect(rowOrder.map((entry) => entry.title)).toEqual(['Pinned card', 'Older card', 'step-file']);

  await board(page).locator(`#board-area .react-flow__node[data-id="${rowOrder[0]!.id}"] button[data-card-main]`).click();
  const reader = board(page).locator('[data-board-reader]');
  await expect(reader.getByRole('heading', { name: 'Pinned card', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('1 / 3')).toBeVisible();

  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 'Older card', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('2 / 3')).toBeVisible();

  await page.keyboard.press(']');
  await expect(reader.getByRole('heading', { name: 'step-file', level: 2, exact: true })).toBeVisible();
  await expect(reader.getByText('3 / 3')).toBeVisible();
  await expect(reader.getByRole('button', { name: /^Next/ })).toBeDisabled();
});

test('PX1 fix1: self-link after Back from Markdown picture does not pull focus back to the picture', async ({ page }) => {
  await routeWorkspaceDocumentReferences(
    page,
    () => ['docs/guide.md', 'board-pictures/diagram.png'],
    workspace.workspacePath,
  );
  await routeBoard(page);
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        now: { key: 's1', by: 'claude', at: minutesAgo(1) },
        title: 'Self-link focus after Back',
        checkpoints: [
          checkpoint('Guide Checkpoint', {
            steps: [
              { key: 's1', line: 4, text: 'Inspect `docs/guide.md`', done: false, kind: 'step', indent: 0, current: true },
            ],
          }),
        ],
      }),
    }),
  );
  await routeWork(page, []);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) =>
    route.fulfill({
      json: {
        files: [
          { path: 'docs/guide.md', modifiedAt: isoHoursAgo(1), size: 220 },
          { path: 'board-pictures/diagram.png', modifiedAt: isoHoursAgo(0.5), size: 220 },
        ],
        truncated: false,
        errors: [],
      },
    }),
  );
  await routeDocumentViews(page, {}, {
    'docs/guide.md': [
      '# Architecture Guide',
      '',
      'Read [Self link](guide.md).',
      '',
      '![Architecture diagram](../board-pictures/diagram.png)',
    ].join('\n'),
  });

  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Guide Checkpoint/);

  await node(page, 'wsfile:step:s1:docs/guide.md').getByRole('button', { name: 'Open guide.md' }).click();
  const reader = board(page).locator('[data-board-reader]');
  const picBtn = reader.getByRole('button', { name: 'Architecture diagram', exact: true });
  await picBtn.click();
  await expect(reader.getByRole('heading', { name: 'diagram', level: 2, exact: true })).toBeVisible();

  await reader.getByRole('button', { name: /^Back to / }).click();
  await expect(picBtn).toBeFocused();

  await reader.getByRole('link', { name: 'Self link', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Architecture Guide' })).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'guide.md', level: 2, exact: true })).toBeFocused();
  await expect(picBtn).not.toBeFocused();
});
