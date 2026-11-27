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
    const searchFits = await search.evaluate((el) => {
      const input = el as HTMLInputElement;
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padRight = parseFloat(style.paddingRight) || 0;
      const available = input.clientWidth - padLeft - padRight;
      if (!ctx) return input.scrollWidth <= input.clientWidth + 1;
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const textWidth = ctx.measureText(input.placeholder).width;
      return textWidth <= available + 1 && input.scrollWidth <= input.clientWidth + 1;
    });
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

interface MutableDocRecord {
  path: string;
  kind: 'markdown' | 'text' | 'html' | 'image';
  content: string;
  revision: string;
  modifiedAt: string;
  editable: boolean;
  readOnlyReason?: string;
}

function parseMultipartUpload(contentType: string, raw: Buffer) {
  const match = /boundary=([^\s;]+)/i.exec(contentType);
  if (!match) return { fields: {} as Record<string, string>, fileName: '', content: Buffer.alloc(0) };
  const boundary = match[1].replace(/^"|"$/g, '');
  const rawStr = raw.toString('latin1');
  const parts = rawStr.split(`--${boundary}`);
  const fields: Record<string, string> = {};
  let fileName = '';
  let content = Buffer.alloc(0);

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    let bodyStr = part.slice(headerEnd + 4);
    if (bodyStr.endsWith('\r\n')) bodyStr = bodyStr.slice(0, -2);
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const fnMatch = /filename="([^"]*)"/.exec(headers);
    if (fnMatch) {
      fileName = fnMatch[1];
      content = Buffer.from(bodyStr, 'latin1');
    } else {
      fields[fieldName] = Buffer.from(bodyStr, 'latin1').toString('utf8');
    }
  }
  return { fields, fileName, content };
}

function createMutableDocsStore(options: { sqlitePlan?: boolean; extraDocs?: MutableDocRecord[] } = {}) {
  let revCounter = 1;
  const nextRev = () => `rev-${++revCounter}`;
  const folders = new Set<string>(['design', 'design/plans', 'design/mocks', 'board-pictures']);
  const docs = new Map<string, MutableDocRecord>([
    [
      'PLAN.md',
      {
        path: 'PLAN.md',
        kind: 'markdown',
        content: '# New canvas interaction\n\nInitial plan text.',
        revision: 'rev-plan-1',
        modifiedAt: hoursAgo(1),
        editable: !options.sqlitePlan,
        ...(options.sqlitePlan ? { readOnlyReason: 'Managed on the Board database — edit steps on the Board.' } : {}),
      },
    ],
    [
      'AGENTS.md',
      {
        path: 'AGENTS.md',
        kind: 'markdown',
        content: '# Auto-generated\n\nAgent instructions.',
        revision: 'rev-agents-1',
        modifiedAt: hoursAgo(2),
        editable: false,
        readOnlyReason: 'Generated by ContextSpace — refreshed automatically.',
      },
    ],
    [
      'design/plans/workspace-db.md',
      {
        path: 'design/plans/workspace-db.md',
        kind: 'markdown',
        content: '# SQLite architecture\n\nDetails here.',
        revision: 'rev-db-1',
        modifiedAt: hoursAgo(3),
        editable: true,
      },
    ],
    [
      'design/mocks/documents.html',
      {
        path: 'design/mocks/documents.html',
        kind: 'html',
        content: '<!doctype html><html><body><h1>Mock Page</h1></body></html>',
        revision: 'rev-html-1',
        modifiedAt: hoursAgo(4),
        editable: true,
      },
    ],
    [
      'board-pictures/root-1440.png',
      {
        path: 'board-pictures/root-1440.png',
        kind: 'image',
        content: '',
        revision: 'rev-img-1',
        modifiedAt: hoursAgo(0.5),
        editable: false,
      },
    ],
    ...(options.extraDocs ?? []).map((doc) => [doc.path, doc] as const),
  ]);

  const toTitle = (docPath: string, content: string) => {
    const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
    if (heading) return heading;
    const base = docPath.split('/').pop() ?? docPath;
    return base.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  };

  const buildCatalog = () => {
    const folderSet = new Set<string>(folders);
    for (const doc of docs.values()) {
      const parts = doc.path.split('/').slice(0, -1);
      let acc = '';
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        folderSet.add(acc);
      }
    }

    const items = Array.from(docs.values()).map((doc) => {
      const slash = doc.path.lastIndexOf('/');
      return {
        path: doc.path,
        name: slash < 0 ? doc.path : doc.path.slice(slash + 1),
        folder: slash < 0 ? '' : doc.path.slice(0, slash),
        kind: doc.kind,
        size: doc.kind === 'image' ? PICTURE.length : Buffer.byteLength(doc.content, 'utf8'),
        modifiedAt: doc.modifiedAt,
        title: toTitle(doc.path, doc.content),
        excerpt: doc.kind === 'image' ? '' : doc.content.replace(/^#+\s*/gm, '').trim().slice(0, 120),
        evidence: false,
        editable: doc.editable,
        ...(doc.readOnlyReason ? { readOnlyReason: doc.readOnlyReason } : {}),
      };
    });

    const folderEntries = Array.from(folderSet)
      .sort()
      .map((folderPath) => {
        const slash = folderPath.lastIndexOf('/');
        const directSubfolders = Array.from(folderSet).filter((f) => {
          const s = f.lastIndexOf('/');
          return (s < 0 ? '' : f.slice(0, s)) === folderPath;
        });
        const prefix = `${folderPath}/`;
        let docCount = 0;
        let pictureCount = 0;
        for (const doc of docs.values()) {
          if (doc.path.startsWith(prefix)) {
            if (doc.kind === 'image') pictureCount += 1;
            else docCount += 1;
          }
        }
        return {
          path: folderPath,
          name: slash < 0 ? folderPath : folderPath.slice(slash + 1),
          parent: slash < 0 ? '' : folderPath.slice(0, slash),
          evidence: false,
          summary: '',
          folderCount: directSubfolders.length,
          docCount,
          pictureCount,
          evidenceCount: 0,
        };
      });

    const recent = items
      .filter((i) => i.kind !== 'image')
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, 4)
      .map((i) => i.path);

    return { items, folders: folderEntries, recent };
  };

  return {
    docs,
    folders,
    buildCatalog,
    bumpExternal(docPath: string, content: string) {
      const existing = docs.get(docPath);
      const rev = nextRev();
      const modifiedAt = new Date(Date.now() + 5000).toISOString();
      if (existing) {
        existing.content = content;
        existing.revision = rev;
        existing.modifiedAt = modifiedAt;
      }
      return rev;
    },
    async install(page: Page, wsId = 'demo') {
      await page.route(`**/api/workspace/${wsId}/plan`, (route) => route.fulfill({ json: planFile() }));
      await page.route(`**/api/workspace/${wsId}/documents/catalog`, (route) =>
        route.fulfill({ json: buildCatalog() }),
      );
      await page.route(`**/api/workspace/${wsId}/documents/preview?*`, (route) => {
        const name = new URL(route.request().url()).searchParams.get('name') ?? '';
        const doc = docs.get(name);
        if (!doc) return route.fulfill({ status: 404, json: { error: `Not found: ${name}` } });
        return route.fulfill({
          json: {
            name: doc.path,
            kind: doc.kind,
            size: Buffer.byteLength(doc.content, 'utf8'),
            modifiedAt: doc.modifiedAt,
            revision: doc.revision,
            editable: doc.editable,
            ...(doc.readOnlyReason ? { readOnlyReason: doc.readOnlyReason } : {}),
            content: doc.content,
          },
        });
      });
      await page.route(`**/api/workspace/${wsId}/documents/file?*`, (route) => {
        const name = new URL(route.request().url()).searchParams.get('name') ?? '';
        const doc = docs.get(name);
        if (doc?.kind === 'html') {
          return route.fulfill({ status: 200, contentType: 'text/html', body: doc.content });
        }
        return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE });
      });
      await page.route(`**/api/workspace/${wsId}/documents`, async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        const body = route.request().postDataJSON() as {
          name?: string;
          content?: string;
          expectedRevision?: string;
          createOnly?: boolean;
        };
        const name = (body.name ?? '').trim().replace(/^\/+|\/+$/g, '');
        const existing = docs.get(name);
        if (existing && !existing.editable) {
          return route.fulfill({ status: 400, json: { error: existing.readOnlyReason ?? 'Read-only file' } });
        }
        if (body.createOnly && existing) {
          return route.fulfill({
            status: 409,
            json: {
              error: `Document "${name}" already exists.`,
              code: 'ALREADY_EXISTS',
              currentRevision: existing.revision,
              currentModifiedAt: existing.modifiedAt,
            },
          });
        }
        if (body.expectedRevision) {
          if (!existing) {
            return route.fulfill({
              status: 409,
              json: {
                error: `Document "${name}" no longer exists on disk.`,
                code: 'CONFLICT',
                currentRevision: null,
                currentModifiedAt: null,
              },
            });
          }
          if (existing.revision !== body.expectedRevision) {
            return route.fulfill({
              status: 409,
              json: {
                error: 'This document changed on disk since you started editing.',
                code: 'CONFLICT',
                currentRevision: existing.revision,
                currentContent: existing.content,
                currentModifiedAt: existing.modifiedAt,
              },
            });
          }
        }
        const content = body.content ?? '';
        const revision = nextRev();
        const modifiedAt = new Date().toISOString();
        const kind: MutableDocRecord['kind'] = name.endsWith('.html') || name.endsWith('.htm')
          ? 'html'
          : name.endsWith('.md') || name.endsWith('.mdx')
            ? 'markdown'
            : 'text';
        docs.set(name, {
          path: name,
          kind,
          content,
          revision,
          modifiedAt,
          editable: true,
        });
        return route.fulfill({
          json: {
            name,
            kind,
            mime: kind === 'html' ? 'text/html' : 'text/markdown',
            size: Buffer.byteLength(content, 'utf8'),
            modifiedAt,
            revision,
            content,
          },
        });
      });
      await page.route(`**/api/workspace/${wsId}/documents/folders`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const body = route.request().postDataJSON() as { folder?: string };
        const clean = (body.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
        if (!clean || clean.includes('..')) {
          return route.fulfill({ status: 400, json: { error: 'Invalid folder name.' } });
        }
        const parts = clean.split('/');
        let acc = '';
        for (const p of parts) {
          acc = acc ? `${acc}/${p}` : p;
          folders.add(acc);
        }
        return route.fulfill({ json: { folder: clean } });
      });
      await page.route(`**/api/workspace/${wsId}/documents/move`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const body = route.request().postDataJSON() as { from: string; to: string };
        const existing = docs.get(body.from);
        if (!existing) return route.fulfill({ status: 404, json: { error: 'Not found' } });
        if (docs.has(body.to)) return route.fulfill({ status: 409, json: { error: 'Destination exists', code: 'ALREADY_EXISTS' } });
        docs.delete(body.from);
        docs.set(body.to, { ...existing, path: body.to, modifiedAt: new Date().toISOString() });
        return route.fulfill({ json: { from: body.from, to: body.to } });
      });
      await page.route(`**/api/workspace/${wsId}/documents/upload`, async (route) => {
        const headers = route.request().headers();
        const buf = route.request().postDataBuffer() ?? Buffer.alloc(0);
        const parsed = parseMultipartUpload(headers['content-type'] ?? '', buf);
        const folderPrefix = parsed.fields.folder ? `${parsed.fields.folder.replace(/^\/+|\/+$/g, '')}/` : '';
        const chosenName = (parsed.fields.name || parsed.fileName).trim();
        const target = `${folderPrefix}${chosenName}`;
        if (target.endsWith('.exe')) {
          return route.fulfill({ status: 400, json: { error: `${chosenName}: unsupported file format.` } });
        }
        const createOnly = parsed.fields.createOnly !== '0';
        const existing = docs.get(target);
        if (createOnly && existing) {
          return route.fulfill({
            status: 409,
            json: {
              error: `Document "${target}" already exists.`,
              code: 'ALREADY_EXISTS',
              currentRevision: existing.revision,
              currentModifiedAt: existing.modifiedAt,
            },
          });
        }
        const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(target);
        const kind: MutableDocRecord['kind'] = isImg ? 'image' : target.endsWith('.md') ? 'markdown' : 'text';
        const revision = isImg ? undefined : nextRev();
        const modifiedAt = new Date().toISOString();
        const textContent = isImg ? '' : parsed.content.toString('utf8');
        docs.set(target, {
          path: target,
          kind,
          content: textContent,
          revision: revision ?? 'img-rev',
          modifiedAt,
          editable: !isImg,
        });
        return route.fulfill({
          json: {
            name: target,
            kind,
            mime: isImg ? 'image/png' : 'text/markdown',
            size: parsed.content.length,
            modifiedAt,
            ...(revision ? { revision } : {}),
          },
        });
      });
    },
  };
}

test.describe('Documents page authoring and editing (DC2)', () => {
  test.use({
    workspacesData: [[DEMO, OLD], { option: true }],
    viewport: { width: 1440, height: 900 },
  });

  test('creates a document with auto-.md, previews live, saves with Ctrl+S, and persists across reload', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page);
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.getByTestId('new-document-button').click();

    const dialog = page.getByRole('dialog', { name: 'New document' });
    await expect(dialog).toBeVisible();
    await assertReadableAndPressable(dialog);

    const fileInput = dialog.getByLabel('File name');
    await fileInput.fill('notes');
    await expect(dialog).toContainText('notes.md');
    await dialog.getByRole('button', { name: 'Create & edit', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Immediately opens in edit mode with focus inside editor textarea
    const editor = docs.locator('aside').getByTestId('document-editor');
    await expect(editor).toBeVisible();
    const textarea = editor.locator('textarea');
    await expect(textarea).toBeFocused();
    await assertReadableAndPressable(docs);

    await textarea.fill('# Release Checklist\n\nShip **DC2** cleanly.');
    await expect(editor.getByTestId('unsaved-changes-badge')).toBeVisible();

    await editor.getByRole('tab', { name: 'Preview', exact: true }).click();
    await expect(editor.getByRole('heading', { name: 'Release Checklist' })).toBeVisible();

    await editor.getByRole('tab', { name: 'Write', exact: true }).click();
    await textarea.focus();
    await page.keyboard.press('Control+s');
    await expect(docs.locator('aside').getByTestId('document-editor')).toHaveCount(0);
    await expect(docs.locator('aside').getByRole('heading', { name: 'Release Checklist', level: 1 })).toBeVisible();

    // Reload preserves created + saved document from store
    await page.reload();
    const docsAfter = docsRegion(page);
    await expect(docsAfter.locator('button[data-doc-path="notes.md"]').first()).toBeVisible();
    await docsAfter.locator('button[data-doc-path="notes.md"]').last().click();
    await expect(docsAfter.locator('aside')).toContainText('Release Checklist');
  });

  test('creates a new folder (visible while empty), creates a doc inside it, edits & moves in Reader', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page);
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.getByTestId('new-folder-button').click();
    const folderDialog = page.getByRole('dialog', { name: 'New folder' });
    await expect(folderDialog).toBeVisible();
    await folderDialog.getByLabel('Folder name').fill('specs');
    await folderDialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(folderDialog).toHaveCount(0);

    const folderCard = docs.getByRole('button', { name: /^specs\b/ });
    await expect(folderCard).toBeVisible();
    await expect(folderCard).toContainText('Empty');
    await folderCard.click();

    await expect(docs.getByText('No documents here')).toBeVisible();
    await docs.locator('section[aria-label="Documents list"]').getByRole('button', { name: 'New document' }).click();
    const docDialog = page.getByRole('dialog', { name: 'New document' });
    await expect(docDialog.getByLabel('Folder')).toHaveValue('specs');
    await docDialog.getByLabel('File name').fill('brief');
    await docDialog.getByRole('button', { name: 'Create & edit', exact: true }).click();

    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await expect(sideTextarea).toBeVisible();
    await sideTextarea.fill('# Draft Brief\n\nInitial draft.');
    // Promote unsaved side edit straight into Reader via Open in reader
    await docs.locator('aside').getByTestId('open-in-reader').click();

    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    const readerTextarea = reader.getByTestId('document-editor').locator('textarea');
    await expect(readerTextarea).toHaveValue('# Draft Brief\n\nInitial draft.');
    await readerTextarea.fill('# Final Brief\n\nSaved from Reader.');
    await reader.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await expect(reader.getByRole('heading', { name: 'Final Brief' })).toBeVisible();
    await assertReadableAndPressable(docs);

    // Move or rename from Reader menu
    await reader.getByRole('button', { name: 'More document actions' }).click();
    await page.getByRole('menuitem', { name: 'Move or rename' }).click();
    const moveDialog = page.getByRole('dialog', { name: 'Move or rename document' });
    await moveDialog.locator('input').fill('specs/final-brief.md');
    await moveDialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(reader).toContainText('specs/final-brief.md');
    await page.keyboard.press('Escape');
    await expect(docs.locator('button[data-doc-path="specs/final-brief.md"]').first()).toBeVisible();
  });

  test('guards dirty edits against Escape, card switch, Close document, and preserves draft across tab switches', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page);
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    const search = docs.getByPlaceholder('Find a document by title, words or path');
    await search.fill('PLAN');
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await sideTextarea.fill('# Unsaved side edits');

    // Clearing the search filter while editing must NOT prompt to discard edits or lose typed text
    await docs.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(sideTextarea).toHaveValue('# Unsaved side edits');

    // Escape in dirty side editor opens confirmation AlertDialog; Keep editing preserves edits and restores focus
    await sideTextarea.press('Escape');
    const sideAlert = page.getByRole('alertdialog');
    await expect(sideAlert).toContainText('Unsaved changes');
    await sideAlert.getByRole('button', { name: 'Keep editing' }).click();
    await expect(sideTextarea).toHaveValue('# Unsaved side edits');
    await expect(sideTextarea).toBeFocused();

    // Clicking another doc opens confirmation AlertDialog; Discard changes switches cleanly
    await docs.locator('button[data-doc-path="AGENTS.md"]').last().click();
    await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(docs.locator('aside')).toContainText('AGENTS.md');

    // Reader dirty guard + tab switch preservation
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const readerTextarea = reader.getByTestId('document-editor').locator('textarea');
    await readerTextarea.fill('# Unsaved reader draft');

    // Switch to Board tab and return -> draft & editing mode are preserved!
    await workspaceNav(page).getByRole('link', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(reader.getByTestId('document-editor').locator('textarea')).toHaveValue('# Unsaved reader draft');

    // Close document button prompts AlertDialog when dirty; Keep editing keeps typed draft
    await reader.getByRole('button', { name: 'Close document' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing' }).click();
    await expect(reader.getByTestId('document-editor').locator('textarea')).toHaveValue('# Unsaved reader draft');

    // Escape inside Reader when dirty prompts AlertDialog too -> Discard returns to Reader preview, second Escape closes Reader
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await expect(reader).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
  });

  test('detects external SSE edits and resolves 409 CONFLICT via Save as copy, Overwrite with mine, and Load latest', async ({ page }) => {
    const store = createMutableDocsStore();
    let releaseSse!: () => void;
    let sseReleased = false;
    const sseGate = new Promise<void>((resolve) => {
      releaseSse = () => {
        sseReleased = true;
        resolve();
      };
    });
    await page.route('**/api/workspace/demo/screen-events**', async (route) => {
      if (sseReleased) {
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `${STREAM_HEAD}${PING}` }).catch(() => {});
      }
      await sseGate;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `${STREAM_HEAD}${frame('files', { timestamp: new Date().toISOString() }, 'ext-1')}`,
      }).catch(() => {});
    });
    await store.install(page);
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const editor = docs.locator('aside').getByTestId('document-editor');
    const textarea = editor.locator('textarea');
    await textarea.fill('# My Local Edits');

    // External modification triggers SSE files invalidation -> calm notice without wiping draft
    store.bumpExternal('PLAN.md', '# External V2 on disk');
    releaseSse();
    await expect(editor.getByTestId('document-external-change-notice')).toBeVisible();
    await expect(textarea).toHaveValue('# My Local Edits');

    // Clicking Save gets 409 CONFLICT -> preserves typed draft and offers recovery buttons in an inline row
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    const conflictBar = editor.getByTestId('document-conflict-bar');
    await expect(conflictBar).toBeVisible();
    await expect(textarea).toHaveValue('# My Local Edits');
    await assertReadableAndPressable(docs);

    const overwriteBtn = conflictBar.getByRole('button', { name: 'Overwrite with mine' });
    const copyBtn = conflictBar.getByRole('button', { name: 'Save as copy' });
    const [overwriteBox, copyBox, barBox] = await Promise.all([
      overwriteBtn.boundingBox(),
      copyBtn.boundingBox(),
      conflictBar.boundingBox(),
    ]);
    expect(overwriteBox!.x - barBox!.x).toBeLessThan(40);
    expect(copyBox!.x).toBeGreaterThan(overwriteBox!.x);

    // If a third external edit lands while the conflict bar is open, Overwrite with mine checks currentRevision instead of blindly clobbering
    store.bumpExternal('PLAN.md', '# External V2.5 on disk');
    await overwriteBtn.click();
    await expect(conflictBar).toBeVisible();
    await expect(textarea).toHaveValue('# My Local Edits');
    expect(store.docs.get('PLAN.md')?.content).toBe('# External V2.5 on disk');

    // Save as copy writes PLAN-copy.md with typed draft intact
    await copyBtn.click();
    await expect(docs.locator('aside')).toContainText('PLAN-copy.md');
    await expect(docs.locator('aside')).toContainText('My Local Edits');
    expect(store.docs.get('PLAN-copy.md')?.content).toBe('# My Local Edits');
    expect(store.docs.get('PLAN.md')?.content).toBe('# External V2.5 on disk');

    // Trigger conflict again on PLAN.md in Reader and verify Load latest + Overwrite with mine
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const readerTextarea = reader.getByTestId('document-editor').locator('textarea');
    await readerTextarea.fill('# Overwrite candidate');
    store.bumpExternal('PLAN.md', '# External V3');
    await reader.getByRole('button', { name: 'Save document', exact: true }).click();
    const readerConflict = reader.getByTestId('document-conflict-bar');
    await expect(readerConflict).toBeVisible();
    await readerConflict.getByRole('button', { name: 'Overwrite with mine' }).click();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    expect(store.docs.get('PLAN.md')?.content).toBe('# Overwrite candidate');

    // Load latest replaces conflict draft cleanly
    await reader.getByRole('button', { name: 'Edit document' }).click();
    await reader.getByTestId('document-editor').locator('textarea').fill('# Stale candidate');
    store.bumpExternal('PLAN.md', '# Fresh disk V4');
    await reader.getByRole('button', { name: 'Save document', exact: true }).click();
    await reader.getByTestId('document-conflict-bar').getByRole('button', { name: 'Load latest' }).click();
    await expect(reader.getByTestId('document-editor').locator('textarea')).toHaveValue('# Fresh disk V4');
  });

  test('uploads Markdown & PNG, drops duplicate with Keep both / Skip, and rejects .exe inline', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page);
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    const fileInput = docs.locator('input[type="file"]');

    // Batch upload: valid markdown, valid PNG, and rejected .exe
    await fileInput.setInputFiles([
      { name: 'uploaded-note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Uploaded Note\n\nVia upload.') },
      { name: 'diagram.png', mimeType: 'image/png', buffer: PICTURE },
      { name: 'bad.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
    ]);

    const errorBanner = docs.getByTestId('upload-error-banner');
    await expect(errorBanner).toContainText('bad.exe');
    const [errBannerBox, dismissBox] = await Promise.all([
      errorBanner.boundingBox(),
      errorBanner.getByRole('button', { name: 'Dismiss' }).boundingBox(),
    ]);
    expect(errBannerBox!.width).toBeGreaterThan(250);
    expect(dismissBox!.x).toBeGreaterThan(errBannerBox!.x + 120);
    expect(dismissBox!.x + dismissBox!.width).toBeLessThanOrEqual(errBannerBox!.x + errBannerBox!.width + 1);
    await expect(docs.locator('button[data-doc-path="uploaded-note.md"]').first()).toBeVisible();
    await expect(docs.locator('button[data-doc-path="diagram.png"]').first()).toBeVisible();
    await errorBanner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(errorBanner).toHaveCount(0);

    // Drag-and-drop duplicate PLAN.md -> conflict prompt with Keep both / Skip
    const dropSurface = docs.locator('section[aria-label="Documents list"]');
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['# Copy of PLAN'], 'PLAN.md', { type: 'text/markdown' }));
      return dt;
    });
    await dropSurface.dispatchEvent('dragenter', { dataTransfer });
    await expect(docs.getByTestId('documents-drop-zone')).toBeVisible();
    await dropSurface.dispatchEvent('drop', { dataTransfer });

    const conflictBanner = docs.getByTestId('upload-conflict-banner');
    await expect(conflictBanner).toContainText('PLAN.md already exists');
    const [confBannerBox, keepBothBox] = await Promise.all([
      conflictBanner.boundingBox(),
      conflictBanner.getByRole('button', { name: 'Keep both' }).boundingBox(),
    ]);
    expect(confBannerBox!.width).toBeGreaterThan(250);
    expect(keepBothBox!.x).toBeGreaterThan(confBannerBox!.x + 120);
    await conflictBanner.getByRole('button', { name: 'Keep both' }).click();
    await expect(conflictBanner).toHaveCount(0);
    await expect(docs.locator('button[data-doc-path="PLAN-2.md"]').first()).toBeVisible();
    expect(store.docs.get('PLAN-2.md')?.content).toBe('# Copy of PLAN');
  });

  test('typing in the side editor during an upload keeps the text', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page);
    await page.route('**/documents/upload', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    });
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await expect(sideTextarea).toBeVisible();

    await docs.locator('input[type="file"]').setInputFiles([
      { name: 'during-edit.md', mimeType: 'text/markdown', buffer: Buffer.from('# During edit') },
    ]);
    await sideTextarea.fill('# TYPED WHILE UPLOADING');

    await expect(docs.locator('button[data-doc-path="during-edit.md"]').first()).toBeVisible();
    await expect(docs.getByTestId('upload-document-button')).toBeEnabled();
    await expect(sideTextarea).toBeVisible();
    await expect(sideTextarea).toHaveValue('# TYPED WHILE UPLOADING');
  });

  test('starting an edit during an upload keeps the editor on screen', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page);
    await page.route('**/documents/upload', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    });
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('input[type="file"]').setInputFiles([
      { name: 'during-edit-b.md', mimeType: 'text/markdown', buffer: Buffer.from('# During edit b') },
    ]);
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await sideTextarea.fill('# STARTED WHILE UPLOADING');

    await expect(docs.locator('button[data-doc-path="during-edit-b.md"]').first()).toBeVisible();
    await expect(docs.getByTestId('upload-document-button')).toBeEnabled();
    await expect(sideTextarea).toBeVisible();
    await expect(sideTextarea).toHaveValue('# STARTED WHILE UPLOADING');
  });

  test('disables editing with quiet reasons on AGENTS.md and SQLite PLAN.md, and hides write controls when archived', async ({ page }) => {
    const store = createMutableDocsStore({ sqlitePlan: true });
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="AGENTS.md"]').last().click();
    await expect(docs.locator('aside').getByTestId('side-edit-button')).toHaveCount(0);
    await expect(docs.locator('aside').getByTestId('doc-readonly-reason')).toContainText('Generated by ContextSpace — refreshed automatically.');

    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await expect(docs.locator('aside').getByTestId('side-edit-button')).toHaveCount(0);
    await expect(docs.locator('aside').getByTestId('doc-readonly-reason')).toContainText('Managed on the Board database — edit steps on the Board.');
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await expect(reader.getByRole('button', { name: 'Edit document' })).toHaveCount(0);
    await expect(reader.getByTestId('reader-readonly-reason')).toContainText('Managed on the Board database — edit steps on the Board.');

    // Archived workspace hides all creation/upload/edit controls
    await store.install(page, 'old');
    await page.goto('/#/workspaces/old/documents');
    const oldDocs = docsRegion(page);
    await expect(oldDocs.getByTestId('new-document-button')).toHaveCount(0);
    await expect(oldDocs.getByTestId('upload-document-button')).toHaveCount(0);
    await expect(oldDocs.getByTestId('new-folder-button')).toHaveCount(0);
    await oldDocs.locator('button[data-doc-path="design/plans/workspace-db.md"]').last().click();
    await expect(oldDocs.locator('aside').getByTestId('side-edit-button')).toHaveCount(0);
  });
});

test.describe('Documents page DC2 typing isolation in Split mode', () => {
  test.use({
    workspacesData: [[DEMO], { option: true }],
    sidebarDocked: false,
    viewport: { width: 1280, height: 800 },
  });

  test('typing / and Escape inside DocumentEditor never hijacks ResumeSessions in Split mode', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('split-chat-dc2-seeded')) {
        localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 45 }));
        sessionStorage.setItem('split-chat-dc2-seeded', '1');
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
    const store = createMutableDocsStore();
    await store.install(page);
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    const resumeSection = page.getByRole('region', { name: 'Continue a conversation' });
    const resumeSearch = resumeSection.getByPlaceholder('Search conversations or harnesses (/)');
    await resumeSearch.fill('claude');

    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const textarea = reader.getByTestId('document-editor').locator('textarea');
    await textarea.focus();
    await textarea.press('Control+End');
    await page.keyboard.type(' /notes');
    await expect(resumeSearch).not.toBeFocused();
    await expect(resumeSearch).toHaveValue('claude');
    await expect(textarea).toHaveValue('# New canvas interaction\n\nInitial plan text. /notes');

    // Escape in dirty DocumentEditor triggers Unsaved changes dialog and leaves ResumeSessions untouched
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing' }).click();
    await expect(textarea).toHaveValue('# New canvas interaction\n\nInitial plan text. /notes');
    await expect(resumeSearch).toHaveValue('claude');

    // Close dirty edit, then create a new doc in Split mode -> Save -> switch to Board & back stays in Preview mode (no stale edit mode)
    await reader.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);

    await docs.getByTestId('new-document-button').click();
    const newDialog = page.getByRole('dialog', { name: 'New document' });
    await newDialog.getByLabel('File name').fill('split-note');
    await newDialog.getByRole('button', { name: 'Create & edit', exact: true }).click();
    const newTextarea = reader.getByTestId('document-editor').locator('textarea');
    await expect(newTextarea).toBeFocused();
    await newTextarea.fill('# Split Created\n\nSaved cleanly.');
    await reader.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await expect(reader.getByRole('heading', { name: 'Split Created' })).toBeVisible();

    await workspaceNav(page).getByRole('link', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
    await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(reader).toBeVisible();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await expect(reader.getByRole('heading', { name: 'Split Created' })).toBeVisible();
  });
});

test.describe('Documents page DC2 fix1 regressions', () => {
  const BETA = {
    id: 'beta',
    branchName: 'beta',
    name: 'Second Workspace',
    description: 'Workspace isolation target',
    mode: 'worktree',
    repos: ['/dev/NexusFlow'],
    assistants: [],
    workspacePath: '/ws/beta',
    createdAt: '2026-11-02T00:00:00.000Z',
  };

  test.use({
    workspacesData: [[DEMO, BETA], { option: true }],
    viewport: { width: 1440, height: 900 },
  });

  test('fix1-1: preserves unsaved side-pane and Reader drafts across X close-panel, Ctrl+3 Terminal, and active Docs rail toggle, scoped per workspace', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('dc2-fix1-1-seeded')) {
        localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: true, percent: 48 }));
        sessionStorage.setItem('dc2-fix1-1-seeded', '1');
      }
    });
    await page.route('**/api/terminals/bootstrap', (route) =>
      route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }),
    );
    await page.route('**/api/terminals/*/status', (route) =>
      route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }),
    );
    await page.route('**/api/workspace/*/sessions*', (route) =>
      route.fulfill({ json: { sessions: [] } }),
    );

    const demoStore = createMutableDocsStore();
    const betaStore = createMutableDocsStore();
    await demoStore.install(page, 'demo');
    await betaStore.install(page, 'beta');

    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);

    // 1. Side pane: edit PLAN.md, close panel with X, return via Docs rail -> draft intact
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await sideTextarea.fill('# CRITICAL UNSAVED WORK 999');

    await docs.getByRole('button', { name: 'Close this panel and give the chat the whole screen' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
    await expect(docs).toHaveCount(0);

    // Clicking Docs in another workspace must NOT leak demo's draft into beta
    await page.goto('/#/workspaces/beta/documents');
    const betaDocs = docsRegion(page);
    await expect(betaDocs.locator('aside').getByTestId('document-editor')).toHaveCount(0);

    // Returning to demo Docs restores the exact side-pane draft
    await page.goto('/#/workspaces/demo/documents');
    await expect(docs.locator('aside').getByTestId('document-editor').locator('textarea')).toHaveValue('# CRITICAL UNSAVED WORK 999');

    // Discard side edit before testing Reader draft
    await docs.locator('aside').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(docs.locator('aside').getByTestId('document-editor')).toHaveCount(0);

    // 2. Reader: open PLAN.md in Reader, edit, press Ctrl+3 (Terminal), return via Docs rail -> draft intact
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const readerTextarea = reader.getByTestId('document-editor').locator('textarea');
    await readerTextarea.fill('# CRITICAL READER DRAFT 888');

    await page.keyboard.press('Control+3');
    await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
    await expect(docs).toHaveCount(0);

    await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/documents$/);
    await expect(reader.getByTestId('document-editor').locator('textarea')).toHaveValue('# CRITICAL READER DRAFT 888');
  });

  test('fix1-2: automatically promotes active side-pane edit session to Reader when entering Split (< 56rem) and leaves CLI Chat uncovered', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('dc2-fix1-2-seeded')) {
        localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: true, percent: 50 }));
        sessionStorage.setItem('dc2-fix1-2-seeded', '1');
      }
    });
    await page.route('**/api/terminals/bootstrap', (route) =>
      route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }),
    );
    await page.route('**/api/terminals/demo/status', (route) =>
      route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }),
    );
    await page.route('**/api/workspace/demo/sessions*', (route) =>
      route.fulfill({ json: { sessions: [] } }),
    );

    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await sideTextarea.fill('# SIDE DRAFT BEFORE SPLIT 777');

    // Toggle chat beside Docs -> Docs container narrows below 56rem; side editor must promote automatically into Reader
    await docs.getByRole('button', { name: 'Show the chat beside this' }).click();
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    await expect(chat).toBeVisible();
    await expect(docs.locator('aside')).toBeHidden();

    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    await expect(reader.getByTestId('document-editor').locator('textarea')).toHaveValue('# SIDE DRAFT BEFORE SPLIT 777');

    // Reader must never overlap CLI Chat in Split mode
    const [readerBox, chatBox] = await Promise.all([reader.boundingBox(), chat.boundingBox()]);
    expect(readerBox!.x + readerBox!.width).toBeLessThanOrEqual(chatBox!.x + 1);
  });

  test('fix1-3: guards relative Markdown link clicks in Reader Preview tab while dirty without orphaning drafts', async ({ page }) => {
    const store = createMutableDocsStore({
      extraDocs: [
        {
          path: 'other.md',
          kind: 'markdown',
          content: '# Other Document\n\nDestination content.',
          revision: 'rev-other-1',
          modifiedAt: hoursAgo(1.5),
          editable: true,
        },
      ],
    });
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByTestId('open-in-reader').click();

    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const editor = reader.getByTestId('document-editor');
    await editor.locator('textarea').fill('# Draft with link\n\nSee [other doc](other.md)');
    await editor.getByRole('tab', { name: 'Preview', exact: true }).click();
    await editor.getByRole('link', { name: 'other doc' }).click();

    // Unsaved changes AlertDialog must block immediate navigation
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Unsaved changes');

    // Keep editing stays on PLAN.md with draft intact
    await alert.getByRole('button', { name: 'Keep editing' }).click();
    await expect(alert).toHaveCount(0);
    await expect(reader).toContainText('PLAN.md');
    await editor.getByRole('tab', { name: 'Write', exact: true }).click();
    await expect(editor.locator('textarea')).toHaveValue('# Draft with link\n\nSee [other doc](other.md)');

    // Click link again and Discard changes -> opens other.md and leaves NO orphaned draft on PLAN.md
    await editor.getByRole('tab', { name: 'Preview', exact: true }).click();
    await editor.getByRole('link', { name: 'other doc' }).click();
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Discard changes' }).click();
    await expect(reader).toContainText('other.md');
    await expect(reader.getByRole('heading', { name: 'Other Document' })).toBeVisible();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);

    // Returning to PLAN.md must show disk content in preview, NOT orphaned dirty Edit mode
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByTestId('open-in-reader').click();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await expect(reader.getByRole('heading', { name: 'New canvas interaction' })).toBeVisible();
  });

  test('fix1-4: restores focus to a visible control (never document.body) when exiting Side Pane, Reader, and Expanded Reader editors', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    const assertFocusedInsideDocs = async (contextLabel: string) => {
      await page.waitForTimeout(350);
      const info = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const docsEl = document.querySelector('[data-documents-page]');
        return {
          tag: active?.tagName ?? null,
          inDocs: Boolean(active && docsEl?.contains(active)),
          visible: Boolean(active && !active.closest('[inert], [hidden]') && active.getClientRects().length > 0),
        };
      });
      expect(info.tag, `${contextLabel}: focus dropped to BODY`).not.toBe('BODY');
      expect(info.inDocs, `${contextLabel}: focus left DocumentsPage`).toBe(true);
      expect(info.visible, `${contextLabel}: focused hidden element`).toBe(true);
    };

    // 1a. Side pane clean Escape
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await expect(sideTextarea).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(docs.locator('aside').getByTestId('document-editor')).toHaveCount(0);
    await assertFocusedInsideDocs('side clean Escape');

    // 1b. Side pane Save
    await docs.getByTestId('side-edit-button').click();
    await sideTextarea.fill('# Side Saved Focus Check');
    await docs.locator('aside').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(docs.locator('aside').getByTestId('document-editor')).toHaveCount(0);
    await assertFocusedInsideDocs('side Save');

    // 1c. Side pane dirty Escape -> Discard changes
    await docs.getByTestId('side-edit-button').click();
    await sideTextarea.fill('# Side Dirty Discard Focus Check');
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(docs.locator('aside').getByTestId('document-editor')).toHaveCount(0);
    await assertFocusedInsideDocs('side dirty Escape -> Discard');

    // 2a. Reader clean Escape
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const readerTextarea = reader.getByTestId('document-editor').locator('textarea');
    await expect(readerTextarea).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await assertFocusedInsideDocs('reader clean Escape');

    // 2b. Reader Save
    await reader.getByRole('button', { name: 'Edit document' }).click();
    await readerTextarea.fill('# Reader Saved Focus Check');
    await reader.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await assertFocusedInsideDocs('reader Save');

    // 2c. Reader dirty Escape -> Discard changes
    await reader.getByRole('button', { name: 'Edit document' }).click();
    await readerTextarea.fill('# Reader Dirty Discard Focus Check');
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await assertFocusedInsideDocs('reader dirty Escape -> Discard');

    // 3. Expanded Reader dirty Escape -> Discard changes
    await reader.getByRole('button', { name: 'Expand document' }).click();
    const expanded = page.getByTestId('document-viewer-expanded');
    await expect(expanded).toBeVisible();
    await expanded.getByRole('button', { name: 'Edit document' }).click();
    const expandedTextarea = expanded.getByTestId('document-editor').locator('textarea');
    await expect(expandedTextarea).toBeFocused();
    await expandedTextarea.fill('# Expanded Dirty Discard Focus Check');
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(reader.getByTestId('document-editor')).toHaveCount(0);
    await assertFocusedInsideDocs('expanded reader dirty Escape -> Discard');
  });

  test('fix1-extra: covers active Docs rail toggle, narrow Ask in CLI draft survival, and Save & continue on Preview link', async ({ page }) => {
    await page.route('**/api/terminals/bootstrap', (route) =>
      route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }),
    );
    await page.route('**/api/terminals/*/status', (route) =>
      route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }),
    );
    await page.route('**/api/workspace/*/sessions*', (route) =>
      route.fulfill({ json: { sessions: [] } }),
    );

    const store = createMutableDocsStore({
      extraDocs: [
        {
          path: 'other.md',
          kind: 'markdown',
          content: '# Other Document\n\nDestination content.',
          revision: 'rev-other-1',
          modifiedAt: hoursAgo(1.5),
          editable: true,
        },
      ],
    });
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    // Active Docs rail click toggles to chat and back without losing side draft
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    await docs.locator('aside').getByTestId('document-editor').locator('textarea').fill('# RAIL TOGGLE DRAFT');
    await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
    await expect(docs).toHaveCount(0);
    await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(page).toHaveURL(/#\/workspaces\/demo\/documents$/);
    await expect(docs.locator('aside').getByTestId('document-editor').locator('textarea')).toHaveValue('# RAIL TOGGLE DRAFT');

    // Open in Reader -> Save & continue on Preview link persists changes and navigates to other.md cleanly
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    const editor = reader.getByTestId('document-editor');
    await editor.locator('textarea').fill('# Saved via Link\n\nSee [other doc](other.md)');
    await editor.getByRole('tab', { name: 'Preview', exact: true }).click();
    await editor.getByRole('link', { name: 'other doc' }).click();

    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Save & continue' }).click();
    await expect(reader).toContainText('other.md');
    expect(store.docs.get('PLAN.md')?.content).toBe('# Saved via Link\n\nSee [other doc](other.md)');

    // Expanded clean Escape & Save keep focus on a visible control (not BODY)
    await reader.getByRole('button', { name: 'Expand document' }).click();
    const expanded = page.getByTestId('document-viewer-expanded');
    await expanded.getByRole('button', { name: 'Edit document' }).click();
    await page.keyboard.press('Escape');
    await expect(expanded.getByTestId('document-editor')).toHaveCount(0);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });
});

test.describe('DC2 adversarial probes', () => {
  test.use({
    workspacesData: [[DEMO], { option: true }],
    viewport: { width: 1440, height: 900 },
  });

  test('probe-A: Docs -> Board / Overview / Skills -> Docs while editing in Wide side pane must keep side editor in aside (no forced Reader)', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await sideTextarea.fill('# SIDE DRAFT ACROSS BOARD');

    for (const [label, urlPattern] of [
      ['Board', /#\/workspaces\/demo\/board$/],
      ['Overview', /#\/workspaces\/demo\/overview$/],
      ['Skills', /#\/workspaces\/demo\/skills$/],
    ] as const) {
      await workspaceNav(page).getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(urlPattern);
      await expect(workspaceNav(page).getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
      await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
      await expect(page).toHaveURL(/#\/workspaces\/demo\/documents$/);
      await expect(workspaceNav(page).getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(docs.locator('[data-documents-reader]')).toHaveCount(0);
      await expect(docs.locator('aside').getByTestId('document-editor').locator('textarea')).toHaveValue('# SIDE DRAFT ACROSS BOARD');
    }
  });

  test('probe-B: side-discard-dialog Keep editing followed immediately (<50ms) by Escape must re-open discard dialog', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await sideTextarea.fill('# SIDE DIRTY FAST ESCAPE');

    await page.keyboard.press('Escape');
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Keep editing' }).click();
    // Immediate Escape right after Keep editing (within Base UI 200ms animation window)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveAttribute('data-ending-style', '');
  });

  test('probe-C: pressing Escape on Reader discardPrompt AlertDialog must preserve focus inside Reader (never BODY)', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();
    await reader.getByTestId('document-editor').locator('textarea').fill('# READER ESCAPE ALERT');

    await page.keyboard.press('Escape');
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    // Dismiss AlertDialog with Escape (not Keep editing button)
    await page.keyboard.press('Escape');
    await expect(alert).toHaveCount(0);
    await page.waitForTimeout(250);
    const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? null);
    const inReader = await page.evaluate(() => Boolean(document.querySelector('[data-documents-reader]')?.contains(document.activeElement)));
    expect(activeTag).not.toBe('BODY');
    expect(inReader).toBe(true);
  });

  test('probe-D: side-pane Discard changes and Save & continue -> select uncached editable doc with delayed preview must NOT focus disabled Edit button (BODY)', async ({ page }) => {
    const store = createMutableDocsStore({
      extraDocs: [
        {
          path: 'other.md',
          kind: 'markdown',
          content: '# Other Doc',
          revision: 'rev-other-1',
          modifiedAt: hoursAgo(2),
          editable: true,
        },
        {
          path: 'slow2.md',
          kind: 'markdown',
          content: '# Slow Doc 2',
          revision: 'rev-slow2-1',
          modifiedAt: hoursAgo(2.5),
          editable: true,
        },
      ],
    });
    await store.install(page, 'demo');
    await page.route('**/api/workspace/demo/documents/preview?*', async (route) => {
      const name = new URL(route.request().url()).searchParams.get('name') ?? '';
      if (name === 'other.md' || name === 'slow2.md') {
        await new Promise((r) => setTimeout(r, 350));
      }
      const doc = store.docs.get(name);
      if (!doc) return route.fulfill({ status: 404, json: { error: `Not found: ${name}` } });
      return route.fulfill({
        json: {
          name: doc.path,
          kind: doc.kind,
          size: Buffer.byteLength(doc.content, 'utf8'),
          modifiedAt: doc.modifiedAt,
          revision: doc.revision,
          editable: doc.editable,
          content: doc.content,
        },
      });
    });

    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);

    // 1. Discard changes -> uncached slow doc
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    await docs.locator('aside').getByTestId('document-editor').locator('textarea').fill('# DIRTY BEFORE DISCARD SELECT');

    await docs.locator('button[data-doc-path="other.md"]').last().click();
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Discard changes' }).click();

    await page.waitForTimeout(100);
    const discardInfo = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      disabled: (document.activeElement as HTMLButtonElement | null)?.disabled ?? false,
      inDocs: Boolean(document.querySelector('[data-documents-page]')?.contains(document.activeElement)),
    }));
    expect(discardInfo.tag).not.toBe('BODY');
    expect(discardInfo.disabled).toBe(false);
    expect(discardInfo.inDocs).toBe(true);

    // 2. Save & continue -> another uncached slow doc
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    await docs.locator('aside').getByTestId('document-editor').locator('textarea').fill('# SAVED BEFORE SLOW2');

    await docs.locator('button[data-doc-path="slow2.md"]').last().click();
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Save & continue' }).click();

    await page.waitForTimeout(100);
    const saveInfo = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      disabled: (document.activeElement as HTMLButtonElement | null)?.disabled ?? false,
      inDocs: Boolean(document.querySelector('[data-documents-page]')?.contains(document.activeElement)),
    }));
    expect(saveInfo.tag).not.toBe('BODY');
    expect(saveInfo.disabled).toBe(false);
    expect(saveInfo.inDocs).toBe(true);
    expect(store.docs.get('PLAN.md')?.content).toBe('# SAVED BEFORE SLOW2');
  });

  test('probe-E: Reader discardPrompt Save & continue / Save & close hitting 409 CONFLICT across all 3 actions must restore focus inside Reader (never BODY)', async ({ page }) => {
    const store = createMutableDocsStore({
      extraDocs: [
        {
          path: 'other.md',
          kind: 'markdown',
          content: '# Other Doc',
          revision: 'rev-other-1',
          modifiedAt: hoursAgo(2),
          editable: true,
        },
      ],
    });
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    const alert = page.getByRole('alertdialog');

    const assertConflictFocus = async (label: string) => {
      await expect(reader.getByTestId('document-conflict-bar')).toBeVisible();
      await page.waitForTimeout(100);
      const info = await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? null,
        inReader: Boolean(document.querySelector('[data-documents-reader]')?.contains(document.activeElement)),
        inConflictBar: Boolean(document.querySelector('[data-testid="document-conflict-bar"]')?.contains(document.activeElement)),
      }));
      expect(info.tag, `${label}: dropped to BODY`).not.toBe('BODY');
      expect(info.inReader, `${label}: left Reader`).toBe(true);
      expect(info.inConflictBar, `${label}: did not focus conflict bar`).toBe(true);
    };

    // 1. open-link -> Save & continue -> 409
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const editor = reader.getByTestId('document-editor');
    await editor.locator('textarea').fill('# Link draft\n\nSee [other](other.md)');
    await editor.getByRole('tab', { name: 'Preview', exact: true }).click();
    await editor.getByRole('link', { name: 'other' }).click();
    await expect(alert).toBeVisible();
    store.bumpExternal('PLAN.md', '# External edit 1');
    await alert.getByRole('button', { name: 'Save & continue' }).click();
    await assertConflictFocus('open-link 409');

    // Reset conflict via Load latest
    await reader.getByTestId('document-conflict-bar').getByRole('button', { name: 'Load latest' }).click();
    await editor.getByRole('tab', { name: 'Write', exact: true }).click();

    // 2. cancel-edit -> Save & continue -> 409
    await editor.locator('textarea').fill('# Cancel draft 409');
    await reader.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(alert).toBeVisible();
    store.bumpExternal('PLAN.md', '# External edit 2');
    await alert.getByRole('button', { name: 'Save & continue' }).click();
    await assertConflictFocus('cancel-edit 409');

    // Reset conflict via Load latest
    await reader.getByTestId('document-conflict-bar').getByRole('button', { name: 'Load latest' }).click();

    // 3. close-reader -> Save & close -> 409
    await editor.locator('textarea').fill('# Close draft 409');
    await reader.getByRole('button', { name: 'Close document', exact: true }).click();
    await expect(alert).toBeVisible();
    store.bumpExternal('PLAN.md', '# External edit 3');
    await alert.getByRole('button', { name: 'Save & close' }).click();
    await assertConflictFocus('close-reader 409');
  });

  test.describe('narrow Ask in CLI with slim sidebar (1040x800)', () => {
    test.use({
      sidebarDocked: false,
      viewport: { width: 1040, height: 800 },
    });

    test('probe-F: narrow Ask in CLI (< 1000px bodyWidth where side pane is visible) preserves unsaved side draft across chat unmount/remount', async ({ page }) => {
      await page.route('**/api/terminals/bootstrap', (route) =>
        route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }),
      );
      await page.route('**/api/terminals/*/status', (route) =>
        route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }),
      );
      await page.route('**/api/workspace/*/sessions*', (route) =>
        route.fulfill({ json: { sessions: [] } }),
      );
      const store = createMutableDocsStore();
      await store.install(page, 'demo');
      await page.goto('/#/workspaces/demo/documents');

      const docs = docsRegion(page);
      await expect(docs.locator('aside')).toBeVisible();
      await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
      await docs.getByTestId('side-edit-button').click();
      await docs.locator('aside').getByTestId('document-editor').locator('textarea').fill('# NARROW ASK IN CLI DRAFT');
      await docs.locator('aside').getByRole('button', { name: 'Ask in CLI' }).click();

      await expect(page).toHaveURL(/#\/workspaces\/demo\/chat$/);
      await expect(docs).toHaveCount(0);
      await workspaceNav(page).getByRole('link', { name: 'Docs', exact: true }).click();
      await expect(docs.locator('aside').getByTestId('document-editor').locator('textarea')).toHaveValue('# NARROW ASK IN CLI DRAFT');
    });
  });

  test('probe-G: clicking relative & self Markdown links in side-pane DocumentEditor Preview tab guards unsaved draft cleanly', async ({ page }) => {
    const store = createMutableDocsStore({
      extraDocs: [
        {
          path: 'other.md',
          kind: 'markdown',
          content: '# Other Doc',
          revision: 'rev-other-1',
          modifiedAt: hoursAgo(2),
          editable: true,
        },
      ],
    });
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideEditor = docs.locator('aside').getByTestId('document-editor');
    await sideEditor.locator('textarea').fill('# Side dirty link\n\nSee [other](other.md) and [self](PLAN.md)');
    await sideEditor.getByRole('tab', { name: 'Preview', exact: true }).click();

    // 1. Self-link inside side editor Preview must be a clean no-op
    await sideEditor.getByRole('link', { name: 'self' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(docs.locator('[data-documents-reader]')).toHaveCount(0);

    // 2. Link to other.md while dirty must open discard dialog; Keep editing preserves draft & focus
    await sideEditor.getByRole('link', { name: 'other' }).click();
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Keep editing' }).click();
    await expect(alert).toHaveCount(0);
    await page.waitForTimeout(100);
    const keepFocusTag = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      inAside: Boolean(document.querySelector('[data-documents-page] aside')?.contains(document.activeElement)),
    }));
    expect(keepFocusTag.tag).not.toBe('BODY');
    expect(keepFocusTag.inAside).toBe(true);

    // 3. Discard changes clears side edit cleanly (zero orphan) and opens other.md in Reader
    await sideEditor.getByRole('link', { name: 'other' }).click();
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Discard changes' }).click();
    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    await expect(reader).toContainText('other.md');
    await expect(docs.locator('aside').getByTestId('document-editor')).toHaveCount(0);

    // Close Reader and verify Save & continue from side editor Preview link persists PLAN.md and opens other.md
    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await docs.getByTestId('side-edit-button').click();
    await sideEditor.locator('textarea').fill('# Saved from side link\n\nSee [other](other.md)');
    await sideEditor.getByRole('tab', { name: 'Preview', exact: true }).click();
    await sideEditor.getByRole('link', { name: 'other' }).click();
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Save & continue' }).click();
    await expect(reader).toBeVisible();
    await expect(reader).toContainText('other.md');
    expect(store.docs.get('PLAN.md')?.content).toBe('# Saved from side link\n\nSee [other](other.md)');
    await expect(docs.locator('aside').getByTestId('document-editor')).toHaveCount(0);
  });

  test('probe-H (#4c): clicking current breadcrumb while dirty in side pane is a no-op; clearing search via current breadcrumb restores focus to breadcrumb', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    const crumbs = docs.getByRole('navigation', { name: 'Breadcrumbs' });

    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideTextarea = docs.locator('aside').getByTestId('document-editor').locator('textarea');
    await sideTextarea.fill('# DIRTY ROOT CRUMB CHECK');

    // Clicking current root breadcrumb ("All folders") without active search must be a clean no-op
    await crumbs.getByRole('button', { name: 'All folders' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(sideTextarea).toHaveValue('# DIRTY ROOT CRUMB CHECK');

    // Now search while dirty at root, click "All folders" breadcrumb -> Discard changes -> clears search and focuses breadcrumb (never BODY)
    await docs.getByPlaceholder('Find a document by title, words or path').fill('PLAN');
    await crumbs.getByRole('button', { name: 'All folders' }).click();
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Discard changes' }).click();
    await expect(docs.getByPlaceholder('Find a document by title, words or path')).toHaveValue('');
    await page.waitForTimeout(100);
    const focusInfo = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      text: document.activeElement?.textContent?.trim() ?? '',
    }));
    expect(focusInfo.tag).not.toBe('BODY');
    expect(focusInfo.text).toBe('All folders');
  });

  test('probe-I (#4d): 409 CONFLICT -> Load latest while on Preview tab in both Side Pane and Reader never drops focus to BODY', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideEditor = docs.locator('aside').getByTestId('document-editor');
    await sideEditor.locator('textarea').fill('# Side preview 409');
    await sideEditor.getByRole('tab', { name: 'Preview', exact: true }).click();
    store.bumpExternal('PLAN.md', '# Side latest V2');
    await docs.locator('aside').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sideEditor.getByTestId('document-conflict-bar')).toBeVisible();
    await sideEditor.getByTestId('document-conflict-bar').getByRole('button', { name: 'Load latest' }).click();
    await page.waitForTimeout(100);
    const sideFocus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      inAside: Boolean(document.querySelector('[data-documents-page] aside')?.contains(document.activeElement)),
    }));
    expect(sideFocus.tag).not.toBe('BODY');
    expect(sideFocus.inAside).toBe(true);

    // Discard side edit and verify Reader Preview tab 409 -> Load latest
    await docs.locator('aside').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(docs.locator('aside').getByTestId('document-editor')).toHaveCount(0);
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const readerEditor = reader.getByTestId('document-editor');
    await readerEditor.locator('textarea').fill('# Reader preview 409');
    await readerEditor.getByRole('tab', { name: 'Preview', exact: true }).click();
    store.bumpExternal('PLAN.md', '# Reader latest V3');
    await reader.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(readerEditor.getByTestId('document-conflict-bar')).toBeVisible();
    await readerEditor.getByTestId('document-conflict-bar').getByRole('button', { name: 'Load latest' }).click();
    await page.waitForTimeout(100);
    const readerFocus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      inReader: Boolean(document.querySelector('[data-documents-reader]')?.contains(document.activeElement)),
    }));
    expect(readerFocus.tag).not.toBe('BODY');
    expect(readerFocus.inReader).toBe(true);
  });

  test('pressing Save on a conflict in the side pane moves focus to the conflict choices', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideEditor = docs.locator('aside').getByTestId('document-editor');
    await sideEditor.locator('textarea').fill('# Side save conflict');
    store.bumpExternal('PLAN.md', '# Side external');
    await docs.locator('aside').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sideEditor.getByTestId('document-conflict-bar')).toBeVisible();
    await expect(sideEditor.getByTestId('document-conflict-bar').getByRole('button', { name: 'Overwrite with mine' })).toBeFocused();
    await expect(sideEditor.locator('textarea')).toHaveValue('# Side save conflict');
  });

  test('pressing Save on a conflict in the reader moves focus to the conflict choices', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();
    const readerEditor = reader.getByTestId('document-editor');
    await readerEditor.locator('textarea').fill('# Reader save conflict');
    store.bumpExternal('PLAN.md', '# Reader external');
    await reader.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(readerEditor.getByTestId('document-conflict-bar')).toBeVisible();
    await expect(readerEditor.getByTestId('document-conflict-bar').getByRole('button', { name: 'Overwrite with mine' })).toBeFocused();
    await expect(readerEditor.locator('textarea')).toHaveValue('# Reader save conflict');
  });

  test('Ctrl+S on a conflict keeps focus in the text', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.getByTestId('side-edit-button').click();
    const sideEditor = docs.locator('aside').getByTestId('document-editor');
    const textarea = sideEditor.locator('textarea');
    await textarea.fill('# Ctrl+S conflict');
    store.bumpExternal('PLAN.md', '# Ctrl+S external');
    await textarea.press('Control+s');
    await expect(sideEditor.getByTestId('document-conflict-bar')).toBeVisible();
    await page.waitForTimeout(200);
    await expect(textarea).toBeFocused();
  });

  test('probe-J (#4e): Reader Inline Edit -> Expand -> Collapse -> 409 -> Load latest on Write tab focuses active textarea cleanly', async ({ page }) => {
    const store = createMutableDocsStore();
    await store.install(page, 'demo');
    await page.goto('/#/workspaces/demo/documents');

    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();
    await docs.locator('aside').getByTestId('open-in-reader').click();
    const reader = docs.locator('[data-documents-reader]');
    await reader.getByRole('button', { name: 'Edit document' }).click();

    await reader.getByRole('button', { name: 'Expand document' }).click();
    const expanded = page.getByTestId('document-viewer-expanded');
    await expect(expanded).toBeVisible();
    await expect(page.getByTestId('document-editor')).toHaveCount(1);
    const expandedTextarea = expanded.getByTestId('document-editor').locator('textarea');
    await expandedTextarea.fill('# Edited while expanded');

    await expanded.getByRole('button', { name: 'Expand document' }).click();
    await expect(expanded).toHaveCount(0);

    const inlineTextarea = reader.getByTestId('document-editor').locator('textarea');
    await expect(inlineTextarea).toHaveValue('# Edited while expanded');

    // Trigger 409 -> Load latest and verify inline textarea receives focus (never BODY)
    store.bumpExternal('PLAN.md', '# Fresh server content after collapse');
    await reader.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(reader.getByTestId('document-conflict-bar')).toBeVisible();
    await reader.getByTestId('document-conflict-bar').getByRole('button', { name: 'Load latest' }).click();
    await expect(inlineTextarea).toHaveValue('# Fresh server content after collapse');
    await expect(inlineTextarea).toBeFocused();

    // Dirty Escape -> Keep editing after Expand -> Collapse must also return focus to inline textarea
    await inlineTextarea.fill('# Dirty after collapse');
    await page.keyboard.press('Escape');
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Keep editing' }).click();
    await expect(inlineTextarea).toBeFocused();
  });

  test('PX1: Markdown picture in side preview and reader opens in reader without nested buttons and returns focus on Escape', async ({ page }) => {
    await mockCatalogAndPreviews(page);
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
      const name = new URL(route.request().url()).searchParams.get('name') ?? '';
      if (name === 'PLAN.md') {
        return route.fulfill({
          json: {
            name,
            kind: 'markdown',
            size: 180,
            modifiedAt: hoursAgo(1),
            content: [
              '# Plan with images',
              '',
              '![Mock screenshot](board-pictures/mock-shot.png)',
              '',
              '[![Linked pic](board-pictures/linked.png)](design/plans/workspace-db.md)',
              '',
              '![Remote pic](https://example.com/remote.png)',
            ].join('\n'),
          },
        });
      }
      if (name.endsWith('.png')) {
        return route.fulfill({ json: { name, kind: 'image', size: 250, modifiedAt: hoursAgo(1) } });
      }
      return route.fulfill({
        json: { name, kind: 'markdown', size: 140, modifiedAt: hoursAgo(1), content: `# Preview of ${name}` },
      });
    });

    await page.goto('/#/workspaces/demo/documents');
    const docs = docsRegion(page);
    await docs.locator('button[data-doc-path="PLAN.md"]').last().click();

    const aside = docs.locator('aside');
    const sidePicBtn = aside.getByRole('button', { name: 'Mock screenshot', exact: true });
    await expect(sidePicBtn).toBeVisible();
    await expect(sidePicBtn.locator('img')).toBeVisible();
    await expect(aside.getByRole('link').filter({ has: page.locator('button') })).toHaveCount(0);
    await expect(aside.locator('img[src="https://example.com/remote.png"]')).toBeVisible();
    await assertReadableAndPressable(docs);

    await sidePicBtn.focus();
    await sidePicBtn.press('Enter');
    const reader = docs.locator('[data-documents-reader]');
    await expect(reader).toBeVisible();
    await expect(reader.getByRole('img', { name: 'board-pictures/mock-shot.png' })).toBeVisible();
    await expect(reader.getByRole('button', { name: 'Close document', exact: true })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(reader).toHaveCount(0);
    await expect(sidePicBtn).toBeFocused();

    await docs.locator('aside').getByTestId('open-in-reader').click();
    await expect(reader).toBeVisible();
    const readerPicBtn = reader.getByRole('button', { name: 'Mock screenshot', exact: true });
    await expect(readerPicBtn).toBeVisible();
    await readerPicBtn.click();
    await expect(reader.getByRole('img', { name: 'board-pictures/mock-shot.png' })).toBeVisible();
  });
});
