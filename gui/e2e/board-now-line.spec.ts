/**
 * The Now line (slice W1): one line at the top of the Board that says where the work is and what waits for you, at both levels.
 * "Now" is only ever a step someone said they work on; the plan's order is "Next up". The data is like this workspace's: two open
 * checkpoints, the work in the later one when it is set, loose cards, a question, and news.
 */
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, boardNote, decision, planFile, whatsNew } from './planData';

const workspace = {
  id: 'demo', branchName: 'demo', name: 'The Board', description: 'The board', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z',
};
test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

const PICS = process.env.W1_PICS ?? '';
const AREA_ONE = 'A Board tab in NexusFlow';
const AREA_TWO = 'The Code window';
const AREA_ONE_ID = 'checkpoint:a-board-tab-in-nexusflow';
const FIRST_STEP = 'C1 bug, tracked: the overview keeps its zoom after a far jump';
const SET_STEP = 'F1: The Code window opens over the Board';
const QUESTION = 'Should the Code window keep the commit box open after a commit?';

const s = (key: string, text: string, done = false, parent?: string) => ({ key, text, done, ...(parent ? { parent } : {}) });
type Now = { key: string; by: string; at: string } | null;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const LONG_TWO = 'The Code window, with commit, finish and sync back to the main branch of every repository in the workspace';

function plan(now: Now, question: boolean, long = false) {
  return {
    ...planFile({
      title: 'New canvas',
      checkpoints: [
        {
          key: 'a-board-tab-in-nexusflow', title: AREA_ONE, done: false,
          steps: [s('heading', '**Audit and polish**:'), s('c1-bug', FIRST_STEP, false, 'heading'), s('c2', 'C2: Segment the loose cards', false, 'heading'), s('slice-a', 'Slice A: purge clutter', true)],
          decisions: [],
        },
        {
          key: 'the-code-window', title: long ? LONG_TWO : AREA_TWO, done: false,
          steps: [s('f1', SET_STEP), s('f2', 'F2: Commit, finish and sync back'), s('f3', 'F3: The commit box remembers its text')],
          decisions: question ? [{ ...decision(QUESTION, { suggested: ['Keep it open', 'Close it'] }), checkpoint: 'the-code-window' }] : [],
        },
      ],
    }),
    now,
  };
}

const cards = () => [
  boardNote(1, { area: AREA_ONE_ID, step: undefined, title: 'A loose note of the first Area', at: minutesAgo(3), updatedAt: minutesAgo(3) }),
  boardNote(2, { area: AREA_ONE_ID, step: 'c1-bug', title: 'A note on the bug', at: minutesAgo(4), updatedAt: minutesAgo(4) }),
];

const newsOf = (n: number) => whatsNew({
  plan: { more: 0, items: [
    { at: minutesAgo(9), by: 'claude', action: 'added', kind: 'step', key: 'f2', text: 'F2: Commit, finish and sync back' },
    { at: minutesAgo(7), by: 'claude', action: 'ticked', kind: 'step', key: 'slice-a', text: 'Slice A: purge clutter' },
    { at: minutesAgo(5), by: 'claude', action: 'removed', kind: 'step', key: 'gone', text: 'A step that was removed' },
  ].slice(0, Math.max(0, n - 1)) },
  commits: n > 0 ? [{ repo: 'NexusFlow', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Claude', subject: 'feat(board): the Code window', at: minutesAgo(2) }] }] : [],
});

interface Options { now?: Now; question?: boolean; news?: number; gate?: boolean; long?: boolean; recent?: boolean }

async function routeNow(page: Page, opts: Options = {}) {
  const state = { extra: [] as Array<Record<string, unknown>>, now: opts.now ?? null, question: opts.question ?? false, news: opts.news ?? 0, posts: [] as unknown[], seen: 0, release: () => {} };
  const planNow = () => plan(state.now, state.question, opts.long);
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.routeWebSocket('**/ws/terminal', () => {});
  await page.route('**/api/workspace/demo/plan', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: planNow() }) : route.continue()));
  await page.route('**/api/workspace/demo/plan/now', (route) => {
    const body = route.request().postDataJSON() as { key?: string; clear?: boolean };
    state.posts.push(body);
    state.now = body.key ? { key: body.key, by: 'user', at: new Date().toISOString() } : null;
    return route.fulfill({ json: { message: 'ok', plan: planNow() } });
  });
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: newsOf(state.news) }));
  // Got it: the news is empty from then on, as the real route answers after the pending record is marked
  await page.route('**/api/workspace/demo/news/seen', (route) => { state.seen += 1; state.news = 0; return route.fulfill({ json: { ok: true } }); });
  if (opts.recent) {
    await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({ json: { at: new Date().toISOString(), from: minutesAgo(72 * 60), commits: [{ repo: 'NexusFlow', more: 0, commits: [
      { sha: 'a91f2e0c4d5b', author: 'Claude', subject: 'feat(board): the Code window', at: minutesAgo(2) },
      { sha: 'b82e1d9b3c4a', author: 'Claude', subject: 'fix(board): keep the view', at: minutesAgo(90) },
      { sha: 'c73d0c8a2b39', author: 'Anna', subject: 'docs: the Now line', at: minutesAgo(200) },
    ] }] } }));
  }
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile({ cards: [...state.extra, ...cards()] }) }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  // A live stream that stays shut until the test releases it with a plan change
  const gate = new Promise<void>((resolve) => { state.release = resolve; });
  await page.route('**/api/workspace/*/screen-events**', async (route) => {
    if (!opts.gate) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' });
    await gate;
    const at = new Date().toISOString();
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 60000\n\nevent: plan\nid: p1\ndata: ${JSON.stringify({ type: 'plan', timestamp: at })}\n\n` });
  });
  return state;
}

async function settled(page: Page, root: string) {
  let last = '';
  await expect.poll(async () => {
    const now = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return 'absent';
      const running = el.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity).length;
      const viewport = el.querySelector('.react-flow__viewport');
      return `${running} ${viewport ? getComputedStyle(viewport).transform : ''}`;
    }, root);
    const calm = now.startsWith('0 ') && now === last;
    last = now;
    return calm;
  }, { intervals: [100], timeout: 10_000 }).toBe(true);
}

async function openBoard(page: Page, split: boolean) {
  await page.goto('/#/workspaces/demo/board');
  if (split) {
    if (await page.getByTestId('view-mode-split').isDisabled()) await page.getByRole('button', { name: /^Collapse/ }).click();
    await page.getByTestId('view-mode-split').click();
  }
  await expect(page.getByTestId('board-now-line')).toBeVisible();
  await settled(page, '#board-overview');
}

const line = (page: Page) => page.getByTestId('board-now-line');
const main = (page: Page) => page.getByTestId('board-now-main');
const areaCard = (page: Page, title: string) => page.locator('#board-overview button.board-area').filter({ hasText: title });
async function shot(page: Page, name: string) {
  if (PICS) { fs.mkdirSync(PICS, { recursive: true }); await page.screenshot({ path: `${PICS}/${name}.png` }); }
}

const SIZES = [
  { name: '1280x800 split', width: 1280, height: 800, split: true, scheme: 'light' as const },
  { name: '1100x700 split', width: 1100, height: 700, split: true, scheme: 'dark' as const },
  { name: '1440x900 board', width: 1440, height: 900, split: false, scheme: 'light' as const },
  { name: '420 pane', width: 420, height: 800, split: false, scheme: 'light' as const },
];

for (const size of SIZES) {
  test.describe(`the Now line, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, colorScheme: size.scheme });
    const tag = size.name.replace(/\s+/g, '-');

    test('with none set it says Next up with the plan\'s first step, and Now and Current appear nowhere', async ({ page }) => {
      await routeNow(page);
      await openBoard(page, size.split);
      await expect(main(page)).toContainText('Next up');
      await expect(main(page)).toContainText(FIRST_STEP);
      await expect(main(page)).toHaveAttribute('title', new RegExp(FIRST_STEP));
      await expect(page.getByTestId('board-now-who')).toHaveCount(0);
      const text = await page.evaluate(() => document.body.innerText);
      expect(text).not.toMatch(/\b(Now|Current)\b/);
      const labels = await page.evaluate(() => Array.from(document.querySelectorAll('[aria-label],[title]')).map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`).join('\n'));
      expect(labels).not.toMatch(/\b(Now|Current)\b/);
      await shot(page, `overview-next-up-${tag}-${size.scheme}`);
      // pressing it lands in the Area, with the step's row in view
      await main(page).click();
      await expect(page.locator('#board-area')).toBeVisible();
      await expect(page.locator('#board-area').getByRole('heading', { name: AREA_ONE })).toBeVisible();
      await settled(page, '#board-area');
      await expect(page.locator('.react-flow__node[data-id="row:step:c1-bug"]')).toBeVisible();
      await expect(page.locator('.react-flow__node[data-id="row:step:c1-bug"]')).toContainText('Next up');
      await expect(line(page)).toBeVisible();
      await shot(page, `area-next-up-${tag}-${size.scheme}`);
      const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('.react-flow__node[data-id="row:step:c1-bug"]')));
      expect(inside).toBe(true);
    });

    test('with a step set in the later checkpoint it says Now, names who and when, and the pill, row and chip move with it while loose cards stay', async ({ page }) => {
      await routeNow(page, { now: { key: 'f1', by: 'claude', at: minutesAgo(5) } });
      await openBoard(page, size.split);
      await expect(main(page)).toContainText('Now');
      await expect(main(page)).toContainText(SET_STEP);
      // the Area name and who go first on a narrow pane; the step and the rest stay
      // who and when show where the line has room beside the step (the step keeps 200 px first)
      if ((await line(page).boundingBox())!.width >= 700) await expect(page.getByTestId('board-now-who')).toHaveText('Claude · 5 min ago');
      // the pill is on the later Area, the loose card is where it was
      await expect(areaCard(page, AREA_TWO)).toHaveAccessibleName(/\bnow\b/);
      await expect(areaCard(page, AREA_ONE)).not.toHaveAccessibleName(/\b(now|next up)\b/);
      await expect(areaCard(page, AREA_ONE)).toHaveAccessibleName(/2 notes/);
      await shot(page, `overview-now-${tag}-${size.scheme}`);
      // the header chip (when the chat is not beside the board) and the chat's progress line say the same words
      const chip = page.getByRole('group', { name: 'Task status' });
      if (await chip.count()) {
        await expect(chip).toContainText('Now');
        await expect(chip).toContainText(SET_STEP);
      }
      const strip = page.getByRole('region', { name: 'Where are we', exact: true });
      if (await strip.count()) await expect(strip).toContainText(`Now · ${SET_STEP}`);
      await main(page).click();
      await expect(page.locator('#board-area').getByRole('heading', { name: AREA_TWO })).toBeVisible();
      await settled(page, '#board-area');
      const row = page.locator('.react-flow__node[data-id="row:step:f1"]');
      await expect(row).toBeVisible();
      await expect(row).toContainText('Now');
      await expect(line(page)).toBeVisible();
      await shot(page, `area-now-${tag}-${size.scheme}`);
    });

    test('shows the question count in the warning colour and goes to the question', async ({ page }) => {
      await routeNow(page, { now: { key: 'f1', by: 'claude', at: minutesAgo(1) }, question: true });
      await openBoard(page, size.split);
      const question = page.getByTestId('board-now-question');
      await expect(question).toHaveAccessibleName('1 question waits');
      await shot(page, `overview-question-${tag}-${size.scheme}`);
      await question.click();
      await expect(page.locator('#board-area')).toBeVisible();
      await settled(page, '#board-area');
      await expect(page.locator('#board-area').getByRole('heading', { name: AREA_TWO })).toBeVisible();
      await expect(page.getByTestId(/^decision-card-/).first()).toBeVisible();
      await shot(page, `area-question-${tag}-${size.scheme}`);
    });

    test('shows what is new, each line jumps to its card or step or shows only its text, and Got it marks it seen', async ({ page }) => {
      const state = await routeNow(page, { now: { key: 'f1', by: 'claude', at: minutesAgo(1) }, news: 4 });
      await openBoard(page, size.split);
      const news = page.getByTestId('board-now-news');
      await expect(news).toHaveText('4 new');
      await news.click();
      const list = page.getByTestId('board-news-list');
      await expect(list).toBeVisible();
      await expect(list).toHaveCSS('opacity', '1');
      await settled(page, '[data-slot="popover-popup"]');
      await shot(page, `overview-news-${tag}-${size.scheme}`);
      // a commit goes to its card; a removed step has nowhere to go and shows its text
      await expect(list.getByRole('button', { name: /feat\(board\): the Code window/ })).toHaveCount(1);
      await expect(list).toContainText('A step that was removed');
      await expect(list.getByRole('button', { name: /A step that was removed/ })).toHaveCount(0);
      // a step line goes to its Area
      await list.getByRole('button', { name: /added “F2: Commit, finish and sync back”/ }).click();
      await expect(page.locator('#board-area').getByRole('heading', { name: AREA_TWO })).toBeVisible();
      await expect(list).toHaveCount(0);
      expect(state.seen).toBe(0);
      await news.click();
      await page.getByTestId('board-news-list').getByRole('button', { name: 'Got it' }).click();
      await expect.poll(() => state.seen).toBe(1);
      await expect(news).toHaveCount(0);
    });

    test('keeps its parts readable and pressable, and the level fits on one screen with nothing overlapping', async ({ page }) => {
      await routeNow(page, { now: { key: 'f1', by: 'claude', at: minutesAgo(5) }, question: true, news: 4 });
      await openBoard(page, size.split);
      await shot(page, `overview-full-${tag}-${size.scheme}`);
      for (const level of ['overview', 'area'] as const) {
        if (level === 'area') {
          await main(page).click();
          await settled(page, '#board-area');
        }
        const parts = line(page).locator('button:visible');
        expect(await parts.count()).toBeGreaterThanOrEqual(4);
        const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
        for (const part of await parts.all()) {
          const box = (await part.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(24);
          expect(box.width).toBeGreaterThanOrEqual(24);
          boxes.push(box);
        }
        const lineBox = (await line(page).boundingBox())!;
        for (const box of boxes) {
          expect(box.x).toBeGreaterThanOrEqual(lineBox.x - 1);
          expect(box.x + box.width).toBeLessThanOrEqual(lineBox.x + lineBox.width + 1);
        }
        for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]!; const b = boxes[j]!;
          expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, `parts ${i} and ${j} overlap`).toBe(false);
        }
        const small = await line(page).evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('*')).filter((el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
        expect(small).toEqual([]);
        // the page does not scroll, and the level is drawn whole inside the window
        expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        const region = level === 'area' ? page.locator('#board-area') : page.locator('#board-overview');
        const box = (await region.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(lineBox.y + lineBox.height - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
        if (level === 'overview') {
          const nodes = page.locator('#board-overview .react-flow__node');
          for (const node of await nodes.all()) {
            const nodeBox = (await node.boundingBox())!;
            expect(nodeBox.y).toBeGreaterThanOrEqual(lineBox.y + lineBox.height - 1);
            expect(nodeBox.y + nodeBox.height).toBeLessThanOrEqual(size.height + 1);
          }
        }
      }
    });
  });
}

test.describe('the search and the key', () => {
  test('the search button opens the Board index with its search focused, and "/" does the same except in a field', async ({ page }) => {
    await routeNow(page);
    await openBoard(page, false);
    const search = page.getByRole('searchbox', { name: 'Search the board' });
    await line(page).getByRole('button', { name: 'Search the board' }).click();
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    // typing a slash in the box types it
    await search.fill('');
    await page.keyboard.type('a/b');
    await expect(search).toHaveValue('a/b');
    // out of the box, the key goes to the search again
    await search.fill('');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(search).not.toBeFocused();
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
  });

  test('"/" opens a folded index first', async ({ page }) => {
    await routeNow(page);
    await page.addInitScript(() => { try { localStorage.setItem('contextspace_board_nav_open_v1', 'closed'); } catch { /* ignore */ } });
    await openBoard(page, false);
    const search = page.getByRole('searchbox', { name: 'Search the board' });
    await expect(search).toHaveCount(0);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
  });
});

test.describe('saying which step is worked on, and a live change', () => {
  test('the step\'s dialog has "Work on this now", which sends it and moves the line', async ({ page }) => {
    const state = await routeNow(page);
    await openBoard(page, false);
    await areaCard(page, AREA_TWO).click();
    await settled(page, '#board-area');
    await page.getByTestId('step-trigger-f1').first().click();
    const dialog = page.getByTestId('step-detail-dialog');
    await dialog.getByTestId('step-dialog-now').click();
    await expect.poll(() => state.posts).toEqual([{ key: 'f1' }]);
    await expect(main(page)).toContainText('Now');
    await expect(main(page)).toContainText(SET_STEP);
    await expect(dialog).toHaveCount(0);
    // once set, the dialog offers to let go of it instead
    await page.getByTestId('step-trigger-f1').first().click();
    await expect(page.getByTestId('step-detail-dialog').getByTestId('step-dialog-now')).toHaveText('Stop working on this');
    await page.getByTestId('step-detail-dialog').getByTestId('step-dialog-now').click();
    await expect.poll(() => state.posts).toEqual([{ key: 'f1' }, { clear: true }]);
    await expect(main(page)).toContainText('Next up');
    // a heading is not a step to work on: its dialog has no such action
    await page.locator('#board-area').getByRole('button', { name: 'Board ›' }).click();
    await areaCard(page, AREA_ONE).click();
    await settled(page, '#board-area');
    await page.getByTestId('step-trigger-c1-bug').first().click();
    await expect(page.getByTestId('step-detail-dialog').getByTestId('step-dialog-now')).toHaveText('Work on this now');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('step-detail-dialog')).toHaveCount(0);
  });

  test('moves the line when the plan changes under it, with no reload', async ({ page }) => {
    const state = await routeNow(page, { gate: true });
    await openBoard(page, false);
    await expect(main(page)).toContainText('Next up');
    await expect(main(page)).toContainText(FIRST_STEP);
    state.now = { key: 'f3', by: 'codex', at: new Date().toISOString() };
    state.release();
    await expect(main(page)).toContainText('Now');
    await expect(main(page)).toContainText('F3: The commit box remembers its text');
    await expect(page.getByTestId('board-now-who')).toContainText('Codex');
    await expect(areaCard(page, AREA_TWO)).toHaveAccessibleName(/\bnow\b/);
  });
});


const WIDE = [
  { name: '1500x900', width: 1500, height: 900 },
  { name: '1600x900', width: 1600, height: 900 },
  { name: '1680x1000', width: 1680, height: 1000 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1100x700', width: 1100, height: 700 },
  { name: '420 pane', width: 420, height: 800 },
];

for (const size of WIDE) {
  test.describe(`the line with a long Area title, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    for (const level of ['overview', 'area'] as const) {
      test(`${level}: the step keeps its room, nothing overlaps, with a question and news`, async ({ page }) => {
        await routeNow(page, { now: { key: 'f1', by: 'claude', at: new Date().toISOString() }, question: true, news: 4, long: true });
        await openBoard(page, size.width >= 1100);
        if (level === 'area') { await main(page).click(); await settled(page, '#board-area'); }
        const box = async (locator: ReturnType<typeof line>) => (await locator.boundingBox())!;
        const step = await box(page.getByTestId('board-now-step'));
        const lineBox = await box(line(page));
        // the step keeps about 200 px wherever the line has the room for it; on the narrow pane it keeps what is left
        expect(step.width).toBeGreaterThanOrEqual(size.width >= 1500 ? 195 : size.width >= 1100 ? 180 : 60);
        const names = ['board-now-main', 'board-now-step', 'board-now-area', 'board-now-who', 'board-now-question', 'board-now-news'];
        const boxes: Array<[string, { x: number; y: number; width: number; height: number }]> = [];
        for (const id of names) {
          const target = page.getByTestId(id);
          if (await target.count()) boxes.push([id, await box(target)]);
        }
        boxes.push(['search', await box(line(page).getByRole('button', { name: 'Search the board' }))]);
        const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x + 0.5 < b.x + b.width && b.x + 0.5 < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        // the parts side by side never overlap; the step and the Area and who are inside the button that holds them
        const sides = boxes.filter(([id]) => ['board-now-main', 'board-now-question', 'board-now-news', 'search'].includes(id));
        for (let i = 0; i < sides.length; i += 1) for (let j = i + 1; j < sides.length; j += 1) expect(overlaps(sides[i]![1], sides[j]![1]), `${sides[i]![0]} over ${sides[j]![0]}`).toBe(false);
        const inner = boxes.filter(([id]) => ['board-now-step', 'board-now-area', 'board-now-who'].includes(id));
        for (let i = 0; i < inner.length; i += 1) for (let j = i + 1; j < inner.length; j += 1) expect(overlaps(inner[i]![1], inner[j]![1]), `${inner[i]![0]} over ${inner[j]![0]}`).toBe(false);
        const mainBox = boxes.find(([id]) => id === 'board-now-main')![1];
        for (const [id, b] of inner) {
          expect(b.x, id).toBeGreaterThanOrEqual(mainBox.x - 1);
          expect(b.x + b.width, id).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1);
        }
        for (const [id, b] of boxes) expect(b.x + b.width, id).toBeLessThanOrEqual(lineBox.x + lineBox.width + 1);
        await shot(page, `wide-${level}-${size.name.replace(/\s+/g, '-')}`);
      });
    }
  });
}

test.describe('Got it never takes commits off the board', () => {
  test('the same commits and the same count after Got it and a reload', async ({ page }) => {
    const state = await routeNow(page, { now: { key: 'f1', by: 'claude', at: new Date().toISOString() }, news: 1, recent: true });
    await openBoard(page, false);
    const count = async () => (await areaCard(page, AREA_TWO).getAttribute('aria-label'))!.match(/(\d+) commits?/)?.[1];
    await expect.poll(count).toBe('3');
    await page.getByTestId('board-now-news').click();
    await page.getByTestId('board-news-list').getByRole('button', { name: 'Got it' }).click();
    await expect.poll(() => state.seen).toBe(1);
    await expect(page.getByTestId('board-now-news')).toHaveCount(0);
    expect(await count()).toBe('3');
    await page.reload();
    await expect(line(page)).toBeVisible();
    await settled(page, '#board-overview');
    await expect.poll(count).toBe('3');
    await areaCard(page, AREA_TWO).click();
    await settled(page, '#board-area');
    await expect(page.locator('#board-area').getByText('feat(board): the Code window').first()).toBeVisible();
  });
});

test.describe('"/" with no session open', () => {
  const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search the board' });
  const mode = (page: Page, name: 'board' | 'split') => page.getByTestId(`view-mode-${name}`).click();

  test('goes to the Board search after a reload in Board, in Split then Board, in Board then Split, and after a reload in Split', async ({ page }) => {
    await routeNow(page);
    await page.goto('/#/workspaces/demo/board');
    await expect(line(page)).toBeVisible();
    const slash = async (label: string) => {
      await page.locator('body').click({ position: { x: 3, y: 3 } });
      await page.keyboard.press('/');
      await expect(searchBox(page), label).toBeFocused();
      await searchBox(page).fill('');
    };
    await mode(page, 'board');
    await slash('after a reload in Board');
    await mode(page, 'split');
    await slash('Board then Split');
    await mode(page, 'board');
    await slash('Split then Board');
    await mode(page, 'split');
    await page.reload();
    await expect(line(page)).toBeVisible();
    await slash('after a reload in Split');
  });

  test('in Split goes to the chat\'s search when the keyboard is in the chat\'s list, and not behind a dialog', async ({ page }) => {
    await routeNow(page);
    await openBoard(page, true);
    const chatSearch = page.getByPlaceholder('Search conversations or harnesses (/)');
    await expect(chatSearch).toBeVisible();
    // the keyboard on the list's own heading: the chat's search
    await page.getByRole('region', { name: 'Continue a conversation' }).getByText('Or continue a saved conversation').click();
    await page.getByRole('link', { name: 'Full history' }).focus();
    await page.keyboard.press('/');
    await expect(chatSearch).toBeFocused();
    // a modal step dialog: the key does not land behind it
    await chatSearch.blur();
    await areaCard(page, AREA_TWO).click();
    await settled(page, '#board-area');
    await page.getByTestId('step-trigger-f1').first().click();
    await expect(page.getByTestId('step-detail-dialog')).toBeVisible();
    await page.keyboard.press('/');
    await expect(page.locator('input[type="search"]:focus')).toHaveCount(0);
    await expect(page.getByTestId('step-detail-dialog')).toBeVisible();
  });
});

test.describe('an idle board does not keep a stale claim', () => {
  test('"ago" moves on a minute tick, and a step set more than a day ago stops saying Now on the line, the pill and the chat strip', async ({ page }) => {
    await page.clock.install({ time: new Date() });
    await routeNow(page, { now: { key: 'f1', by: 'claude', at: new Date().toISOString() } });
    await openBoard(page, true);
    await expect(page.getByTestId('board-now-who')).toHaveText(/Claude · just now/).catch(() => undefined);
    await expect(main(page)).toContainText('Now');
    await page.clock.fastForward('02:21');
    await expect(main(page)).toHaveAttribute('title', /2 min ago/);
    await page.clock.fastForward('28:00:00');
    await expect(main(page)).toContainText('Next up');
    await expect(main(page)).not.toContainText('Now');
    await expect(areaCard(page, AREA_TWO)).not.toHaveAccessibleName(/\bnow\b/);
    const strip = page.getByRole('region', { name: 'Where are we', exact: true });
    await expect(strip).not.toContainText('Now ·');
    await expect(strip).toContainText('Next up ·');
  });
});

test.describe('what the AI just added still lights its Area after the board has been open a while', () => {
  test('a new AI note in another Area shows the dot at 70 s, though the tick leaves the Areas as they were', async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const state = await routeNow(page, { now: { key: 'f1', by: 'claude', at: new Date().toISOString() } });
    await openBoard(page, false);
    await expect(areaCard(page, AREA_ONE).locator('[title="New since you looked"]')).toHaveCount(0);
    await page.clock.fastForward('01:10');
    const at = await page.evaluate(() => new Date().toISOString());
    state.extra = [boardNote(77, { area: AREA_ONE_ID, step: undefined, title: 'Just added by the AI', at, updatedAt: at })];
    await page.clock.fastForward('00:31');
    await expect(areaCard(page, AREA_ONE).locator('[title="New since you looked"]')).toHaveCount(1);
  });
});
