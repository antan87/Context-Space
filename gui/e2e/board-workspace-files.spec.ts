import { test, expect } from './fixtures';
import {
  board,
  boardEvent,
  frame,
  minutesAgo,
  node,
  PING,
  PICTURE,
  routeBoard,
  routeCards,
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
      json: { name, kind: name.endsWith('.md') ? 'markdown' : 'text', modifiedAt: isoHoursAgo(2), size: 150, content: `# File ${name}` },
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
