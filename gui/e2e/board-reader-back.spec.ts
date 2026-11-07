import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardFileCard, checkpoint, planFile, step, whatsNew } from './planData';

/**
 * The reader keeps a trail: following a picture, a plan path or a link from inside it is a step deeper, and Back, Alt+Left and
 * Escape return one step to the place as it was left. Everything is faked, and every write is refused.
 */
const workspace = { id: 'demo', branchName: 'demo', name: 'Reports CSV export', description: 'Add CSV export', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z' };
test.use({ workspacesData: [[workspace], { option: true }], sidebarDocked: false });

const SHA = 'a91f2e0c4d5b1234567890123456789012345678';
const SHORT = SHA.slice(0, 7);
const SHA2 = 'b82e3f1d5e6c2345678901234567890123456789';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const COMMIT = {
  repo: 'billing', sha: SHA, shortSha: SHA.slice(0, 12), author: 'Anna', at: new Date(Date.now() - 30 * 60_000).toISOString(),
  subject: 'Write the CSV writer',
  body: Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long commit message that makes the reader scroll.`).join('\n'),
  parents: [], files: [{ path: 'src/export.ts', status: 'modified', additions: 2, deletions: 1 }], moreFiles: 0, additions: 2, deletions: 1, pushed: false, forge: null, webUrl: null,
};
const DIFF = { repo: 'billing', repoPath: '/tmp/demo/billing', sha: SHA, file: 'src/export.ts', diff: 'diff --git a/src/export.ts b/src/export.ts\n--- a/src/export.ts\n+++ b/src/export.ts\n@@ -1,2 +1,3 @@\n-old\n+new one\n+new two\n keep\n', fileContent: 'new one\nnew two\nkeep\n', originalContent: 'old\nkeep\n', symbols: [] };
const DOCS: Record<string, string> = {
  'PLAN.md': '# The plan\n\nSee [the notes](docs/notes.md) and [the picture](board-pictures/export.png).',
  'docs/notes.md': '# The notes\n\nOpen [the picture](board-pictures/other.png) or go [deeper](deep.md).',
  'docs/deep.md': '# The deep page\n\nLink to [the deep page](deep.md) again.',
};

let writes: string[] = [];
test.beforeEach(async ({ page }) => {
  writes = [];
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 't', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({
    json: planFile({
      title: 'Reports CSV export',
      checkpoints: [checkpoint('Reports export to CSV', { steps: [
        step(`Write the CSV writer (${COMMIT.shortSha}). Pictures: \`board-pictures/export.png\`, \`board-pictures/other.png\``, true),
        step(`Background job queue for large exports (${SHA2.slice(0, 12)})`),
      ] })],
    }),
  }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
    json: whatsNew({
      commits: [{
        repo: 'billing',
        more: 0,
        commits: [
          { sha: SHA, author: 'Anna', subject: COMMIT.subject, at: COMMIT.at },
          { sha: SHA2, author: 'Anna', subject: 'Second commit', at: COMMIT.at },
        ],
      }],
    }),
  }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({
    json: boardFile({ cards: [
      boardFileCard(2, 'board-pictures/other.png', { title: 'Other picture' }),
    ] }),
  }));
  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/diff')) return route.fulfill({ json: DIFF });
    if (url.pathname.includes(SHA2)) return route.fulfill({ json: { ...COMMIT, sha: SHA2, shortSha: SHA2.slice(0, 12), subject: 'Second commit' } });
    return route.fulfill({ json: COMMIT });
  });
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name.endsWith('.png')) return route.fulfill({ json: { name, kind: 'image', size: PNG.length, modifiedAt: new Date().toISOString() } });
    const content = DOCS[name];
    return content ? route.fulfill({ json: { name, kind: 'markdown', content, size: content.length, modifiedAt: new Date().toISOString() } }) : route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.route('**/api/workspace/demo/documents/file?*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD' || new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
  await page.routeWebSocket('**/ws/terminal', () => undefined);
});
test.afterEach(() => { expect(writes, 'no test here may write').toEqual([]); });

const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
const title = (page: Page, name: string) => reader(page).getByRole('heading', { name, level: 2, exact: true });
const backButton = (page: Page, label: string) => reader(page).getByRole('button', { name: `Back to ${label}`, exact: true });
const anyBack = (page: Page) => reader(page).getByRole('button', { name: /^Back to /, });
const commitCard = (page: Page) => board(page).locator('#board-area .react-flow__node-commit').filter({ hasText: 'Write the CSV writer' });
const commitButton = (page: Page) => commitCard(page).getByRole('button', { name: 'Open Write the CSV writer', exact: true });
const scroller = (page: Page) => reader(page).locator('div.overflow-y-auto').first();

async function open(page: Page, mode: 'board' | 'split', layout: 'large' | 'side') {
  await page.addInitScript((value) => {
    localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
    localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
    localStorage.setItem('contextspace_board_reader_layout_v1', value);
  }, layout);
  await page.goto('/#/workspaces/demo/board');
  await page.getByTestId(`view-mode-${mode}`).click();
  await expect(page.getByTestId(`view-mode-${mode}`)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.board-overview-plane button.board-area').first().click();
  await expect(page.getByRole('button', { name: 'Board ›', exact: true })).toBeVisible();
  await expect(commitButton(page)).toBeVisible();
}
const openCommitAndPicture = async (page: Page) => {
  await commitButton(page).click();
  await expect(title(page, 'Write the CSV writer')).toBeVisible();
  await expect(anyBack(page)).toHaveCount(0);
  await reader(page).getByRole('link', { name: 'export.png', exact: true }).click();
  await expect(title(page, 'export.png')).toBeVisible();
};

for (const size of [{ width: 1280, height: 800, mode: 'split' as const }, { width: 1100, height: 700, mode: 'split' as const }, { width: 1440, height: 900, mode: 'board' as const }]) {
  for (const layout of ['large', 'side'] as const) {
    test.describe(`${size.width}x${size.height} in ${size.mode}, reader ${layout === 'large' ? 'as a window' : 'docked'}`, () => {
      test.use({ viewport: { width: size.width, height: size.height } });
      test.beforeEach(async ({ page }) => open(page, size.mode, layout));

      test('Back and Escape return to the commit as it was left: file, diff mode, scroll; a second Escape closes and the commit card has the keyboard', async ({ page }) => {
        await commitButton(page).click();
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
        await reader(page).getByRole('button', { name: /src\/export\.ts/ }).click();
        const sideBySide = reader(page).getByRole('button', { name: 'Side by side', exact: true });
        await expect(sideBySide).toBeVisible();
        const before = await sideBySide.getAttribute('aria-pressed');
        await sideBySide.click();
        const chosen = before === 'true' ? 'false' : 'true';
        await expect(sideBySide).toHaveAttribute('aria-pressed', chosen);
        await scroller(page).evaluate((el) => { el.scrollTop = 160; });
        await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
        const left = await scroller(page).evaluate((el) => el.scrollTop);

        await reader(page).getByRole('link', { name: 'export.png', exact: true }).click();
        await expect(title(page, 'export.png')).toBeVisible();
        const back = backButton(page, SHORT);
        await expect(back).toBeVisible();
        await expect(back).toHaveAttribute('title', new RegExp(`Back to ${SHORT}`));
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(24);
        expect(await back.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
        await expect(back).toContainText(SHORT);
        // the commit card stays lit, not the picture followed
        await expect(commitCard(page).locator('article')).toHaveAttribute('aria-current', 'true');

        const restored = async () => {
          await expect(title(page, 'Write the CSV writer')).toBeVisible();
          await expect(reader(page).getByRole('button', { name: /src\/export\.ts/ })).toHaveAttribute('aria-expanded', 'true');
          await expect(reader(page).getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', chosen);
          await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(left - 2);
          await expect(anyBack(page)).toHaveCount(0);
        };
        await back.click();
        await restored();

        // Escape does the same step, and the second one closes
        await reader(page).getByRole('link', { name: 'export.png', exact: true }).click();
        await expect(title(page, 'export.png')).toBeVisible();
        await page.keyboard.press('Escape');
        await restored();
        await page.keyboard.press('Escape');
        await expect(reader(page)).toHaveCount(0);
        await expect(commitButton(page)).toBeFocused();
      });

      test('the close button and a press on the board from the picture close everything', async ({ page }) => {
        await openCommitAndPicture(page);
        await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
        await expect(reader(page)).toHaveCount(0);
        await expect(commitCard(page).locator('article')).toBeVisible();
        // reopening starts clean: no trail
        await commitButton(page).click();
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);

        await reader(page).getByRole('link', { name: 'export.png', exact: true }).click();
        await expect(title(page, 'export.png')).toBeVisible();
        // a press on the board (the empty corner of the Area, or the dimmed board round the window) closes it all
        // (where the reader covers the Area, the strip left of it is the board too)
        const area = (await page.locator('#board-area').boundingBox())!;
        const shown = (await reader(page).boundingBox())!;
        const inside = (x: number, y: number) => x >= shown.x && x <= shown.x + shown.width && y >= shown.y && y <= shown.y + shown.height;
        const pane = (await board(page).boundingBox())!;
        const candidates: Array<[number, number]> = [
          [area.x + 6, area.y + area.height - 6],
          [shown.x - 5, shown.y + shown.height / 2],
          [shown.x + shown.width / 2, shown.y + shown.height + 5],
        ];
        const [x, y] = candidates.find(([cx, cy]) => !inside(cx, cy) && cx > pane.x && cx < pane.x + pane.width && cy > pane.y && cy < pane.y + pane.height)!;
        await page.mouse.click(x, y);
        await expect(reader(page)).toHaveCount(0);
        // the press also does its own thing (a press on the Area header steps out of the Area): step in again if it did
        const areaButton = page.locator('.board-overview-plane button.board-area').first();
        const stepOut = page.getByRole('button', { name: 'Board ›', exact: true });
        await expect.poll(async () => (await commitButton(page).isVisible()) || !(await stepOut.isVisible())).toBe(true);
        if (!(await commitButton(page).isVisible())) {
          await areaButton.click();
          await expect(commitButton(page)).toBeVisible();
        }
        await commitButton(page).click();
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);
      });

      test('three deep through links in documents and back twice, by the button and by Alt+Left', async ({ page }) => {
        await commitButton(page).click();
        await reader(page).getByRole('link', { name: /Reports export to CSV/ }).click();
        await expect(title(page, 'PLAN.md')).toBeVisible();
        await expect(backButton(page, SHORT)).toBeVisible();
        await reader(page).getByRole('link', { name: 'the notes', exact: true }).click();
        await expect(title(page, 'notes.md')).toBeVisible();
        await expect(backButton(page, 'PLAN.md')).toBeVisible();
        await reader(page).getByRole('link', { name: 'deeper', exact: true }).click();
        await expect(title(page, 'deep.md')).toBeVisible();
        await expect(backButton(page, 'notes.md')).toBeVisible();
        await backButton(page, 'notes.md').click();
        await expect(title(page, 'notes.md')).toBeVisible();
        await page.keyboard.press('Alt+ArrowLeft');
        await expect(title(page, 'PLAN.md')).toBeVisible();
        await expect(backButton(page, SHORT)).toBeVisible();
        await page.keyboard.press('Alt+ArrowLeft');
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);
        // with no trail Alt+Left is no Back
        await page.keyboard.press('Alt+ArrowLeft');
        await expect(reader(page)).toBeVisible();
      });

      test('a link to the place already shown adds nothing to the trail', async ({ page }) => {
        await commitButton(page).click();
        await reader(page).getByRole('link', { name: /Reports export to CSV/ }).click();
        await expect(title(page, 'PLAN.md')).toBeVisible();
        await reader(page).getByRole('link', { name: 'the notes', exact: true }).click();
        await expect(title(page, 'notes.md')).toBeVisible();
        await reader(page).getByRole('link', { name: 'deeper', exact: true }).click();
        await expect(title(page, 'deep.md')).toBeVisible();
        await expect(backButton(page, 'notes.md')).toBeVisible();
        // Follow a link to the place already shown (deep.md itself)
        await reader(page).getByRole('link', { name: 'the deep page', exact: true }).click();
        await expect(title(page, 'deep.md')).toBeVisible();
        // Nothing added to trail: Back still says notes.md, and one Escape goes to notes.md
        await expect(backButton(page, 'notes.md')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(title(page, 'notes.md')).toBeVisible();
      });

      test('] from a followed picture (not a card) goes to the card after the origin and starts a new trail', async ({ page }) => {
        await openCommitAndPicture(page);
        await expect(anyBack(page)).toBeVisible();
        // The followed picture is not a card: the counter stays on the origin card ("2 / 3") and Next points to the card after it ("Second commit")
        const navigation = reader(page).getByRole('group', { name: 'Item navigation' });
        await expect(navigation.getByText('2 / 3')).toBeVisible();
        const next = navigation.getByRole('button', { name: 'Next: Second commit (] or Alt+→)', exact: true });
        await expect(next).toBeEnabled();
        await page.keyboard.press(']');
        await expect(title(page, 'Second commit')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);
        await expect(navigation.getByText('3 / 3')).toBeVisible();
        // one Escape closes the reader now
        await page.keyboard.press('Escape');
        await expect(reader(page)).toHaveCount(0);
      });

      test('following a file that is a registered card keeps counter, origin lit, and next on origin card', async ({ page }) => {
        await commitButton(page).click();
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
        // Follow link to Other picture, which IS a registered card in this area (card 1)
        await reader(page).getByRole('link', { name: 'Other picture', exact: true }).click();
        await expect(title(page, 'Other picture')).toBeVisible();
        await expect(backButton(page, SHORT)).toBeVisible();
        // Position and next/previous stay on origin card ("2 / 3"), origin card stays lit
        const navigation = reader(page).getByRole('group', { name: 'Item navigation' });
        await expect(navigation.getByText('2 / 3')).toBeVisible();
        await expect(commitCard(page).locator('article')).toHaveAttribute('aria-current', 'true');
        const next = navigation.getByRole('button', { name: 'Next: Second commit (] or Alt+→)', exact: true });
        await expect(next).toBeEnabled();
        // Pressing ] moves to the card after origin (Second commit) and starts a clean trail
        await page.keyboard.press(']');
        await expect(title(page, 'Second commit')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);
        await expect(navigation.getByText('3 / 3')).toBeVisible();
      });

      test('Back from a commit scrolled to the top restores 0 and wins over mount scrollIntoView', async ({ page }) => {
        await commitButton(page).click();
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
        await reader(page).getByRole('button', { name: /src\/export\.ts/ }).click();
        await expect(reader(page).getByRole('button', { name: /src\/export\.ts/ })).toHaveAttribute('aria-expanded', 'true');

        // Scroll the commit down, then back to the top
        await scroller(page).evaluate((el) => {
          el.scrollTop = 160;
          el.dispatchEvent(new Event('scroll'));
          el.scrollTop = 0;
          el.dispatchEvent(new Event('scroll'));
        });
        await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBe(0);

        // Follow link to picture
        // A real click would scroll the link into view first, and then that is the place to come back to, so press it where it is
        await reader(page).getByRole('link', { name: 'export.png', exact: true }).evaluate((el: HTMLElement) => el.click());
        await expect(title(page, 'export.png')).toBeVisible();

        // Step back to the commit
        await backButton(page, SHORT).click();
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
        await expect(reader(page).getByRole('button', { name: /src\/export\.ts/ })).toHaveAttribute('aria-expanded', 'true');
        // A saved 0 must restore 0 and win over the mount scrollIntoView
        await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBe(0);
      });

      test('with a reader open on active Board, Alt+Left with no trail and no previous card stays in the app and prevents default', async ({ page }) => {
        // Open Other picture, which is card 1 of 3 (it has no previous card)
        const otherCard = board(page).locator('#board-area').getByRole('article', { name: 'Other picture' });
        await otherCard.getByRole('button', { name: 'Open Other picture', exact: true }).click();
        await expect(title(page, 'Other picture')).toBeVisible();
        await expect(anyBack(page)).toHaveCount(0);
        // Track whether default was prevented
        await page.evaluate(() => {
          (window as unknown as { lastAltLeftPrevented?: boolean }).lastAltLeftPrevented = false;
          window.addEventListener('keydown', (e) => {
            if (e.altKey && e.key === 'ArrowLeft') {
              (window as unknown as { lastAltLeftPrevented?: boolean }).lastAltLeftPrevented = e.defaultPrevented;
            }
          });
        });
        await page.keyboard.press('Alt+ArrowLeft');
        // Alt+Left always stays in the app: preventDefault is called and does nothing
        const prevented = await page.evaluate(() => (window as unknown as { lastAltLeftPrevented?: boolean }).lastAltLeftPrevented);
        expect(prevented).toBe(true);
        await expect(title(page, 'Other picture')).toBeVisible();
        await expect(page).toHaveURL(/#\/workspaces\/demo\/board$/);
      });

      test('hidden reader does not take Alt+Left, [ or ] when Board section is inactive', async ({ page }) => {
        await openCommitAndPicture(page);
        await expect(backButton(page, SHORT)).toBeVisible();

        // Navigate away to another section
        const nav = page.getByRole('navigation', { name: 'Workspace' });
        await nav.getByRole('link', { name: 'Overview' }).click();
        await expect(board(page)).toBeHidden();

        // While hidden, press Alt+Left, [, ]
        await page.keyboard.press('Alt+ArrowLeft');
        await page.keyboard.press('[');
        await page.keyboard.press(']');

        // Navigate back to Board
        await nav.getByRole('link', { name: 'Board' }).click();
        await expect(board(page)).toBeVisible();

        // The reader is still on the picture with the trail intact
        await expect(title(page, 'export.png')).toBeVisible();
        await expect(backButton(page, SHORT)).toBeVisible();
      });

      test('reopening the same commit from the index starts a clean trail with no old open file or scroll', async ({ page }) => {
        // Open the index
        await page.getByRole('button', { name: /^Board index/ }).first().click();
        const readInReader = page.getByRole('button', { name: 'Read Write the CSV writer in reader', exact: true });
        await expect(readInReader).toBeVisible();

        // Open commit from the index
        await readInReader.click();
        await expect(title(page, 'Write the CSV writer')).toBeVisible();

        // Open a file, toggle side by side, and scroll down
        await reader(page).getByRole('button', { name: /src\/export\.ts/ }).click();
        const sideBySide = reader(page).getByRole('button', { name: 'Side by side', exact: true });
        await expect(sideBySide).toBeVisible();
        await sideBySide.click();
        await scroller(page).evaluate((el) => {
          el.scrollTop = 150;
          el.dispatchEvent(new Event('scroll'));
        });
        await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(100);

        // Close the reader
        await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
        await expect(reader(page)).toHaveCount(0);

        // Reopen the SAME commit from the index (which reuses the memoized target)
        const indexBtn = page.getByRole('button', { name: /^Board index/ }).first();
        if (!(await readInReader.isVisible())) {
          await indexBtn.click();
        }
        await expect(readInReader).toBeVisible();
        await readInReader.click();
        await expect(title(page, 'Write the CSV writer')).toBeVisible();

        // Newly opened trail starts clean: file is not expanded, scroll is 0, no Back button
        await expect(reader(page).getByRole('button', { name: /src\/export\.ts/ })).toHaveAttribute('aria-expanded', 'false');
        await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBe(0);
        await expect(anyBack(page)).toHaveCount(0);
      });

      test('full screen on the picture: Escape leaves full screen, then steps back, then closes', async ({ page }) => {
        await openCommitAndPicture(page);
        await reader(page).getByRole('button', { name: 'Full screen', exact: true }).click();
        const full = page.locator('[data-board-reader-fullscreen]');
        await expect(full).toBeVisible();
        await expect(full.getByRole('button', { name: `Back to ${SHORT}`, exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(full).toHaveCount(0);
        await expect(title(page, 'export.png')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(reader(page)).toHaveCount(0);
      });

      test('the Code window open keeps Escape and Alt+Left away from the reader', async ({ page }) => {
        await openCommitAndPicture(page);
        await page.evaluate(() => {
          const backdrop = document.createElement('div');
          backdrop.setAttribute('data-code-window-backdrop', '');
          backdrop.id = 'fake-code-window';
          const inner = document.createElement('div');
          inner.setAttribute('data-code-window', '');
          backdrop.append(inner);
          document.body.append(backdrop);
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Alt+ArrowLeft');
        await expect(title(page, 'export.png')).toBeVisible();
        await page.evaluate(() => document.getElementById('fake-code-window')?.remove());
        await page.keyboard.press('Alt+ArrowLeft');
        await expect(title(page, 'Write the CSV writer')).toBeVisible();
      });
    });
  }
}
