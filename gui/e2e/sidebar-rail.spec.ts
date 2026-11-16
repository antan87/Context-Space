import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { FLOATING_CHAT_STORAGE_KEY } from '../src/brand';
import { checkpoint, planFile, step } from './planData';

/**
 * On a desktop the sidebar is the slim rail, so the page keeps its room. The full list opens over the page as a sheet
 * (it never moves the page), closes on a click outside, Escape or any destination, and a pin docks it beside the page.
 */
const workspace = (name: string) => ({
  id: name, branchName: name, description: `${name} workspace`, repos: [], assistants: [], workspacePath: `/tmp/${name}`, createdAt: '2026-09-24T00:00:00Z',
});

test.use({
  workspacesData: [['alpha', 'beta'].map(workspace), { option: true }],
  sidebarDocked: false,
  viewport: { width: 1280, height: 800 },
});

const rail = (page: Page) => page.locator('aside[data-sidebar="rail"]');
const sheet = (page: Page) => page.locator('[data-slot="sheet-popup"]');
const showWorkspaces = (page: Page) => rail(page).getByRole('button', { name: 'Show workspaces (z)' });
const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
// By its label, not its role: an open sheet hides the page from the accessibility tree.
const boxOf = async (page: Page) => (await page.locator('[aria-label="Board"]').first().boundingBox())!;

async function expectNoSeriousViolations(page: Page, scope: string) {
  // Measure settled colours: a fade caught mid-way reports a contrast no user sees.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const results = await new AxeBuilder({ page }).include(scope).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  const summary = serious.map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.html.slice(0, 120) + ' ' + node.failureSummary).join(' | ')}`);
  expect(summary, summary.join('\n')).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  // Two open sessions, as on a real desktop, so the rail carries their tiles and close buttons and axe sees how they sit together.
  await page.addInitScript((key) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ openTabs: ['alpha', 'beta'], activeTab: 'alpha' })); } catch { /* no storage */ } }, FLOATING_CHAT_STORAGE_KEY);
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.goto('/#/workspaces/alpha/board');
  await expect(board(page)).toBeVisible();
});

test('the rail is the default, and the board has about 200 px more room than beside the docked list', async ({ page }) => {
  await expect(rail(page)).toBeVisible();
  expect(Math.round((await rail(page).boundingBox())!.width)).toBe(56);
  await expect(page.locator('aside[data-sidebar="full"]')).toHaveCount(0);
  const withRail = await boxOf(page);

  await showWorkspaces(page).click();
  await sheet(page).getByRole('button', { name: 'Keep the sidebar open' }).click();
  await expect(page.locator('aside[data-sidebar="full"]')).toBeVisible();
  await expect.poll(async () => Math.round((await boxOf(page)).width)).toBeLessThan(Math.round(withRail.width) - 150);
  const docked = await boxOf(page);
  expect(withRail.width - docked.width).toBeGreaterThanOrEqual(190);
  expect(withRail.width - docked.width).toBeLessThanOrEqual(210);
});

test('the sheet opens over the page without moving the board', async ({ page }) => {
  const before = await boxOf(page);
  await showWorkspaces(page).click();
  await expect(sheet(page).getByRole('link', { name: /^alpha\b/ })).toBeVisible();
  await expect(sheet(page).getByRole('link', { name: /^beta\b/ })).toBeVisible();
  expect(await boxOf(page)).toEqual(before);
  expect(Math.round((await sheet(page).boundingBox())!.width)).toBe(256);
});

test('a click outside closes the sheet', async ({ page }) => {
  await showWorkspaces(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.mouse.click(900, 400);
  await expect(sheet(page)).toHaveCount(0);
});

test('Escape closes the sheet and puts focus back on the rail button', async ({ page }) => {
  await showWorkspaces(page).focus();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(showWorkspaces(page)).toBeFocused();
});

test('z opens and closes the sheet, and choosing a workspace closes it too', async ({ page }) => {
  await page.keyboard.press('z');
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('z');
  await expect(sheet(page)).toHaveCount(0);

  await page.keyboard.press('z');
  await sheet(page).getByRole('link', { name: /^beta\b/ }).click();
  await expect(page).toHaveURL(/#\/workspaces\/beta(\/board)?$/);
  await expect(sheet(page)).toHaveCount(0);
});

test('the pin docks the list, and the dock survives a reload; collapsing goes back to the rail', async ({ page }) => {
  await showWorkspaces(page).click();
  await sheet(page).getByRole('button', { name: 'Keep the sidebar open' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(rail(page)).toHaveCount(0);
  await expect(page.locator('aside[data-sidebar="full"]').getByRole('button', { name: 'Collapse (z)' })).toBeFocused();

  await page.reload();
  await expect(page.locator('aside[data-sidebar="full"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ctxspace_sidebar_docked_v1'))).toBe('true');

  await page.keyboard.press('z');
  await expect(rail(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ctxspace_sidebar_docked_v1'))).toBeNull();
  await page.reload();
  await expect(rail(page)).toBeVisible();
});

test('Ctrl K opens Jump to from the rail, and its icon does too', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Jump to a workspace or page' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await rail(page).getByRole('button', { name: 'Jump to a workspace' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('option', { name: /beta/ }).click();
  await expect(page).toHaveURL(/#\/workspaces\/beta(\/board)?$/);
});

test('Jump to from inside the sheet closes the sheet', async ({ page }) => {
  await page.keyboard.press('z');
  await sheet(page).getByRole('button', { name: 'Search and jump to a workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Jump to a workspace or page' });
  await expect(dialog).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await dialog.getByRole('option', { name: /beta/ }).click();
  await expect(page).toHaveURL(/#\/workspaces\/beta(\/board)?$/);
});

test('has no serious accessibility violations on the rail or on the open sheet', async ({ page }) => {
  // The second tile's close button is focused, so its ring is drawn too.
  await rail(page).getByRole('button', { name: /^Close session beta/ }).focus();
  await expectNoSeriousViolations(page, 'aside[data-sidebar="rail"]');
  await showWorkspaces(page).click();
  await expect(sheet(page)).toBeVisible();
  await expectNoSeriousViolations(page, '[data-slot="sheet-popup"]');
});

test('a press in the bottom-left corner of a tile opens that tile and closes nothing', async ({ page }) => {
  await page.goto('/#/overview');
  const tile = rail(page).locator('[data-sidebar-session="alpha"]');
  const box = (await tile.boundingBox())!;
  await page.mouse.click(box.x + 3, box.y + box.height - 3);
  await expect(page).toHaveURL(/#\/workspaces\/alpha/);
  await expect(rail(page).getByRole('button', { name: /^Close session/ })).toHaveCount(2);
  await expect(rail(page).locator('[data-sidebar-session="beta"]')).toBeVisible();
});

test('a narrow window has the sheet but no pin', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await showWorkspaces(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Keep the sidebar open' })).toHaveCount(0);
});

const jumpDialog = (page: Page) => page.getByRole('dialog', { name: 'Jump to a workspace or page' });

test('the pin and the collapse swap the rail for the list without morphing it', async ({ page }) => {
  await showWorkspaces(page).click();
  // Watch the docked list from the frame it appears in: a reused rail node would ease from 56 px to 256.
  await page.evaluate(() => {
    const widths: number[] = [];
    (window as unknown as { dockedWidths: number[] }).dockedWidths = widths;
    new MutationObserver((records) => {
      for (const record of records) for (const added of record.addedNodes) {
        if (added instanceof HTMLElement && added.matches('aside[data-sidebar="full"]') && !added.closest('[data-slot="sheet-popup"]')) {
          widths.push(added.getBoundingClientRect().width);
          requestAnimationFrame(() => { widths.push(added.getBoundingClientRect().width); requestAnimationFrame(() => widths.push(added.getBoundingClientRect().width)); });
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await sheet(page).getByRole('button', { name: 'Keep the sidebar open' }).click();
  await expect(page.locator('aside[data-sidebar="full"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { dockedWidths: number[] }).dockedWidths.length)).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => (window as unknown as { dockedWidths: number[] }).dockedWidths)).toEqual([256, 256, 256]);

  // And back: the rail is 56 px from its first frame.
  await page.evaluate(() => {
    const widths: number[] = [];
    (window as unknown as { railWidths: number[] }).railWidths = widths;
    new MutationObserver((records) => {
      for (const record of records) for (const added of record.addedNodes) {
        if (added instanceof HTMLElement && added.matches('aside[data-sidebar="rail"]')) {
          widths.push(added.getBoundingClientRect().width);
          requestAnimationFrame(() => widths.push(added.getBoundingClientRect().width));
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.press('z');
  await expect(rail(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { railWidths: number[] }).railWidths.length)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => (window as unknown as { railWidths: number[] }).railWidths)).toEqual([56, 56]);
});

test('z does nothing behind Jump to or a dialog, on the rail or docked', async ({ page }) => {
  const dockedKey = () => page.evaluate(() => localStorage.getItem('ctxspace_sidebar_docked_v1'));
  for (const docked of [false, true]) {
    if (docked) {
      await page.evaluate(() => localStorage.setItem('ctxspace_sidebar_docked_v1', 'true'));
      // A hash-only navigation would not reload the page, so the saved choice would not be read.
      await page.reload();
      await expect(page.locator('aside[data-sidebar="full"]')).toBeVisible();
    }
    await page.keyboard.press('Control+k');
    await expect(jumpDialog(page)).toBeVisible();
    // Focus on a button, not the field, so z is not taken for typing.
    await jumpDialog(page).getByRole('button', { name: 'Close search' }).focus();
    await page.keyboard.press('z');
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('aside[data-sidebar="rail"]')).toHaveCount(docked ? 0 : 1);
    expect(await dockedKey()).toBe(docked ? 'true' : null);
    await page.keyboard.press('Escape');
    await expect(jumpDialog(page)).toBeHidden();

    // A Base UI dialog, which sets no aria-modal.
    await page.goto('/#/projects');
    await page.getByRole('button', { name: /New project/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Cancel/ }).first().focus();
    await page.keyboard.press('z');
    await page.waitForTimeout(300);
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator('aside[data-sidebar="rail"]')).toHaveCount(docked ? 0 : 1);
    expect(await dockedKey()).toBe(docked ? 'true' : null);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
  // With nothing open the shortcut works again, and undocks the docked list.
  await page.locator('body').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('z');
  await expect(rail(page)).toBeVisible();
});

test('Escape from Jump to leaves focus where it was, so the board still closes its Area with the next Escape', async ({ page }) => {
  await page.route('**/api/workspace/alpha/plan', (route) => route.fulfill({ json: planFile({
    title: 'Reports CSV export',
    checkpoints: [checkpoint('Reports export to CSV', { steps: [step('Write the CSV writer', true), step('Download link in the report page')] })],
  }) }));
  await page.reload();
  const area = page.locator('[aria-label="Board"] .board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' });
  await area.click();
  const back = page.getByRole('button', { name: 'Board ›' });
  await expect(back).toBeVisible();
  // The keyboard is on the page itself, as after a click on empty canvas: Jump to has nothing to give focus back to
  // and must not pull it onto the rail.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+k');
  await expect(jumpDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(jumpDialog(page)).toBeHidden();
  await expect(showWorkspaces(page)).not.toBeFocused();
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  // The Area is still open, and an Escape from the page closes it.
  await page.keyboard.press('Escape');
  await expect(back).toHaveCount(0);
  await area.click();
  await expect(back).toBeVisible();
  // With the keyboard on the board, Jump to gives it back, so the next Escape closes the Area.
  await back.focus();
  await page.keyboard.press('Control+k');
  await expect(jumpDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(jumpDialog(page)).toBeHidden();
  await expect(back).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(back).toHaveCount(0);
});

test('Jump to over the open sheet closes the sheet, so Escape closes Jump to only', async ({ page }) => {
  await page.keyboard.press('z');
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(jumpDialog(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(jumpDialog(page)).toBeHidden();
  await expect(sheet(page)).toHaveCount(0);
});

test('focus is not lost when Jump to was opened from the field in the sheet', async ({ page }) => {
  await page.keyboard.press('z');
  await sheet(page).getByRole('button', { name: 'Search and jump to a workspace' }).click();
  await expect(jumpDialog(page)).toBeVisible();
  // The sheet is gone, and with it the field that opened Jump to. Waiting matters: Escape inside the sheet's exit would pass anyway.
  await expect(sheet(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(jumpDialog(page)).toBeHidden();
  await expect(showWorkspaces(page)).toBeFocused();
});

test('a sheet left open when another tab docks does not come back when it undocks', async ({ page, context }) => {
  await page.keyboard.press('z');
  await expect(sheet(page)).toBeVisible();
  const other = await context.newPage();
  await other.goto('/#/overview');
  await other.evaluate(() => localStorage.setItem('ctxspace_sidebar_docked_v1', 'true'));
  await expect(page.locator('aside[data-sidebar="full"]')).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await other.evaluate(() => localStorage.removeItem('ctxspace_sidebar_docked_v1'));
  await expect(rail(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await other.close();
});

test('the sheet starts on its Jump to field, so Enter does not leave for Overview', async ({ page }) => {
  await page.keyboard.press('z');
  await expect(sheet(page).getByRole('button', { name: 'Search and jump to a workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(jumpDialog(page)).toBeVisible();
});

test('Ctrl K still opens the one Jump to in docked mode after three rounds of docking and undocking', async ({ page }) => {
  for (let round = 0; round < 3; round += 1) {
    await showWorkspaces(page).click();
    await sheet(page).getByRole('button', { name: 'Keep the sidebar open' }).click();
    await expect(rail(page)).toHaveCount(0);
    await page.keyboard.press('z');
    await expect(rail(page)).toBeVisible();
  }
  await showWorkspaces(page).click();
  await sheet(page).getByRole('button', { name: 'Keep the sidebar open' }).click();
  await expect(page.locator('aside[data-sidebar="full"]')).toBeVisible();
  await expect(page.locator('dialog')).toHaveCount(1);
  await page.keyboard.press('Control+k');
  await expect(jumpDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(jumpDialog(page)).toBeHidden();
});

test('the open sheet is set apart from the page by a shadow', async ({ page }) => {
  await page.keyboard.press('z');
  await expect(sheet(page)).toBeVisible();
  // The layer this sheet adds to the default one, which is there on every sheet.
  expect(await sheet(page).evaluate((node) => getComputedStyle(node).boxShadow)).toContain('8px 0px 24px');
});
