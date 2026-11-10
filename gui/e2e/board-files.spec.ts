import { test, expect } from './fixtures';
import { workspace, routeBoard, routeCards, routePictures, boardEvent, routeWork, document } from './boardHelpers';
import { boardFile, boardNote } from './planData';

test.use({ workspacesData: [[workspace, { ...workspace, id: 'other', branchName: 'other', workspacePath: '/tmp/other' }], { option: true }], viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  // Every interaction uses mocked reads; unexpected writes cannot reach a backend.
  await page.route('**/api/**', (route) => ['GET', 'HEAD'].includes(route.request().method()) ? route.fallback() : route.fulfill({ status: 405, json: { error: 'Writes disabled in Files tests' } }));
});

test('Files loads on demand, searches origins, and opens scoped documents', async ({ page }) => {
  let listings = 0;
  await routeBoard(page);
  await routePictures(page);
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', async (route) => {
    listings++;
    await route.fulfill({ json: { files: [{ path: 'docs/guide.md' }], truncated: false, errors: [] } });
  });
  await page.route('**/api/workspace/demo/changes?include=all', async (route) => {
    listings++;
    await route.fulfill({ json: { changes: [{ repoName: 'api', repoPath: '/repos/api', files: [{ file: 'docs/guide.md', type: 'unchanged' }] }, { repoName: 'web', repoPath: '/repos/web', files: [{ file: 'docs/guide.md', type: 'unchanged' }] }] } });
  });
  await page.route('**/api/workspace/demo/documents/preview?*', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ json: { name: 'docs/guide.md', kind: 'markdown', content: `# ${url.searchParams.get('repo') ?? 'workspace'} guide` } });
  });
  await page.goto('/#/workspaces/demo/board');
  await expect(page.getByRole('button', { name: 'Board index' })).toBeVisible();
  expect(listings).toBe(0);
  await page.getByRole('button', { name: 'Board index' }).click();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(nav.getByText('Workspace documents and repository files.', { exact: false })).toBeVisible();
  await expect(nav.getByText('Repository · api')).toBeVisible();
  const loadedRequests = listings;
  expect(loadedRequests).toBeGreaterThanOrEqual(2);
  await nav.getByPlaceholder('Search files…').fill('web');
  await expect(nav.getByText('Repository · web')).toBeVisible();
  await expect(nav.getByText('Repository · api')).toBeHidden();
  for (const query of ['API guide', 'guide api']) {
    await nav.getByPlaceholder('Search files…').fill(query);
    await expect(nav.getByRole('button', { name: 'docs/guide.md Repository · api', exact: true })).toBeVisible();
    await expect(nav.getByText('Repository · web')).toBeHidden();
  }
  await nav.getByPlaceholder('Search files…').fill('missing');
  await expect(nav.getByText('No matches found')).toBeVisible();
  expect(listings).toBe(loadedRequests);
  await nav.getByPlaceholder('Search files…').fill('');
  await nav.getByRole('button', { name: /docs\/guide.md Repository · api/ }).click();
  await expect(page.getByRole('heading', { name: 'api guide' })).toBeVisible();
});

async function filesSetup(page: import('@playwright/test').Page, docs: string[], changes: unknown[]) {
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) => route.fulfill({ json: { files: docs.filter((name) => !name.startsWith('isolated-api/')).map((path) => ({ path })), truncated: false, errors: [] } }));
  await page.route('**/api/workspace/demo/changes?include=all', (route) => route.fulfill({ json: { changes } }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: 'Board index', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  return nav;
}
const repos = [{ repoName: 'api', repoPath: '/tmp/demo/isolated-api', files: [{ file: 'docs/guide.md', type: 'unchanged' }, { file: 'src/server.ts', type: 'unchanged' }] }, { repoName: 'web', repoPath: '/repos/web', files: [{ file: 'docs/guide.md', type: 'unchanged' }] }];

test('empty Board narrow Files gives way to reader and returns to chosen result with query', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({ json: { kind: 'markdown', content: '# Narrow guide' } }));
  const nav = await filesSetup(page, ['docs/guide.md'], repos);
  await nav.getByPlaceholder('Search files…').fill('api');
  const result = nav.getByRole('button', { name: /docs\/guide.md Repository · api/ });
  await result.click();
  await expect(nav).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Narrow guide' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nav).toBeVisible();
  await expect(nav.getByPlaceholder('Search files…')).toHaveValue('api');
  await expect(result).toBeFocused();
});

test('same paths keep workspace and repository cache identities and links', async ({ page }) => {
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const url = new URL(route.request().url());
    const origin = url.searchParams.get('repo') ?? 'workspace';
    const next = url.searchParams.get('name') === 'docs/next.md';
    return route.fulfill({ json: { kind: 'markdown', content: `# ${origin} ${next ? 'next' : 'guide'}\n\n[Next](./next.md)\n\n![Diagram](./diagram.png)` } });
  });
  await routeWork(page, [document('Adapter guide', { filename: 'docs/guide.md' })]);
  const nav = await filesSetup(page, ['docs/guide.md', 'isolated-api/docs/guide.md'], repos);
  await expect(nav.getByRole('button', { name: /guide.md/ })).toHaveCount(3);
  for (const origin of ['Workspace', 'Repository · api', 'Repository · web']) {
    await nav.getByRole('button', { name: `docs/guide.md ${origin}`, exact: true }).click();
    const name = origin === 'Workspace' ? 'workspace' : origin.split(' · ')[1];
    await expect(page.getByRole('heading', { name: `${name} guide`, exact: true })).toBeVisible();
    if (name === 'api') {
      await expect(page.getByRole('img', { name: 'Diagram' })).toHaveAttribute('src', /name=docs%2Fdiagram.png&repo=api/);
      await page.getByRole('link', { name: 'Next', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'api next' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('heading', { name: 'api guide' })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(nav).toBeVisible();
  }
});

test('listing failure never labels repo documents Workspace; retry and capped results are honest', async ({ page }) => {
  let failed = true;
  await page.route('**/api/workspace/demo/changes?include=all', (route) => failed ? route.fulfill({ status: 500, json: { error: 'offline' } }) : route.fulfill({ json: { changes: repos } }));
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/files', (route) => route.fulfill({ json: { files: Array.from({ length: 205 }, (_, i) => ({ path: `notes/${i}.md` })), truncated: false, errors: [] } }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: 'Board index', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(nav.getByRole('alert')).toContainText('Repository files could not be loaded');
  await expect(nav.getByRole('button', { name: /isolated-api/ })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: 'notes/0.md Workspace', exact: true })).toBeVisible();
  failed = false;
  await nav.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(nav.getByText('Showing 200 of 208 matches. Refine your search.')).toBeVisible();
  await expect(nav.getByRole('button', { name: /isolated-api/ })).toHaveCount(0);
  await nav.getByPlaceholder('Search files…').fill('api');
  await expect(nav.getByText('Repository · api')).toHaveCount(2);
  await nav.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(nav.getByRole('button', { name: /src\/server.ts/ })).toBeVisible();
});

test('repo code opens existing Code on the explicit file and returns to narrow Files', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const asked: string[] = [];
  await page.route('**/api/workspace/demo/changes/diff?*', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ json: { diff: '', fileContent: 'export const server = "api";' } });
  });
  const nav = await filesSetup(page, [], repos);
  await nav.getByPlaceholder('Search files…').fill('server');
  const result = nav.getByRole('button', { name: /src\/server.ts Repository · api/ });
  await result.click();
  await expect(nav).toBeHidden();
  const win = page.getByRole('region', { name: 'Code window' });
  await expect(win).toBeVisible();
  await expect.poll(() => asked.some((value) => { const url = new URL(value); return url.searchParams.get('repo') === 'api' && url.searchParams.get('file') === 'src/server.ts'; })).toBe(true);
  await win.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(nav).toBeVisible();
  await expect(result).toBeFocused();
  await expect(nav.getByPlaceholder('Search files…')).toHaveValue('server');
});

test('repo HTML keeps scoped view link, relative asset, form and download through live Board changes', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/workspace/demo/screen-events**', async (route) => { await held; await route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' + boardEvent(2) }).catch(() => {}); });
  const viewRequests: unknown[] = [];
  const assets: string[] = [];
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => route.fulfill({ json: { kind: 'html', content: '<h1>Raw</h1>' } }));
  await page.route('**/api/workspace/demo/documents/view-link', (route) => {
    viewRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { token: 'api-page', url: '/view/api-page/docs/page.html', scope: 'docs' } });
  });
  await page.route('**/view/api-page/**', (route) => {
    if (new URL(route.request().url()).pathname.endsWith('theme.css')) {
      assets.push(route.request().url());
      return route.fulfill({ contentType: 'text/css', body: 'h1 { color: rgb(12, 34, 56); }' });
    }
    return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="theme.css"></head><body><h1>API page</h1><input aria-label="Draft"></body></html>' });
  });
  const nav = await filesSetup(page, [], [{ ...repos[0], files: [{ file: 'docs/page.html', type: 'unchanged' }] }]);
  await nav.getByRole('button', { name: /docs\/page.html/ }).click();
  const frame = page.frameLocator('iframe[title="Preview of docs/page.html"]');
  await expect(frame.getByRole('heading', { name: 'API page' })).toBeVisible();
  expect(viewRequests).toContainEqual({ name: 'docs/page.html', repo: 'api' });
  await expect.poll(() => assets.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open in browser', exact: true })).toHaveAttribute('href', /\/view\/api-page\/docs\/page.html$/);
  await expect(page.getByRole('menuitem', { name: 'Download', exact: true })).toHaveAttribute('href', /\/view\/api-page\/docs\/page.html\?download=1$/);
  await page.keyboard.press('Escape');
  let updatedReads = 0;
  await page.route('**/api/workspace/demo/board', (route) => { updatedReads++; return route.fulfill({ json: boardFile({ revision: 2, cards: [boardNote(9, { title: 'New live note' })] }) }); });
  await frame.getByRole('textbox', { name: 'Draft' }).fill('keep my draft');
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(frame.getByRole('textbox', { name: 'Draft' })).toHaveValue('keep my draft');
  release();
  await expect.poll(() => updatedReads).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
  await expect(frame.getByRole('textbox', { name: 'Draft' })).toHaveValue('keep my draft');
});

test('loading, partial repository failure, workspace failure, retry and empty state', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let fail = true;
  await page.route('**/api/workspace/demo/changes?include=all', async (route) => {
    await held;
    return route.fulfill({ json: { changes: fail ? [{ ...repos[0], error: 'Cannot read api', files: [] }, repos[1]] : [] } });
  });
  await page.route('**/api/workspace/demo/files', (route) => fail ? route.fulfill({ status: 500, json: { error: 'offline' } }) : route.fulfill({ json: { files: [], truncated: false, errors: [] } }));
  await routeCards(page, boardFile({ cards: [] }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: 'Board index', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(nav.getByRole('status')).toHaveText('Loading files…');
  release();
  await expect(nav.getByText('Partial results')).toBeVisible();
  await expect(nav.getByText('Repository · web')).toBeVisible();
  await expect(nav.getByRole('alert')).toHaveCount(2);
  fail = false;
  await nav.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(nav.getByText('No files found')).toBeVisible();
  await expect(nav.getByRole('alert')).toHaveCount(0);
});

test('switching workspaces while Files loads cannot show the old results', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/workspace/demo/changes?include=all', async (route) => { await held; await route.fulfill({ json: { changes: repos } }).catch(() => {}); });
  await page.route('**/api/workspace/demo/files', (route) => route.fulfill({ json: { files: [{ path: 'old-workspace.md' }], truncated: false, errors: [] } }));
  await page.route('**/api/workspace/other/changes?include=all', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/other/files', (route) => route.fulfill({ json: { files: [{ path: 'new-workspace.md' }], truncated: false, errors: [] } }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: 'Board index', exact: true }).click();
  await page.getByRole('navigation', { name: 'Board index' }).getByRole('button', { name: 'Files', exact: true }).click();
  await page.goto('/#/workspaces/other/board');
  release();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  if (!await nav.isVisible()) await page.getByRole('button', { name: 'Board index', exact: true }).click();
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(nav.getByRole('button', { name: 'new-workspace.md Workspace', exact: true })).toBeVisible();
  await expect(nav.getByText('old-workspace.md')).toHaveCount(0);
  await expect(nav.getByText('Repository · api')).toHaveCount(0);
});

test('missing repo document reports its scoped error and returns to Files', async ({ page }) => {
  let asked: URL | undefined;
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    asked = new URL(route.request().url());
    return route.fulfill({ status: 404, json: { error: 'No such document in api.' } });
  });
  const nav = await filesSetup(page, [], repos);
  await nav.getByRole('button', { name: /docs\/guide.md Repository · api/ }).click();
  await expect(page.getByRole('alert')).toContainText('No such document in api.');
  expect(asked?.searchParams.get('repo')).toBe('api');
  expect(asked?.searchParams.get('name')).toBe('docs/guide.md');
  await page.keyboard.press('Escape');
  await expect(nav.getByRole('button', { name: /docs\/guide.md Repository · api/ })).toBeFocused();
});

test('workspace code/config/extensionless files use read-only Code and return to narrow Files, repeatedly', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const reads: string[] = [];
  let diffs = 0;
  await page.route('**/api/workspace/demo/changes/diff?*', (route) => { diffs++; return route.fulfill({ json: { diff: '', fileContent: '' } }); });
  await page.route('**/api/workspace/demo/files/read?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file')!;
    reads.push(name);
    return route.fulfill({ json: { content: name === 'src/shared.ts' ? 'export const origin = "workspace";' : 'workspace configuration' } });
  });
  const nav = await filesSetup(page, ['src/local.ts', 'src/shared.ts', 'config.yaml', 'Makefile'], []);
  const win = page.getByRole('region', { name: 'Code window' });
  for (const name of ['src/shared.ts', 'config.yaml', 'Makefile', 'src/shared.ts']) {
    await nav.getByPlaceholder('Search files…').fill(name);
    const result = nav.getByRole('button', { name: `${name} Workspace`, exact: true });
    await result.click();
    await expect(nav).toBeHidden();
    await expect(win.getByText('Workspace · demo · Read only', { exact: true })).toBeVisible();
    await expect(win.getByTestId('code-file-viewer')).toBeVisible();
    await expect(win.getByTestId('code-file-viewer').locator('textarea')).toHaveJSProperty('readOnly', true);
    await expect(win.getByRole('button', { name: /Commit|Sync|Finish|terminal/i })).toHaveCount(0);
    await expect.poll(() => reads.at(-1)).toBe(name);
    await win.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(result).toBeFocused();
    await expect(nav.getByPlaceholder('Search files…')).toHaveValue(name);
  }
  // StrictMode remounts effects, so compare the requested sequence rather than transport count.
  expect(reads.filter((name, index) => index === 0 || name !== reads[index - 1])).toEqual(['src/shared.ts', 'config.yaml', 'Makefile', 'src/shared.ts']);
  expect(diffs).toBe(0);
});

test('same code path opens workspace, api and web with isolated identities', async ({ page }) => {
  const requested: string[] = [];
  await page.route('**/api/workspace/demo/files/read?*', (route) => { requested.push('workspace'); return route.fulfill({ json: { content: 'export const workspaceOrigin = true;' } }); });
  await page.route('**/api/workspace/demo/changes/diff?*', (route) => {
    const repo = new URL(route.request().url()).searchParams.get('repo')!;
    requested.push(repo);
    return route.fulfill({ json: { diff: '', fileContent: `export const ${repo}Origin = true;` } });
  });
  const nav = await filesSetup(page, ['src/shared.ts'], ['api', 'web'].map((repoName) => ({ repoName, repoPath: `/repos/${repoName}`, files: [{ file: 'src/shared.ts', type: 'unchanged' }] })));
  const win = page.getByRole('region', { name: 'Code window' });
  for (const origin of ['Workspace', 'Repository · api', 'Workspace', 'Repository · web']) {
    await nav.getByRole('button', { name: `src/shared.ts ${origin}`, exact: true }).click();
    await expect(win).toBeVisible();
    const expected = origin === 'Workspace' ? 'workspace' : origin.split(' · ')[1];
    await expect.poll(() => requested.at(-1)).toBe(expected);
    if (origin === 'Workspace') await expect(win.getByText('Workspace · demo · Read only', { exact: true })).toBeVisible();
    else await expect(win.getByTestId('workspace-code-view')).toHaveCount(0);
    await expect(win.getByTestId('code-file-viewer').filter({ visible: true })).toBeVisible();
    await win.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(nav).toBeVisible();
  }
});

test('workspace scan coverage, read error Retry, binary and size omissions are explicit', async ({ page }) => {
  let fail = true;
  await page.route('**/api/workspace/demo/files/read?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file');
    if (name === 'src/local.ts') return fail ? route.fulfill({ status: 400, json: { error: 'File no longer exists.' } }) : route.fulfill({ json: { content: 'const restored = true;' } });
    return route.fulfill({ json: { content: '', omitted: name === 'binary.dat' ? 'binary' : 'too-large' } });
  });
  await page.route('**/api/workspace/demo/files', (route) => route.fulfill({ json: { files: ['src/local.ts', 'binary.dat', 'large.ts'].map((path) => ({ path })), truncated: true, errors: ['Could not scan unreadable.'] } }));
  await routeCards(page, boardFile({ cards: [] }));
  await page.route('**/api/workspace/demo/changes?include=all', (route) => route.fulfill({ json: { changes: [] } }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: 'Board index', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(nav.getByText('Partial results')).toBeVisible();
  await expect(nav.getByText(/Workspace listing is limited/)).toBeVisible();
  await expect(nav.getByText('Could not scan unreadable.')).toBeVisible();
  await nav.getByRole('button', { name: 'src/local.ts Workspace', exact: true }).click();
  const win = page.getByRole('region', { name: 'Code window' });
  await expect(win.getByRole('alert')).toHaveText('File no longer exists.');
  fail = false;
  await win.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(win.getByTestId('code-file-viewer')).toBeVisible();
  await win.getByRole('button', { name: 'Close', exact: true }).click();
  for (const [name, message] of [['binary.dat', 'Binary file: text preview omitted.'], ['large.ts', 'File exceeds the 1 MiB preview limit.']]) {
    await nav.getByRole('button', { name: `${name} Workspace`, exact: true }).click();
    await expect(win.getByRole('status')).toHaveText(message);
    await expect(win.getByTestId('code-file-viewer')).toHaveCount(0);
    await win.getByRole('button', { name: 'Close', exact: true }).click();
  }
});

test('switching workspace while a Code read is pending cannot show old file text', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/workspace/demo/files/read?*', async (route) => { await held; await route.fulfill({ json: { content: 'const OLD_WORKSPACE = true;' } }).catch(() => {}); });
  await page.route('**/api/workspace/other/files', (route) => route.fulfill({ json: { files: [{ path: 'src/shared.ts' }], truncated: false, errors: [] } }));
  await page.route('**/api/workspace/other/changes?include=all', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/other/files/read?*', (route) => route.fulfill({ json: { content: 'const NEW_WORKSPACE = true;' } }));
  const oldNav = await filesSetup(page, ['src/shared.ts'], []);
  await oldNav.getByRole('button', { name: 'src/shared.ts Workspace', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading workspace file' })).toBeVisible();
  await page.goto('/#/workspaces/other/board');
  release();
  const nav = page.getByRole('navigation', { name: 'Board index' });
  if (!await nav.isVisible()) await page.getByRole('button', { name: 'Board index', exact: true }).click();
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await nav.getByRole('button', { name: 'src/shared.ts Workspace', exact: true }).click();
  const win = page.getByRole('region', { name: 'Code window' });
  await expect(win.getByText('Workspace · other · Read only', { exact: true })).toBeVisible();
  await expect(win.getByTestId('code-file-viewer').getByText('NEW_WORKSPACE', { exact: true })).toBeVisible();
  await expect(win.getByText('OLD_WORKSPACE', { exact: true })).toHaveCount(0);
});
