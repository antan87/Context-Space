import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

test.use({
  workspacesData: [{
    id: 'demo', branchName: 'demo', name: 'Invoice speed-up', description: 'Make invoice totals load under a second', repos: ['/dev/api'],
    assistants: [], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z',
  }],
  workspacesStatusData: { demo: { id: 'demo', branchName: 'demo', changedFiles: 0, dirtyRepos: 0, syncStatus: 'up-to-date', runningServices: 0 } },
});

const summary = '2 knowledge entries and the planning notes in this workspace exist only on this computer, because it has no git remote.';
const atRisk = {
  remote: { state: 'none' },
  handWritten: { knowledgeEntries: 2, planningNotes: true },
  atRisk: true,
  summary,
  message: `${summary} Back them up: \`ctxspace remote add <git-url>\`, then \`ctxspace remote push\`.`,
};
const backedUp = {
  remote: { state: 'configured', name: 'origin', url: 'https://github.com/team/notes.git' },
  handWritten: { knowledgeEntries: 2, planningNotes: true },
  atRisk: false,
  summary: null,
  message: null,
};

async function openWorkspace(page: Page, backup: unknown) {
  const lifecycle = { workspaceId: 'demo', flowType: 'feature', revision: 0, updatedAt: '', fleet: [], steps: [] };
  const guidance = { version: 1, revision: 0, workType: 'feature', size: 'standard', documents: [],
    assignment: { stage: 'implement', objective: 'Find the bottleneck', expectedOutput: '', stopCondition: '' } };
  await page.route('**/api/workspace/demo/backup', (route) => route.fulfill({ json: { backup } }));
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: { content: '# Plan' } }));
  await page.route('**/api/workspace/demo/lifecycle', (route) => route.fulfill({ json: { lifecycle, report: { overallStatus: 'pass', canProgress: true, durationMs: 1000, repos: [] } } }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: { guidance, lifecycle, sharedDocuments: [], assignment: '' } }));
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.goto('/#/workspaces/demo/overview');
  await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
}

const notice = (page: Page) => page.getByRole('status', { name: 'Backup' });

test.describe('Workspace backup notice', () => {
  test('says the notes exist only on this computer, and shows the two commands to fix it', async ({ page }) => {
    await openWorkspace(page, atRisk);

    await expect(notice(page)).toContainText('Not backed up.');
    await expect(notice(page)).toContainText(summary);
    await expect(notice(page).getByRole('button', { name: 'Copy command: ctxspace remote add <git-url>' })).toBeVisible();
    await expect(notice(page).getByRole('button', { name: 'Copy command: ctxspace remote push' })).toBeVisible();
  });

  test('copies a command rather than running it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const writes: string[] = [];
    // Anything that would add a remote or push goes through the API; clicking must never call it.
    // Requests the page makes by itself while loading are not counted, only those made by the click.
    page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${request.url()}`); });
    await openWorkspace(page, atRisk);
    await expect(notice(page)).toBeVisible();
    writes.length = 0;

    await notice(page).getByRole('button', { name: 'Copy command: ctxspace remote push' }).click();

    await expect(notice(page).getByRole('button', { name: 'Copied: ctxspace remote push' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ctxspace remote push');
    expect(writes).toEqual([]);
  });

  test('can be dismissed, and stays dismissed after a reload', async ({ page }) => {
    await openWorkspace(page, atRisk);
    await expect(notice(page)).toBeVisible();

    await notice(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice(page)).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });

  test('shows nothing once a remote is set', async ({ page }) => {
    await openWorkspace(page, backedUp);

    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });

  test('shows nothing, and breaks nothing, when the status cannot be read', async ({ page }) => {
    await openWorkspace(page, atRisk);
    await page.unroute('**/api/workspace/demo/backup');
    await page.route('**/api/workspace/demo/backup', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));
    await page.reload();

    await expect(page.getByRole('heading', { level: 1, name: 'Invoice speed-up' })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the notice meets the automated accessibility rules', async ({ page }) => {
      await openWorkspace(page, atRisk);
      await expect(notice(page)).toBeVisible();
      // Measure settled colours, not a fade caught half-way.
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .include('[aria-label="Backup"]')
        .analyze();

      const serious = results.violations
        .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.html.slice(0, 100)).join(' | ')}`);
      expect(serious, `${colorScheme}: ${serious.join('\n')}`).toEqual([]);
    });
  });
}
