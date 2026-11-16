import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { checkpoint, planFile, step, whatsNew, boardNote } from './planData';
import type { PlanFileView } from '../src/features/plan/planFile.ts';

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

interface RouteBoardOptions {
  initialPlan?: PlanFileView;
  failTick?: boolean;
  failCheck?: boolean;
}

async function routeBoard(page: Page, options: RouteBoardOptions = {}) {
  let currentPlan: PlanFileView = options.initialPlan ?? planFile({
    title: 'Reports CSV export',
    checkpoints: [
      checkpoint('Reports export to CSV', {
        check: 'npm test',
        steps: [
          step('Write the CSV writer', false),
          step('Background job queue for large exports', false),
          step('Download link in the report page', false),
        ],
      }),
    ],
  });

  const ticksReceived: Array<{ key: string; done: boolean; expected?: string }> = [];
  const checksReceived: string[] = [];

  await page.route('**/api/workspace/demo/plan', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: currentPlan });
    }
    return route.continue();
  });

  await page.route('**/api/workspace/demo/plan/steps/*/tick', async (route) => {
    if (options.failTick) {
      return route.fulfill({
        status: 500,
        json: { error: 'Failed to update step: database locked.' },
      });
    }

    const url = new URL(route.request().url());
    const segments = url.pathname.split('/');
    const key = decodeURIComponent(segments[segments.length - 2] ?? '');
    const body = route.request().postDataJSON();
    ticksReceived.push({ key, done: body.done, expected: body.expected });

    const updateStep = (s: { key: string; text: string; done: boolean }) =>
      s.key === key ? { ...s, done: body.done } : s;

    const updatedCheckpoints = currentPlan.checkpoints.map((cp) => ({
      ...cp,
      steps: cp.steps.map(updateStep),
    }));
    const updatedSteps = currentPlan.steps.map(updateStep);

    currentPlan = {
      ...currentPlan,
      checkpoints: updatedCheckpoints,
      steps: updatedSteps,
    };

    return route.fulfill({
      status: 200,
      json: {
        message: `${body.done ? 'Ticked' : 'Unticked'} "${body.expected ?? key}".`,
        plan: currentPlan,
      },
    });
  });

  await page.route('**/api/workspace/demo/plan/checkpoints/*/check', async (route) => {
    if (options.failCheck) {
      return route.fulfill({
        status: 500,
        json: { error: 'Check execution failed: process timed out.' },
      });
    }

    const url = new URL(route.request().url());
    const segments = url.pathname.split('/');
    const key = decodeURIComponent(segments[segments.length - 2] ?? '');
    checksReceived.push(key);

    const updatedCheckpoints = currentPlan.checkpoints.map((cp) =>
      cp.key === key
        ? {
            ...cp,
            proof: {
              canProgress: true,
              lastVerificationStatus: 'pass',
              lastVerificationSha: 'a91f2e0',
              at: new Date().toISOString(),
            },
          }
        : cp,
    );

    currentPlan = { ...currentPlan, checkpoints: updatedCheckpoints };

    return route.fulfill({
      status: 200,
      json: {
        message: 'The check passed.',
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
          documents: [],
        },
        lifecycle: null,
        assignment: '',
        sharedDocuments: [],
      },
    }),
  );

  await page.route('**/api/workspace/demo/news', (route) =>
    route.fulfill({
      json: whatsNew({ commits: [] }),
    }),
  );

  await page.route('**/api/workspace/demo/board', (route) =>
    route.fulfill({
      json: {
        file: 'contextspace-board.json',
        revision: 1,
        positions: {},
        cards: [
          boardNote(1, { title: 'First note', step: 'write-the-csv-writer' }),
          boardNote(2, { title: 'Second note', step: 'background-job-queue-for-large-exports' }),
        ],
      },
    }),
  );

  return {
    getPlan: () => currentPlan,
    getTicks: () => ticksReceived,
    getChecks: () => checksReceived,
  };
}

test.describe('Board Interactive Step Ticking (Milestone 1, Slice 1.2)', () => {
  test('ticking an open step row from the board calls endpoint, marks step done, and moves it to Done steps fold', async ({ page }) => {
    const tracker = await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    // Overview displays area button
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect(areaBtn).toBeVisible();

    // Step into area
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    // The open step row is present
    const stepRow = stepped.locator('[data-row-control="row:step:write-the-csv-writer"]');
    await expect(stepRow).toBeVisible();

    // The interactive checkbox on the step row
    const checkbox = stepped.locator('[data-testid="step-checkbox-write-the-csv-writer"]');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');

    // Click checkbox to mark step done
    await checkbox.click();

    // Verify endpoint called with done: true
    await expect.poll(() => tracker.getTicks().length).toBe(1);
    expect(tracker.getTicks()[0]).toMatchObject({
      key: 'write-the-csv-writer',
      done: true,
    });

    // The ticked step moves into the 'Done' fold
    const doneFold = stepped.locator('[data-row-control="row:done"]');
    await expect(doneFold).toBeVisible();
    await expect(doneFold).toContainText('1 done step');

    // The open step row is no longer prominent
    await expect(stepped.locator('[data-row-control="row:step:write-the-csv-writer"]')).toHaveCount(0);
  });

  test('unticking a step from inside the Done steps fold moves it back to open steps', async ({ page }) => {
    const initialPlan = planFile({
      title: 'Reports CSV export',
      checkpoints: [
        checkpoint('Reports export to CSV', {
          check: 'npm test',
          steps: [
            step('Write the CSV writer', true),
            step('Background job queue for large exports', false),
          ],
        }),
      ],
    });

    const tracker = await routeBoard(page, { initialPlan });
    await page.goto('/#/workspaces/demo/board');

    // Step into area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    // The done row is initially present in the area
    const doneRow = stepped.locator('[data-row-control="row:done"]');
    await expect(doneRow).toBeVisible();

    // Open the done row to view finished steps
    await doneRow.click();

    // The finished step tile inside the opened done row has a checked checkbox
    const staticStepCheckbox = stepped.locator('[data-testid="step-checkbox-write-the-csv-writer"]');
    await expect(staticStepCheckbox).toBeVisible();
    await expect(staticStepCheckbox).toHaveAttribute('aria-checked', 'true');

    // Click the checkbox to untick the step
    await staticStepCheckbox.click();

    // Verify endpoint was called with done: false
    await expect.poll(() => tracker.getTicks().length).toBe(1);
    expect(tracker.getTicks()[0]).toMatchObject({
      key: 'write-the-csv-writer',
      done: false,
    });

    // Step moves out of Done and back to open step rows
    await expect(stepped.locator('[data-row-control="row:step:write-the-csv-writer"]')).toBeVisible();
  });

  test('ticking a step updates progress bar on overview checkpoint card', async ({ page }) => {
    const tracker = await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    // Overview displays area button with 0 of 3 steps
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect(areaBtn).toBeVisible();
    await expect(areaBtn).toContainText('0 of 3 steps');

    // Initial progress bar width is 0%
    const progressBar = areaBtn.locator('.bg-muted > span');
    await expect(progressBar).toHaveAttribute('style', /width:\s*0%/);

    // Step into area and tick a step
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    const checkbox = stepped.locator('[data-testid="step-checkbox-write-the-csv-writer"]');
    await expect(checkbox).toBeVisible();
    await checkbox.click();

    await expect.poll(() => tracker.getTicks().length).toBe(1);

    // Step back to overview by clicking overview tab or navigating back
    await page.goto('/#/workspaces/demo/board');
    const updatedAreaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect(updatedAreaBtn).toBeVisible();

    // Progress text updated
    await expect(updatedAreaBtn).toContainText('1 of 3 steps');

    // Progress bar now has 33.33% width
    const updatedProgressBar = updatedAreaBtn.locator('.bg-muted > span');
    await expect(updatedProgressBar).toHaveAttribute('style', /width:\s*33/);
    const box = await updatedProgressBar.boundingBox();
    expect(box?.width).toBeGreaterThan(0);
  });

  test('running checkpoint check triggers check execution and updates check status', async ({ page }) => {
    const tracker = await routeBoard(page);
    await page.goto('/#/workspaces/demo/board');

    // Step into area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await expect(areaBtn).toBeVisible();
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    // Verify check button is visible with initial status
    const runCheckBtn = stepped.locator('[data-testid="run-check-reports-export-to-csv"]');
    await expect(runCheckBtn).toBeVisible();
    await expect(stepped).toContainText('Check configured');

    // Click Run check button directly on UI
    await runCheckBtn.click();

    // Verify check was executed
    await expect.poll(() => tracker.getChecks().length).toBe(1);
    expect(tracker.getChecks()[0]).toBe('reports-export-to-csv');

    // Check status updates to passed with commit SHA
    await expect(stepped).toContainText('Check passed on a91f2e0');
  });

  test('handles backend errors gracefully when toggling step fails', async ({ page }) => {
    await routeBoard(page, { failTick: true });
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const checkbox = stepped.locator('[data-testid="step-checkbox-write-the-csv-writer"]');
    await expect(checkbox).toBeVisible();

    // Click checkbox when backend fails
    await checkbox.click();

    // Step remains unchecked because mutation fails and rolls back
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');

    // Error alert is displayed to user
    await expect(stepped.getByRole('alert')).toContainText('Failed to update step: database locked.');

    // Row control remains available without crashing the board
    const stepRow = stepped.locator('[data-row-control="row:step:write-the-csv-writer"]');
    await expect(stepRow).toBeVisible();
  });

  test('handles check failure gracefully and displays check error message', async ({ page }) => {
    await routeBoard(page, { failCheck: true });
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();

    const stepped = page.locator('#board-area');
    const runCheckBtn = stepped.locator('[data-testid="run-check-reports-export-to-csv"]');
    await expect(runCheckBtn).toBeVisible();

    // Click Run check when backend fails
    await runCheckBtn.click();

    // Error alert is displayed to user
    await expect(stepped.getByRole('alert')).toContainText('Check execution failed: process timed out.');
  });

  test('clicking a static step card opens full-text dialog, shows status, and does not activate thread selection', async ({ page }) => {
    const initialPlan = planFile({
      title: 'Reports CSV export',
      checkpoints: [
        checkpoint('Reports export to CSV', {
          check: 'npm test',
          steps: [
            step('Write the CSV writer with streaming support and high-performance chunking', true),
            step('Background job queue for large exports', false),
          ],
        }),
      ],
    });

    await routeBoard(page, { initialPlan });
    await page.goto('/#/workspaces/demo/board');

    // Step into area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    // Open the done fold
    const doneRow = stepped.locator('[data-row-control="row:done"]');
    await doneRow.click();

    // Step trigger button is visible inside the opened row
    const stepTrigger = stepped.locator('[data-testid="step-trigger-write-the-csv-writer-with-streaming-support-and-high-performance-chunking"]');
    await expect(stepTrigger).toBeVisible();

    // Clicking anywhere on the card tile (even on its padding/edge) opens the dialog via brickPress
    const card = stepTrigger.locator('xpath=..');
    await card.click({ position: { x: 6, y: 6 } });

    // Step detail dialog is open
    const dialog = page.locator('[data-testid="step-detail-dialog"]');
    await expect(dialog).toBeVisible();

    // Displays untruncated full title inside the scrollable panel
    await expect(dialog).toContainText('Write the CSV writer with streaming support and high-performance chunking');

    // Displays status badge ("Done")
    await expect(dialog.getByText('Done', { exact: true })).toBeVisible();

    // Verify clicking did NOT trigger thread selection on the board canvas
    const flowContainer = page.locator('#board-area-flow');
    await expect(flowContainer).not.toHaveAttribute('data-thread-active', 'true');

    // Close via footer Close button
    const closeBtn = dialog.locator('[data-testid="step-dialog-close"]');
    await closeBtn.click();
    await expect(dialog).not.toBeVisible();

    // Reopen and close via top-right 'X' close button, verifying focus returns to trigger
    await stepTrigger.click();
    await expect(dialog).toBeVisible();
    const xCloseBtn = dialog.locator('button[aria-label="Close"]');
    await xCloseBtn.click();
    await expect(dialog).not.toBeVisible();
    await expect(stepTrigger).toBeFocused();

    // Reopen and close via backdrop click
    await stepTrigger.click();
    await expect(dialog).toBeVisible();
    const backdrop = page.locator('[data-slot="dialog-backdrop"]');
    await backdrop.click({ position: { x: 10, y: 10 }, force: true });
    await expect(dialog).not.toBeVisible();

    // Trigger can be reopened and closed via Escape
    await stepTrigger.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(stepTrigger).toBeFocused();
  });

  test('step dialog renders rich markdown and clicking checkbox toggles without opening dialog', async ({ page }) => {
    const initialPlan = planFile({
      title: 'Reports CSV export',
      checkpoints: [
        checkpoint('Reports export to CSV', {
          check: 'npm test',
          steps: [
            step('Create `parser.ts` with **high throughput** and [specs](https://example.com)', true),
          ],
        }),
      ],
    });

    const tracker = await routeBoard(page, { initialPlan });
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    const doneRow = stepped.locator('[data-row-control="row:done"]');
    await doneRow.click();

    const stepTrigger = stepped.locator('[data-testid^="step-trigger-create-parser-ts"]');
    await expect(stepTrigger).toBeVisible();

    // Clicking the step trigger opens the dialog with markdown formatting
    await stepTrigger.click();
    const dialog = page.locator('[data-testid="step-detail-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('code')).toContainText('parser.ts');
    await expect(dialog.locator('strong')).toContainText('high throughput');
    const link = dialog.locator('a');
    await expect(link).toContainText('specs');
    await expect(link).toHaveAttribute('href', 'https://example.com');

    // Close the dialog
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // Clicking the checkbox on the card toggles the step WITHOUT opening the dialog
    const checkbox = stepped.locator('[data-testid^="step-checkbox-create-parser-ts"]');
    await checkbox.click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(() => tracker.getTicks().length).toBe(1);
  });

  test('keyboard access opens dialog via Enter and toggles step inside dialog', async ({ page }) => {
    const initialPlan = planFile({
      title: 'Reports CSV export',
      checkpoints: [
        checkpoint('Reports export to CSV', {
          check: 'npm test',
          steps: [
            step('Write the CSV writer with streaming support and high-performance chunking', true),
          ],
        }),
      ],
    });

    const tracker = await routeBoard(page, { initialPlan });
    await page.goto('/#/workspaces/demo/board');

    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'Reports export to CSV' });
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    const doneRow = stepped.locator('[data-row-control="row:done"]');
    await doneRow.click();

    const stepTrigger = stepped.locator('[data-testid="step-trigger-write-the-csv-writer-with-streaming-support-and-high-performance-chunking"]');
    await stepTrigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.locator('[data-testid="step-detail-dialog"]');
    await expect(dialog).toBeVisible();

    // Toggle from inside the dialog
    const toggleBtn = dialog.locator('[data-testid="step-dialog-toggle"]');
    await expect(toggleBtn).toContainText('Mark as open');
    await toggleBtn.click();

    // Verify tick was sent to backend
    await expect.poll(() => tracker.getTicks().length).toBe(1);
    expect(tracker.getTicks()[0]).toMatchObject({
      key: 'write-the-csv-writer-with-streaming-support-and-high-performance-chunking',
      done: false,
    });
  });
});
