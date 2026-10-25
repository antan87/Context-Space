import type { Page, Request } from '@playwright/test';
import { test, expect } from './fixtures';

const skill = (id: string, title: string, category = 'general') => ({
  id, name: id, title, category, description: `Use when testing ${title}.`, content: `# ${title}`, custom: true, scope: 'global',
});
const shared = skill('shared-skill', 'Shared Skill');
const ops = skill('ops-skill', 'Ops Skill', 'ops');
const pdf = {
  id: 'pdf', name: 'pdf', title: 'pdf', category: 'documents', description: 'Read and fill PDFs.', content: '# pdf', custom: false,
  source: { harness: 'claude', label: 'Claude Code', root: '/home/me/.claude/skills' },
};

const workspaces = [
  { repos: [], assistants: [], mode: 'in-place', createdAt: '2026-08-16T00:00:00.000Z', id: 'example', branchName: 'example', name: 'Example work', description: 'Skills test', workspacePath: '/ws/example' },
];

test.use({ workspacesData: [workspaces, { option: true }] });

interface Seen { deletes: Request[]; saves: any[]; imports: unknown[] }

/** The skills API: My library skills in two categories and one skill a tool ships. Saves can be made to fail. */
async function mockSkills(page: Page, { failSaves = false } = {}): Promise<Seen> {
  const seen: Seen = { deletes: [], saves: [], imports: [] };
  await page.route('**/api/skills**', async (route, request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/skills/categories') {
      return route.fulfill({ json: { categories: [{ id: 'general', name: 'General', custom: true }, { id: 'ops', name: 'Operations', custom: true }] } });
    }
    if (url.pathname === '/api/skills/import') {
      seen.imports.push(request.postDataJSON());
      return route.fulfill({ json: { skill: { ...skill('pdf', 'pdf', 'documents') } } });
    }
    if (url.pathname === '/api/skills' && request.method() === 'GET') {
      return route.fulfill({ json: { skills: [shared, ops, pdf] } });
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
  test('is My library only: no workspace picker, and it points to a workspace\'s Skills tab', async ({ page }) => {
    await mockSkills(page);
    await page.goto('/#/skills');
    await expect(page.getByRole('heading', { name: 'Skill Library' })).toBeVisible();

    await expect(page.getByLabel('Scope:')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save selection' })).toHaveCount(0);
    await expect(page.getByText('open that workspace and use its Skills tab', { exact: false })).toBeVisible();
    // No skill is called "global" here.
    await expect(page.getByText('Global', { exact: false })).toHaveCount(0);
  });

  test('lists My library by category and, per tool, the skills it has built in', async ({ page }) => {
    await mockSkills(page);
    await page.goto('/#/skills');

    const list = page.getByRole('complementary', { name: 'Skill list' });
    await expect(list.getByText('My library', { exact: true })).toBeVisible();
    await expect(list.getByRole('listitem', { name: 'General category' })).toContainText('Shared Skill');
    await expect(list.getByRole('listitem', { name: 'Operations category' })).toContainText('Ops Skill');
    await expect(list.getByText('Built into Claude Code', { exact: true })).toBeVisible();
  });

  test('copies a skill a tool ships into My library', async ({ page }) => {
    const seen = await mockSkills(page);
    await page.goto('/#/skills');
    await page.getByRole('button', { name: /^pdf\b/ }).click();
    await expect(page.getByText('Built into Claude Code · read-only')).toBeVisible();
    await page.getByRole('button', { name: 'Add pdf to my library' }).click();

    await expect.poll(() => seen.imports).toEqual([{ harness: 'claude', id: 'pdf' }]);
  });

  test('moves a skill to another category by dragging it there', async ({ page }) => {
    const seen = await mockSkills(page);
    await page.goto('/#/skills');

    await page.getByRole('button', { name: /Shared Skill/ }).dragTo(page.getByRole('listitem', { name: 'Operations category' }));
    await expect.poll(() => seen.saves.length).toBe(1);
    expect(seen.saves[0]).toMatchObject({ id: 'shared-skill', category: 'ops' });
  });

  test('deletes a skill from My library', async ({ page }) => {
    const seen = await mockSkills(page);
    await page.goto('/#/skills');
    await expect(page.getByRole('heading', { name: 'Skill Library' })).toBeVisible();

    // The explorer acts on the skill that is selected in its list.
    await page.getByText('Shared Skill', { exact: true }).click();
    await page.getByRole('button', { name: 'Delete skill' }).click();
    await expect(page.getByRole('dialog').getByText('Delete Skill', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete Permanently' }).click();

    // The library skill is deleted as a library one: no workspace is named.
    await expect.poll(() => seen.deletes.length).toBe(1);
    const url = new URL(seen.deletes[0]!.url());
    expect(url.pathname).toBe('/api/skills/shared-skill');
    expect(url.searchParams.has('workspace')).toBe(false);
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

  test('a skill made here is saved to My library, with no workspace to choose', async ({ page }) => {
    const seen = await mockSkills(page);
    await page.goto('/#/skills');
    await page.getByRole('button', { name: 'New Skill' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Workspace-Local')).toHaveCount(0);
    await expect(dialog.getByText('Target Workspace')).toHaveCount(0);
    await dialog.getByLabel('Display Title').fill('Fresh Skill');
    await dialog.getByLabel('Trigger Description (for AI Autonomous Discovery)').fill('Use when testing.');
    await dialog.getByRole('button', { name: 'Save Skill' }).click();

    await expect.poll(() => seen.saves.length).toBe(1);
    expect(seen.saves[0]).toMatchObject({ name: 'fresh-skill', scope: 'global' });
    expect(seen.saves[0].workspaceId).toBeUndefined();
  });
});

test.describe('Skills of one workspace', () => {
  test('are reached from the workspace rail, where the Skills item is marked', async ({ page }) => {
    await mockSkills(page);
    await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [] } }));
    await page.route('**/api/skills/workspace/example', (route) => route.fulfill({ json: { config: { schemaVersion: 2, revision: 1, enabledSkills: [], enabledAgents: [], enabledCategories: [] }, resolvedSkills: [], installedSkills: [] } }));
    await page.goto('/#/workspaces/example');
    const rail = page.getByRole('navigation', { name: 'Workspace' });
    await rail.getByRole('link', { name: 'Skills' }).click();
    await expect(page).toHaveURL(/#\/workspaces\/example\/skills$/);
    await expect(page.getByRole('heading', { name: 'Workspace Skills & Agents' })).toBeVisible();
    await expect(rail.getByRole('link')).toHaveText(['Overview', 'Plan', 'Sessions', 'Code', 'Docs', 'Skills', 'Services']);
    await expect(rail.getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');
  });

  test('still open at the old workspace address', async ({ page }) => {
    await mockSkills(page);
    await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [] } }));
    await page.route('**/api/skills/workspace/example', (route) => route.fulfill({ json: { config: { schemaVersion: 2, revision: 1, enabledSkills: [], enabledAgents: [], enabledCategories: [] }, resolvedSkills: [], installedSkills: [] } }));
    await page.goto('/#/workspaces/example/skills');
    await expect(page.getByRole('heading', { name: 'Workspace Skills & Agents' })).toBeVisible();
    await expect(page.getByText('Shared Skill', { exact: true })).toBeVisible();
  });
});
