import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { planFile } from './planData';
import { openMenuFor } from './menus';

const ACTIVE = {
  id: 'demo', branchName: 'demo', name: 'Invoice speed-up', description: 'Make invoice totals load under a second',
  mode: 'in-place', repos: ['/dev/api', '/dev/web'], assistants: [], workspacePath: '/ws/demo', createdAt: '2026-06-01T00:00:00.000Z',
};

const ARCHIVED = {
  ...ACTIVE,
  archivedAt: '2026-09-28T10:00:00.000Z',
  archive: {
    archivedAt: '2026-09-28T10:00:00.000Z', previousMode: 'in-place', parked: true,
    repos: [
      { name: 'api', access: 'isolated', sourcePath: '/dev/api', branch: 'feat/speed', headSha: '1234567890abcdef', branchState: 'merged', mergeEvidence: 'ancestor', branchDeleted: true },
      { name: 'web', access: 'isolated', sourcePath: '/dev/web', branch: 'feat/speed', headSha: 'fedcba0987654321', branchState: 'parked' },
    ],
  },
};

function preview(park: boolean, deleteRemoteBranches = false) {
  return {
    workspacePath: '/ws/demo', workspaceId: 'demo', dryRun: true, alreadyArchived: false,
    ready: park, blockers: park ? [] : ['web: "feat/speed" is pushed but not merged into main. Archive with --park to keep the branch and archive anyway.'],
    repos: [
      { name: 'api', action: 'remove-worktree', reason: 'feat/speed is contained in origin/main', branchState: 'merged', headSha: '1234567' },
      park
        ? { name: 'web', action: 'remove-worktree', reason: '"feat/speed" is pushed but not merged; parked on request, branch kept', branchState: 'parked', headSha: 'fedcba0' }
        : { name: 'web', action: 'blocked', reason: 'web: "feat/speed" is pushed but not merged into main.', branchState: 'unmerged', headSha: 'fedcba0' },
    ],
    kept: ['contextspace-milestones.md', 'contextspace.json'], notes: [], errors: [], archived: false,
    branches: park ? [
      { repo: 'api', branch: 'feat/speed', local: 'delete', remote: deleteRemoteBranches ? 'delete' : 'not-requested', reason: 'merged into the default branch' },
      { repo: 'web', branch: 'feat/speed', local: 'keep', remote: deleteRemoteBranches ? 'keep' : 'not-requested', reason: 'not merged; kept so the work can be picked up again' },
    ] : [],
  };
}

/** A stateful backend for the archive journey: archive and unarchive flip what /api/workspaces returns. */
async function mockArchiveBackend(page: Page) {
  let current: typeof ACTIVE | typeof ARCHIVED = ACTIVE;
  const calls: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [current] }));
  await page.route('**/api/workspace/demo/archive', async (route: Route) => {
    const body = route.request().postDataJSON() as { park: boolean; dryRun?: boolean; deleteRemoteBranches: boolean };
    calls.push({ path: 'archive', body });
    if (body.dryRun) return route.fulfill({ json: preview(body.park, body.deleteRemoteBranches) });
    current = ARCHIVED;
    return route.fulfill({ json: { ...preview(true), dryRun: false, archived: true, archivedAt: ARCHIVED.archivedAt } });
  });
  await page.route('**/api/workspace/demo/unarchive', async (route) => {
    calls.push({ path: 'unarchive', body: null });
    current = ACTIVE;
    return route.fulfill({ json: { workspacePath: '/ws/demo', workspaceId: 'demo', restored: true, notes: [] } });
  });
  await page.route('**/api/workspace/demo/plan', (route) => route.fulfill({ json: planFile() }));
  await page.route('**/api/workspace/demo/documents', (route) => route.fulfill({ json: { documents: [] } }));
  await page.route('**/api/workspace/demo/work', (route) => route.fulfill({ json: {
    guidance: { version: 1, revision: 0, workType: 'performance', size: 'standard', documents: [],
      assignment: { stage: 'implement', objective: 'Find the bottleneck', expectedOutput: '', stopCondition: '' } },
    lifecycle: null, assignment: '', sharedDocuments: [],
  } }));
  return calls;
}

const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });

test('archive previews what happens, parks unmerged work on request, and restores the workspace', async ({ page }) => {
  const calls = await mockArchiveBackend(page);
  await page.goto('/#/workspaces/demo');
  // Overview, Plan, Sessions, Code, Docs, Knowledge, Skills and Services.
  await expect(workspaceNav(page).getByRole('link')).toHaveCount(8);

  await openMenuFor(page.getByRole('button', { name: 'Workspace actions' }), page.getByRole('menuitem', { name: 'Archive workspace…' }));
  await page.getByRole('menuitem', { name: 'Archive workspace…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Archive workspace' });
  await expect(dialog.getByRole('list', { name: 'Repositories' })).toContainText('Blocks archive');
  await expect(dialog.getByText('Nothing will be removed until every blocking repository is resolved.')).toBeVisible();
  const archiveButton = dialog.getByRole('button', { name: 'Archive workspace' });
  await expect(archiveButton).toBeDisabled();

  // Pushed-but-unmerged work is the only obstacle, so parking it is offered.
  await dialog.getByRole('checkbox', { name: 'Archive pushed but unmerged work' }).click();
  await expect(dialog.getByRole('list', { name: 'Repositories' })).not.toContainText('Blocks archive');
  await expect(dialog).toContainText('Kept in the workspace folder: contextspace-milestones.md, contextspace.json');
  const branches = dialog.getByRole('list', { name: 'Branches' });
  await expect(branches).toContainText('feat/speed in api: deleted — merged into the default branch');
  await expect(branches).toContainText('feat/speed in web: kept — not merged');
  await dialog.getByRole('checkbox', { name: 'Also delete merged branches on origin' }).click();
  await expect(branches).toContainText('feat/speed in api: deleted, also on origin');
  await archiveButton.click();
  await expect(dialog).toBeHidden();
  const none = { keepBranches: false, deleteRemoteBranches: false };
  // Only the first preview fetches; option changes re-plan without fetching again.
  expect(calls.filter((call) => call.path === 'archive').map((call) => call.body)).toEqual([
    { park: false, ...none, dryRun: true }, { park: true, ...none, dryRun: true, fetch: false },
    { park: true, keepBranches: false, deleteRemoteBranches: true, dryRun: true, fetch: false },
    { park: true, keepBranches: false, deleteRemoteBranches: true },
  ]);

  // The record is read-only and shows what archive kept.
  await expect(page.getByRole('status').filter({ hasText: 'Archived on' })).toBeVisible();
  // The record and what it knew; nothing to act on.
  await expect(workspaceNav(page).getByRole('link')).toHaveText(['Record', 'Plan', 'Docs']);
  const record = page.getByRole('table');
  await expect(record).toContainText('feat/speed');
  await expect(record).toContainText('1234567890');
  await expect(record).toContainText('Parked (pushed, not merged)');
  await expect(record).toContainText('branch deleted');

  // Out of the active list, one click away under Archived.
  await page.goto('/#/overview');
  const sidebar = page.getByRole('complementary').first();
  await expect(sidebar.getByText('No active workspaces')).toBeVisible();
  await sidebar.getByRole('button', { name: 'Archived (1)' }).click();
  await expect(sidebar.getByRole('link', { name: /Invoice speed-up/ })).toBeVisible();

  // A deep link to a working section lands on the record; the plan cannot be edited.
  await page.goto('/#/workspaces/demo/changes');
  await expect(page.getByRole('table')).toBeVisible();
  await page.goto('/#/workspaces/demo/plan');
  // The record is read, not edited: the plan shows what it said, with no editors to open.
  await expect(page.getByRole('region', { name: 'Goal', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit the goal' })).toHaveCount(0);
  await expect(page.getByLabel('Current objective')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save goal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit sources' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add document' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run verification' })).toHaveCount(0);
  await page.goto('/#/workspaces/demo/knowledge');
  await expect(page.getByRole('region', { name: 'Knowledge' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Edit Knowledge/ })).toHaveCount(0);
  await page.goto('/#/workspaces/demo/plan');

  await page.getByRole('button', { name: 'Restore workspace' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Archived on' })).toHaveCount(0);
  // Overview, Plan, Sessions, Code, Docs, Knowledge, Skills and Services.
  await expect(workspaceNav(page).getByRole('link')).toHaveCount(8);
  await page.getByRole('button', { name: 'Edit the goal' }).click();
  await expect(page.getByLabel('Current objective')).toBeEnabled();
  expect(calls.at(-1)?.path).toBe('unarchive');
});

test('delete says what is lost and offers archive instead', async ({ page }) => {
  await mockArchiveBackend(page);
  await page.goto('/#/workspaces/demo');
  await openMenuFor(page.getByRole('button', { name: 'Workspace actions' }), page.getByRole('menuitem', { name: 'Delete workspace…' }));
  await page.getByRole('menuitem', { name: 'Delete workspace…' }).click();
  const remove = page.getByRole('dialog', { name: 'Delete workspace' });
  await expect(remove).toContainText('milestones, verification results, planning notes, knowledge and documents');
  await remove.getByRole('button', { name: 'Archive instead' }).click();
  await expect(remove).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Archive workspace' })).toBeVisible();
});
