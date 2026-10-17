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
  test.use({ workspacesData: [workspace] });

  test('keeps workspace edits in a draft until the complete selection is saved', async ({ page }) => {
    let assignmentBody: Record<string, unknown> | null = null;
    const selection = {
      schemaVersion: 1,
      revision: 3,
      enabledSkills: ['portable-skill'],
      enabledAgents: ['reviewer'],
      enabledCategories: ['general'],
    };

    await page.route('**/api/skills**', async (route, request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/skills/categories') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            categories: [{ id: 'general', name: 'General', description: 'General skills', custom: true }],
          }),
        });
        return;
      }
      if (pathname === '/api/skills/workspace/example/assign') {
        assignmentBody = request.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, config: { ...selection, revision: 4, enabledSkills: [] } }),
        });
        return;
      }
      if (pathname === '/api/skills/workspace/example') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ config: selection }),
        });
        return;
      }
      if (pathname === '/api/skills') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ skills: [skill] }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/skills');
    await expect(page.getByRole('heading', { name: 'Skill Library' })).toBeVisible();
    await page.getByLabel('Scope:').selectOption('example');

    const toggle = page.getByRole('button', { name: 'Enabled', exact: true });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Disabled', exact: true })).toBeVisible();
    expect(assignmentBody).toBeNull();

    await page.getByRole('button', { name: 'Save selection' }).click();
    await expect.poll(() => assignmentBody).toEqual({
      expectedRevision: 3,
      enabledSkills: [],
      enabledAgents: ['reviewer'],
      enabledCategories: ['general'],
    });
  });

  test('shows skills that did not load, and what to fix, on the global Skills page', async ({ page }) => {
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

  test('shows no notices on the global Skills page when every skill loads', async ({ page }) => {
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
  test('shows invalid local packages and saves explicit local skill selection', async ({ page }) => {
    let selected: string[] = [];
    await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [] } }));
    await page.route('**/api/skills**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/skills/categories') return route.fulfill({ json: { categories: [] } });
      if (pathname === '/api/skills') return route.fulfill({ json: { skills: [{ ...skill, scope: 'workspace' }], diagnostics: [{ id: 'wrong-name', scope: 'workspace', message: 'Skill id and name must match.' }] } });
      if (pathname === '/api/skills/workspace/example') return route.fulfill({ json: { config: { revision: 1, enabledSkills: selected, enabledAgents: [], enabledCategories: [] } } });
      if (pathname === '/api/skills/workspace/example/assign') {
        selected = route.request().postDataJSON().enabledSkills;
        return route.fulfill({ json: { success: true, config: { revision: 2, enabledSkills: selected, enabledAgents: [], enabledCategories: [] } } });
      }
      return route.fallback();
    });
    await page.route('**/api/workspace/example/refresh', (route) => route.fulfill({ json: { report: {} } }));
    await page.goto('/#/workspaces/example/skills');
    await expect(page.getByRole('heading', { name: 'Workspace Skills & Agents' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Skill id and name must match');
    await expect(page.getByText('Uncategorized Skills', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Portable Skill.*Use when testing resource selection/ }).click();
    await page.getByRole('button', { name: /Save.*Deploy/ }).click();
    await expect.poll(() => selected).toEqual(['portable-skill']);
    await expect(page.getByText('Skills & agents deployed successfully to workspace context!', { exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/contextspace-skills-diagnostics.png', fullPage: true });
  });
});
