import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { checkpoint, decision, planFile, step, whatsNew } from './planData';
import type { WorkDocument } from '../src/types.ts';

const workspace = {
  id: 'demo',
  branchName: 'demo',
  name: 'Reports CSV export',
  description: 'Add CSV export to reports',
  repos: [],
  assistants: [],
  workspacePath: '/tmp/demo',
  createdAt: '2026-10-01T00:00:00Z',
};

test.use({
  workspacesData: [[workspace], { option: true }],
  viewport: { width: 1280, height: 800 },
});

const document = (title: string, fields: Partial<WorkDocument> = {}): WorkDocument => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  title,
  role: 'design',
  status: 'approved',
  scope: {},
  summary: `About ${title}.`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...fields,
});

async function routeBoard(
  page: Page,
  options: {
    suggested?: string[];
    decisions?: Array<ReturnType<typeof decision>>;
  } = {},
) {
  const decs = options.decisions ?? [
    decision('Which time zone should export timestamps use?', {
      suggested: options.suggested ?? ['UTC', 'Local time (browser)', 'Account setting'],
    }),
  ];

  let currentPlan = planFile({
    title: 'Reports CSV export',
    checkpoints: [
      checkpoint('Report rows load fast', { done: true, steps: [step('Query the report rows', true)] }),
      checkpoint('Reports export to CSV', {
        steps: [
          step('Write the CSV writer', true),
          step('Background job queue for large exports'),
          step('Download link in the report page'),
        ],
        decisions: decs,
      }),
    ],
  });

  const answersReceived: Array<{ key: string; answer: string; expected?: string }> = [];

  await page.route('**/api/workspace/demo/plan', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: currentPlan });
    }
    return route.continue();
  });

  await page.route('**/api/workspace/demo/plan/decisions/*/answer', async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/');
    const key = decodeURIComponent(segments[segments.length - 2] ?? '');
    const body = route.request().postDataJSON();
    answersReceived.push({ key, answer: body.answer, expected: body.expected });

    // Update currentPlan
    const updatedCheckpoints = currentPlan.checkpoints.map((cp) => ({
      ...cp,
      decisions: cp.decisions.map((d) => (d.key === key ? { ...d, done: true, answer: body.answer } : d)),
    }));
    const updatedWaiting = currentPlan.waiting.filter((k) => k !== key);
    currentPlan = { ...currentPlan, checkpoints: updatedCheckpoints, waiting: updatedWaiting };

    return route.fulfill({
      status: 200,
      json: {
        message: `Answered "${body.expected ?? key}".`,
        plan: currentPlan,
      },
    });
  });

  await page.route('**/api/workspace/demo/work', (route) =>
    route.fulfill({
      json: {
        guidance: {
          version: 1,
          revision: 1,
          workType: 'feature',
          size: 'standard',
          assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' },
          documents: [document('Export requirements', { role: 'requirements' })],
        },
        lifecycle: null,
        assignment: '',
        sharedDocuments: [],
      },
    }),
  );

  await page.route('**/api/workspace/demo/news', (route) =>
    route.fulfill({
      json: whatsNew({
        commits: [
          {
            repo: 'billing api',
            more: 0,
            commits: [{ sha: 'a91f2e0c4d5b', author: 'Anna', subject: 'Write the CSV writer', at: new Date().toISOString() }],
          },
        ],
      }),
    }),
  );

  await page.route('**/api/workspace/demo/board', (route) =>
    route.fulfill({
      json: {
        file: 'contextspace-board.json',
        revision: 1,
        positions: {},
        cards: [],
      },
    }),
  );

  return { getPlan: () => currentPlan, getAnswers: () => answersReceived };
}

/** The free answer is in the dialog that the quiet button at the end of the card's answers opens. */
async function openAnswerDialog(page: Page, frame: Locator) {
  await frame.getByTestId('decision-more-answers').first().click();
  const dialog = page.getByTestId('decision-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Board Decision Answering (Milestone 1, Slice 1.1)', () => {
  test('displays decision question, quick-action suggested option buttons, and answer input inside the waiting frame', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    // Overview displays area button
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect(areaBtn).toBeVisible();

    // Step into area
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    // The Waits for you frame is visible
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();

    // Decision question is displayed
    await expect(frame).toContainText('Which time zone should export timestamps use?');

    // Quick-action option buttons from Suggested: Option 1 · Option 2 are visible
    const optUtc = frame.getByRole('button', { name: 'UTC' });
    const optLocal = frame.getByRole('button', { name: 'Local time (browser)' });
    const optAccount = frame.getByRole('button', { name: 'Account setting' });
    await expect(optUtc).toBeVisible();
    await expect(optLocal).toBeVisible();
    await expect(optAccount).toBeVisible();

    // The card has no input: the quiet button at the end of the answers opens the dialog that has it
    await expect(frame.getByPlaceholder('Your answer')).toHaveCount(0);
    const dialog = await openAnswerDialog(page, frame);
    const input = dialog.getByPlaceholder('Your answer');
    await expect(input).toBeVisible();
    const answerBtn = dialog.getByRole('button', { name: 'Answer', exact: true });
    await expect(answerBtn).toBeVisible();
    await expect(answerBtn).toBeDisabled(); // Empty input has disabled button
  });

  test('answers a decision via quick-action option button: calls answer endpoint and immediately removes card from canvas', async ({ page }) => {
    const tracker = await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();

    // Click quick-action button 'UTC'
    const optUtc = frame.getByRole('button', { name: 'UTC' });
    await optUtc.click();

    // Decision immediately disappears from canvas / lane
    await expect(stepped.getByRole('article', { name: 'Waits for you' })).toHaveCount(0);

    // Verify answer was submitted to endpoint
    expect(tracker.getAnswers()).toEqual([
      {
        key: 'which-time-zone-should-export-timestamps-use',
        answer: 'UTC',
        expected: 'Which time zone should export timestamps use?',
      },
    ]);
  });

  test('answers a decision whose question is over 300 characters and echoes all of it as `expected`', async ({ page }) => {
    const question = `Which time zone should export timestamps use ${'when the reader is in another country and the file is opened later, '.repeat(8)}?`;
    expect(question.length).toBeGreaterThan(500);
    const tracker = await routeBoard(page, { decisions: [decision(question, { suggested: ['UTC', 'Local time (browser)'] })] });
    await page.goto('/#/workspaces/demo/board');
    await page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' }).click();
    const stepped = page.locator('#board-area');
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await frame.getByRole('button', { name: 'UTC' }).click();
    await expect(stepped.getByRole('article', { name: 'Waits for you' })).toHaveCount(0);
    expect(tracker.getAnswers().map((a) => [a.answer, a.expected])).toEqual([['UTC', question]]);
  });

  for (const [width, height] of [[1100, 700], [1280, 800], [420, 800], [1280, 500], [420, 600]] as const) {
    test(`a 2,000-character question, four long suggested answers and a long detail keep every part usable at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const question = `Which way should the whole export work ${'and what must it keep for the person who opens it later, '.repeat(40)}`.slice(0, 1990).trim() + '?';
      const suggested = ['One', 'Two', 'Three', 'Four'].map((n) => `${n}: ${'a long suggested answer that goes on and on about the details, '.repeat(8)}`.trim());
      const detail = Array.from({ length: 30 }, (_, i) => `Detail paragraph ${i + 1}: what the person needs to know before choosing, written out so that it runs for a while.`).join('\n\n');
      const tracker = await routeBoard(page, { decisions: [{ ...decision(question, { suggested }), detail }] });
      await page.goto('/#/workspaces/demo/board');
      await page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' }).click();
      // in a short window the Area is a list of rows: the waiting row opens first
      const row = page.getByRole('button', { name: /^Waits for you/ });
      if (await row.count()) await row.first().click();
      const frame = page.locator('#board-area').getByRole('article', { name: 'Waits for you' });
      const dialog = await openAnswerDialog(page, frame);
      await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      const input = dialog.getByPlaceholder('Your answer');
      await input.fill('My own answer');
      const answer = dialog.getByRole('button', { name: 'Answer', exact: true });
      for (const target of [input, answer]) {
        await expect(target).toBeInViewport();
        const hit = await target.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return Boolean(top && (top === el || el.contains(top)));
        });
        expect(hit).toBe(true);
      }
      const box = await dialog.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);

      // every part keeps readable room: about three lines each
      const heights = await dialog.evaluate((root) => {
        const h = (sel: string) => (root.querySelector(sel) as HTMLElement).clientHeight;
        return { question: h('[data-testid="decision-question"]'), detail: h('[data-testid="decision-detail"]'), answers: h('[aria-label="All suggested answers"]') };
      });
      expect(heights.question, 'question room').toBeGreaterThanOrEqual(64);
      expect(heights.detail, 'detail room').toBeGreaterThanOrEqual(64);
      expect(heights.answers, 'suggestions room').toBeGreaterThanOrEqual(56);

      // the keyboard reaches each scrolling region and scrolls it to its end, with no script scrolling
      const seen = new Set<string>();
      const regionOf = () => page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a) return null;
        const id = a.getAttribute('data-testid') === 'decision-question' ? 'question' : a.getAttribute('data-testid') === 'decision-detail' ? 'detail' : a.getAttribute('aria-label') === 'All suggested answers' ? 'answers' : null;
        return id;
      });
      for (let i = 0; i < 25 && seen.size < 3; i += 1) {
        const region = await regionOf();
        if (region && !seen.has(region)) {
          seen.add(region);
          await page.keyboard.press('End');
          await expect.poll(() => page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.scrollHeight > a.clientHeight && a.scrollTop + a.clientHeight >= a.scrollHeight - 1; }), { message: `${region} scrolls to its end by keyboard` }).toBe(true);
        }
        await page.keyboard.press('Tab');
      }
      expect([...seen].sort()).toEqual(['answers', 'detail', 'question']);

      await answer.click();
      await expect(page.getByTestId('decision-dialog')).toHaveCount(0);
      expect(tracker.getAnswers().map((a) => [a.answer, a.expected])).toEqual([['My own answer', question]]);
    });
  }

  const reachable = (target: Locator) => target.evaluate((el) => {
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.top >= 0 && r.bottom <= innerHeight && Boolean(top && (top === el || el.contains(top)));
  });
  const longDialogCase = async (page: Page, fail?: (question: string) => string) => {
    await page.setViewportSize({ width: 420, height: 600 });
    const question = `Which way should the whole export work ${'and what must it keep for the person who opens it later, '.repeat(40)}`.slice(0, 1990).trim() + '?';
    const suggested = ['One', 'Two', 'Three', 'Four'].map((n) => `${n}: ${'a long suggested answer that goes on and on about the details, '.repeat(8)}`.trim());
    const detail = Array.from({ length: 30 }, (_, i) => `Detail paragraph ${i + 1}: what the person needs to know before choosing, written out so that it runs for a while.`).join('\n\n');
    const tracker = await routeBoard(page, { decisions: [{ ...decision(question, { suggested }), detail }] });
    if (fail) await page.route('**/api/workspace/demo/plan/decisions/*/answer', (route) => route.fulfill({ status: 409, json: { error: fail(question) } }));
    await page.goto('/#/workspaces/demo/board');
    await page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' }).click();
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    const frame = page.locator('#board-area').getByRole('article', { name: 'Waits for you' });
    const dialog = await openAnswerDialog(page, frame);
    await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    return { dialog, question, tracker };
  };

  test('with a 24 px root font the detail keeps room and nothing in the dialog is out of reach', async ({ page }) => {
    const { dialog } = await longDialogCase(page);
    await dialog.getByPlaceholder('Your answer').fill('My own answer');
    expect(await dialog.getByTestId('decision-detail').evaluate((el) => el.clientHeight), 'detail room').toBeGreaterThanOrEqual(64);
    expect(await reachable(dialog.getByRole('button', { name: 'Answer', exact: true }))).toBe(true);
    expect(await reachable(dialog.getByRole('button', { name: 'Close', exact: true }).last())).toBe(true);
  });

  test('a 409 that repeats a 2,000-character question keeps its alert small and the buttons reachable', async ({ page }) => {
    const { dialog } = await longDialogCase(page, (q) => `"${q}" changed in PLAN.md since it was read. Read the plan again.`);
    await dialog.getByPlaceholder('Your answer').fill('My own answer');
    await dialog.getByRole('button', { name: 'Answer', exact: true }).click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('changed in PLAN.md since it was read');
    expect(await alert.evaluate((el) => el.clientHeight), 'alert height is capped (6rem)').toBeLessThanOrEqual(150);
    expect(await alert.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await reachable(dialog.getByRole('button', { name: 'Answer', exact: true }))).toBe(true);
    expect(await reachable(dialog.getByRole('button', { name: 'Close', exact: true }).last())).toBe(true);
    expect(await dialog.getByTestId('decision-detail').evaluate((el) => el.clientHeight), 'detail room').toBeGreaterThanOrEqual(64);
  });

  test('answers a decision via typing custom text in the input and clicking Answer', async ({ page }) => {
    const tracker = await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();

    const dialog = await openAnswerDialog(page, frame);
    const input = dialog.getByPlaceholder('Your answer');
    const answerBtn = dialog.getByRole('button', { name: 'Answer', exact: true });

    // Type custom answer
    await input.fill('Europe/Stockholm');
    await expect(answerBtn).toBeEnabled();

    // Submit answer
    await answerBtn.click();

    // Decision immediately disappears from canvas
    await expect(stepped.getByRole('article', { name: 'Waits for you' })).toHaveCount(0);

    // Verify answer was sent to backend
    expect(tracker.getAnswers()).toEqual([
      {
        key: 'which-time-zone-should-export-timestamps-use',
        answer: 'Europe/Stockholm',
        expected: 'Which time zone should export timestamps use?',
      },
    ]);
  });

  test('when multiple decisions wait, answering one decision leaves the remaining decisions in the waiting frame', async ({ page }) => {
    const dec1 = decision('First question?', { suggested: ['Alpha', 'Beta'] });
    const dec2 = decision('Second question?', { suggested: ['Gamma', 'Delta'] });

    const tracker = await routeBoard(page, { decisions: [dec1, dec2] });
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();

    await expect(frame).toContainText('First question?');
    await expect(frame).toContainText('Second question?');

    // Answer the first question by clicking 'Alpha'
    await frame.getByRole('button', { name: 'Alpha' }).click();

    // First question is gone, but second question remains in Waits for you frame
    await expect(frame).not.toContainText('First question?');
    await expect(frame).toContainText('Second question?');
    expect(tracker.getAnswers()).toEqual([
      { key: 'first-question', answer: 'Alpha', expected: 'First question?' },
    ]);

    // Now answer the second question by typing custom text
    const dialog = await openAnswerDialog(page, frame);
    await dialog.getByPlaceholder('Your answer').fill('Custom answer for two');
    await dialog.getByRole('button', { name: 'Answer', exact: true }).click();

    // All decisions answered, Waits for you frame disappears
    await expect(stepped.getByRole('article', { name: 'Waits for you' })).toHaveCount(0);
    expect(tracker.getAnswers()).toHaveLength(2);
  });

  test('shows error message if answering fails on the backend, without losing the card', async ({ page }) => {
    await routeBoard(page);

    // Override the answer route to fail
    await page.route('**/api/workspace/demo/plan/decisions/*/answer', (route) =>
      route.fulfill({
        status: 409,
        json: { error: 'Conflict: plan was modified in another session.' },
      }),
    );

    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();

    // Click 'UTC' option button
    await frame.getByRole('button', { name: 'UTC' }).click();

    // Error is shown and card remains visible
    await expect(frame.getByRole('alert')).toContainText('Conflict: plan was modified in another session.');
    await expect(frame).toContainText('Which time zone should export timestamps use?');
  });

  test('submits answer via pressing Enter key in the custom answer input', async ({ page }) => {
    const tracker = await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();

    const dialog = await openAnswerDialog(page, frame);
    const input = dialog.getByPlaceholder('Your answer');
    await input.fill('Custom via Enter');
    await input.press('Enter');

    // Decision card disappears
    await expect(stepped.getByRole('article', { name: 'Waits for you' })).toHaveCount(0);
    expect(tracker.getAnswers()).toEqual([
      {
        key: 'which-time-zone-should-export-timestamps-use',
        answer: 'Custom via Enter',
        expected: 'Which time zone should export timestamps use?',
      },
    ]);
  });

  test('extracts suggested options from detail text when suggested array is empty, and formats markdown in question', async ({ page }) => {
    const dec = decision('Which **delimiter** should `CSV` use?', {
      suggested: [],
      detail: 'Suggested: Comma (,) · Tab (\\t) · Semicolon (;)\nIf no answer: Comma',
    });
    const tracker = await routeBoard(page, { decisions: [dec] });
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();

    // Markdown rendered (strong and code tags)
    await expect(frame.locator('strong')).toHaveText('delimiter');
    await expect(frame.locator('code')).toHaveText('CSV');

    // Options extracted from detail
    await expect(frame.getByRole('button', { name: 'Comma (,)' })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Tab (\\t)' })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Semicolon (;)' })).toBeVisible();

    // Click 'Comma (,)'
    await frame.getByRole('button', { name: 'Comma (,)' }).click();
    await expect(stepped.getByRole('article', { name: 'Waits for you' })).toHaveCount(0);
    expect(tracker.getAnswers()).toHaveLength(1);
    expect(tracker.getAnswers()[0]?.answer).toBe('Comma (,)');
  });

  test('captures live screenshot of interactive decision card with options and input', async ({ page }) => {
    await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const card = stepped.locator('[data-testid^="decision-card-"]');
    await expect(card).toBeVisible();


    // Click an option button
    await card.getByRole('button', { name: 'UTC' }).click();
    await expect(card).toHaveCount(0);

  });
});
