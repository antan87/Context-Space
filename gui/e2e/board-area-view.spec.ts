/**
 * Inside an Area (Slice A1): the waiting decisions are fixed, readable cards; the Now row is a real step with no raw markup; no line is
 * drawn at rest; and at the sizes of the laptop windows at least one line of cards shows. The data is like this workspace's: a plan
 * with nested steps (a heading holding a heading holding steps), a long question with four answers, and cards that link to each other.
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ANSWER_HOLD_OFF_MS } from '../src/features/board/answerHoldOff.ts';
import { boardFile, boardFileCard, boardLink, boardNote, decision, planFile, whatsNew } from './planData';

const workspace = {
  id: 'demo', branchName: 'demo', name: 'A Board tab', description: 'The board', repos: [], assistants: [], workspacePath: '/tmp/demo', createdAt: '2026-10-01T00:00:00Z',
};

test.use({ workspacesData: [[workspace], { option: true }], viewport: { width: 1280, height: 800 } });

const AREA = 'A Board tab in NexusFlow';
const AREA_ID = 'checkpoint:a-board-tab-in-nexusflow';
const LONG = 'Code, Docs and Services can no longer be reached from a workspace, only the Board. Is that what you want, or should some come back?';
const ANSWERS = ['Stay removed; the Board takes over', 'Bring back Code (uncommitted changes)', 'Bring back Code and Services', 'Bring back all three'];
const HEADING = '**End-User Tester Audit & Co-Working Polish**:';
const NOW = 'C1 bug, tracked: with a fold open, **Escape** within about 250 ms of a far jump leaves the overview at a smaller zoom';

const s = (key: string, text: string, done = false, parent?: string) => ({ key, text, done, ...(parent ? { parent } : {}) });

function plan(decisions: Array<ReturnType<typeof decision>>, check?: string, second = false) {
  const steps = [
    s('slice-a', '**Slice A: Purge lingering clutter**', true),
    s('heading', HEADING),
    s('slice-c', '**Slice C: Split mode Level 0 density & mini-board**', false, 'heading'),
    s('c1', 'C1: Fix Level 0 collapse in Split mode', true, 'slice-c'),
    s('c1-bug', NOW, false, 'slice-c'),
    s('c2', 'C2: Segment the loose cards into `Media`, `Notes` and `Commits`', false, 'slice-c'),
    ...Array.from({ length: 6 }, (_, i) => s(`later-${i}`, `Later step ${i} with a few words to read`)),
  ];
  // Someone said the work is on this step, so the Now row is it (the plan's order alone says Next up)
  return planFile({
    now: { key: 'c1-bug', by: 'claude', at: new Date().toISOString() },
    title: 'New canvas',
    checkpoints: [
      {
        key: 'a-board-tab-in-nexusflow', title: AREA, done: false, steps, ...(check ? { check } : {}),
        decisions: decisions.map((entry) => ({ ...entry, checkpoint: 'a-board-tab-in-nexusflow' })),
      },
      ...(second ? [{ key: 'second-area', title: 'A second Area', done: false, steps: [s('sa-1', 'Do the first thing of the second Area'), s('sa-2', 'Then the second')], decisions: [] }] : []),
    ],
  });
}

const cards = (archived = 0, onNow = true) => [
  // the first three are the newest: they are the ones drawn, and the lines run between them
  boardNote(1, { area: AREA_ID, step: onNow ? 'c1-bug' : undefined, title: 'Live development on the board', body: 'We are using the board live during development.', at: new Date(Date.now() - 1 * 60_000).toISOString(), pinned: true }),
  boardNote(2, { area: AREA_ID, step: onNow ? 'c1-bug' : undefined, title: 'Second note', body: 'About the second note.', at: new Date(Date.now() - 2 * 60_000).toISOString() }),
  boardNote(3, { area: AREA_ID, step: onNow ? 'c1-bug' : undefined, title: 'Third note', body: 'About the third note.', at: new Date(Date.now() - 3 * 60_000).toISOString() }),
  ...Array.from({ length: archived }, (_, i) => boardNote(40 + i, { area: AREA_ID, step: undefined, archived: true, title: `Archived note ${i}` })),
  ...Array.from({ length: 7 }, (_, i) => boardFileCard(10 + i, `p${i}.png`, { area: AREA_ID, step: undefined, title: `Picture ${i}`, at: new Date(Date.now() - (10 + i) * 60_000).toISOString() })),
];

/** Like this workspace's: about 38 pictures and 3 notes, all tied to no step. The newest card is a note. */
const looseCards = () => [
  ...Array.from({ length: 38 }, (_, i) => boardFileCard(100 + i, `m${i}.png`, { area: AREA_ID, step: undefined, title: `Media ${i}`, at: new Date(Date.now() - (10 + i) * 60_000).toISOString() })),
  ...Array.from({ length: 3 }, (_, i) => boardNote(200 + i, { area: AREA_ID, step: undefined, title: `Loose note ${i}`, body: `About loose note ${i}.`, at: new Date(Date.now() - (1 + i) * 60_000).toISOString() })),
];

const links = () => [
  boardLink(1, boardNote(1).id, boardNote(2).id),
  boardLink(2, boardNote(1).id, boardNote(3).id),
  ...Array.from({ length: 6 }, (_, i) => boardLink(3 + i, boardNote(1).id, boardFileCard(10 + i, `p${i}.png`).id)),
];

async function routeBoard(page: Page, decisions: Array<ReturnType<typeof decision>>, opts: { loose?: boolean; second?: boolean; linked?: boolean | number; check?: string; archived?: number; onNow?: boolean; answerDelay?: number; answerFails?: boolean } = {}) {
  let current = plan(decisions, opts.check, opts.second);
  const control = { getDelay: 0, answerFails: opts.answerFails ?? false, getCount: 0 };
  const answers: Array<{ key: string; answer: string }> = [];
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.routeWebSocket('**/ws/terminal', () => {});
  await page.route('**/api/workspace/demo/plan', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    control.getCount += 1;
    // the answer is what the plan was when the request came in, whatever it is when the reply is let go
    const json = current;
    if (control.getDelay) await new Promise((resolve) => setTimeout(resolve, control.getDelay));
    return route.fulfill({ json });
  });
  await page.route('**/api/workspace/demo/plan/decisions/*/answer', async (route) => {
    const segments = new URL(route.request().url()).pathname.split('/');
    const key = decodeURIComponent(segments[segments.length - 2] ?? '');
    const body = route.request().postDataJSON();
    answers.push({ key, answer: body.answer });
    if (opts.answerDelay) await new Promise((resolve) => setTimeout(resolve, opts.answerDelay));
    if (control.answerFails) return route.fulfill({ status: 500, json: { error: 'No luck.' } });
    current = {
      ...current,
      checkpoints: current.checkpoints.map((cp) => ({ ...cp, decisions: cp.decisions.map((d) => (d.key === key ? { ...d, done: true, answer: body.answer } : d)) })),
      waiting: current.waiting.filter((k) => k !== key),
    };
    return route.fulfill({ json: { message: 'Answered.', plan: current } });
  });
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew({ commits: [{ repo: 'NexusFlow', more: 0, commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'A commit', at: new Date().toISOString() }] }] }) }));
  // The board as it is now: what a note added, or a live change, makes of it
  const live = {
    cards: (opts.loose ? looseCards() : cards(opts.archived ?? 0, opts.onNow ?? true)) as Array<Record<string, unknown>>,
    links: (opts.linked ? [boardLink(50, boardNote(200).id, boardFileCard(100 + (typeof opts.linked === 'number' ? opts.linked : 0), `m${typeof opts.linked === 'number' ? opts.linked : 0}.png`).id)] : opts.loose ? [] : links()) as Array<Record<string, unknown>>,
    changesAfter: 0,
    added: [] as Array<Record<string, unknown>>,
  };
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile({ cards: live.cards, links: live.links }) }));
  await page.route('**/api/workspace/demo/board/changes', async (route) => {
    const body = route.request().postDataJSON() as { changes: Array<Record<string, unknown>> };
    for (const change of body.changes) {
      if (change.op !== 'add_card') continue;
      const added = boardNote(300 + live.added.length, { title: change.title as string, ...(change.area ? { area: change.area as string } : {}), step: (change.step as string | undefined) ?? undefined, at: new Date().toISOString(), updatedAt: new Date().toISOString() });
      live.added.push(added);
      live.cards = [added, ...live.cards];
    }
    if (live.changesAfter) await new Promise((resolve) => setTimeout(resolve, live.changesAfter));
    return route.fulfill({ json: boardFile({ cards: live.cards, links: live.links }) });
  });
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  return { live, answers, control, setDecisions: (next: Array<ReturnType<typeof decision>>) => { current = plan(next, opts.check); } };
}

const TWO = () => [decision(LONG, { suggested: ANSWERS, detail: 'The Board does not yet show uncommitted changes or run services.' }), decision('Which **time zone** should export timestamps use?', { suggested: ['UTC', 'Local time (browser)', 'Account setting'] })];

/**
 * Waits until what is drawn inside `root` has stopped moving: no finite animation or transition is running in it (an Area scales in over 260 ms,
 * and again whenever it is drawn anew) and its zoom and pan are the same on two looks in a row. A box measured before that is a box in flight.
 */
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
  }, { message: `${root} has stopped moving`, intervals: [100], timeout: 10_000 }).toBe(true);
}

async function stepIn(page: Page, split: boolean, openFold = true) {
  await page.goto('/#/workspaces/demo/board');
  if (split) {
    // On a laptop window the sidebar gives its room up to the rail, which is what Split needs
    if (await page.getByTestId('view-mode-split').isDisabled()) await page.getByRole('button', { name: /^Collapse/ }).click();
    await page.getByTestId('view-mode-split').click();
  }
  // the overview is drawn for the width it has once the panels have settled; a click before that scrolls the stage to reach the card
  await settled(page, '#board-overview');
  await page.locator('#board-overview button.board-area').filter({ hasText: AREA }).click();
  await expect(page.locator('#board-area')).toBeVisible();
  const frame = page.getByRole('article', { name: 'Waits for you' });
  // On a canvas too small for the cards the decisions are one line, which opens them
  if (openFold && !(await frame.isVisible().catch(() => false))) await page.locator('#board-area').getByRole('button', { name: /Waits for you/ }).click();
  await expect(frame).toBeVisible();
  // the Area's rows are laid out for the canvas as it is, a frame or two after it opens
  await settled(page, '#board-area');
}

/** What overflows inside `box`: elements that scroll, and the ones whose content is wider or taller than they are. */
const overflowing = (box: Locator) => box.evaluate((root) => {
  const bad: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))] as HTMLElement[]) {
    const style = getComputedStyle(el);
    const label = `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`;
    if (/auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflowX)) bad.push(`${label} scrolls`);
    const clamped = style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '';
    if (!clamped && !el.closest('.sr-only') && !el.classList.contains('sr-only')) {
      if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) bad.push(`${label} taller than itself (${el.scrollHeight} > ${el.clientHeight})`);
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && style.display !== 'inline' && !/truncate|text-ellipsis/.test(el.className) && style.textOverflow !== 'ellipsis') bad.push(`${label} wider than itself (${el.scrollWidth} > ${el.clientWidth})`);
    }
  }
  return bad;
});

const SIZES = [
  { name: '1280x800 split', width: 1280, height: 800, split: true },
  { name: '1100x700 split', width: 1100, height: 700, split: true },
  { name: '420 pane', width: 420, height: 800, split: false },
];

for (const size of SIZES) {
  test.describe(`inside an Area, ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('the waiting card is fixed and calm: the question, whole answer buttons inside it, nothing scrolls or overflows', async ({ page }) => {
      await routeBoard(page, TWO());
      await stepIn(page, size.split);
      const frame = page.getByRole('article', { name: 'Waits for you' });
      const card = frame.getByTestId('decision-card-code-docs-and-services-can-no-longer-be-reached-from-a-workspace-only-the-board-is-that-what-you-want-or-should-some-come-back');
      await expect(card).toBeVisible();
      // the first words of the question are on the card, and all of it is in its title
      await expect(card).toContainText('Code, Docs and Services');
      await expect(card.locator('span[title]').first()).toHaveAttribute('title', LONG);
      expect(await overflowing(frame)).toEqual([]);
      const cardBox = (await card.boundingBox())!;
      const buttons = card.getByRole('group', { name: 'Suggested answers' }).getByRole('button');
      expect(await buttons.count()).toBeGreaterThan(0);
      for (const button of await buttons.all()) {
        const box = (await button.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
        expect(box.y).toBeGreaterThanOrEqual(cardBox.y);
        expect(box.y + box.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
        expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      // the card is as tall as the layout says, so it does not move the rows under it
      const frameBox = (await frame.boundingBox())!;
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height);
      // every text of the card is 12 px or more
      const small = await frame.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('*')).filter((el) => !el.classList.contains('sr-only') && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
      expect(small).toEqual([]);
    });

    test('one press on an answer answers, and the decision leaves the board', async ({ page }) => {
      const tracker = await routeBoard(page, TWO());
      await stepIn(page, size.split);
      const frame = page.getByRole('article', { name: 'Waits for you' });
      const first = frame.getByTestId(/^decision-card-code-docs/).getByRole('group', { name: 'Suggested answers' }).getByRole('button').first();
      const answer = (await first.textContent())!;
      await first.click();
      await expect.poll(() => tracker.answers.length).toBe(1);
      expect(tracker.answers[0]).toMatchObject({ answer });
      await expect(frame).not.toContainText('Code, Docs and Services');
      await expect(frame).toContainText('time zone');
    });

    test('a dialog holds the whole question, every answer and the free answer, closes on Escape and on a click outside, and gives the focus back', async ({ page }) => {
      const tracker = await routeBoard(page, TWO());
      await stepIn(page, size.split);
      const frame = page.getByRole('article', { name: 'Waits for you' });
      const trigger = frame.getByTestId('decision-more-answers').first();
      await expect(trigger).toHaveText('All answers…');
      await trigger.click();
      const dialog = page.getByTestId('decision-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(LONG);
      await expect(dialog).toContainText('The Board does not yet show uncommitted changes');
      for (const answer of ANSWERS) await expect(dialog.getByRole('button', { name: answer })).toBeVisible();
      await expect(dialog.getByPlaceholder('Your answer')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(dialog).toBeVisible();
      await page.mouse.click(4, 4);
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      // and a long answer, which is only in the dialog, answers from there
      await trigger.click();
      await dialog.getByRole('button', { name: ANSWERS[1]! }).click();
      await expect.poll(() => tracker.answers.length).toBe(1);
      expect(tracker.answers[0]).toMatchObject({ answer: ANSWERS[1] });
    });

    test('says a failed answer on the card, in place, without changing its height', async ({ page }) => {
      await routeBoard(page, TWO());
      await page.route('**/api/workspace/demo/plan/decisions/*/answer', (route) => route.fulfill({ status: 409, json: { error: 'Conflict: the plan was changed in another session.' } }));
      await stepIn(page, size.split);
      const frame = page.getByRole('article', { name: 'Waits for you' });
      const card = frame.getByTestId(/^decision-card-code-docs/);
      const before = (await card.boundingBox())!;
      const frameBefore = (await frame.boundingBox())!;
      const first = card.getByRole('group', { name: 'Suggested answers' }).getByRole('button').first();
      const label = (await first.textContent())!;
      await first.click();
      await expect(card.getByRole('alert')).toContainText('Conflict');
      // a failed answer draws the Area anew, which scales it in again: measure the card once that has stopped
      await settled(page, '#board-area');
      const after = (await card.boundingBox())!;
      expect(after.height).toBe(before.height);
      expect((await frame.boundingBox())!.height).toBe(frameBefore.height);
      expect(await overflowing(frame)).toEqual([]);
      await card.getByRole('button', { name: 'Answer again' }).click();
      await expect(card.getByRole('button', { name: label })).toBeVisible();
      // the keyboard is on the first answer, not on the page
      await expect(card.getByRole('button', { name: label })).toBeFocused();
    });

    test('names a step to work on in Now, with no markup, and shows at least one line of cards', async ({ page }) => {
      await routeBoard(page, TWO());
      await stepIn(page, size.split);
      const now = page.locator('#board-area button[aria-label^="Now:"]');
      await expect(now).toHaveCount(1);
      const label = (await now.getAttribute('aria-label'))!;
      expect(label).toContain('C1 bug, tracked: with a fold open, Escape within about 250 ms');
      expect(label).not.toContain('Audit');
      expect(label).not.toMatch(/\*\*|`/);
      const area = page.locator('#board-area');
      expect(await area.evaluate((root) => Array.from(root.querySelectorAll('*')).flatMap((el) => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]).filter((text) => text && /\*\*/.test(text)).map((text) => text!.slice(0, 120)))).toEqual([]);
      expect(await area.locator('.react-flow__node-note, .react-flow__node-file').count()).toBeGreaterThan(0);
    });

    test('draws no line at rest, and the lines of a card when the pointer or the keyboard is on it', async ({ page }) => {
      await routeBoard(page, TWO());
      await stepIn(page, size.split);
      const edges = page.locator('#board-area .react-flow__edge');
      expect(await edges.count()).toBeGreaterThan(0);
      const opacities = () => edges.evaluateAll((all) => all.map((el) => getComputedStyle(el).opacity));
      await page.mouse.move(2, 2);
      await expect.poll(async () => (await opacities()).every((value) => value === '0')).toBe(true);
      // the pointer on the first card lights its lines
      const first = page.locator('#board-area .react-flow__node[data-id="' + boardNote(1).id + '"]');
      await first.hover();
      await expect.poll(async () => (await opacities()).some((value) => value === '1')).toBe(true);
      await page.mouse.move(2, 2);
      await expect.poll(async () => (await opacities()).every((value) => value === '0')).toBe(true);
      // and so does the keyboard
      await first.getByRole('button').first().focus();
      await expect.poll(async () => (await opacities()).some((value) => value === '1')).toBe(true);
      await page.locator('#board-area').getByRole('button', { name: /^Now:/ }).focus();
      await expect.poll(async () => (await opacities()).every((value) => value === '0')).toBe(true);
      // the lines stay in the accessibility tree
      expect(await edges.evaluateAll((all) => all.every((el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'))).toBe(true);
    });
  });
}

test.describe('cards always show, with two waiting decisions', () => {
  for (const [width, height] of [[1100, 700], [1280, 800], [1440, 900]] as const) {
    test(`at ${width}x${height} in Split`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await routeBoard(page, TWO());
      await stepIn(page, true);
      const drawn = await page.locator('#board-area .react-flow__node-note, #board-area .react-flow__node-file').count();
      expect(drawn).toBeGreaterThan(0);
      // the waiting decisions are cards, or their one line, which still says what the question is
      const frame = page.locator('#board-area').getByRole('article', { name: 'Waits for you' });
      if (await frame.count()) await expect(frame).toContainText('Code, Docs');
      else await expect(page.locator('#board-area').getByRole('button', { name: /Waits for you/ })).toContainText('Code, Docs and Services');
    });
  }
});

// ─── Review fixes ───────────────────────────────────────────────────────────

test.describe('the header of an Area never pushes its buttons out', () => {
  for (const size of [
    { name: '1100x700 split', width: 1100, height: 700, split: true },
    { name: '1280x800 split', width: 1280, height: 800, split: true },
    { name: '1440x900 split', width: 1440, height: 900, split: true },
    { name: '420 pane', width: 420, height: 800, split: false },
  ]) {
    test(`at ${size.name}, with an archived card: every button is whole and reachable, and the keyboard never scrolls the stage sideways`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await routeBoard(page, TWO(), { archived: 1 });
      await stepIn(page, size.split);
      const area = page.locator('#board-area');
      const header = area.locator('> header');
      const areaBox = (await area.boundingBox())!;
      const buttons = await header.getByRole('button').all();
      expect(buttons.length).toBeGreaterThanOrEqual(5);
      for (const button of buttons) {
        const name = (await button.getAttribute('aria-label')) ?? (await button.innerText()) ?? '';
        const box = (await button.boundingBox())!;
        expect(box.x, name).toBeGreaterThanOrEqual(areaBox.x);
        expect(box.x + box.width, name).toBeLessThanOrEqual(areaBox.x + areaBox.width);
        expect(box.width, name).toBeGreaterThanOrEqual(24);
        expect(box.height, name).toBeGreaterThanOrEqual(24);
        // the centre of the button is the button: nothing is drawn over it, and it is not cut off
        expect(await button.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return Boolean(hit) && (hit === el || el.contains(hit)); }), `${name} is reachable`).toBe(true);
        // a button with no visible words has a name and a tooltip
        if (!(await button.innerText()).trim()) expect(await button.evaluate((el) => (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').length), `${name} has a name`).toBeGreaterThan(0);
      }
      // tab through the whole header: nothing scrolls the stage or the header sideways
      const sideways = () => page.evaluate(() => {
        const area = document.querySelector('#board-area')!;
        const out: string[] = [];
        for (let el: Element | null = area; el; el = el.parentElement) if (el.scrollLeft !== 0) out.push(`${el.tagName}#${el.id} ${el.scrollLeft}`);
        for (const el of Array.from(area.querySelectorAll('header, header *'))) if (el.scrollLeft !== 0) out.push(`${el.tagName} ${el.scrollLeft}`);
        return out;
      });
      await header.getByRole('button', { name: /^Board/ }).focus();
      for (let i = 0; i < buttons.length + 1; i += 1) {
        await page.keyboard.press('Tab');
        expect(await sideways(), `after Tab ${i + 1}`).toEqual([]);
      }
      // the last button of the header (Close) takes the focus too, and the start of the header is still there
      await expect(header.getByRole('button', { name: /^Board/ })).toBeInViewport({ ratio: 1 });
    });
  }
});

test.describe('a decision answered from the dialog', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('stays open with "Saving…" until the server confirms; on failure it keeps the words and the keyboard, then closes on success and puts the keyboard on the next decision', async ({ page }) => {
    const tracker = await routeBoard(page, TWO(), { answerDelay: 150 });
    let failures = 1;
    await page.route('**/api/workspace/demo/plan/decisions/*/answer', (route) => {
      if (failures > 0) { failures -= 1; return route.fulfill({ status: 409, json: { error: 'Conflict: the plan was changed in another session by somebody else a moment ago, so this answer was not saved.' } }); }
      return route.fallback();
    });
    await stepIn(page, true);
    const frame = page.getByRole('article', { name: 'Waits for you' });
    await frame.getByTestId('decision-more-answers').first().click();
    const dialog = page.getByTestId('decision-dialog');
    const input = dialog.getByPlaceholder('Your answer');
    await input.fill('Bring back Code only, please');
    await input.press('Enter');
    // the failure is said whole in the dialog, which stays open with the words and the keyboard where they were
    await expect(dialog.getByRole('alert')).toContainText('so this answer was not saved.');
    await expect(dialog).toBeVisible();
    await expect(input).toHaveValue('Bring back Code only, please');
    await expect(input).toBeFocused();
    expect(tracker.answers).toHaveLength(0);
    // the second try shows that it is saving, and the dialog closes only when the server has said yes
    await input.press('Enter');
    await expect(dialog.getByRole('status')).toHaveText('Saving…');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(tracker.answers).toEqual([expect.objectContaining({ answer: 'Bring back Code only, please' })]);
    await expect(frame).not.toContainText('Code, Docs and Services');
    // and the keyboard is on the next decision's card (never on one of its answers), not on the page
    await expect.poll(() => page.evaluate(() => { const el = document.activeElement; return el?.matches('[data-testid^="decision-card-"]') ? el.textContent : `${el?.tagName} ${el?.textContent}`; })).toContain('time zone');
  });

  test('opens on the question for "All answers…", and a second Enter never answers', async ({ page }) => {
    const tracker = await routeBoard(page, TWO());
    await stepIn(page, true);
    const frame = page.getByRole('article', { name: 'Waits for you' });
    const dialog = page.getByTestId('decision-dialog');
    // the long question has answers that do not fit: the dialog opens on the question
    const all = frame.getByTestId('decision-more-answers').first();
    await expect(all).toHaveText('All answers…');
    await all.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.tagName === 'BUTTON' || document.activeElement?.tagName === 'INPUT')).toBe(false);
    await expect(dialog.locator(':focus')).toContainText('Code, Docs and Services');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    expect(tracker.answers).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(all).toBeFocused();
  });

  test('opens on the free answer for "Other answer…", and a second Enter answers nothing', async ({ page }) => {
    const tracker = await routeBoard(page, [decision('Which time zone?', { suggested: ['UTC', 'Local'] })]);
    await stepIn(page, true);
    const dialog = page.getByTestId('decision-dialog');
    const other = page.getByRole('article', { name: 'Waits for you' }).getByTestId('decision-more-answers');
    await expect(other).toHaveText('Other answer…');
    await other.focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByPlaceholder('Your answer')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    expect(tracker.answers).toHaveLength(0);
  });

  test('a one-press answer puts the keyboard on the next decision, and on the row after the waiting card when it was the last', async ({ page }) => {
    await routeBoard(page, TWO());
    await stepIn(page, true);
    const frame = page.getByRole('article', { name: 'Waits for you' });
    const cardOf = (text: RegExp) => frame.getByTestId(text);
    await cardOf(/^decision-card-code-docs/).getByRole('group', { name: 'Suggested answers' }).getByRole('button').first().focus();
    await page.keyboard.press('Enter');
    await expect(frame).not.toContainText('Code, Docs and Services');
    // on the card of the next decision, not on one of its answers: a second press of the same key must not answer it unread
    await expect(cardOf(/^decision-card-which/)).toBeFocused();
    // the next Tab reaches its answers; a deliberate press (after the hold-off) answers
    await page.waitForTimeout(ANSWER_HOLD_OFF_MS + 200);
    await page.keyboard.press('Tab');
    await expect(cardOf(/^decision-card-which/).getByRole('group', { name: 'Suggested answers' }).getByRole('button').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('article', { name: 'Waits for you' })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none')).toMatch(/^Now:/);
  });
});

test.describe('the answer line', () => {
  const MODES = [
    { name: 'in Split', split: true, widths: [1000, 1060, 1100, 1180, 1280, 1360, 1440] },
    { name: 'in a pane', split: false, widths: [380, 420, 460, 520, 600] },
  ];
  const sets: Array<[string, string[]]> = [
    ['CJK', ['はい、そうしてください', '戻さないでください、このままで', 'コードとサービスを戻す', '全部戻す']],
    ['emoji', ['👍👍👍👍👍👍👍👍', '🙂 Yes please 🙂', '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀', 'No 🙅']],
    ['accented', ['Größenänderung möglich', 'Ménage à trois été', 'Zürich, Köln, Düsseldorf', 'Ça ne fait rien']],
  ];
  for (const [name, answers] of sets) for (const mode of MODES) {
    test(`${name} answers ${mode.name}: no button runs under the "All answers…" button, at a sweep of widths, and the line holds one row of buttons`, async ({ page }) => {
      await page.setViewportSize({ width: mode.widths[mode.widths.length - 1]!, height: 800 });
      await routeBoard(page, [decision('Which of these do you want us to do with the old screens that were removed?', { suggested: answers })]);
      await stepIn(page, mode.split);
      for (const width of mode.widths) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(450);
        const card = page.getByTestId(/^decision-card-/).first();
        await expect(card).toBeVisible();
        const ghost = (await card.getByTestId('decision-more-answers').boundingBox())!;
        const group = await card.getByTestId('decision-answers').boundingBox();
        for (const button of await card.getByRole('group', { name: 'Suggested answers' }).getByRole('button').all()) {
          const box = (await button.boundingBox())!;
          expect(box.x + box.width, `${name} at ${width}: "${await button.innerText()}" ends before the ghost button starts`).toBeLessThanOrEqual(ghost.x);
          expect(box.height).toBeLessThanOrEqual(26);
        }
        // the hard guarantee: whatever the estimate let through, the buttons' box ends before the ghost button
        if (group) expect(group.x + group.width, `${name} at ${width}: the buttons' clip`).toBeLessThanOrEqual(ghost.x);
        if (group) expect(await card.getByTestId('decision-answers').evaluate((el) => getComputedStyle(el).overflowX)).toMatch(/clip|hidden/);
      }
    });
  }

  test('the keyboard ring of an answer button is whole: nothing between it and the card clips its 2 px outline and 1 px offset', async ({ page }) => {
    await routeBoard(page, TWO());
    await stepIn(page, true);
    const card = page.getByTestId(/^decision-card-code-docs/);
    await page.keyboard.press('Shift');
    const buttons = await card.getByRole('group', { name: 'Suggested answers' }).getByRole('button').all();
    for (const button of [buttons[0]!, ...(buttons.length > 1 ? [buttons[buttons.length - 1]!] : []), card.getByTestId('decision-more-answers')]) {
      await button.focus();
      const clipped = await button.evaluate((el) => {
        const ring = 3;
        const r = el.getBoundingClientRect();
        const need = { left: r.left - ring, top: r.top - ring, right: r.right + ring, bottom: r.bottom + ring };
        const shadow = getComputedStyle(el).boxShadow;
        const bad: string[] = [];
        if (!shadow || shadow === 'none') bad.push('no ring');
        for (let up = el.parentElement; up && up.tagName !== 'ARTICLE'; up = up.parentElement) {
          const style = getComputedStyle(up);
          if (/hidden|clip|auto|scroll/.test(style.overflowX + style.overflowY)) {
            const b = up.getBoundingClientRect();
            const sides = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
            if (need.top < sides.top - 0.5 || need.bottom > sides.bottom + 0.5 || need.left < sides.left - 0.5 || need.right > sides.right + 0.5) bad.push(`${up.tagName}.${(up.className || '').toString().slice(0, 40)} clips (${JSON.stringify(sides)} vs ${JSON.stringify(need)})`);
          }
        }
        return bad;
      });
      expect(clipped, await button.innerText()).toEqual([]);
    }
  });
});

test.describe('the waiting frame with a check', () => {
  for (const size of SIZES) {
    test(`is as tall as what it draws, at ${size.name}: the question, the answers, the footer and the border`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await routeBoard(page, TWO().slice(0, 1), { check: 'npm test' });
      await stepIn(page, size.split);
      const frame = page.getByRole('article', { name: 'Waits for you' });
      expect(await overflowing(frame)).toEqual([]);
      const footer = frame.locator('footer');
      await expect(footer).toContainText('Run check');
      const node = (await page.locator('#board-area .react-flow__node-checkpoint').first().boundingBox())!;
      const box = (await frame.boundingBox())!;
      const foot = (await footer.boundingBox())!;
      // the node is the height the layout computed; the frame fills it, and the footer, with its bottom border, is inside it
      expect(Math.abs(box.height - node.height)).toBeLessThanOrEqual(1);
      expect(foot.y + foot.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
      expect(await frame.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      // the card ends above the footer
      const card = (await frame.getByTestId(/^decision-card-/).boundingBox())!;
      expect(card.y + card.height).toBeLessThanOrEqual(foot.y + 0.5);
    });
  }
});

test.describe('the Now row', () => {
  test('keeps its dot round, says no "Nothing on this step yet", and shows the heading above it only where it has room', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await routeBoard(page, TWO(), { onNow: false });
    await stepIn(page, false);
    const area = page.locator('#board-area');
    await expect(area).not.toContainText('Nothing on this step yet');
    const dot = (await area.locator('.board-now-dot').boundingBox())!;
    expect(dot.width).toBeGreaterThanOrEqual(7);
    expect(dot.height).toBeGreaterThanOrEqual(7);
    // even with a long error beside it the dot stays round
    await page.route('**/api/workspace/demo/plan/steps/*/tick', (route) => route.fulfill({ status: 409, json: { error: 'Conflict: the plan was changed in another session by somebody else a moment ago.' } }));
    await area.getByTestId('step-checkbox-c1-bug').click();
    await expect(area.locator('button[aria-label^="Now"], .react-flow__node').getByRole('alert').first()).toBeVisible();
    const withError = (await area.locator('.board-now-dot').boundingBox())!;
    expect(withError.width).toBeGreaterThanOrEqual(7);
    // 420 px: the heading is not drawn at all, not cut to a few letters
    const nowNode = area.locator('.react-flow__node').filter({ has: page.getByTestId('step-trigger-c1-bug') });
    await expect(nowNode).toHaveCount(1);
    await expect(nowNode.getByText('Slice C: Split mode')).toBeHidden();
    await expect(nowNode).toContainText('C1 bug, tracked');
    // an empty Now has no row to open: its one button, named "Now: …", opens the whole step
    await expect(area.locator('button[aria-label^="Now:"]')).toHaveCount(1);
    await area.locator('button[aria-label^="Now:"]').click();
    const dialog = page.getByTestId('step-detail-dialog');
    await expect(dialog).toContainText('with a fold open, Escape within about 250 ms of a far jump leaves the overview at a smaller zoom');
    await page.keyboard.press('Escape');
    await expect(area.getByTestId('step-trigger-c1-bug')).toBeFocused();
  });

  test('on a wide board the heading stands above the step, set apart and whole', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeBoard(page, TWO(), { onNow: false });
    await stepIn(page, false);
    const area = page.locator('#board-area');
    const nowNode = area.locator('.react-flow__node').filter({ has: page.getByTestId('step-trigger-c1-bug') });
    const nowWidth = (await nowNode.boundingBox())!.width;
    expect(nowWidth).toBeGreaterThan(560);
    await expect(nowNode.getByText('Slice C: Split mode Level 0 density & mini-board')).toBeVisible();
    await expect(nowNode.getByText('Slice C: Split mode Level 0 density & mini-board')).not.toContainText('…');
  });

  test('a press on its first line opens the row, and on its words opens the whole step', async ({ page }) => {
    await routeBoard(page, TWO());
    await stepIn(page, true);
    const area = page.locator('#board-area');
    const toggle = area.locator('button[aria-label^="Now:"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await area.getByTestId('step-trigger-c1-bug').click();
    await expect(page.getByTestId('step-detail-dialog')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('no step shows a trailing colon of its heading, in the list of more open steps or anywhere', async ({ page }) => {
    await routeBoard(page, TWO());
    await stepIn(page, true);
    const area = page.locator('#board-area');
    await area.getByRole('button', { name: /more open steps/ }).click();
    const tile = area.getByText('End-User Tester Audit & Co-Working Polish');
    await expect(tile.first()).toBeVisible();
    expect(await area.evaluate((root) => Array.from(root.querySelectorAll('*')).filter((el) => /Co-Working Polish\s*:\s*$/.test(el.textContent ?? '')).map((el) => el.textContent))).toEqual([]);
  });
});

test.describe('the lines', () => {
  test('are lit by hover and focus while a thread is active, and one line stands for several links to the same place', async ({ page }) => {
    await routeBoard(page, TWO());
    await stepIn(page, true);
    const flow = page.locator('#board-area .board-flow-rows');
    const edges = page.locator('#board-area .react-flow__edge');
    const opacities = () => edges.evaluateAll((all) => all.map((el) => getComputedStyle(el).opacity));
    const first = page.locator('#board-area .react-flow__node[data-id="' + boardNote(1).id + '"]');
    await page.mouse.move(2, 2);
    await expect.poll(async () => (await opacities()).every((value) => value === '0')).toBe(true);
    // a thread is active (as when a card has been pressed): the lines of the card under the pointer are lit all the same. The attribute is set and read in
    // one call, so that the board's own bookkeeping of the thread does not matter.
    const lit = () => flow.evaluate(async (el) => {
      el.setAttribute('data-thread-active', 'true');
      // the lines fade over 220 ms: what they are is read when that has passed
      await new Promise((resolve) => setTimeout(resolve, 450));
      const lines = Array.from(el.querySelectorAll('.react-flow__edge[data-lit]'));
      const seen = { lit: lines.length, visible: lines.filter((line) => getComputedStyle(line).opacity === '1').length };
      el.removeAttribute('data-thread-active');
      return seen;
    });
    await first.hover();
    await expect.poll(async () => (await opacities()).some((value) => value === '1')).toBe(true);
    const hovered = await lit();
    expect(hovered.lit).toBeGreaterThan(0);
    expect(hovered.visible).toBe(hovered.lit);
    // and the keyboard: the same
    await page.mouse.move(2, 2);
    await first.getByRole('button').first().focus();
    await expect.poll(async () => (await opacities()).some((value) => value === '1')).toBe(true);
    const focused = await lit();
    expect(focused.lit).toBeGreaterThan(0);
    expect(focused.visible).toBe(focused.lit);
    // no two lines are drawn on top of each other
    const labels = await edges.evaluateAll((all) => all.map((el) => el.getAttribute('aria-label') ?? ''));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

const FIVE = () => ['Which **time zone** should export timestamps use?', 'Should the **old screens** return?', 'Who **reviews** the change?', 'When is the **release**?', 'Is the **name** final?']
  .map((question) => decision(question, { suggested: ['First answer', 'Second answer'] }));

test.describe('a double press answers once', () => {
  const firstAnswer = (page: Page, nth = 0) => page.getByRole('article', { name: 'Waits for you' }).getByTestId(/^decision-card-/).nth(nth).getByRole('group', { name: 'Suggested answers' }).getByRole('button').first();

  test('a double Enter at 100 to 400 ms answers one decision, and the keyboard rests on the next card', async ({ page }) => {
    const tracker = await routeBoard(page, FIVE());
    await stepIn(page, true);
    for (const gap of [100, 250, 400]) {
      const before = tracker.answers.length;
      await firstAnswer(page).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(gap);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(ANSWER_HOLD_OFF_MS + 100);
      expect(tracker.answers.length - before, `Enter twice, ${gap} ms apart`).toBe(1);
      await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-testid^="decision-card-"]'))).toBe(true);
    }
  });

  test('a double Space, and a held Enter, answer one decision', async ({ page }) => {
    const tracker = await routeBoard(page, FIVE());
    await stepIn(page, true);
    await firstAnswer(page).focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await page.keyboard.press('Space');
    await page.waitForTimeout(ANSWER_HOLD_OFF_MS + 100);
    expect(tracker.answers).toHaveLength(1);
    await firstAnswer(page).focus();
    await page.keyboard.down('Enter');
    for (let i = 0; i < 20; i++) { await page.keyboard.down('Enter'); await page.waitForTimeout(30); }
    await page.keyboard.up('Enter');
    await page.waitForTimeout(ANSWER_HOLD_OFF_MS + 100);
    expect(tracker.answers).toHaveLength(2);
  });

  test('a native double click, and pairs of clicks 20, 150 and 300 ms apart, answer one decision', async ({ page }) => {
    const tracker = await routeBoard(page, FIVE());
    await stepIn(page, true);
    const centre = async () => { const box = (await firstAnswer(page).boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
    let point = await centre();
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForTimeout(ANSWER_HOLD_OFF_MS + 100);
    expect(tracker.answers, 'native double click').toHaveLength(1);
    for (const gap of [20, 150, 300]) {
      const before = tracker.answers.length;
      point = await centre();
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(gap);
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(ANSWER_HOLD_OFF_MS + 100);
      expect(tracker.answers.length - before, `clicks ${gap} ms apart`).toBe(1);
    }
  });

  test('a second press after the hold-off does answer the next decision', async ({ page }) => {
    const tracker = await routeBoard(page, FIVE());
    await stepIn(page, true);
    await firstAnswer(page).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(ANSWER_HOLD_OFF_MS + 200);
    await page.keyboard.press('Tab');
    await expect(firstAnswer(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => tracker.answers.length).toBe(2);
    expect(tracker.answers.map((entry) => entry.answer)).toEqual(['First answer', 'First answer']);
  });

  for (const [gap, posts] of [[600, 1], [1000, 2]] as const) {
    test(`a second click ${gap} ms later, with the pointer still, makes ${posts} answer${posts > 1 ? 's' : ''}`, async ({ page }) => {
      const tracker = await routeBoard(page, FIVE());
      await stepIn(page, true);
      const box = (await firstAnswer(page).boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.click(x, y);
      await page.waitForTimeout(gap);
      await page.mouse.click(x, y);
      await page.waitForTimeout(700);
      expect(tracker.answers).toHaveLength(posts);
    });
  }

  for (const clicks of [2, 3]) {
    test(`${clicks} quick clicks answer once, the keyboard rests on the card, and an Enter 1.5 s later answers nothing`, async ({ page }) => {
      const tracker = await routeBoard(page, FIVE());
      await stepIn(page, true);
      const box = (await firstAnswer(page).boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      for (let count = 1; count <= clicks; count++) {
        await page.mouse.down({ clickCount: count });
        await page.mouse.up({ clickCount: count });
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(1500);
      expect(tracker.answers).toHaveLength(1);
      await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-testid^="decision-card-"]'))).toBe(true);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      expect(tracker.answers).toHaveLength(1);
    });
  }

  test('guard: the hold-off alone stops a press that is a single click, not a repeat, 150 ms after an answer', async ({ page }) => {
    const tracker = await routeBoard(page, FIVE());
    await stepIn(page, true);
    await firstAnswer(page).click();
    await page.waitForTimeout(150);
    // a lone click on whatever answer is there now (a click event of its own: detail 1)
    await firstAnswer(page).evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    await page.waitForTimeout(700);
    expect(tracker.answers).toHaveLength(1);
  });

  test('guard: a click that says it is the second of a double click is dropped even when the hold-off has passed', async ({ page }) => {
    const tracker = await routeBoard(page, FIVE());
    await stepIn(page, true);
    await page.evaluate(() => { const real = performance.now.bind(performance); performance.now = () => real() + 100_000; });
    await firstAnswer(page).evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })));
    await page.waitForTimeout(300);
    expect(tracker.answers).toHaveLength(0);
    await firstAnswer(page).evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
    await expect.poll(() => tracker.answers.length).toBe(1);
  });

  test('guard: a held key on a button that keeps the keyboard (the dialog, after a failure) does not answer again', async ({ page }) => {
    const tracker = await routeBoard(page, FIVE(), { answerFails: true, answerDelay: 650 });
    await stepIn(page, true);
    await page.getByRole('article', { name: 'Waits for you' }).getByTestId('decision-more-answers').first().click();
    const dialog = page.getByTestId('decision-dialog');
    const button = dialog.getByRole('group', { name: 'All suggested answers' }).getByRole('button').first();
    await button.focus();
    await page.keyboard.down('Enter');
    // the key stays down while the first answer fails, 650 ms later, and the button is back and still has the keyboard
    for (let i = 0; i < 40; i++) { await page.keyboard.down('Enter'); await page.waitForTimeout(40); }
    await page.keyboard.up('Enter');
    await page.waitForTimeout(1500);
    expect(tracker.answers).toHaveLength(1);
  });
});

test.describe('the Area header buttons that add', () => {
  for (const [name, split, width] of [['at 1100 in Split', true, 1100], ['at 1280 in Split', true, 1280], ['at 1440 in Split', true, 1440], ['in the 420 pane', false, 420]] as const) {
    test(`say apart what they add ${name}: two different icons, each with a name and a tooltip`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await routeBoard(page, TWO());
      await stepIn(page, split);
      const header = page.locator('#board-area header').first();
      const step = header.getByRole('button', { name: 'Add a step' });
      const note = header.getByRole('button', { name: 'Add a note' });
      await expect(step).toHaveCount(1);
      await expect(note).toHaveCount(1);
      const shape = (button: Locator) => button.evaluate((el) => ({ icon: el.querySelector('svg')?.getAttribute('class') ?? '', text: (el.textContent ?? '').trim(), box: el.getBoundingClientRect().width }));
      const a = await shape(step);
      const b = await shape(note);
      expect(a.icon).toContain('lucide-list-plus');
      expect(b.icon).toContain('lucide-sticky-note');
      expect(a.icon).not.toBe(b.icon);
      expect(a.text + b.text).toBe('');
      expect(a.box).toBeGreaterThanOrEqual(24);
      await step.hover();
      await expect(page.locator('[data-slot="tooltip-popup"]')).toContainText('Add a step');
    });
  }

  test('keep their words, with the plus, where the header holds them', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeBoard(page, TWO());
    await stepIn(page, false);
    const header = page.locator('#board-area header').first();
    await expect(header.getByRole('button', { name: 'Add a step' })).toContainText('Step');
    await expect(header.getByRole('button', { name: 'Add a note' })).toContainText('Note');
    await expect(header.getByRole('button', { name: 'Add a step' }).locator('svg.lucide-plus')).toBeVisible();
  });
});

test.describe('when the plan changes under the keyboard', () => {
  // Where the notice goes: in the header when the frame has no pager, or room beside it; on a line of its own under the header when the frame is paged and narrow.
  for (const [name, split, width, paged, place] of [['at 1280 in Split', true, 1280, false, 'header'], ['at 1100 in Split', true, 1100, false, 'header'], ['in the 420 pane', false, 420, true, 'own line']] as const) {
  test(`a question edited in the plan while its dialog is open says so, and the keyboard is not lost to the page, and the notice is ${place === 'header' ? 'in the header' : 'on a line of its own under the header'} ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    const tracker = await routeBoard(page, TWO());
    await stepIn(page, split);
    const frame = page.getByRole('article', { name: 'Waits for you' });
    // the card whose answers do not all fit holds the dialog's button (which cards that is depends on the width)
    const opener = frame.getByTestId(/^decision-card-/).filter({ has: page.getByTestId('decision-more-answers') }).last();
    const openedIndex = (await frame.getByTestId(/^decision-card-/).evaluateAll((all, key) => all.findIndex((el) => el.getAttribute('data-testid') === key), await opener.getAttribute('data-testid')));
    await opener.getByTestId('decision-more-answers').click();
    const input = page.getByTestId('decision-dialog').getByPlaceholder('Your answer');
    await input.fill('Some words I typed');
    const changed = TWO();
    changed[openedIndex] = decision('Which **time zone** should export files use?', { suggested: ['UTC', 'Local time (browser)', 'Account setting'] });
    tracker.setDecisions(changed);
    await page.waitForTimeout(5200);
    const reads = tracker.control.getCount;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await expect.poll(() => tracker.control.getCount).toBeGreaterThan(reads);
    await expect(page.getByTestId('decision-dialog')).toHaveCount(0);
    const notice = frame.getByRole('status');
    await expect(notice).toContainText('answer not sent');
    await expect(notice).toHaveAttribute('title', /The question changed in the plan; your answer was not sent/);
    const fit = await frame.evaluate((el) => {
      const header = el.querySelector('header')!.getBoundingClientRect();
      const h2 = el.querySelector('header h2')!;
      const status = el.querySelector('[role="status"]')!;
      const list = el.querySelector('ul')!.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(h2).lineHeight);
      const rects = [h2.getBoundingClientRect(), status.getBoundingClientRect()];
      const frameBox = el.getBoundingClientRect();
      const noticeBox = status.getBoundingClientRect();
      // in the header, or on a line of its own right under it, with the decisions below and inside the frame
      const inHeader = rects.every((r) => r.top >= header.top - 0.5 && r.bottom <= header.bottom + 0.5 && r.right <= header.right + 0.5);
      const apart = noticeBox.top >= header.bottom - 0.5 && noticeBox.bottom <= list.top + 0.5 && noticeBox.right <= frameBox.right + 0.5;
      return { h2Lines: Math.round(h2.getBoundingClientRect().height / lineHeight), place: inHeader ? 'header' : apart ? 'own line' : 'neither', noticeCut: status.scrollHeight > status.clientHeight + 1 || status.scrollWidth > status.clientWidth + 1, listBelow: list.top >= (inHeader ? header.bottom : noticeBox.bottom) - 0.5 && list.bottom <= frameBox.bottom + 0.5 };
    });
    expect(await page.getByRole('navigation', { name: /^Pages of / }).count() > 0, 'the frame is paged').toBe(paged);
    expect(fit, `the heading on one line, the notice whole ${place === 'header' ? 'in the header' : 'on its own line under it'}, the decisions not pushed`).toEqual({ h2Lines: 1, place, noticeCut: false, listBelow: true });
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('#board-area') !== null)).toBe(true);
    expect(tracker.answers).toHaveLength(0);
  });
  }

  for (const [name, width, height, make] of [['in the 420 pane with 5 decisions', 420, 700, FIVE], ['at 360 wide with 2 decisions', 360, 700, TWO], ['at 360x600 on a page of one card', 360, 600, TWO]] as const) {
  test(`a paged frame keeps its notice off the pager, and "not sent" stays visible, with the answers whole inside their cards ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const tracker = await routeBoard(page, make());
    await stepIn(page, false);
    const frame = page.getByRole('article', { name: 'Waits for you' });
    const more = frame.getByRole('button', { name: /^Show \d+ more decisions waiting for you/ });
    if (await more.count()) await more.click();
    const pager = page.getByRole('navigation', { name: /^Pages of / });
    await expect(pager).toBeVisible();
    const opener = frame.getByTestId(/^decision-card-/).filter({ has: page.getByTestId('decision-more-answers') }).last();
    const openedIndex = (await frame.getByTestId(/^decision-card-/).evaluateAll((all, key) => all.findIndex((el) => el.getAttribute('data-testid') === key), await opener.getAttribute('data-testid')));
    await opener.getByTestId('decision-more-answers').click();
    await page.getByTestId('decision-dialog').getByPlaceholder('Your answer').fill('Some words I typed');
    const changed = make();
    changed[openedIndex] = decision('Which **time zone** should export files use?', { suggested: ['UTC', 'Local time (browser)', 'Account setting'] });
    tracker.setDecisions(changed);
    await page.waitForTimeout(5200);
    const reads = tracker.control.getCount;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await expect.poll(() => tracker.control.getCount).toBeGreaterThan(reads);
    const notice = frame.getByRole('status');
    await expect(notice).toContainText('answer not sent');
    await expect(pager).toBeVisible();
    const boxes = { notice: (await notice.boundingBox())!, pager: (await pager.boundingBox())! };
    const apart = boxes.notice.x + boxes.notice.width <= boxes.pager.x + 0.5 || boxes.pager.x + boxes.pager.width <= boxes.notice.x + 0.5 || boxes.notice.y + boxes.notice.height <= boxes.pager.y + 0.5 || boxes.pager.y + boxes.pager.height <= boxes.notice.y + 0.5;
    expect(apart, `the notice ${JSON.stringify(boxes.notice)} does not overlap the pager ${JSON.stringify(boxes.pager)}`).toBe(true);
    const shown = await notice.evaluate((el) => { const r = el.getBoundingClientRect(); const f = el.closest('article')!.getBoundingClientRect(); return { whole: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1, inFrame: r.left >= f.left - 0.5 && r.right <= f.right + 0.5 && r.bottom <= f.bottom + 0.5 }; });
    expect(shown).toEqual({ whole: true, inFrame: true });
    await expect(frame.getByTestId(/^decision-card-/).first()).toBeVisible();
    // every answer button sits whole inside its card, under the notice line, with room below it
    const gaps = await frame.evaluate((el) => {
      const f = el.getBoundingClientRect();
      return Array.from(el.querySelectorAll('[data-testid^="decision-card-"]')).flatMap((card) => {
        const c = card.getBoundingClientRect();
        return Array.from(card.querySelectorAll('button')).filter((b) => b.getBoundingClientRect().height > 0).map((b) => { const r = b.getBoundingClientRect(); return { belowCardTop: r.top - c.top, aboveCardBottom: c.bottom - r.bottom, aboveFrameBottom: f.bottom - r.bottom }; });
      });
    });
    expect(gaps.length, 'the card has answer buttons').toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap.belowCardTop, `an answer button starts inside its card: ${JSON.stringify(gap)}`).toBeGreaterThanOrEqual(0);
      expect(gap.aboveCardBottom, `an answer button ends inside its card, with a little room: ${JSON.stringify(gap)}`).toBeGreaterThanOrEqual(3);
      expect(gap.aboveFrameBottom, `an answer button ends inside the frame: ${JSON.stringify(gap)}`).toBeGreaterThanOrEqual(3);
    }
  });
  }

  test('a paged frame 540 px or wider keeps the notice in the header, beside the pager and not under it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 600 });
    const tracker = await routeBoard(page, FIVE());
    await stepIn(page, false);
    const frame = page.getByRole('article', { name: 'Waits for you' });
    const more = frame.getByRole('button', { name: /^Show \d+ more decisions waiting for you/ });
    if (await more.count()) await more.click();
    const pager = page.getByRole('navigation', { name: /^Pages of / });
    await expect(pager).toBeVisible();
    expect((await frame.boundingBox())!.width, 'the frame is 540 px or wider').toBeGreaterThanOrEqual(540);
    const opener = frame.getByTestId(/^decision-card-/).filter({ has: page.getByTestId('decision-more-answers') }).last();
    const openedIndex = (await frame.getByTestId(/^decision-card-/).evaluateAll((all, key) => all.findIndex((el) => el.getAttribute('data-testid') === key), await opener.getAttribute('data-testid')));
    await opener.getByTestId('decision-more-answers').click();
    await page.getByTestId('decision-dialog').getByPlaceholder('Your answer').fill('Some words I typed');
    const changed = FIVE();
    changed[openedIndex] = decision('Which **time zone** should export files use?', { suggested: ['UTC', 'Local time (browser)', 'Account setting'] });
    tracker.setDecisions(changed);
    await page.waitForTimeout(5200);
    const reads = tracker.control.getCount;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await expect.poll(() => tracker.control.getCount).toBeGreaterThan(reads);
    const notice = frame.getByRole('status');
    await expect(notice).toContainText('answer not sent');
    await expect(pager).toBeVisible();
    const where = await frame.evaluate((el) => {
      const header = el.querySelector('header')!.getBoundingClientRect();
      const n = el.querySelector('[role="status"]')!.getBoundingClientRect();
      const p = el.querySelector('nav[aria-label^="Pages of"]')?.getBoundingClientRect() ?? Array.from(document.querySelectorAll('nav')).find((x) => /^Pages of/.test(x.getAttribute('aria-label') ?? ''))!.getBoundingClientRect();
      return { inHeader: n.top >= header.top - 0.5 && n.bottom <= header.bottom + 0.5 && n.right <= header.right + 0.5, noticeRight: n.right, pagerLeft: p.left, pagerTop: p.top, pagerBottom: p.bottom, noticeTop: n.top, noticeBottom: n.bottom };
    });
    expect(where.inHeader, `the notice is in the header ${JSON.stringify(where)}`).toBe(true);
    const sideBySide = where.noticeRight <= where.pagerLeft + 0.5 || where.noticeBottom <= where.pagerTop + 0.5 || where.pagerBottom <= where.noticeTop + 0.5;
    expect(sideBySide, `the notice does not touch the pager ${JSON.stringify(where)}`).toBe(true);
    expect(await notice.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  });

  test('after the last decision is answered with an empty Now row, the keyboard is on the Now row\'s step', async ({ page }) => {
    await routeBoard(page, [TWO()[1]!], { onNow: false });
    await stepIn(page, true);
    const frame = page.getByRole('article', { name: 'Waits for you' });
    await frame.getByTestId(/^decision-card-/).getByRole('group', { name: 'Suggested answers' }).getByRole('button').first().focus();
    await page.keyboard.press('Enter');
    await expect(frame).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none')).toMatch(/^Now:/);
  });

  test('a plan read that was begun before an answer in the dialog was saved cannot bring the answered decision back', async ({ page }) => {
    const tracker = await routeBoard(page, TWO(), { answerDelay: 400 });
    await stepIn(page, true);
    await page.waitForTimeout(5200); // the plan read is stale after 5 s, which is when a return to the window reads it again
    const frame = page.getByRole('article', { name: 'Waits for you' });
    await frame.getByTestId('decision-more-answers').first().click();
    const dialog = page.getByTestId('decision-dialog');
    await dialog.getByRole('group', { name: 'All suggested answers' }).getByRole('button').first().click();
    // a read begins while the answer is being saved, and is answered late, with the plan as it was
    tracker.control.getDelay = 1500;
    const reads = tracker.control.getCount;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await page.waitForTimeout(100);
    await expect(dialog).toHaveCount(0);
    await expect(frame).not.toContainText('Code, Docs and Services');
    expect(tracker.control.getCount, 'a read was begun').toBeGreaterThan(reads);
    await page.waitForTimeout(2200);
    await expect(frame).not.toContainText('Code, Docs and Services');
    expect(tracker.answers).toHaveLength(1);
  });
});

for (const size of [{ name: '1280x800', width: 1280, height: 800 }, { name: '1100x700', width: 1100, height: 700 }]) {
  test.describe(`the row that is not tied to a step has Media and Notes tabs, ${size.name} Split`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    const looseNodes = (page: Page) => page.locator('#board-area .react-flow__node-note, #board-area .react-flow__node-file');

    test('shows the tabs with their counts on the header line, only that kind after a press, and moves with the arrow keys without panning the board', async ({ page }) => {
      await routeBoard(page, TWO(), { loose: true });
      await stepIn(page, true);
      const area = page.locator('#board-area');
      const tabs = area.getByRole('tablist', { name: 'Kinds of cards' });
      await expect(tabs).toBeVisible();
      const media = tabs.getByRole('tab', { name: /^Media\s*38$/ });
      const notes = tabs.getByRole('tab', { name: /^Notes\s*3$/ });
      await expect(media).toBeVisible();
      await expect(notes).toBeVisible();
      // the newest card is a note: that tab shows first
      await expect(notes).toHaveAttribute('aria-selected', 'true');
      // the tabs share the header line of their row, are at least 24 px, and the summary is gone
      const header = area.locator('.react-flow__node[data-id="lane:board"]');
      const headBox = (await header.boundingBox())!;
      for (const tab of [media, notes]) {
        const box = (await tab.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(24);
        expect(box.y).toBeGreaterThanOrEqual(headBox.y - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(headBox.y + headBox.height + 1);
      }
      await expect(header).not.toContainText('41 cards');
      await expect(looseNodes(page).filter({ hasText: /Loose note/ })).not.toHaveCount(0);
      await expect(looseNodes(page).filter({ hasText: /Media \d/ })).toHaveCount(0);
      await media.click();
      await expect(media).toHaveAttribute('aria-selected', 'true');
      await settled(page, '#board-area');
      await expect(looseNodes(page).filter({ hasText: /Media \d/ }).first()).toBeVisible();
      await expect(looseNodes(page).filter({ hasText: /Loose note/ })).toHaveCount(0);
      // "+N more" counts the media alone, and lines up on the header line beside the tabs without overlapping them
      const more = area.getByRole('button', { name: /^Show \d+ more for Not tied to a step/ });
      await expect(more).toBeVisible();
      const moreBox = (await more.boundingBox())!;
      const mediaBox = (await media.boundingBox())!;
      const notesBox = (await notes.boundingBox())!;
      expect(notesBox.x + notesBox.width).toBeLessThanOrEqual(moreBox.x + 1);
      expect(mediaBox.x + mediaBox.width).toBeLessThanOrEqual(notesBox.x + 1);
      const shown = await looseNodes(page).count();
      expect(Number((await more.textContent())!.match(/\d+/)![0])).toBe(38 - shown);
      // Left and Right move and select; the board does not pan
      const viewport = () => page.locator('#board-area .react-flow__viewport').evaluate((el) => getComputedStyle(el).transform);
      const before = await viewport();
      await media.focus();
      await page.keyboard.press('ArrowRight');
      await expect(notes).toHaveAttribute('aria-selected', 'true');
      await expect(notes).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(media).toHaveAttribute('aria-selected', 'true');
      await expect(media).toBeFocused();
      await page.waitForTimeout(300);
      expect(await viewport()).toBe(before);
      // one tab stop: the tab that is not selected is out of the tab order
      await expect(notes).toHaveAttribute('tabindex', '-1');
      // the header's toggle still opens the row, and a tab keeps it open and goes back to page 1
      await area.getByRole('button', { name: /^Not tied to a step/ }).click();
      await expect(area.getByRole('button', { name: /^Not tied to a step/ })).toHaveAttribute('aria-expanded', 'true');
      await notes.click();
      await expect(area.getByRole('button', { name: /^Not tied to a step/ })).toHaveAttribute('aria-expanded', 'true');
      await expect(media).toHaveAttribute('aria-selected', 'false');
      await settled(page, '#board-area');
      // a small canvas may page the three notes, but only notes are shown
      await expect(looseNodes(page).filter({ hasText: /Loose note/ }).first()).toBeVisible();
      await expect(looseNodes(page).filter({ hasText: /Media \d/ })).toHaveCount(0);
    });

    test('an index jump to a note while on Media switches the tab and highlights the note', async ({ page }) => {
      await routeBoard(page, TWO(), { loose: true });
      await stepIn(page, true);
      const area = page.locator('#board-area');
      await area.getByRole('tab', { name: /^Media/ }).click();
      await expect(area.getByRole('tab', { name: /^Media/ })).toHaveAttribute('aria-selected', 'true');
      await settled(page, '#board-area');
      await expect(looseNodes(page).filter({ hasText: /Loose note 1/ })).toHaveCount(0);
      const nav = page.getByRole('navigation', { name: 'Board index' });
      if (!(await nav.isVisible().catch(() => false))) await page.getByRole('button', { name: /^Board index/ }).click();
      await nav.locator('li').filter({ hasText: 'Loose note 1' }).locator('button').first().click();
      await expect(area.getByRole('tab', { name: /^Notes/ })).toHaveAttribute('aria-selected', 'true');
      await expect(area.locator('.react-flow__node[data-highlighted="true"]')).toContainText('Loose note 1');
    });
  });
}

test.describe('a note that was added always shows, and the tab that shows holds still', () => {
  const AREA2 = 'A second Area';
  const added = (page: Page, title: string) => page.locator('#board-area .react-flow__node[data-highlighted="true"]').filter({ hasText: title });
  async function addNote(page: Page, title: string, area: string, step?: string) {
    await page.getByRole('button', { name: /^(Add a note|\+?\s*Note)$/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Note title...').fill(title);
    await dialog.getByLabel('Area').selectOption({ label: area });
    if (step) await dialog.getByLabel(/^Step/).selectOption(step);
    await dialog.getByRole('button', { name: 'Add note' }).click();
    await expect(dialog).toHaveCount(0);
  }

  test('from the overview, from another Area and from the Media tab, the board goes to the note and lights it up, even when the card arrives late', async ({ page }) => {
    const tracker = await routeBoard(page, TWO(), { loose: true, second: true });
    tracker.live.changesAfter = 300;
    await page.goto('/#/workspaces/demo/board');
    await page.getByTestId('view-mode-split').click().catch(() => undefined);
    await settled(page, '#board-overview');
    // 1. from the overview: it steps into the Area, to the Notes tab, and lights the note
    await expect(page.locator('#board-area')).toHaveCount(0);
    await addNote(page, 'Added from the overview', AREA);
    await expect(page.locator('#board-area')).toBeVisible();
    await expect(added(page, 'Added from the overview')).toBeVisible();
    await expect(page.locator('#board-area').getByRole('tab', { name: /^Notes/ })).toHaveAttribute('aria-selected', 'true');
    // 2. from another Area: it steps across
    await page.locator('#board-area').getByRole('button', { name: /^Board ›/ }).click();
    await settled(page, '#board-overview');
    await page.locator('#board-overview button.board-area').filter({ hasText: AREA2 }).click();
    await expect(page.locator('#board-area')).toContainText('Do the first thing of the second Area');
    await expect(page.locator('#board-area').getByRole('tab', { name: /^Notes/ })).toHaveCount(0);
    await addNote(page, 'Added from the other Area', AREA);
    await expect(page.locator('#board-area').getByRole('tab', { name: /^Notes/ })).toBeVisible();
    await expect(added(page, 'Added from the other Area')).toBeVisible();
    // 3. from the Media tab of the same Area: the tab turns to Notes
    await page.locator('#board-area').getByRole('tab', { name: /^Media/ }).click();
    await settled(page, '#board-area');
    await expect(page.locator('#board-area .react-flow__node-note')).toHaveCount(0);
    await addNote(page, 'Added from the Media tab', AREA);
    await expect(page.locator('#board-area').getByRole('tab', { name: /^Notes/ })).toHaveAttribute('aria-selected', 'true');
    await expect(added(page, 'Added from the Media tab')).toBeVisible();
    // the keyboard is on the note, not lost on the page
    await expect(page.locator('#board-area .react-flow__node').filter({ hasText: 'Added from the Media tab' }).locator(':focus')).toHaveCount(1);
  });

  test('a note added to a step shows on that step\'s row', async ({ page }) => {
    await routeBoard(page, TWO(), { loose: true });
    await stepIn(page, true);
    await addNote(page, 'Added to a step', AREA, 'c1-bug');
    await expect(added(page, 'Added to a step')).toBeVisible();
  });

  test('the tab that shows holds still when a picture arrives live', async ({ page }) => {
    const tracker = await routeBoard(page, TWO(), { loose: true });
    await stepIn(page, true);
    const area = page.locator('#board-area');
    await expect(area.getByRole('tab', { name: /^Notes/ })).toHaveAttribute('aria-selected', 'true');
    tracker.live.cards = [boardFileCard(400, 'new.png', { area: AREA_ID, step: undefined, title: 'A new AI picture', at: new Date().toISOString() }), ...tracker.live.cards];
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(area.getByRole('tab', { name: /^Media\s*39$/ })).toBeVisible({ timeout: 15_000 });
    await expect(area.getByRole('tab', { name: /^Notes/ })).toHaveAttribute('aria-selected', 'true');
    await expect(area.locator('.react-flow__node-note').first()).toBeVisible();
  });

  test('a line runs from a note to a picture on the other tab, to the row header, on hover and when its thread is followed', async ({ page }) => {
    // 32 px taller than the laptop window: the Now line takes that much of the pane, and this is about what fits below it
    await page.setViewportSize({ width: 1280, height: 832 });
    await routeBoard(page, TWO(), { loose: true, linked: true });
    await stepIn(page, true);
    const area = page.locator('#board-area');
    await expect(area.getByRole('tab', { name: /^Notes/ })).toHaveAttribute('aria-selected', 'true');
    const note = area.locator(`.react-flow__node[data-id="${boardNote(200).id}"]`);
    await note.hover();
    await expect(area.locator('.react-flow__edge[data-lit]')).toHaveCount(1);
    await expect(area.locator('.react-flow__edge[data-lit]')).toHaveAttribute('aria-label', /Not tied to a step/);
    await page.mouse.move(5, 5);
    await note.click({ position: { x: 20, y: 12 } });
    await expect(area.locator('.react-flow__edge[data-thread="active"]')).toHaveCount(1);
  });
});

test.describe('the reader closes on a row paged off the first page, and a note or a tab never leaves the board dark', () => {
  test.use({ viewport: { width: 1500, height: 840 } });
  const dimmed = (page: Page) => page.evaluate(() => ({
    thread: document.querySelectorAll('#board-area .board-flow[data-thread-active]').length,
    dim: Array.from(document.querySelectorAll('#board-area .react-flow__node-note, #board-area .react-flow__node-file, #board-area .react-flow__node-step')).filter((el) => Number(getComputedStyle(el).opacity) < 0.9).length,
  }));
  const drawn = (page: Page, title: string) => page.locator('#board-area .react-flow__node').filter({ hasText: title });
  const frames = (page: Page, n = 12) => page.evaluate((count) => new Promise<void>((resolve) => { let left = count; const tick = () => { if (--left <= 0) resolve(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }), n);

  for (const [steps, how] of [[12, 'Escape'], [9, 'the Close button']] as const) {
    test(`a row opened at a late page, the reader walked ${steps} cards back and closed by ${how}: the card last read is drawn and holds the keyboard`, async ({ page }) => {
      await page.addInitScript(() => { try { localStorage.setItem('contextspace_board_reader_layout_v1', 'side'); } catch { /* no storage */ } });
      await routeBoard(page, TWO(), { loose: true });
      await stepIn(page, false);
      const area = page.locator('#board-area');
      await area.getByRole('tab', { name: /^Media/ }).click();
      await settled(page, '#board-area');
      await area.locator('.react-flow__node-more button').first().click();
      await settled(page, '#board-area');
      for (let i = 0; i < 3; i += 1) { await area.getByRole('button', { name: 'Older cards' }).click(); await frames(page, 6); }
      await settled(page, '#board-area');
      await area.locator('.react-flow__node-file').first().click({ position: { x: 30, y: 20 } });
      const reader = page.locator('[data-board-reader]');
      await expect(reader).toBeVisible();
      await settled(page, '#board-area');
      const label = reader.getByLabel(/^Item \d+ of \d+$/);
      const position = async () => Number((await label.getAttribute('aria-label'))!.match(/Item (\d+)/)![1]);
      const first = await position();
      for (let i = 0; i < steps; i += 1) { await page.keyboard.press(']'); await frames(page, 4); }
      await expect.poll(position).toBe(first + steps);
      const last = `m${(await reader.textContent())!.match(/Media (\d+)/)![1]}.png`;
      if (how === 'Escape') await page.keyboard.press('Escape');
      else await reader.getByRole('button', { name: /^Close/ }).first().click();
      await expect(reader).toHaveCount(0);
      await settled(page, '#board-area');
      await expect(drawn(page, last).first(), 'the card last read is drawn').toBeVisible();
      await expect(drawn(page, last).first().locator(':focus'), 'the keyboard is on it').toHaveCount(1);
    });
  }

  test('a note that was added lights up alone: nothing is dim, and a press on a tab leaves nothing dim either', async ({ page }) => {
    await routeBoard(page, TWO(), { loose: true });
    await stepIn(page, false);
    const area = page.locator('#board-area');
    await page.getByRole('button', { name: /^(Add a note|\+?\s*Note)$/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Note title...').fill('A lit note');
    await dialog.getByLabel('Area').selectOption({ label: AREA });
    await dialog.getByRole('button', { name: 'Add note' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(area.locator('.react-flow__node[data-highlighted="true"]')).toContainText('A lit note');
    await frames(page, 20);
    expect(await dimmed(page)).toEqual({ thread: 0, dim: 0 });
    // a thread selected with no reader open (the note is linked to nothing, so the tab press holds none of its chain and ends it), then a press on a tab, a row control, "+N more" and the pager
    await area.locator('.react-flow__node-note').nth(1).click({ position: { x: 20, y: 12 } });
    await expect(area.locator('.board-flow[data-thread-active]')).toHaveCount(1);
    await area.getByRole('tab', { name: /^Media/ }).click();
    await settled(page, '#board-area');
    expect(await dimmed(page)).toEqual({ thread: 0, dim: 0 });
    await area.locator('.react-flow__node-file').first().click({ position: { x: 30, y: 20 } });
    await page.keyboard.press('Escape');
    await area.locator('.react-flow__node-more button').first().click();
    await settled(page, '#board-area');
    expect(await dimmed(page)).toEqual({ thread: 0, dim: 0 });
  });

  test('a note linked to a picture on the other tab: the thread stays through the tab and "+N more" until the picture shows lit', async ({ page }) => {
    await routeBoard(page, TWO(), { loose: true, linked: 37 });
    await stepIn(page, false);
    const area = page.locator('#board-area');
    await area.locator(`.react-flow__node[data-id="${boardNote(200).id}"]`).click({ position: { x: 20, y: 12 } });
    await expect(area.locator('.board-flow[data-thread-active]')).toHaveCount(1);
    await area.getByRole('tab', { name: /^Media/ }).click();
    await settled(page, '#board-area');
    await frames(page, 10);
    await expect(area.locator('.board-flow[data-thread-active]'), 'the thread stays on the tab that holds its picture').toHaveCount(1);
    const picture = area.locator('.react-flow__node[data-id="' + boardFileCard(137, 'm37.png').id + '"]');
    await expect(picture).toHaveCount(0);
    await expect(area.locator('.react-flow__node-more[data-thread="active"]'), '"+N more" that holds it is lit').toHaveCount(1);
    await area.locator('.react-flow__node-more button').first().click();
    await settled(page, '#board-area');
    for (let i = 0; i < 20 && (await picture.count()) === 0; i += 1) {
      await expect(area.locator('.board-flow[data-thread-active]'), 'the thread stays while the pager is followed').toHaveCount(1);
      await expect(area.locator('.react-flow__node-pager[data-thread="active"]'), 'the pager that holds it is lit').toHaveCount(1);
      await area.getByRole('button', { name: 'Older cards' }).click();
      await settled(page, '#board-area');
    }
    await expect(picture).toHaveAttribute('data-thread', 'active');
    await expect(area.locator('.board-flow[data-thread-active]')).toHaveCount(1);
  });
});
