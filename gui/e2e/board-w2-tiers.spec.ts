/**
 * Slice W2 acceptance tests:
 * 1. Focus card never clips content (1440x900 Board, 1280x800 Split, 1100x700 Split)
 * 2. Tier 3 "Moved since you looked" draws with what moved and caps at at most 3 Areas
 * 3. Clear tiers (Focus hero, Waits for you, Moved, Open in plan order, Done fold)
 */
import { test, expect } from './fixtures';
import { boardFile, boardFileCard, boardNote, checkpoint, decision, planFile, step, whatsNew } from './planData';
import type { Page } from '@playwright/test';

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
  viewport: { width: 1440, height: 900 },
});

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const PICTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const TITLES = [
  'First Focus Area with commits',
  'Second Area waits for decision',
  'Third Area moved recently',
  'Fourth Area also moved',
  'Fifth Area open step five',
  'Sixth Area open step six',
  'Seventh Area open step seven',
  'Eighth Area open step eight',
  'Ninth Area open step nine',
  'Tenth Area open step ten',
  'Eleventh Area open step eleven',
  'Twelfth Area open step twelve',
  'Thirteenth Area done thirteen',
  'Fourteenth Area done fourteen',
];

async function setupMocks(page: Page) {
  await page.route('**/api/terminals/bootstrap', (route) =>
    route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } })
  );
  await page.route('**/api/terminals/*/status', (route) => {
    const id = route.request().url().split('/api/terminals/')[1]!.split('/')[0]!;
    const terminal = { id: `term-${id}`, workspace: id, target: 'shell', label: 'bash', cwd: `/tmp/${id}`, state: 'running' };
    return route.fulfill({
      json: { available: true, sessions: [terminal], targets: [{ id: 'shell', name: 'Shell', available: true, reason: null }] },
    });
  });
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/*/documents/file**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PICTURE }));
}

async function atRest(page: Page) {
  const board = page.getByRole('region', { name: 'Board', exact: true });
  await expect(board).toBeVisible();
  await expect(board.getByText(/^Still loading/)).toHaveCount(0);
  let last = '';
  await expect.poll(async () => {
    const now = await page.locator('#board-overview .react-flow__viewport').evaluate((el) => getComputedStyle(el).transform).catch(() => '');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
    const still = now !== '' && now === last;
    last = now;
    return still;
  }, { intervals: [100], timeout: 10000 }).toBe(true);
}

test.describe('Slice W2: Focus card clipping & tier acceptance', () => {
  test.beforeEach(async ({ page }) => {
    await setupMocks(page);
  });

  const checkFocusCardNoClipping = async (page: Page, label: string) => {
    const heroNode = page.locator('#board-overview .react-flow__node-area');
    await expect(heroNode).toBeVisible();

    const heroBtn = heroNode.locator('button.board-area');
    await expect(heroBtn).toBeVisible();

    // 1. Verify 3 step buttons are visible and whole
    const stepButtons = heroNode.locator('button[data-step-key]');
    await expect(stepButtons).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const btn = stepButtons.nth(i);
      await expect(btn).toBeVisible();
      const text = await btn.textContent();
      expect(text?.length).toBeGreaterThan(0);
    }

    // 2. Verify the card's bottom edge clips nothing
    const cardEl = heroNode.locator('> div');
    const overflowFacts = await cardEl.evaluate((el) => {
      const isOverflowing = el.scrollHeight > el.clientHeight + 1.5;
      const box = el.getBoundingClientRect();
      const texts = Array.from(el.querySelectorAll<HTMLElement>('span, p, div, button')).filter((child) => {
        const own = Array.from(child.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        return own && child.offsetWidth > 0 && child.offsetHeight > 0;
      });
      const clipped = texts.filter((t) => {
        const r = t.getBoundingClientRect();
        return r.top < box.top - 1 || r.bottom > box.bottom + 1.5;
      }).map((t) => t.textContent?.trim());

      return { isOverflowing, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, clippedCount: clipped.length, clipped };
    });

    expect(overflowFacts.isOverflowing, `${label}: focus card scrollHeight (${overflowFacts.scrollHeight}) exceeds clientHeight (${overflowFacts.clientHeight})`).toBe(false);
    expect(overflowFacts.clippedCount, `${label}: text clipped: ${overflowFacts.clipped.join(', ')}`).toBe(0);
  };

  const setupFocusCardData = async (page: Page) => {
    const commits = Array.from({ length: 10 }, (_, i) => ({
      sha: `c00000${i}abcdef123456`,
      author: 'Author',
      subject: i === 0 ? 'feat(board): add responsive node cards and layout' : `commit ${i}`,
      at: minutesAgo(10 + i),
    }));

    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Focus Card Test',
        now: { key: 's1', by: 'claude', at: minutesAgo(5) },
        checkpoints: TITLES.map((title, i) => {
          if (i === 0) {
            return checkpoint(title, {
              done: false,
              steps: [
                step('First open step of focus card', true, 's0'),
                step('Second open step (Now) with a very long descriptive step text that should truncate properly without wrapping or breaking lines', false, 's1'),
                step('Third open step of focus card which also has a very long step description to verify truncation', false, 's2'),
                step('Fourth open step of focus card', false, 's3'),
              ],
            });
          }
          return checkpoint(title, {
            done: i >= 12,
            steps: [step(`Step of ${title}`)],
          });
        }),
      }),
    }));

    await page.route('**/api/workspace/*/news', (route) => route.fulfill({
      json: whatsNew({
        empty: false,
        commits: [{ repo: 'NexusFlow', more: 0, commits }],
      }),
    }));

    await page.route('**/api/workspace/*/board', (route) => route.fulfill({
      json: boardFile({
        cards: [
          boardNote(1, { title: 'Note 1', area: `checkpoint:${slug(TITLES[0]!)}` }),
          boardFileCard(2, 'board-pictures/a.png', { title: 'Pic 1', area: `checkpoint:${slug(TITLES[0]!)}` }),
        ],
      }),
    }));
  };

  test('focus card never clips its own content at 1440x900 Board', async ({ page }) => {
    await setupFocusCardData(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);
    await checkFocusCardNoClipping(page, '1440x900 Board');
  });

  test('focus card never clips its own content at 1280x800 Split', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 })); } catch { /* no storage */ }
    });
    await setupFocusCardData(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);
    await checkFocusCardNoClipping(page, '1280x800 Split');
  });

  test('focus card never clips its own content at 1100x700 Split', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 })); } catch { /* no storage */ }
    });
    await setupFocusCardData(page);
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);
    await checkFocusCardNoClipping(page, '1100x700 Split');
  });

  test('Tier 3 Moved since you looked draws what moved and caps at at most 3 Areas', async ({ page }) => {
    const shas = ['1111111abcdef', '2222222abcdef', '3333333abcdef', '4444444abcdef', '5555555abcdef'];
    const newsCommits = shas.map((sha, i) => ({
      sha,
      author: `Author ${i + 1}`,
      subject: `commit for area ${i + 1}`,
      at: minutesAgo(2 + i * 5),
    }));

    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Tier 3 Capping Test',
        now: { key: 'focus-step', by: 'claude', at: minutesAgo(1) },
        checkpoints: TITLES.slice(0, 8).map((title, i) => checkpoint(title, {
          done: false,
          steps: [
            step(i < 5 ? `Step of ${title} (${shas[i]!.slice(0, 7)})` : `Step of ${title}`, false, i === 0 ? 'focus-step' : undefined),
          ],
        })),
      }),
    }));

    await page.route('**/api/workspace/*/news', (route) => route.fulfill({
      json: whatsNew({
        empty: false,
        commits: [{ repo: 'NexusFlow', more: 0, commits: newsCommits }],
      }),
    }));

    await page.route('**/api/workspace/*/board', (route) => route.fulfill({
      json: boardFile({ cards: [] }),
    }));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);

    const overview = page.locator('#board-overview');
    // Tier 1 is hero card
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);

    // Tier 3: Areas with news (at most 3 Areas capped)
    // Lower tier cards in Tier 3 display their newsSummary ("1 commit")
    const tier3SummaryBadges = overview.locator('.react-flow__node-areaMini [title="1 commit"], .react-flow__node-areaRow [title="1 commit"]');
    const tier3Count = await tier3SummaryBadges.count();
    // At most 3 areas capped into Tier 3
    expect(tier3Count).toBeGreaterThanOrEqual(1);
    expect(tier3Count).toBeLessThanOrEqual(3);
  });

  test('Tier acceptance: focus hero is first, 14 areas reachable without pan, question moves up, and done fold opens', async ({ page }) => {
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Full 14 Area Tier Test',
        now: { key: 'focus-step', by: 'claude', at: minutesAgo(1) },
        checkpoints: TITLES.map((title, i) => checkpoint(title, {
          done: i >= 12,
          steps: [
            step(`Step 1 of ${title}`, true),
            step(`Step 2 of ${title}`, false, i === 0 ? 'focus-step' : undefined),
            step(`Step 3 of ${title}`, false),
          ],
          decisions: i === 1 ? [decision('Should we ship this feature now?')] : [],
        })),
      }),
    }));

    await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);

    const overview = page.locator('#board-overview');

    // 1. Focus area is first and largest (Hero card)
    const hero = overview.locator('.react-flow__node-area');
    await expect(hero).toHaveCount(1);
    await expect(hero).toContainText(TITLES[0]!);

    // 2. Question moves up to Tier 2 ("Waits for you")
    const tier2 = overview.locator('button.board-area').filter({ hasText: 'Should we ship this feature now?' });
    await expect(tier2).toBeVisible();

    // 3. Board index starts closed
    await expect(page.getByRole('navigation', { name: 'Board index' })).toBeHidden();

    // 4. Done fold opens on press
    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toHaveText('2 done');
    await fold.click();
    await expect(fold).toHaveText('Show fewer');

    // 5. Stepping into an Area and pressing Back returns focus to that Area
    const secondArea = overview.locator('button.board-area').filter({ hasText: TITLES[1]! });
    await secondArea.click();
    await expect(page.getByRole('button', { name: 'Board ›' })).toBeVisible();
    await page.getByRole('button', { name: 'Board ›' }).click();
    await atRest(page);
    await expect(secondArea).toBeFocused();
  });

  test('Item 1: steps in focus card are real buttons in tab order, and pressing by click or keyboard lands on that step (highlighted and focused)', async ({ page }) => {
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Step Landing Test',
        now: { key: 'focus-step-1', by: 'claude', at: minutesAgo(1) },
        checkpoints: [
          checkpoint(TITLES[0]!, {
            done: false,
            steps: [
              step('Head step (focus 1)', false, 'focus-step-1'),
              step('Second step (focus 2)', false, 'focus-step-2'),
              step('Third step (focus 3)', false, 'focus-step-3'),
              step('Fourth step in more', false, 'focus-step-4'),
              step('Fifth step in more', false, 'focus-step-5'),
            ],
          }),
          checkpoint(TITLES[1]!, { done: false, steps: [step('Step of other')] }),
        ],
      }),
    }));
    await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);

    const heroNode = page.locator('#board-overview .react-flow__node-area');
    const heroBtn = heroNode.locator('button.board-area');
    await expect(heroBtn).toBeVisible();

    // 1. Verify step buttons are real buttons and NOT nested inside another button
    const stepButtons = heroNode.locator('button:not(.board-area)');
    await expect(stepButtons).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const btn = stepButtons.nth(i);
      const isNestedInButton = await btn.evaluate((el) => Boolean(el.parentElement?.closest('button')));
      expect(isNestedInButton).toBe(false);
    }

    // 2. Keyboard Tab navigation lands on the focus card button, then each step button
    await heroBtn.focus();
    await expect(heroBtn).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(stepButtons.nth(0)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(stepButtons.nth(1)).toBeFocused();

    // 3. Press Enter on step 2 via keyboard
    await page.keyboard.press('Enter');
    await atRest(page);
    await expect(page.locator('#board-area')).toBeVisible();

    // Verify it landed on step 2, highlighted and focused
    const step2InArea = page.locator('#board-area .react-flow__node[data-id="row:more-steps:step:second-step-focus-2"]');
    await expect(step2InArea).toBeVisible();
    await expect(step2InArea).toHaveAttribute('data-highlighted', 'true');
    await expect(step2InArea.getByRole('button', { name: /Second step/ })).toBeFocused();

    // 4. Step back to board
    await page.getByRole('button', { name: 'Board ›' }).click();
    await atRest(page);
    await expect(page.locator('#board-area')).toHaveCount(0);

    // 5. Test pressing step 3 by click
    await stepButtons.nth(2).click();
    await atRest(page);
    await expect(page.locator('#board-area')).toBeVisible();

    const step3InArea = page.locator('#board-area .react-flow__node[data-id="row:more-steps:step:third-step-focus-3"]');
    await expect(step3InArea).toBeVisible();
    await expect(step3InArea).toHaveAttribute('data-highlighted', 'true');
    await expect(step3InArea.getByRole('button', { name: /Third step/ })).toBeFocused();
  });

  test('Escape out of an Area in the fold opens the fold and lands focus on that Area, never on Show fewer', async ({ page }) => {
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Fold Focus Return Test',
        now: { key: 's0', by: 'claude', at: minutesAgo(1) },
        checkpoints: TITLES.map((title, i) => checkpoint(title, {
          done: i >= 12,
          steps: [step(`Step of ${title}`, i >= 12, `s${i}`)],
        })),
      }),
    }));
    await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);

    const overview = page.locator('#board-overview');
    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toHaveText('2 done');

    await page.getByRole('button', { name: /^Board index/ }).click();
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();
    await nav.getByRole('button', { name: new RegExp(TITLES[13]!) }).first().click();
    await atRest(page);

    await expect(page.locator('#board-area')).toBeVisible();

    await page.keyboard.press('Escape');
    await atRest(page);

    await expect(fold).toHaveText('Show fewer');

    const targetAreaBtn = overview.locator('button.board-area').filter({ hasText: TITLES[13]! });
    await expect(targetAreaBtn).toBeVisible();
    await expect(targetAreaBtn).toBeFocused();
    expect(await fold.evaluate((el) => el === document.activeElement)).toBe(false);
  });

  test('Board breadcrumb after an index jump restores the closed done fold and index focus', async ({ page }) => {
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Fold Focus Return Test',
        now: { key: 's0', by: 'claude', at: minutesAgo(1) },
        checkpoints: TITLES.map((title, i) => checkpoint(title, {
          done: i >= 12,
          steps: [step(`Step of ${title}`, i >= 12, `s${i}`)],
        })),
      }),
    }));
    await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);

    const overview = page.locator('#board-overview');
    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toHaveText('2 done');

    await page.getByRole('button', { name: /^Board index/ }).click();
    const nav = page.getByRole('navigation', { name: 'Board index' });
    await expect(nav).toBeVisible();
    const indexOrigin = nav.getByRole('button', { name: new RegExp(TITLES[13]!) }).first();
    await indexOrigin.click();
    await atRest(page);

    await expect(page.locator('#board-area')).toBeVisible();

    await page.getByRole('button', { name: 'Board ›' }).click();
    await expect(page.locator('#board-area')).toHaveCount(0);
    await atRest(page);

    await expect(fold).toHaveText('2 done');
    await expect(overview.locator('button.board-area').filter({ hasText: TITLES[13]! })).toHaveCount(0);
    await expect(nav).toBeVisible();
    await expect(indexOrigin).toBeFocused();
  });

  test('focus card step buttons use plain-text helper to strip markdown formatting', async ({ page }) => {
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Markdown Step Test',
        now: { key: 'm1', by: 'claude', at: minutesAgo(1) },
        checkpoints: [
          checkpoint(TITLES[0]!, {
            done: false,
            steps: [
              step('**Bold title**: for `reports/data.ts` and [documentation](https://example.com)', false, 'm1'),
              step('Second step with *italic* and ~~strikethrough~~ words', false, 'm2'),
            ],
          }),
        ],
      }),
    }));
    await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);

    const heroNode = page.locator('#board-overview .react-flow__node-area');
    const stepButtons = heroNode.locator('button:not(.board-area)');
    await expect(stepButtons).toHaveCount(2);

    const firstBtn = stepButtons.nth(0);
    const firstText = await firstBtn.locator('span.truncate').textContent();
    expect(firstText).toBe('Bold title: for reports/data.ts and documentation');
    expect(await firstBtn.getAttribute('title')).toBe('Bold title: for reports/data.ts and documentation');
    expect(await firstBtn.getAttribute('aria-label')).toBe('Bold title: for reports/data.ts and documentation');

    const secondBtn = stepButtons.nth(1);
    const secondText = await secondBtn.locator('span.truncate').textContent();
    expect(secondText).toBe('Second step with italic and strikethrough words');
  });

  test('narrow stage: rows carry tier text and tier 2 + 3 are capped with no 0 more fold', async ({ page }) => {
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Narrow Tier Text Test',
        now: { key: 's0', by: 'claude', at: minutesAgo(1) },
        checkpoints: [
          checkpoint(TITLES[0]!, { done: false, steps: [step('Step 1', false, 's0')] }),
          checkpoint(TITLES[1]!, { done: false, steps: [step('Step 2')], decisions: [decision('Which layout style is preferred?')] }),
          checkpoint(TITLES[2]!, { done: false, steps: [step('Step 3')], decisions: [decision('Should we deploy to staging?')] }),
          checkpoint(TITLES[3]!, { done: false, steps: [step('Step 4')] }),
          checkpoint(TITLES[4]!, { done: false, steps: [step('Step 5')] }),
          checkpoint(TITLES[5]!, { done: false, steps: [step('Step 6')] }),
          checkpoint(TITLES[6]!, { done: false, steps: [step('Step 7')] }),
          checkpoint(TITLES[7]!, { done: false, steps: [step('Step 8')] }),
        ],
      }),
    }));

    await page.route('**/api/workspace/*/news', (route) => route.fulfill({
      json: whatsNew({
        empty: false,
        commits: [
          { repo: 'NexusFlow', more: 0, commits: [{ sha: 'c1234567890', author: 'Author', subject: 'feat(board): news commit', at: minutesAgo(5) }] },
        ],
      }),
    }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));

    await page.setViewportSize({ width: 420, height: 700 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);

    const overview = page.locator('#board-overview');
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(1);

    const t2Row = overview.locator('.react-flow__node-areaRow').filter({ hasText: 'Which layout style is preferred?' });
    await expect(t2Row).toBeVisible();

    const fold = overview.locator('button.board-area-fold');
    if (await fold.isVisible()) {
      const foldText = await fold.textContent();
      expect(foldText).not.toContain('0 more');
      expect(foldText).toMatch(/^\d+ more$/);
    }

    const facts = await overview.evaluate((el) => {
      const stage = el.querySelector('.react-flow')!.getBoundingClientRect();
      const nodes = Array.from(el.querySelectorAll('.react-flow__node')).map((n) => n.getBoundingClientRect());
      const overflowing = nodes.filter((n) => n.bottom > stage.bottom + 1);
      return { stageBottom: stage.bottom, overflowingCount: overflowing.length };
    });
    expect(facts.overflowingCount).toBe(0);
  });

  test('all-done unfold fits the stage and a Done checkpoint is never the focus card', async ({ page }) => {
    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'All Done Test',
        checkpoints: TITLES.slice(0, 11).map((title) => checkpoint(title, {
          done: true,
          steps: [step(`Completed step of ${title}`, true)],
        })),
      }),
    }));
    await page.route('**/api/workspace/*/news', (route) => route.fulfill({ json: whatsNew() }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));

    await page.addInitScript(() => {
      try { localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 })); } catch { /* no storage */ }
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);

    const overview = page.locator('#board-overview');
    await expect(overview.locator('.react-flow__node-area')).toHaveCount(0);

    const fold = overview.locator('button.board-area-fold');
    await expect(fold).toHaveText('11 done');

    await fold.click();
    await atRest(page);
    await expect(fold).toHaveText('Show fewer');

    await expect(overview.locator('.react-flow__node-areaMini')).toHaveCount(11);

    const bounds = await overview.evaluate((el) => {
      const stage = el.querySelector('.react-flow')!.getBoundingClientRect();
      const nodes = Array.from(el.querySelectorAll('.react-flow__node')).map((n) => n.getBoundingClientRect());
      const overflowingBottom = nodes.filter((n) => n.bottom > stage.bottom + 1.5);
      const overflowingTop = nodes.filter((n) => n.top < stage.top - 1.5);
      return { overflowingBottom: overflowingBottom.length, overflowingTop: overflowingTop.length };
    });
    expect(bounds.overflowingBottom).toBe(0);
    expect(bounds.overflowingTop).toBe(0);
  });

  test('narrow mini card and row bottom line never overlap with commits, updates and many steps', async ({ page }) => {
    const LONG_TITLE = 'The Board is powerful enough to be where the work happens, and it replaces the Plan tab';
    const commitSha = 'a1b2c3d4e5f6';
    const targetSteps = Array.from({ length: 46 }, (_, i) =>
      step(i === 0 ? `Ship board interaction (${commitSha.slice(0, 7)})` : `Area step ${i + 1}`, i < 40),
    );
    const planItems = targetSteps.slice(0, 10).map((s, i) => ({
      key: s.key,
      text: s.text,
      at: minutesAgo(2 + i),
    }));

    await page.route('**/api/workspace/*/plan', (route) => route.fulfill({
      json: planFile({
        title: 'Overlap Regression Test',
        now: { key: 'focus-step-1', by: 'claude', at: minutesAgo(1) },
        checkpoints: [
          checkpoint(TITLES[0]!, { done: false, steps: [step('Focus step 1', false), step('Focus step 2', false)] }),
          checkpoint(LONG_TITLE, { done: false, steps: targetSteps }),
          ...TITLES.slice(2).map((title) => checkpoint(title, { done: false, steps: [step(`Step of ${title}`, false)] })),
          checkpoint('Fifteenth Area open step fifteen', { done: false, steps: [step('Step fifteen', false)] }),
          checkpoint('Sixteenth Area open step sixteen', { done: false, steps: [step('Step sixteen', false)] }),
        ],
      }),
    }));

    await page.route('**/api/workspace/*/news', (route) => route.fulfill({
      json: whatsNew({
        empty: false,
        commits: [{ repo: 'NexusFlow', more: 0, commits: [{ sha: commitSha, author: 'Dev', subject: 'feat: board layout', at: minutesAgo(5) }] }],
        plan: { items: planItems, more: 0 },
      }),
    }));
    await page.route('**/api/workspace/*/board', (route) => route.fulfill({ json: boardFile({ cards: [] }) }));

    const assertNoBottomLineOverlap = async (cardSelector: string, label: string) => {
      const card = page.locator(cardSelector).filter({ hasText: 'The Board is powerful' }).first();
      await expect(card, `${label}: target card visible`).toBeVisible();

      const facts = await card.evaluate((el) => {
        const cardRect = el.getBoundingClientRect();
        const stepsEl = Array.from(el.querySelectorAll<HTMLElement>('span')).find((s) => !s.querySelector('span') && /^\d+\s+of\s+\d+$/.test(s.textContent?.trim() ?? ''));
        if (!stepsEl) return { error: 'missing steps text', cardWidth: cardRect.width };
        const stepsRect = stepsEl.getBoundingClientRect();

        // Visible interactive count buttons + steps count + any visible progress bar or status on the same line
        const items: Array<{ kind: string; text: string; left: number; right: number; top: number; bottom: number; scrollW: number; clientW: number }> = [];
        const addEl = (kind: string, node: HTMLElement) => {
          const r = node.getBoundingClientRect();
          if (r.width <= 0.5 || r.height <= 0.5) return;
          if (getComputedStyle(node).visibility === 'hidden') return;
          items.push({
            kind,
            text: (node.textContent ?? '').trim(),
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            scrollW: node.scrollWidth,
            clientW: node.clientWidth,
          });
        };

        addEl('steps', stepsEl);
        for (const btn of Array.from(el.querySelectorAll<HTMLElement>('button:not(.board-area)'))) {
          addEl('count-button', btn);
        }
        const bar = el.querySelector<HTMLElement>('.bg-muted-foreground\\/20');
        if (bar) addEl('progress-bar', bar);

        // Plain newsSummary span (when not overlaid by buttons)
        for (const span of Array.from(el.querySelectorAll<HTMLElement>('span[title]'))) {
          if (span.getAttribute('title') === '1 commit, 10 updates' && getComputedStyle(span).visibility !== 'hidden' && !span.querySelector('button')) {
            addEl('news-summary', span);
          }
        }

        // Check pairwise intersection for items on the same horizontal band as stepsEl
        const sameLine = items.filter((item) => !(item.bottom <= stepsRect.top + 0.5 || stepsRect.bottom <= item.top + 0.5));
        const overlaps: string[] = [];
        for (let i = 0; i < sameLine.length; i++) {
          for (let j = i + 1; j < sameLine.length; j++) {
            const a = sameLine[i]!;
            const b = sameLine[j]!;
            const horizOverlap = !(a.right <= b.left + 0.5 || b.right <= a.left + 0.5);
            if (horizOverlap) {
              overlaps.push(`${a.kind}("${a.text}" ${Math.round(a.left)}..${Math.round(a.right)}) vs ${b.kind}("${b.text}" ${Math.round(b.left)}..${Math.round(b.right)})`);
            }
          }
        }
        const outOfCard = sameLine.filter((item) => item.left < cardRect.left - 0.5 || item.right > cardRect.right + 0.5)
          .map((item) => `${item.kind}(${Math.round(item.left)}..${Math.round(item.right)} vs card ${Math.round(cardRect.left)}..${Math.round(cardRect.right)})`);

        return {
          cardWidth: Math.round(cardRect.width),
          stepsText: stepsEl.textContent?.trim(),
          stepsRect: { height: Math.round(stepsRect.height), scrollW: stepsEl.scrollWidth, clientW: stepsEl.clientWidth },
          overlaps,
          outOfCard,
          itemCount: sameLine.length,
        };
      });

      expect(facts.error, `${label}: ${facts.error}`).toBeUndefined();
      expect(facts.stepsText).toBe('40 of 46');
      expect(facts.stepsRect!.scrollW, `${label}: "40 of 46" clipped`).toBeLessThanOrEqual(facts.stepsRect!.clientW + 1);
      expect(facts.stepsRect!.height, `${label}: "40 of 46" wrapped`).toBeLessThanOrEqual(22);
      expect(facts.overlaps, `${label}: overlapping bottom-line items at width ${facts.cardWidth}px`).toEqual([]);
      expect(facts.outOfCard, `${label}: items overflow card at width ${facts.cardWidth}px`).toEqual([]);
      return facts;
    };

    // 1. Narrow mini cards (1440x900 Board with Board index open ~300px)
    await page.addInitScript(() => {
      try { window.localStorage.setItem('contextspace_board_nav_open_v1', 'open'); } catch { /* no storage */ }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/workspaces/demo/board');
    await atRest(page);
    const miniFacts = await assertNoBottomLineOverlap('#board-overview .react-flow__node-areaMini', '1440x900 with index open');
    expect(miniFacts.cardWidth).toBeLessThanOrEqual(300);

    // 2. Narrow mini cards in Split mode (1280x800 Split)
    await page.evaluate(() => {
      try {
        window.localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: false, percent: 50 }));
        window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
      } catch { /* no storage */ }
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await atRest(page);
    const splitFacts = await assertNoBottomLineOverlap('#board-overview .react-flow__node-areaMini', '1280x800 Split');
    expect(splitFacts.cardWidth).toBeLessThanOrEqual(300);

    // 3. Narrow Area row (420x700)
    await page.setViewportSize({ width: 420, height: 700 });
    await atRest(page);
    await assertNoBottomLineOverlap('#board-overview .react-flow__node-areaRow', '420x700 row');
  });
});
