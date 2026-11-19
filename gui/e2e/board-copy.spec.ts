import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  board,
  minutesAgo,
  nodesAtRest,
  PICTURE,
  routeBoard,
  routeCards,
  routeWorkspaceDocumentReferences,
  stepIntoArea,
  transformOf,
  viewAtRest,
  workspace,
} from './boardHelpers';
import { boardFile, boardFileCard, boardId, boardNote } from './planData';

test.use({
  workspacesData: [[workspace], { option: true }],
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});

const MODIFIED = '2026-10-22T00:00:00.000Z';
const SVG_PIC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><rect width="120" height="60" fill="#2563eb"/><circle cx="60" cy="30" r="18" fill="#ffffff"/></svg>';
const MERMAID_SOURCE = 'flowchart LR\naccTitle: Copy diagram flow\nA[Input] --> B[Output]';
const COPY_SHORTCUT = process.platform === 'darwin' ? 'Meta+c' : 'Control+c';

const FILES: Record<string, { kind: string; content?: string }> = {
  'docs/spec.md': {
    kind: 'markdown',
    content: '# The CSV spec\n\nOne row per line in UTF-8 format.\n\nKeep commas quoted cleanly.',
  },
  'docs/arch.md': {
    kind: 'markdown',
    content: `# System flow\n\n\`\`\`mermaid\n${MERMAID_SOURCE}\n\`\`\``,
  },
  'board-pictures/overview.png': { kind: 'image' },
  'board-pictures/wide.svg': { kind: 'image' },
};

const reader = (page: Page) => board(page).getByRole('region', { name: 'Reader', exact: true });
const card = (page: Page, title: string) => board(page).getByRole('article', { name: title, exact: true });

async function routeCopyBoard(page: Page, layout: 'side' | 'default' = 'side') {
  await page.addInitScript((chosenLayout) => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
    window.localStorage.setItem('contextspace_board_reader_layout_v1', chosenLayout);
  }, layout);
  await routeBoard(page);
  await routeWorkspaceDocumentReferences(page, () => Object.keys(FILES), workspace.workspacePath);
  await page.route('**/api/workspace/demo/documents/preview?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    const file = FILES[name];
    return file
      ? route.fulfill({ json: { name, size: 120, modifiedAt: MODIFIED, ...file } })
      : route.fulfill({ status: 404, json: { error: 'No such document.' } });
  });
  await page.route('**/api/workspace/demo/documents/file**', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (name.endsWith('.svg')) {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG_PIC });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE });
  });
  await page.route('**/api/workspace/demo/documents', (route) =>
    route.fulfill({
      json: {
        documents: Object.entries(FILES).map(([name, file]) => ({
          name,
          kind: file.kind,
          size: 120,
          modifiedAt: MODIFIED,
        })),
      },
    }),
  );

  const cards = [
    boardNote(1, {
      title: 'Retry disk save cleanly',
      body: 'Check **disk full** handling cleanly.',
      at: minutesAgo(10),
      updatedAt: minutesAgo(10),
    }),
    boardFileCard(2, 'docs/spec.md', {
      title: 'CSV format specification',
      description: 'One row per record in export.',
      at: minutesAgo(11),
      updatedAt: minutesAgo(11),
    }),
    boardFileCard(3, 'board-pictures/overview.png', {
      title: 'Overview PNG',
      description: 'Raster screenshot.',
      at: minutesAgo(12),
      updatedAt: minutesAgo(12),
    }),
    boardFileCard(4, 'board-pictures/wide.svg', {
      title: 'Wide vector SVG',
      description: 'Vector diagram.',
      at: minutesAgo(13),
      updatedAt: minutesAgo(13),
    }),
    boardFileCard(5, 'docs/arch.md', {
      title: 'Architecture diagram',
      description: 'Mermaid diagram doc.',
      at: minutesAgo(14),
      updatedAt: minutesAgo(14),
    }),
    boardNote(6, {
      title: 'Flow in a note',
      body: `Where it goes.\n\n\`\`\`mermaid\n${MERMAID_SOURCE}\n\`\`\``,
      at: minutesAgo(15),
      updatedAt: minutesAgo(15),
    }),
  ];

  const positions = {
    [boardId(1)]: { x: 640, y: 240 },
    [boardId(2)]: { x: 930, y: 240 },
    [boardId(3)]: { x: 640, y: 450 },
    [boardId(4)]: { x: 930, y: 450 },
    [boardId(5)]: { x: 1220, y: 240 },
    [boardId(6)]: { x: 1220, y: 450 },
  };
  await routeCards(page, boardFile({ cards, positions }));
}

async function dragSelectLocatorText(page: Page, target: Locator): Promise<string> {
  const span = await target.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    while (walker.nextNode()) {
      const candidate = walker.currentNode as Text;
      if (!candidate.textContent || !candidate.textContent.trim().length) continue;
      const range = document.createRange();
      range.selectNodeContents(candidate);
      for (const rect of range.getClientRects()) {
        if (rect.width > 1 && rect.height > 1) rects.push(rect);
      }
    }
    if (rects.length === 0) return null;
    const first = rects[0];
    const last = rects[rects.length - 1];
    return {
      startX: first.left + 2,
      startY: first.top + first.height / 2,
      endX: last.right - 2,
      endY: last.top + last.height / 2,
    };
  });
  if (!span) throw new Error('Target has no visible text rect to select');
  await page.mouse.move(span.startX, span.startY);
  await page.mouse.down();
  await page.mouse.move(span.endX, span.endY, { steps: 10 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

async function readClipboardPngSize(page: Page): Promise<{ width: number; height: number } | null> {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('image/png')) {
        const blob = await item.getType('image/png');
        const bitmap = await createImageBitmap(blob);
        const dims = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return dims;
      }
    }
    return null;
  });
}

test('drag-selecting card and row text selects and Ctrl+C copies while single clicks still open', async ({ page }) => {
  await routeCopyBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);

  // Overview card text can be drag-selected without panning away and copied with Ctrl+C
  const beforePan = await transformOf(page);
  const areaTitle = board(page)
    .locator('.board-overview-plane button.board-area')
    .filter({ hasText: 'Reports export to CSV' })
    .locator('span[title="Reports export to CSV"]');
  const selectedOverview = await dragSelectLocatorText(page, areaTitle);
  expect(selectedOverview).toContain('Reports export to CSV');
  expect(await transformOf(page)).toEqual(beforePan);
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toHaveCount(0);
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Reports export to CSV');

  await stepIntoArea(page, /Reports export to CSV/);

  // NoteCard title + body text drag-selection + Ctrl+C
  const note = card(page, 'Retry disk save cleanly');
  await expect(note).toBeVisible();
  const noteTitle = note.locator('h2');
  const selectedTitle = await dragSelectLocatorText(page, noteTitle);
  expect(selectedTitle.trim()).toContain('Retry disk save');
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Retry disk save');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const noteBody = note.locator('.board-text');
  const selectedBody = await dragSelectLocatorText(page, noteBody);
  expect(selectedBody).toContain('disk full');
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('disk full');

  // Pressable FileCard: drag-select selects without opening, single-click opens reader
  const fileCard = card(page, 'CSV format specification');
  const fileTitle = fileCard.locator('h2 span[title="CSV format specification"]');
  const selectedFileTitle = await dragSelectLocatorText(page, fileTitle);
  expect(selectedFileTitle).toContain('CSV format');
  await expect(reader(page)).toHaveCount(0);
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('CSV format');

  await fileCard.getByRole('button', { name: 'Open CSV format specification', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(reader(page)).toHaveCount(0);

  // Pressable Area step row: drag-select selects without opening step dialog, single-click opens dialog
  const stepTrigger = board(page).getByTestId('step-trigger-background-job-queue-for-large-exports');
  const stepText = stepTrigger.locator('span[title="Background job queue for large exports"]');
  const selectedStep = await dragSelectLocatorText(page, stepText);
  expect(selectedStep).toContain('Background job queue');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Background job queue');

  await stepTrigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Copy text in a card … menu copies the title and body as Markdown', async ({ page }) => {
  await routeCopyBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);

  const note = card(page, 'Retry disk save cleanly');
  await note.hover();
  await note.getByRole('button', { name: 'Actions for Retry disk save cleanly', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy text', exact: true }).click();

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('# Retry disk save cleanly\n\nCheck **disk full** handling cleanly.');
});

test('Copy picture works in the reader and fullscreen lightbox for raster PNG and 2x SVG, and falls back cleanly', async ({ page }) => {
  await routeCopyBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);

  // 1. Raster picture in reader and maximized lightbox
  await card(page, 'Overview PNG').getByRole('button', { name: 'Open Overview PNG', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  const copyPicBtn = reader(page).getByRole('button', { name: 'Copy picture', exact: true });
  await expect(copyPicBtn).toBeVisible();
  const box = await copyPicBtn.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);

  await copyPicBtn.click();
  await expect(reader(page).getByRole('status')).toHaveText('Copied');
  await expect.poll(() => readClipboardPngSize(page)).toEqual({ width: 1, height: 1 });

  // Open fullscreen lightbox (maximized reader)
  await reader(page).getByRole('button', { name: 'Full screen', exact: true }).click();
  const lightboxCopyBtn = reader(page).getByRole('button', { name: 'Copy picture', exact: true });
  await expect(lightboxCopyBtn).toBeVisible();
  await lightboxCopyBtn.click();
  await expect(reader(page).getByRole('status')).toHaveText(/^Copied\u00A0?$/);
  await expect.poll(() => readClipboardPngSize(page)).toEqual({ width: 1, height: 1 });
  await reader(page).getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await reader(page).getByRole('button', { name: 'Close', exact: true }).click();

  // 2. SVG picture rasterised to PNG at 2x
  await card(page, 'Wide vector SVG').getByRole('button', { name: 'Open Wide vector SVG', exact: true }).click();
  await expect(reader(page).getByRole('img')).toBeVisible();
  await reader(page).getByRole('button', { name: 'Copy picture', exact: true }).click();
  await expect(reader(page).getByRole('status')).toHaveText('Copied');
  await expect.poll(() => readClipboardPngSize(page)).toEqual({ width: 240, height: 120 });
});

test('Copy picture falls back to copying the path when ClipboardItem write is disallowed', async ({ page }) => {
  await page.addInitScript(() => {
    const writes: string[] = [];
    (window as unknown as { __copiedTexts: string[] }).__copiedTexts = writes;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async () => {
          throw new DOMException('Blocked by policy', 'NotAllowedError');
        },
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    });
  });

  await routeCopyBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);

  await card(page, 'Overview PNG').getByRole('button', { name: 'Open Overview PNG', exact: true }).click();
  await reader(page).getByRole('button', { name: 'Copy picture', exact: true }).click();
  await expect(reader(page).getByRole('status')).toHaveText('Copied path (image copy unavailable)');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copiedTexts: string[] }).__copiedTexts))
    .toEqual(['board-pictures/overview.png']);
});

test('Copy picture on a drawn Mermaid diagram copies a 2x PNG', async ({ page }) => {
  await routeCopyBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);

  await card(page, 'Architecture diagram').getByRole('button', { name: 'Open Architecture diagram', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  const diagramImg = reader(page).getByRole('img', { name: 'Copy diagram flow' });
  await expect(diagramImg).toBeVisible();
  const naturalDims = await diagramImg.evaluate((el) => {
    const img = el as HTMLImageElement;
    return { width: img.naturalWidth, height: img.naturalHeight };
  });
  expect(naturalDims.width).toBeGreaterThan(0);

  const diagramCopyBtn = reader(page).getByRole('button', { name: 'Copy picture', exact: true });
  await expect(diagramCopyBtn).toBeVisible();
  await diagramCopyBtn.click();
  await expect(reader(page).getByRole('status').filter({ hasText: 'Copied' })).toHaveText('Copied');
  await expect
    .poll(() => readClipboardPngSize(page))
    .toEqual({ width: naturalDims.width * 2, height: naturalDims.height * 2 });
});

test('Ctrl+C while the reader is open copies reader and board text cleanly', async ({ page }) => {
  await routeCopyBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);

  await card(page, 'CSV format specification').getByRole('button', { name: 'Open CSV format specification', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  const readerParagraph = reader(page).getByText('One row per line in UTF-8 format.');
  const selectedReader = await dragSelectLocatorText(page, readerParagraph);
  expect(selectedReader).toContain('One row per line');
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('One row per line');
  await expect(reader(page)).toBeVisible();

  // Select text on a Board card beside the open reader and Ctrl+C
  const noteTitle = card(page, 'Retry disk save cleanly').locator('h2');
  const selectedCard = await dragSelectLocatorText(page, noteTitle);
  expect(selectedCard).toContain('Retry disk save');
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Retry disk save');
  await expect(reader(page)).toBeVisible();
});

test('keyboard activation, cross-edge drag-select, note selection without thread dimming, and commit subject click work after selecting text', async ({ page }) => {
  await routeCopyBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);

  // 1. Drag-selecting NoteCard body text does not activate thread dimming (data-thread-active)
  const note = card(page, 'Retry disk save cleanly');
  const areaFlow = board(page).locator('#board-area .board-flow');
  const selectedNoteBody = await dragSelectLocatorText(page, note.locator('.board-text'));
  expect(selectedNoteBody).toContain('disk full');
  await expect(areaFlow).not.toHaveAttribute('data-thread-active', 'true');

  // 2. Cross-edge drag-select starting inside FileCard title and ending past button edge does not open Reader
  const fileCard = card(page, 'CSV format specification');
  const fileBtn = fileCard.getByRole('button', { name: 'Open CSV format specification', exact: true });
  const fileTitleBox = await fileCard.locator('h2 span[title="CSV format specification"]').boundingBox();
  const cardBox = await fileCard.boundingBox();
  expect(fileTitleBox && cardBox).toBeTruthy();
  await page.mouse.move(fileTitleBox!.x + 4, fileTitleBox!.y + fileTitleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox!.x + cardBox!.width - 6, fileTitleBox!.y + fileTitleBox!.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(reader(page)).toHaveCount(0);

  // 3. Keyboard Enter still opens FileCard and StepDetailDialog while text inside is selected
  const selectedFile = await dragSelectLocatorText(page, fileCard.locator('h2 span[title="CSV format specification"]'));
  expect(selectedFile).toContain('CSV format');
  await fileBtn.focus();
  await page.keyboard.press('Enter');
  await expect(reader(page)).toBeVisible();
  await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(reader(page)).toHaveCount(0);

  const stepTrigger = board(page).getByTestId('step-trigger-background-job-queue-for-large-exports');
  const selectedStep = await dragSelectLocatorText(page, stepTrigger.locator('span[title="Background job queue for large exports"]'));
  expect(selectedStep).toContain('Background job queue');
  await stepTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 4. Commit subject drag-select copies without opening Review, and subsequent single-click opens Review
  const commitsRowToggle = board(page).locator('button[data-row-control^="lane:commits"]');
  if (await commitsRowToggle.isVisible() && (await commitsRowToggle.getAttribute('aria-expanded')) === 'false') {
    await commitsRowToggle.click();
  }
  await nodesAtRest(page);
  const commitBtn = board(page).locator('#board-area .react-flow__node-commit').getByRole('button', { name: 'Open Write the CSV writer', exact: true });
  await expect(commitBtn).toBeVisible();
  const selectedCommit = await dragSelectLocatorText(page, commitBtn.locator('span'));
  expect(selectedCommit).toContain('Write the CSV writer');
  await expect(page.getByRole('region', { name: 'Review', exact: true })).toHaveCount(0);
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Write the CSV writer');

  await commitBtn.click();
  await expect(page.getByRole('region', { name: 'Review', exact: true })).toBeVisible();
});

test('a drag over Overview preview text that is not in a button selects it and does not pan the board', async ({ page }) => {
  // The plain demo board: its hero Area has no pictures, so it shows the preview line, which is text outside every button
  await routeBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await viewAtRest(page);
  const before = await transformOf(page);
  const text = board(page).locator('.board-overview-plane .react-flow__node span.select-text:not(button span)').first();
  await expect(text).toBeVisible();
  expect(await text.evaluate((el) => el.closest('button, a'))).toBeNull();
  const selected = await dragSelectLocatorText(page, text);
  expect(selected.trim().length).toBeGreaterThan(3);
  expect(await transformOf(page)).toEqual(before);
  await expect(board(page).getByRole('button', { name: 'Board ›' })).toHaveCount(0);
  await page.keyboard.press(COPY_SHORTCUT);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(selected.trim().slice(0, 8));
});

test('a picture copy still rendering when the Reader closes writes nothing and does not touch a newer copy', async ({ page }) => {
  await routeCopyBoard(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback, ...rest: unknown[]) {
      const delay = (window as unknown as { __blobDelay?: number }).__blobDelay ?? 0;
      setTimeout(() => (original as (...args: unknown[]) => void).call(this, callback, ...rest), delay);
    } as typeof original;
  });
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);
  await card(page, 'Wide vector SVG').getByRole('button', { name: 'Open Wide vector SVG', exact: true }).click();
  await expect(reader(page)).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __blobDelay: number }).__blobDelay = 1500; });
  await reader(page).getByRole('button', { name: 'Copy picture', exact: true }).click();
  await reader(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(reader(page)).toHaveCount(0);
  await page.evaluate(() => navigator.clipboard.writeText('a newer copy'));
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('a newer copy');
  expect(await readClipboardPngSize(page).catch(() => null)).toBeNull();
});

test('Copy picture and Source on a Mermaid diagram inside a note are at least 24 px and 12 px at the Board zoom of 0.9', async ({ page }) => {
  await routeCopyBoard(page);
  await page.goto('/#/workspaces/demo/board');
  await stepIntoArea(page, /Reports export to CSV/);
  const note = card(page, 'Flow in a note');
  await expect(note).toBeVisible();
  for (const name of ['Copy picture', 'Source']) {
    const button = note.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const m = await button.evaluate((el) => ({ height: (el as HTMLElement).offsetHeight, font: parseFloat(getComputedStyle(el).fontSize) }));
    expect(m.height * 0.9, `${name} height at 0.9 zoom`).toBeGreaterThanOrEqual(24);
    expect(m.font * 0.9, `${name} font at 0.9 zoom`).toBeGreaterThanOrEqual(12);
  }
});
