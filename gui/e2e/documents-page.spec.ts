import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { frame, PING, PICTURE, STREAM_HEAD, terminal } from './boardHelpers';
import { checkpoint, planFile, step } from './planData';

const OLD = {
  id: 'old',
  branchName: 'old',
  name: 'Archived Canvas',
  description: 'Finished earlier',
  mode: 'in-place',
  repos: ['/dev/api'],
  assistants: [],
  workspacePath: '/ws/old',
  createdAt: '2026-06-01T00:00:00.000Z',
  archivedAt: '2026-09-28T10:00:00.000Z',
  archive: { archivedAt: '2026-09-28T10:00:00.000Z', previousMode: 'in-place', parked: false, repos: [] },
};

const DEMO = {
  id: 'demo',
  branchName: 'demo',
  name: 'New canvas interaction',
  description: 'Folders and previews',
  mode: 'worktree',
  repos: ['/dev/NexusFlow'],
  assistants: [],
  workspacePath: '/ws/demo',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function buildSampleCatalog(overrides: { extraItems?: Array<Record<string, unknown>> } = {}) {
  const items = [
    {
      path: 'PLAN.md',
      name: 'PLAN.md',
      folder: '',
      kind: 'markdown',
      size: 1420,
      modifiedAt: hoursAgo(1),
      title: 'New canvas interaction',
      excerpt: 'One board where people and AIs keep the plan, documents, pictures, and commits together.',
      evidence: false,
    },
    {
      path: 'AGENTS.md',
      name: 'AGENTS.md',
      folder: '',
      kind: 'markdown',
      size: 980,
      modifiedAt: hoursAgo(4),
      title: 'Workspace agent guide',
      excerpt: 'Repos, plan rules, lessons from earlier sessions, and where to look.',
      evidence: false,
    },
    {
      path: 'design/plans/workspace-db.md',
      name: 'workspace-db.md',
      folder: 'design/plans',
      kind: 'markdown',
      size: 2100,
      modifiedAt: hoursAgo(2),
      title: 'Workspace database in SQLite',
      excerpt: 'Board data moves to SQLite so concurrent edits never collide.',
      evidence: false,
    },
    {
      path: 'design/mocks/documents.html',
      name: 'documents.html',
      folder: 'design/mocks',
      kind: 'html',
      size: 3200,
      modifiedAt: hoursAgo(3),
      title: 'Documents by folder mock',
      excerpt: 'Folders first, titles and previews, evidence folded away.',
      evidence: false,
    },
    {
      path: 'board-pictures/root-1440.png',
      name: 'root-1440.png',
      folder: 'board-pictures',
      kind: 'image',
      size: 12_400,
      modifiedAt: hoursAgo(0.5),
      title: 'Root 1440',
      excerpt: '',
      evidence: false,
    },
    {
      path: 'board-pictures/split-1280.png',
      name: 'split-1280.png',
      folder: 'board-pictures',
      kind: 'image',
      size: 11_800,
      modifiedAt: hoursAgo(2.5),
      title: 'Split 1280',
      excerpt: '',
      evidence: false,
    },
    {
      path: 'design/dc1-before.log',
      name: 'dc1-before.log',
      folder: 'design',
      kind: 'text',
      size: 512,
      modifiedAt: hoursAgo(0.2),
      title: 'Dc1 before',
      excerpt: '',
      evidence: true,
    },
    {
      path: 'design/evidence/dc1-run/dc1-report.md',
      name: 'dc1-report.md',
      folder: 'design/evidence/dc1-run',
      kind: 'markdown',
      size: 1800,
      modifiedAt: hoursAgo(0.1),
      title: 'Dc1 report',
      excerpt: '',
      evidence: true,
    },
    ...(overrides.extraItems ?? []),
  ];

  return {
    items,
    folders: [
      {
        path: 'board-pictures',
        name: 'board-pictures',
        parent: '',
        evidence: false,
        summary: 'Pictures of the app, each slice',
        folderCount: 0,
        docCount: 0,
        pictureCount: 2,
        evidenceCount: 0,
      },
      {
        path: 'design',
        name: 'design',
        parent: '',
        evidence: false,
        summary: 'Plans, packets, mocks and the look',
        folderCount: 2,
        docCount: 2,
        pictureCount: 0,
        evidenceCount: 2,
      },
      {
        path: 'design/plans',
        name: 'plans',
        parent: 'design',
        evidence: false,
        summary: 'Reviewed architecture plans',
        folderCount: 0,
        docCount: 1,
        pictureCount: 0,
        evidenceCount: 0,
      },
      {
        path: 'design/mocks',
        name: 'mocks',
        parent: 'design',
        evidence: false,
        summary: '',
        folderCount: 0,
        docCount: 1,
        pictureCount: 0,
        evidenceCount: 0,
      },
      {
        path: 'design/evidence',
        name: 'evidence',
        parent: 'design',
        evidence: true,
        summary: '',
        folderCount: 0,
        docCount: 0,
        pictureCount: 0,
        evidenceCount: 1,
      },
      {
        path: 'design/evidence/dc1-run',
        name: 'dc1-run',
        parent: 'design/evidence',
        evidence: true,
        summary: '',
        folderCount: 0,
        docCount: 0,
        pictureCount: 0,
        evidenceCount: 1,
      },
    ],
    recent: ['PLAN.md', 'design/plans/workspace-db.md', 'design/mocks/documents.html', 'AGENTS.md'],
  };
}

async function mockCatalogAndPreviews(page: Page, wsId = 'demo', getCatalog = () => buildSampleCatalog()) {
  await page.route(`**/api/workspace/${wsId}/plan`, (route) => route.fulfill({ json: planFile() }));
  await page.route(`**/api/workspace/${wsId}/documents/catalog`, (route) => route.fulfill({ json: getCatalog() }));
  await page.route(`**/api/workspace/${wsId}/documents/preview?*`, (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name.endsWith('.html')) {
      return route.fulfill({
        json: {
          name,
          kind: 'html',
          size: 3200,
          modifiedAt: hoursAgo(3),
          content: '<!doctype html><html><body><h1>Mock Preview</h1><p>Interactive HTML page</p></body></html>',
        },
      });
    }
    return route.fulfill({
      json: {
        name,
        kind: name.endsWith('.md') ? 'markdown' : 'text',
        size: 1420,
        modifiedAt: hoursAgo(1),
        content: `# Live preview for ${name}\n\nDetailed preview body for **${name}**. Read [the SQLite plan](design/plans/workspace-db.md).`,
      },
    });
  });
  await page.route(`**/api/workspace/${wsId}/documents/file?*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }),
  );
}

async function assertReadableAndPressable(region: Locator) {
  const issues = await region.evaluate((root) => {
    const smallText: string[] = [];
    const smallTargets: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const el = node.parentElement;
      if (!el || !node.textContent?.trim()) continue;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !r.width || !r.height || el.closest('.sr-only')) continue;
      let scale = 1;
      for (let ancestor: Element | null = el; ancestor; ancestor = ancestor.parentElement) {
        const transform = getComputedStyle(ancestor).transform;
        if (transform !== 'none') scale *= new DOMMatrixReadOnly(transform).a;
      }
      const px = parseFloat(style.fontSize) * scale;
      if (px < 11.95) smallText.push(`${px.toFixed(1)}px "${node.textContent.trim().slice(0, 24)}"`);
    }
    for (const control of root.querySelectorAll<HTMLElement>('button, a[href], input, [role="button"]')) {
      const style = getComputedStyle(control);
      if (style.display === 'none' || style.visibility === 'hidden' || control.closest('[hidden], [inert]')) continue;
      if (control.tagName === 'A' && style.display === 'inline') continue;
      const r = control.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (r.width < 23.95 || r.height < 23.95) {
        const label = control.getAttribute('aria-label') || control.textContent?.trim() || control.tagName;
        smallTargets.push(`${Math.round(r.width)}x${Math.round(r.height)} "${label.slice(0, 30)}"`);
      }
    }
    return { smallText, smallTargets };
  });
  expect(issues.smallText, `text < 12px: ${issues.smallText.join(', ')}`).toEqual([]);
  expect(issues.smallTargets, `target < 24px: ${issues.smallTargets.join(', ')}`).toEqual([]);
}

const docsRegion = (page: Page) => page.getByRole('region', { name: 'Documents', exact: true });
const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });

test.describe('Documents page', () => {
  test.use({
    workspacesData: [[DEMO, OLD], { option: true }],
    viewport: { width: 1440, height: 900 },
  });

  test('navigates via Docs rail, renders Changed lately, folders, doc cards, and folds evidence until Show them', async ({ page }) => {
    await mockCatalogAndPreviews(page);
    await page.goto('/#/workspaces/demo/overview');
    await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/documents$/);
    await expect(workspaceNav(page).getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('aria-current', 'page');

    const docs = docsRegion(page);
    await expect(docs).toBeVisible();
    await expect(docs.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
    await expect(docs.getByRole('heading', { name: /Changed lately/ })).toBeVisible();
    await expect(docs.getByRole('button', { name: /New canvas interaction/ }).first()).toBeVisible();

    // Folder cards with summary and non-zero counts
    const designCard = docs.getByRole('button', { name: /^design\b/ });
    await expect(designCard).toContainText('Plans, packets, mocks and the look');
    await expect(designCard).toContainText('2 folders · 2 documents');

    // Navigate into design/
    await designCard.click();
    const crumbs = docs.getByRole('navigation', { name: 'Breadcrumbs' });
    await expect(crumbs.getByRole('button', { name: 'All folders' })).toBeVisible();
    await expect(crumbs.getByRole('button', { name: 'design' })).toHaveAttribute('aria-current', 'page');

    // design/evidence is folded by default
    await expect(docs.getByRole('button', { name: /^evidence/ })).toHaveCount(0);
    await expect(docs.getByText(/Evidence and logs/)).toBeVisible();
    await expect(docs.getByText(/2 files/)).toBeVisible();

    await docs.getByRole('button', { name: 'Show them', exact: true }).click();
    await expect(docs.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
    await expect(docs.getByRole('button', { name: /^evidence\b/ })).toBeVisible();
    await expect(docs.getByRole('button', { name: /Dc1 before/ })).toBeVisible();

    await assertReadableAndPressable(docs);
  });

  test('shows full search placeholder at 1440px, clears search on breadcrumb click, and preserves focus through internal reader links', async ({ page }) => {
    let catalog = buildSampleCatalog();
    await mockCatalogAndPreviews(page, 'demo', () => catalog);
    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);

    const search = docs.getByPlaceholder('Find a document by title, words or path');
    await expect(search).toBeVisible();
    const searchFits = await search.evaluate((el) => (el as HTMLInputElement).scrollWidth <= (el as HTMLInputElement).clientWidth + 1);
    expect(searchFits).toBe(true);

    // Search inside a subfolder, then click a breadcrumb -> exits search and navigates cleanly
    await docs.getByRole('button', { name: /^design\b/ }).click();
    await search.fill('SQLite');
    await expect(docs.getByRole('heading', { name: /Found 1/ })).toBeVisible();
    await assertReadableAndPressable(docs);

    await docs.getByRole('navigation', { name: 'Breadcrumbs' }).getByRole('button', { name: 'All folders' }).click();
    await expect(search).toHaveValue('');
    await expect(docs.getByRole('heading', { name: /Changed lately/ })).toBeVisible();

    // Open PLAN.md in reader, follow internal Markdown link, and Escape returns focus to original opener
    const planCard = docs.locator('button[data-doc-path="PLAN.md"]').last();
    await planCard.click();
    const openBtn = docs.locator('aside').getByRole('button', { name: 'Open in reader', exact: true });
    await openBtn.click();

    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    await assertReadableAndPressable(docs);
    await reader.getByRole('link', { name: 'the SQLite plan' }).click();
    await expect(reader).toContainText('Live preview for design/plans/workspace-db.md');

    // Background refetch updating mtime of the currently open reader document keeps it mounted without flashing
    catalog = {
      ...catalog,
      items: catalog.items.map((item) =>
        item.path === 'design/plans/workspace-db.md' ? { ...item, modifiedAt: new Date().toISOString() } : item,
      ),
    };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(reader).toContainText('Live preview for design/plans/workspace-db.md');

    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect(openBtn).toBeFocused();
  });

  test('Ask in CLI keeps Documents open beside chat and prefills the active AI session', async ({ page }) => {
    const sent: string[] = [];
    const claudeTerm = { ...terminal, target: 'claude', label: 'claude' };
    await page.addInitScript(() => {
      localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: true, percent: 48 }));
    });
    await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
    await page.route('**/api/terminals/running', (route) => route.fulfill({ json: { terminals: [claudeTerm] } }));
    await page.route('**/api/terminals/demo/status', (route) => route.fulfill({
      json: { available: true, sessions: [claudeTerm], targets: [{ id: 'claude', name: 'Claude', available: true, reason: null }] },
    }));
    await page.routeWebSocket('**/ws/terminal', (socket) => {
      socket.onMessage((msg) => {
        const parsed = JSON.parse(String(msg));
        if (parsed.type === 'attach') {
          socket.send(JSON.stringify({ type: 'ready', terminal: claudeTerm, truncated: false }));
          socket.send(JSON.stringify({ type: 'replayed' }));
        } else if (parsed.type === 'input' && typeof parsed.data === 'string') {
          sent.push(parsed.data);
        }
      });
    });
    await mockCatalogAndPreviews(page);
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByRole('button', { name: 'Ask in CLI' }).click();

    await expect(page).toHaveURL(/#\/workspaces\/demo\/documents$/);
    await expect(page.getByRole('region', { name: 'CLI Chat', exact: true })).toBeVisible();
    await expect.poll(() => sent.join('')).toContain('About PLAN.md');
  });

  test('steps into folders, loads 16:9 pictures, and navigates back via breadcrumbs', async ({ page }) => {
    await mockCatalogAndPreviews(page);
    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);

    await docs.getByRole('button', { name: /board-pictures/ }).click();
    const crumbs = docs.getByRole('navigation', { name: 'Breadcrumbs' });
    await expect(crumbs.getByRole('button', { name: 'board-pictures' })).toHaveAttribute('aria-current', 'page');

    const picsHeading = docs.getByRole('heading', { name: /Pictures/ });
    await expect(picsHeading).toBeVisible();
    const img = docs.locator('img').first();
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await crumbs.getByRole('button', { name: 'All folders' }).click();
    await expect(docs.getByRole('heading', { name: /Changed lately/ })).toBeVisible();
    await expect(crumbs.getByRole('button', { name: 'All folders' })).toHaveAttribute('aria-current', 'page');
  });

  test('selects doc for side preview at 1440x900, opens reader, and Escape returns focus to opener', async ({ page }) => {
    await mockCatalogAndPreviews(page);
    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);

    const planCard = docs.locator('button[data-doc-path="PLAN.md"]').last();
    await planCard.click();
    await expect(planCard).toHaveAttribute('aria-pressed', 'true');

    const previewPane = docs.locator('aside');
    await expect(previewPane).toBeVisible();
    await expect(previewPane).toContainText('Live preview for PLAN.md');
    await expect(previewPane.getByRole('button', { name: 'Ask in CLI' })).toBeVisible();

    const openBtn = previewPane.getByRole('button', { name: 'Open in reader', exact: true });
    await openBtn.click();

    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    await expect(reader).toContainText('Live preview for PLAN.md');
    await expect(reader.getByRole('button', { name: 'Close document' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect(openBtn).toBeFocused();

    await assertReadableAndPressable(docs);
  });

  test('searches across folders, refreshes via SSE files event without window focus, and skips fetches while hidden', async ({ page }) => {
    let catalog = buildSampleCatalog();
    let catalogRequests = 0;
    let filesRequests = 0;
    let sseRequests = 0;
    let releaseSse: () => void = () => {};
    let sseReleased = false;
    const sseGate = new Promise<void>((resolve) => {
      releaseSse = () => {
        sseReleased = true;
        resolve();
      };
    });

    await mockCatalogAndPreviews(page, 'demo', () => catalog);
    await page.route('**/api/workspace/demo/documents/catalog', (route) => {
      catalogRequests += 1;
      return route.fulfill({ json: catalog });
    });
    await page.route('**/api/workspace/demo/files', (route) => {
      filesRequests += 1;
      return route.fulfill({ json: { files: [], truncated: false, errors: [] } });
    });
    await page.route('**/api/workspace/demo/screen-events**', async (route) => {
      sseRequests += 1;
      if (sseReleased) {
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `${STREAM_HEAD}${PING}` }).catch(() => {});
      }
      await sseGate;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `${STREAM_HEAD}${frame('files', { timestamp: new Date().toISOString() }, 'f1')}`,
      }).catch(() => {});
    });

    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);
    const search = docs.getByPlaceholder('Find a document by title, words or path');
    await search.fill('SQLite');
    await expect(docs.getByRole('heading', { name: /Found 1/ })).toBeVisible();
    await expect(docs.locator('button[data-doc-path="design/plans/workspace-db.md"]')).toBeVisible();
    await expect.poll(() => sseRequests).toBeGreaterThanOrEqual(1);

    // Live SSE files event refreshes catalog in full-width mode (Chat hidden) without dispatching window.focus
    catalog = buildSampleCatalog({
      extraItems: [{
        path: 'design/plans/sqlite-backup.md',
        name: 'sqlite-backup.md',
        folder: 'design/plans',
        kind: 'markdown',
        size: 500,
        modifiedAt: hoursAgo(0.05),
        title: 'SQLite backup guide',
        excerpt: 'Atomic snapshot backups.',
        evidence: false,
      }],
    });
    releaseSse();
    await expect(docs.getByRole('heading', { name: /Found 2/ })).toBeVisible();
    await expect(search).toHaveValue('SQLite');

    // Switching to Board hides DocumentsPage: Board focus invalidation must NOT fetch /documents/catalog while hidden
    await workspaceNav(page).getByRole('link', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Board index' })).toBeVisible();
    await expect.poll(() => filesRequests).toBeGreaterThanOrEqual(1);
    await expect(docs).toBeHidden();

    catalog = buildSampleCatalog({
      extraItems: [
        {
          path: 'design/plans/sqlite-backup.md',
          name: 'sqlite-backup.md',
          folder: 'design/plans',
          kind: 'markdown',
          size: 500,
          modifiedAt: hoursAgo(0.05),
          title: 'SQLite backup guide',
          excerpt: 'Atomic snapshot backups.',
          evidence: false,
        },
        {
          path: 'design/plans/sqlite-wal.md',
          name: 'sqlite-wal.md',
          folder: 'design/plans',
          kind: 'markdown',
          size: 420,
          modifiedAt: hoursAgo(0.02),
          title: 'SQLite WAL notes',
          excerpt: 'Write-ahead log behavior.',
          evidence: false,
        },
      ],
    });
    const catalogBeforeBoardFocus = catalogRequests;
    const filesBeforeBoardFocus = filesRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => filesRequests).toBeGreaterThan(filesBeforeBoardFocus);
    await page.waitForTimeout(150);
    expect(catalogRequests).toBe(catalogBeforeBoardFocus);

    // Returning to Docs refreshes the stale catalog automatically
    await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(docs).toBeVisible();
    await expect.poll(() => catalogRequests).toBeGreaterThan(catalogBeforeBoardFocus);
    await expect(docs.getByRole('heading', { name: /Found 3/ })).toBeVisible();

    await docs.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(docs.getByRole('heading', { name: /Changed lately/ })).toBeVisible();
  });

  test('hidden mounted Documents page unmounts reader overlay and ignores / and Escape when switched to Board', async ({ page }) => {
    await mockCatalogAndPreviews(page);
    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);
    const search = docs.getByPlaceholder('Find a document by title, words or path');
    await expect(search).toBeVisible();

    // Open reader first so Escape would close it if the hidden page still listened
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('open-in-reader').click();
    await expect(docs.locator('[data-documents-reader]')).toBeVisible();

    await workspaceNav(page).getByRole('link', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await expect(docs).toBeHidden();

    const mountedSearch = page.locator('input[placeholder="Find a document by title, words or path"]');
    const mountedReader = page.locator('[data-documents-reader]');
    await expect(mountedSearch).toHaveCount(1);
    await expect(mountedReader).toHaveCount(0);

    await page.keyboard.press('/');
    await expect(mountedSearch).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(mountedReader).toHaveCount(0);
    await expect(docs).toBeHidden();

    // Switching back remounts reader with preserved path and re-enables Escape and / on the active page
    await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(docs).toBeVisible();
    await expect(docs.locator('[data-documents-reader]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(docs.locator('[data-documents-reader]')).toHaveCount(0);
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
  });

  test('unmounts expanded DocumentViewer portal, clears scroll lock, and avoids focus theft when leaving Docs via Ctrl+1, Ctrl+2, Ctrl+Backquote, or browser Back', async ({ page }) => {
    await page.route('**/api/terminals/demo/status', (route) =>
      route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }),
    );
    await mockCatalogAndPreviews(page);
    await page.route('**/api/workspace/demo/plan', (route) =>
      route.fulfill({
        json: planFile({
          checkpoints: [checkpoint('Reports export', { steps: [step('Write CSV writer')] })],
        }),
      }),
    );

    await page.goto('/#/workspaces/demo/overview');
    await expect(page.getByRole('region', { name: 'Overview', exact: true })).toBeVisible();

    const docsLink = workspaceNav(page).getByRole('link', { name: 'Docs', exact: true });
    await docsLink.click();
    const docs = docsRegion(page);
    await expect(docs).toBeVisible();

    // Expand PLAN.md in reader -> switch to Board via Ctrl+1
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    const openBtn = docs.locator('aside').getByRole('button', { name: 'Open in reader', exact: true });
    await openBtn.click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Expand document' }).click();

    const expanded = page.getByTestId('document-viewer-expanded');
    await expect(expanded).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    await page.keyboard.press('Control+1');
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await expect(expanded).toHaveCount(0);
    await expect(page.locator('[data-documents-reader]')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    // Wait for Board areas to render, then verify Board receives '/' cleanly without the hidden expanded overlay swallowing keys
    await expect(page.getByRole('button', { name: /Reports export/ })).toBeVisible();
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search the board' })).toBeFocused();

    // Returning to Docs must not steal focus from the Docs rail link
    await docsLink.click();
    await expect(docs).toBeVisible();
    await expect(docsLink).toBeFocused();
    await expect(reader).toBeVisible();
    await expect(expanded).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect(openBtn).toBeFocused();

    // Navigate Overview -> Docs, expand a picture by clicking it inside the reader, then browser Back
    await workspaceNav(page).getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Overview', exact: true })).toBeVisible();
    await docsLink.click();
    await docs.getByRole('button', { name: /^board-pictures\b/ }).click();
    await docs.locator('button[data-doc-path="board-pictures/root-1440.png"]').click();
    await openBtn.click();
    await reader.getByRole('button', { name: 'View full screen' }).click();
    await expect(expanded).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    await page.goBack();
    await expect(page.getByRole('region', { name: 'Overview', exact: true })).toBeVisible();
    await expect(expanded).toHaveCount(0);
    await expect(page.locator('[data-documents-reader]')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    await docsLink.click();
    await expect(docs).toBeVisible();
    await expect(docsLink).toBeFocused();

    // Also verify Ctrl+2 and Ctrl+Backquote while expanded unmount portal and clear scroll lock
    await reader.getByRole('button', { name: 'Expand document' }).click();
    await expect(expanded).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await page.keyboard.press('Control+2');
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await expect(expanded).toHaveCount(0);
    await expect(page.locator('[data-documents-reader]')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    await docsLink.click();
    await expect(docs).toBeVisible();
    await expect(docsLink).toBeFocused();
    await reader.getByRole('button', { name: 'Expand document' }).click();
    await expect(expanded).toBeVisible();
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await expect(expanded).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');

    await docsLink.click();
    await expect(docs).toBeVisible();
    await expect(docsLink).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
  });

  test('collapses expanded HTML document when Escape is pressed inside the expanded iframe', async ({ page }) => {
    await mockCatalogAndPreviews(page);
    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);

    await docs.locator('button[data-doc-path="design/mocks/documents.html"]').last().click();
    await docs.locator('aside').getByRole('button', { name: 'Open in reader', exact: true }).click();
    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();

    await reader.getByRole('button', { name: 'Expand document' }).click();
    const expanded = page.getByTestId('document-viewer-expanded');
    await expect(expanded).toBeVisible();

    // Open More document actions menu inside expanded viewer -> Escape closes only the menu
    await expanded.getByRole('button', { name: 'More document actions' }).click();
    await expect(page.locator('[data-slot="menu-popup"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="menu-popup"]')).toHaveCount(0);
    await expect(expanded).toBeVisible();

    const expandedFrame = expanded.locator('iframe').contentFrame();
    await expect(expandedFrame.getByRole('heading', { name: 'Mock Preview' })).toBeVisible();
    await expandedFrame.getByRole('heading', { name: 'Mock Preview' }).click();

    await page.keyboard.press('Escape');
    await expect(expanded).toHaveCount(0);
    await expect(reader).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Expand document' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
  });

  test('restores focus to a visible card after wide-to-narrow resize and keeps focus on search from empty-state Clear search', async ({ page }) => {
    await mockCatalogAndPreviews(page);
    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);

    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByRole('button', { name: 'Open in reader', exact: true }).click();
    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();

    // Following an internal link must not overwrite the original opening card path for narrow fallback
    await reader.getByRole('link', { name: 'the SQLite plan' }).click();
    await expect(reader).toContainText('Live preview for design/plans/workspace-db.md');

    await page.setViewportSize({ width: 800, height: 800 });
    await expect(docs.locator('aside')).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect.poll(() =>
      page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? null,
        path: (document.activeElement as HTMLElement | null)?.dataset.docPath ?? null,
      })),
    ).toEqual({ tag: 'BUTTON', path: 'PLAN.md' });

    // Empty-state Clear search must move focus to the search input rather than dropping to BODY
    const search = docs.getByPlaceholder('Find a document by title, words or path');
    await search.fill('zzzznonexistent12345');
    await expect(docs.getByText('No matching documents')).toBeVisible();
    await docs.locator('section[aria-label="Documents list"]').getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
  });

  test('works read-only on an archived workspace', async ({ page }) => {
    await mockCatalogAndPreviews(page, 'old');
    await page.goto('/#/workspaces/old/documents');

    await expect(page.getByRole('status').filter({ hasText: 'Archived on' })).toBeVisible();
    await expect(workspaceNav(page).getByRole('link')).toHaveText(['Record', 'Board', 'Docs']);
    await expect(workspaceNav(page).getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('aria-current', 'page');

    const docs = docsRegion(page);
    await expect(docs).toBeVisible();
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    const previewPane = docs.locator('aside');
    await expect(previewPane).toContainText('Live preview for PLAN.md');
    await expect(previewPane.getByRole('button', { name: 'Open in reader' })).toBeVisible();
    await expect(previewPane.getByRole('button', { name: 'Ask in CLI' })).toHaveCount(0);
  });
});

test.describe('Documents page in 1100x700 Split mode', () => {
  test.use({
    workspacesData: [[DEMO], { option: true }],
    sidebarDocked: false,
    viewport: { width: 1100, height: 700 },
  });

  test('fits single-column with zero horizontal overflow, opens reader without covering chat, and returns focus on Escape', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 48 }));
    });
    await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
    await page.route('**/api/terminals/demo/status', (route) => route.fulfill({
      json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] },
    }));
    await page.routeWebSocket('**/ws/terminal', (socket) => {
      socket.onMessage((msg) => {
        if (JSON.parse(String(msg)).type !== 'attach') return;
        socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      });
    });
    await mockCatalogAndPreviews(page);

    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    await expect(docs).toBeVisible();
    await expect(chat).toBeVisible();
    await expect(docs.locator('aside')).toBeHidden();

    const overflow = await docs.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);

    const card = docs.locator('button[data-doc-path="PLAN.md"]').last();
    await card.click();

    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    const [readerBox, chatBox] = await Promise.all([reader.boundingBox(), chat.boundingBox()]);
    expect(readerBox!.x + readerBox!.width).toBeLessThanOrEqual(chatBox!.x + 1);

    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect(card).toBeFocused();

    await assertReadableAndPressable(docs);
  });
});

test.describe('Documents page Split-mode keyboard coordination with CLI Chat', () => {
  test.use({
    workspacesData: [[DEMO], { option: true }],
    sidebarDocked: false,
    viewport: { width: 1280, height: 800 },
  });

  for (const entry of ['direct', 'via-overview'] as const) {
    test(`keeps / and Escape isolated between Documents and ResumeSessions (${entry})`, async ({ page }) => {
      await page.addInitScript(() => {
        if (!sessionStorage.getItem('split-chat-seeded')) {
          localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 45 }));
          sessionStorage.setItem('split-chat-seeded', '1');
        }
      });
      await page.route('**/api/terminals/bootstrap', (route) =>
        route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }),
      );
      await page.route('**/api/terminals/demo/status', (route) =>
        route.fulfill({
          json: {
            available: true,
            sessions: [],
            targets: [{ id: 'claude', name: 'Claude', available: true, reason: null }],
          },
        }),
      );
      await page.route('**/api/workspace/demo/sessions*', (route) =>
        route.fulfill({
          json: {
            sessions: [
              {
                id: '0199a213-81c0-7800-8aa1-bbab2a035a51',
                assistant: 'claude',
                title: 'Claude architecture chat',
                threadKind: 'main',
                workspacePath: DEMO.workspacePath,
                recordedCwd: DEMO.workspacePath,
                createdAt: hoursAgo(5),
                updatedAt: hoursAgo(1),
                messageCount: 4,
              },
            ],
          },
        }),
      );
      await mockCatalogAndPreviews(page);

      if (entry === 'direct') {
        await page.goto('/#/workspaces/demo/documents');
      } else {
        await page.goto('/#/workspaces/demo/overview');
        await expect(page.getByRole('region', { name: 'Continue a conversation' })).toBeVisible();
        await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
      }

      const docs = docsRegion(page);
      const docsSearch = docs.getByPlaceholder('Find a document by title, words or path');
      const resumeSection = page.getByRole('region', { name: 'Continue a conversation' });
      const resumeSearch = resumeSection.getByPlaceholder('Search conversations or harnesses (/)');
      await expect(docs).toBeVisible();
      await expect(resumeSearch).toBeVisible();

      // 2. Focus a folder in Documents and press '/' -> Documents search gets focus
      await docs.getByRole('button', { name: /^design\b/ }).focus();
      await page.keyboard.press('/');
      await expect(docsSearch).toBeFocused();
      await expect(resumeSearch).not.toBeFocused();

      // 4. Focus a control inside ResumeSessions ([data-slash-owner]) and press '/' -> ResumeSessions search gets focus
      await resumeSection.getByRole('button', { name: 'Refresh saved sessions' }).focus();
      await page.keyboard.press('/');
      await expect(resumeSearch).toBeFocused();
      await expect(docsSearch).not.toBeFocused();

      // 1. Type 'claude' in ResumeSessions search, open PLAN.md in Documents reader, press Escape ->
      // reader closes AND ResumeSessions search keeps 'claude'
      await resumeSearch.fill('claude');
      await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
      const reader = docs.locator('[data-documents-reader]');
      await expect(reader).toBeVisible();
      await expect(reader.getByRole('button', { name: 'Close document' })).toBeFocused();

      // 3. Pressing '/' inside the Document Reader must not focus ResumeSessions search
      await page.keyboard.press('/');
      await expect(resumeSearch).not.toBeFocused();
      await expect(docsSearch).not.toBeFocused();

      await page.keyboard.press('Escape');
      await expect(reader).toHaveCount(0);
      await expect(resumeSearch).toHaveValue('claude');

      // Focusing inside ResumeSessions when no reader/overlay is open still lets Escape clear its own search
      await resumeSection.getByRole('button', { name: 'Refresh saved sessions' }).focus();
      await page.keyboard.press('Escape');
      await expect(resumeSearch).toHaveValue('');
    });
  }
});

test.describe('Documents page in 420px narrow pane', () => {
  test.use({
    workspacesData: [[DEMO], { option: true }],
    sidebarDocked: false,
    viewport: { width: 420, height: 800 },
  });

  test('fits 420px pane with zero horizontal overflow, readable controls, and working search/reader', async ({ page }) => {
    await mockCatalogAndPreviews(page);
    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);
    await expect(docs).toBeVisible();
    await expect(docs.locator('aside')).toBeHidden();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);
    const docsOverflow = await docs.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(docsOverflow).toBe(false);

    const search = docs.getByPlaceholder('Find a document by title, words or path');
    const searchFits = await search.evaluate((el) => (el as HTMLInputElement).scrollWidth <= (el as HTMLInputElement).clientWidth + 1);
    expect(searchFits).toBe(true);

    await assertReadableAndPressable(docs);

    const card = docs.locator('button[data-doc-path="PLAN.md"]').last();
    await card.click();
    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect(card).toBeFocused();
  });
});
