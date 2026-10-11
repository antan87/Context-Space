import { test as base, expect, type Route } from '@playwright/test';
import { planView } from './planData';

export type MockDataOptions = {
  configData: any;
  adaptersData: any;
  workspacesData: any;
  workspacesStatusData: any;
  editorDetectData: any;
  workspaceLaunchTargetsData: any;
  updateStatusData: any;
  projectsData: any;
  reposData: { data: any[] };
  aiDetectData: any;
  workflowsTemplatesData: any;
  servicesData: any;
};

export const test = base.extend<MockDataOptions & { setupMocks: void }>({
  configData: [{
    exists: true,
    config: {
      version: '0.2.7',
      devDir: 'C:\\mock-dev',
      workspacesDir: 'C:\\mock-dev\\workspaces',
      defaultAssistant: 'ANTIGRAVITY',
      scanDepth: 2,
    },
  }, { option: true }],
  adaptersData: [{ adapters: [] }, { option: true }],
  workspacesData: [[], { option: true }],
  workspacesStatusData: [{}, { option: true }],
  editorDetectData: [[], { option: true }],
  workspaceLaunchTargetsData: [[
    {
      id: 'codex-desktop', name: 'Codex Desktop',
      description: 'Start a new Codex chat with this folder as its workspace.',
      kind: 'ai-app', icon: 'codex', available: true,
    },
    {
      id: 'claude-desktop', name: 'Claude Desktop',
      description: 'Open Claude Code with this folder selected.',
      kind: 'ai-app', icon: 'claude', available: false,
      unavailableReason: 'Claude Desktop is not installed.',
    },
    {
      id: 'cursor', name: 'Cursor',
      description: 'Open the generated workspace in Cursor.',
      kind: 'editor', icon: 'cursor', available: true,
    },
    {
      id: 'vscode', name: 'VS Code',
      description: 'Open the generated VS Code workspace.',
      kind: 'editor', icon: 'vscode', available: true,
    },
    {
      id: 'vscode-insiders', name: 'VS Code Insiders',
      description: 'Open the generated workspace in Insiders.',
      kind: 'editor', icon: 'vscode-insiders', available: false,
      unavailableReason: 'VS Code Insiders was not detected on PATH.',
    },
  ], { option: true }],
  updateStatusData: [{ currentVersion: '0.2.7', latestVersion: '0.2.7', updateAvailable: false }, { option: true }],
  projectsData: [{ data: [] }, { option: true }],
  reposData: [{ data: [] }, { option: true }],
  aiDetectData: [[], { option: true }],
  workflowsTemplatesData: [{ templates: [] }, { option: true }],
  servicesData: [{ services: [], orchestrationTools: [], runningState: [], runningOrchestrators: [] }, { option: true }],

  setupMocks: [async ({
    page,
    configData,
    adaptersData,
    workspacesData,
    workspacesStatusData,
    editorDetectData,
    workspaceLaunchTargetsData,
    updateStatusData,
    projectsData,
    reposData,
    aiDetectData,
    workflowsTemplatesData,
    servicesData,
  }, use) => {
    const json = (body: unknown) => async (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    // How the plan works opens by itself on a first visit; a spec about it clears this.
    await page.addInitScript(() => { try { window.localStorage.setItem('contextspace.plan.how-it-works-seen', '1'); } catch { /* no storage */ } });

    await page.route('**/api/config', json(configData));
    await page.route('**/api/adapters', json(adaptersData));
    await page.route('**/api/workspaces', json(workspacesData));
    await page.route('**/api/workspaces/status', json(workspacesStatusData));
    await page.route('**/api/session-sources', json({ sources: ['antigravity', 'claude', 'codex', 'copilot', 'pi', 'workspace'] }));
    await page.route('**/api/workspaces/status?*', async (route) => {
      const url = new URL(route.request().url());
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 24);
      const list = Array.isArray(workspacesData) ? workspacesData : [];
      const selected = list.slice(offset, offset + limit);
      const statuses = Object.fromEntries(selected.flatMap((workspace: { branchName: string }) =>
        workspacesStatusData[workspace.branchName]
          ? [[workspace.branchName, workspacesStatusData[workspace.branchName]]]
          : []));
      await route.fulfill({ json: {
        statuses,
        total: list.length,
        nextOffset: offset + selected.length < list.length ? offset + selected.length : null,
        snapshot: 'fixture',
      } });
    });
    await page.route('**/api/editor-detect', json(editorDetectData));
    await page.route('**/api/workspace-launch-targets', json(workspaceLaunchTargetsData));
    await page.route('**/api/update-status', json(updateStatusData));
    await page.route('**/api/projects', json(projectsData?.data ?? projectsData));
    await page.route('**/api/repos', json(reposData?.data ?? reposData));
    await page.route('**/api/ai-detect', json(aiDetectData));
    await page.route('**/api/workflows/templates', json(workflowsTemplatesData));
    await page.route('**/api/workspace/*/sessions?*', json({ sessions: [] }));

    // Service log routes — register the more specific /stream matcher first so
    // it wins over the backfill route.
    await page.route('**/api/workspace/*/services/logs/*/stream**', async (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: init\ndata: {"offset":0}\n\nevent: log\ndata: {"chunk":"hello from sse\\n"}\n\n',
      }),
    );
    await page.route('**/api/workspace/*/services/logs/*', json({ logs: 'backfill line\n', size: 14 }));
    await page.route('**/api/workspace/*/services', json(servicesData));
    await page.route('**/api/workspace/*/work', json({
      guidance: { version: 1, revision: 0, workType: 'feature', size: 'standard',
        assignment: { stage: 'investigate', objective: '', expectedOutput: '', stopCondition: '' }, documents: [] },
      lifecycle: null, assignment: '', sharedDocuments: [],
    }));
    await page.route('**/api/workspace/*/changes', json({ changes: [] }));
    // An empty plan for the Plan tab; a spec about the plan routes its own.
    await page.route('**/api/workspace/*/plan/items', json(planView([])));
    // The Where Are We strip above the chat: an empty plan and a live feed with nothing in it. A spec that
    // exercises the strip registers its own routes, which win over these.
    await page.route('**/api/workspace/*/progress-facts', async (route) => {
      const workspaceId = new URL(route.request().url()).pathname.split('/')[3] ?? '';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ facts: {
          workspaceId, generatedAt: '2026-10-02T12:00:00.000Z', milestones: [],
          counts: { total: 0, done: 0, inProgress: 0, reopened: 0, blocked: 0, upcoming: 0 },
          openQuestions: [], changes: { repos: [], files: 0, additions: 0, deletions: 0 },
          verification: { status: 'never', freshness: 'unknown' }, unavailable: [],
        } }),
      });
    });
    await page.route('**/api/workspace/*/screen-events**', async (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' }),
    );
    // Nothing is waiting by default; a spec that exercises alerts registers its own route.
    await page.route('**/api/attention?*', json({ requests: [] }));
    // No CLI is running anywhere by default. The sidebar reads this on every page, so it gets a token too;
    // a spec about terminals registers its own routes, which win over these.
    await page.route('**/api/terminals/bootstrap', json({ token: 'test-token', expiresAt: Date.now() + 300_000 }));
    await page.route('**/api/terminals/running', json({ sessions: [] }));

    // The chat sits beside Plan, Changes and the other parts when there is room. Specs about those parts are about
    // the parts, so they start with the chat hidden there; a spec about the layout sets its own.
    await page.addInitScript(() => {
      try {
        if (!localStorage.getItem('contextspace_chat_layout_v1')) localStorage.setItem('contextspace_chat_layout_v1', JSON.stringify({ hidden: true, percent: 62 }));
      } catch { /* Storage can be unavailable. */ }
    });

    await use();
  }, { auto: true }],
});

export { expect };
