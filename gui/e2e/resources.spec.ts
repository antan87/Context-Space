import { test, expect } from './fixtures';

const workspace = {
  id: 'example',
  branchName: 'example',
  description: 'Resource test workspace',
  repos: [],
  assistants: ['codex'],
  workspacePath: 'C:\\mock-dev\\workspaces\\example',
  createdAt: '2026-08-16T00:00:00.000Z',
};

const skill = {
  id: 'portable-skill',
  name: 'portable-skill',
  title: 'Portable Skill',
  category: 'general',
  description: 'Use when testing resource selection.',
  content: '# Portable Skill',
  custom: true,
};

test.describe('Resource Library', () => {
  test('shows skills that did not load, and what to fix, on the Skills page', async ({ page }) => {
    await page.route('**/api/skills**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/skills/categories') return route.fulfill({ json: { categories: [] } });
      if (pathname === '/api/skills') {
        return route.fulfill({
          json: {
            skills: [skill],
            diagnostics: [
              { id: 'wrong-folder', scope: 'global', level: 'error', message: 'Skill name "other" must match directory identity "wrong-folder". Rename the folder to "other", or change name: to "wrong-folder" in SKILL.md.' },
              { id: 'plain-skill', scope: 'global', level: 'warning', message: 'No category is set in SKILL.md, so this skill is listed under "general". Add "category: <name>" to its frontmatter.' },
            ],
          },
        });
      }
      return route.fallback();
    });

    await page.goto('/#/skills');
    await expect(page.getByRole('heading', { name: 'Skill Library' })).toBeVisible();

    const notices = page.getByRole('status').filter({ hasText: 'Skill discovery notices' });
    await expect(notices).toContainText('wrong-folder (global) — not loaded: Skill name "other" must match');
    await expect(notices).toContainText('Rename the folder to "other"');
    // A warning is not "not loaded": the skill is there, it is only filed under "general".
    await expect(notices).toContainText('plain-skill (global): No category is set');
    await expect(notices).not.toContainText('plain-skill (global) — not loaded');
    await expect(notices).toContainText('ctxspace skill lint');
  });

  test('shows no notices on the Skills page when every skill loads', async ({ page }) => {
    await page.route('**/api/skills**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/skills/categories') return route.fulfill({ json: { categories: [] } });
      if (pathname === '/api/skills') return route.fulfill({ json: { skills: [skill], diagnostics: [] } });
      return route.fallback();
    });

    await page.goto('/#/skills');
    await expect(page.getByRole('heading', { name: 'Skill Library' })).toBeVisible();
    await expect(page.getByText('Showing', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Skill discovery notices')).toHaveCount(0);
  });
});

test.describe('Workspace resource diagnostics', () => {
  test.use({ workspacesData: [workspace] });
  test('shows invalid local packages and saves a single skill pick for the workspace', async ({ page }) => {
    let selected: string[] = [];
    await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [] } }));
    await page.route('**/api/skills**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/skills/categories') return route.fulfill({ json: { categories: [] } });
      if (pathname === '/api/skills') return route.fulfill({ json: { skills: [{ ...skill, scope: 'workspace' }], diagnostics: [{ id: 'wrong-name', scope: 'workspace', message: 'Skill id and name must match.' }] } });
      if (pathname === '/api/skills/workspace/example') return route.fulfill({ json: { config: { schemaVersion: 2, revision: 1, enabledSkills: selected, enabledAgents: [], enabledCategories: [] }, resolvedSkills: selected, installedSkills: selected } });
      if (pathname === '/api/skills/workspace/example/assign') {
        selected = route.request().postDataJSON().enabledSkills;
        return route.fulfill({ json: { success: true, config: { schemaVersion: 2, revision: 2, enabledSkills: selected, enabledAgents: [], enabledCategories: [] } } });
      }
      return route.fallback();
    });
    await page.route('**/api/workspace/example/refresh', (route) => route.fulfill({ json: { report: {} } }));
    await page.goto('/#/workspaces/example/skills');
    await expect(page.getByRole('heading', { name: 'Workspace Skills & Agents' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Skill id and name must match');
    // A skill written in this workspace is listed with the workspace's own, and is switched on one by one.
    await expect(page.getByText('This workspace only', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Portable Skill' }).check();
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => selected).toEqual(['portable-skill']);
    await expect(page.getByText('Saved and applied.', { exact: false })).toBeVisible();
    await page.screenshot({ path: '/tmp/contextspace-skills-diagnostics.png', fullPage: true });
  });
});
