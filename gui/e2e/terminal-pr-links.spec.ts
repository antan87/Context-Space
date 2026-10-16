import { test, expect } from './fixtures';

const workspace = { id: 'feature-x', branchName: 'feature-x', description: 'Inspect work', repos: ['/home/dev/workspaces/feature-x/repo'], assistants: ['codex'], workspacePath: '/home/dev/workspaces/feature-x', createdAt: '2026-09-20T00:00:00Z' };
const terminal = { id: '0199a213-81c0-7800-8aa1-bbab2a035a50', workspace: 'feature-x', target: 'shell', label: 'bash', cwd: workspace.workspacePath, state: 'running' };

test.use({ workspacesData: [workspace], viewport: { width: 1450, height: 950 } });

const PR = 'https://github.com/mrpatronz/nexusflow/pull/123';
/** A string that starts with `start`, goes on with `filler`, and is exactly `length` long, ending in a letter. */
const sized = (start: string, filler: string, length: number) => `${start}${filler.repeat(Math.ceil(length / filler.length))}`.slice(0, length - 1).replace(/[^a-z]+$/i, '') + 'x';

/** What a CLI that wraps its own output prints: a row filled to the last column, then the rest on a row of its own, indented. */
const hardWrap = (text: string, cols: number) => [text.slice(0, cols), `  ${text.slice(cols)}`];

test('a pull request link opens the browser and never the Code tree, also when the CLI wrapped it', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url: string) => { (window as unknown as { __opened: string[] }).__opened.push(String(url)); return null; }) as typeof window.open;
    localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
  });
  await page.route('**/api/terminals/bootstrap', route => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', route => route.fulfill({ json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  await page.route('**/api/workspace/feature-x/changes**', route => route.fulfill({ json: { changes: [{ repoName: 'repo', repoPath: workspace.repos[0], files: [] }] } }));
  const resolved: (string | null)[] = [];
  await page.route('**/api/workspace/feature-x/files/resolve?*', route => {
    resolved.push(new URL(route.request().url()).searchParams.get('path'));
    return route.fulfill({ json: { status: 'not-found', reason: 'missing' } });
  });
  let print: ((data: string) => void) | null = null;
  await page.routeWebSocket('**/ws/terminal', socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type !== 'attach') return;
      socket.send(JSON.stringify({ type: 'ready', terminal, truncated: false }));
      socket.send(JSON.stringify({ type: 'replayed' }));
      print = (data) => socket.send(JSON.stringify({ type: 'output', data }));
    });
  });

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const pane = page.getByRole('region', { name: 'CLI Chat', exact: true }).getByTestId('terminal-pane');
  await expect(pane.getByTestId('terminal-state')).toHaveText('Running');
  await pane.locator('.xterm-helper-textarea').focus();
  await expect.poll(() => print !== null).toBe(true);

  const screen = pane.locator('.xterm-screen');
  const cellWidth = await screen.evaluate((element) => {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(40);
    probe.style.cssText = 'visibility:hidden;position:absolute;white-space:pre;font:inherit';
    element.querySelector('.xterm-rows')!.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 40;
    probe.remove();
    return width;
  });
  const box = (await screen.boundingBox())!;
  const cols = Math.round(box.width / cellWidth);
  const rowHeight = await screen.evaluate((element) => element.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height ?? 17);
  // Each is a little longer than the row, so it breaks into two rows and the rest fits on the second.
  const LONG_URL = sized('https://github.com/mrpatronz/nexusflow/compare/main...', 'feature-archive-navigation-', cols + 20 - '  PR: '.length);
  const LONG_PATH = sized('/home/dev/workspaces/feature-x/repo/gui/src/', 'workspace-shell/nested-folder/', cols + 20 - '  Wrote '.length);
  const [urlFirst, urlRest] = hardWrap(`  PR: ${LONG_URL}`, cols);
  const [pathFirst, pathRest] = hardWrap(`  Wrote ${LONG_PATH}`, cols);
  expect(urlFirst).toHaveLength(cols);
  expect(pathFirst).toHaveLength(cols);
  const rows = [`  PR created: ${PR}`, urlFirst, urlRest, 'PR mrpatronz/nexusflow#123 is merged', pathFirst, pathRest];
  print!(`${rows.join('\r\n')}\r\n`);
  await expect(pane.locator('.xterm-rows')).toContainText('is merged');

  const opened = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.slice());
  const clickAt = async (row: number, column: number, expectLink: boolean) => {
    const point = { x: box.x + cellWidth * (column + 0.5), y: box.y + rowHeight * (row + 0.5) };
    await page.mouse.move(point.x, point.y);
    await expect(pane.locator('.xterm-cursor-pointer')).toHaveCount(expectLink ? 1 : 0);
    await page.mouse.click(point.x, point.y);
  };

  // A pull request URL on one row opens the browser, and only that.
  await clickAt(0, 20, true);
  await expect.poll(opened).toEqual([PR]);

  // A URL the CLI broke over two rows is one link: either half opens the whole address.
  await clickAt(1, 20, true);
  await expect.poll(async () => (await opened()).length).toBe(2);
  await clickAt(2, 6, true);
  await expect.poll(async () => (await opened()).length).toBe(3);
  expect(await opened()).toEqual([PR, LONG_URL, LONG_URL]);

  // The name of a pull request, `owner/repo#123`, is not a file and not an address: nothing to open.
  await clickAt(3, 10, false);
  await page.waitForTimeout(300);
  expect(await opened()).toHaveLength(3);
  expect(resolved).toEqual([]);
  await expect(page).toHaveURL(/\/workspaces\/feature-x\/sessions$/);

  // A long path the CLI broke over two rows is one file reference: the second half asks for the whole path.
  await clickAt(5, 8, true);
  await expect.poll(() => resolved).toEqual([LONG_PATH]);
  await expect(page).toHaveURL(/\/workspaces\/feature-x\/changes$/);
});
