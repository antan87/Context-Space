import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const workspace = {
  id: 'example',
  branchName: 'example',
  name: 'Example work',
  description: 'Skills test',
  repos: [],
  assistants: [],
  mode: 'in-place',
  workspacePath: '/ws/example',
  createdAt: '2026-08-16T00:00:00.000Z',
};

const library = (id: string, title: string, category: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, title, category, description: `Use when ${title.toLowerCase()}.`, content: `# ${title}`, custom: true, scope: 'global', ...extra,
});
const review = library('review', 'Review PRs', 'git');
const commit = library('commit', 'Commit helper', 'git');
const lint = library('lint', 'Lint fixer', 'quality');
const notes = library('notes', 'Workspace notes', 'general', { scope: 'workspace' });
const pdf = {
  id: 'pdf', name: 'pdf', title: 'pdf', category: 'documents', description: 'Read and fill PDFs.', content: '', custom: false,
  source: { harness: 'claude', label: 'Claude Code', root: '/home/me/.claude/skills' },
};
const imagegen = {
  id: 'imagegen', name: 'imagegen', title: 'imagegen', category: 'general', description: 'Make images.', content: '', custom: false,
  source: { harness: 'codex', label: 'Codex', root: '/home/me/.codex/skills' },
};

interface Config { schemaVersion?: number; revision: number; enabledSkills: string[]; disabledSkills?: string[]; enabledAgents: string[]; enabledCategories: string[] }

interface Seen { assigns: any[]; imports: any[]; refreshes: number }

/** The skills API for one workspace ("example"): what is saved, what that turns on, and what is installed. */
async function mockWorkspaceSkills(
  page: Page,
  { config, resolved = [], installed = [], importStatus = 200 }: { config: Config; resolved?: string[]; installed?: string[]; importStatus?: number },
): Promise<Seen> {
  const seen: Seen = { assigns: [], imports: [], refreshes: 0 };
  let current = config;
  await page.route('**/api/agents', (route) => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/workspace/example/refresh', (route) => {
    seen.refreshes += 1;
    return route.fulfill({ json: { report: {} } });
  });
  await page.route('**/api/skills**', async (route, request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/skills/categories') {
      return route.fulfill({ json: { categories: [
        { id: 'git', name: 'Git', description: 'Working with git', custom: true },
        { id: 'quality', name: 'Quality', description: '', custom: true },
      ] } });
    }
    if (url.pathname === '/api/skills/workspace/example/assign') {
      const body = request.postDataJSON();
      seen.assigns.push(body);
      current = { schemaVersion: 2, revision: body.expectedRevision + 1, enabledSkills: body.enabledSkills, disabledSkills: body.disabledSkills, enabledAgents: body.enabledAgents, enabledCategories: body.enabledCategories };
      return route.fulfill({ json: { success: true, config: current } });
    }
    if (url.pathname === '/api/skills/workspace/example') {
      return route.fulfill({ json: { config: current, resolvedSkills: resolved, installedSkills: installed } });
    }
    if (url.pathname === '/api/skills/import') {
      seen.imports.push(request.postDataJSON());
      return importStatus === 200
        ? route.fulfill({ json: { skill: { ...library('pdf', 'pdf', 'documents') } } })
        : route.fulfill({ status: importStatus, json: { error: 'My library already has a skill with that id.' } });
    }
    if (url.pathname === '/api/skills' && request.method() === 'GET') {
      return route.fulfill({ json: { skills: [review, commit, lint, notes, pdf, imagegen] } });
    }
    return route.fallback();
  });
  return seen;
}

const saved = (extra: Partial<Config> = {}): Config => ({ schemaVersion: 2, revision: 1, enabledSkills: [], disabledSkills: [], enabledAgents: [], enabledCategories: [], ...extra });

test.use({ workspacesData: [[workspace], { option: true }] });

test.describe('Skills of one workspace', () => {
  test('lists categories, single skills, this workspace only, and what the tools have built in, in that order', async ({ page }) => {
    await mockWorkspaceSkills(page, { config: saved() });
    await page.goto('/#/workspaces/example/skills');
    await expect(page.getByRole('heading', { name: 'Workspace Skills & Agents' })).toBeVisible();

    const headings = page.locator('section[aria-labelledby^="ws-skills-"] h3');
    await expect(headings).toHaveText(['Categories', 'Single skills', 'This workspace only', 'Built into your tools', 'Who sees what']);
    // "Global" is no longer a word for a skill.
    await expect(page.locator('section[aria-labelledby^="ws-skills-"]').filter({ hasText: /global/i })).toHaveCount(0);
  });

  test('turning a category on subscribes it, and only the categories that are on are saved', async ({ page }) => {
    const seen = await mockWorkspaceSkills(page, { config: saved() });
    await page.goto('/#/workspaces/example/skills');

    const git = page.getByRole('switch', { name: 'Turn on the Git category' });
    await expect(git).not.toBeChecked();
    await git.click();
    await expect(git).toBeChecked();
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
    await expect(page.getByText('All 2 in. Skills you add to it later arrive automatically.')).toBeVisible();
    // Skills in an on category come with it, so they are not offered one by one.
    await expect(page.getByRole('checkbox', { name: 'Select Review PRs' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Select Lint fixer' })).toBeVisible();
    expect(seen.assigns).toHaveLength(0);

    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => seen.assigns.length).toBe(1);
    expect(seen.assigns[0]).toEqual({
      expectedRevision: 1,
      enabledSkills: [],
      disabledSkills: [],
      enabledAgents: [],
      // Not "quality": it was never turned on.
      enabledCategories: ['git'],
    });
    await expect.poll(() => seen.refreshes).toBe(1);
    await expect(page.getByText('Saved and applied.', { exact: false })).toBeVisible();
  });

  test('switching a skill off inside an on category leaves it out, and switching it on again takes it back', async ({ page }) => {
    const seen = await mockWorkspaceSkills(page, {
      config: saved({ enabledCategories: ['git'] }),
      resolved: ['review', 'commit'],
      installed: ['review', 'commit'],
    });
    await page.goto('/#/workspaces/example/skills');

    await page.getByRole('button', { name: /^Git/ }).click();
    const commitSwitch = page.getByRole('switch', { name: 'Include Commit helper' });
    await expect(commitSwitch).toBeChecked();
    await commitSwitch.click();
    await expect(commitSwitch).not.toBeChecked();
    await expect(page.getByText('Left out', { exact: true })).toBeVisible();
    await expect(page.getByText('Save and apply will remove Commit helper.', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => seen.assigns.length).toBe(1);
    expect(seen.assigns[0]).toMatchObject({ enabledCategories: ['git'], disabledSkills: ['commit'], enabledSkills: [] });

    // Switching it on again removes the exception.
    await page.getByRole('switch', { name: 'Include Commit helper' }).click();
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => seen.assigns.length).toBe(2);
    expect(seen.assigns[1]).toMatchObject({ enabledCategories: ['git'], disabledSkills: [] });
  });

  test('picks a single skill on its own', async ({ page }) => {
    const seen = await mockWorkspaceSkills(page, { config: saved() });
    await page.goto('/#/workspaces/example/skills');

    await page.getByRole('checkbox', { name: 'Select Lint fixer' }).check();
    await expect(page.getByText('Save and apply will add Lint fixer.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => seen.assigns.length).toBe(1);
    expect(seen.assigns[0]).toMatchObject({ enabledSkills: ['lint'], enabledCategories: [], disabledSkills: [] });
  });

  test('does not switch on the categories an older version saved for every registered category', async ({ page }) => {
    await mockWorkspaceSkills(page, { config: { schemaVersion: 1, revision: 4, enabledSkills: ['lint'], enabledAgents: [], enabledCategories: ['git', 'quality'] } });
    await page.goto('/#/workspaces/example/skills');

    await expect(page.getByRole('switch', { name: 'Turn on the Git category' })).not.toBeChecked();
    await expect(page.getByRole('switch', { name: 'Turn on the Quality category' })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Select Lint fixer' })).toBeChecked();
    // Nothing was changed, so there is nothing unsaved.
    await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
  });

  test('keeps a workspace\'s own skills on when nothing was saved yet', async ({ page }) => {
    const seen = await mockWorkspaceSkills(page, {
      config: { schemaVersion: 1, revision: 0, enabledSkills: [], enabledAgents: [], enabledCategories: [] },
      resolved: ['notes'],
      installed: ['notes'],
    });
    await page.goto('/#/workspaces/example/skills');

    await expect(page.getByRole('checkbox', { name: 'Select Workspace notes' })).toBeChecked();
    await page.getByRole('switch', { name: 'Turn on the Git category' }).click();
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => seen.assigns.length).toBe(1);
    expect(seen.assigns[0]).toMatchObject({ expectedRevision: 0, enabledSkills: ['notes'], enabledCategories: ['git'] });
  });

  test('shows what each tool has built in as read-only, and adds one to My library', async ({ page }) => {
    const seen = await mockWorkspaceSkills(page, { config: saved() });
    await page.goto('/#/workspaces/example/skills');

    const builtIn = page.getByRole('region', { name: 'Built into your tools' });
    await expect(builtIn).toContainText('Built into Claude Code');
    await expect(builtIn).toContainText('Built into Codex');
    await expect(builtIn).toContainText('always on in Claude Code, in every folder');
    // Nothing built in can be turned on or off here.
    await expect(page.getByRole('checkbox', { name: /pdf/ })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: /pdf/ })).toHaveCount(0);

    await builtIn.getByText('Built into Claude Code').click();
    await builtIn.getByRole('button', { name: 'Add pdf to my library' }).click();
    await expect.poll(() => seen.imports).toEqual([{ harness: 'claude', id: 'pdf' }]);
    await expect(page.getByText('is in My library now', { exact: false })).toBeVisible();
  });

  test('says so when My library already has that skill', async ({ page }) => {
    await mockWorkspaceSkills(page, { config: saved(), importStatus: 409 });
    await page.goto('/#/workspaces/example/skills');

    const builtIn = page.getByRole('region', { name: 'Built into your tools' });
    await builtIn.getByText('Built into Claude Code').click();
    await builtIn.getByRole('button', { name: 'Add pdf to my library' }).click();
    await expect(page.getByText('My library already has a skill called "pdf".')).toBeVisible();
  });

  test('says who sees what: the installed skills, the two folders, and what each tool has built in', async ({ page }) => {
    await mockWorkspaceSkills(page, { config: saved({ enabledCategories: ['git'] }), resolved: ['review', 'commit'], installed: ['review'] });
    await page.goto('/#/workspaces/example/skills');

    const who = page.getByRole('region', { name: 'Who sees what' });
    await expect(who).toContainText('Every tool sees the 1 skill in this workspace.');
    await expect(who).toContainText('.claude/skills/');
    await expect(who).toContainText('.agents/skills/');
    // Saved but not applied: the screen says what will change.
    await expect(who).toContainText('Saved, but not applied yet. Save and apply will add Commit helper.');
    await expect(who).toContainText('Claude Code 1');
    await expect(who).toContainText('Codex 1');
  });
});
