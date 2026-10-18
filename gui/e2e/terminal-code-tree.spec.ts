import { test, expect } from './fixtures';

const workspace = { id: 'feature-x', branchName: 'feature-x', description: 'Inspect work', repos: ['C:/repo'], assistants: ['codex'], workspacePath: 'C:/ws/feature-x', createdAt: '2026-09-20T00:00:00Z' };
const terminal = { id: '0199a213-81c0-7800-8aa1-bbab2a035a50', workspace: 'feature-x', target: 'shell', label: 'bash', cwd: workspace.workspacePath, state: 'running' };

test.use({ workspacesData: [workspace], viewport: { width: 1450, height: 950 } });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/terminals/bootstrap', route => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
});

type Page = import('@playwright/test').Page;
type Listing = { repoName: string; repoPath: string; files: { file: string; type: string; additions?: number; deletions?: number }[] }[];

/** Code and the chat side by side, the way a user with a wide window works. The fixtures start with the chat hidden beside panels. */
const chatBesidePanels = (page: Page, percent = 50) =>
  page.addInitScript((share) => localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: share })), percent);

/** The server's reference resolver, answered from a listing: exact, then repository-qualified, then a unique suffix. */
const resolveFrom = (page: Page, listing: Listing) => page.route('**/api/workspace/feature-x/files/resolve?*', (route) => {
  const wanted = (new URL(route.request().url()).searchParams.get('path') ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const all = listing.flatMap((repo) => repo.files.map((file) => ({ repoName: repo.repoName, repoPath: repo.repoPath, file: file.file })));
  const exact = all.filter((entry) => entry.file === wanted || `${entry.repoName}/${entry.file}` === wanted);
  const found = exact.length ? exact : all.filter((entry) => entry.file.endsWith(`/${wanted}`));
  if (found.length === 1) return route.fulfill({ json: { status: 'found', ...found[0] } });
  if (found.length > 1) return route.fulfill({ json: { status: 'ambiguous', candidates: found } });
  return route.fulfill({ json: { status: 'not-found', reason: 'missing' } });
});

const codeSection = (page: Page) => page.getByRole('region', { name: 'Workspace code' });
const openFileName = (page: Page) => codeSection(page).locator('p[title]').first();

test('shows the changed and the repository files in Code on the rail, beside the CLI', async ({ page }) => {
  const changed = { repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/nested/changed.ts', type: 'modified', additions: 1, deletions: 0 }] };
  await page.route('**/api/workspace/feature-x/changes?include=all', route => route.fulfill({ json: { changes: [{ ...changed, files: [...changed.files, { file: 'src/nested/clean.ts', type: 'unchanged' }] }] } }));
  await page.route('**/api/workspace/feature-x/changes', route => route.fulfill({ json: { changes: [changed] } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'export const changed = 1;\n', originalContent: 'export const changed = 0;\n' } }));
  await chatBesidePanels(page, 40);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  await chat.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/feature-x\/changes$/);
  const code = codeSection(page);
  // One panel beside the chat, not a second panel inside it.
  await expect(chat.getByRole('region', { name: 'Workspace code' })).toHaveCount(0);
  await expect(chat.getByTestId('terminal-pane')).toBeVisible();
  await expect(code.getByRole('tree', { name: 'repo changed files' })).toBeVisible();
  await expect(code.getByRole('treeitem', { name: 'src/nested' })).toHaveAttribute('aria-expanded', 'true');
  await code.getByRole('treeitem', { name: /changed\.ts/ }).click();
  await expect(openFileName(page)).toHaveText('src/nested/changed.ts');
  await code.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(code.getByRole('tree', { name: 'repo files' }).getByRole('treeitem', { name: /clean\.ts/ })).toBeVisible();
  await code.getByRole('treeitem', { name: /clean\.ts/ }).click();
  await expect(openFileName(page)).toHaveText('src/nested/clean.ts');
  // The chat's Code button closes it again.
  await chat.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/feature-x\/chat$/);
  await expect(code).toBeHidden();
});

test('filters the files in Code and clears the filter', async ({ page }) => {
  const repo = {
    repoName: 'repo',
    repoPath: 'C:/repo',
    files: [
      { file: 'src/components/Button.tsx', type: 'modified', additions: 1, deletions: 0 },
      { file: 'src/utils/format.ts', type: 'modified', additions: 1, deletions: 0 },
    ],
  };
  await page.route('**/api/workspace/feature-x/changes', route => route.fulfill({ json: { changes: [repo] } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'export const x = 1;\n', originalContent: '' } }));
  await page.goto('/#/workspaces/feature-x/changes');
  const code = codeSection(page);

  const searchInput = code.getByRole('searchbox', { name: 'Filter files' });
  await expect(searchInput).toBeVisible();
  await expect(code.getByTestId('search-match-count')).toHaveText('2 changed files');

  await searchInput.fill('Button');
  await expect(code.getByTestId('search-match-count')).toHaveText('1 of 2 files match');
  await expect(code.getByRole('treeitem', { name: /Button\.tsx/ })).toBeVisible();
  await expect(code.getByRole('treeitem', { name: /format\.ts/ })).toHaveCount(0);

  await code.getByRole('button', { name: 'Clear the filter' }).click();
  await expect(code.getByTestId('search-match-count')).toHaveText('2 changed files');
  await expect(code.getByRole('treeitem', { name: /format\.ts/ })).toBeVisible();

  // / filters from anywhere in the panel, and Escape clears it.
  await code.getByRole('treeitem', { name: /format\.ts/ }).focus();
  await page.keyboard.press('/');
  await expect(searchInput).toBeFocused();
  await page.keyboard.type('zzz');
  await expect(code.getByText('No file matches “zzz” among the changes.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(searchInput).toHaveValue('');
});

test('exposes a disconnected session in the docked CLI with a reconnect action', async ({ page }) => {
  let dropConnection: (() => Promise<void>) | undefined;
  let connections = 0;
  await page.routeWebSocket('**/ws/terminal', socket => {
    connections++;
    dropConnection = () => socket.close();
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await chatBesidePanels(page);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const pane = chat.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  await expect(pane.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
  // The docked chat carries no title or breadcrumb of its own: the workspace header above it says where you are.
  await expect(chat.getByText('ContextSpace', { exact: true })).toHaveCount(0);
  // Opening Code beside the chat leaves the session as it is.
  await chat.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(codeSection(page)).toBeVisible();
  await dropConnection?.();
  await expect(pane.getByTestId('terminal-state-help')).toContainText('Input is paused');
  await expect(pane.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(1);
  await expect(pane.getByRole('button', { name: 'End', exact: true })).toHaveCount(1);
  await pane.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(() => connections).toBe(2);
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  await expect(pane.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
  await expect(pane.getByTestId('terminal-disconnected')).toHaveCount(0);
});

test('uses ordinary terminal copy and paste shortcuts', async ({ page, context, baseURL }) => {
  // Derive the origin so the grant follows the configured port instead of a
  // hardcoded one that silently stops matching.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin });
  const inputs: string[] = [];
  await page.routeWebSocket('**/ws/terminal', socket => {
    socket.onMessage(message => {
      const item = JSON.parse(String(message));
      if (item.type === 'attach') {
        socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
        socket.send(JSON.stringify({ type: 'output', data: 'copy this line\r\n' }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      }
      if (item.type === 'input') inputs.push(item.data);
    });
  });
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const pane = page.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  const screen = pane.locator('.xterm-screen');
  // The terminal can connect a frame before the chat has measured its place on the page; measure once it shows.
  await expect(screen).toBeVisible();
  const bounds = await screen.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 1, bounds!.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 130, bounds!.y + 10);
  await page.mouse.up();
  await screen.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('copy this line');
  await page.evaluate(() => navigator.clipboard.writeText('replaced before menu copy'));
  await screen.click({ button: 'right' });
  await pane.getByRole('menuitem', { name: 'Copy selection' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('copy this line');
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
  await page.evaluate(() => navigator.clipboard.writeText('pasted into CLI'));
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(() => inputs.join('')).toContain('pasted into CLI');
  expect(inputs.join('')).not.toContain('\x16');
  await page.evaluate(() => navigator.clipboard.writeText('right click paste'));
  await screen.click({ button: 'right' });
  await pane.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await expect.poll(() => inputs.join('')).toContain('right click paste');

  await page.evaluate(async () => navigator.clipboard.write([
    new ClipboardItem({ 'text/html': new Blob(['<p>menu first</p><p>menu second</p>'], { type: 'text/html' }) }),
  ]));
  await screen.click({ button: 'right' });
  await pane.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await expect.poll(() => inputs.join('')).toContain('menu first\rmenu second');

  // Windows clipboard providers can include an image preview with HTML text
  // while omitting text/plain, which xterm normally reads for paste.
  await pane.locator('.xterm-helper-textarea').evaluate(element => {
    const payload = new DataTransfer();
    payload.setData('text/html', '<p>rich CLI first<br>rich CLI second</p><img src="cid:preview">');
    payload.items.add(new File(['image bytes'], 'preview.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: payload }));
  });
  await expect.poll(() => inputs.join('')).toContain('rich CLI first\rrich CLI second');

  const beforeImage = inputs.join('');
  await pane.locator('.xterm-helper-textarea').evaluate(element => {
    const payload = new DataTransfer();
    payload.items.add(new File(['image bytes'], 'screenshot.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: payload }));
  });
  await expect(pane.getByRole('alert')).toContainText('clipboard contains an image but no text');
  expect(inputs.join('')).toBe(beforeImage);
});

test('Shift+Enter sends a new line to the CLI while Enter still submits', async ({ page }) => {
  const inputs: string[] = [];
  await page.routeWebSocket('**/ws/terminal', socket => {
    socket.onMessage(message => {
      const item = JSON.parse(String(message));
      if (item.type === 'attach') {
        socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      }
      if (item.type === 'input') inputs.push(item.data);
    });
  });
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const pane = page.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('beta');
  await page.keyboard.press('Enter');
  // Exactly one line feed for Shift+Enter and one carriage return for Enter:
  // the keypress that follows Shift+Enter must not add a second, submitting \r.
  await expect.poll(() => inputs.join('')).toBe('alpha\nbeta\r');
});

test('opens paths printed in the terminal in Code, says when one is not there, and keeps the keyboard in the CLI', async ({ page }) => {
  const listing = [{ repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/nested/clean.ts', type: 'unchanged' }] }];
  await page.route('**/api/workspace/feature-x/changes?include=all', route => route.fulfill({ json: { changes: listing } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'export const clean = true;\n' } }));
  const resolved: { path: string | null; cwd: string | null }[] = [];
  await page.route('**/api/workspace/feature-x/files/resolve?*', route => {
    const query = new URL(route.request().url()).searchParams;
    resolved.push({ path: query.get('path'), cwd: query.get('cwd') });
    return query.get('path') === 'src/nested/clean.ts'
      ? route.fulfill({ json: { status: 'found', repoName: 'repo', repoPath: 'C:/repo', file: 'src/nested/clean.ts' } })
      : route.fulfill({ json: { status: 'not-found', reason: 'missing' } });
  });
  await page.routeWebSocket('**/ws/terminal', socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'output', data: 'src/nested/clean.ts:12\r\nsrc/missing.ts:9\r\n' }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await chatBesidePanels(page);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const pane = chat.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  // The chat was already on screen beside Sessions, so it is focused the way a user does: by clicking into it.
  await pane.locator('.xterm-helper-textarea').focus();

  const screen = pane.locator('.xterm-screen');
  const clickOutputRow = async (index: number) => {
    const cell = await screen.evaluate((element, rowIndex) => {
      const bounds = element.getBoundingClientRect();
      const firstRow = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
      const rowHeight = firstRow?.height ?? 17;
      return { x: bounds.x + 35, y: (firstRow?.y ?? bounds.y) + rowHeight * (rowIndex + 0.5) };
    }, index);
    await page.mouse.move(cell.x, cell.y);
    // xterm finds the link under the pointer on hover; a click before that lands on plain text.
    await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
    await page.mouse.click(cell.x, cell.y);
  };
  await clickOutputRow(0);
  const code = codeSection(page);
  await expect(openFileName(page)).toHaveText('src/nested/clean.ts:12');
  await expect(code.getByTestId('code-file-viewer')).toContainText('export const clean = true;');
  // The session's working directory travels with the path, so a relative path resolves the way the CLI meant it.
  expect(resolved[0]).toEqual({ path: 'src/nested/clean.ts', cwd: terminal.cwd });

  // A path that is not there says so, with a way to look for it, instead of doing nothing.
  await clickOutputRow(1);
  const notice = code.getByTestId('code-reference-notice');
  await expect(notice).toContainText("src/missing.ts:9 is not a file in this workspace's repositories.");
  await expect(notice.getByRole('button', { name: /Find “missing\.ts” in Files/ })).toBeVisible();

  await clickOutputRow(0);
  await expect(openFileName(page)).toHaveText('src/nested/clean.ts:12');
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
});

test('a path printed in a tool-call line, in bold or in a diff header opens that file, not the words around it', async ({ page }) => {
  const listing = [{ repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/nested/clean.ts', type: 'unchanged' }] }];
  await page.route('**/api/workspace/feature-x/changes?include=all', route => route.fulfill({ json: { changes: listing } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'export const clean = true;\n' } }));
  const resolved: (string | null)[] = [];
  await page.route('**/api/workspace/feature-x/files/resolve?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    resolved.push(path);
    return path === 'src/nested/clean.ts'
      ? route.fulfill({ json: { status: 'found', repoName: 'repo', repoPath: 'C:/repo', file: 'src/nested/clean.ts' } })
      : route.fulfill({ json: { status: 'not-found', reason: 'missing' } });
  });
  await page.routeWebSocket('**/ws/terminal', socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      // The lines an assistant CLI prints on Linux: a tool call, a bold path in prose, and a diff header.
      socket.send(JSON.stringify({ type: 'output', data: '\u23fa Update(src/nested/clean.ts)\r\n- **src/nested/clean.ts:** the ring\r\n+++ b/src/nested/clean.ts\r\n' }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await chatBesidePanels(page);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const pane = page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  await pane.locator('.xterm-helper-textarea').focus();

  const screen = pane.locator('.xterm-screen');
  const cellWidth = await screen.evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(40);
    probe.style.cssText = 'visibility:hidden;position:absolute;white-space:pre;font:inherit';
    rows!.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 40;
    probe.remove();
    return width;
  });
  const hover = async (row: number, column: number) => {
    const box = await screen.boundingBox();
    const rowHeight = await screen.evaluate((element) => element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height ?? 17);
    const point = { x: box!.x + cellWidth * (column + 0.5), y: box!.y + rowHeight * (row + 0.5) };
    await page.mouse.move(point.x, point.y);
    return point;
  };

  // On the tool's name there is nothing to open.
  await hover(0, 4);
  await page.waitForTimeout(150);
  await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(0);

  // On the path of each line there is, and it is the path alone that is asked for.
  for (const [row, column] of [[0, 16], [1, 12], [2, 14]] as const) {
    const point = await hover(row, column);
    await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => resolved.length).toBe(row + 1);
  }
  expect(resolved).toEqual(['src/nested/clean.ts', 'src/nested/clean.ts', 'src/nested/clean.ts']);
  await expect(codeSection(page).locator('p[title]').first()).toHaveText('src/nested/clean.ts');
});

test('a file made moments ago is looked for among the changes before Code moves to Files', async ({ page }) => {
  const old = { file: 'src/old.ts', type: 'modified', additions: 1, deletions: 0 };
  const made = { file: 'src/new.ts', type: 'added', additions: 3, deletions: 0 };
  // The listing on screen was taken before the assistant made the file; the next one has it.
  let made_it = false;
  await page.route('**/api/workspace/feature-x/changes', route => route.fulfill({ json: { changes: [{ repoName: 'repo', repoPath: 'C:/repo', files: made_it ? [old, made] : [old] }] } }));
  await page.route('**/api/workspace/feature-x/changes?include=all', route => route.fulfill({ json: { changes: [{ repoName: 'repo', repoPath: 'C:/repo', files: [old, made] }] } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'export const made = true;\n' } }));
  await page.route('**/api/workspace/feature-x/files/resolve?*', route => {
    made_it = true;
    return route.fulfill({ json: { status: 'found', repoName: 'repo', repoPath: 'C:/repo', file: 'src/new.ts' } });
  });
  await page.routeWebSocket('**/ws/terminal', socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'output', data: 'src/new.ts:3\r\n' }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await chatBesidePanels(page, 40);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const pane = page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  // Code is open and has listed the changes, so that listing is what is on screen when the path is clicked.
  await page.getByRole('region', { name: 'CLI Chat', exact: true }).getByRole('button', { name: 'Code', exact: true }).click();
  await expect(codeSection(page).getByRole('tree', { name: 'repo changed files' }).getByRole('treeitem', { name: /old\.ts/ })).toBeVisible();
  await expect(codeSection(page).getByRole('tree', { name: 'repo changed files' }).getByRole('treeitem', { name: /new\.ts/ })).toHaveCount(0);
  await pane.locator('.xterm-helper-textarea').focus();

  const screen = pane.locator('.xterm-screen');
  const cell = await screen.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const firstRow = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
    return { x: bounds.x + 35, y: (firstRow?.y ?? bounds.y) + (firstRow?.height ?? 17) * 0.5 };
  });
  await page.mouse.move(cell.x, cell.y);
  await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
  await page.mouse.click(cell.x, cell.y);

  const code = codeSection(page);
  await expect(openFileName(page)).toHaveText('src/new.ts:3');
  // Still among the changes, where the new file now is, not moved to the list of every file.
  await expect(code.getByRole('tree', { name: 'repo changed files' }).getByRole('treeitem', { name: /new\.ts/ })).toBeVisible();
  await expect(code.getByRole('button', { name: /^Changes/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(code.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('opens a path even when the terminal beside Code wraps it across rows', async ({ page }) => {
  const longPath = 'src/nested/really-long-folder-name/with-another-quite-long-segment/target.ts';
  const listing = [{ repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/nested/clean.ts', type: 'unchanged' }, { file: longPath, type: 'unchanged' }] }];
  await page.route('**/api/workspace/feature-x/changes?include=all', route => route.fulfill({ json: { changes: listing } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'export const target = true;\n' } }));
  await resolveFrom(page, listing);
  await page.routeWebSocket('**/ws/terminal', socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'output', data: `src/nested/clean.ts\r\n${longPath}:42\r\n` }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  // The chat keeps the smallest share it can, so the terminal is narrow once Code opens beside it.
  await chatBesidePanels(page, 40);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const pane = chat.getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  const screen = pane.locator('.xterm-screen');
  const clickRow = async (row: number) => {
    const cell = await screen.evaluate((element, index) => {
      const bounds = element.getBoundingClientRect();
      const height = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height ?? 17;
      return { x: bounds.x + 30, y: bounds.y + height * (index + 0.5) };
    }, row);
    await page.mouse.move(cell.x, cell.y);
    // xterm finds the link under the pointer on hover; a click before that lands on plain text.
    await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
    await page.mouse.click(cell.x, cell.y);
  };
  await clickRow(0);
  await expect(openFileName(page)).toHaveText('src/nested/clean.ts');
  await expect.poll(() => screen.evaluate(element => element.clientWidth)).toBeLessThan(500);
  const wrappedLinkRow = screen.locator('.xterm-rows > div').filter({ hasText: 'really-long' }).first();
  await expect(wrappedLinkRow).toBeVisible();
  const wrappedLinkBounds = await wrappedLinkRow.boundingBox();
  expect(wrappedLinkBounds).not.toBeNull();
  await page.mouse.click(wrappedLinkBounds!.x + 30, wrappedLinkBounds!.y + wrappedLinkBounds!.height / 2);
  await expect(openFileName(page)).toHaveText(`${longPath}:42`);
});

test('shows the tree beside the code when there is room, and over it when the panel is narrow', async ({ page }) => {
  const changed = { repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/demo.ts', type: 'modified' }, { file: 'src/other.ts', type: 'modified' }] };
  await page.route('**/api/workspace/feature-x/changes', route => route.fulfill({ json: { changes: [changed] } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: 'diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new\n', fileContent: 'new\n', originalContent: 'old\n' } }));
  await page.goto('/#/workspaces/feature-x/changes');
  const code = codeSection(page);
  await code.getByRole('treeitem', { name: /demo\.ts/ }).click();

  // Wide: the tree sits on the left of the code, and can be hidden and shown again.
  const tree = code.getByRole('complementary', { name: 'Files' });
  const diff = code.getByRole('toolbar', { name: 'Diff' });
  await expect(tree).toBeVisible();
  await expect(diff).toBeVisible();
  expect((await tree.boundingBox())!.x).toBeLessThan((await diff.boundingBox())!.x);
  await code.getByRole('button', { name: 'Hide the file tree' }).click();
  await expect(tree).toHaveCount(0);
  await code.getByRole('button', { name: 'Show the file tree' }).click();
  await expect(tree).toBeVisible();

  // Narrow, as beside the chat: the code keeps the width and the tree opens over it, closing once a file is chosen.
  await code.getByRole('button', { name: 'Show the chat beside this' }).click();
  await expect.poll(async () => (await code.boundingBox())!.width).toBeLessThan(620);
  await expect(tree).toHaveCount(0);
  await expect(diff).toBeVisible();
  await code.getByRole('button', { name: 'Show the file tree' }).click();
  await expect(tree).toBeVisible();
  await tree.getByRole('treeitem', { name: /other\.ts/ }).click();
  await expect(tree).toHaveCount(0);
  await expect(openFileName(page)).toHaveText('src/other.ts');
});

test('opens Code and Docs by keyboard from the terminal and steps files with Alt+Arrow', async ({ page }) => {
  const files = [
    { file: 'src/alpha.ts', type: 'modified' },
    { file: 'src/beta.ts', type: 'modified' },
  ];
  const changed = { repoName: 'repo', repoPath: 'C:/repo', files };
  await page.route('**/api/workspace/feature-x/changes', route => route.fulfill({ json: { changes: [changed] } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'x\n' } }));
  await page.route('**/api/workspace/feature-x/documents', route => route.fulfill({ json: { documents: [{ name: 'AGENTS.md', kind: 'markdown', modifiedAt: '', size: 1 }, { name: 'NOTES.md', kind: 'markdown', modifiedAt: '', size: 1 }] } }));
  await chatBesidePanels(page);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const pane = chat.getByTestId('terminal-pane');
  await expect(pane.locator('.xterm-helper-textarea')).toHaveCount(1);

  // The bindings work with the terminal focused, which is where a user actually is.
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+E');
  await expect(page).toHaveURL(/\/changes$/);
  // Exactly one Code section: the chat keeps every tab mounted, so an ungated listener would act once per pane.
  await expect(page.locator('section[aria-label="Workspace code"]')).toHaveCount(1);
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+D');
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole('region', { name: 'Workspace documents' })).toBeVisible();
  await expect(codeSection(page)).toBeHidden();
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+D');
  await expect(page).toHaveURL(/\/chat$/);
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+E');
  await expect(codeSection(page)).toBeVisible();

  // Alt+Arrow walks the changed files.
  const code = codeSection(page);
  await code.getByRole('treeitem', { name: /alpha\.ts/ }).click();
  await expect(openFileName(page)).toHaveText('src/alpha.ts');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(openFileName(page)).toHaveText('src/beta.ts');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(openFileName(page)).toHaveText('src/alpha.ts');
  await expect(pane).toBeVisible();
});

test('resizes the file tree by dragging, persists it, and marks file types', async ({ page }) => {
  const files = [
    { file: 'src/deeply/nested/folder/with-a-very-long-module-name.ts', type: 'modified' },
    { file: 'src/app.tsx', type: 'added' },
    { file: 'docs/notes.md', type: 'unchanged' },
    { file: 'config/app.config.json', type: 'unchanged' },
    { file: 'scripts/release.sh', type: 'unchanged' },
  ];
  const changed = { repoName: 'repo', repoPath: 'C:/repo', files };
  await page.route('**/api/workspace/feature-x/changes', route => route.fulfill({ json: { changes: [changed] } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'x\n' } }));
  await page.goto('/#/workspaces/feature-x/changes');
  const code = codeSection(page);
  const aside = code.getByRole('complementary', { name: 'Files' });
  const tree = code.getByRole('tree', { name: 'repo changed files' });
  await expect(tree).toBeVisible();

  // Extension glyphs carry the file type, and the type and change are still announced.
  await expect(tree.getByRole('treeitem', { name: /app\.tsx/ })).toContainText('TypeScript React, added');
  await expect(tree.getByRole('treeitem', { name: /app\.config\.json/ })).toContainText('JSON');
  await expect(tree.getByRole('treeitem', { name: /release\.sh/ })).toContainText('Shell script');
  await expect(tree.getByRole('treeitem', { name: /notes\.md/ })).toContainText('Markdown');

  const handle = code.getByRole('separator', { name: 'Resize the file tree' });
  await expect(handle).toBeVisible();
  // Regression: a handle that overlaps the tree sits on its scrollbar and swallows drags on the thumb.
  const treeBox = (await aside.boundingBox())!;
  const handleBox = (await handle.boundingBox())!;
  expect(handleBox.x).toBeGreaterThanOrEqual(treeBox.x + treeBox.width - 0.5);
  const before = treeBox.width;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 90, handleBox.y + handleBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeGreaterThan(before + 40);
  const dragged = Number(await handle.getAttribute('aria-valuenow'));
  expect(dragged).toBeGreaterThan(260);
  expect(await page.evaluate(() => localStorage.getItem('contextspace.code-panel.tree-width'))).toBe(String(dragged));

  // Keyboard resizing stays available, and double-click restores the default.
  await handle.focus();
  await handle.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', String(dragged + 16));
  await handle.dblclick();
  await expect(handle).toHaveAttribute('aria-valuenow', '248');
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeCloseTo(248, 0);
});

test('moves between the changes in a file from one slim toolbar', async ({ page }) => {
  const multiDiff = [
    'diff --git a/src/multi.ts b/src/multi.ts',
    '--- a/src/multi.ts',
    '+++ b/src/multi.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '+const b = 2;',
    ' const c = 3;',
    '@@ -20,3 +21,4 @@ function later() {',
    ' const x = 10;',
    '+const y = 20;',
    ' const z = 30;',
  ].join('\n');
  const changed = { repoName: 'repo', repoPath: 'C:/repo', files: [{ file: 'src/multi.ts', type: 'modified' }] };
  await page.route('**/api/workspace/feature-x/changes', route => route.fulfill({ json: { changes: [changed] } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: multiDiff, fileContent: 'const a = 1;\nconst b = 2;\nconst c = 3;\n' } }));
  await page.goto('/#/workspaces/feature-x/changes');
  const code = codeSection(page);
  await code.getByRole('treeitem', { name: /multi\.ts/ }).click();
  const toolbar = code.getByRole('toolbar', { name: 'Diff' });
  await expect(toolbar).toContainText('Change 1 of 2');
  // One file: past its last change there is no next file to go to.
  await toolbar.getByRole('button', { name: 'Next change' }).click();
  await expect(toolbar).toContainText('Change 2 of 2');
  await expect(toolbar).toContainText('function later() {');
  await expect(toolbar.getByRole('button', { name: 'Next change' })).toBeDisabled();
  await toolbar.getByRole('button', { name: /Jump to a change/ }).click();
  await page.getByRole('menuitem', { name: /Change 1/ }).click();
  await expect(toolbar).toContainText('Change 1 of 2');
});

test('gives Code the whole width and shows the chat beside it again', async ({ page }) => {
  await chatBesidePanels(page);
  await page.goto('/#/workspaces/feature-x/changes');
  const code = codeSection(page);
  const toolbar = code.getByRole('toolbar', { name: 'Code' });
  // The panel's own controls share Code's toolbar: one row, not a title row above it.
  await toolbar.getByRole('button', { name: 'Hide the chat and give this the whole width' }).click();
  const before = (await code.boundingBox())!.width;
  await toolbar.getByRole('button', { name: 'Show the chat beside this' }).click();
  await expect.poll(async () => (await code.boundingBox())!.width).toBeLessThan(before - 200);
  await toolbar.getByRole('button', { name: 'Close this panel and give the chat the whole screen' }).click();
  await expect(page).toHaveURL(/\/chat$/);
});

test('resizes the chat and Code with the arrow keys on the divider between them', async ({ page }) => {
  await chatBesidePanels(page);
  await page.goto('/#/workspaces/feature-x/changes');
  const divider = page.getByRole('separator', { name: 'Resize the chat' });
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await divider.focus();
  await divider.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '47');
  await divider.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
});

test.describe('assistant terminal lifecycle', () => {
  const conversation = '0199a213-81c0-7800-8aa1-bbab2a035a70';
  const codex = { ...terminal, id: '0199a213-81c0-7800-8aa1-bbab2a035a51', target: 'codex', label: 'Codex', sessionId: conversation };
  const targets = [{ id: 'codex', name: 'Codex', available: true, reason: null }];

  test('an ended terminal says so and resumes its conversation instead of offering Reconnect', async ({ page }) => {
    let backendHasTerminal = true;
    let dropConnection: (() => Promise<void>) | undefined;
    const launches: Record<string, unknown>[] = [];
    await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: backendHasTerminal ? [codex] : [], targets } }));
    await page.route('**/api/terminals/feature-x/create', async route => {
      launches.push(route.request().postDataJSON());
      await route.fulfill({ status: 400, json: { error: 'Test launch intercepted' } });
    });
    await page.routeWebSocket('**/ws/terminal', socket => {
      dropConnection = () => socket.close();
      socket.onMessage(message => {
        if (JSON.parse(String(message)).type !== 'attach') return;
        if (!backendHasTerminal) {
          socket.send(JSON.stringify({ type: 'error', code: 'terminal_not_found', message: 'Terminal not found in this workspace.' }));
          void socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: 'ready', terminal: codex, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      });
    });
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const pane = page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane');
    await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
    // The backend restarts: the process is gone, not merely disconnected.
    backendHasTerminal = false;
    await dropConnection?.();
    await pane.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(pane.getByTestId('terminal-state')).toHaveText('Ended');
    await expect(pane.getByTestId('terminal-state-help')).toContainText('no longer running');
    await expect(pane.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'End', exact: true })).toHaveCount(0);
    await expect(pane.getByRole('alert')).toHaveCount(0);
    await pane.getByRole('button', { name: 'Resume conversation', exact: true }).click();
    await expect.poll(() => launches.length).toBe(1);
    expect(launches[0]).toMatchObject({ target: 'codex', sessionId: conversation });
  });

  test('a tool that fails right after starting points to its output and sign-in', async ({ page }) => {
    const fresh = { ...codex, sessionId: undefined, startedAt: new Date(Date.now() - 60_000).toISOString() };
    await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [fresh], targets } }));
    await page.routeWebSocket('**/ws/terminal', socket => {
      socket.onMessage(message => {
        if (JSON.parse(String(message)).type !== 'attach') return;
        socket.send(JSON.stringify({ type: 'ready', terminal: fresh, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
        // Replayed later than 15 s after the start: the backend's exit time decides.
        socket.send(JSON.stringify({ type: 'exit', exitCode: 1, exitedAt: new Date(Date.parse(fresh.startedAt) + 2000).toISOString() }));
      });
    });
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const pane = page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane');
    await expect(pane.getByTestId('terminal-state')).toHaveText('Exited (1)');
    await expect(pane.getByTestId('terminal-state-help')).toContainText('stopped right after starting');
    await expect(pane.getByTestId('terminal-state-help')).toContainText('sign in or finish setup');
  });
});

test.describe('documents in folders of the workspace root', () => {
  test.use({ workspacesData: [{ ...workspace, repos: ['C:/ws/feature-x/repo'] }] });

  test('opens from terminal output in Docs, and repository files in Code', async ({ page }) => {
    const markdown = (name: string, content: string) => ({ name, kind: 'markdown', content });
    // Folders are not in the root listing, so these documents are reachable by link only.
    await page.route('**/api/workspace/feature-x/documents', route => route.fulfill({ json: { documents: [] } }));
    await page.route('**/api/workspace/feature-x/documents?*', route => route.fulfill({ json: { documents: [], folders: [] } }));
    await page.route('**/api/workspace/feature-x/documents/preview?*', route => {
      const name = new URL(route.request().url()).searchParams.get('name');
      if (name === 'docs/report.md') return route.fulfill({ json: markdown(name, '# Quarterly report\n\nSee the [summary](q3/summary.md).') });
      if (name === 'docs/q3/summary.md') return route.fulfill({ json: markdown(name, '# Summary') });
      // The server would open this one, so only the repository rule keeps it out of the document viewer.
      if (name === 'repo/docs/guide.md') return route.fulfill({ json: markdown(name, '# Repository guide') });
      // `docs/guide.md` exists in the repository, not under the workspace root.
      return route.fulfill({ status: 400, json: { error: 'ENOENT: no such file or directory, open' } });
    });
    const listing = [{ repoName: 'repo', repoPath: 'C:/ws/feature-x/repo', files: [{ file: 'docs/guide.md', type: 'unchanged' }] }];
    await page.route('**/api/workspace/feature-x/changes?include=all', route => route.fulfill({ json: { changes: listing } }));
    await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: '# Guide\n' } }));
    await resolveFrom(page, listing);
    await page.routeWebSocket('**/ws/terminal', socket => {
      socket.onMessage(message => {
        if (JSON.parse(String(message)).type !== 'attach') return;
        socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
        // The workspace root is C:/ws/feature-x: the second line is the same folder spelled the way Windows tools do.
        socket.send(JSON.stringify({ type: 'output', data: 'docs/report.md\r\nc:\\ws\\Feature-X\\docs\\q3\\summary.md\r\ndocs/guide.md\r\nrepo/docs/guide.md\r\n' }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      });
    });
    await chatBesidePanels(page);
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    const pane = chat.getByTestId('terminal-pane');
    await expect(pane.getByTestId('terminal-state')).toHaveText('Running');

    const screen = pane.locator('.xterm-screen');
    const clickOutputRow = async (index: number) => {
      const cell = await screen.evaluate((element, rowIndex) => {
        const bounds = element.getBoundingClientRect();
        const firstRow = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
        const rowHeight = firstRow?.height ?? 17;
        return { x: bounds.x + 35, y: (firstRow?.y ?? bounds.y) + rowHeight * (rowIndex + 0.5) };
      }, index);
      await page.mouse.move(cell.x, cell.y);
      // xterm finds the link under the pointer on hover; a click before that lands on plain text.
      await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
      await page.mouse.click(cell.x, cell.y);
    };

    // Documents open in Docs on the rail; there is no second document viewer inside the chat.
    await clickOutputRow(0);
    await expect(page).toHaveURL(/\/documents$/);
    const documents = page.getByRole('region', { name: 'Workspace documents' });
    await expect(documents.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();
    await expect(chat.getByRole('region', { name: 'Workspace documents' })).toHaveCount(0);

    // A relative link in the opened document follows to its sibling, and Back returns.
    await documents.getByRole('link', { name: 'summary' }).click();
    await expect(documents.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
    await documents.getByRole('button', { name: 'Back to report.md' }).click();
    await expect(documents.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();

    // An absolute Windows path in different letter case still names the same document.
    await clickOutputRow(1);
    await expect(documents.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();

    // A repo-relative path has the same shape but is not under the workspace root, so it opens in Code.
    await clickOutputRow(2);
    await expect(page).toHaveURL(/\/changes$/);
    await expect(openFileName(page)).toHaveText('docs/guide.md');

    // A path through a repository under the workspace root is code too, even though the server could open it.
    await clickOutputRow(0);
    await expect(documents.getByRole('heading', { name: 'Quarterly report' })).toBeVisible();
    await clickOutputRow(3);
    await expect(openFileName(page)).toHaveText('docs/guide.md');
    await expect(documents).toBeHidden();
  });
});

test('a file git ignores that the AI names gets a row in the Files tree, only while it is the open file', async ({ page }) => {
  const old = { file: 'src/old.ts', type: 'modified', additions: 1, deletions: 0 };
  const other = { file: 'src/other.ts', type: 'unchanged' };
  // git's listing: no dist/out.js, which the repository ignores, and no other ignored file either.
  await page.route('**/api/workspace/feature-x/changes', route => route.fulfill({ json: { changes: [{ repoName: 'repo', repoPath: 'C:/repo', files: [old] }] } }));
  await page.route('**/api/workspace/feature-x/changes?include=all', route => route.fulfill({ json: { changes: [{ repoName: 'repo', repoPath: 'C:/repo', files: [{ ...old, type: 'modified' }, other] }] } }));
  await page.route('**/api/workspace/feature-x/changes/diff?*', route => route.fulfill({ json: { diff: '', fileContent: 'export const out = 1;\n' } }));
  await page.route('**/api/workspace/feature-x/files/resolve?*', route => route.fulfill({ json: { status: 'found', repoName: 'repo', repoPath: 'C:/repo', file: 'dist/out.js' } }));
  await page.routeWebSocket('**/ws/terminal', socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'output', data: 'dist/out.js:3\r\n' }));
      socket.send(JSON.stringify({ type: 'replayed' }));
    });
  });
  await chatBesidePanels(page, 40);
  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const pane = page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  await pane.locator('.xterm-helper-textarea').focus();
  const screen = pane.locator('.xterm-screen');
  const cell = await screen.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const firstRow = element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect();
    return { x: bounds.x + 35, y: (firstRow?.y ?? bounds.y) + (firstRow?.height ?? 17) * 0.5 };
  });
  await page.mouse.move(cell.x, cell.y);
  await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(1);
  await page.mouse.click(cell.x, cell.y);

  const code = codeSection(page);
  await expect(openFileName(page)).toHaveText('dist/out.js:3');
  // The file is in the Files tree, selected, and marked as not in git's listing.
  await expect(code.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const tree = code.getByRole('tree', { name: 'repo files' });
  const row = tree.getByRole('treeitem', { name: /out\.js/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('I');
  await expect(row.locator('[title*="ignored by git"]').first()).toBeAttached();
  await expect(code.getByTestId('code-file-viewer')).toContainText('export const out = 1;');
  // Only the file that was opened: the files git lists are there as before, the other ignored ones are not.
  await expect(tree.getByRole('treeitem', { name: 'dist' })).toHaveAttribute('aria-expanded', 'true');
  await tree.getByRole('treeitem', { name: 'src' }).click();
  await expect(tree.getByRole('treeitem', { name: /other\.ts/ })).toBeVisible();
  // dist, out.js, src, old.ts and other.ts: no other ignored file has a row.
  await expect(tree.getByRole('treeitem')).toHaveCount(5);

  // Opening another file takes the extra row away; it was only there for the file that was open.
  await tree.getByRole('treeitem', { name: /other\.ts/ }).click();
  await expect(openFileName(page)).toHaveText('src/other.ts');
  await expect(tree.getByRole('treeitem', { name: /out\.js/ })).toHaveCount(0);
});
