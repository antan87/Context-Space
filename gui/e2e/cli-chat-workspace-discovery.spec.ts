import { test, expect } from './fixtures';
import { planFile } from './planData';

/**
 * Workspace discovery in the docked CLI chat.
 *
 * Two independent defects used to hide workspaces from anyone picking one to
 * start a CLI session:
 *
 *   1. The "Choose a workspace for CLI chat" empty state rendered
 *      `workspaces.slice(0, 5)` and offered no search field, so a sixth
 *      workspace onward was simply unreachable from that screen.
 *   2. The search field inside a menu popup could not be typed into (first seen
 *      in the "Add workspace" menu; the terminal's "Pane options" menu has the
 *      same kind of field). Base UI's `useTypeahead` attaches an
 *      `onKeyDown` to the menu popup that calls `preventDefault()` on every
 *      single-character key while the menu is open, without checking whether
 *      the event target is an editable element. The character never reaches
 *      the field, so the filter never changes.
 *
 * These assertions describe intended behavior, so they fail against the
 * defective build. Typing is done with `pressSequentially` on purpose:
 * `fill()` writes the value directly and never dispatches `keydown`, so it
 * would happily pass against the broken search field.
 */

const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];

const workspaces = names.map((name, index) => ({
  id: name,
  branchName: name,
  name,
  description: `Workspace ${index + 1} of ${names.length}`,
  repos: [],
  assistants: [],
  workspacePath: `/tmp/${name}`,
  createdAt: '2026-09-24T00:00:00Z',
}));

test.use({ workspacesData: [workspaces, { option: true }], viewport: { width: 1365, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/terminals/bootstrap', route => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', route => route.fulfill({ json: { available: true, sessions: [], targets: [] } }));
  await page.route('**/api/workspace/*/sessions', route => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/plan', route => route.fulfill({ json: planFile() }));
});

/** The picker button for a workspace. Its accessible name is "<branch> <description>". */
function workspaceButton(chat: import('@playwright/test').Locator, branch: string) {
  return chat.getByRole('button', { name: new RegExp(`^${branch}\\b`) });
}

/** An open chat is a session in the sidebar; the one on screen is the current page. */
function sessionLink(page: import('@playwright/test').Page, branch: string) {
  return page.locator(`aside.context-sidebar [data-sidebar-session="${branch}"]`);
}

/** Open the CLI chat on a workspace and close its only session, so the empty state shows. */
async function openEmptyCliChat(page: import('@playwright/test').Page, first = 'alpha') {
  await page.goto(`/#/workspaces/${first}/chat`);
  const chat = page.getByRole('region', { name: 'CLI Chat' });
  await sessionLink(page, first).focus();
  await page.keyboard.press('Delete');
  await expect(chat.getByRole('heading', { name: 'Choose a workspace for CLI chat' })).toBeVisible();
  return chat;
}

test('the empty CLI chat state reaches every workspace, not just the first five', async ({ page }) => {
  const chat = await openEmptyCliChat(page);

  // All seven must be offered. The sixth and seventh are the ones the old
  // `slice(0, 5)` cap dropped.
  for (const name of names) {
    await expect(workspaceButton(chat, name)).toBeVisible();
  }

  // The name and its description are both announced, so a screen reader user
  // can tell two similarly named workspaces apart.
  await expect(workspaceButton(chat, 'golf')).toHaveAccessibleName('golf Workspace 7 of 7');
});

test('the empty CLI chat state can be searched without opening the header menu', async ({ page }) => {
  const chat = await openEmptyCliChat(page);

  const search = chat.getByRole('searchbox', { name: 'Search workspaces for CLI chat' });
  await expect(search).toBeVisible();
  await search.pressSequentially('golf');

  await expect(workspaceButton(chat, 'golf')).toBeVisible();
  await expect(workspaceButton(chat, 'alpha')).toHaveCount(0);
});

test('a search that matches nothing says so instead of listing everything', async ({ page }) => {
  const chat = await openEmptyCliChat(page);

  const search = chat.getByRole('searchbox', { name: 'Search workspaces for CLI chat' });
  await search.pressSequentially('zzzz');

  // The on-screen copy; the status region carries the spoken one (tested below).
  await expect(chat.locator('p:not([role="status"])', { hasText: 'No workspaces match "zzzz"' })).toBeVisible();
  await expect(workspaceButton(chat, 'alpha')).toHaveCount(0);
});

/**
 * The terminal's "Pane options" menu has a search field of the same kind. It has to stay out of the popup's
 * typeahead, but it must not swallow the keys the menu itself needs: Escape is handled by a document-level native
 * listener in Base UI, so a blanket `stopPropagation` on the field's keydown would stop the event before it ever gets
 * there and leave the menu stuck open.
 *
 * (Clicking outside is deliberately not asserted: the popup is modal, so the rest of the page is inert and cannot
 * receive the click. That is Base UI's design, not behaviour this change affects.)
 */
test.describe('the search field in the terminal pane menu', () => {
  test.beforeEach(async ({ page }) => {
    // A running terminal, so the pane has its menu. Registered after the file's own, so these answer first.
    await page.route('**/api/terminals/*/status', route => {
      const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
      return route.fulfill({ json: { available: true, sessions: [{ id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' }], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } });
    });
    await page.routeWebSocket('**/ws/terminal', socket => {
      socket.onMessage(message => {
        const parsed = JSON.parse(String(message));
        if (parsed.type !== 'attach') return;
        socket.send(JSON.stringify({ type: 'ready', terminal: { id: parsed.id, workspace: parsed.workspace, target: 'shell', label: 'bash', cwd: `/tmp/${parsed.workspace}`, state: 'running' }, truncated: false }));
        socket.send(JSON.stringify({ type: 'replayed' }));
      });
    });
  });

  async function openPaneMenu(page: import('@playwright/test').Page) {
    await page.goto('/#/workspaces/alpha/chat');
    const chat = page.getByRole('region', { name: 'CLI Chat' });
    await expect(chat.getByTestId('terminal-state')).toHaveText('Running');
    await chat.getByRole('button', { name: 'Pane options' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    return { menu, search: menu.getByPlaceholder('Search output') };
  }

  test('typing into it reaches the field', async ({ page }) => {
    const { search } = await openPaneMenu(page);

    // Real keystrokes, not fill(): the defect is a cancelled keydown, so a
    // direct value write would pass even while search is broken.
    await search.pressSequentially('golf');

    await expect(search).toHaveValue('golf');
  });

  test('Escape still closes the menu while the field has focus', async ({ page }) => {
    const { menu, search } = await openPaneMenu(page);
    await search.pressSequentially('golf');
    await expect(menu).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('arrow keys still reach the menu while the field has focus', async ({ page }) => {
    const { menu, search } = await openPaneMenu(page);
    await search.focus();

    // Arrow navigation must not be swallowed: if it were, the popup would never
    // highlight an item and the list could not be traversed from the keyboard.
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('[role="menuitem"][data-highlighted]')).toHaveCount(1);
  });
});

/**
 * The picker replaces itself as you use it: choosing a workspace unmounts the
 * whole empty state, and the last "Show N more" click unmounts its own button.
 * Without care, focus falls to <body> and a keyboard or screen-reader user is
 * thrown back to the top of the page with no word about what happened.
 */
test('opening a workspace from the empty state keeps keyboard focus on its session', async ({ page }) => {
  const chat = await openEmptyCliChat(page);

  await chat.getByRole('searchbox', { name: 'Search workspaces for CLI chat' }).pressSequentially('golf');
  await page.keyboard.press('Tab');
  await expect(workspaceButton(chat, 'golf')).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(sessionLink(page, 'golf')).toBeFocused();
});

test('filtering the picker is announced to screen readers', async ({ page }) => {
  const chat = await openEmptyCliChat(page);
  const status = chat.getByTestId('cli-chat-picker-results');

  // The live region must exist, empty, before the first change: a region that
  // appears together with its text is not reliably announced.
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveText('');

  const search = chat.getByRole('searchbox', { name: 'Search workspaces for CLI chat' });
  await search.pressSequentially('golf');
  await expect(status).toHaveText('1 workspace matches');

  await search.fill('');
  await search.pressSequentially('ha');
  await expect(status).toHaveText('2 workspaces match');

  await search.pressSequentially('zzz');
  await expect(status).toHaveText('No workspaces match "hazzz"');
});

test.describe('with more workspaces than the first page shows', () => {
  const many = Array.from({ length: 30 }, (_, index) => {
    const branch = `ws-${String(index + 1).padStart(2, '0')}`;
    return { ...workspaces[0], id: branch, branchName: branch, name: branch, description: `Workspace ${index + 1} of 30`, workspacePath: `/tmp/${branch}` };
  });
  test.use({ workspacesData: [many, { option: true }] });

  test('revealing more workspaces moves focus to the first new one', async ({ page }) => {
    const chat = await openEmptyCliChat(page, many[0]!.branchName);
    const group = chat.getByRole('group', { name: 'Workspaces available for CLI chat' });
    await expect(group.getByRole('button')).toHaveCount(12);

    // Thirty workspaces: one click reveals the rest and removes the button
    // that had focus, which is exactly the case that used to drop it.
    const more = chat.getByRole('button', { name: 'Show 18 more of 30' });
    await more.focus();
    await page.keyboard.press('Enter');

    await expect(group.getByRole('button')).toHaveCount(30);
    await expect(more).toHaveCount(0);
    await expect(workspaceButton(chat, 'ws-13')).toBeFocused();
  });
});

test.describe('the sidebar list', () => {
  const filter = (page: import('@playwright/test').Page) => page.locator('aside.context-sidebar').getByPlaceholder('Filter...');
  const listed = (page: import('@playwright/test').Page, branch: string) => page.locator(`aside.context-sidebar a[href="#/workspaces/${branch}"]`);

  test('lists every workspace, and its filter narrows the list as you type', async ({ page }) => {
    await page.goto('/#/overview');
    for (const name of names) await expect(listed(page, name)).toBeVisible();

    await filter(page).pressSequentially('golf');
    await expect(listed(page, 'golf')).toBeVisible();
    await expect(listed(page, 'alpha')).toHaveCount(0);
  });

  test('a filter that matches nothing says so', async ({ page }) => {
    await page.goto('/#/overview');
    await filter(page).pressSequentially('zzzz');
    await expect(page.locator('aside.context-sidebar').getByText('No workspaces match')).toBeVisible();
  });
});
