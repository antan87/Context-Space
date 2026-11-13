import { test, expect, type Page } from './fixtures';
import { boardFile, boardFileCard, boardNote, checkpoint, planFile, step, whatsNew } from './planData';

/**
 * The Code window: one window over the whole workspace content (Board, Split and Terminal), opened by the Board's Code button,
 * by the uncommitted card in the commits row, by a path pressed in the terminal and by the old /changes address.
 * Everything is faked here, and every write is refused: nothing in this file may commit, push, revert or sync.
 */
const workspace = { id: 'demo', branchName: 'demo', name: 'Reports CSV export', description: 'Add CSV export', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
const other = { ...workspace, id: 'other', branchName: 'other', name: 'Other work', workspacePath: '/tmp/other' };
test.use({ workspacesData: [[workspace, other], { option: true }], sidebarDocked: false });

const FILES = [
  { file: 'src/server/handler.ts', type: 'modified', additions: 12, deletions: 3 },
  { file: 'src/server/routes.ts', type: 'modified', additions: 30, deletions: 8 },
  { file: 'README.md', type: 'added', additions: 5, deletions: 0 },
];
const LISTING = [{ repoName: 'api', repoPath: '/tmp/api', files: FILES }];
const ALL_FILES = [...FILES, { file: 'src/server/config.ts', type: 'clean', additions: 0, deletions: 0 }];
const ALL_LISTING = [{ repoName: 'api', repoPath: '/tmp/api', files: ALL_FILES }];

/** A 20-line file; the new version changes line 10 and adds a line after 12. */
const original = (name: string) => Array.from({ length: 20 }, (_, i) => `// ${name} line ${i + 1}`).join('\n') + '\n';
const modified = (name: string) => {
  const lines = original(name).trimEnd().split('\n');
  lines[9] = `// ${name} line 10 CHANGED ${'and this line is long enough to be cut off at the right edge without wrapping '.repeat(3)}`;
  lines.splice(12, 0, `// ${name} inserted`);
  return lines.join('\n') + '\n';
};
const patch = (name: string) => {
  const o = original(name).trimEnd().split('\n');
  const m = modified(name).trimEnd().split('\n');
  return [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, '@@ -8,7 +8,8 @@',
    ` ${o[7]}`, ` ${o[8]}`, `-${o[9]}`, `+${m[9]}`, ` ${o[10]}`, ` ${o[11]}`, `+${m[12]}`, ` ${o[12]}`, ` ${o[13]}`, ''].join('\n');
};

let writes: string[] = [];
let termTarget: 'claude' | 'shell' = 'claude';
let typed: string[] = [];
let noSession = false;
let terminalDocument = 'docs/guide.md';

test.beforeEach(async ({ page }) => {
  writes = []; typed = []; termTarget = 'claude'; noSession = false; terminalDocument = 'docs/guide.md';
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    if (noSession) return route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } });
    const terminal = { id: `term-${id}`, workspace: id, target: termTarget, label: termTarget, cwd: `/tmp/${id}`, state: 'running' };
    return route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: termTarget, name: termTarget, available: true, reason: null }] } });
  });
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
    json: planFile({ title: 'Reports CSV export', checkpoints: [checkpoint('Reports export to CSV', { steps: [step('Write the CSV writer', true), step('Background job queue')] })] }),
  }));
  await page.route('**/api/workspace/*/news', (route) => route.fulfill({
    json: whatsNew({ commits: [{ repo: 'api', more: 0, commits: [{ sha: 'abc1234def', subject: 'Add the writer', author: 'A', at: new Date(Date.now() - 3_600_000).toISOString() }, { sha: 'def5678abc', subject: 'Add the reader', author: 'A', at: new Date(Date.now() - 7_200_000).toISOString() }] }], empty: false }),
  }));
  await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [boardNote(1, { title: 'A note' })] }) }));
  await page.route('**/api/workspace/*/changes', (route) => route.fulfill({ json: { changes: LISTING } }));
  await page.route('**/api/workspace/*/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/*/changes?include=all', (route) => route.fulfill({ json: { changes: ALL_LISTING } }));
  await page.route('**/api/workspace/*/changes/diff?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('file')!;
    if (name === 'src/server/config.ts') {
      return route.fulfill({ json: { diff: '', fileContent: '// config file\nconst port = 3000;\n' } });
    }
    return route.fulfill({ json: { diff: patch(name), fileContent: modified(name), originalContent: original(name) } });
  });
  await page.route('**/api/workspace/*/repositories', (route) => route.fulfill({ json: { repositories: [{
    name: 'api', access: 'isolated', editable: true, path: '/tmp/api', sourcePath: '/tmp/api', branch: 'feat/x', expectedBranch: 'feat/x', onExpectedBranch: true, baseBranch: 'main',
    headSha: 'abc1234def', dirty: true, changedFiles: FILES.map((f) => ({ code: ' M', path: f.file })), ahead: 0, behind: 0, remoteUrl: null,
  }] } }));
  await page.route('**/api/workspace/*/progression', (route) => route.fulfill({ json: { ready: true, blockers: [], repos: [] } }));
  await page.route('**/api/workspace/*/lifecycle', (route) => route.fulfill({ json: { lifecycle: { steps: [] }, report: null } }));
  await page.route('**/api/workspace/*/finish/last', (route) => route.fulfill({ json: { lastFinish: null } }));
  // Nothing here may write. A test that fakes a write registers its own route, which is looked at first.
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    // The terminal's token, status and list are asked with POST and write nothing; the routes above fake every one of them
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
  await page.routeWebSocket('**/ws/terminal', (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type === 'input') typed.push(parsed.data);
      if (parsed.type !== 'attach') return;
      const terminal = { id: parsed.id, workspace: parsed.workspace, target: termTarget, label: termTarget, cwd: `/tmp/${parsed.workspace}`, state: 'running' };
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'output', data: `opened ${terminalDocument}\r\n` }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await page.route('**/api/workspace/*/files/reference?*', (route) => {
    const wanted = new URL(route.request().url()).searchParams.get('path');
    return wanted === 'src/server/routes.ts'
      ? route.fulfill({ json: { status: 'found', target: { origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' }, file: 'src/server/routes.ts', viewer: 'code' } } })
      : route.fulfill({ json: { status: 'found', target: { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: wanted, viewer: 'reader' } } });
  });
});
test.afterEach(() => { expect(writes, 'no test here may write').toEqual([]); });


async function clickDocument(page: Page, row = 0) {
  const pane = page.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  const cell = await pane.locator('.xterm-screen').evaluate((element, index) => {
    const bounds = element.getBoundingClientRect();
    const first = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
    return { x: bounds.x + 80, y: (first?.y ?? bounds.y) + (first?.height ?? 17) * (index + 0.5) };
  }, row);
  await pane.locator('.xterm-helper-textarea').focus();
  await page.mouse.move(cell.x + 200, cell.y + 40);
  await page.mouse.move(cell.x, cell.y);
  await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
  await page.mouse.click(cell.x, cell.y);
}

for (const mode of ['terminal', 'split'] as const) {
  test(`terminal document opens the Board reader in ${mode} and does not replay`, async ({ page }) => {
    await page.route('**/api/workspace/*/documents/preview?*', (route) => route.fulfill({ json: { name: 'docs/guide.md', kind: 'markdown', content: '# A hidden guide' } }));
    await page.goto(`/#/workspaces/demo/${mode === 'terminal' ? 'chat' : 'board'}`);
    if (mode === 'split') await page.getByTestId('view-mode-split').click();
    await clickDocument(page);
    const reader = page.locator('[data-board-reader]');
    await expect(reader).toContainText('A hidden guide');
    await expect(reader.getByRole('heading', { name: 'guide.md' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reader).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
    await clickDocument(page);
    await expect(reader).toContainText('A hidden guide');
    await page.keyboard.press('Escape');
    await page.goto('/#/workspaces/other/board');
    await page.goto('/#/workspaces/demo/board');
    await expect(reader).toHaveCount(0);
  });
}

test('a terminal document opens on an empty Board', async ({ page }) => {
  await page.route('**/api/workspace/*/plan', (route) => route.fulfill({ json: planFile() }));
  await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
  await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile() }));
  await page.route('**/api/workspace/*/documents/preview?*', (route) => route.fulfill({ json: { name: 'docs/guide.md', kind: 'markdown', content: '# A hidden guide' } }));
  await page.goto('/#/workspaces/demo/board');
  await expect(page.getByText('Nothing on the board yet.', { exact: false })).toBeVisible();
  await page.getByTestId('view-mode-split').click();
  await clickDocument(page);
  const reader = page.locator('[data-board-reader]');
  await expect(reader).toContainText('A hidden guide');
  await expect(reader.getByRole('heading', { name: 'guide.md' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
  await clickDocument(page);
  await expect(reader).toContainText('A hidden guide');
});


for (const fullScreen of [false, true]) {
  test(`an HTML reader keeps its iframe, typed values and ${fullScreen ? 'full screen' : 'docked view'} when the first plan arrives`, async ({ page }) => {
    terminalDocument = 'docs/form.html';
    let releasePlan!: () => void;
    const planReady = new Promise<void>((resolve) => { releasePlan = resolve; });
    await page.route('**/api/workspace/*/plan', async (route) => {
      await planReady;
      await route.fulfill({ json: planFile({ checkpoints: [checkpoint('First work', { steps: [step('First step')] })] }) });
    });
    await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile() }));
    await page.route('**/api/workspace/*/documents/preview?*', (route) => route.fulfill({ json: { name: terminalDocument, kind: 'html', content: '' } }));
    await page.route('**/api/workspace/*/documents/view-link', (route) => route.fulfill({ json: { token: 'form-token', url: '/view/form-token/docs/form.html', scope: '' } }));
    await page.route('**/view/form-token/docs/form.html?frame=1', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><label>Your notes <input name="notes"></label>',
    }));
    try {
      await page.goto('/#/workspaces/demo/board');
      await expect(page.getByText('Loading the board', { exact: true })).toBeVisible();
      await page.getByTestId('view-mode-split').click();
      await clickDocument(page);
      const reader = page.locator('[data-board-reader]');
      if (fullScreen) await reader.getByRole('button', { name: 'Full screen', exact: true }).click();
      const iframe = reader.locator('iframe');
      const notes = iframe.contentFrame().getByRole('textbox', { name: 'Your notes' });
      await notes.fill('Keep what I typed while the AI adds work');
      const originalIframe = await iframe.elementHandle();
      const originalReader = await reader.elementHandle();
      const planResponse = page.waitForResponse('**/api/workspace/demo/plan');
      releasePlan();
      await planResponse;
      // A canvas proves the response has reached the Board, rather than only the network.
      await expect(page.locator('#board-overview-flow')).toHaveCount(1);
      expect(await originalIframe!.evaluate((element) => element.isConnected), 'the original iframe stays mounted').toBe(true);
      expect(await originalReader!.evaluate((element) => element.isConnected), 'the original reader stays mounted').toBe(true);
      await expect(notes).toHaveValue('Keep what I typed while the AI adds work');
      await expect(reader.getByRole('button', { name: fullScreen ? 'Exit full screen' : 'Full screen', exact: true })).toHaveAttribute('aria-pressed', String(fullScreen));
    } finally {
      releasePlan();
    }
  });
}
for (const viewport of [{ width: 1280, height: 800 }, { width: 1100, height: 700 }]) test(`preserves HTML draft and iframe identity through full screen and back at ${viewport.width}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  terminalDocument = 'docs/form.html';
  await page.route('**/api/workspace/*/documents/preview?*', route => route.fulfill({ json: { name: 'docs/form.html', kind: 'html', content: '' } }));
  await page.route('**/api/workspace/*/documents/view-link', route => route.fulfill({ json: { token: 'draft-fullscreen', url: '/view/draft-fullscreen/docs/form.html', scope: 'docs' } }));
  await page.route('**/view/draft-fullscreen/docs/form.html?frame=1', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><label>Your notes <input name="notes"></label>' }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId('view-mode-split').click();
  await clickDocument(page);
  const frame = page.frameLocator('iframe[title="Preview of docs/form.html"]');
  const notes = frame.getByRole('textbox', { name: 'Your notes' });
  await notes.fill('keep draft across full screen');
  await notes.evaluate(el => { el.dataset.liveFrame = 'original'; });
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(notes).toHaveValue('keep draft across full screen');
  await expect(notes).toHaveAttribute('data-live-frame', 'original');
  const fullscreen = page.locator('[data-board-reader-fullscreen]');

  await expect(fullscreen).toHaveCSS('width', `${viewport.width}px`);
  await expect(fullscreen).toHaveCSS('height', `${viewport.height}px`);
  const layering = await fullscreen.evaluate((panel) => {
    const ancestors = [];
    for (let element = panel.parentElement; element; element = element.parentElement) {
      const css = getComputedStyle(element);
      ancestors.push({ tag: element.tagName, class: element.className, animation: css.animationName, fill: css.animationFillMode, opacity: css.opacity, isolation: css.isolation, z: css.zIndex, transform: css.transform });
    }
    const points = [[8, innerHeight / 2], [innerWidth - 8, innerHeight / 2]];
    return { ancestors, paint: points.map(([x, y]) => panel.contains(document.elementFromPoint(x, y))) };
  });
  await test.info().attach('fullscreen-layering', { body: JSON.stringify(layering, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: test.info().outputPath('fullscreen-paint.png') });
  expect(layering.paint, 'fullscreen paints above the navigation rail and Split chat').toEqual([true, true]);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(fullscreen).toBeVisible();
  // Another feature can request Code while the reader is fullscreen; the real window owns paint and Escape.
  await page.getByTestId('board-code-button').evaluate((button: HTMLElement) => button.click());
  const code = page.getByRole('region', { name: 'Code window', exact: true });
  await expect(code).toBeVisible();
  await expect.poll(() => code.evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    return panel.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  await code.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(code).toBeHidden();
  await expect(fullscreen).toBeVisible();
  await expect.poll(() => fullscreen.evaluate((panel) =>
    [8, innerWidth - 8].every((x) => panel.contains(document.elementFromPoint(x, innerHeight / 2))),
  )).toBe(true);
  await expect(notes).toHaveValue('keep draft across full screen');
  await expect(notes).toHaveAttribute('data-live-frame', 'original');
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await expect(notes).toHaveValue('keep draft across full screen');
  await expect(notes).toHaveAttribute('data-live-frame', 'original');
  // Docking is offered only with enough space for both canvas and reader.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('view-mode-board').click();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show beside the board', exact: true }).click();
  await expect(notes).toHaveValue('keep draft across full screen');
  const reader = page.getByRole('region', { name: 'Reader', exact: true });
  expect((await reader.boundingBox())!.width).toBeLessThan(viewport.width);
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await nav.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.locator('iframe[title="Preview of docs/form.html"]')).toBeHidden();
  await page.keyboard.press('[');
  await page.keyboard.press(']');
  await page.keyboard.press('Escape');
  await nav.getByRole('link', { name: 'Board', exact: true }).click();
  await expect(notes).toHaveValue('keep draft across full screen');
  await expect(notes).toHaveAttribute('data-live-frame', 'original');
});

test('a mixed terminal reference offers workspace and repository identities and opens the chosen reader', async ({ page }) => {
  await page.route('**/api/workspace/*/files/reference?*', route => route.fulfill({ json: { status: 'ambiguous', truncated: true, candidates: [
    { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: 'docs/guide.md', viewer: 'reader' },
    { origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' }, file: 'docs/guide.md', viewer: 'reader' },
  ] } }));
  let previewUrl = '';
  await page.route('**/api/workspace/*/documents/preview?*', route => { previewUrl = route.request().url(); return route.fulfill({ json: { name: 'docs/guide.md', kind: 'markdown', content: '# Repository guide' } }); });
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId('view-mode-split').click();
  await clickDocument(page);
  const notice = page.getByTestId('code-reference-notice');
  await expect(notice).toContainText('2 or more');
  await expect(notice.getByRole('button', { name: 'Workspace/docs/guide.md' })).toBeVisible();
  await notice.getByRole('button', { name: 'api/docs/guide.md' }).click();
  await expect(page.locator('[data-board-reader]')).toContainText('Repository guide');
  expect(new URL(previewUrl).searchParams.get('repo')).toBe('api');
});

test('a workspace document line from terminal opens workspace Code and repeated clicks remain requests', async ({ page }) => {
  terminalDocument = 'docs/guide.md:3';
  await page.route('**/api/workspace/*/files/reference?*', route => route.fulfill({ json: { status: 'found', target: { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: 'docs/guide.md', viewer: 'reader' } } }));
  await page.route('**/api/workspace/*/files/read?*', route => route.fulfill({ json: { content: 'one\ntwo\nthree\nfour\n' } }));
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId('view-mode-split').click();
  await clickDocument(page);
  const view = page.getByTestId('workspace-code-view');
  await expect(view).toContainText('Workspace · demo · Read only');
  await expect(view).toContainText('three');
  await page.getByRole('region', { name: 'Code window' }).getByRole('button', { name: 'Close', exact: true }).click();
  await clickDocument(page);
  await expect(view).toContainText('three');
});

test('closing a locating window cancels its late terminal reference', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/workspace/*/files/reference?*', async route => { await pending; await route.fulfill({ json: { status: 'found', target: { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: 'docs/guide.md', viewer: 'reader' } } }); });
  try {
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await clickDocument(page);
    await expect(page.getByTestId('code-reference-notice')).toContainText('Looking for');
    await page.getByRole('region', { name: 'Code window' }).getByRole('button', { name: 'Close', exact: true }).click();
    const response = page.waitForResponse('**/files/reference?*');
    release();
    await response;
    await expect(page.locator('[data-board-reader]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Code window' })).toBeHidden();
  } finally { release(); }
});

test('manual Code selection wins over a deferred terminal reference', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/workspace/*/files/reference?*', async route => { await pending; await route.fulfill({ json: { status: 'found', target: { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: 'docs/guide.md', viewer: 'reader' } } }); });
  try {
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await clickDocument(page);
    await expect(page.getByTestId('code-reference-notice')).toContainText('Looking for');
    const win = page.getByRole('region', { name: 'Code window' });
    await win.getByRole('treeitem', { name: /handler\.ts/ }).click();
    await expect(win.locator('p[title]').first()).toHaveText('src/server/handler.ts');
    const response = page.waitForResponse('**/files/reference?*');
    release();
    await response;
    await expect(win.locator('p[title]').first()).toHaveText('src/server/handler.ts');
    await expect(page.locator('[data-board-reader]')).toHaveCount(0);
  } finally { release(); }
});

test('switching workspace cancels a deferred terminal reference', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/workspace/*/files/reference?*', async route => { await pending; await route.fulfill({ json: { status: 'found', target: { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: 'docs/guide.md', viewer: 'reader' } } }); });
  try {
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await clickDocument(page);
    await expect(page.getByTestId('code-reference-notice')).toContainText('Looking for');
    await page.goto('/#/workspaces/other/board');
    const response = page.waitForResponse('**/files/reference?*');
    release();
    await response;
    await page.goto('/#/workspaces/demo/board');
    await expect(page.locator('[data-board-reader]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Code window' })).toBeHidden();
  } finally { release(); }
});

test('correction workspace far line is visible in Monaco after terminal click', async ({page}) => {
  terminalDocument='src/local.ts:140';
  await page.route('**/api/workspace/*/files/reference?*', route => route.fulfill({json:{status:'found',target:{origin:{kind:'workspace',workspacePath:'/tmp/demo'},file:'src/local.ts',viewer:'code'}}}));
  await page.route('**/api/workspace/*/files/read?*', route => route.fulfill({json:{content:Array.from({length:200},(_,i)=>`// workspace number ${i+1}`).join('\n')}}));
  await page.goto('/#/workspaces/demo/board'); await page.getByTestId('view-mode-split').click(); await clickDocument(page);
  const view=page.getByTestId('workspace-code-view');
  await expect.poll(async()=> (await view.locator('.view-line').allTextContents()).join('\n').replace(/\u00a0/g,' ')).toContain('// workspace number 140');
  console.log('WORKSPACE-LINE-PROOF', JSON.stringify(await view.locator('.view-line').allTextContents()));
});

for (const compact of [false, true]) {
test(`correction typed Finish draft wins over deferred terminal file reference${compact ? ' compact toolbar' : ''}`, async ({page}) => {
  let release!:()=>void; const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/workspace/*/files/reference?*',async route=>{await pending;await route.fulfill({json:{status:'found',target:{origin:{kind:'repository',repoName:'api',repoPath:'/tmp/api'},file:'src/server/routes.ts',viewer:'code'}}});});
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/#/workspaces/demo/board'); await page.getByTestId('view-mode-split').click(); await clickDocument(page);
    const win=page.getByRole('region',{name:'Code window'}); await expect(page.getByTestId('code-reference-notice')).toContainText('Looking for');
    if (compact) {
      await page.setViewportSize({ width: 600, height: 900 });
      await expect(win.getByRole('button', { name: 'Finish…', exact: true })).toHaveCount(0);
      await win.getByRole('button', { name: 'More code actions' }).click();
      await page.getByRole('menuitem', { name: 'Finish…' }).click();
    } else await win.getByRole('button', { name: 'Finish…', exact: true }).click();
    await win.getByLabel('Commit message for remaining changes').fill('keep my finish message');
    const response=page.waitForResponse('**/files/reference?*'); release(); await response;
    await expect(win.getByLabel('Commit message for remaining changes')).toHaveValue('keep my finish message');
    await expect(win.getByRole('heading', { name: 'Finish work' })).toBeVisible();
  } finally {release();}
});

}

test('correction leaving a docked second workspace cancels its deferred reader navigation',async ({page})=>{
  let release!:()=>void; const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/workspace/*/files/reference?*',async route=>{await pending;await route.fulfill({json:{status:'found',target:{origin:{kind:'workspace',workspacePath:'/tmp/other'},file:'docs/guide.md',viewer:'reader'}}});});
  await page.route('**/api/workspace/*/documents/preview?*',route=>route.fulfill({json:{name:'docs/guide.md',kind:'markdown',content:'# Other guide'}}));
  await page.setViewportSize({width:1600,height:900});
  await page.addInitScript(()=>{
    if(window!==window.top)return;
    localStorage.setItem('contextspace_chat_layout_v1',JSON.stringify({hidden:false,percent:50}));
    localStorage.setItem('contextspace_floating_chat_state_v1',JSON.stringify({openTabs:['demo','other'],activeTab:'demo',splitTab:'other',splitRatio:50,modes:{demo:'cli',other:'cli'},harnesses:{},terminalLaunches:{},drafts:{}}));
  });
  try {
    await page.goto('/#/workspaces/demo/chat');
    const panes=page.getByTestId('terminal-pane');await expect(panes).toHaveCount(2,{timeout:20000});
    const pane=panes.nth(1);await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
    const cellOf=()=>pane.locator('.xterm-screen').evaluate(element=>{const bounds=element.getBoundingClientRect();const first=element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();return{x:bounds.x+80,y:(first?.y??bounds.y)+(first?.height??17)*0.5};});
    let cell=await cellOf();
    await expect(async()=>{cell=await cellOf();await page.mouse.move(cell.x-3,cell.y);await page.mouse.move(cell.x,cell.y);await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1,{timeout:1500});}).toPass({timeout:20000});
    await page.mouse.click(cell.x,cell.y);
    await expect(page.getByTestId('code-reference-notice')).toContainText('Looking for');
    expect(new URL(page.url()).hash).toBe('#/workspaces/other/board');
    await page.goto('/#/workspaces/demo/board');
    const response=page.waitForResponse('**/files/reference?*');release();await response;
    await expect(page.locator('[data-board-reader]')).toHaveCount(0);
    expect(new URL(page.url()).hash,'A newer workspace selection must win').toBe('#/workspaces/demo/board');
  }finally{release();}
});

for (const origin of ['repository', 'workspace'] as const) {
  for (const line of [undefined, 35]) {
    test(`correction ${origin} Markdown code link retains origin${line ? ' and line' : ''}`, async ({ page }) => {
      const references: { path: string | null; cwd: string | null }[] = [];
      const root = origin === 'repository' ? '/tmp/api' : '/tmp/demo';
      await page.route('**/api/workspace/*/files/reference?*', (route) => {
        const query = new URL(route.request().url()).searchParams;
        const file = query.get('path')!;
        references.push({ path: file, cwd: query.get('cwd') });
        return route.fulfill({ json: { status: 'found', target: {
          origin: origin === 'repository' ? { kind: 'repository', repoName: 'api', repoPath: root } : { kind: 'workspace', workspacePath: root },
          file, viewer: file.endsWith('.md') ? 'reader' : 'code',
        } } });
      });
      await page.route('**/api/workspace/*/documents/preview?*', (route) => {
        const name = new URL(route.request().url()).searchParams.get('name');
        return name === 'docs/guide.md'
          ? route.fulfill({ json: { name, kind: 'markdown', content: `# Guide\n[Open code](../src/shared.ts${line ? '#L35' : ''})` } })
          : route.fulfill({ status: 400, json: { error: ".ts files can't be opened here. Open it from the workspace folder instead." } });
      });
      const content = Array.from({ length: 200 }, (_, i) => `// shared number ${i + 1}`).join('\n');
      await page.route('**/api/workspace/*/files/read?*', (route) => route.fulfill({ json: { content } }));
      await page.route('**/api/workspace/*/changes/diff?*', (route) => route.fulfill({ json: { diff: '', fileContent: content } }));
      await page.goto('/#/workspaces/demo/board');
      await page.getByTestId('view-mode-split').click();
      await clickDocument(page);
      await expect(page.locator('[data-board-reader]').getByRole('link', { name: 'Open code' })).toBeVisible();
    await page.locator('[data-board-reader]').getByRole('link', { name: 'Open code' }).click();
      const win = page.getByRole('region', { name: 'Code window' });
      await expect(win).toBeVisible();
      await expect.poll(() => references).toEqual([{ path: 'docs/guide.md', cwd: null }, { path: 'src/shared.ts', cwd: root }]);
      const view = origin === 'workspace' ? page.getByTestId('workspace-code-view') : win;
      await expect.poll(async () => (await view.locator('.view-line').allTextContents()).join('\n').replace(/\u00a0/g, ' ')).toContain(`// shared number ${line ?? 1}`);
      await win.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.locator('[data-board-reader]')).toContainText('Guide');
      await expect(page.locator('[data-board-reader]').getByRole('link', { name: 'Open code' })).toBeFocused();
    });
  }
}

for (const delivery of ['pending', 'queued-repository', 'queued-workspace'] as const) {
  test(`correction newer Commit form supersedes ${delivery} reference results`, async ({ page }) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/workspace/*/files/reference?*', async (route) => {
      await pending;
      await route.fulfill({ json: { status: 'found', target: { origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' }, file: 'src/server/routes.ts', viewer: 'code' } } });
    });
    try {
      await page.goto('/#/workspaces/demo/board');
      await page.getByTestId('view-mode-split').click();
      await clickDocument(page);
      const win = page.getByRole('region', { name: 'Code window' });
      await expect(page.getByTestId('code-reference-notice')).toContainText('Looking for');
      if (delivery !== 'pending') {
        // A capture listener queues the result immediately before React handles the newer form click.
        // This covers deliveries that passed the async guard but have not reached their consumer effect yet.
        await page.evaluate(async (workspaceOrigin) => {
          // @ts-expect-error Vite serves the source module in this mounted test.
          const { codeRequests, codeWindowRequests } = await import('/src/features/workspace-shell/openRequests.ts');
          const previous = codeWindowRequests.get('demo')!.request;
          document.querySelector('[aria-label="Review & commit"]')!.addEventListener('click', () => {
            if (workspaceOrigin) codeWindowRequests.open('demo', { ...previous, workspaceFile: { workspaceId: 'demo', file: 'src/server/routes.ts' } });
            else codeRequests.open('demo', { kind: 'file', repoName: 'api', repoPath: '/tmp/api', file: 'src/server/routes.ts', intent: previous.intent });
          }, { capture: true, once: true });
        }, delivery === 'queued-workspace');
      }
      await win.getByRole('button', { name: 'Review & commit', exact: true }).click();
      await expect(win.getByLabel('Commit message', { exact: true })).toBeVisible();
      await win.getByLabel('Commit message', { exact: true }).fill('keep my commit message');
      const response = page.waitForResponse('**/files/reference?*');
      release();
      await response;
      await expect(win.getByLabel('Commit message', { exact: true })).toHaveValue('keep my commit message');
    } finally { release(); }
  });
}

for (const reference of ['/source/api/src/shared.ts#L35', '~/api/src/shared.ts:35']) {
  test(`correction scoped Markdown resolves ${reference.startsWith('~') ? 'home' : 'source alias'} paths`, async ({ page }) => {
    const requests: { path: string | null; cwd: string | null }[] = [];
    await page.route('**/api/workspace/*/files/reference?*', (route) => {
      const query = new URL(route.request().url()).searchParams;
      const path = query.get('path');
      requests.push({ path, cwd: query.get('cwd') });
      return route.fulfill({ json: { status: 'found', target: { origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' }, file: path === 'docs/guide.md' ? path : 'src/shared.ts', viewer: path === 'docs/guide.md' ? 'reader' : 'code' } } });
    });
    await page.route('**/api/workspace/*/documents/preview?*', (route) => route.fulfill({ json: { name: 'docs/guide.md', kind: 'markdown', content: `# Guide\n[Open code](${reference})` } }));
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await clickDocument(page);
    await expect(page.locator('[data-board-reader]').getByRole('link', { name: 'Open code' })).toBeVisible();
    await page.locator('[data-board-reader]').getByRole('link', { name: 'Open code' }).click();
    await expect(page.getByRole('region', { name: 'Code window' })).toBeVisible();
    expect(requests.at(-1)).toEqual({ path: reference.startsWith('~') ? '~/api/src/shared.ts' : '/source/api/src/shared.ts', cwd: '/tmp/api' });
  });
}

for (const origin of ['repository', 'workspace'] as const) {
  test(`correction ${origin} document links keep scoped trail and Back`, async ({ page }) => {
    const root = origin === 'repository' ? '/tmp/api' : '/tmp/demo';
    const previews: string[] = [];
    await page.route('**/api/workspace/*/files/reference?*', (route) => route.fulfill({ json: { status: 'found', target: {
      origin: origin === 'repository' ? { kind: 'repository', repoName: 'api', repoPath: root } : { kind: 'workspace', workspacePath: root },
      file: new URL(route.request().url()).searchParams.get('path'), viewer: 'reader',
    } } }));
    await page.route('**/api/workspace/*/documents/preview?*', (route) => {
      const query = new URL(route.request().url()).searchParams;
      previews.push(`${query.get('repo') ?? 'workspace'}/${query.get('name')}`);
      const name = query.get('name');
      return route.fulfill({ json: { name, kind: 'markdown', content: name === 'docs/guide.md' ? '# Guide\n[Notes](./notes.md)\n[Web](https://example.com/guide#L35)\n[Heading](#guide)' : '# Notes' } });
    });
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await clickDocument(page);
    const reader = page.locator('[data-board-reader]');
    await expect(reader.getByRole('link', { name: 'Web', exact: false })).toHaveAttribute('href', 'https://example.com/guide#L35');
    await reader.getByRole('link', { name: 'Heading' }).click();
    await expect(reader.getByRole('heading', { name: 'Guide', exact: true })).toBeVisible();
    await reader.getByRole('link', { name: 'Notes', exact: true }).click();
    await expect(reader.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
    expect([...new Set(previews)]).toEqual([`${origin === 'repository' ? 'api' : 'workspace'}/docs/guide.md`, `${origin === 'repository' ? 'api' : 'workspace'}/docs/notes.md`]);
    await reader.getByRole('button', { name: 'Back to guide.md', exact: true }).click();
    await expect(reader.getByRole('heading', { name: 'Guide', exact: true })).toBeVisible();
  });
}

for (const [label, file] of [['the Terraform entry', 'main.tf'], ['the notes', 'notes.org']] as const) {
  test(`fix2 ${file} link in a root document stays a local file and never opens a web site`, async ({ page }) => {
    terminalDocument = 'README.md';
    const references: { path: string | null; cwd: string | null }[] = [];
    await page.addInitScript(() => {
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((url?: string | URL) => { (window as unknown as { __opened: string[] }).__opened.push(String(url)); return null; }) as typeof window.open;
    });
    await page.route('**/api/workspace/*/files/reference?*', (route) => {
      const query = new URL(route.request().url()).searchParams;
      const path = query.get('path')!;
      references.push({ path, cwd: query.get('cwd') });
      return route.fulfill({ json: { status: 'found', target: { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: path, viewer: path.endsWith('.md') ? 'reader' : 'code' } } });
    });
    await page.route('**/api/workspace/*/documents/preview?*', (route) => route.fulfill({ json: { name: 'README.md', kind: 'markdown', content: '# Readme\n\nSee [the Terraform entry](main.tf) and [the notes](notes.org).' } }));
    await page.route('**/api/workspace/*/files/read?*', (route) => route.fulfill({ json: { content: 'resource "x" "y" {}\n' } }));
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await clickDocument(page);
    await expect(page.locator('[data-board-reader]')).toContainText('Readme');
    const before = references.length;
    await page.locator('[data-board-reader]').getByRole('link', { name: label }).click();
    await expect.poll(() => references.slice(before)).toEqual([{ path: file, cwd: '/tmp/demo' }]);
    expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened), 'a local file link must not open a web site').toEqual([]);
  });
}

test('fix2 keyboard Tab from the Code toolbar reaches the mixed choices', async ({ page }) => {
  await page.route('**/api/workspace/*/files/reference?*', (route) => route.fulfill({ json: { status: 'ambiguous', truncated: false, candidates: [
    { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file: 'README.md', viewer: 'reader' },
    { origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' }, file: 'README.md', viewer: 'reader' },
  ] } }));
  terminalDocument = 'README.md';
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId('view-mode-split').click();
  await clickDocument(page);
  const notice = page.getByTestId('code-reference-notice');
  await expect(notice.getByRole('button', { name: 'Workspace/README.md' })).toBeVisible();
  const win = page.getByRole('region', { name: 'Code window' });
  await win.getByRole('button', { name: 'Finish…', exact: true }).focus();
  let reached = false;
  for (let i = 0; i < 25 && !reached; i++) {
    await page.keyboard.press('Tab');
    await expect(notice, 'Tab must not dismiss the choices').toBeVisible();
    reached = await page.evaluate(() => Boolean(document.querySelector('[data-testid="code-reference-notice"]')?.contains(document.activeElement)));
  }
  expect(reached, 'Tab reaches a choice inside the notice').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-board-reader]')).toBeVisible();
});

test('fix2 a late document-link lookup does not replace the item chosen with ]', async ({ page }) => {
  // The trail starts from a page of the Board (commits open in the Code window now, not in the reader)
  const DOCS: Record<string, string> = { 'start-here.md': '# Write the CSV writer\n\nSee [Reports export to CSV](PLAN.md).', 'second-note.md': '# Second note', 'PLAN.md': '# The plan\n\nSee [the notes](docs/notes.md).', 'docs/notes.md': '# The notes' };
  let release: () => void = () => undefined;
  let hold = false;
  try {
    await page.route('**/api/workspace/demo/files/reference?*', async (route) => {
      const file = new URL(route.request().url()).searchParams.get('path') ?? '';
      if (hold && file === 'docs/notes.md') await new Promise<void>((resolve) => { release = resolve; });
      return route.fulfill({ json: DOCS[file] ? { status: 'found', target: { origin: { kind: 'workspace', workspacePath: '/tmp/demo' }, file, viewer: 'reader' } } : { status: 'not-found', reason: 'missing' } });
    });
    await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({ title: 'Reports CSV export', checkpoints: [checkpoint('Reports export to CSV', { steps: [
      step('Write the CSV writer', true), step('Background job queue for large exports'),
    ] })] }) }));
    await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [] }) }));
    await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile({ cards: [
      boardFileCard(2, 'board-pictures/other.png', { title: 'Other picture', at: new Date(Date.now() - 30 * 60_000).toISOString() }),
      boardFileCard(1, 'start-here.md', { title: 'Write the CSV writer', at: new Date(Date.now() - 20 * 60_000).toISOString() }),
      boardFileCard(3, 'second-note.md', { title: 'Second note', at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    ] }) }));
    await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
      const name = new URL(route.request().url()).searchParams.get('name') ?? '';
      const content = DOCS[name];
      return content ? route.fulfill({ json: { name, kind: 'markdown', content, size: content.length, modifiedAt: new Date().toISOString() } }) : route.fulfill({ status: 404, json: { error: 'Not found' } });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
      localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
      localStorage.setItem('contextspace_board_reader_layout_v1', 'large');
    });
    const board = page.getByRole('region', { name: 'Board', exact: true });
    const reader = board.getByRole('region', { name: 'Reader', exact: true });
    const title = (name: string) => reader.getByRole('heading', { name, level: 2, exact: true });
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await page.locator('.board-overview-plane button.board-area').first().click();
    const originButton = board.locator('#board-area').getByRole('button', { name: 'Open Write the CSV writer', exact: true });
    await expect(originButton).toBeVisible();
    await originButton.click();
    await expect(title('Write the CSV writer')).toBeVisible();
    await reader.getByRole('link', { name: /Reports export to CSV/ }).click();
    await expect(title('PLAN.md')).toBeVisible();
    hold = true;
    const asked = page.waitForRequest((r) => r.url().includes('/files/reference?') && r.url().includes('notes.md'));
    await reader.getByRole('link', { name: 'the notes', exact: true }).click();
    await asked;
    await page.keyboard.press(']');
    await expect(title('Second note')).toBeVisible();
    const answered = page.waitForResponse((r) => r.url().includes('/files/reference?') && r.url().includes('notes.md'));
    release();
    await answered;
    await page.waitForTimeout(500);
    await expect(title('Second note'), 'the newer ] choice must stay').toBeVisible();
  } finally { release(); }
});

test('correction Markdown code link keeps focus across background updates while opening and closing Code', async ({ page }) => {
  let filesVersion = 1;
  let changesVersion = 1;
  let releaseRef!: () => void;
  const pendingRef = new Promise<void>((resolve) => { releaseRef = resolve; });
  try {
    await page.route('**/api/workspace/*/files', (route) => route.fulfill({
      json: {
        files: filesVersion === 1
          ? [{ path: 'docs/guide.md' }]
          : [{ path: 'docs/guide.md' }, { path: 'docs/extra.md' }],
        truncated: false,
        errors: [],
      },
    }));
    await page.route('**/api/workspace/*/changes', (route) => route.fulfill({
      json: {
        changes: changesVersion === 1
          ? LISTING
          : [{ repoName: 'api', repoPath: '/tmp/api', files: [...FILES, { file: 'src/server/extra.ts', type: 'modified', additions: 1, deletions: 0 }] }],
      },
    }));
    await page.route('**/api/workspace/*/files/reference?*', async (route) => {
      const file = new URL(route.request().url()).searchParams.get('path')!;
      if (file === 'src/shared.ts') await pendingRef;
      return route.fulfill({
        json: {
          status: 'found',
          target: {
            origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' },
            file,
            viewer: file.endsWith('.md') ? 'reader' : 'code',
          },
        },
      });
    });
    await page.route('**/api/workspace/*/documents/preview?*', (route) => {
      const name = new URL(route.request().url()).searchParams.get('name');
      return route.fulfill({ json: { name, kind: 'markdown', content: '# Guide\n[Open code](../src/shared.ts#L35)' } });
    });
    const content = Array.from({ length: 200 }, (_, i) => `// shared number ${i + 1}`).join('\n');
    await page.route('**/api/workspace/*/files/read?*', (route) => route.fulfill({ json: { content } }));
    await page.route('**/api/workspace/*/changes/diff?*', (route) => route.fulfill({ json: { diff: '', fileContent: content } }));

    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click();
    await clickDocument(page);
    const readerLink = page.locator('[data-board-reader]').getByRole('link', { name: 'Open code' });
    await expect(readerLink).toBeVisible();

    const refAsked = page.waitForRequest((r) => r.url().includes('/files/reference?') && r.url().includes('shared.ts'));
    await readerLink.click();
    await refAsked;

    filesVersion = 2;
    const filesRefetched = page.waitForResponse((r) => r.url().endsWith('/api/workspace/demo/files') && r.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await filesRefetched;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    releaseRef();
    const win = page.getByRole('region', { name: 'Code window' });
    await expect(win).toBeVisible();
    await expect.poll(async () => (await win.locator('.view-line').allTextContents()).join('\n').replace(/\u00a0/g, ' ')).toContain('// shared number 35');

    changesVersion = 2;
    const changesRefetched = page.waitForResponse((r) => r.url().endsWith('/api/workspace/demo/changes') && r.request().method() === 'GET');
    await win.getByRole('button', { name: 'Close', exact: true }).click();
    await changesRefetched;

    await expect(page.locator('[data-board-reader]')).toContainText('Guide');
    await expect(readerLink).toBeFocused();
  } finally {
    releaseRef?.();
  }
});

test('correction Markdown code link returns focus to equivalent link after reader content re-renders', async ({ page }) => {
  let previewVersion = 1;
  await page.route('**/api/workspace/*/files/reference?*', (route) => {
    const file = new URL(route.request().url()).searchParams.get('path')!;
    return route.fulfill({
      json: {
        status: 'found',
        target: {
          origin: { kind: 'repository', repoName: 'api', repoPath: '/tmp/api' },
          file,
          viewer: file.endsWith('.md') ? 'reader' : 'code',
        },
      },
    });
  });
  await page.route('**/api/workspace/*/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name');
    const content = previewVersion === 1
      ? '# Guide\n\n[Keep](../other.md)\n\n[Open code](../src/shared.ts#L35)'
      : '# Guide\n\nUpdated section inserted above the link.\n\n[Keep](../other.md)\n\n[Open code](../src/shared.ts#L35)';
    return route.fulfill({ json: { name, kind: 'markdown', content } });
  });
  const content = Array.from({ length: 200 }, (_, i) => `// shared number ${i + 1}`).join('\n');
  await page.route('**/api/workspace/*/files/read?*', (route) => route.fulfill({ json: { content } }));
  await page.route('**/api/workspace/*/changes/diff?*', (route) => route.fulfill({ json: { diff: '', fileContent: content } }));

  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId('view-mode-split').click();
  await clickDocument(page);
  const reader = page.locator('[data-board-reader]');
  await expect(reader.getByRole('link', { name: 'Open code' })).toBeVisible();
  await reader.getByRole('link', { name: 'Open code' }).click();

  const win = page.getByRole('region', { name: 'Code window' });
  await expect(win).toBeVisible();
  await expect.poll(async () => (await win.locator('.view-line').allTextContents()).join('\n').replace(/\u00a0/g, ' ')).toContain('// shared number 35');

  previewVersion = 2;
  const previewRefetched = page.waitForResponse((r) => r.url().includes('/documents/preview?') && r.url().includes('guide.md'));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await previewRefetched;
  await expect(reader).toContainText('Updated section inserted above the link.');

  await win.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(reader.getByRole('link', { name: 'Open code' })).toBeFocused();
});
