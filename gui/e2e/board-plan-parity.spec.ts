import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { checkpoint, planFile, step, whatsNew } from './planData';
import type { PlanFileChangeInput, PlanFileView } from '../src/features/plan/planFile.ts';

const workspace = {
  id: 'parity-ws',
  branchName: 'parity-ws',
  name: 'CSV Reports Feature',
  description: 'Add CSV export to reports',
  repos: [],
  assistants: [],
  workspacePath: '/tmp/parity-ws',
  createdAt: '2026-10-01T00:00:00Z',
};

test.use({
  workspacesData: [[workspace], { option: true }],
  viewport: { width: 1280, height: 800 },
});

interface RouteSetupOptions {
  initialPlan?: PlanFileView;
}

async function setupBoardMocks(page: Page, options: RouteSetupOptions = {}) {
  let currentPlan: PlanFileView = options.initialPlan ?? planFile({
    title: 'CSV Reports Feature',
    checkpoints: [
      checkpoint('CSV Export Engine', {
        check: 'npm test',
        steps: [
          step('Create stream parser', false),
          step('Buffer records to disk', false),
        ],
      }),
    ],
  });

  const mutations: PlanFileChangeInput[] = [];

  await page.route('**/api/workspace/parity-ws/plan', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: currentPlan });
    }
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { change: PlanFileChangeInput };
      mutations.push(body.change);

      if (body.change.type === 'add') {
        const addedStep = {
          key: body.change.step.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          text: body.change.step,
          done: false,
        };

        if (body.change.checkpoint) {
          currentPlan = {
            ...currentPlan,
            checkpoints: currentPlan.checkpoints.map((cp) =>
              cp.key === body.change.checkpoint
                ? { ...cp, steps: [...cp.steps, addedStep] }
                : cp
            ),
          };
        } else {
          currentPlan = {
            ...currentPlan,
            steps: [...currentPlan.steps, addedStep],
          };
        }
      }

      return route.fulfill({
        status: 200,
        json: {
          message: `Added step "${body.change.step}".`,
          plan: currentPlan,
        },
      });
    }
    return route.continue();
  });

  await page.route('**/api/workspace/parity-ws/work', (route) =>
    route.fulfill({
      json: {
        workspace: { branchName: 'parity-ws', name: 'CSV Reports Feature' },
        documents: [],
      },
    }),
  );

  await page.route('**/api/workspace/parity-ws/whats-new', (route) =>
    route.fulfill({
      json: whatsNew({
        basis: 'last-look',
        empty: true,
      }),
    }),
  );

  await page.route('**/api/workspace/parity-ws/board', (route) =>
    route.fulfill({
      json: {
        file: 'contextspace-board.json',
        revision: 1,
        positions: {},
        cards: [],
      },
    }),
  );

  return {
    getMutations: () => mutations,
    getPlan: () => currentPlan,
  };
}

test.describe('Plan Tab Deprecation & Board Redirection (Slice 1.3)', () => {
  test('navigating to /workspaces/:id without section defaults to Board home', async ({ page }) => {
    await setupBoardMocks(page);
    await page.goto('/#/workspaces/parity-ws');

    // The Board canvas overview should be rendered as default home
    const boardOverview = page.locator('#board-overview');
    await expect(boardOverview).toBeVisible();

    // The rail should mark Board as the active section
    const railNav = page.getByRole('navigation', { name: 'Workspace' });
    await expect(railNav).toBeVisible();
    const boardRailItem = railNav.getByRole('link', { name: /Board/i });
    await expect(boardRailItem).toBeVisible();
    await expect(boardRailItem).toHaveAttribute('aria-current', 'page');

    await page.screenshot({ path: '/home/anton-patron/Dev/workspaces/new-canvas-interaction/board-pictures/live-board-default-landing.png' });
    await page.screenshot({ path: '/home/anton-patron/.gemini/antigravity-cli/brain/479352b4-55ad-4858-b77c-8d4608fbaa81/live-board-default-landing.png' });
  });

  test('navigating to legacy /workspaces/:id/plan aliases and resolves directly to Board', async ({ page }) => {
    await setupBoardMocks(page);
    await page.goto('/#/workspaces/parity-ws/plan');

    // Should resolve to the Board overview
    const boardOverview = page.locator('#board-overview');
    await expect(boardOverview).toBeVisible();

    // Rail should show Board selected
    const railNav = page.getByRole('navigation', { name: 'Workspace' });
    const boardRailItem = railNav.getByRole('link', { name: /Board/i });
    await expect(boardRailItem).toHaveAttribute('aria-current', 'page');
  });

  test('adding a step via the Board checkpoint card sends the { type: \'add\', step, checkpoint } mutation and updates the plan', async ({ page }) => {
    const tracker = await setupBoardMocks(page);
    await page.goto('/#/workspaces/parity-ws/board');

    // Locate the area button on Level 0
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'CSV Export Engine' });
    await expect(areaBtn).toBeVisible();

    // Step into area
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    // Verify stepped area displays Add step trigger
    const addStepTrigger = stepped.locator('[data-testid="area-add-step-trigger"]');
    await expect(addStepTrigger).toBeVisible();

    // Click trigger to expand form
    await addStepTrigger.click();

    // The inline form panel is visible
    const formPanel = stepped.locator('[data-testid="area-add-step-panel"]');
    await expect(formPanel).toBeVisible();

    const input = stepped.locator('[data-testid="area-add-step-input"]');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    // Type new step text and submit
    await input.fill('Write gzip compressor');
    await page.screenshot({ path: '/home/anton-patron/Dev/workspaces/new-canvas-interaction/board-pictures/live-board-add-step.png' });
    await page.screenshot({ path: '/home/anton-patron/.gemini/antigravity-cli/brain/479352b4-55ad-4858-b77c-8d4608fbaa81/live-board-add-step.png' });
    await stepped.locator('[data-testid="area-add-step-submit"]').click();

    // Form should close after successful submission
    await expect(formPanel).not.toBeVisible();

    // Verify mutation payload
    await expect.poll(() => tracker.getMutations().length).toBe(1);
    expect(tracker.getMutations()[0]).toMatchObject({
      type: 'add',
      step: 'Write gzip compressor',
      checkpoint: 'csv-export-engine',
    });
  });

  test('adding a step via header action button in stepped Area sends the mutation and updates the plan', async ({ page }) => {
    const tracker = await setupBoardMocks(page);
    await page.goto('/#/workspaces/parity-ws/board');

    // Step into area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'CSV Export Engine' });
    await expect(areaBtn).toBeVisible();
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    // Open add step via header action button
    const stepBtn = stepped.locator('[data-testid="area-add-step-button"]');
    await expect(stepBtn).toBeVisible();
    await stepBtn.click();

    const formPanel = stepped.locator('[data-testid="area-add-step-panel"]');
    await expect(formPanel).toBeVisible();

    const input = stepped.locator('[data-testid="area-add-step-input"]');
    await input.fill('Write gzip compressor');
    await stepped.locator('[data-testid="area-add-step-submit"]').click();

    await expect(formPanel).not.toBeVisible();
    await expect.poll(() => tracker.getMutations().length).toBe(1);
    expect(tracker.getMutations()[0]).toMatchObject({
      type: 'add',
      step: 'Write gzip compressor',
      checkpoint: 'csv-export-engine',
    });
  });

  test('cancelling or escaping inline add step form in stepped Area closes cleanly without mutation', async ({ page }) => {
    const tracker = await setupBoardMocks(page);
    await page.goto('/#/workspaces/parity-ws/board');

    // Step into area
    const areaBtn = page.locator('#board-overview button.board-area').filter({ hasText: 'CSV Export Engine' });
    await expect(areaBtn).toBeVisible();
    await areaBtn.click();
    const stepped = page.locator('#board-area');
    await expect(stepped).toBeVisible();

    // Open add step via header action button
    const stepBtn = stepped.locator('[data-testid="area-add-step-button"]');
    await expect(stepBtn).toBeVisible();
    await stepBtn.click();

    const formPanel = stepped.locator('[data-testid="area-add-step-panel"]');
    await expect(formPanel).toBeVisible();

    // Press Escape to cancel
    const input = stepped.locator('[data-testid="area-add-step-input"]');
    await input.fill('Draft step text');
    await input.press('Escape');

    await expect(formPanel).not.toBeVisible();
    expect(tracker.getMutations().length).toBe(0);
  });
});
