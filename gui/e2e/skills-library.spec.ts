import type { Page, Request } from '@playwright/test';
import { test, expect } from './fixtures';

const base = { repos: [], assistants: [], mode: 'in-place', createdAt: '2026-08-16T00:00:00.000Z' };
const workspaces = [
  { ...base, id: 'example', branchName: 'example', name: 'Example work', description: 'Skills test', workspacePath: '/ws/example' },
  { ...base, id: 'retired', branchName: 'retired', name: 'Retired work', description: 'Done', workspacePath: '/ws/retired', archivedAt: '2026-09-28T10:00:00.000Z' },
];

const skill = (id: string, title: string, scope: 'global' | 'workspace') => ({
  id, name: id, title, category: 'general', description: `Use when testing ${title}.`, content: `# ${title}`, custom: true, scope,
});
const shared = skill('shared-skill', 'Shared Skill', 'global');
const local = skill('local-skill', 'Local Skill', 'workspace');

test.use({ workspacesData: [workspaces, { option: true }] });

interface Seen { deletes: Request[]; saves: unknown[] }

/** The skills API for one workspace ("example") whose own package sits beside a global one. Saves can be made to fail. */
async function mockSkills(page: Page, { failSaves = false } = {}): Promise<Seen> {
  const seen: Seen = { deletes: [], saves: [] };
  await page.route('**/api/skills**', async (route, request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/skills/categories') {
      return route.fulfill({ json: { categories: [{ id: 'general', name: 'General', custom: true }, { id: 'ops', name: 'Operations', custom: true }] } });
    }
    if (url.pathname === '/api/skills/workspace/example') {
      return route.fulfill({ json: { config: { schemaVersion: 1, revision: 1, enabledSkills: [], enabledAgents: [], enabledCategories: ['general'] } } });
    }
    if (url.pathname === '/api/skills' && request.method() === 'GET') {
      return route.fulfill({ json: { skills: url.searchParams.get('workspace') === 'example' ? [shared, local] : [shared] } });
    }
    if (url.pathname === '/api/skills' && request.method() === 'POST') {
      seen.saves.push(request.postDataJSON());
      return failSaves ? route.fulfill({ status: 400, json: { error: 'That category is read-only.' } }) : route.fulfill({ json: { success: true, skill: shared } });
    }
    if (request.method() === 'DELETE') {
      seen.deletes.push(request);
      return route.fulfill({ json: { success: true } });
    }
    return route.fallback();
  });
  return seen;
}

test.describe('Skill Library', () => {
  test('deletes a global skill from the catalog even after a workspace skill was opened', async ({ page }) => {
    const seen = await mockSkills(page);
    await page.goto('/#/skills');
    await expect(page.getByRole('heading', { name: 'Skill Library' })).toBeVisible();

    // Opening a workspace's own skill leaves the editor on that workspace's scope.
    await page.getByLabel('Scope:').selectOption('example');
    await page.getByText('Local Skill', { exact: true }).click();
    await expect(page.getByRole('dialog').getByText('Edit Skill Package')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByLabel('Scope:').selectOption('global');
    // The explorer acts on the skill that is selected in its list.
    await page.getByText('Shared Skill', { exact: true }).click();
    await page.getByRole('button', { name: 'Delete skill' }).click();
    await expect(page.getByRole('dialog').getByText('Delete Global Skill')).toBeVisible();
    await page.getByRole('button', { name: 'Delete Permanently' }).click();

    // The global package is deleted as a global one. Naming a workspace made the server look only there: "Skill not found".
    await expect.poll(() => seen.deletes.length).toBe(1);
    const url = new URL(seen.deletes[0]!.url());
    expect(url.pathname).toBe('/api/skills/shared-skill');
    expect(url.searchParams.has('workspace')).toBe(false);
  });

  test('offers delete in a workspace\'s view only for that workspace\'s own skills', async ({ page }) => {
    await mockSkills(page);
    await page.goto('/#/skills');
    await page.getByLabel('Scope:').selectOption('example');
    await expect(page.getByText('Shared Skill', { exact: true })).toBeVisible();
    await expect(page.getByText('Local Skill', { exact: true })).toBeVisible();

    // One trash button for two custom skills: the global one is not deleted from here.
    await expect(page.getByRole('button', { name: 'Delete skill' })).toHaveCount(1);
  });

  test('a key pressed on a card\'s button acts on that button, not on the card', async ({ page }) => {
    await mockSkills(page);
    await page.goto('/#/skills');
    await page.getByText('Shared Skill', { exact: true }).click();

    await page.getByRole('button', { name: 'Move to another category' }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('dialog').getByText('Move Skill to Category')).toBeVisible();
    await expect(page.getByText('Edit Skill Package')).toHaveCount(0);
  });

  test('says so when a skill cannot be moved, and keeps the dialog open', async ({ page }) => {
    const seen = await mockSkills(page, { failSaves: true });
    await page.goto('/#/skills');
    await page.getByText('Shared Skill', { exact: true }).click();
    await page.getByRole('button', { name: 'Move to another category' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Operations/ }).click();

    await expect(page.getByText('That category is read-only.')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Move Skill to Category')).toBeVisible();
    expect(seen.saves).toHaveLength(1);
  });

  test('typing a letter in the scope picker picks an option and does not collapse the sidebar', async ({ page }) => {
    await mockSkills(page);
    await page.goto('/#/skills');
    const sidebar = page.locator('aside.context-sidebar');
    await expect(sidebar.getByRole('button', { name: /^Collapse/ })).toBeVisible();

    // "z" is the sidebar's own key, but a letter pressed in a select belongs to the select.
    await page.getByLabel('Scope:').focus();
    await page.keyboard.press('z');
    await page.waitForTimeout(300);
    await expect(sidebar.getByRole('button', { name: /^Collapse/ })).toBeVisible();

    // Anywhere else on the page it still collapses it.
    await page.locator('body').click({ position: { x: 600, y: 300 } });
    await page.keyboard.press('z');
    await expect(sidebar.getByRole('button', { name: /^Collapse/ })).toHaveCount(0);
  });

  test('names workspaces in the scope list and marks an archived one', async ({ page }) => {
    await mockSkills(page);
    await page.goto('/#/skills');
    const scope = page.getByLabel('Scope:');
    await expect(scope.locator('option', { hasText: 'Example work' })).toHaveCount(1);
    await expect(scope.locator('option', { hasText: 'Retired work (retired) · archived' })).toHaveCount(1);
  });
});

test.describe('Skills of one workspace', () => {
  test('are reached from the Skill Library and highlighted on the workspace rail', async ({ page }) => {
    await mockSkills(page);
    await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [] } }));
    await page.goto('/#/skills');
    await expect(page.getByRole('heading', { name: 'Skill Library' })).toBeVisible();
    const link = page.getByRole('link', { name: "This workspace's skills" });
    // The global catalog belongs to no workspace, and an archived workspace has no skills view to open.
    await expect(link).toHaveCount(0);
    await page.getByLabel('Scope:').selectOption('retired');
    await expect(link).toHaveCount(0);

    await page.getByLabel('Scope:').selectOption('example');
    await link.click();
    await expect(page).toHaveURL(/#\/workspaces\/example\/skills$/);
    await expect(page.getByRole('heading', { name: 'Workspace Skills & Agents' })).toBeVisible();
    // Skills are on the rail, so the Skills item is marked.
    const rail = page.getByRole('navigation', { name: 'Workspace' });
    await expect(rail.getByRole('link')).toHaveText(['Overview', 'Plan', 'Sessions', 'Code', 'Docs', 'Skills', 'Services']);
    await expect(rail.getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');
  });

  test('still open at the old workspace address', async ({ page }) => {
    await mockSkills(page);
    await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [] } }));
    await page.goto('/#/workspaces/example/skills');
    await expect(page.getByRole('heading', { name: 'Workspace Skills & Agents' })).toBeVisible();
    await expect(page.getByText('Local Skill', { exact: true })).toBeVisible();
  });
});
