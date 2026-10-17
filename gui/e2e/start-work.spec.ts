import { test, expect, type Page } from './fixtures';

async function mockCompletedCreationStream(page: Page) {
  await page.addInitScript(() => {
    class MockEventSource {
      url: string;
      listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
      onerror: ((e: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          const jobId = decodeURIComponent(url.split('/').pop() ?? 'created-workspace');
          const eventPayload = {
            status: 'completed',
            progress: 100,
            workspacePath: `C:\\mock-dev\\workspaces\\${jobId}`,
            feature: { id: jobId },
            steps: [
              { id: 'workspace', name: 'Create workspace', status: 'completed', message: 'Done' },
              { id: 'analysis', name: 'Analyze repositories', status: 'completed', message: 'Done' },
              { id: 'context', name: 'Generate AI context', status: 'completed', message: 'Done' },
            ],
          };
          const progressEvent = new MessageEvent('progress', { data: JSON.stringify(eventPayload) });
          this.listeners.progress?.forEach((cb) => cb(progressEvent));
        }, 50);
      }

      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(cb);
      }

      close() {}
    }

    (window as any).EventSource = MockEventSource;
  });
}

async function mockRunningCreationStream(page: Page) {
  await page.addInitScript(() => {
    class MockEventSource {
      url: string;
      listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
      onerror: ((e: Event) => void) | null = null;
      closed = false;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          if (this.closed) return;
          const eventPayload = {
            status: 'running',
            progress: 17,
            steps: [
              { id: 'workspace', name: 'Register Workspace', status: 'running', message: 'Registering workspace...' },
              { id: 'analysis', name: 'Analyze Repositories', status: 'pending', message: 'Waiting...' },
              { id: 'context', name: 'Generate AI Context Files', status: 'pending', message: 'Waiting...' },
            ],
          };
          const progressEvent = new MessageEvent('progress', { data: JSON.stringify(eventPayload) });
          this.listeners.progress?.forEach((cb) => cb(progressEvent));
        }, 500);
      }

      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(cb);
      }

      close() {
        this.closed = true;
      }
    }

    (window as any).EventSource = MockEventSource;
  });
}

async function mockFailedCreationReplay(page: Page) {
  await page.addInitScript(() => {
    class MockEventSource {
      url: string;
      listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
      onerror: ((e: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          const eventPayload = {
            status: 'failed',
            error: 'Workspace setup could not be resumed.',
            steps: [
              { id: 'workspace', name: 'Register Workspace', status: 'failed', message: 'Workspace setup could not be resumed.' },
            ],
          };
          const progressEvent = new MessageEvent('progress', { data: JSON.stringify(eventPayload) });
          this.listeners.progress?.forEach((cb) => cb(progressEvent));
        }, 0);
      }

      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(cb);
      }

      close() {}
    }

    (window as any).EventSource = MockEventSource;
  });
}

async function mockStaleCreationStream(page: Page) {
  await page.addInitScript(() => {
    class MockEventSource {
      url: string;
      listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
      onerror: ((e: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        const jobId = decodeURIComponent(url.split('/').pop() ?? 'unknown');
        const eventPayload = jobId === 'first-job'
          ? {
              status: 'completed',
              workspacePath: 'C:\\mock-dev\\workspaces\\first-job',
              feature: { id: 'first-job' },
              steps: [{ id: 'workspace', name: 'First job', status: 'completed', message: 'Done' }],
            }
          : {
              status: 'running',
              steps: [{ id: 'workspace', name: 'Second job', status: 'running', message: 'Still working' }],
            };
        setTimeout(() => {
          const progressEvent = new MessageEvent('progress', { data: JSON.stringify(eventPayload) });
          this.listeners.progress?.forEach((cb) => cb(progressEvent));
        }, jobId === 'first-job' ? 150 : 20);
      }

      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(cb);
      }

      close() {}
    }

    (window as any).EventSource = MockEventSource;
  });
}

async function mockFailedCreationStream(page: Page) {
  await page.addInitScript(() => {
    class MockEventSource {
      static CLOSED = 2;
      url: string;
      listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
      onerror: ((e: Event) => void) | null = null;
      readyState = MockEventSource.CLOSED;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => this.onerror?.(new Event('error')), 0);
      }

      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(cb);
      }

      close() {}
    }

    (window as any).EventSource = MockEventSource;
  });
}

/** Everything beyond the repositories and the task sits under More options, closed until opened. */
async function openMoreOptions(page: Page) {
  const toggle = page.getByRole('button', { name: /More options/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

test.describe('NexusFlow E2E GUI Tests', () => {
  test.use({
    configData: {
      exists: true,
      config: {
        version: '0.2.7',
        devDir: 'C:\\mock-dev',
        workspacesDir: 'C:\\mock-dev\\workspaces',
        defaultAssistant: 'ANTIGRAVITY',
        defaultEditor: 'code',
        scanDepth: 2,
      },
    },
    reposData: [
      { name: 'nexus-frontend', path: 'C:\\mock-dev\\nexus-frontend', defaultBranch: 'main' },
    ],
    aiDetectData: [{ name: 'claude', displayName: 'Claude CLI', detected: true }],
    workflowsTemplatesData: {
      templates: [
        {
          id: 'plan-implement-review',
          name: 'Plan Implement Review',
          description: 'Plan, implement, and review.',
          content: '# Plan Implement Review\n\nInstructions...',
          custom: false,
        },
      ],
    },
    workspacesData: [
      {
        id: 'demo-worktree',
        branchName: 'demo-worktree',
        description: 'Implement the demo flow',
        repos: ['C:\\mock-dev\\nexus-frontend'],
        assistants: ['claude'],
        workspacePath: 'C:\\mock-dev\\workspaces\\demo-worktree',
        createdAt: '2026-08-10T00:00:00.000Z',
      },
    ],
  });

  test('should create a workspace in worktree mode from the new workspace flow', async ({ page }) => {
    await mockCompletedCreationStream(page);
    const chatFrames: Array<Record<string, unknown>> = [];
    const legacyRequests: string[] = [];
    let launchBody: Record<string, unknown> | null = null;
    page.on('request', (request) => {
      if (/\/resume$|\/api\/open-editor$/.test(new URL(request.url()).pathname)) {
        legacyRequests.push(request.url());
      }
    });
    await page.route('**/api/adapters/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'claude-cli',
            name: 'Claude Code (Local CLI)',
            isConfigured: true,
            executionProfiles: [
              { id: 'review', label: 'Review only', description: 'Reads and plans; no source edits.' },
              { id: 'workspace-write', label: 'Edit workspace', description: 'Auto-accepts in-workspace file edits.' },
            ],
            defaultExecutionProfile: 'review',
            capabilities: {
              transport: 'cli-print',
              sessionIdentity: 'client-assigned',
              workspaceAccess: 'harness-managed',
              sessionIdFormat: 'uuid',
            },
          },
        ]),
      });
    });
    await page.routeWebSocket('**/ws', (socket) => {
      socket.onMessage((message) => {
        chatFrames.push(JSON.parse(String(message)));
      });
    });
    await page.route('**/api/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'demo',
            name: 'Demo',
            description: 'Demo project',
            repos: [{ path: 'C:\\mock-dev\\nexus-frontend', defaultBranch: 'main' }],
            createdAt: '2026-07-15T00:00:00.000Z',
            updatedAt: '2026-07-15T00:00:00.000Z',
          },
        ]),
      });
    });

    await page.route('**/api/workspace/demo-worktree/launch', async (route, request) => {
      launchBody = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, targetId: launchBody?.targetId }),
      });
    });

    let workspaceBody: any = null;
    await page.route('**/api/workspace', async (route, request) => {
      workspaceBody = request.postDataJSON();
      expect(workspaceBody.mode).toBe('worktree');
      expect(workspaceBody.flowType).toBeUndefined();
      expect(workspaceBody.name).toBe('Demo work');
      expect(workspaceBody.branchName).toBe('feature/demo-work');
      expect(workspaceBody.projectId).toBe('demo');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, jobId: 'demo-worktree' }),
      });
    });

    await page.goto('/#/new?project=demo');
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    await page.getByLabel('Workspace name').fill('Demo work');
    await openMoreOptions(page);
    await page.getByRole('radio', { name: /New worktrees/ }).click();
    await page.getByLabel('Feature branch').fill('feature/demo-work');
    await page.getByLabel('What do you want to do?').fill('Implement the demo flow');
    await page.getByRole('button', { name: 'Create workspace' }).click();

    await expect.poll(() => workspaceBody?.mode).toBe('worktree');
    // Creation lands straight on the new workspace: no intermediate "Workspace ready" step.
    await expect(page).toHaveURL(/#\/workspaces\/demo-worktree/);
    await expect(page.getByRole('heading', { name: 'Workspace ready' })).toHaveCount(0);
  });

  test('starts from repos, task, name, and skills without a size preset', async ({ page }) => {
    await mockRunningCreationStream(page);
    await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [{ id: 'work-lifecycle', name: 'Work lifecycle', title: 'Work lifecycle', description: 'Workspace guidance' }] } }));
    let previewRequest: any;
    await page.route('**/api/resources/preview', (route) => {
      previewRequest = route.request().postDataJSON();
      return route.fulfill({ json: { resources: [{ kind: 'skill', id: 'work-lifecycle', title: 'Work lifecycle', description: 'Workspace guidance', files: ['.agents/skills/work-lifecycle/SKILL.md'] }] } });
    });
    let payload: any;
    await page.route('**/api/workspace', async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({ json: { success: true, jobId: 'simple-start' } });
    });
    await page.goto('/#/new');
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    await openMoreOptions(page);
    await expect(page.getByRole('checkbox', { name: 'Select Work lifecycle' })).toBeVisible();
    await expect(page.getByText('Small task', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Standard change', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Epic', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/new-workspace.png', fullPage: true });
    await expect(page.getByRole('radio', { name: /New worktrees/ })).toBeVisible();
    await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
    await page.getByLabel('Workspace name').fill('Simple start');
    await page.getByLabel('What do you want to do?').fill('Simplify creation');
    await expect(page.getByText('No skills or agents selected', { exact: false })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Work lifecycle' }).check();
    // The file listing stays out of the way until asked for: a one-line summary sits by Create.
    const preview = page.getByRole('region', { name: 'What this adds to the workspace' });
    await expect(preview).toContainText('1 skill · 1 file');
    await expect(preview.getByText('.agents/skills/work-lifecycle/SKILL.md')).toBeHidden();
    // The region the toggle controls exists even while collapsed, so aria-controls never dangles.
    const toggle = preview.getByRole('button', { name: /What this adds to the workspace/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#' + (await toggle.getAttribute('aria-controls'))!)).toBeAttached();
    // Before anything is installed, the user can still see each file and where it goes.
    await preview.getByRole('button', { name: /What this adds to the workspace/ }).click();
    await expect(preview).toContainText('Work lifecycle');
    await expect(preview).toContainText('.agents/skills/work-lifecycle/SKILL.md');
    expect(previewRequest).toMatchObject({ skills: ['work-lifecycle'], agents: [] });
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect.poll(() => payload?.name).toBe('Simple start');
    expect(payload.mode).toBe('in-place');
    expect(payload.flowType).toBeUndefined();
    expect(payload.autoUpdateBase).toBe(false);
    expect(payload.enabledSkills).toEqual(['work-lifecycle']);
  });

  test('creates worktrees from an existing branch with a suggested workspace branch', async ({ page }) => {
    await mockRunningCreationStream(page);
    await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [] } }));
    let payload: any;
    await page.route('**/api/workspace', async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({ json: { success: true, jobId: 'review-api' } });
    });
    await page.goto('/#/new');
    await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
    await page.getByLabel('Workspace name').fill('Review API');
    await page.getByLabel('What do you want to do?').fill('Review an existing release branch');
    await openMoreOptions(page);
    await page.getByRole('radio', { name: /New worktrees/ }).click();
    await expect(page.getByRole('checkbox', { name: 'nexus-frontend' })).toBeChecked();
    await expect(page.getByRole('radio', { name: /New worktrees/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Loading skills...')).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'test-results/new-workspace-advanced.png', fullPage: true });
    await expect(page.getByLabel('Feature branch')).toHaveAttribute('placeholder', 'feature/review-api');
    await page.getByText('Create worktrees from existing branches').click();
    await page.getByPlaceholder('existing branch (must exist)').fill('release/2.0');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect.poll(() => payload?.branchName).toBe('feature/review-api');
    expect(payload.name).toBe('Review API');
    expect(payload.repos[0].existingBranch).toBe('release/2.0');
  });

  test('shows workspace names and clear sections in the left menu', async ({ page }) => {
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: [{
      id: 'feature/review-api', branchName: 'feature/review-api', name: 'Review API',
      description: 'Review an existing release branch', repos: ['C:\\mock-dev\\nexus-frontend'],
      assistants: [], workspacePath: 'C:\\mock-dev\\workspaces\\feature\\review-api', createdAt: '2026-08-10T00:00:00.000Z',
    }] }));
    await page.goto('/#/overview');
    await expect(page.getByRole('link', { name: /Review API/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'New workspace' })).toBeVisible();
    await expect(page.getByText('Reusable setup', { exact: true })).toBeVisible();
    await expect(page.getByText('Advanced tools', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Skills & agents' })).toBeVisible();
  });

  test('keeps the setup screen visible after a creation-page reload', async ({ page }) => {
    await mockRunningCreationStream(page);
    await page.route('**/api/workspace', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, jobId: 'running-workspace' }),
      });
    });

    await page.goto('/#/new');
    await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
    await page.getByLabel('Workspace name').fill('Running workspace');
    await page.getByLabel('What do you want to do?').fill('Keep setup progress visible');
    await page.getByRole('button', { name: 'Create workspace' }).click();

    await expect(page).toHaveURL(/#\/new\?job=running-workspace/);
    await expect(page.getByRole('heading', { name: 'Setting up your workspace…' })).toBeVisible();
    await expect(page.getByText('Register Workspace')).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/#\/new\?job=running-workspace/);
    await expect(page.getByRole('heading', { name: 'Setting up your workspace…' })).toBeVisible();
    await expect(page.getByText('Register Workspace')).toBeVisible();

    await page.getByRole('button', { name: 'Return to form' }).click();
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
  });

  test('renders a replayed failed creation job with its server error', async ({ page }) => {
    await mockFailedCreationReplay(page);

    await page.goto('/#/new?job=failed-workspace');

    await expect(page.getByRole('heading', { name: 'Workspace creation failed' })).toBeVisible();
    await expect(page.getByText('Workspace setup could not be resumed.').last()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to form (edit & retry)' })).toBeVisible();

    await page.getByRole('button', { name: 'Start over (clear form)' }).click();
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
  });

  test('renders a replayed completed creation job opened directly', async ({ page }) => {
    await mockCompletedCreationStream(page);

    await page.goto('/#/new?job=completed-workspace');

    await expect(page).toHaveURL(/#\/new\?job=completed-workspace/);
    await expect(page.getByRole('heading', { name: 'Workspace ready' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open workspace' })).toBeVisible();
  });

  test('ignores a late event from a replaced creation stream', async ({ page }) => {
    await mockStaleCreationStream(page);

    await page.goto('/#/new?job=first-job');
    await page.evaluate(() => {
      window.location.hash = '#/new?job=second-job';
    });

    await expect(page).toHaveURL(/#\/new\?job=second-job/);
    await expect(page.getByText('Second job')).toBeVisible();
    await page.waitForTimeout(200);
    await expect(page.getByRole('heading', { name: 'Setting up your workspace…' })).toBeVisible();
    await expect(page.getByText('Second job')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workspace ready' })).toBeHidden();
  });

  test('shows an honest recovery state when the creation stream closes', async ({ page }) => {
    await mockFailedCreationStream(page);
    await page.route('**/api/workspace', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, jobId: 'missing-workspace' }),
      });
    });

    await page.goto('/#/new');
    await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
    await page.getByLabel('Workspace name').fill('Missing workspace');
    await page.getByLabel('What do you want to do?').fill('Show a recovery state');
    await page.getByRole('button', { name: 'Create workspace' }).click();

    await expect(page.getByRole('heading', { name: 'Unable to reconnect to workspace setup' })).toBeVisible();
    await expect(page.getByText('Unable to reconnect to the creation stream. The workspace may still have been created.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try reconnecting' })).toBeVisible();

    await page.getByRole('button', { name: 'Back to form' }).click();
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
  });

  test('should create an in-place workspace without showing branch fields', async ({ page }) => {
    await mockCompletedCreationStream(page);

    let workspaceBody: any = null;
    await page.route('**/api/workspace', async (route, request) => {
      workspaceBody = request.postDataJSON();
      expect(workspaceBody.mode).toBe('in-place');
      expect(workspaceBody.name).toBe('Fix invoices');
      expect(workspaceBody.branchName).toBeUndefined();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, jobId: 'fix-invoices' }),
      });
    });

    await page.goto('/#/new');
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    await openMoreOptions(page);
    await expect(page.getByRole('radio', { name: /Reference checkouts/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Feature branch')).toBeHidden();
    await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
    await page.getByLabel('Workspace name').fill('Fix invoices');
    await page.getByLabel('What do you want to do?').fill('Fix invoice rounding issues');
    await page.getByRole('button', { name: 'Create workspace' }).click();

    await expect.poll(() => workspaceBody?.mode).toBe('in-place');
  });

  test('keeps Create workspace in reach however long the skills list is', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 520 });
    await page.route('**/api/skills', (route) => route.fulfill({
      json: { skills: Array.from({ length: 30 }, (_, i) => ({ id: `skill-${i}`, name: `skill-${i}`, title: `Skill ${i}`, description: 'Guidance' })) },
    }));
    await page.goto('/#/new');
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    await openMoreOptions(page);
    await expect(page.getByRole('checkbox', { name: 'Select Skill 29' })).toBeAttached();
    await expect(page.getByRole('button', { name: 'Create workspace' })).toBeInViewport();
  });

  test('creates a workspace from just a name: the keyboard starts on the repositories, Enter submits, the description is optional with a name', async ({ page }) => {
    await mockCompletedCreationStream(page);
    let payload: any = null;
    await page.route('**/api/workspace', async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({ json: { success: true, jobId: 'quick-start' } });
    });

    await page.goto('/#/new');
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();

    const name = page.getByLabel('Workspace name');
    const description = page.getByLabel('What do you want to do?');
    // The keyboard starts on the first thing to do: choosing repositories.
    await expect(page.getByLabel('Filter repositories')).toBeFocused();
    // The task is asked for first; the name that follows is optional.
    const nameBox = await name.boundingBox();
    const descriptionBox = await description.boundingBox();
    expect(descriptionBox!.y).toBeLessThan(nameBox!.y);
    await expect(page.locator('label', { has: name }).getByText('optional', { exact: true })).toBeVisible();

    // Without a repository the form is not valid, so Enter must not create anything.
    await name.fill('Quick start');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
    expect(payload).toBeNull();
    // It says what is missing instead of doing nothing, and stops saying it once a repository is chosen.
    const needsRepo = page.getByRole('alert').filter({ hasText: 'Choose a repository first' });
    await expect(needsRepo).toBeVisible();

    await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
    await expect(needsRepo).toHaveCount(0);
    await name.focus();
    await page.keyboard.press('Enter');

    await expect.poll(() => payload?.name).toBe('Quick start');
    expect(payload.description).toBe('');
    // Straight to the workspace: no "Workspace ready" step to click through.
    await expect(page).toHaveURL(/#\/workspaces\/quick-start/);
    await expect(page.getByRole('heading', { name: 'Workspace ready' })).toHaveCount(0);
  });

  test.describe('choosing the harness to start with', () => {
    // The explicit `[value, { option: true }]` form: Playwright reads a bare array here as that tuple and keeps
    // only its first element, so a plain list of tools would reach the app as a single object.
    test.use({
      aiDetectData: [[
        { name: 'claude', displayName: 'Claude Code', detected: true, command: 'claude' },
        { name: 'codex', displayName: 'OpenAI Codex', detected: true, command: 'codex' },
        { name: 'copilot', displayName: 'GitHub Copilot', detected: false },
        { name: 'pi', displayName: 'Pi', detected: true, command: 'pi' },
      ], { option: true }],
    });

    const pickerOf = (page: Page) => page.getByRole('radiogroup', { name: 'Start with' });

    test('shows each tool with its logo and installed state, and only lets installed ones be chosen', async ({ page }) => {
      await page.goto('/#/new');
      await openMoreOptions(page);
      const picker = pickerOf(page);
      await expect(picker.getByRole('radio')).toHaveCount(4);
      for (const name of ['Claude Code', 'Codex', 'Pi']) {
        const card = picker.getByRole('radio', { name, exact: true });
        await expect(card).toBeEnabled();
        await expect(card).toContainText('Installed');
        await expect(card.locator('svg').first()).toBeVisible();
      }
      const copilot = picker.getByRole('radio', { name: 'GitHub Copilot', exact: true });
      await expect(copilot).toBeDisabled();
      await expect(copilot).toContainText('Not installed');
      // Nothing is chosen for you the first time.
      await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
    });

    test('creating with a chosen tool includes it in the instructions and makes it the preferred tool on the start screen', async ({ page }) => {
      await mockCompletedCreationStream(page);
      let payload: any = null;
      await page.route('**/api/workspace', async (route) => {
        payload = route.request().postDataJSON();
        await route.fulfill({ json: { success: true, jobId: 'harness-start' } });
      });
      await page.goto('/#/new');
      await openMoreOptions(page);
      await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
      await page.getByLabel('Workspace name').fill('Harness start');
      const codex = pickerOf(page).getByRole('radio', { name: 'Codex', exact: true });
      await codex.click();
      await expect(codex).toBeChecked();
      await page.getByRole('button', { name: 'Create workspace' }).click();

      // The chosen tool receives the workspace instructions without being ticked under More options.
      await expect.poll(() => payload?.assistants).toEqual(['codex']);
      await expect(page).toHaveURL(/#\/workspaces\/harness-start/);
      await expect.poll(() => page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('contextspace_floating_chat_state_v1') ?? '{}');
        return saved.harnesses?.['harness-start'];
      })).toBe('codex');
    });

    test('moves with the arrow keys, skipping tools that are not installed', async ({ page }) => {
      await page.goto('/#/new');
      await openMoreOptions(page);
      const picker = pickerOf(page);
      await picker.getByRole('radio', { name: 'Claude Code', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(picker.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
      await page.keyboard.press('ArrowRight');
      await expect(picker.getByRole('radio', { name: 'Pi', exact: true })).toBeChecked();
      await expect(picker.getByRole('radio', { name: 'Pi', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(picker.getByRole('radio', { name: 'Claude Code', exact: true })).toBeChecked();
      await page.keyboard.press('ArrowLeft');
      await expect(picker.getByRole('radio', { name: 'Pi', exact: true })).toBeChecked();
    });

    test('"Choose later" clears the pick, and nothing is sent for it', async ({ page }) => {
      let payload: any = null;
      await page.route('**/api/workspace', async (route) => {
        payload = route.request().postDataJSON();
        await route.fulfill({ json: { success: true, jobId: 'no-harness' } });
      });
      await page.goto('/#/new');
      await openMoreOptions(page);
      const picker = pickerOf(page);
      await picker.getByRole('radio', { name: 'Claude Code', exact: true }).click();
      await expect(picker.getByRole('radio', { name: 'Claude Code', exact: true })).toBeChecked();

      await page.getByRole('button', { name: 'Choose later' }).click();
      await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Choose later' })).toHaveCount(0);

      await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
      await page.getByLabel('Workspace name').fill('No harness');
      await page.getByRole('button', { name: 'Create workspace' }).click();
      await expect.poll(() => payload?.name).toBe('No harness');
      expect(payload.assistants).toEqual([]);
    });

    test('never preselects a tool: not the first one, not the one used for the last workspace', async ({ page }) => {
      await mockCompletedCreationStream(page);
      // Builds that remembered the last pick left this behind; it must not choose anything now.
      await page.addInitScript(() => localStorage.setItem('contextspace_start_harness_v1', 'codex'));
      await page.route('**/api/workspace', async (route) => {
        await route.fulfill({ json: { success: true, jobId: 'first-with-codex' } });
      });
      await page.goto('/#/new');
      await openMoreOptions(page);
      const picker = pickerOf(page);
      await expect(picker.getByRole('radio')).toHaveCount(4);
      await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Choose later' })).toHaveCount(0);

      await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
      await page.getByLabel('Workspace name').fill('First with Codex');
      await picker.getByRole('radio', { name: 'Codex', exact: true }).click();
      await page.getByRole('button', { name: 'Create workspace' }).click();
      await expect(page).toHaveURL(/#\/workspaces\/first-with-codex/);
      // Leave through a page that has really rendered, so the finished form is gone before the next one starts.
      await page.goto('/#/overview');
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
      // Starting the next workspace begins with nothing chosen again, in the same window and after a reload.
      await page.goto('/#/new');
      await openMoreOptions(page);
      await expect(picker.getByRole('radio')).toHaveCount(4);
      await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
      await page.reload();
      await openMoreOptions(page);
      await expect(picker.getByRole('radio')).toHaveCount(4);
      await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
    });

    test('keeps keyboard focus in the picker when "Choose later" clears the pick', async ({ page }) => {
      await page.goto('/#/new');
      await openMoreOptions(page);
      const picker = pickerOf(page);
      await picker.getByRole('radio', { name: 'Codex', exact: true }).click();
      const later = page.getByRole('button', { name: 'Choose later' });
      await later.focus();
      await page.keyboard.press('Enter');
      // The button goes away with the pick; focus must not fall back to the top of the page. It stays on the
      // card that was just cleared, so the arrow keys carry on from where the choice was.
      await expect(later).toHaveCount(0);
      await expect(picker.getByRole('radio', { name: 'Codex', exact: true })).toBeFocused();
      await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
    });

    test('leaves no preferred tool behind for a workspace that was not created', async ({ page }) => {
      await mockFailedCreationStream(page);
      await page.route('**/api/workspace', async (route) => {
        await route.fulfill({ json: { success: true, jobId: 'never-created' } });
      });
      await page.goto('/#/new');
      await openMoreOptions(page);
      await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
      await page.getByLabel('Workspace name').fill('Never created');
      await pickerOf(page).getByRole('radio', { name: 'Codex', exact: true }).click();
      await page.getByRole('button', { name: 'Create workspace' }).click();

      await expect(page.getByRole('heading', { name: 'Unable to reconnect to workspace setup' })).toBeVisible();
      const preferred = await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('contextspace_floating_chat_state_v1') ?? '{}');
        return saved.harnesses?.['never-created'] ?? null;
      });
      expect(preferred).toBeNull();
    });

    test('lists the chosen tool under More options as always included', async ({ page }) => {
      await page.goto('/#/new');
      await openMoreOptions(page);
      await pickerOf(page).getByRole('radio', { name: 'Claude Code', exact: true }).click();
      const instructions = page.getByRole('region', { name: 'AI harnesses' });
      await expect(instructions.getByText('The tool you start with is always included.')).toBeVisible();
      const chosen = instructions.getByRole('checkbox', { name: /Claude Code/ });
      await expect(chosen).toBeChecked();
      await expect(chosen).toBeDisabled();
      await expect(instructions.getByRole('checkbox', { name: /OpenAI Codex/ })).toBeEnabled();
    });
  });

  test('suggests a strategy from the workspace name when there is no description', async ({ page }) => {
    let suggestBody: any = null;
    await page.route('**/api/workspace/suggest-workflow', async (route) => {
      suggestBody = route.request().postDataJSON();
      await route.fulfill({ json: { success: true, difficulty: 'simple', suggestedWorkflowId: 'plan-implement-review', customInstructions: '# Plan' } });
    });
    await page.goto('/#/new');
    await openMoreOptions(page);
    const suggest = page.getByRole('button', { name: 'Suggest with AI' });

    // With neither a name nor a task there is nothing to go on, and the message says how to fix it.
    await suggest.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Name the workspace or describe the task first' })).toBeVisible();
    expect(suggestBody).toBeNull();

    // The name is enough, and a description still wins when there is one.
    await page.getByLabel('Workspace name').fill('Fix invoice rounding');
    await suggest.click();
    await expect.poll(() => suggestBody?.description).toBe('Fix invoice rounding');
    await page.getByLabel('What do you want to do?').fill('Round every invoice line to two decimals');
    await suggest.click();
    await expect.poll(() => suggestBody?.description).toBe('Round every invoice line to two decimals');
  });

  test('shows which repository is selected: in the list, as a chip, and in the pinned bar', async ({ page }) => {
    await page.goto('/#/new');
    const footer = page.getByTestId('create-footer');
    await expect(footer).toContainText('No repository selected');

    await page.getByRole('checkbox', { name: 'nexus-frontend' }).click();
    const chips = page.getByRole('list', { name: 'Selected repositories' });
    await expect(chips).toContainText('nexus-frontend');
    await expect(footer).toContainText('1 repository');
    await expect(footer).toContainText('nexus-frontend');

    // A chip removes its repository without finding it in the list again.
    await chips.getByRole('button', { name: 'Remove nexus-frontend' }).click();
    await expect(page.getByRole('checkbox', { name: 'nexus-frontend' })).not.toBeChecked();
    await expect(chips).toHaveCount(0);
    await expect(footer).toContainText('No repository selected');
  });

  test('the pinned Create bar is solid, so content scrolling under it never shows through', async ({ page }) => {
    await page.goto('/#/new');
    await expect(page.getByTestId('create-footer')).toBeVisible();
    // Paint the bar's background onto a canvas: this reads its real opacity, whatever colour syntax the theme uses.
    const alpha = await page.getByTestId('create-footer').evaluate((element) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    });
    expect(alpha).toBe(255);
  });

  test.describe('with several repositories', () => {
    // The explicit `[value, { option: true }]` form again: a bare list would be read as that tuple.
    test.use({
      reposData: [[
        { name: 'shop-api', path: 'C:\\mock-dev\\shop-api', defaultBranch: 'main' },
        { name: 'shop-web', path: 'C:\\mock-dev\\shop-web', defaultBranch: 'main' },
        { name: 'docs-site', path: 'C:\\mock-dev\\docs-site', defaultBranch: 'main' },
        { name: 'billing-service-with-a-long-name', path: 'C:\\mock-dev\\billing-service-with-a-long-name', defaultBranch: 'main' },
      ], { option: true }],
    });

    test('names the first few in the pinned bar and counts the rest, with every name one hover away', async ({ page }) => {
      await page.goto('/#/new');
      for (const name of ['shop-api', 'shop-web', 'billing-service-with-a-long-name']) {
        await page.getByRole('checkbox', { name }).click();
      }
      const footer = page.getByTestId('create-footer');
      await expect(footer).toContainText('3 repositories');
      await expect(footer).toContainText('shop-api, shop-web +1');
      await expect(footer.locator('p')).toHaveAttribute('title', 'shop-api, shop-web, billing-service-with-a-long-name');
      await expect(page.getByRole('list', { name: 'Selected repositories' }).getByRole('listitem')).toHaveCount(3);
      // The one left out stays unticked and is not listed.
      await expect(page.getByRole('checkbox', { name: 'docs-site' })).not.toBeChecked();
    });
  });

  // <main> pads its content by a different amount at each breakpoint and a sticky bar respects that padding, so a bar
  // that is not offset by the same amount leaves a strip of the page showing under it.
  for (const width of [390, 760, 1280]) {
    test(`the pinned Create bar sits flush with the bottom of a ${width}px window and spans the page`, async ({ page }) => {
      await page.setViewportSize({ width, height: 520 });
      await page.route('**/api/skills', (route) => route.fulfill({
        json: { skills: Array.from({ length: 30 }, (_, i) => ({ id: `skill-${i}`, name: `skill-${i}`, title: `Skill ${i}`, description: 'Guidance' })) },
      }));
      await page.goto('/#/new');
      await openMoreOptions(page);
      await expect(page.getByRole('checkbox', { name: 'Select Skill 29' })).toBeAttached();
      const bar = (await page.getByTestId('create-footer').boundingBox())!;
      expect(Math.round(bar.y + bar.height)).toBe(520);
      // It runs the width of the page, not just the form column (36rem), and nothing sticks out sideways.
      expect(bar.width).toBeGreaterThan(Math.min(width - 40, 600));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // The button sits in the middle of the bar: as much room above it as below, not pushed up by padding.
      const button = (await page.getByRole('button', { name: 'Create workspace' }).boundingBox())!;
      const above = button.y - bar.y;
      const below = bar.y + bar.height - (button.y + button.height);
      expect(Math.abs(above - below)).toBeLessThanOrEqual(2);
    });
  }

  test('should save settings changes', async ({ page }) => {
    let savedConfig: any = null;

    await page.route('**/api/config', async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            exists: true,
            config: {
              version: '0.2.7',
              devDir: 'C:\\mock-dev',
              workspacesDir: 'C:\\mock-dev\\workspaces',
              defaultAssistant: 'ANTIGRAVITY',
              scanDepth: 2,
            },
          }),
        });
      } else if (request.method() === 'POST') {
        savedConfig = request.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, config: savedConfig }),
        });
      }
    });

    await page.route('**/api/updates/tools', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });

    await page.goto('/');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();

    await expect(page.locator('h1')).toContainText('Global Settings');

    const devDirInput = page.locator('label:has-text("Development Directory") + input, input[value="C:\\\\mock-dev"]').first();
    await devDirInput.fill('C:\\mock-code');

    const saveButton = page.locator('button:has-text("Save Configuration")');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect.poll(() => savedConfig?.devDir).toBe('C:\\mock-code');
  });

  test('shows base repository freshness, allows pull, and includes autoUpdateBase on creation', async ({ page }) => {
    let workspaceCreationPayload: any = null;
    let pullCalled = false;

    await page.route('**/api/repos', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { name: 'api-service', path: '/mock-dev/api-service', defaultBranch: 'main' },
        ]),
      });
    });

    await page.route('**/api/repos/freshness', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            repoPath: '/mock-dev/api-service',
            repoName: 'api-service',
            branch: 'main',
            defaultBranch: 'main',
            trackingBranch: 'origin/main',
            remoteName: 'origin',
            hasRemote: true,
            isClean: true,
            ahead: 0,
            behind: 3,
            status: 'behind',
            message: '3 commits behind origin/main',
          },
        ]),
      });
    });

    await page.route('**/api/repos/pull', async (route) => {
      pullCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          results: [
            {
              repoPath: '/mock-dev/api-service',
              repoName: 'api-service',
              branch: 'main',
              status: 'fast-forwarded',
              message: 'Fast-forwarded "main" to origin/main (3 commits)',
              ahead: 0,
              behind: 0,
            },
          ],
        }),
      });
    });

    await page.route('**/api/workspace', async (route, request) => {
      if (request.method() === 'POST') {
        workspaceCreationPayload = request.postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, jobId: 'freshness-test-ws' }),
        });
      }
    });

    await page.goto('/#/new');

    // Select api-service repo
    const repoCheckbox = page.getByRole('checkbox', { name: /api-service/i });
    await expect(repoCheckbox).toBeVisible();
    await repoCheckbox.click();

    await openMoreOptions(page);
    // Verify Base repository sync section appears
    await expect(page.locator('text=Base repository sync')).toBeVisible();
    await expect(page.locator('text=↓ 3 behind origin/main').first()).toBeVisible();

    // Click "Pull" button for the stale repo
    const pullBtn = page.locator('button:has-text("Pull 3 stale")').or(page.locator('li:has-text("api-service") button:has-text("Pull")'));
    await expect(pullBtn.first()).toBeVisible();
    await pullBtn.first().click();

    await expect.poll(() => pullCalled).toBe(true);

    // Updating the selected checkout is opt-in, even when a remote is ahead.
    const autoUpdateCb = page.getByRole('checkbox', { name: /Fast-forward/i });
    await expect(autoUpdateCb).toBeVisible();
    await expect(autoUpdateCb).not.toHaveAttribute('data-checked', '');
    await autoUpdateCb.click();
    await expect(autoUpdateCb).toHaveAttribute('data-checked', '');

    // Fill workspace name and description
    await page.getByLabel('Workspace name').fill('Freshness Workspace');
    await page.getByLabel('What do you want to do?').fill('Test base freshness feature');

    // Submit workspace creation
    const submitBtn = page.getByRole('button', { name: 'Create workspace', exact: true });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    await expect.poll(() => workspaceCreationPayload).not.toBeNull();
    expect(workspaceCreationPayload.autoUpdateBase).toBe(true);
    expect(workspaceCreationPayload.name).toBe('Freshness Workspace');
  });
  test.describe('one step: repositories and a task, everything else under More options', () => {
    test.use({
      reposData: [[
        { name: 'api', path: 'C:\\mock-dev\\api', defaultBranch: 'main' },
        { name: 'web', path: 'C:\\mock-dev\\web', defaultBranch: 'main' },
        { name: 'docs', path: 'C:\\mock-dev\\docs', defaultBranch: 'main' },
      ], { option: true }],
      aiDetectData: [[
        { name: 'claude', displayName: 'Claude Code', detected: true, command: 'claude' },
        { name: 'codex', displayName: 'OpenAI Codex', detected: true, command: 'codex' },
        { name: 'copilot', displayName: 'GitHub Copilot', detected: false },
      ], { option: true }],
    });

    const listSkills = (page: Page) => page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [
      { id: 'work-lifecycle', name: 'Work lifecycle', title: 'Work lifecycle', description: 'Workspace guidance' },
      { id: 'code-review', name: 'Code review', title: 'Code review', description: 'Review changes before they merge' },
    ] } }));

    test('only repositories and a description send the default payload; More options is closed until opened', async ({ page }) => {
      await mockCompletedCreationStream(page);
      await listSkills(page);
      let payload: any = null;
      await page.route('**/api/workspace', async (route) => {
        payload = route.request().postDataJSON();
        await route.fulfill({ json: { success: true, jobId: 'cache-invoice-lookups' } });
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('/#/new');
      await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();

      // The main area is the repositories, the task, an optional name and Create: nothing else to read.
      const more = page.getByRole('button', { name: /More options/ });
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByLabel('Workspace name')).toBeVisible();
      for (const hidden of [
        page.getByRole('radiogroup', { name: 'Start with' }),
        page.getByRole('radiogroup', { name: 'Work mode' }),
        page.getByLabel('Work type'),
        page.getByRole('checkbox', { name: /Fast-forward/ }),
        page.getByRole('checkbox', { name: 'Select Work lifecycle' }),
        page.getByRole('region', { name: 'AI harnesses' }),
        page.getByRole('combobox', { name: 'Teamwork strategy' }),
      ]) await expect(hidden).toBeHidden();
      // The closed button says nothing was changed, and its panel exists for aria-controls to point at.
      await expect(more).toContainText('The defaults are fine');
      await expect(page.locator('#' + (await more.getAttribute('aria-controls'))!)).toBeAttached();

      await page.getByRole('checkbox', { name: 'api' }).click();
      await page.getByLabel('What do you want to do?').fill('Cache invoice lookups. Then measure the totals.');
      // Left empty, the name is the first line of the task, and the page says so before Create.
      await expect(page.getByText('Leave empty to call it Cache invoice lookups', { exact: false })).toBeVisible();
      await expect(page.getByLabel('Workspace name')).toHaveAccessibleDescription(/Leave empty to call it Cache invoice lookups/);

      if (process.env.PLAN_SHOTS_DIR) {
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${process.env.PLAN_SHOTS_DIR}/new-workspace.png` });
      }

      await page.getByRole('button', { name: 'Create workspace' }).click();
      await expect.poll(() => payload).not.toBeNull();
      // Exactly what today's defaults send: no branch, no skills, agents, tags or instructions, no tool chosen.
      expect(payload).toEqual({
        workType: 'feature',
        mode: 'in-place',
        name: 'Cache invoice lookups',
        description: 'Cache invoice lookups. Then measure the totals.',
        repos: [{ name: 'api', path: 'C:\\mock-dev\\api', defaultBranch: 'main' }],
        assistants: [],
        autoUpdateBase: false,
      });
      await expect(page).toHaveURL(/#\/workspaces\/cache-invoice-lookups/);
    });

    test('More options opens and closes on click, and a Space or Enter press', async ({ page }) => {
      await listSkills(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('/#/new');
      const more = page.getByRole('button', { name: /More options/ });
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('radiogroup', { name: 'Start with' })).toBeVisible();
      await expect(page.getByRole('radio', { name: /Reference checkouts/ })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByLabel('Work type')).toHaveValue('feature');
      await expect(page.getByRole('checkbox', { name: /Fast-forward/ })).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Select Work lifecycle' })).not.toBeChecked();
      await expect(page.getByRole('combobox', { name: 'Teamwork strategy' })).toContainText('None');

      if (process.env.PLAN_SHOTS_DIR) {
        await page.getByRole('checkbox', { name: 'api' }).click();
        await page.getByLabel('What do you want to do?').fill('Cache invoice lookups');
        await more.evaluate((button) => button.scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${process.env.PLAN_SHOTS_DIR}/new-workspace-more.png` });
        await more.evaluate((button) => button.closest('main')?.scrollTo(0, 0));
      }

      await more.focus();
      await page.keyboard.press('Enter');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('radiogroup', { name: 'Start with' })).toBeHidden();
      await page.keyboard.press('Space');
      await expect(more).toHaveAttribute('aria-expanded', 'true');
    });

    test('the closed button lists what was changed inside, so nothing set there is out of sight', async ({ page }) => {
      await listSkills(page);
      await page.goto('/#/new');
      const more = page.getByRole('button', { name: /More options/ });
      await more.click();
      await page.getByRole('radio', { name: /New worktrees/ }).click();
      await page.getByLabel('Work type').selectOption('bug');
      await page.getByRole('checkbox', { name: 'Select Code review' }).check();
      await page.getByRole('radiogroup', { name: 'Start with' }).getByRole('radio', { name: 'Codex', exact: true }).click();
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(more).toContainText('Changed: New worktrees, Bug fix, Starts with Codex, 1 skill');
      // Reopening shows the same choices: closing never throws them away.
      await more.click();
      await expect(page.getByRole('checkbox', { name: 'Select Code review' })).toBeChecked();
      await expect(page.getByLabel('Work type')).toHaveValue('bug');
    });

    test('with no name typed, new worktrees get a name and a branch from the task', async ({ page }) => {
      await mockCompletedCreationStream(page);
      await listSkills(page);
      let payload: any = null;
      await page.route('**/api/workspace', async (route) => {
        payload = route.request().postDataJSON();
        await route.fulfill({ json: { success: true, jobId: 'feature/fix-invoice-rounding' } });
      });
      await page.goto('/#/new');
      await openMoreOptions(page);
      await page.getByRole('radio', { name: /New worktrees/ }).click();
      await expect(page.getByLabel('Feature branch')).toHaveAttribute('placeholder', 'feature/my-work');
      await page.getByRole('checkbox', { name: 'web' }).click();
      await page.getByLabel('What do you want to do?').fill('Fix invoice rounding');
      await expect(page.getByLabel('Feature branch')).toHaveAttribute('placeholder', 'feature/fix-invoice-rounding');
      await page.getByRole('button', { name: 'Create workspace' }).click();
      await expect.poll(() => payload).not.toBeNull();
      expect(payload).toMatchObject({ mode: 'worktree', name: 'Fix invoice rounding', branchName: 'feature/fix-invoice-rounding', description: 'Fix invoice rounding' });
    });

    test('Create stays off until there is a repository and a task or a name, and says what is missing on Enter', async ({ page }) => {
      let payload: any = null;
      await page.route('**/api/workspace', async (route) => {
        payload = route.request().postDataJSON();
        await route.fulfill({ json: { success: true, jobId: 'x' } });
      });
      await page.goto('/#/new');
      const create = page.getByRole('button', { name: 'Create workspace' });
      await expect(create).toBeDisabled();
      await page.getByRole('checkbox', { name: 'api' }).click();
      await expect(create).toBeDisabled();
      // Enter in the name field with nothing to name the workspace from says so, and creates nothing.
      await page.getByLabel('Workspace name').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert').filter({ hasText: 'Say what you want to do, or give the workspace a name' })).toBeVisible();
      expect(payload).toBeNull();
      await page.getByLabel('What do you want to do?').fill('Anything');
      await expect(create).toBeEnabled();
      await expect(page.getByRole('alert').filter({ hasText: 'Say what you want to do' })).toHaveCount(0);
    });

    test('a branch that cannot be built from the name opens More options and focuses the branch field', async ({ page }) => {
      await mockCompletedCreationStream(page);
      let payload: any = null;
      await page.route('**/api/workspace', async (route) => {
        payload = route.request().postDataJSON();
        await route.fulfill({ json: { success: true, jobId: 'feature/own-branch' } });
      });
      await page.goto('/#/new');
      const more = page.getByRole('button', { name: /More options/ });
      await more.click();
      await page.getByRole('radio', { name: /New worktrees/ }).click();
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'false');

      await page.getByRole('checkbox', { name: 'api' }).click();
      await page.getByLabel('Workspace name').fill('###');
      const create = page.getByRole('button', { name: 'Create workspace' });
      await expect(create).toBeEnabled();
      await create.click();

      // The field that needs attention is under More options: it opens, takes focus and explains itself.
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      const branch = page.getByLabel('Feature branch');
      await expect(branch).toBeFocused();
      await expect(branch).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('alert').filter({ hasText: 'need a branch name' })).toBeVisible();
      expect(payload).toBeNull();

      await page.keyboard.type('feature/own-branch');
      await expect(page.getByRole('alert').filter({ hasText: 'need a branch name' })).toHaveCount(0);
      await create.click();
      await expect.poll(() => payload?.branchName).toBe('feature/own-branch');
      expect(payload.name).toBe('###');
    });

    test('with repositories already chosen by the link, the keyboard starts on the task', async ({ page }) => {
      await page.goto('/#/new?repo=' + encodeURIComponent('C:\\mock-dev\\api'));
      await expect(page.getByRole('checkbox', { name: 'api' })).toBeChecked();
      await expect(page.getByLabel('What do you want to do?')).toBeFocused();
    });
  });
});
