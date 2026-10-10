import { test, expect, type Page } from './fixtures';

const feature = {
  id: 'deliver', branchName: 'deliver', description: 'Safe delivery', mode: 'in-place',
  repos: ['/source/api', '/source/web', '/source/docs'], originalRepos: ['/source/api', '/source/web', '/source/docs'],
  isolatedRepos: {
    api: { worktreePath: '/ws/deliver/api', branchName: 'feat/deliver', baseBranch: 'main', isolatedAt: '2026-09-27T00:00:00Z' },
    web: { worktreePath: '/ws/deliver/web', branchName: 'feat/deliver', baseBranch: 'main', isolatedAt: '2026-09-27T00:00:00Z' },
  },
  assistants: [], workspacePath: '/ws/deliver', createdAt: '2026-09-20T00:00:00Z',
};

const repo = (name: string, overrides: object = {}) => ({
  name, access: 'isolated', editable: true, path: `/ws/deliver/${name}`, sourcePath: `/source/${name}`,
  branch: 'feat/deliver', expectedBranch: 'feat/deliver', onExpectedBranch: true, baseBranch: 'main',
  headSha: 'abc1234def', dirty: true, changedFiles: [{ code: ' M', path: 'src/a.ts' }, { code: '??', path: 'src/b.ts' }],
  ahead: 0, behind: 0, remoteUrl: `git@github.com:o/${name}.git`, ...overrides,
});
const repositories = [
  repo('api'),
  repo('web', { changedFiles: [{ code: ' M', path: 'page.tsx' }] }),
  repo('docs', { access: 'reference', editable: false, path: '/source/docs', expectedBranch: null, branch: 'main', changedFiles: [{ code: ' M', path: 'README.md' }] }),
];
const ready = { ready: true, blockers: [], repos: [
  { name: 'api', state: 'passed-dirty', ready: true, detail: 'api passed on uncommitted changes that are still exactly what was tested.' },
  { name: 'web', state: 'passed-dirty', ready: true, detail: 'web passed on uncommitted changes that are still exactly what was tested.' },
] };
const stale = { ready: false, blockers: ['web has changes that were made after it was verified. Verify again.'], repos: [
  ready.repos[0],
  { name: 'web', state: 'stale', ready: false, detail: 'web has changes that were made after it was verified. Verify again.' },
] };

test.use({ workspacesData: [feature], workspacesStatusData: {
  deliver: { id: 'deliver', branchName: 'deliver', changedFiles: 4, dirtyRepos: 3, syncStatus: 'unknown', runningServices: 0 },
} });

async function mockWorkspace(page: Page, options: { progression?: object; lastFinish?: object | null } = {}) {
  await page.route('**/api/workspace/deliver/lifecycle', route => route.fulfill({ json: { lifecycle: { steps: [] }, report: null } }));
  await page.route('**/api/workspace/deliver/changes', route => route.fulfill({ json: { changes: [
    { repoName: 'api', repoPath: '/ws/deliver/api', files: [{ file: 'src/a.ts', type: 'modified', additions: 1, deletions: 0 }, { file: 'src/b.ts', type: 'untracked', additions: 1, deletions: 0 }] },
    { repoName: 'web', repoPath: '/ws/deliver/web', files: [{ file: 'page.tsx', type: 'modified', additions: 1, deletions: 0 }] },
  ] } }));
  await page.route('**/api/workspace/deliver/changes/symbols', route => route.fulfill({ json: { symbols: [] } }));
  await page.route('**/api/workspace/deliver/repositories', route => route.fulfill({ json: { repositories } }));
  await page.route('**/api/workspace/deliver/progression', route => route.fulfill({ json: options.progression ?? ready }));
  await page.route('**/api/workspace/deliver/finish/last', route => route.fulfill({ json: { lastFinish: options.lastFinish ?? null } }));
}

async function openCommitReview(page: Page) {
  await page.goto('/#/workspaces/deliver/changes');
  await page.getByRole('button', { name: 'Review & commit', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Review commit' });
  await expect(panel.getByTestId('commit-repo-api')).toBeVisible();
  return panel;
}

test.describe('reviewed commit', () => {
  for (const failure of [
    { name: 'HTTP 500 with an error body', fulfill: { status: 500, json: { error: 'fatal: Unable to create index.lock' } }, text: /index\.lock/ },
    { name: 'an unreadable response', fulfill: { status: 502, contentType: 'text/html', body: '<html>bad gateway</html>' }, text: /unreadable response/ },
  ]) {
    test(`keeps the message and selection after ${failure.name}`, async ({ page }) => {
      await mockWorkspace(page);
      await page.route('**/api/workspace/deliver/commit', route => route.fulfill(failure.fulfill));
      const panel = await openCommitReview(page);
      await panel.getByRole('checkbox', { name: 'Include api/src/b.ts' }).click();
      await panel.getByLabel('Commit message').fill('feat: reviewed change');
      await panel.getByRole('button', { name: 'Commit & push selected' }).click();

      await expect(panel.getByRole('alert')).toContainText(failure.text);
      await expect(panel.getByRole('alert')).toContainText('Your message and file selection are kept.');
      await expect(panel.getByLabel('Commit message')).toHaveValue('feat: reviewed change');
      await expect(panel.getByRole('checkbox', { name: 'Include api/src/b.ts' })).toHaveAttribute('aria-checked', 'false');
      await expect(panel.getByRole('checkbox', { name: 'Include api/src/a.ts' })).toHaveAttribute('aria-checked', 'true');
    });
  }

  test('keeps the draft when the connection drops', async ({ page }) => {
    await mockWorkspace(page);
    await page.route('**/api/workspace/deliver/commit', route => route.abort('connectionreset'));
    const panel = await openCommitReview(page);
    await panel.getByLabel('Commit message').fill('feat: offline');
    await panel.getByRole('button', { name: 'Commit & push selected' }).click();
    await expect(panel.getByRole('alert')).toContainText('Could not reach ContextSpace');
    await expect(panel.getByLabel('Commit message')).toHaveValue('feat: offline');
  });

  test('names every destination, sends only the reviewed files, and leaves the reference out', async ({ page }) => {
    await mockWorkspace(page);
    let body: any;
    await page.route('**/api/workspace/deliver/commit', async route => {
      body = route.request().postDataJSON();
      await route.fulfill({ json: { skipped: [], results: [
        { repoName: 'api', success: true, committed: true, pushed: true, branch: 'feat/deliver', commitHash: 'aaa1111', filesChanged: 1, message: 'ok' },
        { repoName: 'web', success: true, committed: true, pushed: true, branch: 'feat/deliver', commitHash: 'bbb2222', filesChanged: 1, message: 'ok' },
      ] } });
    });
    const panel = await openCommitReview(page);
    await expect(panel.getByTestId('commit-repo-api')).toContainText('feat/deliver → github.com/o/api');
    await expect(panel.getByTestId('commit-repo-docs')).toContainText('read-only reference');
    await expect(panel.getByRole('checkbox', { name: 'Commit changes in docs' })).toHaveCount(0);
    await panel.getByRole('checkbox', { name: 'Include api/src/b.ts' }).click();
    await expect(panel.getByTestId('commit-review-summary')).toContainText('Commit 2 files in api (feat/deliver), web (feat/deliver), then push to github.com/o/api, github.com/o/web');

    await panel.getByLabel('Commit message').fill('feat: reviewed');
    await panel.getByRole('button', { name: 'Commit & push selected' }).click();
    await expect(page.getByText('Commit results', { exact: true })).toBeVisible();
    expect(body).toEqual({ message: 'feat: reviewed', noPush: false, files: { api: ['src/a.ts'], web: ['page.tsx'] } });
    await expect(page.getByText(/aaa1111\) on feat\/deliver, pushed/)).toBeVisible();
  });

  test('a push that failed after its commit retries only the push', async ({ page }) => {
    await mockWorkspace(page);
    const commits: any[] = [];
    let pushed: any;
    await page.route('**/api/workspace/deliver/commit', async route => {
      commits.push(route.request().postDataJSON());
      await route.fulfill({ json: { skipped: [], results: [
        { repoName: 'api', success: true, committed: true, pushed: true, branch: 'feat/deliver', commitHash: 'aaa1111', filesChanged: 2, message: 'ok' },
        { repoName: 'web', success: false, committed: true, pushed: false, pushError: 'remote rejected', branch: 'feat/deliver', commitHash: 'bbb2222', filesChanged: 1, message: 'push failed' },
      ] } });
    });
    await page.route('**/api/workspace/deliver/push', async route => {
      pushed = route.request().postDataJSON();
      await route.fulfill({ json: { results: [{ name: 'web', pushed: true, branch: 'feat/deliver' }] } });
    });
    const panel = await openCommitReview(page);
    await panel.getByLabel('Commit message').fill('feat: partial');
    await panel.getByRole('button', { name: 'Commit & push selected' }).click();
    await expect(panel.getByText(/web:.*committed bbb2222 on feat\/deliver, push failed — remote rejected/)).toBeVisible();
    await expect(panel.getByLabel('Commit message')).toHaveValue('feat: partial');

    await panel.getByRole('button', { name: 'Retry push (web)' }).click();
    await expect(panel.getByText(/web:.*committed bbb2222 on feat\/deliver, pushed/)).toBeVisible();
    expect(pushed).toEqual({ repos: ['web'] });
    expect(commits).toHaveLength(1);
  });
});

test('prepare for editing previews path, branch and base before creating anything', async ({ page }) => {
  await mockWorkspace(page);
  const isolateCalls: any[] = [];
  await page.route('**/api/workspace/deliver/isolate', async route => {
    const request = route.request().postDataJSON();
    isolateCalls.push(request);
    const plan = { repoName: 'docs', sourcePath: '/source/docs', worktreePath: '/ws/deliver/docs', branchName: 'feat/deliver', baseBranch: 'main', alreadyIsolated: false, conflicts: [] };
    await route.fulfill({ json: request.dryRun ? plan : { success: true, ...plan } });
  });
  await page.goto('/#/workspaces/deliver/changes');
  await page.getByRole('button', { name: /^Show repositories and branches for/ }).click();
  await page.getByRole('button', { name: 'Prepare docs for editing', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Prepare docs for editing' });
  await expect(dialog.getByTestId('prepare-plan')).toContainText('/ws/deliver/docs');
  await expect(dialog.getByTestId('prepare-plan')).toContainText('feat/deliver');
  await expect(dialog.getByTestId('prepare-plan')).toContainText('/source/docs (unchanged)');
  expect(isolateCalls).toEqual([{ repo: 'docs', dryRun: true }]);

  await dialog.getByRole('button', { name: 'Prepare for editing' }).click();
  await expect(dialog).toHaveCount(0);
  expect(isolateCalls[1]).toEqual({ repo: 'docs', branchName: 'feat/deliver', baseBranch: 'main' });
  // Editable repos offer no prepare action; only the reference does.
  await expect(page.getByRole('button', { name: 'Prepare api for editing', exact: true })).toHaveCount(0);
});

test('a path collision is shown and cannot be confirmed', async ({ page }) => {
  await mockWorkspace(page);
  await page.route('**/api/workspace/deliver/isolate', route => route.fulfill({ json: {
    repoName: 'docs', sourcePath: '/source/docs', worktreePath: '/ws/deliver/docs', branchName: 'feat/deliver', baseBranch: 'main',
    alreadyIsolated: false, conflicts: ['A folder already exists at /ws/deliver/docs. Move or remove it first.'],
  } }));
  await page.goto('/#/workspaces/deliver/changes');
  await page.getByRole('button', { name: /^Show repositories and branches for/ }).click();
  await page.getByRole('button', { name: 'Prepare docs for editing', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Prepare docs for editing' });
  await expect(dialog.getByRole('alert')).toContainText('A folder already exists');
  await expect(dialog.getByRole('button', { name: 'Prepare for editing' })).toBeDisabled();
});

test.describe('finish', () => {
  test('stale evidence blocks finish until an explicit, reasoned override', async ({ page }) => {
    await mockWorkspace(page, { progression: stale });
    let body: any;
    await page.route('**/api/workspace/deliver/finish', async route => {
      body = route.request().postDataJSON();
      await route.fulfill({ json: {
        blocked: false, dryRun: false, safeToCleanup: false, policy: stale,
        override: { at: 'now', operation: 'finish', reason: body.overrideReason, blockers: stale.blockers },
        repos: [
          { name: 'api', committed: true, commitHash: 'aaa1111', pushed: true, branch: 'feat/deliver', remoteUrl: null, compareUrl: 'https://github.com/o/api/compare/main...feat/deliver' },
          { name: 'web', committed: true, commitHash: 'bbb2222', pushed: false, branch: 'feat/deliver', remoteUrl: null, error: 'remote rejected' },
          { name: 'docs', committed: false, pushed: false, branch: 'main', remoteUrl: null, skipped: '"docs" is a read-only reference.' },
        ],
      } });
    });
    await page.goto('/#/workspaces/deliver/changes');
    await page.getByRole('button', { name: 'Finish…' }).click();
    const panel = page.getByRole('region', { name: 'Finish work' });
    await expect(panel.getByTestId('finish-evidence')).toContainText('web has changes that were made after it was verified');
    await panel.getByLabel('Commit message for remaining changes').fill('feat: deliver');
    await expect(panel.getByRole('button', { name: 'Finish', exact: true })).toBeDisabled();

    await panel.getByRole('checkbox', { name: 'Finish anyway, with a reason' }).click();
    await panel.getByLabel(/This reason is recorded/).fill('short');
    await expect(panel.getByRole('button', { name: 'Finish', exact: true })).toBeDisabled();
    await panel.getByLabel(/This reason is recorded/).fill('Hotfix approved by the owner');
    await panel.getByRole('button', { name: 'Finish', exact: true }).click();

    await expect(panel.getByTestId('finish-result')).toContainText('Recorded reason: Hotfix approved by the owner');
    await expect(panel.getByTestId('finish-result')).toContainText('web: committed bbb2222, failed — remote rejected');
    await expect(panel.getByTestId('finish-result')).toContainText('Cleanup is unavailable');
    expect(body).toMatchObject({ message: 'feat: deliver', createPrs: true, overrideReason: 'Hotfix approved by the owner', dryRun: false });
  });

  test('after a restart the partial finish is shown and resumed', async ({ page }) => {
    await mockWorkspace(page, { lastFinish: {
      startedAt: '2026-09-27T10:00:00Z', completedAt: '2026-09-27T10:01:00Z', status: 'partial', safeToCleanup: false,
      repos: [
        { name: 'api', committed: true, commitHash: 'aaa1111', pushed: true },
        { name: 'web', committed: true, commitHash: 'bbb2222', pushed: false, error: 'remote rejected' },
      ],
    } });
    await page.route('**/api/workspace/deliver/finish', route => route.fulfill({ json: {
      blocked: false, dryRun: true, safeToCleanup: false, policy: ready,
      repos: [{ name: 'web', committed: false, pushed: false, branch: 'feat/deliver', remoteUrl: 'git@github.com:o/web.git', wouldCommit: false, wouldPush: true }],
    } }));
    await page.goto('/#/workspaces/deliver/changes');
    await page.getByRole('button', { name: 'Finish…' }).click();
    const panel = page.getByRole('region', { name: 'Finish work' });
    await expect(panel.getByTestId('finish-resume')).toContainText('web: committed bbb2222, failed — remote rejected');
    await expect(panel.getByRole('button', { name: 'Resume finish' })).toBeVisible();
    await panel.getByLabel('Commit message for remaining changes').fill('feat: deliver');
    await panel.getByRole('button', { name: 'Preview' }).click();
    await expect(panel.getByTestId('finish-preview')).toContainText('web: push feat/deliver → github.com/o/web');
  });
});
