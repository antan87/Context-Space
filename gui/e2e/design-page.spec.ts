/**
 * DS7: the live design page at `#/design` (hidden: nothing links to it). Every piece of the design module and every kind of
 * Board card renders there, in its states, from fixture data, and the page writes nothing to the server.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { KNOWN_SMALL_TEXT } from './design-page-small-text';
import { smallTexts } from './readable';

test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

/** The pieces, by the heading each one has (`design-piece-<id>`). */
const PIECES: Array<[id: string, heading: string]> = [
  ['button', 'Button'], ['icon-button', 'IconButton'], ['badge', 'Badge and StatusBadge'], ['card-frame', 'CardFrame'], ['pill', 'Pill'], ['kind-label', 'KindLabel'], ['mark', 'Mark'],
  ['fresh-dot', 'FreshDot'], ['step-check', 'StepCheck'], ['row-surface', 'rowSurface and foldSurface'], ['needs-surface', 'needsSurface and chipClass'], ['composer', 'Composer'],
  ['input', 'Input, Textarea and Field'], ['choices', 'Checkbox, Switch, Radio and Select'], ['tabs', 'Tabs'], ['alert', 'Alert, Empty and Card'],
  ['small-things', 'Kbd, Separator, Skeleton, Spinner, ScrollArea and ContextRing'], ['overlays', 'Dialog, AlertDialog, Sheet, Menu, Popover and Tooltip'],
];

/** The card kinds the golden markup test knows, each with every card the page draws of it (the key `design-card-<key>`). */
const CARDS: Record<string, string[]> = {
  area: ['area.default', 'area.doneArea', 'area.planArea', 'area.long'],
  areaRow: ['areaRow.default', 'areaRow.long'],
  areaMini: ['areaMini.checkpointMini', 'areaMini.questionsMini', 'areaMini.newsMini', 'areaMini.filesMini', 'areaMini.long'],
  areaFold: ['areaFold.collapsed', 'areaFold.expanded'],
  checkpoint: ['checkpoint.open', 'checkpoint.folded', 'checkpoint.waitingFrame', 'checkpoint.planFrame'],
  lane: ['lane.open', 'lane.folded'],
  document: ['document.full', 'document.compact', 'document.compactReading', 'document.long'],
  commit: ['commit.full', 'commit.compact', 'commit.fullReading', 'commit.fullLong', 'commit.compactReading', 'commit.compactLong'],
  placeholder: ['placeholder.full', 'placeholder.compact'],
  uncommitted: ['uncommitted.default'],
  note: ['note.full', 'note.compact', 'note.archived', 'note.pinned', 'note.long', 'note.compactPinned', 'note.compactLong', 'note.compactArchived'],
  file: [
    'file.fullImage', 'file.fullDoc', 'file.compactPicture', 'file.compactDocumentRow', 'file.compactGeneric', 'file.fullArchived', 'file.fullReading',
    'file.fullLong', 'file.compactPinned', 'file.compactArchived', 'file.compactReading', 'file.compactLong',
  ],
  answer: ['answer.text', 'answer.codeMatches', 'answer.codeChanged', 'answer.picture', 'answer.pictureMissing', 'answer.diagram', 'answer.textLong', 'answer.textReading'],
  step: ['step.prominent', 'step.regular', 'step.staticDone', 'step.tabbed'],
  fold: ['fold.default'],
  more: ['more.default'],
  pager: ['pager.default'],
};

/** The two POSTs the app's own shell makes on every page (the terminal's token, and its list of running terminals), not the page's: the fixtures' mock answers them. */
const SHELL_WRITES = ['POST /api/terminals/bootstrap', 'POST /api/terminals/running'];

/** What the page may ask the server for: nothing of its own (its pictures are drawn in the page). Writes are refused, and none may be tried; any request for a workspace file is recorded. */
async function guard(page: Page) {
  const writes: string[] = [];
  const reads: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${String(error).slice(0, 200)}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 200)}`); });
  await page.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      const write = `${request.method()} ${url.pathname}`;
      if (SHELL_WRITES.includes(write)) return route.fallback();
      writes.push(write);
      return route.abort('blockedbyclient');
    }
    if (url.pathname.includes('/documents/file') || url.pathname.startsWith('/api/workspace/ws-snap/')) reads.push(url.pathname);
    return route.fallback();
  });
  return { writes, reads, errors };
}

async function open(page: Page) {
  const seen = await guard(page);
  await page.clock.setFixedTime(new Date('2026-11-17T12:00:00.000Z'));
  await page.goto('/#/design');
  await expect(page.getByTestId('design-page')).toBeVisible();
  // The pictures of the fixture cards are in: nothing is half loaded when the page is read.
  await page.waitForLoadState('networkidle');
  // Read the page in one state: the diagram is drawn (an image with a size), every card node is initialised (visible), the fonts are in.
  await expect.poll(() => page.getByTestId('design-card-answer.diagram').locator('img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0).catch(() => false), { message: 'the diagram is drawn' }).toBe(true);
  await expect.poll(() => page.locator('[data-testid^="design-card-"] .react-flow__node').evaluateAll((nodes) => nodes.length > 0 && nodes.every((node) => getComputedStyle(node).visibility !== 'hidden' && node.children.length > 0)), { message: 'every card node is initialised' }).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  return seen;
}

test.describe('DS7: the design page', () => {
  test('every piece draws, under its own heading', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Design page' })).toBeVisible();
    for (const [id, heading] of PIECES) {
      const piece = page.getByTestId(`design-piece-${id}`);
      await expect(piece, `piece ${id}`).toBeVisible();
      await expect(piece.getByRole('heading', { level: 3, name: heading, exact: true }), `heading of ${id}`).toBeVisible();
    }
    await expect(page.locator('[data-testid^="design-piece-"]:not([data-testid$="-title"])')).toHaveCount(PIECES.length);
  });

  test('every kind of Board card draws, in each state, at the Area zoom', async ({ page }) => {
    await open(page);
    for (const [kind, keys] of Object.entries(CARDS)) {
      const section = page.getByTestId(`design-kind-${kind}`);
      await expect(section.getByRole('heading', { level: 3, name: kind, exact: true }), `heading of ${kind}`).toBeVisible();
      await expect(section.locator('[data-testid^="design-card-"]'), `cards of ${kind}`).toHaveCount(keys.length);
      for (const key of keys) {
        const card = page.getByTestId(`design-card-${key}`);
        await expect(card, key).toBeVisible();
        // A real card, not an empty box: its own article or button, drawn inside a node, in a canvas at 0.9.
        await expect(card.locator('.react-flow__node').locator('xpath=./*').first(), `${key} has content`).toBeVisible();
        expect(await card.locator('.react-flow__viewport').evaluate((viewport) => new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a), `${key} zoom`).toBeCloseTo(0.9, 5);
      }
    }
    await expect(page.locator('[data-testid^="design-card-"]')).toHaveCount(Object.values(CARDS).flat().length);
    await expect(page.locator('[data-testid^="design-kind-"]:not([data-testid$="-title"])')).toHaveCount(Object.keys(CARDS).length);
  });

  test('the states show as words and marks: fresh, pinned, archived, reading', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('design-card-note.archived').locator('article')).toHaveCSS('border-top-style', 'dashed');
    await expect(page.getByTestId('design-card-file.fullReading').locator('article')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('design-card-commit.fullReading').locator('[aria-current="true"]')).toHaveCount(1);
    await expect(page.getByTestId('design-card-note.full').locator('.board-fresh')).toHaveCount(1);
    await expect(page.getByTestId('design-card-note.pinned').locator('.board-fresh')).toHaveCount(0);
  });

  test('the full commit card\'s header never overlaps: icon, sha, dot, author, time and note marker stay apart and inside the card', async ({ page }) => {
    await open(page);
    // The busiest header a commit card can have: a long author, "45 min ago" and "2 notes" (set here, so the page's own texts stay as they are).
    const card = page.getByTestId('design-card-commit.full');
    await card.locator('article > div.h-4 > div > span.truncate').evaluate((el) => { el.textContent = 'a-very-long-author-name@example.com'; });
    await card.locator('article > div.h-4 > div > time').evaluate((el) => { el.textContent = '45 min ago'; });
    await card.getByTestId('commit-note-marker').evaluate((el) => { el.lastChild!.textContent = '2 notes'; });
    await expect(card.getByTestId('commit-note-marker')).toContainText('2 notes');
    for (const key of ['commit.full']) {
      const boxes = await card.locator('article > div.h-4 > div > *, article > div.h-4 > :not(div)').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { name: (el.textContent || el.tagName).trim().slice(0, 20), left: r.left, right: r.right, width: r.width };
      }).filter((box) => box.width > 2).sort((a, b) => a.left - b.left));
      const article = await card.locator('article').evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
      expect(boxes.length, `${key} header children`).toBeGreaterThanOrEqual(4);
      boxes.forEach((box, i) => {
        expect(box.left, `${key}: ${box.name} inside the card`).toBeGreaterThanOrEqual(article.left);
        expect(box.right, `${key}: ${box.name} inside the card`).toBeLessThanOrEqual(article.right + 0.5);
        if (i > 0) expect(box.left, `${key}: ${boxes[i - 1]!.name} overlaps ${box.name}`).toBeGreaterThanOrEqual(boxes[i - 1]!.right - 0.5);
      });
    }
  });

  test('the page shows no error and makes no request that writes', async ({ page }) => {
    const seen = await open(page);
    // Presses on cards and pieces do nothing on the server: a card, its edit button, a menu, a dialog.
    await page.getByTestId('design-card-note.full').locator('article').click();
    await page.getByTestId('design-card-commit.full').locator('article').click();
    await page.getByTestId('design-card-note.full').getByRole('button', { name: /^Edit / }).click();
    await page.keyboard.press('Escape');
    await page.getByTestId('design-piece-overlays').getByRole('button', { name: 'Open dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'A dialog' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(seen.errors, `errors: ${seen.errors.join(' | ')}`).toEqual([]);
    expect(seen.writes, `writes tried: ${seen.writes.join(', ')}`).toEqual([]);
    // Nothing is asked of the workspace, pictures included: they are drawn from the page's own image.
    expect(seen.reads, 'requests for a workspace file').toEqual([]);
    for (const key of ['file.fullImage', 'file.compactPicture', 'answer.picture']) {
      const loaded = await page.getByTestId(`design-card-${key}`).locator('img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
      expect(loaded, `${key} shows a picture`).toBe(true);
    }
    expect(new URL(page.url()).hash).toBe('#/design');
    // No alert on the page but the Alert piece's own samples.
    expect(await page.locator('[role="alert"]').evaluateAll((all) => all.filter((el) => !el.closest('[data-testid="design-piece-alert"]')).length), 'alerts outside the Alert piece').toBe(0);
  });

  test('every control that could write does nothing on the server: the add-step form, answers, checks, steps, the note editor, and links', async ({ page }) => {
    const seen = await open(page);
    page.setDefaultTimeout(5000);
    const popups: string[] = [];
    page.on('popup', (popup) => popups.push(popup.url()));
    // The checkpoint card's own "Add step" form, on a checkpoint and on the plan's own frame: it submits, and closes as if it had worked
    for (const key of ['checkpoint.open', 'checkpoint.planFrame']) {
      const card = page.getByTestId(`design-card-${key}`);
      await card.locator('[data-testid^="checkpoint-add-step-trigger"]').click();
      const form = card.locator('[data-testid^="checkpoint-add-step-form"]');
      await form.locator('input').fill('A step that must not be saved');
      await form.locator('input').press('Enter');
      await expect(form, `${key}: the form closes after its submit`).toHaveCount(0);
    }
    // Answering a decision (a suggested answer, and a typed one), running the check, ticking a step
    const checkpoint = page.getByTestId('design-card-checkpoint.open');
    await checkpoint.getByRole('button', { name: 'Precision' }).click();
    await checkpoint.getByPlaceholder('Your answer').fill('Something else');
    await checkpoint.getByRole('button', { name: 'Answer', exact: true }).click();
    await checkpoint.getByRole('button', { name: /Run check/ }).click();
    await checkpoint.locator('[data-testid^="checkpoint-step-checkbox-"]').first().click();
    await page.getByTestId('design-card-step.regular').locator('[data-testid^="step-checkbox-"]').first().click();
    // The note editor: change the title and save
    const note = page.getByTestId('design-card-note.full');
    await note.getByRole('button', { name: /^Edit / }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Note title...').fill('Changed on the design page');
    await dialog.getByRole('button', { name: /^(Save|Add note)/ }).click();
    // Ask in CLI and the external link of a document
    await page.getByTestId('design-card-file.fullImage').getByRole('button', { name: /Ask in CLI/ }).first().click();
    await page.getByTestId('design-card-document.compact').getByRole('link').first().click();
    await page.waitForTimeout(500);
    expect(popups, 'no other tab opened').toEqual([]);
    expect(new URL(page.url()).hash).toBe('#/design');
    expect(seen.writes, `writes tried: ${seen.writes.join(', ')}`).toEqual([]);
    expect(seen.errors, `errors: ${seen.errors.join(' | ')}`).toEqual([]);
  });

  test('nothing links to the design page', async ({ page }) => {
    await guard(page);
    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { name: 'Settings' }).first()).toBeVisible();
    expect(await page.locator('a[href*="design"]').count()).toBe(0);
    await expect(page.getByText('Design page')).toHaveCount(0);
  });

  test('the readable check finds no text under 12 px that today\'s look does not already have', async ({ page }) => {
    await open(page);
    // Line breaks inside a code text are one space in the list, so each entry is one line.
    const found = [...new Set((await smallTexts(page.getByTestId('design-page'))).map((text) => text.replace(/\s+/g, ' ')))].sort();
    const known = [...KNOWN_SMALL_TEXT].sort();
    const added = found.filter((text) => !known.includes(text));
    const gone = known.filter((text) => !found.includes(text));
    expect(added, `new text under 12 px (fix it, the list may only shrink):\n${added.join('\n')}`).toEqual([]);
    expect(gone, `no longer drawn, remove from design-page-small-text.ts:\n${gone.join('\n')}`).toEqual([]);
  });

  test('dark mode draws the same page', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const seen = await open(page);
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByTestId('design-card-note.full')).toBeVisible();
    expect(seen.errors).toEqual([]);
  });
});
