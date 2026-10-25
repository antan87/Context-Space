import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

const workspace = {
  id: 'feature-one',
  branchName: 'feature-one',
  description: 'Build collaboration',
  repos: ['C:\\mock-dev\\repo-one'],
  assistants: ['codex'],
  workspacePath: 'C:\\mock-dev\\workspaces\\feature-one',
  createdAt: '2026-08-27T10:00:00.000Z',
};

function hostStatus() {
  const now = '2026-08-27T10:00:00.000Z';
  return {
    mode: 'host',
    roomId: 'room-1234567890abcdef1234567890abcdef',
    name: 'Feature One Workroom',
    url: 'https://10.0.0.7:4242',
    localWorkspaceId: 'feature-one',
    certificateFingerprint: 'AB'.repeat(32),
    snapshot: {
      schemaVersion: 1,
      roomId: 'room-1234567890abcdef1234567890abcdef',
      name: 'Feature One Workroom',
      address: '10.0.0.7',
      port: 4242,
      certificateFingerprint: 'AB'.repeat(32),
      revision: 1,
      createdAt: now,
      bundle: {
        schemaVersion: 1,
        project: { id: 'project-one', name: 'Project One' },
        feature: { id: 'feature-one', goal: 'Build collaboration', description: 'Synthetic E2E room.' },
        repos: [{ id: 'repo-one', name: 'Repo One', remoteUrl: 'https://example.test/repo-one', defaultBranch: 'main' }],
        pinnedResources: [],
        createdAt: now,
      },
      documents: {
        plan: { name: 'plan', revision: 0, content: '# Plan', updatedAt: now, updatedBy: 'member-host', history: [] },
        decisions: { name: 'decisions', revision: 0, content: '# Decisions', updatedAt: now, updatedBy: 'member-host', history: [] },
        handoff: { name: 'handoff', revision: 0, content: '', updatedAt: now, updatedBy: 'member-host', history: [] },
      },
      participants: [{ id: 'member-host', displayName: 'Host', role: 'host', joinedAt: now, lastSeenAt: now }],
      pendingJoins: [],
      resources: [],
      activity: [{ sequence: 1, type: 'room.created', actorId: 'member-host', createdAt: now, summary: 'Workroom created.' }],
    },
  };
}

const tabTools = ['Project & privacy', 'Shared context', 'Resources', 'Workflow', 'People', 'Full activity log', 'Security & encrypted export'];

async function openRoomTool(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open room tools' }).click();
  await page.getByRole('menuitem', { name }).click();
  if (tabTools.includes(name)) {
    await expect(page.getByRole('tabpanel', { name })).toBeVisible();
  }
}

test.describe('Workrooms', () => {
  test.use({ workspacesData: [workspace] });
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/workrooms/bootstrap', async (route) => route.fulfill({
      json: { token: 'test-workroom-bootstrap-token' },
      headers: { 'Set-Cookie': 'nexusflow_workroom_bootstrap=test-workroom-bootstrap-token; Path=/api/workrooms; HttpOnly; SameSite=Strict' },
    }));
  });

  test('previews the sharing boundary and starts an explicit private listener', async ({ page }) => {
    let status: any = { mode: 'idle' };
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [{ name: 'VPN', address: '10.0.0.7', family: 'IPv4', internal: false }] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/preview/feature-one', async (route) => route.fulfill({ json: {
      preview: {
        workspaceId: 'feature-one',
        bundle: hostStatus().snapshot.bundle,
        bundleDigest: 'ab'.repeat(32),
        bundleWarnings: [],
        documents: { plan: '# Plan', decisions: '# Decisions', handoff: '' },
        warnings: { plan: [], decisions: [], handoff: [] },
      },
    } }));
    await page.route('**/api/workrooms/start', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.address).toBe('10.0.0.7');
      expect(body.workspaceId).toBe('feature-one');
      expect(body.contextConfirmed).toBe(true);
      expect(body.contextDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(body.documents).toEqual({ plan: '# Plan', decisions: '', handoff: '' });
      status = hostStatus();
      await route.fulfill({ status: 201, json: { status } });
    });
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));

    await page.goto('/#/workrooms');
    await expect(page.getByRole('heading', { name: 'Workrooms' })).toBeVisible();
    await page.getByText('Select a workspace', { exact: true }).click();
    await page.getByRole('option', { name: 'feature-one' }).click();
    await expect(page.getByText('Exact sharing review')).toBeVisible();
    await expect(page.getByText(/never adds code, diffs, credentials/i)).toBeVisible();
    await page.getByLabel('Include Plan').check();
    await page.getByText(/I reviewed the exact included text/).click();
    await page.getByRole('button', { name: 'Start private Workroom' }).click();
    await expect(page.getByRole('heading', { name: 'Handoff Stream' })).toBeVisible();
    await expect(page.getByText(/No files, diffs, paths, credentials, or transcripts are collected automatically/)).toBeVisible();
  });

  test('keeps an optimistic context draft visible after a conflict', async ({ page }) => {
    const status = hostStatus();
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));
    await page.route('**/api/workrooms/documents/plan', async (route) => route.fulfill({ status: 409, json: { error: 'revision conflict' } }));

    await page.goto('/#/workrooms');
    await openRoomTool(page, 'Shared context');
    const panel = page.getByRole('tabpanel', { name: 'Shared context' });
    await expect(panel).toBeVisible();
    const plan = panel.locator('textarea').first();
    await plan.fill('# My preserved draft');
    await panel.getByRole('button', { name: 'Share revision' }).first().click();
    await expect(plan).toHaveValue('# My preserved draft');
    await expect(page.getByText(/draft is preserved/i)).toBeVisible();
  });

  test('shows a locked active room and explicitly reconnects the local dashboard', async ({ page }) => {
    let reclaimed = false;
    await page.route('**/api/workrooms/status', async (route) => reclaimed
      ? route.fulfill({ json: { status: hostStatus() } })
      : route.fulfill({ status: 401, json: { error: 'human session required' } }));
    await page.route('**/api/workrooms/session', async (route) => route.fulfill({ json: { active: true, locked: true, roomType: 'host' } }));
    await page.route('**/api/workrooms/session/reclaim', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ password: 'correct horse battery staple' });
      reclaimed = true;
      await route.fulfill({ json: { success: true } });
    });
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));

    await page.goto('/#/workrooms');
    await expect(page.getByRole('heading', { name: 'Active Workroom is locked' })).toBeVisible();
    await page.getByLabel('Room password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Unlock host dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Handoff Stream' })).toBeVisible();
  });

  test('reacquires one rotated bootstrap for concurrent rejected read and mutation requests', async ({ page }) => {
    await page.unroute('**/api/workrooms/bootstrap');
    let bootstrapCalls = 0;
    await page.route('**/api/workrooms/bootstrap', async (route) => {
      bootstrapCalls += 1;
      const token = bootstrapCalls === 1 ? 'stale-bootstrap-token' : 'fresh-bootstrap-token';
      await route.fulfill({
        json: { token },
        headers: { 'Set-Cookie': `nexusflow_workroom_bootstrap=${token}; Path=/api/workrooms; HttpOnly; SameSite=Strict` },
      });
    });
    let staleRequests = 0;
    let releaseStaleRequests!: () => void;
    const bothStaleRequestsArrived = new Promise<void>((resolve) => { releaseStaleRequests = resolve; });
    const respondAfterRotation = (body: unknown) => async (route: Route) => {
      const token = route.request().headers()['x-nexusflow-workroom-bootstrap'];
      if (token === 'stale-bootstrap-token') {
        staleRequests += 1;
        if (staleRequests === 2) releaseStaleRequests();
        await bothStaleRequestsArrived;
        await route.fulfill({ status: 403, json: { error: 'Workroom access requires a same-origin dashboard bootstrap.' } });
        return;
      }
      expect(token).toBe('fresh-bootstrap-token');
      await route.fulfill({ json: body });
    };
    const digest = 'a'.repeat(64);
    await page.route('**/api/workrooms/status', respondAfterRotation({ status: { mode: 'idle' } }));
    await page.route(`**/api/workrooms/resources/${digest}/quarantine`, respondAfterRotation({ success: true }));

    await page.goto('/');
    const results = await page.evaluate(async (resourceDigest) => {
      const { apiFetch } = await import('/src/lib/api/client.ts');
      return Promise.all([
        apiFetch<{ status: { mode: string } }>('/api/workrooms/status'),
        apiFetch<{ success: boolean }>(`/api/workrooms/resources/${resourceDigest}/quarantine`, {
          method: 'POST', body: '{}',
        }),
      ]);
    }, digest);
    expect(results).toEqual([{ status: { mode: 'idle' } }, { success: true }]);
    expect(bootstrapCalls).toBe(2);
    expect(staleRequests).toBe(2);
  });

  test('makes a locked guest leave before joining again', async ({ page }) => {
    let left = false;
    await page.route('**/api/workrooms/status', async (route) => left
      ? route.fulfill({ json: { status: { mode: 'idle' } } })
      : route.fulfill({ status: 401, json: { error: 'human session required' } }));
    await page.route('**/api/workrooms/session', async (route) => route.fulfill({ json: left
      ? { active: false, locked: false }
      : { active: true, locked: true, roomType: 'guest' } }));
    await page.route('**/api/workrooms/session/abandon', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ confirm: true });
      left = true;
      await route.fulfill({ json: { success: true } });
    });
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));

    await page.goto('/#/workrooms');
    await expect(page.getByText(/leave this local guest connection/i)).toBeVisible();
    await page.getByRole('button', { name: 'Leave and rejoin' }).click();
    await expect(page.getByRole('heading', { name: 'Workrooms' })).toBeVisible();
  });

  test('lets a disconnected accepted guest retry or leave locally', async ({ page }) => {
    const status = {
      mode: 'guest', roomId: 'room-one', url: 'https://10.0.0.7:4242',
      status: 'accepted', connection: 'disconnected', memberId: 'member-guest',
    };
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));

    await page.goto('/#/workrooms');
    await expect(page.getByRole('heading', { name: 'Workroom connection is unavailable' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Leave local connection' })).toBeVisible();
  });

  test('submits human workflow evidence when completing a required step', async ({ page }) => {
    const status = hostStatus();
    (status.snapshot as any).workflowProgress = {
      workflow: { digest: 'cd'.repeat(32), version: '0.1.0' },
      package: { name: 'Verification workflow', steps: [{ id: 'verify', title: 'Verify', requiresEvidence: true }] },
      revision: 0,
      steps: [{ stepId: 'verify', status: 'in_progress', revision: 0 }],
    };
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));
    await page.route('**/api/workrooms/workflow/steps/verify/transition', async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({ status: 'completed', expectedRevision: 0, evidence: '39 focused tests passed' });
      await route.fulfill({ json: { step: { stepId: 'verify', status: 'completed', revision: 1 } } });
    });

    await page.goto('/#/workrooms');
    await openRoomTool(page, 'Workflow');
    await page.getByLabel('Completion evidence').fill('39 focused tests passed');
    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByLabel('Completion evidence')).toHaveValue('39 focused tests passed');
  });

  test('opens an active room on the lightweight Handoff Stream and keeps tools reachable', async ({ page }) => {
    const status = hostStatus();
    const snapshot = status.snapshot as any;
    snapshot.participants.push({
      id: 'member-publisher', displayName: 'Mira', role: 'publisher',
      joinedAt: '2026-08-27T10:01:00.000Z', lastSeenAt: '2026-08-27T10:05:00.000Z',
    });
    snapshot.workflowProgress = {
      workflow: { kind: 'workflow', id: 'delivery', digest: 'cd'.repeat(32), version: '0.1.0' },
      package: {
        schemaVersion: 1, id: 'delivery', version: '0.1.0', name: 'Delivery workflow', description: '', markdown: '', dependencies: [],
        steps: [
          { id: 'plan', title: 'Plan', requiresEvidence: true },
          { id: 'implement', title: 'Implement', requiresEvidence: true },
          { id: 'review', title: 'Review', requiresEvidence: true },
        ],
      },
      revision: 2,
      steps: [
        { stepId: 'plan', status: 'completed', revision: 1, updatedBy: 'member-host', updatedAt: '2026-08-27T10:10:00.000Z', evidence: 'Plan reviewed' },
        { stepId: 'implement', status: 'in_progress', revision: 1, updatedBy: 'member-publisher', updatedAt: '2026-08-27T10:20:00.000Z' },
        { stepId: 'review', status: 'pending', revision: 0, updatedBy: 'member-host', updatedAt: '2026-08-27T10:00:00.000Z' },
      ],
    };
    snapshot.activity = [
      { sequence: 1, type: 'room.created', actorId: 'member-host', createdAt: '2026-08-27T10:00:00.000Z', summary: 'Workroom created.' },
      { sequence: 2, type: 'document.updated', actorId: 'member-publisher', createdAt: '2026-08-27T10:12:00.000Z', summary: 'plan updated to revision 1.' },
      { sequence: 3, type: 'workflow.updated', actorId: 'member-publisher', createdAt: '2026-08-27T10:20:00.000Z', summary: 'Workflow step implement moved to in progress.' },
    ];
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));

    await page.goto('/#/workrooms');
    const stream = page.getByTestId('handoff-stream');
    await expect(stream.getByRole('heading', { name: 'Handoff Stream' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(stream.getByText('Work is moving')).toBeVisible();
    await expect(stream.getByText(/Mira updated Implement · step 2 of 3 · next: Review/)).toBeVisible();
    const events = stream.getByRole('list', { name: 'Workroom activity' }).getByRole('listitem');
    await expect(events).toHaveCount(3);
    await expect(events.nth(0)).toContainText('Workroom created.');
    await expect(events.nth(1)).toContainText('plan updated to revision 1.');
    await expect(events.nth(2)).toContainText('Workflow step implement moved to in progress.');
    await expect(stream.locator('aside').getByText('publisher', { exact: true })).toBeVisible();

    await openRoomTool(page, 'Security & export');
    const backToStream = page.getByRole('button', { name: 'Back to Handoff Stream' });
    await expect(backToStream).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Security & encrypted export' })).toBeVisible();
    await expect(page.getByText('TLS identity')).toBeVisible();
    await backToStream.click();
    await expect(stream.getByRole('heading', { name: 'Handoff Stream' })).toBeVisible();
    await expect(stream.getByRole('heading', { name: 'Handoff Stream' })).toBeFocused();
  });

  test('posts a reviewed handoff update through the revision-checked document contract', async ({ page }) => {
    const status = hostStatus();
    const snapshot = status.snapshot as any;
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));
    await page.route('**/api/workrooms/documents/handoff', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(0);
      expect(body.content).toBe('Keyboard navigation is ready for review.\n');
      snapshot.documents.handoff = { ...snapshot.documents.handoff, revision: 1, content: body.content };
      snapshot.activity.push({
        sequence: 2, type: 'handoff.published', actorId: 'member-host',
        createdAt: '2026-08-27T10:22:00.000Z', summary: 'handoff updated to revision 1.',
      });
      await route.fulfill({ json: { document: snapshot.documents.handoff } });
    });

    await page.goto('/#/workrooms');
    const composer = page.getByLabel('Share a handoff update');
    await composer.fill('Keyboard navigation is ready for review.');
    await page.getByRole('button', { name: 'Post update' }).click();
    await expect(composer).toHaveValue('');
    await expect(page.getByText('handoff updated to revision 1.')).toBeVisible();
    await expect(page.getByText('Handoff update shared.')).toBeVisible();
  });

  test('preserves a typed stream update when another participant wins the revision race', async ({ page }) => {
    const status = hostStatus();
    const snapshot = status.snapshot as any;
    let attempts = 0;
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));
    await page.route('**/api/workrooms/documents/handoff', async (route) => {
      attempts += 1;
      if (attempts === 1) {
        snapshot.documents.handoff = { ...snapshot.documents.handoff, revision: 1, content: 'A teammate posted first.\n' };
        await route.fulfill({ status: 409, json: { error: 'revision conflict' } });
        return;
      }
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(1);
      expect(body.content).toBe('A teammate posted first.\n\nKeep this draft after the conflict.\n');
      snapshot.documents.handoff = { ...snapshot.documents.handoff, revision: 2, content: body.content };
      await route.fulfill({ json: { document: snapshot.documents.handoff } });
    });

    await page.goto('/#/workrooms');
    const composer = page.getByLabel('Share a handoff update');
    await composer.fill('Keep this draft after the conflict.');
    await page.getByRole('button', { name: 'Post update' }).click();
    await expect(composer).toHaveValue('Keep this draft after the conflict.');
    await expect(page.getByText(/Someone updated the handoff first/)).toBeVisible();
    await openRoomTool(page, 'Shared context');
    await expect(page.locator('textarea').nth(2)).toHaveValue('A teammate posted first.\n');
    await page.getByRole('button', { name: 'Back to Handoff Stream' }).click();
    await expect(composer).toHaveValue('Keep this draft after the conflict.');
    await page.getByRole('button', { name: 'Post update' }).click();
    await expect(composer).toHaveValue('');
    expect(attempts).toBe(2);
  });

  test('keeps an unsaved handoff document from overwriting a stream update', async ({ page }) => {
    const status = hostStatus();
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));

    await page.goto('/#/workrooms');
    await openRoomTool(page, 'Shared context');
    await page.locator('textarea').nth(2).fill('Unsaved full-document edit.');
    await page.getByRole('button', { name: 'Back to Handoff Stream' }).click();
    const composer = page.getByLabel('Share a handoff update');
    await composer.fill('This stream update must wait.');
    await expect(page.getByText(/Resolve your unsaved Handoff draft/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Post update' })).toBeDisabled();
    await page.getByRole('button', { name: 'Review draft' }).click();
    await page.getByRole('button', { name: 'Back to Handoff Stream' }).click();
    await expect(composer).toHaveValue('This stream update must wait.');
  });

  test('preserves text added during a post and disables Stop while it is in flight', async ({ page }) => {
    const status = hostStatus();
    let releasePost!: () => void;
    let markStarted!: () => void;
    let postCompleted = false;
    const released = new Promise<void>((resolve) => { releasePost = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    await page.route('**/api/workrooms/status', async (route) => postCompleted
      ? route.fulfill({ status: 503, json: { error: 'temporary status failure' } })
      : route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));
    await page.route('**/api/workrooms/documents/handoff', async (route) => {
      const body = route.request().postDataJSON();
      markStarted();
      await released;
      postCompleted = true;
      await route.fulfill({ json: { document: { ...status.snapshot.documents.handoff, revision: 1, content: body.content } } });
    });

    await page.goto('/#/workrooms');
    const composer = page.getByLabel('Share a handoff update');
    await composer.fill('Initial update.');
    await page.getByRole('button', { name: 'Post update' }).click();
    await started;
    await composer.fill('Initial update.\nA second thought typed while posting.');
    await page.getByRole('button', { name: 'Open room tools' }).click();
    await expect(page.getByRole('menuitem', { name: 'Stop room' })).toBeDisabled();
    await page.getByRole('menuitem', { name: 'Shared context' }).click();
    const handoffDocument = page.locator('textarea').nth(2);
    await expect(handoffDocument).toBeDisabled();
    releasePost();
    await expect(page.getByText('Handoff update shared.')).toBeVisible();
    await expect(handoffDocument).toBeEnabled();
    await expect(handoffDocument).toHaveValue('Initial update.\n');
    await page.getByRole('button', { name: 'Back to Handoff Stream' }).click();
    await expect(composer).toHaveValue('Initial update.\nA second thought typed while posting.');
  });

  test('does not let an older held status response undo a successful handoff post', async ({ page }) => {
    const status = hostStatus();
    let statusRequests = 0;
    let releaseHeldStatus!: () => void;
    let markHeldStatusStarted!: () => void;
    let markHeldStatusFinished!: () => void;
    let postCompleted = false;
    const heldStatusReleased = new Promise<void>((resolve) => { releaseHeldStatus = resolve; });
    const heldStatusStarted = new Promise<void>((resolve) => { markHeldStatusStarted = resolve; });
    const heldStatusFinished = new Promise<void>((resolve) => { markHeldStatusFinished = resolve; });
    await page.route('**/api/workrooms/status', async (route) => {
      statusRequests += 1;
      if (statusRequests === 2) {
        markHeldStatusStarted();
        await heldStatusReleased;
        await route.fulfill({ json: { status } });
        markHeldStatusFinished();
        return;
      }
      if (postCompleted) {
        await route.fulfill({ status: 503, json: { error: 'temporary status failure' } });
        return;
      }
      await route.fulfill({ json: { status } });
    });
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));
    await page.route('**/api/workrooms/documents/handoff', async (route) => {
      const body = route.request().postDataJSON();
      postCompleted = true;
      await route.fulfill({ json: { document: { ...status.snapshot.documents.handoff, revision: 1, content: body.content } } });
    });

    await page.goto('/#/workrooms');
    await openRoomTool(page, 'Refresh room');
    await heldStatusStarted;
    await page.getByLabel('Share a handoff update').fill('Posted while an older poll is waiting.');
    await page.getByRole('button', { name: 'Post update' }).click();
    await expect(page.getByText('Handoff update shared.')).toBeVisible();
    releaseHeldStatus();
    await heldStatusFinished;
    await page.waitForTimeout(100);
    await openRoomTool(page, 'Shared context');
    await expect(page.locator('textarea').nth(2)).toHaveValue('Posted while an older poll is waiting.\n');
  });

  test('does not let a delayed post response replace a newer polled handoff revision', async ({ page }) => {
    const status = hostStatus();
    const newerStatus = structuredClone(status);
    newerStatus.snapshot.revision = 3;
    newerStatus.snapshot.documents.handoff = {
      ...newerStatus.snapshot.documents.handoff,
      revision: 2,
      content: 'My posted update.\n\nA teammate added a newer update.\n',
    };
    newerStatus.snapshot.activity.push({
      sequence: 2,
      type: 'document.updated',
      actorId: 'member-host',
      createdAt: '2026-08-27T10:01:00.000Z',
      summary: 'A newer handoff revision arrived.',
    });
    let serveNewerStatus = false;
    let releasePost!: () => void;
    let markPostStarted!: () => void;
    const postReleased = new Promise<void>((resolve) => { releasePost = resolve; });
    const postStarted = new Promise<void>((resolve) => { markPostStarted = resolve; });
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status: serveNewerStatus ? newerStatus : status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));
    await page.route('**/api/workrooms/documents/handoff', async (route) => {
      const body = route.request().postDataJSON();
      markPostStarted();
      await postReleased;
      await route.fulfill({ json: { document: { ...status.snapshot.documents.handoff, revision: 1, content: body.content } } });
    });

    await page.goto('/#/workrooms');
    await page.getByLabel('Share a handoff update').fill('My posted update.');
    await page.getByRole('button', { name: 'Post update' }).click();
    await postStarted;
    serveNewerStatus = true;
    await openRoomTool(page, 'Refresh room');
    await expect(page.getByText('A newer handoff revision arrived.')).toBeVisible();
    await openRoomTool(page, 'Shared context');
    const handoffDocument = page.locator('textarea').nth(2);
    await expect(handoffDocument).toHaveValue('My posted update.\n\nA teammate added a newer update.\n');
    releasePost();
    await expect(page.getByText('Handoff update shared.')).toBeVisible();
    await expect(handoffDocument).toBeEnabled();
    await expect(handoffDocument).toHaveValue('My posted update.\n\nA teammate added a newer update.\n');
  });

  test('does not offer host-only workflow setup to an accepted guest', async ({ page }) => {
    const status: any = hostStatus();
    status.mode = 'guest';
    status.status = 'accepted';
    status.connection = 'connected';
    status.memberId = 'member-guest';
    status.snapshot.participants.push({
      id: 'member-guest', displayName: 'Guest', role: 'member',
      joinedAt: '2026-08-27T10:01:00.000Z', lastSeenAt: '2026-08-27T10:01:00.000Z',
    });
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));

    await page.goto('/#/workrooms');
    await expect(page.getByText('The host has not selected a shared workflow yet.')).toBeVisible();
    await expect(page.getByText('Waiting for a workflow')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set workflow' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invite' })).toHaveCount(0);
    await openRoomTool(page, 'Workflow');
    await expect(page.getByRole('tabpanel', { name: 'Workflow' }).getByText('No shared workflow yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start workflow' })).toHaveCount(0);
  });

  test('presents an entirely pending workflow as ready, without implying assignment', async ({ page }) => {
    const status = hostStatus();
    const snapshot = status.snapshot as any;
    snapshot.workflowProgress = {
      workflow: { kind: 'workflow', id: 'delivery', digest: 'cd'.repeat(32), version: '0.1.0' },
      package: {
        schemaVersion: 1, id: 'delivery', version: '0.1.0', name: 'Delivery workflow', description: '', markdown: '', dependencies: [],
        steps: [
          { id: 'plan', title: 'Plan', requiresEvidence: true },
          { id: 'implement', title: 'Implement', requiresEvidence: true },
        ],
      },
      revision: 0,
      steps: [
        { stepId: 'plan', status: 'pending', revision: 0, updatedBy: 'member-host', updatedAt: '2026-08-27T10:00:00.000Z' },
        { stepId: 'implement', status: 'pending', revision: 0, updatedBy: 'member-host', updatedAt: '2026-08-27T10:00:00.000Z' },
      ],
    };
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));

    await page.goto('/#/workrooms');
    const stream = page.getByTestId('handoff-stream');
    await expect(stream.getByText('Workflow ready')).toBeVisible();
    await expect(stream.getByText('Next: Plan · step 1 of 2')).toBeVisible();
    await expect(stream.getByText('Work is moving')).toHaveCount(0);
    await expect(stream.locator('aside').getByText(/updated by/)).toHaveCount(0);
  });

  test('stacks the stream without horizontal overflow on a narrow viewport', async ({ page }) => {
    const status = hostStatus();
    (status.snapshot as any).participants[0].displayName = 'A'.repeat(80);
    (status.snapshot as any).activity.push({
      sequence: 2,
      type: 'document.updated',
      actorId: 'member-from-imported-history',
      createdAt: '2026-08-27T10:05:00.000Z',
      summary: 'B'.repeat(500),
    });
    await page.route('**/api/workrooms/status', async (route) => route.fulfill({ json: { status } }));
    await page.route('**/api/workrooms/interfaces', async (route) => route.fulfill({ json: { interfaces: [] } }));
    await page.route('**/api/workrooms/paused', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/quarantined', async (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route('**/api/workrooms/local-resources', async (route) => route.fulfill({ json: { resources: [] } }));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/workrooms');
    await expect(page.getByTestId('handoff-stream')).toBeVisible();
    await expect(page.getByText('Historical participant')).toBeVisible();
    await expect(page.getByText('system', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByRole('complementary', { name: 'Workroom details' })).toBeVisible();
  });
});
