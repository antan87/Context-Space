import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  boardFile,
  boardFileCard,
  boardId,
  boardLink,
  boardNote,
  } from "./planData";
import {
  workspace,
  minutesAgo,
  document,
  routeWork,
  routeBoard,
  routeCards,
  routeMoves,
  routePictures,
  board,
  stepIntoArea,
  revealAll,
} from "./boardHelpers";

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
  // A large window: these specs put several cards, and often a document and a commit too, on screen at once, which a laptop-sized
  // canvas shows as folded rows and "+N more" (specs for that are under "Board, rows by step").
  test.use({ viewport: { width: 1800, height: 1200 } });

    test.use({ colorScheme });

    async function expectNoSeriousViolations(page: Page, scope: string) {
      // Settled colours only: a transition caught half-way reports a contrast no one sees.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      const results = await new AxeBuilder({ page }).include(scope).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} ${node.html.slice(0, 100)}`).join(' | ')}`);
      expect(serious, serious.join('\n')).toEqual([]);
    }

    test('has no serious accessibility violations, with every kind of card on screen', async ({ page }) => {
      await routeBoard(page);
      await routePictures(page);
      await routeWork(page, [
        document('Export requirements', { role: 'requirements', summary: 'Customers export their reports as CSV, up to 50,000 rows.' }),
        document('Draft notes', { role: 'reference', status: 'draft', summary: 'Rough notes.' }),
        document('First export design', { status: 'superseded', summary: 'Replaced by the queue design.' }),
      ]);
      await routeMoves(page, boardFile({
        cards: [
          boardNote(1, { title: 'Export leaks memory', body: Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of what was seen in the CSV writer.`).join('\n'), updatedAt: minutesAgo(0) }),
          boardNote(2, { title: 'Ask finance about time zones', body: 'Before we ship.', pinned: true, by: 'user', updatedBy: 'user' }),
          boardNote(3, { title: 'An idea we dropped', body: 'It was too slow.', archived: true }),
          boardFileCard(4, 'docs/export flow.png', { title: 'Export flow', description: 'How a report becomes a CSV file.', pinned: true }),
          boardFileCard(5, 'docs/overview.html', { title: 'Overview page', description: 'Start with the diagram.', by: 'codex', updatedBy: 'codex' }),
          boardFileCard(6, 'docs/spec.pdf', { title: 'The spec', description: 'What was agreed.', archived: true }),
          boardFileCard(7, 'docs/flow.png', { title: 'flow.png', description: 'The same flow, drawn smaller.' }),
        ],
        links: [boardLink(1, boardId(1), 'checkpoint:reports-export-to-csv', 'found while'), boardLink(2, boardId(4), 'commit:billing api:a91f2e0'), boardLink(3, boardId(2), `document:${boardId(99)}`)],
        positions: { [boardId(2)]: { x: 1060, y: 330 } },
      }));
      await page.goto('/#/workspaces/demo/board');
      await expect(board(page).locator('.board-overview-plane button.board-area').filter({ hasText: 'Reports export to CSV' })).toBeVisible();
      // Level 0 Overview accessibility
      await expectNoSeriousViolations(page, '[aria-label="Board"]');

      // Step into area for Level 1 accessibility
      await stepIntoArea(page);
      const canvas = board(page);
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
      await revealAll(page);
      await expect(canvas.getByRole('article', { name: 'Export flow' }).getByRole('img', { name: 'Export flow' })).toBeAttached();
      await expect(canvas.getByRole('button', { name: 'Read Export leaks memory' })).toBeVisible();
      await expect(canvas.locator('#board-area .react-flow__edge')).toHaveCount(2);
      await expectNoSeriousViolations(page, '[aria-label="Board"]');

      await canvas.locator('#board-area').getByRole('button', { name: 'Archived (2)' }).click();
      await expect(canvas.getByRole('article', { name: 'The spec' })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');

      // The whole text of a card, in its dialog.
      await canvas.locator('#board-area').getByRole('button', { name: 'Read Export leaks memory' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Export leaks memory' })).toBeVisible();
      await expectNoSeriousViolations(page, '[role="dialog"]');
    });

    /** The board with links in its cards and a source document to open: the reader docked beside the canvas when `docked`, else in its large window. */
    async function checkReader(page: Page, docked: boolean) {
      if (docked) await page.addInitScript(() => window.localStorage.setItem('contextspace_board_reader_layout_v1', 'side'));
      await routeBoard(page);
      await routeWork(page, [
        document('Export requirements', { role: 'requirements', filename: 'contextspace-document-1.md', summary: 'Customers export their reports as CSV.' }),
        document('Pricing sheet', { url: 'https://example.com/pricing', summary: 'Kept on the web.' }),
      ]);
      await routeCards(page, boardFile({
        cards: [
          boardNote(1, { title: 'Links', body: 'Read [the CSV spec](https://example.com/spec), [the file](docs/spec.md) and `code`.\n\n- one\n- two' }),
          boardFileCard(2, 'docs/spec.md', { title: 'The CSV spec', description: 'See [the queue design](https://example.com/queue).' }),
        ],
        positions: { [boardId(1)]: { x: 800, y: 240 }, [boardId(2)]: { x: 1100, y: 240 } },
      }));
      // A source document is read through the work route.
      await page.route('**/api/workspace/demo/work/documents/*', (route) => route.fulfill({ json: {
        document: document('Export requirements', { filename: 'contextspace-document-1.md' }), location: '/tmp/demo/contextspace-document-1.md',
        content: '# Customers export reports\n\nUp to 50,000 rows as CSV. See [the design](docs/design.md) and [the web](https://example.com).\n\n| Column | Meaning |\n| --- | --- |\n| id | The row |\n',
      } }));
      await page.goto('/#/workspaces/demo/board');
      await stepIntoArea(page);
      const canvas = board(page);
      await expect(canvas.getByRole('article', { name: 'Links' }).getByRole('link', { name: 'the CSV spec' })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
      await canvas.getByRole('button', { name: 'Open Export requirements' }).click();
      const reader = canvas.getByRole('region', { name: 'Reader', exact: true });
      await expect(reader.getByRole('heading', { name: 'Customers export reports', level: 1 })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
      // The card that is open has its ring, and is still fine to read.
      await expect(canvas.getByRole('article', { name: 'Export requirements' })).toHaveAttribute('aria-current', 'true');
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
    }

    test('has no serious accessibility violations with links in the cards and the reader open in its large window', async ({ page }) => {
      await checkReader(page, false);
      const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
      await expect(reader.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
      await expect(reader.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
      await expectNoSeriousViolations(page, '[aria-label="Board"]');
    });

    test('has no serious accessibility violations with links in the cards and the reader open beside them', async ({ page }) => {
      await checkReader(page, true);
      const reader = board(page).getByRole('region', { name: 'Reader', exact: true });
      await expect(reader.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
    });
  });
}
