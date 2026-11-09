import { test, expect, type Page } from './fixtures';
import { boardFile, boardNote, checkpoint, planFile, step, whatsNew } from './planData';

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
  await page.route('**/api/workspace/*/files/resolve?*', (route) => {
    const wanted = new URL(route.request().url()).searchParams.get('path');
    return wanted === 'src/server/routes.ts'
      ? route.fulfill({ json: { status: 'found', repoName: 'api', repoPath: '/tmp/api', file: 'src/server/routes.ts' } })
      : route.fulfill({ json: { status: 'not-found', reason: 'missing' } });
  });
});
test.afterEach(() => { expect(writes, 'no test here may write').toEqual([]); });


async function clickDocument(page: Page) {
  const pane = page.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  const cell = await pane.locator('.xterm-screen').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const first = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
    return { x: bounds.x + 80, y: (first?.y ?? bounds.y) + (first?.height ?? 17) * 0.5 };
  });
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
