/**
 * FT1: the Board overview shows more of the work in Split, and it is readable.
 * A realistic workspace (a focus Area under way, one Area that waits for a decision, an answer Area with news, a dozen plain
 * Areas, archived cards) at the sizes the board is used at. Everything is faked and every write is refused.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { board, minutesAgo, PICTURE, viewAtRest, workspace } from './boardHelpers';
import { boardFile, boardFileCard, boardNote, checkpoint, decision, planFile, step, whatsNew } from './planData';

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1100, height: 700 } });

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const FOCUS = 'A Board tab shows the real work, whatever its size';
const WAITING = 'Plan this checkpoint with the team before the build starts';
const ANSWER_QUESTION = 'How does the Board learn about commits and files?';
const PLAIN = [
  'The Board is powerful enough to be where the work happens',
  'You can inspect any change: what changed and why',
  'Pictures, pages and decks the AI makes sit on the board',
  'Only what matters now is in front of you',
  'Code search lands on the board as a trail you can follow',
  'Never lose track in a long task',
  'ContextSpace looks calm and beautiful everywhere',
  'Pages open like a real browser',
  'A design system for ContextSpace, and many other things',
  'How AI models work with the board',
  'See other worktrees of the same project from a single place',
  'New ways of working, tested one at a time',
];

async function routeWorkspace(page: Page) {
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    return route.fulfill({ json: { available: true, sessions: [{ id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' }], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } });
  });
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/demo/documents/file**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: {
    guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] },
    lifecycle: null, assignment: '', sharedDocuments: [],
  } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile({
    title: 'A realistic plan',
    now: { key: slug('Write the first picture'), by: 'claude', at: minutesAgo(5) },
    checkpoints: [
      checkpoint(FOCUS, { steps: [step('Write the first picture'), step('Under CPU load the terminal spec is slow'), step('Leftovers from the third review'), step('Fourth step')] }),
      checkpoint(WAITING, { steps: [step('Order the rows')], decisions: [decision('Should Review get a keyboard shortcut?')] }),
      ...PLAIN.map((title, i) => checkpoint(title, { steps: [step(`Order, from the first to the last number ${i}`, false), step('Second step')] })),
    ],
  }) }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [
    { repo: 'billing api', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the first picture', at: minutesAgo(30) }] },
  ] }) }));
  const focusArea = `checkpoint:${slug(FOCUS)}`;
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile({ cards: [
    boardNote(1, { title: 'A note', area: focusArea }), boardNote(2, { title: 'Another note', area: focusArea }),
    boardFileCard(3, 'board-pictures/a.png', { title: 'Picture 1', area: focusArea }),
    boardFileCard(4, 'board-pictures/b.png', { title: 'Picture 2', area: focusArea }),
    boardNote(5, { title: 'Put away', archived: true, area: focusArea }),
  ] }) }));
  await page.route('**/api/workspace/demo/files', (route) => route.fulfill({ json: { files: ['how-does-the-board-learn', 'second'].map((name) => ({ path: `explain/${name}.md`, modifiedAt: minutesAgo(5), size: 900 })), truncated: false, errors: [] } }));
  const answer = (file: string, question: string) => ({
    path: `explain/${file}.md`, question, summary: 'It reads the plan and the commits.', modifiedAt: minutesAgo(5), area: `checkpoint:${slug(PLAIN[0]!)}`,
    parts: [{ title: 'In short', heading: null, cards: [{ kind: 'text', text: 'It reads the plan and the commits.' }] }],
  });
  await page.route('**/api/workspace/demo/questions', (route) => route.fulfill({ json: { answers: [answer('how-does-the-board-learn', ANSWER_QUESTION), answer('second', 'Who writes the plan?')] } }));
}

const split = async (page: Page) => page.addInitScript(() => {
  try { localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 })); } catch { /* no storage */ }
});

/** The Area cards drawn whole above the bottom of the board, by title, and the text under 12 px anywhere on the Board's overview, its index badge and its Archived button included (font size x zoom). */
async function facts(page: Page) {
  await viewAtRest(page);
  return board(page).evaluate((region) => {
    const box = region.getBoundingClientRect();
    const plane = region.querySelector('.board-overview-plane')!;
    const shown = [...plane.querySelectorAll<HTMLElement>('.react-flow__node-areaMini, .react-flow__node-areaRow')].filter((node) => {
      const r = node.getBoundingClientRect();
      return r.bottom <= box.bottom + 1 && r.top >= box.top && r.right <= box.right + 1;
    }).map((node) => (node.querySelector('button.board-area')?.getAttribute('aria-label') ?? '').split(',')[0]!);
    const small: string[] = [];
    const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const el = text.parentElement;
      if (!el || !text.textContent?.trim()) continue;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !r.width || !r.height || el.closest('.sr-only')) continue;
      if (r.bottom > box.bottom || r.top < box.top) continue;
      // offsetWidth rounds fractional font metrics; transforms give the actual drawn scale.
      let scale = 1;
      for (let ancestor: Element | null = el; ancestor; ancestor = ancestor.parentElement) {
        const transform = getComputedStyle(ancestor).transform;
        if (transform !== 'none') scale *= new DOMMatrixReadOnly(transform).a;
      }
      const px = parseFloat(style.fontSize) * scale;
      if (px < 11.95) small.push(`${px.toFixed(1)}px "${text.textContent.trim().slice(0, 24)}"`);
    }
    // A subtitle is drawn with about 12 characters before its ellipsis or not at all, and a bar only from 32 px
    const cut: string[] = [];
    for (const el of plane.querySelectorAll<HTMLElement>('[data-area-subtitle]')) {
      const text = el.querySelector<HTMLElement>('.truncate') ?? el;
      if (text.scrollWidth > text.clientWidth + 1 && text.clientWidth < 78) cut.push(`subtitle ${text.clientWidth}px "${text.textContent?.slice(0, 20)}"`);
    }
    for (const el of plane.querySelectorAll<HTMLElement>('[data-area-progress]')) if (el.getBoundingClientRect().width < 31.5) cut.push(`bar ${Math.round(el.getBoundingClientRect().width)}px`);
    return { shown, small, cut };
  });
}

test.describe('FT1: the overview in Split', () => {
  test.beforeEach(async ({ page }) => { await routeWorkspace(page); });

  test('1100x700 Split shows at least 4 Areas, the waiting one and the answer among them, with no text under 12 px', async ({ page }) => {
    await split(page);
    await page.goto('/#/workspaces/demo/board');
    const { shown, small, cut } = await facts(page);
    expect(cut, `second lines: ${cut.join(', ')}`).toEqual([]);
    expect(shown.length, `Areas shown: ${shown.join(' | ')}`).toBeGreaterThanOrEqual(4);
    expect(shown.some((label) => label.startsWith(WAITING))).toBe(true);
    expect(shown.some((label) => label.startsWith(ANSWER_QUESTION)), `Areas shown: ${shown.join(' | ')}`).toBe(true);
    expect(small, `text under 12 px: ${small.join(', ')}`).toEqual([]);
  });

  test('fractional label widths use the actual transform and still reject truly small text', async ({ page }) => {
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    await board(page).evaluate((region) => {
      region.style.position = 'relative';
      const sample = document.createElement('span');
      sample.id = 'fractional-font-sample';
      sample.textContent = 'Metric sample';
      sample.style.cssText = 'position:absolute;left:2px;top:40px;display:block;width:17.51px;font-size:13.333333px;transform:scale(.9);transform-origin:top left';
      region.append(sample);
    });
    // 13.333333 * .9 = 12; the old rounded-width estimate is only 11.67.
    expect((await facts(page)).small).toEqual([]);
    await page.locator('#fractional-font-sample').evaluate((el: HTMLElement) => { el.style.fontSize = '13px'; });
    expect((await facts(page)).small).toContain('11.7px "Metric sample"');
  });

  test('a subtitle that is not drawn stays in the card\'s accessible name and its tooltip', async ({ page }) => {
    await split(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const cards = await board(page).locator('.board-overview-plane .react-flow__node-areaMini button.board-area[title]').evaluateAll((buttons) => buttons.map((b) => ({ label: b.getAttribute('aria-label') ?? '', title: b.getAttribute('title') ?? '' })));
    expect(cards.length, 'a card with a hidden subtitle').toBeGreaterThan(0);
    for (const { label, title } of cards) {
      const subtitle = title.slice(title.indexOf(': ') + 2);
      expect(subtitle.length).toBeGreaterThan(0);
      expect(label).toContain(subtitle);
    }
  });

  for (const [seen, name] of [[false, 'shows what moved on an answer card ("Answer updated") while it is unseen'], [true, 'shows nothing of it once the news is marked seen']] as const) {
    test(`an answer ${name}`, async ({ page }) => {
      await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({
        empty: seen,
        answers: { items: [{ path: 'explain/how-does-the-board-learn.md', question: ANSWER_QUESTION, change: 'changed', copies: 1, at: minutesAgo(2) }], more: 0 },
      }) }));
      await split(page);
      await page.goto('/#/workspaces/demo/board');
      await viewAtRest(page);
      const card = board(page).locator('.board-overview-plane .react-flow__node-areaMini').filter({ hasText: ANSWER_QUESTION });
      await expect(card).toBeVisible();
      if (seen) await expect(card).not.toContainText('Answer updated');
      else await expect(card).toContainText('Answer updated');
    });
  }

  test('1280x800 Split shows at least 6 Areas, with no text under 12 px', async ({ page }) => {
    await split(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/workspaces/demo/board');
    const { shown, small, cut } = await facts(page);
    expect(cut, `second lines: ${cut.join(', ')}`).toEqual([]);
    expect(shown.length, `Areas shown: ${shown.join(' | ')}`).toBeGreaterThanOrEqual(6);
    expect(shown.some((label) => label.startsWith(WAITING))).toBe(true);
    expect(shown.some((label) => label.startsWith(ANSWER_QUESTION)), `Areas shown: ${shown.join(' | ')}`).toBe(true);
    expect(small, `text under 12 px: ${small.join(', ')}`).toEqual([]);
  });

  for (const [width, height, name] of [[1440, 900, '1440x900 Board'], [1280, 800, '1280x800 Board']] as const) {
    test(`${name} keeps the whole focus card and has no text under 12 px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/#/workspaces/demo/board');
      const { small } = await facts(page);
      expect(small, `text under 12 px: ${small.join(', ')}`).toEqual([]);
      // Thumbnails stay where there is room
      await expect(board(page).locator('.react-flow__node-area button[aria-label$="Picture 1"], .react-flow__node-area img').first()).toBeVisible();
    });
  }

  test('no card stands alone on a line with an empty half beside it while Areas are folded', async ({ page }) => {
    await split(page);
    await page.goto('/#/workspaces/demo/board');
    await viewAtRest(page);
    const xs = await board(page).locator('.board-overview-plane .react-flow__node-areaMini').evaluateAll((nodes) => nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    }));
    const columns = new Set(xs.map((p) => p.x)).size;
    expect(columns).toBeGreaterThanOrEqual(2);
    const lines = new Map<number, number>();
    for (const p of xs) lines.set(p.y, (lines.get(p.y) ?? 0) + 1);
    const counts = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    // Every line but the last is full
    for (const n of counts.slice(0, -1)) expect(n).toBe(columns);
  });
});
