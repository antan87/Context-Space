import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { boardFile, checkpoint, planFile, step, whatsNew } from './planData';
import { minutesAgo, workspace } from './boardHelpers';
import type { CommitDetail } from '../src/features/board/commitContext';

test.use({
  workspacesData: [[workspace], { option: true }],
  viewport: { width: 1280, height: 800 },
});

const SHA_INC = 'f0011223344556677889900aabbccddeeff11223';
const SHA_UNPR = 'e11223344556677889900aabbccddeeff1122334';
const SHA_PR_1 = 'd223344556677889900aabbccddeeff112233445';
const SHA_PR_2 = 'c3344556677889900aabbccddeeff11223344556';
const SHA_BASE = 'b44556677889900aabbccddeeff1122334455667';
const SHA_BILL = 'a556677889900aabbccddeeff112233445566778';

const LONG_UNPR_SUBJECT =
  'D2: group Review commits by repository, branch, and pull request while wrapping long titles cleanly across two lines';
const PR_URL = 'https://github.com/antan87/Context-Space/pull/482';

let writes: string[] = [];
test.afterEach(() => {
  expect(writes, 'no test here may write').toEqual([]);
});

const win = (page: Page) => page.getByRole('region', { name: 'Review', exact: true });
const commitsRegion = (page: Page) => win(page).getByRole('region', { name: 'Commits' });
const commitHeader = (page: Page) => win(page).getByTestId('commit-header');
const modeButton = (page: Page, name: string) =>
  win(page).getByRole('group', { name: 'Show' }).getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });

function makeDetail(overrides: Partial<CommitDetail> & { repo: string; sha: string; subject: string }): CommitDetail {
  return {
    author: 'Anton',
    at: minutesAgo(10),
    shortSha: overrides.sha.slice(0, 7),
    body: 'Detailed description for commit.',
    parents: [],
    files: [{ path: 'src/review.ts', status: 'modified', additions: 12, deletions: 3 }],
    moreFiles: 0,
    additions: 12,
    deletions: 3,
    pushed: true,
    forge: 'github',
    webUrl: null,
    ...overrides,
  };
}

async function setupGroupedBoard(page: Page, options: { withNewsCommits?: boolean } = {}) {
  writes = [];
  await page.addInitScript(() => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
  });

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 't', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: true, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/demo/plan', (route) =>
    route.fulfill({
      json: planFile({
        title: 'Commit list grouping',
        checkpoints: [checkpoint('CL1', { steps: [step('Group commit list')], decisions: [] })],
      }),
    }),
  );
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
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile() }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes?*', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
    json: whatsNew(options.withNewsCommits ? {
      empty: false,
      commits: [{
        repo: 'NexusFlow',
        more: 0,
        commits: [{
          sha: SHA_PR_1.slice(0, 7),
          author: 'Anton',
          subject: 'Add commit notes storage',
          at: minutesAgo(20),
          fileCount: 3,
          pushed: true,
        }],
      }],
    } : {}),
  }));

  await page.route('**/api/workspace/demo/incoming**', (route) =>
    route.fulfill({
      json: {
        at: new Date().toISOString(),
        repos: [
          {
            repo: 'NexusFlow',
            remote: 'origin',
            ref: 'origin/main',
            remoteRepo: 'antan87/Context-Space',
            branch: 'main',
            host: { kind: 'github', name: 'GitHub' },
            lastFetchAt: minutesAgo(1),
            fetching: false,
            state: 'ok',
            message: null,
            behind: 1,
            commits: [
              {
                sha: SHA_INC.slice(0, 7),
                author: 'Maria',
                subject: 'Incoming fix on origin/main',
                at: minutesAgo(3),
                fileCount: 1,
                incoming: true,
              },
            ],
            more: 0,
          },
          {
            repo: 'billing',
            remote: 'origin',
            ref: 'origin/main',
            remoteRepo: 'acme/billing',
            branch: 'main',
            host: { kind: 'github', name: 'GitHub' },
            lastFetchAt: minutesAgo(1),
            fetching: false,
            state: 'ok',
            message: null,
            behind: 0,
            commits: [],
            more: 0,
          },
        ],
      },
    }),
  );

  await page.route('**/api/workspace/demo/recent-commits', (route) =>
    route.fulfill({
      json: {
        at: new Date().toISOString(),
        from: minutesAgo(180),
        commits: [
          {
            repo: 'NexusFlow',
            remoteRepo: 'antan87/Context-Space',
            branch: 'feat/cl1-groups',
            base: 'main',
            pullRequests: [
              {
                number: 482,
                title: 'Board commit notes & PR grouping',
                state: 'MERGED',
                url: PR_URL,
              },
            ],
            more: 0,
            commits: [
              {
                sha: SHA_UNPR.slice(0, 7),
                author: 'Anton',
                subject: LONG_UNPR_SUBJECT,
                at: minutesAgo(5),
                fileCount: 4,
                pushed: false,
              },
              {
                sha: SHA_PR_1.slice(0, 7),
                author: 'Anton',
                subject: 'Add commit notes storage',
                at: minutesAgo(20),
                fileCount: 3,
                pushed: true,
                prNumber: 482,
              },
              {
                sha: SHA_PR_2.slice(0, 7),
                author: 'Anton',
                subject: 'Render commit note badges',
                at: minutesAgo(30),
                fileCount: 2,
                pushed: true,
                prNumber: 482,
              },
              {
                sha: SHA_BASE.slice(0, 7),
                author: 'Maintainer',
                subject: 'Merge pull request #480 from antan87/base-work',
                at: minutesAgo(45),
                fileCount: 1,
                pushed: true,
                onBase: true,
              },
            ],
          },
          {
            repo: 'billing',
            remoteRepo: 'acme/billing',
            branch: 'main',
            base: null,
            more: 0,
            commits: [
              {
                sha: SHA_BILL.slice(0, 7),
                author: 'Dana',
                subject: 'Update VAT rounding table',
                at: minutesAgo(60),
                fileCount: 1,
                pushed: true,
              },
            ],
          },
        ],
      },
    }),
  );

  const details: CommitDetail[] = [
    makeDetail({ repo: 'NexusFlow', sha: SHA_INC, author: 'Maria', subject: 'Incoming fix on origin/main', at: minutesAgo(3) }),
    makeDetail({ repo: 'NexusFlow', sha: SHA_UNPR, subject: LONG_UNPR_SUBJECT, at: minutesAgo(5), pushed: false }),
    makeDetail({ repo: 'NexusFlow', sha: SHA_PR_1, subject: 'Add commit notes storage', at: minutesAgo(20) }),
    makeDetail({ repo: 'NexusFlow', sha: SHA_PR_2, subject: 'Render commit note badges', at: minutesAgo(30) }),
    makeDetail({ repo: 'NexusFlow', sha: SHA_BASE, author: 'Maintainer', subject: 'Merge pull request #480 from antan87/base-work', at: minutesAgo(45) }),
    makeDetail({ repo: 'billing', sha: SHA_BILL, author: 'Dana', subject: 'Update VAT rounding table', at: minutesAgo(60) }),
  ];

  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const parsed = new URL(route.request().url());
    const [repo, sha] = parsed.pathname.split('/commits/')[1]!.split('/').map(decodeURIComponent);
    const matched = details.find((d) => d.repo === repo && (d.sha === sha || d.sha.startsWith(sha!))) ?? details[0]!;
    return route.fulfill({ json: matched });
  });

  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes are refused in this spec' } });
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('groups by repo -> branch -> PR, supports collapsing, keyboard nav, [ ] drawn order, header PR link, and WCAG checks', async ({ page }) => {
      await setupGroupedBoard(page);
      await page.goto('/#/workspaces/demo/board');

      await page.getByRole('button', { name: /^Review/ }).click();
      await expect(win(page)).toBeVisible();
      await modeButton(page, 'Commits').click();
      await expect(modeButton(page, 'Commits')).toHaveAttribute('aria-pressed', 'true');

      const region = commitsRegion(page);
      const repoGroups = region.getByTestId('commit-repo-group');
      await expect(repoGroups).toHaveCount(2);

      // Repo 1: NexusFlow shows differing owner/repo; Repo 2: billing omits matching acme/billing
      const nexusRepo = repoGroups.nth(0);
      await expect(nexusRepo.getByTestId('commit-repo-toggle')).toContainText('NexusFlow');
      await expect(nexusRepo.getByTestId('commit-repo-remote')).toHaveText('antan87/Context-Space');
      const billingRepo = repoGroups.nth(1);
      await expect(billingRepo.getByTestId('commit-repo-toggle')).toContainText('billing');
      await expect(billingRepo.getByTestId('commit-repo-remote')).toHaveCount(0);

      // Branches under NexusFlow: incoming origin/main first, then feat/cl1-groups -> main
      const nexusBranches = nexusRepo.getByTestId('commit-branch-group');
      await expect(nexusBranches).toHaveCount(2);
      await expect(nexusBranches.nth(0).getByTestId('commit-branch-toggle')).toContainText('origin/main');
      await expect(nexusBranches.nth(0)).toContainText('On GitHub, not in your copy yet');
      await expect(nexusBranches.nth(1).getByTestId('commit-branch-toggle')).toContainText('feat/cl1-groups → main');

      // Branch under billing: main (no base arrow)
      await expect(billingRepo.getByTestId('commit-branch-toggle')).toHaveText('main');

      // PR grouping inside NexusFlow local branch: Not in a PR yet -> #482 Merged -> Already on main
      const localBranch = nexusBranches.nth(1);
      const unprHeading = localBranch.getByTestId('commit-unassigned-toggle');
      const prHeading = localBranch.getByTestId('commit-pr-heading');
      const prLink = prHeading.getByTestId('commit-pr-link');
      const onBaseHeading = localBranch.getByTestId('commit-on-base-toggle');

      await expect(unprHeading).toHaveText('Not in a pull request yet');
      await expect(prLink).toContainText('#482');
      await expect(prLink).toContainText('Board commit notes & PR grouping');
      await expect(prLink).toContainText('Merged');
      await expect(prLink).toHaveAttribute('href', PR_URL);
      await expect(onBaseHeading).toHaveText('Already on main');

      // Order in viewport
      const yUnpr = (await unprHeading.boundingBox())!.y;
      const yPr = (await prHeading.boundingBox())!.y;
      const yBase = (await onBaseHeading.boundingBox())!.y;
      expect(yUnpr).toBeLessThan(yPr);
      expect(yPr).toBeLessThan(yBase);

      // No nested interactive elements inside PR heading or commit rows
      const nestedCount = await region.evaluate((el) => {
        const interactive = el.querySelectorAll('a button, button a, button button, a a, [role="treeitem"] button, [role="treeitem"] a');
        return interactive.length;
      });
      expect(nestedCount).toBe(0);

      // Collapse PR #482 using its toggle button
      const prToggle = localBranch.getByTestId('commit-pr-toggle');
      await expect(prToggle).toHaveAttribute('aria-expanded', 'true');
      await prToggle.focus();
      await page.keyboard.press('Enter');
      await expect(prToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(region.getByRole('treeitem', { name: /Add commit notes storage/ })).toHaveCount(0);

      // ArrowDown from un-PR'd commit skips collapsed #482 and lands in Already on main
      const unprCommit = region.getByRole('treeitem', { name: /group Review commits by repository/ });
      await unprCommit.click();
      await expect(unprCommit).toBeFocused();
      await expect(commitHeader(page).getByTestId('commit-repo')).toHaveText('NexusFlow');
      await expect(commitHeader(page).getByTestId('commit-branch')).toHaveText('feat/cl1-groups');
      await expect(commitHeader(page).getByTestId('commit-pr-link')).toHaveCount(0);

      await page.keyboard.press('ArrowDown');
      const baseCommit = region.getByRole('treeitem', { name: /Merge pull request #480/ });
      await expect(baseCommit).toBeFocused();

      // Re-click un-PR'd commit, then press ] to move in drawn order into collapsed #482 -> auto-expands #482!
      await unprCommit.click();
      await page.keyboard.press(']');
      await expect(prToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Add commit notes storage');
      await expect(commitHeader(page).getByTestId('commit-repo')).toHaveText('NexusFlow');
      await expect(commitHeader(page).getByTestId('commit-branch')).toHaveText('feat/cl1-groups');
      const headerPrLink = commitHeader(page).getByTestId('commit-pr-link');
      await expect(headerPrLink).toContainText('#482');
      await expect(headerPrLink).toContainText('Merged');
      await expect(headerPrLink).toHaveAttribute('href', PR_URL);

      // Pressing [ steps back to Not in a pull request yet
      await page.keyboard.press('[');
      await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText(LONG_UNPR_SUBJECT);

      // Collapse incoming branch heading and verify incoming commit hides and restores
      const incomingToggle = nexusBranches.nth(0).getByTestId('commit-branch-toggle');
      await expect(incomingToggle).toHaveAttribute('aria-expanded', 'true');
      await incomingToggle.click();
      await expect(incomingToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(region.getByRole('treeitem', { name: /Incoming fix on origin\/main/ })).toHaveCount(0);
      await incomingToggle.click();
      await expect(incomingToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(region.getByRole('treeitem', { name: /Incoming fix on origin\/main/ })).toHaveCount(1);

      // Collapsing the open commit's own repository keeps that commit open in the right pane
      const nexusRepoToggle = nexusRepo.getByTestId('commit-repo-toggle');
      await nexusRepoToggle.click();
      await expect(nexusRepoToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText(LONG_UNPR_SUBJECT);
      await nexusRepoToggle.click();
      await expect(nexusRepoToggle).toHaveAttribute('aria-expanded', 'true');

      // Check typography (>=12px), targets (>=24px), zero horizontal overflow, and full subject preserved in DOM
      const metrics = await region.evaluate((el) => {
        const overflow = el.scrollWidth > el.clientWidth + 1;
        const smallTexts: Array<{ text: string; size: number }> = [];
        for (const node of el.querySelectorAll<HTMLElement>('button, a, span, p, code, time')) {
          if (node.offsetParent === null) continue;
          const text = node.textContent?.trim();
          if (!text) continue;
          const size = parseFloat(getComputedStyle(node).fontSize);
          if (size < 11.9) smallTexts.push({ text: text.slice(0, 40), size });
        }
        const smallTargets: Array<{ label: string; w: number; h: number }> = [];
        for (const ctrl of el.querySelectorAll<HTMLElement>('button, a')) {
          if (ctrl.offsetParent === null) continue;
          const rect = ctrl.getBoundingClientRect();
          if (rect.height < 23.9 || rect.width < 23.9) {
            smallTargets.push({ label: ctrl.textContent?.trim() || ctrl.getAttribute('aria-label') || 'ctrl', w: rect.width, h: rect.height });
          }
        }
        return { overflow, smallTexts, smallTargets };
      });
      expect(metrics.overflow).toBe(false);
      expect(metrics.smallTexts, 'all commit list text >= 12px').toEqual([]);
      expect(metrics.smallTargets, 'all group controls >= 24px').toEqual([]);

      // Axe accessibility check on Review region
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      const axe = await new AxeBuilder({ page })
        .include('[aria-label="Review"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = axe.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.html.slice(0, 120)}`).join(' | ')}`);
      expect(serious, serious.join('\n')).toEqual([]);
    });
  });
}

test('reopening the same Board commit card expands its collapsed PR group so the open commit starts visible', async ({ page }) => {
  await setupGroupedBoard(page, { withNewsCommits: true });
  await page.goto('/#/workspaces/demo/board');

  await page.locator('.board-overview-plane button.board-area').first().click();
  const area = page.locator('#board-area');
  await expect(area).toBeVisible();
  const fold = area.locator('button[data-row-control^="lane:commits"]').first();
  if (await fold.getAttribute('aria-expanded') === 'false') {
    await fold.click();
  }
  const commitCardBtn = area.getByRole('button', { name: 'Open Add commit notes storage' });
  await commitCardBtn.click();
  await expect(win(page)).toBeVisible();

  const region = commitsRegion(page);
  const prToggle = region.getByTestId('commit-pr-toggle');
  await expect(prToggle).toHaveAttribute('aria-expanded', 'true');
  await prToggle.click();
  await expect(prToggle).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('Escape');
  await expect(win(page)).toBeHidden();

  await commitCardBtn.click();
  await expect(win(page)).toBeVisible();
  await expect(prToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(region.getByRole('treeitem', { name: /Add commit notes storage/ })).toBeVisible();
});

test('handles detached HEAD, multi-PR states (OPEN -> MERGED -> CLOSED), and <400px mobile header wrapping without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  writes = [];
  await page.addInitScript(() => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
  });
  const longRepo = 'verylongunbrokenrepositoryfoldernameformobilecheck1234567890';
  const longBranch = 'feat/extremelylongunbrokenbranchnameformobileheaderwrappingverification';
  const shaOpen = 'aa11223344556677889900aabbccddeeff112233';
  const shaMerged = 'bb223344556677889900aabbccddeeff11223344';
  const shaClosed = 'cc3344556677889900aabbccddeeff1122334455';
  const shaDetached = 'dd44556677889900aabbccddeeff112233445566';

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 't', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: false, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile() }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes?*', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew() }));
  await page.route('**/api/workspace/demo/incoming**', (route) => route.fulfill({ json: { at: new Date().toISOString(), repos: [] } }));
  await page.route('**/api/workspace/demo/recent-commits', (route) => route.fulfill({
    json: {
      at: new Date().toISOString(),
      from: minutesAgo(180),
      commits: [
        {
          repo: longRepo,
          remoteRepo: 'acme/short',
          branch: longBranch,
          base: 'main',
          pullRequests: [
            { number: 501, title: 'Open PR', state: 'OPEN', url: 'https://github.com/acme/short/pull/501' },
            { number: 499, title: 'Merged PR', state: 'MERGED', url: 'https://github.com/acme/short/pull/499' },
            { number: 490, title: 'Closed PR', state: 'CLOSED', url: 'https://github.com/acme/short/pull/490' },
          ],
          more: 0,
          commits: [
            { sha: shaOpen.slice(0, 7), author: 'A', subject: 'Open PR commit', at: minutesAgo(5), fileCount: 1, pushed: true, prNumber: 501 },
            { sha: shaMerged.slice(0, 7), author: 'A', subject: 'Merged PR commit', at: minutesAgo(15), fileCount: 1, pushed: true, prNumber: 499 },
            { sha: shaClosed.slice(0, 7), author: 'A', subject: 'Closed PR commit', at: minutesAgo(25), fileCount: 1, pushed: true, prNumber: 490 },
          ],
        },
        {
          repo: 'detached-repo',
          remoteRepo: null,
          branch: null,
          base: null,
          more: 0,
          commits: [
            { sha: shaDetached.slice(0, 7), author: 'B', subject: 'Detached commit', at: minutesAgo(40), fileCount: 1, pushed: true },
          ],
        },
      ],
    },
  }));
  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const url = new URL(route.request().url());
    const [repo, sha] = url.pathname.split('/commits/')[1]!.split('/').map(decodeURIComponent);
    const isDetached = repo === 'detached-repo';
    return route.fulfill({
      json: makeDetail({
        repo: repo!,
        sha: sha!,
        subject: isDetached ? 'Detached commit' : 'Open PR commit',
      }),
    });
  });
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes refused' } });
  });

  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: /^Review/ }).click();
  await expect(win(page)).toBeVisible();
  await modeButton(page, 'Commits').click();

  // Check CommitOverview header does not overflow horizontally at 360px
  const header = commitHeader(page);
  await expect(header.getByTestId('commit-repo')).toHaveText(longRepo);
  await expect(header.getByTestId('commit-branch')).toHaveText(longBranch);
  await expect(header.getByTestId('commit-pr-link')).toContainText('#501');
  await expect(header.getByTestId('commit-pr-link')).toContainText('Open');
  const headerOverflow = await win(page).evaluate(() => {
    const h = document.querySelector('[data-testid="commit-header"]');
    const scroller = h?.closest('.overflow-y-auto');
    return scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : false;
  });
  expect(headerOverflow, '360px commit overview must not overflow horizontally').toBe(false);

  // Open drawer in 360px and verify OPEN -> MERGED -> CLOSED PR order and Detached HEAD
  const region = commitsRegion(page);
  if (!(await region.isVisible())) {
    await win(page).getByRole('button', { name: /Show the file tree/i }).click();
  }
  await expect(region).toBeVisible();
  const prTexts = await region.getByTestId('commit-pr-link').allInnerTexts();
  expect(prTexts.map((t) => t.replace(/\s+/g, ' ').trim())).toEqual([
    '#501 Open PR Open',
    '#499 Merged PR Merged',
    '#490 Closed PR Closed',
  ]);
  await expect(region.getByTestId('commit-branch-toggle').last()).toHaveText('Detached HEAD');
  await region.getByRole('treeitem', { name: /Detached commit/ }).click();
  await expect(header.getByTestId('commit-branch')).toHaveText('Detached HEAD');
});

test('keeps -> base visible and distinguishes long same-prefix PR titles in 248px desktop column, shows Other commits (no branch) for held commits the branch does not list, and updates PR headings asynchronously via live feed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  writes = [];
  await page.addInitScript(() => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
    const Native = window.EventSource;
    const feeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> = [];
    (window as unknown as { __cl1Feeds: typeof feeds }).__cl1Feeds = feeds;
    class HeldEventSource {
      closed = false;
      readyState = 0;
      listeners: Record<string, Array<(event: { data?: string; lastEventId: string }) => void>> = {};
      constructor(url: string) {
        if (!url.includes('/screen-events')) return new Native(url) as unknown as HeldEventSource;
        feeds.push(this);
      }
      addEventListener(type: string, listener: (event: { data?: string; lastEventId: string }) => void) {
        (this.listeners[type] ??= []).push(listener);
      }
      close() {
        this.closed = true;
        this.readyState = 2;
      }
      emit(type: string, data?: string) {
        for (const listener of this.listeners[type] ?? []) listener({ data, lastEventId: '' });
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource = HeldEventSource;
  });

  const SHA_482 = '11223344556677889900aabbccddeeff11223344';
  const SHA_476 = '223344556677889900aabbccddeeff1122334455';
  const SHA_OLD = '3344556677889900aabbccddeeff112233445566';

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 't', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: false, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile() }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes?*', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/demo/incoming**', (route) => route.fulfill({ json: { at: new Date().toISOString(), repos: [] } }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({
    json: whatsNew({
      empty: false,
      commits: [{
        repo: 'NexusFlow',
        more: 0,
        commits: [{
          sha: SHA_OLD.slice(0, 7),
          author: 'Anton',
          subject: 'Older commit from news outside 3-day window',
          at: minutesAgo(60 * 24 * 10),
          fileCount: 1,
          pushed: true,
        }],
      }],
    }),
  }));

  let prsReady = false;
  let recentFetches = 0;
  await page.route('**/api/workspace/demo/recent-commits', (route) => {
    recentFetches += 1;
    return route.fulfill({
      json: {
        at: new Date().toISOString(),
        from: minutesAgo(180),
        commits: [
          {
            repo: 'NexusFlow',
            remoteRepo: 'antan87/Context-Space',
            branch: 'feat/NexusFlow-new-canvas-interaction',
            base: 'main',
            ...(prsReady
              ? {
                pullRequests: [
                  {
                    number: 482,
                    title: 'The Board: drawn diagrams, point and ask, and a design module',
                    state: 'MERGED',
                    url: 'https://github.com/antan87/Context-Space/pull/482',
                  },
                  {
                    number: 476,
                    title: 'The Board: one screen where you and the AI see, decide and inspect',
                    state: 'MERGED',
                    url: 'https://github.com/antan87/Context-Space/pull/476',
                  },
                ],
              }
              : { prsPending: true }),
            more: 10,
            commits: [
              {
                sha: SHA_482.slice(0, 7),
                author: 'Anton',
                subject: 'Diagram reader support',
                at: minutesAgo(10),
                fileCount: 2,
                pushed: true,
                ...(prsReady ? { prNumber: 482 } : {}),
              },
              {
                sha: SHA_476.slice(0, 7),
                author: 'Anton',
                subject: 'Initial board overview',
                at: minutesAgo(30),
                fileCount: 3,
                pushed: true,
                ...(prsReady ? { prNumber: 476 } : {}),
              },
            ],
          },
        ],
      },
    });
  });

  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const url = new URL(route.request().url());
    const [repo, sha] = url.pathname.split('/commits/')[1]!.split('/').map(decodeURIComponent);
    return route.fulfill({
      json: makeDetail({
        repo: repo!,
        sha: sha!,
        subject: sha!.startsWith(SHA_OLD.slice(0, 7)) ? 'Older commit from news outside 3-day window' : 'Diagram reader support',
      }),
    });
  });

  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes refused' } });
  });

  await page.goto('/#/workspaces/demo/board');
  // Open the older commit card from the Board Area (so it is in held, not recent)
  await page.locator('.board-overview-plane button.board-area').first().click();
  const area = page.locator('#board-area');
  await expect(area).toBeVisible();
  const fold = area.locator('button[data-row-control^="lane:commits"]').first();
  if (await fold.getAttribute('aria-expanded') === 'false') {
    await fold.click();
  }
  await area.getByRole('button', { name: 'Open Older commit from news outside 3-day window' }).click();
  await expect(win(page)).toBeVisible();

  const region = commitsRegion(page);
  // Branch base "-> main" must stay fully visible even with long branch name in 248px sidebar
  const branchToggle = region.getByTestId('commit-branch-toggle').first();
  const branchBase = region.getByTestId('commit-branch-base');
  await expect(branchBase).toHaveText('→ main');
  const [toggleBox, baseBox] = await Promise.all([branchToggle.boundingBox(), branchBase.boundingBox()]);
  expect(baseBox!.width).toBeGreaterThan(20);
  expect(baseBox!.x + baseBox!.width).toBeLessThanOrEqual(toggleBox!.x + toggleBox!.width + 1);

  // While gh is pending, sidebar shows "PR information is loading"
  await expect(region.getByText('PR information is loading')).toBeVisible();
  await expect(region.getByTestId('commit-unassigned-toggle')).toHaveCount(0);
  const fetchesBeforeOpen = recentFetches;

  // Emit 'open' BEFORE prsReady flips so CodeSection's reconnect refetch runs and settles while PRs are still pending
  const reconnectResponse = page.waitForResponse('**/api/workspace/demo/recent-commits');
  await page.evaluate(() => {
    const feeds = (window as unknown as { __cl1Feeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> }).__cl1Feeds;
    for (const feed of feeds.filter((f) => !f.closed)) {
      feed.readyState = 1;
      feed.emit('open');
    }
  });
  await reconnectResponse;
  await expect.poll(() => recentFetches).toBeGreaterThan(fetchesBeforeOpen);
  await expect(region.getByText('PR information is loading')).toBeVisible();
  await expect(region.getByTestId('commit-pr-link')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  // Now flip prsReady and emit ONLY 'commits' (no 'open') -> PR headings appear solely via SSE 'commits' handling
  prsReady = true;
  await page.evaluate(() => {
    const feeds = (window as unknown as { __cl1Feeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> }).__cl1Feeds;
    for (const feed of feeds.filter((f) => !f.closed)) {
      feed.emit('commits', JSON.stringify({ type: 'commits', timestamp: new Date().toISOString() }));
    }
  });

  await expect(region.getByText('PR information is loading')).toHaveCount(0);
  const prLinks = region.getByTestId('commit-pr-link');
  await expect(prLinks).toHaveCount(2);
  // Two-line PR titles must wrap (height >= ~24px) so #482 and #476 show distinguishing words
  const [link482Box, link476Box] = await Promise.all([prLinks.nth(0).boundingBox(), prLinks.nth(1).boundingBox()]);
  expect(link482Box!.height).toBeGreaterThan(26);
  expect(link476Box!.height).toBeGreaterThan(26);

  // A commit the current branch does not list sits in a neutral "Other commits" group, never under the branch or
  // "Not in a pull request yet", and its header claims no branch.
  await expect(region.getByTestId('commit-branch-toggle').filter({ hasText: 'Other commits' })).toBeVisible();
  await expect(region.getByTestId('commit-branch-toggle')).toHaveCount(2);
  await expect(region.getByTestId('commit-older-toggle')).toHaveCount(0);
  await expect(region.getByTestId('commit-unassigned-toggle')).toHaveCount(0);
  await expect(region.getByTestId('commit-branch-group').filter({ hasText: 'Other commits' }).getByTestId('commit-tree-item')).toHaveCount(1);
  await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Older commit from news outside 3-day window');
  await expect(commitHeader(page).getByTestId('commit-branch')).toHaveCount(0);
  await expect(commitHeader(page).getByTestId('commit-pr-link')).toHaveCount(0);
});

test('keeps PR headings, Not in a pull request yet, open commit, collapsed groups, and focused toggle during Check now while gh is slow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  writes = [];
  await page.addInitScript(() => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
    const Native = window.EventSource;
    const feeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> = [];
    (window as unknown as { __cl1CheckNowFeeds: typeof feeds }).__cl1CheckNowFeeds = feeds;
    class CheckNowEventSource {
      closed = false;
      readyState = 0;
      listeners: Record<string, Array<(event: { data?: string; lastEventId: string }) => void>> = {};
      constructor(url: string) {
        if (!url.includes('/screen-events')) return new Native(url) as unknown as CheckNowEventSource;
        feeds.push(this);
      }
      addEventListener(type: string, listener: (event: { data?: string; lastEventId: string }) => void) {
        (this.listeners[type] ??= []).push(listener);
      }
      close() {
        this.closed = true;
        this.readyState = 2;
      }
      emit(type: string, data?: string) {
        for (const listener of this.listeners[type] ?? []) listener({ data, lastEventId: '' });
      }
    }
    (window as unknown as { EventSource: unknown }).EventSource = CheckNowEventSource;
  });

  const SHA_482 = '11223344556677889900aabbccddeeff11223344';
  const SHA_476 = '223344556677889900aabbccddeeff1122334455';
  const SHA_LOCAL_UNPR = '44556677889900aabbccddeeff11223344556677';
  const SHA_ON_BASE = '556677889900aabbccddeeff1122334455667788';

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 't', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: false, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile() }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes?*', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew() }));

  let phase: 'warm' | 'revalidating' | 'settled' = 'warm';
  let holdPendingRecent: (() => void) | null = null;
  let recentPendingHeldPromise: Promise<void> | null = null;
  let pendingRecentEntered: (() => void) | null = null;
  const pendingRecentStarted = new Promise<void>((resolve) => {
    pendingRecentEntered = resolve;
  });

  await page.route('**/api/workspace/demo/incoming**', (route) => {
    const parsed = new URL(route.request().url());
    if (parsed.searchParams.get('refresh') === '1') {
      phase = 'revalidating';
      recentPendingHeldPromise = new Promise<void>((resolve) => {
        holdPendingRecent = resolve;
      });
    }
    return route.fulfill({ json: { at: new Date().toISOString(), repos: [] } });
  });

  await page.route('**/api/workspace/demo/recent-commits', async (route) => {
    if (phase === 'revalidating' && recentPendingHeldPromise) {
      const heldPromise = recentPendingHeldPromise;
      recentPendingHeldPromise = null;
      pendingRecentEntered?.();
      await heldPromise;
    }
    return route.fulfill({
      json: {
        at: new Date().toISOString(),
        from: minutesAgo(180),
        commits: [
          {
            repo: 'NexusFlow',
            remoteRepo: 'antan87/Context-Space',
            branch: 'feat/cl1-groups',
            base: 'main',
            ...(phase === 'revalidating' ? { prsPending: true } : {}),
            pullRequests: [
              {
                number: 482,
                title: 'Board commit notes & PR grouping',
                state: 'MERGED',
                url: 'https://github.com/antan87/Context-Space/pull/482',
              },
              {
                number: 476,
                title: 'Initial Board overview',
                state: 'MERGED',
                url: 'https://github.com/antan87/Context-Space/pull/476',
              },
            ],
            more: 0,
            commits: [
              {
                sha: SHA_LOCAL_UNPR.slice(0, 7),
                author: 'Anton',
                subject: 'Local commit after PRs',
                at: minutesAgo(5),
                fileCount: 1,
                pushed: false,
              },
              {
                sha: SHA_482.slice(0, 7),
                author: 'Anton',
                subject: 'Diagram reader support',
                at: minutesAgo(20),
                fileCount: 2,
                pushed: true,
                prNumber: 482,
              },
              {
                sha: SHA_476.slice(0, 7),
                author: 'Anton',
                subject: 'Initial board overview commit',
                at: minutesAgo(40),
                fileCount: 3,
                pushed: true,
                prNumber: 476,
              },
              {
                sha: SHA_ON_BASE.slice(0, 7),
                author: 'Maintainer',
                subject: 'Merge pull request #470 from base',
                at: minutesAgo(60),
                fileCount: 1,
                pushed: true,
                onBase: true,
              },
            ],
          },
        ],
      },
    });
  });

  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const url = new URL(route.request().url());
    const [repo, sha] = url.pathname.split('/commits/')[1]!.split('/').map(decodeURIComponent);
    return route.fulfill({
      json: makeDetail({
        repo: repo!,
        sha: sha!,
        subject: sha!.startsWith(SHA_482.slice(0, 7)) ? 'Diagram reader support' : 'Local commit after PRs',
      }),
    });
  });

  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes refused' } });
  });

  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: /^Review/ }).click();
  await expect(win(page)).toBeVisible();
  await modeButton(page, 'Commits').click();

  // Connect live feed initially
  await page.evaluate(() => {
    const feeds = (window as unknown as { __cl1CheckNowFeeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> }).__cl1CheckNowFeeds;
    for (const feed of feeds.filter((f) => !f.closed)) {
      feed.readyState = 1;
      feed.emit('open');
    }
  });

  const region = commitsRegion(page);
  await expect(region.getByTestId('commit-pr-link')).toHaveCount(2);

  // Open a commit inside #482
  await region.getByRole('treeitem', { name: /Diagram reader support/ }).click();
  await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Diagram reader support');
  await expect(commitHeader(page).getByTestId('commit-pr-link')).toContainText('#482');

  // Collapse #476 and Not in a pull request yet
  const pr476Toggle = region.getByRole('button', { name: 'Toggle pull request #476' });
  await pr476Toggle.click();
  await expect(pr476Toggle).toHaveAttribute('aria-expanded', 'false');

  const unassignedToggle = region.getByTestId('commit-unassigned-toggle');
  await unassignedToggle.click();
  await expect(unassignedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(region.getByRole('treeitem', { name: /Local commit after PRs/ })).toHaveCount(0);

  // Click "Check now" while gh will be slow (> 1s -> prsPending: true with stale PRs)
  await win(page).getByTestId('incoming-check-now').click();
  await pendingRecentStarted;

  // Focus the collapsed unassigned toggle while the refresh request is in flight, then deliver prsPending: true
  await unassignedToggle.focus();
  await expect(unassignedToggle).toBeFocused();
  holdPendingRecent?.();

  // While gh is slow (prsPending: true), everything survives without flicker
  await expect(region.getByTestId('commit-pr-loading')).toBeVisible();
  await expect(region.getByTestId('commit-pr-link')).toHaveCount(2);
  await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Diagram reader support');
  await expect(commitHeader(page).getByTestId('commit-pr-link')).toContainText('#482');
  await expect(pr476Toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(unassignedToggle).toBeVisible();
  await expect(unassignedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(region.getByRole('treeitem', { name: /Local commit after PRs/ })).toHaveCount(0);
  await expect(unassignedToggle).toBeFocused();

  // Background gh settles and emits SSE 'commits' -> loading clears, collapsed groups + open commit + focused toggle still survive
  phase = 'settled';
  await page.evaluate(() => {
    const feeds = (window as unknown as { __cl1CheckNowFeeds: Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }> }).__cl1CheckNowFeeds;
    for (const feed of feeds.filter((f) => !f.closed)) {
      feed.emit('commits', JSON.stringify({ type: 'commits', timestamp: new Date().toISOString() }));
    }
  });

  await expect(region.getByTestId('commit-pr-loading')).toHaveCount(0);
  await expect(region.getByTestId('commit-pr-link')).toHaveCount(2);
  await expect(commitHeader(page).getByTestId('commit-subject')).toHaveText('Diagram reader support');
  await expect(commitHeader(page).getByTestId('commit-pr-link')).toContainText('#482');
  await expect(pr476Toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(unassignedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(unassignedToggle).toBeFocused();
});

// ─── CL1 fix round 3 ───────────────────────────────────────────────────────────

type FeedStub = Array<{ closed: boolean; readyState: number; emit: (type: string, data?: string) => void }>;

/** Replaces the live feed with one the test drives by hand, and routes everything the Commits list reads. */
async function setupRecentBoard(
  page: Page,
  recent: () => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>,
) {
  writes = [];
  await page.addInitScript(() => {
    window.localStorage.setItem('contextspace_board_nav_open_v1', 'closed');
    const Native = window.EventSource;
    const feeds: FeedStub = [];
    (window as unknown as { __cl1Feeds3: FeedStub }).__cl1Feeds3 = feeds;
    class HandEventSource {
      closed = false;
      readyState = 0;
      listeners: Record<string, Array<(event: { data?: string; lastEventId: string }) => void>> = {};
      constructor(url: string) {
        if (!url.includes('/screen-events')) return new Native(url) as unknown as HandEventSource;
        feeds.push(this);
      }
      addEventListener(type: string, listener: (event: { data?: string; lastEventId: string }) => void) {
        (this.listeners[type] ??= []).push(listener);
      }
      close() { this.closed = true; this.readyState = 2; }
      emit(type: string, data?: string) { for (const listener of this.listeners[type] ?? []) listener({ data, lastEventId: '' }); }
    }
    (window as unknown as { EventSource: unknown }).EventSource = HandEventSource;
  });
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 't', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/*/status', (route) => route.fulfill({ json: { available: false, sessions: [], targets: [{ id: 'claude', name: 'claude', available: true, reason: null }] } }));
  await page.route('**/api/workspace/*/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance: { version: 1, revision: 1, workType: 'feature', size: 'standard', assignment: { stage: 'implement', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] }, lifecycle: null, assignment: '', sharedDocuments: [] } }));
  await page.route('**/api/workspace/demo/board', (route) => route.fulfill({ json: boardFile() }));
  await page.route('**/api/workspace/demo/changes', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes?*', (route) => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/workspace/demo/changes/symbols', (route) => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/demo/news', (route) => route.fulfill({ json: whatsNew() }));
  await page.route('**/api/workspace/demo/incoming**', (route) => route.fulfill({ json: { at: new Date().toISOString(), repos: [] } }));
  await page.route('**/api/workspace/demo/recent-commits', async (route) => route.fulfill(await recent()));
  await page.route('**/api/workspace/demo/commits/**', (route) => {
    const url = new URL(route.request().url());
    const [repo, sha] = url.pathname.split('/commits/')[1]!.split('/').map(decodeURIComponent);
    return route.fulfill({ json: makeDetail({ repo: repo!, sha: sha!, subject: 'Opened commit' }) });
  });
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    if (new URL(route.request().url()).pathname.startsWith('/api/terminals/')) return route.fallback();
    writes.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'writes refused' } });
  });
}

const emitFeed = (page: Page, type: string, data?: string) =>
  page.evaluate(([kind, payload]) => {
    const feeds = (window as unknown as { __cl1Feeds3: FeedStub }).__cl1Feeds3;
    for (const feed of feeds.filter((f) => !f.closed)) {
      if (kind === 'open') feed.readyState = 1;
      feed.emit(kind!, payload);
    }
  }, [type, data] as const);

test('keeps the last good PRs when a refresh fails, drops a section whose last commit joined a PR, and moves focus on from its vanished toggle', async ({ page }) => {
  const SHA_482 = '11223344556677889900aabbccddeeff11223344';
  const SHA_LOCAL = '44556677889900aabbccddeeff11223344556677';
  let mode: 'good' | 'failed' | 'joined' = 'good';
  const pr482 = { number: 482, title: 'Board commit notes and PR grouping', state: 'MERGED', url: PR_URL };
  await setupRecentBoard(page, () => ({
    json: {
      at: new Date().toISOString(),
      from: minutesAgo(180),
      commits: [{
        repo: 'NexusFlow',
        remoteRepo: 'antan87/Context-Space',
        branch: 'feat/cl1-groups',
        base: 'main',
        pullRequests: [pr482],
        // A failed gh refresh: the server keeps the last good PRs and says so; nothing disappears.
        ...(mode === 'failed' ? { prsStale: true } : {}),
        more: 0,
        commits: [
          { sha: SHA_LOCAL.slice(0, 7), author: 'Anton', subject: 'Local commit after the PR', at: minutesAgo(5), fileCount: 1, pushed: false, ...(mode === 'joined' ? { prNumber: 482 } : {}) },
          { sha: SHA_482.slice(0, 7), author: 'Anton', subject: 'Diagram reader support', at: minutesAgo(20), fileCount: 2, pushed: true, prNumber: 482 },
        ],
      }],
    },
  }));

  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: /^Review/ }).click();
  await expect(win(page)).toBeVisible();
  await modeButton(page, 'Commits').click();
  await emitFeed(page, 'open');

  const region = commitsRegion(page);
  await expect(region.getByTestId('commit-pr-link')).toHaveCount(1);
  const unassigned = region.getByTestId('commit-unassigned-toggle');
  await expect(unassigned).toBeVisible();
  await unassigned.click();
  await expect(unassigned).toHaveAttribute('aria-expanded', 'false');
  await unassigned.focus();
  await expect(unassigned).toBeFocused();

  // 1. The refresh failed: the PR heading, its link and the section all stay, marked out of date.
  mode = 'failed';
  await emitFeed(page, 'commits', JSON.stringify({ type: 'commits', timestamp: new Date().toISOString() }));
  await expect(region.getByTestId('commit-pr-stale')).toBeVisible();
  await expect(region.getByTestId('commit-pr-link')).toHaveCount(1);
  await expect(region.getByTestId('commit-pr-link')).toContainText('#482');
  await expect(unassigned).toBeVisible();
  await expect(unassigned).toBeFocused();

  // 2. A good refresh: the last unassigned commit joined #482, so its section goes away. Focus moves to the next toggle.
  mode = 'joined';
  await emitFeed(page, 'commits', JSON.stringify({ type: 'commits', timestamp: new Date().toISOString() }));
  await expect(region.getByTestId('commit-unassigned-toggle')).toHaveCount(0);
  await expect(region.getByTestId('commit-pr-stale')).toHaveCount(0);
  await expect(region.getByRole('treeitem', { name: /Local commit after the PR/ })).toHaveCount(1);
  await expect(region.getByRole('button', { name: 'Toggle pull request #482' })).toBeFocused();
});

test('asks again after 5 s then 15 s when the live feed missed the commits event, then stops', async ({ page }) => {
  const SHA_482 = '11223344556677889900aabbccddeeff11223344';
  const settled = false;
  let fetches = 0;
  await setupRecentBoard(page, () => {
    fetches += 1;
    return {
      json: {
        at: new Date().toISOString(),
        from: minutesAgo(180),
        commits: [{
          repo: 'NexusFlow',
          remoteRepo: 'antan87/Context-Space',
          branch: 'feat/cl1-groups',
          base: 'main',
          ...(settled ? { pullRequests: [{ number: 482, title: 'Late PR', state: 'OPEN', url: PR_URL }] } : { prsPending: true }),
          more: 0,
          commits: [{ sha: SHA_482.slice(0, 7), author: 'Anton', subject: 'Diagram reader support', at: minutesAgo(20), fileCount: 2, pushed: true, ...(settled ? { prNumber: 482 } : {}) }],
        }],
      },
    };
  });
  await page.clock.install();
  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: /^Review/ }).click();
  await expect(win(page)).toBeVisible();
  await modeButton(page, 'Commits').click();

  const region = commitsRegion(page);
  // The feed reconnected before the pending response arrived, and its `commits` event was never delivered.
  await emitFeed(page, 'open');
  await expect(region.getByTestId('commit-pr-loading')).toBeVisible();
  // Freeze the page clock from here, so only what the test advances can fire the fallback.
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await page.waitForTimeout(400);
  const baseline = fetches;
  const settle = () => page.waitForTimeout(300);

  await page.clock.runFor(2_000);
  await settle();
  expect(fetches, 'nothing asks again before 5 s').toBe(baseline);

  // The first fallback ask comes at 5 s (within the 500 ms step it is found in).
  let firstAsk = 0;
  for (let waited = 2_000; waited <= 5_500 && fetches === baseline; waited += 500) {
    await page.clock.runFor(500);
    await settle();
    firstAsk = waited + 500;
  }
  expect(fetches, 'asked again once, at about 5 s').toBe(baseline + 1);
  expect(firstAsk).toBeGreaterThanOrEqual(3_500);
  expect(firstAsk).toBeLessThanOrEqual(5_500);
  await expect(region.getByTestId('commit-pr-loading')).toBeVisible();

  // Still pending: the second ask comes 15 s after the first, not before.
  await page.clock.runFor(13_900);
  await settle();
  expect(fetches, 'nothing asks again before 15 s after the first ask').toBe(baseline + 1);
  await expect(region.getByTestId('commit-pr-loading')).toBeVisible();
  await page.clock.runFor(1_500);
  await expect.poll(() => fetches).toBe(baseline + 2);

  // And then it stops, however long the response stays pending.
  await page.clock.runFor(10 * 60_000);
  await settle();
  expect(fetches, 'no third ask').toBe(baseline + 2);
  // Both asks are spent and the data is still pending: say so instead of "loading" for ever. Check now stays available.
  await expect(region.getByTestId('commit-pr-unavailable')).toHaveText('PR information is not available right now');
  await expect(region.getByTestId('commit-pr-loading')).toHaveCount(0);
  await expect(win(page).getByTestId('incoming-check-now')).toBeVisible();
});

test('a pending response that settles before the 5 s fallback is fetched is picked up by it', async ({ page }) => {
  const SHA_482 = '11223344556677889900aabbccddeeff11223344';
  let settled = false;
  await setupRecentBoard(page, () => ({
    json: {
      at: new Date().toISOString(),
      from: minutesAgo(180),
      commits: [{
        repo: 'NexusFlow',
        remoteRepo: 'antan87/Context-Space',
        branch: 'feat/cl1-groups',
        base: 'main',
        ...(settled ? { pullRequests: [{ number: 482, title: 'Late PR', state: 'OPEN', url: PR_URL }] } : { prsPending: true }),
        more: 0,
        commits: [{ sha: SHA_482.slice(0, 7), author: 'Anton', subject: 'Diagram reader support', at: minutesAgo(20), fileCount: 2, pushed: true, ...(settled ? { prNumber: 482 } : {}) }],
      }],
    },
  }));
  await page.clock.install();
  await page.goto('/#/workspaces/demo/board');
  await page.getByRole('button', { name: /^Review/ }).click();
  await expect(win(page)).toBeVisible();
  await modeButton(page, 'Commits').click();
  const region = commitsRegion(page);
  await emitFeed(page, 'open');
  await expect(region.getByTestId('commit-pr-loading')).toBeVisible();
  settled = true; // gh settled while the feed was down: no commits event will ever arrive
  await page.clock.runFor(5_200);
  await expect(region.getByTestId('commit-pr-loading')).toHaveCount(0);
  await expect(region.getByTestId('commit-pr-link')).toContainText('#482');
});
