import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  boardFile,
  boardFileCard,
  checkpoint,
  planFile,
  step,
  whatsNew,
} from './planData';

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

const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
const readerTitle = (page: Page, name: string) => reader(page).getByRole('heading', { name, level: 2, exact: true });
const moreButton = (page: Page) => reader(page).getByRole('button', { name: 'More actions', exact: true });
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

async function stepIntoArea(page: Page, name: string | RegExp = /Reports export to CSV/) {
  const areaBtn = board(page).locator('.board-overview-plane button.board-area').filter({ hasText: name });
  await areaBtn.click();
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toBeVisible();
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const FIT_RELAY_SNIPPET = `<script>(function(){addEventListener('keydown',function(event){if(event.key==='Escape'&&!event.defaultPrevented)parent.postMessage('contextspace:escape','*')})})()</script>`;

interface SetupBrowsingBoardOptions {
  htmlFile?: string;
  htmlContent?: string;
  subresources?: Record<string, { contentType: string; body: string | Buffer }>;
}

async function setupBrowsingBoard(page: Page, options: SetupBrowsingBoardOptions = {}) {
  const fileName = options.htmlFile || 'overview.html';
  const htmlContent = options.htmlContent || `<!doctype html>
<html>
<head>
  ${FIT_RELAY_SNIPPET}
  <title>Overview Page</title>
  <link rel="stylesheet" href="./style.css">
  <script type="module" src="./module.js"></script>
</head>
<body>
  <h1 id="heading">Report Overview</h1>
  <img id="logo" src="./img.png" alt="Test Logo" width="10" height="10" />
  <div id="data-container">Pending Data</div>
  <a id="link-page2" href="./page2.html">Go to Page 2</a>
  <button id="escape-trigger" type="button">Click for Escape</button>
  <script>
    fetch('./data.json')
      .then(r => r.json())
      .then(d => { document.getElementById('data-container').textContent = d.message; })
      .catch(e => { document.getElementById('data-container').textContent = 'Fetch failed'; });
    
    window.testApiRefusal = async () => {
      try {
        const res = await fetch('/api/workspaces');
        return res.status;
      } catch (err) {
        return 'network_error';
      }
    };

    window.testPostEditorRefusal = async () => {
      try {
        const res = await fetch('/api/open-editor', { method: 'POST', body: '{}' });
        return res.status;
      } catch (err) {
        return 'network_error';
      }
    };

    window.testParentAccess = () => {
      try {
        return parent.document.title;
      } catch (err) {
        return 'blocked';
      }
    };
  </script>
</body>
</html>`;

  const subresources = options.subresources || {
    'style.css': {
      contentType: 'text/css',
      body: '#heading { color: rgb(18, 52, 86); font-size: 24px; }',
    },
    'img.png': {
      contentType: 'image/png',
      body: TINY_PNG,
    },
    'module.js': {
      contentType: 'application/javascript',
      body: 'window.moduleExecuted = true; const h = document.getElementById("heading"); if (h) h.dataset.module = "loaded";',
    },
    'data.json': {
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Loaded JSON Data Successfully' }),
    },
    'page2.html': {
      contentType: 'text/html; charset=UTF-8',
      body: '<!doctype html><html><body><h1>Page 2 Content</h1></body></html>',
    },
  };

  await page.addInitScript(() => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
  });

  // Server security boundary: refuse cross-site or opaque origin (Origin: null) requests to /api/*
  await page.route('**/api/**', async (route) => {
    const headers = route.request().headers();
    const secFetchSite = headers['sec-fetch-site'];
    const origin = headers['origin'];
    if (secFetchSite === 'cross-site' || origin === 'null') {
      return route.fulfill({ status: 403, json: { error: 'Forbidden cross-site request.' } });
    }
    return route.fallback();
  });

  // Mock plan
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        file: 'PLAN.md',
        source: 'file',
        title: 'Reports CSV export',
        checkpoints: [
          checkpoint('Reports export to CSV', {
            steps: [
              step('HTML overview report and assets'),
            ],
          }),
        ],
      }),
    }),
  );

  await page.route('**/api/workspace/demo/work', (route) =>
    route.fulfill({
      json: {
        guidance: {
          version: 1,
          revision: 1,
          workType: 'feature',
          size: 'standard',
          assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' },
          documents: [],
        },
        lifecycle: null,
        assignment: '',
        sharedDocuments: [],
      },
    }),
  );

  await page.route('**/api/workspace/demo/documents', (route) =>
    route.fulfill({
      json: {
        documents: [],
        folders: [],
      },
    }),
  );

  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name === 'PLAN.md') {
      return route.fulfill({
        json: {
          name: 'PLAN.md',
          kind: 'markdown',
          content: '# Reports CSV export\n\nPlan documentation content.',
          size: 100,
          modifiedAt: new Date().toISOString(),
        },
      });
    }
    return route.fulfill({
      json: {
        name,
        kind: 'html',
        size: 200,
        modifiedAt: new Date().toISOString(),
      },
    });
  });

  // Mock board with file card
  await page.route('**/api/workspace/demo/board', (route) =>
    route.fulfill({
      json: boardFile({
        cards: [
          boardFileCard(1, fileName, {
            title: 'Overview Report',
            text: 'Overview page for export results.',
            step: 'html-overview-report-and-assets',
          }),
        ],
      }),
    }),
  );

  // Mock news
  await page.route('**/api/workspace/demo/news', (route) =>
    route.fulfill({
      json: whatsNew({
        plan: {
          items: [{ author: 'claude', summary: 'Added overview report card', when: new Date().toISOString() }],
          more: 0,
        },
      }),
    }),
  );

  // Mock view link token endpoint
  const mockToken = 'mocktoken1234567890abcdef1234567890abcdef';
  await page.route('**/api/workspace/demo/documents/view-link', async (route) => {
    const postData = JSON.parse(route.request().postData() || '{}');
    const name = postData.name || fileName;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: mockToken,
        url: `/view/${mockToken}/${name}`,
        scope: '',
      }),
    });
  });

  // Mock /view/<token>/<subpath>
  await page.route(`**/view/${mockToken}/**`, async (route) => {
    const url = new URL(route.request().url());
    const pathSegments = url.pathname.replace(`/view/${mockToken}/`, '');

    if (pathSegments === fileName) {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=UTF-8',
        headers: {
          'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        },
        body: htmlContent,
      });
    }

    if (subresources[pathSegments]) {
      const res = subresources[pathSegments];
      return route.fulfill({
        status: 200,
        contentType: res.contentType,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        },
        body: res.body,
      });
    }

    return route.fulfill({ status: 404, body: 'Not Found' });
  });

  await page.goto('/#/workspaces/demo/board');
  await expect(board(page)).toBeVisible();
}

test.describe('Board Browsing S2 (Browser Reader)', () => {
  test('opens HTML document in iframe via /view and renders relative styles, images, modules and data', async ({ page }) => {
    await setupBrowsingBoard(page);
    await stepIntoArea(page, /Reports export to CSV/);

    const openBtn = board(page).getByRole('button', { name: 'Open Overview Report' });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    await expect(reader(page)).toBeVisible();
    await expect(readerTitle(page, 'Overview Report')).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview of overview.html"]');
    await expect(frame.locator('#heading')).toBeVisible();
    await expect(frame.locator('#heading')).toHaveText('Report Overview');

    // 1. Relative style.css loaded and applied
    await expect(frame.locator('#heading')).toHaveCSS('color', 'rgb(18, 52, 86)');

    // 2. Relative image loaded
    const img = frame.locator('#logo');
    await expect(img).toBeVisible();
    await expect.poll(async () => {
      return img.evaluate((el: HTMLImageElement) => el.naturalWidth);
    }).toBeGreaterThan(0);

    // 3. Module script executed
    await expect.poll(async () => {
      return frame.locator('#heading').evaluate((el) => el.getAttribute('data-module'));
    }).toBe('loaded');

    // 4. fetch('./data.json') resolved successfully
    await expect(frame.locator('#data-container')).toHaveText('Loaded JSON Data Successfully');

    // 5. Link to relative page exists
    const link = frame.locator('#link-page2');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', './page2.html');
  });

  test('sandbox boundary keeps opaque origin: parent access throws and /api is refused', async ({ page }) => {
    await setupBrowsingBoard(page);
    await stepIntoArea(page, /Reports export to CSV/);

    await board(page).getByRole('button', { name: 'Open Overview Report' }).click();
    await expect(reader(page)).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview of overview.html"]');
    await expect(frame.locator('#heading')).toBeVisible();

    // Verify parent.document access is blocked
    const parentAccessResult = await frame.locator('body').evaluate(() => {
      return (window as any).testParentAccess();
    });
    expect(parentAccessResult).toBe('blocked');

    // Verify cross-site /api/workspaces is refused
    const apiResult = await frame.locator('body').evaluate(() => {
      return (window as any).testApiRefusal();
    });
    expect(apiResult === 403 || apiResult === 'network_error').toBe(true);

    // Verify cross-site POST to /api/open-editor is refused
    const postResult = await frame.locator('body').evaluate(() => {
      return (window as any).testPostEditorRefusal();
    });
    expect(postResult === 403 || postResult === 'network_error').toBe(true);
  });

  test('loads a large HTML page (> 1 MB) without preview limit refusal', async ({ page }) => {
    // Generate 2 MB HTML to exceed 1 MB MAX_TEXT_BYTES preview limit
    const largeLine = '<p>Large content block that repeats to fill size quota.</p>\n';
    const repeatCount = Math.floor((2 * 1024 * 1024) / largeLine.length);
    const bigHtml = `<!doctype html><html><head><title>Big Page</title></head><body><h1>Big HTML Page (2MB)</h1><div id="content">${largeLine.repeat(repeatCount)}</div></body></html>`;

    await setupBrowsingBoard(page, {
      htmlFile: 'big-report.html',
      htmlContent: bigHtml,
    });
    await stepIntoArea(page, /Reports export to CSV/);

    await board(page).getByRole('button', { name: 'Open Overview Report' }).click();
    await expect(reader(page)).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview of big-report.html"]');
    await expect(frame.getByRole('heading', { name: 'Big HTML Page (2MB)' })).toBeVisible({ timeout: 15000 });
  });

  test('pressing Escape inside the iframe sends contextspace:escape and closes reader', async ({ page }) => {
    await setupBrowsingBoard(page);
    await stepIntoArea(page, /Reports export to CSV/);

    await board(page).getByRole('button', { name: 'Open Overview Report' }).click();
    await expect(reader(page)).toBeVisible();

    const frame = page.frameLocator('iframe[title="Preview of overview.html"]');
    await expect(frame.locator('#escape-trigger')).toBeVisible();

    // Click inside frame to give it focus
    await frame.locator('#escape-trigger').click();

    // Press Escape
    await page.keyboard.press('Escape');

    // Reader should close cleanly
    await expect(reader(page)).toHaveCount(0);
  });

  test('toggles between rendered view and raw source, and provides Open in browser link', async ({ page }) => {
    await setupBrowsingBoard(page);
    await stepIntoArea(page, /Reports export to CSV/);

    await board(page).getByRole('button', { name: 'Open Overview Report' }).click();
    await expect(reader(page)).toBeVisible();

    // Check ⋯ menu for "Open in browser" link pointing to /view/
    await moreButton(page).click();
    const openInBrowserItem = menuItem(page, 'Open in browser');
    await expect(openInBrowserItem).toBeVisible();
    const href = await openInBrowserItem.evaluate((el) => el.getAttribute('href'));
    expect(href).toContain('/view/mocktoken1234567890abcdef1234567890abcdef/overview.html');

    // Toggle "View source"
    const viewSourceItem = menuItem(page, 'View source');
    await expect(viewSourceItem).toBeVisible();
    await viewSourceItem.click();

    // Should display <pre> with raw HTML source
    const rawPre = reader(page).locator('pre');
    await expect(rawPre).toBeVisible();
    await expect(rawPre).toContainText('Report Overview');
    await expect(rawPre).toContainText('<link rel="stylesheet" href="./style.css">');

    // Toggle back to "View page"
    await moreButton(page).click();
    const viewPageItem = menuItem(page, 'View page');
    await expect(viewPageItem).toBeVisible();
    await viewPageItem.click();

    // Back to iframe
    await expect(reader(page).locator('iframe[title="Preview of overview.html"]')).toBeVisible();
  });
});
