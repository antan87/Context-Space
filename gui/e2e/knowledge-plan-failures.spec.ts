import { test, expect } from './fixtures';
import { planFile } from './planData';

const workspace = (branchName: string) => ({
  id: branchName,
  branchName,
  description: `${branchName} workspace`,
  repos: [`C:/dev/${branchName}`],
  assistants: [],
  workspacePath: `C:/ws/${branchName}`,
  createdAt: '2026-06-01T00:00:00.000Z',
});

test.describe('Knowledge and Plan failure recovery', () => {
  test.use({ workspacesData: [workspace('demo')] });

  test('keeps a Knowledge draft after a failed load and applies a successful retry', async ({ page }) => {
    let knowledgeGets = 0;
    await page.route('**/api/workspace/*/knowledge', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      knowledgeGets += 1;
      if (knowledgeGets === 1) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ content: '# Loaded knowledge\n\nKeep this revision.' }),
        });
      }
      if (knowledgeGets === 2) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'secret backend details' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: '# Retried knowledge\n\nNew revision.' }),
      });
    });
    await page.route('**/api/workspace/*/plan', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(planFile({ intro: 'Plan fixture' })),
      });
    });

    await page.goto('/#/workspaces/demo/knowledge');
    await expect(page.getByText('Keep this revision.')).toBeVisible();
    await page.getByRole('button', { name: 'Edit Knowledge' }).click();
    const editor = page.getByRole('textbox', { name: 'Knowledge editor' });
    await editor.fill('# Unsaved draft');

    // Returning to the tab starts a second load without clearing the editor.
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Plan', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Plan', exact: true })).toBeVisible();
    await page.goto('/#/workspaces/demo/knowledge');
    await expect(page.getByRole('region', { name: 'Knowledge', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Existing content and your draft were kept.');
    await expect(page.getByRole('alert')).not.toContainText('secret backend details');
    await expect(editor).toHaveValue('# Unsaved draft');

    await page.getByRole('button', { name: 'Retry load' }).click();
    await expect(editor).toHaveValue('# Unsaved draft');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('New revision.')).toBeVisible();
  });

  test('keeps the Knowledge editor open after a failed save and closes after confirmed retry', async ({ page }) => {
    let saveAttempts = 0;
    await page.route('**/api/workspace/*/knowledge', async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ content: '# Before save' }),
        });
      }
      saveAttempts += 1;
      if (saveAttempts === 1) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'credentials must not be shown' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto('/#/workspaces/demo/knowledge');
    await page.getByRole('button', { name: 'Edit Knowledge' }).click();
    const editor = page.getByRole('textbox', { name: 'Knowledge editor' });
    await editor.fill('# Draft to save');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByRole('alert')).toContainText('Your draft is still open.');
    await expect(editor).toHaveValue('# Draft to save');
    await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Knowledge', exact: true })).not.toBeVisible();

    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(page.getByText('Draft to save')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Knowledge' })).toBeVisible();
  });

  test('keeps a confirmed save when an earlier Knowledge reload returns afterward', async ({ page }) => {
    let knowledgeGets = 0;
    let releaseReload!: () => void;
    const reloadResponse = new Promise<void>((resolve) => { releaseReload = resolve; });
    await page.route('**/api/workspace/*/knowledge', async (route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      }

      knowledgeGets += 1;
      if (knowledgeGets === 2) await reloadResponse;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          content: knowledgeGets === 1 ? '# Before reload' : '# Stale delayed revision',
        }),
      });
    });

    await page.goto('/#/workspaces/demo/knowledge');
    await expect(page.getByText('Before reload')).toBeVisible();
    await page.getByRole('button', { name: 'Edit Knowledge' }).click();
    const editor = page.getByRole('textbox', { name: 'Knowledge editor' });
    await editor.fill('# Saved revision');

    const delayedReload = page.waitForRequest((request) =>
      request.url().includes('/demo/knowledge') && request.method() === 'GET' && knowledgeGets >= 1,
    );
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Plan', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Plan', exact: true })).toBeVisible();
    await page.goto('/#/workspaces/demo/knowledge');
    await expect(page.getByRole('region', { name: 'Knowledge', exact: true })).toBeVisible();
    await delayedReload;

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved revision')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Knowledge' })).toBeVisible();

    const delayedReloadResponse = page.waitForResponse((response) =>
      response.url().includes('/demo/knowledge') && response.request().method() === 'GET',
    );
    releaseReload();
    const response = await delayedReloadResponse;
    await response.finished();
    await expect(page.getByText('Saved revision')).toBeVisible();
    await expect(page.getByText('Stale delayed revision')).not.toBeVisible();
  });

  test('ignores an old workspace response and preserves newer typing during a pending save', async ({ page }) => {
    test.setTimeout(15_000);
    const oldWorkspace = workspace('old');
    const newWorkspace = workspace('new');
    await page.unroute('**/api/workspaces');
    await page.route('**/api/workspaces', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([oldWorkspace, newWorkspace]),
    }));

    let releaseOld!: () => void;
    const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
    let saveRelease!: () => void;
    const saveResponse = new Promise<void>((resolve) => { saveRelease = resolve; });
    await page.route('**/api/workspace/*/knowledge', async (route) => {
      const url = route.request().url();
      if (route.request().method() === 'PUT') {
        await saveResponse;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      }
      if (url.includes('/old/knowledge')) {
        await oldResponse;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ content: '# Old workspace response' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: '# New workspace content' }),
      });
    });

    const oldKnowledgeRequest = page.waitForRequest((request) => request.url().includes('/old/knowledge') && request.method() === 'GET');
    await page.goto('/#/workspaces/old/knowledge');
    await oldKnowledgeRequest;
    await page.goto('/#/workspaces/new/knowledge');
    await expect(page.getByText('New workspace content')).toBeVisible();
    releaseOld();
    await page.waitForTimeout(100);
    await expect(page.getByText('Old workspace response')).not.toBeVisible();

    await page.getByRole('button', { name: 'Edit Knowledge' }).click();
    const editor = page.getByRole('textbox', { name: 'Knowledge editor' });
    await editor.fill('# First draft');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await editor.fill('# Newer typing');
    saveRelease();
    await expect(editor).toHaveValue('# Newer typing');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  });
});
