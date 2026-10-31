import { test, expect } from './fixtures';

const feature = {
  id: 'review', branchName: 'review', description: 'Review changes', mode: 'worktree',
  repos: ['/workspaces/review/app'], originalRepos: ['/source/app'],
  assistants: [], workspacePath: '/workspaces/review', createdAt: '2026-09-20T00:00:00Z',
};
const diff = 'diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-export const answer = 1;\n+export const answer = 2;\n';

test.use({ workspacesData: [feature], workspacesStatusData: {
  review: { id: 'review', branchName: 'review', changedFiles: 1, dirtyRepos: 1, syncStatus: 'up-to-date', runningServices: 0 },
} });

test('reviews the actual worktree, switches diff mode, and copies refinement feedback for CLI chat', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin });
  const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/workspace/review/lifecycle', route => route.fulfill(json({ lifecycle: { steps: [] }, report: null })));
  await page.route('**/api/workspace/review/changes', route => route.fulfill(json({ changes: [{ repoName: 'app', repoPath: feature.repos[0], files: [{ file: 'demo.ts', type: 'modified', additions: 1, deletions: 1 }] }] })));
  await page.route('**/api/workspace/review/changes/symbols', route => route.fulfill(json({ symbols: [] })));
  await page.route('**/api/workspace/review/changes/diff?*', route => route.fulfill(json({ diff, fileContent: 'export const answer = 2;\n', originalContent: 'export const answer = 1;\n', symbols: [] })));
  await page.goto('/#/workspaces/review/changes');
  await expect(page.getByRole('heading', { level: 1, name: 'review' })).toBeVisible();
  // The one workspace header reports the changes and links to where they are reviewed.
  await page.getByRole('button', { name: 'Workspace actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Changes/ })).toContainText('1 file');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: /^Code/ })).toHaveAttribute('aria-current', 'page');
  const code = page.getByRole('region', { name: 'Workspace code' });
  await code.getByRole('treeitem', { name: /demo\.ts/ }).click();
  const diffToolbar = code.getByRole('toolbar', { name: 'Diff' });
  const sideBySide = diffToolbar.getByRole('button', { name: 'Side by side' });
  await expect(sideBySide).toHaveAttribute('aria-pressed', 'true');
  await sideBySide.click();
  await expect(sideBySide).toHaveAttribute('aria-pressed', 'false');
  await sideBySide.click();
  await expect(sideBySide).toHaveAttribute('aria-pressed', 'true');
  // Accepting a change needs a caller that can apply it; the review does not offer it.
  await diffToolbar.getByRole('button', { name: 'More diff options' }).click();
  // Only an open menu can show that the item is absent, and only one that has opened can be closed by Escape.
  const moreOptions = page.getByRole('menu', { name: 'More diff options' });
  await expect(moreOptions).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Accept this change/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(moreOptions).toBeHidden();
  await diffToolbar.getByRole('button', { name: /Refine/ }).click();
  await page.getByPlaceholder('e.g. Ensure null safety when calculating vacation debt...').fill('Use answer 3 instead.');
  await page.getByRole('button', { name: 'Copy for CLI chat', exact: true }).click();
  await expect(page.getByRole('region', { name: 'CLI Chat' })).toBeVisible();
  const request = await page.evaluate(() => navigator.clipboard.readText());
  expect(request).toContain('Use answer 3 instead.');
  expect(request).toContain('app/demo.ts');
  expect(request).toContain('+export const answer = 2;');
  const references = await page.evaluate(async () => {
    // Exercise the provider's search against real Monaco text models.
    const monaco = await import('/node_modules/monaco-editor/esm/vs/editor/editor.api.js');
    const { findChangesetReferences } = await import('/src/features/changes/utils/changesetSymbolIndex.ts');
    const modified = monaco.editor.createModel('answer answerExtra answer', 'typescript', monaco.Uri.parse('file:///test/references.ts'));
    const original = monaco.editor.createModel('answer', 'typescript', monaco.Uri.parse('diff-original:///test/references.ts'));
    try {
      return findChangesetReferences([modified, original], 'answer').map((result) => result.range.startColumn);
    } finally {
      modified.dispose();
      original.dispose();
    }
  });
  expect(references).toEqual([1, 20]);
});
