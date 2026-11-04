import type { Page } from '@playwright/test';
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

    // Answer text input and Answer button are visible
    const input = frame.getByPlaceholder('Your answer');
    await expect(input).toBeVisible();
    const answerBtn = frame.getByRole('button', { name: 'Answer' });
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

  test('answers a decision via typing custom text in the input and clicking Answer', async ({ page }) => {
    const tracker = await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const frame = stepped.getByRole('article', { name: 'Waits for you' });
    await expect(frame).toBeVisible();

    const input = frame.getByPlaceholder('Your answer');
    const answerBtn = frame.getByRole('button', { name: 'Answer' });

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
    const input = frame.getByPlaceholder('Your answer');
    await input.fill('Custom answer for two');
    await frame.getByRole('button', { name: 'Answer' }).click();

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

    const input = frame.getByPlaceholder('Your answer');
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

    await page.screenshot({ path: '/home/anton-patron/Dev/workspaces/new-canvas-interaction/board-pictures/live-board-decision-card.png' });
    await page.screenshot({ path: '/home/anton-patron/.gemini/antigravity-cli/brain/479352b4-55ad-4858-b77c-8d4608fbaa81/live-board-decision-card.png' });

    // Click an option button
    await card.getByRole('button', { name: 'UTC' }).click();
    await expect(card).toHaveCount(0);

    await page.screenshot({ path: '/home/anton-patron/Dev/workspaces/new-canvas-interaction/board-pictures/live-board-decision-answered.png' });
    await page.screenshot({ path: '/home/anton-patron/.gemini/antigravity-cli/brain/479352b4-55ad-4858-b77c-8d4608fbaa81/live-board-decision-answered.png' });
  });
});
