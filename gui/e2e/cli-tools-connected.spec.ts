import { test, expect } from './fixtures';

const feature = {
  id: 'feature-x',
  branchName: 'feature-x',
  description: 'MCP connection status in Start a CLI',
  repos: [],
  assistants: ['claude', 'codex', 'antigravity'],
  workspacePath: '/tmp/feature-x',
  createdAt: '2026-11-26T00:00:00Z',
};

test.use({ workspacesData: [feature], viewport: { width: 1280, height: 800 } });

function agent(id: string, status: Record<string, unknown>) {
  return { id, name: id, configPath: `/tmp/.${id}`, status };
}

test('all connected shows one quiet line with no Connect button and ignores hidden tools', async ({ page }) => {
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
        { id: 'antigravity', name: 'Antigravity', available: true, reason: null },
        { id: 'copilot', name: 'GitHub Copilot', available: true, reason: null },
        { id: 'shell', name: 'Shell', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('codex', { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('antigravity', { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('pi', { state: 'unsupported', reason: 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter' }),
      ],
    },
  }));

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const start = page.getByRole('region', { name: 'Start a CLI session' });
  const mcpStatus = start.getByTestId('mcp-tools-status');
  await expect(mcpStatus).toContainText('Claude Code, Codex and Antigravity can read the plan and change the Board.');
  await expect(mcpStatus).not.toContainText('Pi');
  await expect(mcpStatus).not.toContainText('Copilot');
  await expect(start.getByRole('button', { name: 'Connect' })).toHaveCount(0);
  await expect(start.getByRole('alert')).toHaveCount(0);

  const metrics = await mcpStatus.evaluate((el) => ({
    fontSize: parseFloat(getComputedStyle(el.querySelector('p')!).fontSize),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.fontSize).toBeGreaterThanOrEqual(12);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
});

test('missing tool connects with one press, shows Connecting…, updates line, keeps focus, and survives a poll', async ({ page }) => {
  await page.clock.install();
  let codexConnected = false;
  let agentsReads = 0;
  let releaseConnect!: () => void;
  const connectReady = new Promise<void>((resolve) => { releaseConnect = resolve; });
  const connectPayloads: unknown[] = [];

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', (route) => {
    agentsReads += 1;
    return route.fulfill({
      json: {
        agents: [
          agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
          agent('codex', codexConnected ? { state: 'registered', serverName: 'contextspace-mcp' } : { state: 'missing' }),
        ],
      },
    });
  });
  await page.route('**/api/mcp/agents/connect', async (route) => {
    connectPayloads.push(route.request().postDataJSON());
    await connectReady;
    codexConnected = true;
    await route.fulfill({
      json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] },
    });
  });

  try {
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const start = page.getByRole('region', { name: 'Start a CLI session' });
    const mcpStatus = start.getByTestId('mcp-tools-status');
    await expect(mcpStatus).toContainText("Codex can't read the plan or change the Board yet.");

    const connectBtn = start.getByRole('button', { name: 'Connect' });
    const box = (await connectBtn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(24);
    expect(box.width).toBeGreaterThanOrEqual(24);

    await connectBtn.focus();
    await page.keyboard.press('Enter');

    await expect(start.getByRole('button', { name: 'Connecting…' })).toBeVisible();
    releaseConnect();

    await expect(mcpStatus).toContainText('Connected. Sessions already running get the tools when they start again.');
    await expect(start.getByRole('button', { name: /^Connect/ })).toHaveCount(0);
    expect(connectPayloads).toEqual([{ ids: ['codex'] }]);

    // Focus moved to the status text, never document.body.
    await expect(mcpStatus.locator('p')).toBeFocused();

    // A real refresh/focus poll after staleTime must not hide the result or lose focus.
    const readsBefore = agentsReads;
    await page.clock.fastForward('02:00');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await expect.poll(() => agentsReads).toBeGreaterThan(readsBefore);
    await expect(mcpStatus).toContainText('Connected. Sessions already running get the tools when they start again.');
    await expect(mcpStatus.locator('p')).toBeFocused();
  } finally {
    releaseConnect();
  }
});

test('Connect failure shows the reason in alert style and keeps focus on Connect', async ({ page }) => {
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: { available: true, sessions: [], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: { agents: [agent('codex', { state: 'missing' })] },
  }));
  await page.route('**/api/mcp/agents/connect', (route) => route.fulfill({
    json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'failed', reason: 'codex mcp add exited with code 2: permission denied' } }] },
  }));

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const start = page.getByRole('region', { name: 'Start a CLI session' });
  const connectBtn = start.getByRole('button', { name: 'Connect' });
  await connectBtn.click();

  const alert = start.getByTestId('mcp-tools-status').getByRole('alert');
  await expect(alert).toContainText('codex mcp add exited with code 2: permission denied');
  await expect(connectBtn).toBeVisible();
  await expect(connectBtn).toBeFocused();
});

test('Start on a missing tool connects only that tool first, then starts', async ({ page }) => {
  const order: string[] = [];
  let codexConnected = false;

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('claude', { state: 'missing' }),
        agent('codex', codexConnected ? { state: 'registered', serverName: 'contextspace-mcp' } : { state: 'missing' }),
      ],
    },
  }));
  await page.route('**/api/mcp/agents/connect', async (route) => {
    order.push(`connect:${JSON.stringify(route.request().postDataJSON())}`);
    codexConnected = true;
    await route.fulfill({
      json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] },
    });
  });
  await page.route('**/api/terminals/feature-x/create', async (route) => {
    order.push(`create:${route.request().postDataJSON()?.target}`);
    await route.fulfill({ status: 400, json: { error: 'Test launch intercepted' } });
  });

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  await expect(chat.getByTestId('mcp-tools-status')).toContainText("Claude Code and Codex can't read the plan or change the Board yet.");

  await chat.getByRole('button', { name: 'Start Codex' }).click();
  await expect(chat.getByRole('alert')).toContainText('Test launch intercepted');
  await expect(chat.getByTestId('mcp-tools-status')).toContainText("Connected Codex to ContextSpace's tools first.");
  expect(order).toEqual(['connect:{"ids":["codex"]}', 'create:codex']);
});

test('Start on a missing tool still starts when registration fails, and Start on registered/unsupported never calls connect', async ({ page }) => {
  const connectCalls: unknown[] = [];

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'pi', name: 'Pi', available: true, reason: null },
        { id: 'copilot', name: 'GitHub Copilot', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('pi', { state: 'unsupported', reason: 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter' }),
        agent('codex', { state: 'missing' }),
      ],
    },
  }));
  await page.route('**/api/mcp/agents/connect', (route) => {
    connectCalls.push(route.request().postDataJSON());
    return route.fulfill({
      json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'failed', reason: 'spawn EACCES' } }] },
    });
  });
  await page.route('**/api/terminals/feature-x/create', (route) => {
    const body = route.request().postDataJSON();
    if (body?.target === 'codex') {
      return route.fulfill({
        json: { terminal: { id: 'term-codex', workspace: 'feature-x', target: 'codex', label: 'Codex', cwd: feature.workspacePath, state: 'running' } },
      });
    }
    return route.fulfill({ status: 400, json: { error: 'Test launch intercepted' } });
  });

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });

  for (const label of ['Start Claude Code', 'Start Pi', 'Start GitHub Copilot']) {
    await chat.getByRole('button', { name: label }).click();
    await expect(chat.getByRole('alert')).toContainText('Test launch intercepted');
  }
  expect(connectCalls).toEqual([]);

  await chat.getByRole('button', { name: 'Start Codex' }).click();
  await expect(chat.locator('[data-testid="terminal-state"], [data-testid="terminal-disconnected"]')).toBeVisible();
  expect(connectCalls).toEqual([{ ids: ['codex'] }]);
  await expect(chat.getByRole('alert').filter({ hasText: 'Codex: spawn EACCES' })).toBeVisible();
});

test('unsupported, unreadable, and stale show plain status without a Connect button', async ({ page }) => {
  let mode: 'unsupported' | 'unreadable' | 'stale' = 'unsupported';
  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'pi', name: 'Pi', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', (route) => {
    if (mode === 'unsupported') {
      return route.fulfill({
        json: {
          agents: [
            agent('pi', { state: 'unsupported', reason: 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter' }),
            agent('codex', { state: 'not-installed' }),
          ],
        },
      });
    }
    if (mode === 'unreadable') {
      return route.fulfill({
        json: {
          agents: [
            agent('pi', { state: 'not-installed' }),
            agent('codex', { state: 'unreadable', reason: '/tmp/.codex/config.toml: invalid TOML' }),
          ],
        },
      });
    }
    return route.fulfill({
      json: {
        agents: [
          agent('pi', { state: 'not-installed' }),
          agent('codex', { state: 'registered', serverName: 'contextspace-mcp', stale: '"contextspace-mcp" runs the npm package, which stopped at 2.39.' }),
        ],
      },
    });
  });

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const start = page.getByRole('region', { name: 'Start a CLI session' });
  const mcpStatus = start.getByTestId('mcp-tools-status');

  await expect(mcpStatus).toContainText('Pi needs the pi-mcp-adapter package');
  await expect(start.getByRole('button', { name: 'Connect' })).toHaveCount(0);

  mode = 'unreadable';
  await start.getByRole('button', { name: 'Refresh the CLI tools' }).click();
  await expect(mcpStatus).toContainText('/tmp/.codex/config.toml: invalid TOML');
  await expect(start.getByRole('button', { name: 'Connect' })).toHaveCount(0);

  mode = 'stale';
  await start.getByRole('button', { name: 'Refresh the CLI tools' }).click();
  await expect(mcpStatus).toContainText("Codex uses an old copy of ContextSpace's tools.");
  await expect(start.getByRole('button', { name: 'Connect' })).toHaveCount(0);
  await mcpStatus.locator('summary').click();
  await expect(mcpStatus).toContainText('"contextspace-mcp" runs the npm package, which stopped at 2.39.');
});

test('Start another CLI from SessionDeck + menu connects missing tool even before mcp-agents was cached', async ({ page }) => {
  const order: string[] = [];
  let codexConnected = false;
  const runningClaude = { id: 'term-claude-1', workspace: 'feature-x', target: 'claude', label: 'Claude Code', cwd: feature.workspacePath, state: 'running' };

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [runningClaude],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', async (route) => {
    await new Promise((r) => setTimeout(r, 80));
    await route.fulfill({
      json: {
        agents: [
          agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
          agent('codex', codexConnected ? { state: 'registered', serverName: 'contextspace-mcp' } : { state: 'missing' }),
        ],
      },
    });
  });
  await page.route('**/api/mcp/agents/connect', async (route) => {
    order.push(`connect:${JSON.stringify(route.request().postDataJSON())}`);
    codexConnected = true;
    await route.fulfill({
      json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] },
    });
  });
  await page.route('**/api/terminals/feature-x/create', async (route) => {
    const target = route.request().postDataJSON()?.target;
    order.push(`create:${target}`);
    await route.fulfill({ status: 400, json: { error: 'Test launch intercepted' } });
  });

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  await expect(chat.getByRole('tab', { name: /Claude Code/ })).toBeVisible();

  await chat.getByRole('button', { name: 'Start another CLI' }).click();
  await page.getByRole('menuitem', { name: 'Start Codex' }).click();

  await expect(chat.getByRole('alert')).toContainText('Test launch intercepted');
  await expect(chat.getByTestId('mcp-tools-status')).toContainText("Connected Codex to ContextSpace's tools first.");
  expect(order).toEqual(['connect:{"ids":["codex"]}', 'create:codex']);
});

test('slow in-flight poll cannot revert Connect success, and Connect never steals focus moved elsewhere', async ({ page }) => {
  await page.clock.install();
  let codexConnected = false;
  let releaseSlowPoll!: () => void;
  const slowPollReady = new Promise<void>((resolve) => { releaseSlowPoll = resolve; });
  let releaseConnect!: () => void;
  const connectReady = new Promise<void>((resolve) => { releaseConnect = resolve; });
  let getCount = 0;

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }],
    },
  }));
  await page.route('**/api/mcp/agents', async (route) => {
    getCount += 1;
    if (getCount === 2) {
      // Stale poll started before Connect; resolves after Connect finishes.
      await slowPollReady;
      return route.fulfill({
        json: { agents: [agent('codex', { state: 'missing' })] },
      });
    }
    return route.fulfill({
      json: { agents: [agent('codex', codexConnected ? { state: 'registered', serverName: 'contextspace-mcp' } : { state: 'missing' })] },
    });
  });
  await page.route('**/api/mcp/agents/connect', async (route) => {
    await connectReady;
    codexConnected = true;
    await route.fulfill({
      json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] },
    });
  });

  try {
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const start = page.getByRole('region', { name: 'Start a CLI session' });
    const connectBtn = start.getByRole('button', { name: 'Connect' });
    await expect(connectBtn).toBeVisible();

    // Advance past staleTime (60s) and trigger visibilitychange so TanStack Query starts poll #2.
    await page.clock.fastForward('02:00');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await expect.poll(() => getCount).toBe(2);

    await connectBtn.click();
    await expect(start.getByRole('button', { name: 'Connecting…' })).toBeVisible();
    // Start buttons stay disabled while Connecting… so Start and Connect never race.
    await expect(start.getByRole('button', { name: 'Start Codex' })).toBeDisabled();

    // User moves focus to the conversation search input while Connecting… runs.
    const searchInput = start.getByPlaceholder('Search conversations or harnesses (/)');
    await searchInput.focus();
    await expect(searchInput).toBeFocused();

    releaseConnect();
    const mcpStatus = start.getByTestId('mcp-tools-status');
    await expect(mcpStatus).toContainText('Connected. Sessions already running get the tools when they start again.');
    // Focus stays in the search box instead of being stolen back to the status line.
    await expect(searchInput).toBeFocused();

    // Now the stale poll finishes; it must NOT revert Codex back to missing / Connect.
    releaseSlowPoll();
    await page.clock.runFor(100);
    await expect(mcpStatus).toContainText('Connected. Sessions already running get the tools when they start again.');
    await expect(start.getByRole('button', { name: /^Connect/ })).toHaveCount(0);
  } finally {
    releaseConnect();
    releaseSlowPoll();
  }
});

test('failed Connect on Codex does not leak error banner onto a started Claude session, and mixed missing+stale keeps stale details', async ({ page }) => {
  let claudeStale = true;
  let codexMissing = true;

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('claude', claudeStale
          ? { state: 'registered', serverName: 'contextspace-mcp', stale: '"contextspace-mcp" runs the npm package, which stopped at 2.39.' }
          : { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('codex', codexMissing ? { state: 'missing' } : { state: 'registered', serverName: 'contextspace-mcp' }),
      ],
    },
  }));
  let failOnce = true;
  await page.route('**/api/mcp/agents/connect', (route) => {
    if (failOnce) {
      failOnce = false;
      return route.fulfill({
        json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'failed', reason: 'codex error 123' } }] },
      });
    }
    codexMissing = false;
    return route.fulfill({
      json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] },
    });
  });
  await page.route('**/api/terminals/feature-x/create', (route) => route.fulfill({
    json: { terminal: { id: 'term-claude', workspace: 'feature-x', target: 'claude', label: 'Claude Code', cwd: feature.workspacePath, state: 'running' } },
  }));

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const mcpStatus = chat.getByTestId('mcp-tools-status');

  // Mixed missing + stale shows Connect AND preserves stale disclosure.
  await expect(mcpStatus).toContainText("Codex can't read the plan or change the Board yet.");
  await expect(mcpStatus).toContainText("Claude Code uses an old copy of ContextSpace's tools.");
  await mcpStatus.locator('summary').click();
  await expect(mcpStatus).toContainText('"contextspace-mcp" runs the npm package, which stopped at 2.39.');

  // First Connect fails on Codex.
  await chat.getByRole('button', { name: 'Connect' }).click();
  await expect(mcpStatus.getByRole('alert')).toContainText('codex error 123');

  // Second Connect succeeds on Codex and still keeps Claude's stale disclosure.
  await chat.getByRole('button', { name: 'Connect' }).click();
  await expect(mcpStatus).toContainText('Connected. Sessions already running get the tools when they start again.');
  await expect(mcpStatus).toContainText("Claude Code uses an old copy of ContextSpace's tools.");

  // Force failure again by flipping codex missing via Refresh, fail Connect, then Start Claude Code: Claude must not show Codex's alert.
  codexMissing = true;
  claudeStale = false;
  failOnce = true;
  await chat.getByRole('button', { name: 'Refresh the CLI tools' }).click();
  await chat.getByRole('button', { name: 'Connect' }).click();
  await expect(mcpStatus.getByRole('alert')).toContainText('codex error 123');

  await chat.getByRole('button', { name: 'Start Claude Code' }).click();
  await expect(chat.locator('[data-testid="terminal-state"], [data-testid="terminal-disconnected"]')).toBeVisible();
  await expect(chat.getByRole('alert')).toHaveCount(0);
});

test('hidden pane finishing Connect does not steal focus when reopened later', async ({ page }) => {
  let releaseConnect!: () => void;
  const connectReady = new Promise<void>((resolve) => { releaseConnect = resolve; });
  let codexConnected = false;

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: { available: true, sessions: [], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: { agents: [agent('codex', codexConnected ? { state: 'registered', serverName: 'contextspace-mcp' } : { state: 'missing' })] },
  }));
  await page.route('**/api/mcp/agents/connect', async (route) => {
    await connectReady;
    codexConnected = true;
    await route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] } });
  });

  try {
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    await chat.getByRole('button', { name: 'Connect' }).click();
    await expect(chat.getByRole('button', { name: 'Connecting…' })).toBeVisible();

    // Hide the chat while Connecting… is in flight.
    await page.goto('/#/overview');
    await expect(chat).toBeHidden();

    releaseConnect();
    await page.waitForTimeout(50);

    // Returning to the chat must not retroactively yank focus to the status paragraph.
    const resumeBtn = page.locator('aside.context-sidebar').getByRole('button', { name: 'Resume CLI chat for feature-x' });
    await resumeBtn.click();
    await expect(chat).toBeVisible();
    await expect(chat.getByTestId('mcp-tools-status')).toContainText('Connected. Sessions already running get the tools when they start again.');
    await expect(chat.getByTestId('mcp-tools-status').locator('p')).not.toBeFocused();
  } finally {
    releaseConnect();
  }
});

test('Start on a missing tool after cache goes stale refreshes status, connects first, and shows dismissible banner over running terminal', async ({ page }) => {
  await page.clock.install();
  const order: string[] = [];
  let codexMissing = false;
  const runningClaude = { id: 'term-claude-1', workspace: 'feature-x', target: 'claude', label: 'Claude Code', cwd: feature.workspacePath, state: 'running' };

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [runningClaude],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('codex', codexMissing ? { state: 'missing' } : { state: 'registered', serverName: 'contextspace-mcp' }),
      ],
    },
  }));
  await page.route('**/api/mcp/agents/connect', async (route) => {
    order.push(`connect:${JSON.stringify(route.request().postDataJSON())}`);
    codexMissing = false;
    await route.fulfill({
      json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] },
    });
  });
  await page.route('**/api/terminals/feature-x/create', async (route) => {
    const body = route.request().postDataJSON();
    order.push(`create:${body?.target}`);
    await route.fulfill({
      json: { terminal: { id: 'term-codex', workspace: 'feature-x', target: 'codex', label: 'Codex', cwd: feature.workspacePath, state: 'running' } },
    });
  });

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  await expect(chat.getByRole('tab', { name: /Claude Code/ })).toBeVisible();

  // Seed cache as registered while running Claude, then let cache go stale (>60s) and flip Codex to missing externally.
  await chat.getByRole('button', { name: 'Start another CLI' }).click();
  await page.getByRole('menuitem', { name: 'Continue a saved conversation…' }).click();
  await expect(chat.getByTestId('mcp-tools-status')).toContainText('Claude Code and Codex can read the plan and change the Board.');

  // Switch back to the running Claude tab so useMcpAgents is inactive, advance clock past 60s staleTime, and mark Codex missing.
  await chat.getByRole('tab', { name: /Claude Code/ }).click();
  codexMissing = true;
  await page.clock.fastForward('02:00');

  // Opening a new Codex tab from + menu runs start() immediately while cache is stale: ensureQueryData must refresh and connect Codex first.
  await chat.getByRole('button', { name: 'Start another CLI' }).click();
  await page.getByRole('menuitem', { name: 'Start Codex' }).click();

  await expect(chat.getByRole('status').filter({ hasText: "Connected Codex to ContextSpace's tools first." })).toBeVisible();
  expect(order).toEqual(['connect:{"ids":["codex"]}', 'create:codex']);

  await chat.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(chat.getByText("Connected Codex to ContextSpace's tools first.")).toHaveCount(0);
});

test('external fix clears obsolete Codex connect error even when Pi is unsupported', async ({ page }) => {
  await page.clock.install();
  let codexFixed = false;

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'codex', name: 'Codex', available: true, reason: null },
        { id: 'pi', name: 'Pi', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('codex', codexFixed ? { state: 'registered', serverName: 'contextspace-mcp' } : { state: 'missing' }),
        agent('pi', { state: 'unsupported', reason: 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter' }),
      ],
    },
  }));
  await page.route('**/api/mcp/agents/connect', (route) => route.fulfill({
    json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'failed', reason: 'codex error 123' } }] },
  }));

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const start = page.getByRole('region', { name: 'Start a CLI session' });
  const mcpStatus = start.getByTestId('mcp-tools-status');

  await start.getByRole('button', { name: 'Connect' }).click();
  await expect(mcpStatus.getByRole('alert')).toContainText('Codex: codex error 123');

  codexFixed = true;
  await page.clock.fastForward('02:00');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));

  await expect(mcpStatus.getByRole('alert')).toHaveCount(0);
  await expect(mcpStatus).toContainText('Codex can read the plan and change the Board.');
  await expect(mcpStatus).toContainText('Pi needs the pi-mcp-adapter package');
});

test('double click and double Enter on Connect send one request, and Start and Connect cannot overlap', async ({ page }) => {
  let mode: 'hold-fail' | 'hold-add' | 'hold-start' = 'hold-fail';
  let releaseConnect!: () => void;
  let connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
  const resetGate = () => {
    connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
  };
  const connectPayloads: unknown[] = [];
  const createPayloads: unknown[] = [];

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: { available: true, sessions: [], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: { agents: [agent('codex', { state: 'missing' })] },
  }));
  await page.route('**/api/mcp/agents/connect', async (route) => {
    connectPayloads.push(route.request().postDataJSON());
    await connectGate;
    if (mode === 'hold-fail') {
      return route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'failed', reason: 'mock fail' } }] } });
    }
    return route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] } });
  });
  await page.route('**/api/terminals/feature-x/create', async (route) => {
    createPayloads.push(route.request().postDataJSON());
    await route.fulfill({
      json: { terminal: { id: 'term-codex', workspace: 'feature-x', target: 'codex', label: 'Codex', cwd: feature.workspacePath, state: 'running' } },
    });
  });

  try {
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const start = page.getByRole('region', { name: 'Start a CLI session' });
    const mcpStatus = start.getByTestId('mcp-tools-status');
    const connectBtn = start.getByRole('button', { name: 'Connect' });

    await connectBtn.dblclick();
    await expect(start.getByRole('button', { name: 'Connecting…' })).toBeVisible();
    await page.waitForTimeout(80);
    expect(connectPayloads).toHaveLength(1);
    releaseConnect();
    await expect(mcpStatus.getByRole('alert')).toContainText('Codex: mock fail');

    connectPayloads.length = 0;
    mode = 'hold-add';
    resetGate();
    await connectBtn.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(start.getByRole('button', { name: 'Connecting…' })).toBeVisible();
    await page.waitForTimeout(80);
    expect(connectPayloads).toHaveLength(1);
    await expect(mcpStatus).not.toContainText('Connected.');
    releaseConnect();
    await expect(mcpStatus).toContainText('Connected. Sessions already running get the tools when they start again.');

    // Refresh back to missing, then click Start Codex and click Connect while Connecting… runs (aria-disabled still fires onClick).
    connectPayloads.length = 0;
    mode = 'hold-start';
    resetGate();
    await start.getByRole('button', { name: 'Refresh the CLI tools' }).click();
    await expect(connectBtn).toBeVisible();
    await start.getByRole('button', { name: 'Start Codex' }).click();
    await expect(start.getByRole('button', { name: 'Connecting…' })).toBeVisible();
    await start.getByRole('button', { name: /^Connect/ }).click({ force: true });
    await page.waitForTimeout(80);
    expect(connectPayloads).toHaveLength(1);
    releaseConnect();
    await expect(page.locator('[data-testid="terminal-state"], [data-testid="terminal-disconnected"]')).toBeVisible();
    expect(createPayloads).toHaveLength(1);

    // Also test same-tick pre-commit Connect + Start Codex on a fresh empty tab: Start must be blocked synchronously.
    connectPayloads.length = 0;
    createPayloads.length = 0;
    mode = 'hold-add';
    resetGate();
    await page.getByRole('region', { name: 'CLI Chat', exact: true }).getByRole('button', { name: 'Start another CLI' }).click();
    await page.getByRole('menuitem', { name: 'Continue a saved conversation…' }).click();
    await start.getByRole('button', { name: 'Refresh the CLI tools' }).click();
    await expect(connectBtn).toBeVisible();
    await page.evaluate(() => {
      const region = document.querySelector('[aria-label="Start a CLI session"]');
      const buttons = Array.from(region?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
      const connect = buttons.find((b) => b.textContent?.trim() === 'Connect');
      const startCodex = region?.querySelector('button[aria-label="Start Codex"]') as HTMLButtonElement | null;
      connect?.click();
      startCodex?.click();
    });
    await page.waitForTimeout(80);
    expect(connectPayloads).toHaveLength(1);
    expect(createPayloads).toHaveLength(0);
    releaseConnect();
    await expect(mcpStatus).toContainText('Connected. Sessions already running get the tools when they start again.');
    expect(createPayloads).toHaveLength(0);
  } finally {
    releaseConnect();
  }
});

test('while Connecting…, Start, Retry launch, and saved-conversation Continue are disabled', async ({ page }) => {
  let releaseConnect!: () => void;
  const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
  let createCalls = 0;

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/workspace/feature-x/sessions?*', (route) => {
    const src = new URL(route.request().url()).searchParams.get('source');
    if (src === 'claude') {
      return route.fulfill({
        json: {
          sessions: [{
            id: '11111111-1111-4111-8111-111111111111',
            assistant: 'claude',
            title: 'Saved Claude Thread',
            updatedAt: '2026-11-27T12:00:00Z',
            createdAt: '2026-11-27T11:00:00Z',
            messageCount: 5,
            workspacePath: feature.workspacePath,
            recordedCwd: feature.workspacePath,
            threadKind: 'main',
          }],
        },
      });
    }
    if (src === 'codex') {
      return route.fulfill({
        json: {
          sessions: [{
            id: '22222222-2222-4222-8222-222222222222',
            assistant: 'codex',
            title: 'Saved Codex Thread',
            updatedAt: '2026-11-27T11:30:00Z',
            createdAt: '2026-11-27T11:00:00Z',
            messageCount: 3,
            workspacePath: feature.workspacePath,
            recordedCwd: feature.workspacePath,
            threadKind: 'main',
          }],
        },
      });
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('codex', { state: 'missing' }),
      ],
    },
  }));
  await page.route('**/api/terminals/feature-x/create', (route) => {
    createCalls += 1;
    return route.fulfill({ status: 400, json: { error: 'first launch failed' } });
  });
  await page.route('**/api/mcp/agents/connect', async (route) => {
    await connectGate;
    return route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] } });
  });

  try {
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    const start = chat.getByRole('region', { name: 'Start a CLI session' });
    const continueBtns = start.getByRole('button', { name: 'Continue', exact: true });
    await expect(continueBtns).toHaveCount(2);

    await start.getByRole('button', { name: 'Start Claude Code' }).click();
    const retryBtn = chat.getByRole('button', { name: 'Retry launch' });
    await expect(retryBtn).toBeVisible();
    expect(createCalls).toBe(1);

    await start.getByRole('button', { name: 'Connect' }).click();
    await expect(start.getByRole('button', { name: 'Connecting…' })).toBeVisible();

    await expect(start.getByRole('button', { name: 'Start Claude Code' })).toBeDisabled();
    await expect(start.getByRole('button', { name: 'Start Codex' })).toBeDisabled();
    await expect(retryBtn).toBeDisabled();
    await expect(continueBtns.nth(0)).toBeDisabled();
    await expect(continueBtns.nth(1)).toBeDisabled();

    // Clicking the saved row itself while Connecting… must not start a session either.
    await start.getByTestId('resume-session-row').first().click();
    await page.waitForTimeout(50);
    expect(createCalls).toBe(1);

    releaseConnect();
    await expect(start.getByTestId('mcp-tools-status')).toContainText('Connected. Sessions already running get the tools when they start again.');
    await expect(retryBtn).toBeEnabled();
    await expect(continueBtns.nth(0)).toBeEnabled();
    await expect(continueBtns.nth(1)).toBeEnabled();
  } finally {
    releaseConnect();
  }
});

test('late Connect settling after external launch starts a terminal leaves no notice on that terminal and still updates the status cache', async ({ page }) => {
  let connectOutcome: 'fail' | 'add' = 'fail';
  let codexConnected = false;
  let createSeq = 0;
  let releaseConnect!: () => void;
  let connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [
        { id: 'claude', name: 'Claude Code', available: true, reason: null },
        { id: 'codex', name: 'Codex', available: true, reason: null },
      ],
    },
  }));
  await page.route('**/api/workspace/feature-x/sessions?*', (route) => {
    const src = new URL(route.request().url()).searchParams.get('source');
    if (src === 'claude') {
      return route.fulfill({
        json: {
          sessions: [{
            id: '11111111-1111-4111-8111-111111111111',
            assistant: 'claude',
            title: 'Saved Claude Thread',
            updatedAt: '2026-11-27T12:00:00Z',
            createdAt: '2026-11-27T11:00:00Z',
            messageCount: 5,
            workspacePath: feature.workspacePath,
            recordedCwd: feature.workspacePath,
            threadKind: 'main',
          }],
        },
      });
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('codex', codexConnected ? { state: 'registered', serverName: 'contextspace-mcp' } : { state: 'missing' }),
      ],
    },
  }));
  await page.route('**/api/mcp/agents/connect', async (route) => {
    await connectGate;
    if (connectOutcome === 'fail') {
      return route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'failed', reason: 'late codex failure' } }] } });
    }
    codexConnected = true;
    return route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] } });
  });
  await page.route('**/api/terminals/feature-x/create', (route) => {
    const id = `term-claude-ext-${++createSeq}`;
    return route.fulfill({
      json: { terminal: { id, workspace: 'feature-x', target: 'claude', label: 'Claude Code', cwd: feature.workspacePath, state: 'running' } },
    });
  });
  await page.routeWebSocket('**/ws/terminal', (ws) => {
    let attachedId = 'term-claude-ext-1';
    ws.onMessage((msg) => {
      const parsed = JSON.parse(String(msg));
      if (parsed.type === 'attach') {
        attachedId = parsed.id ?? attachedId;
        ws.send(JSON.stringify({ type: 'ready', terminal: { id: attachedId, workspace: 'feature-x', target: 'claude', label: 'Claude Code', cwd: feature.workspacePath, state: 'running' }, truncated: false }));
        ws.send(JSON.stringify({ type: 'replayed' }));
      }
    });
  });

  try {
    // Part 1: late failure does not stamp an alert onto the running terminal.
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    await chat.getByRole('button', { name: 'Connect' }).click();
    await expect(chat.getByRole('button', { name: 'Connecting…' })).toBeVisible();

    await page.goto('/#/overview');
    await page.getByRole('button', { name: 'Open Saved Claude Thread with Claude Code in CLI chat' }).click();
    await expect(chat.getByTestId('terminal-state')).toBeVisible();

    releaseConnect();
    await page.waitForTimeout(100);
    await expect(chat.getByRole('alert')).toHaveCount(0);

    // Part 2: late success on a second empty tab does not stamp "Connected…" onto the terminal, yet updates the status cache.
    connectOutcome = 'add';
    connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    await chat.getByRole('button', { name: 'Start another CLI' }).click();
    await page.getByRole('menuitem', { name: 'Continue a saved conversation…' }).click();
    await expect(chat.getByRole('button', { name: 'Connect' })).toBeVisible();
    await chat.getByRole('button', { name: 'Connect' }).click();
    await expect(chat.getByRole('button', { name: 'Connecting…' })).toBeVisible();

    await page.goto('/#/overview');
    await page.getByRole('button', { name: 'Open Saved Claude Thread with Claude Code in CLI chat' }).click();
    await expect.poll(() => createSeq).toBe(2);
    await expect(chat.getByTestId('terminal-state')).toHaveCount(2);

    releaseConnect();
    await page.waitForTimeout(100);
    await expect(chat.getByText(/Connected\. Sessions already running/)).toHaveCount(0);

    await chat.getByRole('button', { name: 'Start another CLI' }).click();
    await page.getByRole('menuitem', { name: 'Continue a saved conversation…' }).click();
    await expect(chat.getByTestId('mcp-tools-status')).toContainText('Claude Code and Codex can read the plan and change the Board.');
  } finally {
    releaseConnect();
  }
});

test('with GET /api/mcp/agents returning 500, Start creates the terminal within 2 s with no retries', async ({ page }) => {
  let getCount = 0;
  let createCalls = 0;

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: { available: true, sessions: [], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] },
  }));
  await page.route('**/api/mcp/agents', (route) => {
    getCount += 1;
    return route.fulfill({ status: 500, json: { error: 'inspect boom' } });
  });
  await page.route('**/api/terminals/feature-x/create', (route) => {
    createCalls += 1;
    return route.fulfill({
      json: { terminal: { id: 'term-codex-500', workspace: 'feature-x', target: 'codex', label: 'Codex', cwd: feature.workspacePath, state: 'running' } },
    });
  });

  await page.goto('/#/workspaces/feature-x/sessions');
  await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
  const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
  const startBtn = chat.getByRole('button', { name: 'Start Codex' });
  await expect(startBtn).toBeVisible();
  await expect.poll(() => getCount).toBe(1);

  // useMcpAgents must not schedule TanStack Query's 1s/2s/4s retries.
  await page.waitForTimeout(1200);
  expect(getCount).toBe(1);

  const getsBeforeStart = getCount;
  const startedAt = Date.now();
  await startBtn.click();
  await expect(chat.locator('[data-testid="terminal-state"], [data-testid="terminal-disconnected"]')).toBeVisible();
  const elapsedMs = Date.now() - startedAt;

  expect(elapsedMs).toBeLessThan(2000);
  expect(createCalls).toBe(1);
  expect(getCount - getsBeforeStart).toBe(1);
  await page.waitForTimeout(1200);
  expect(getCount).toBe(getsBeforeStart + 1);
});

test('same-tick Start then Connect sends one request, and Refresh mid-Connect still shows Connect failure', async ({ page }) => {
  let releaseConnect!: () => void;
  let connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
  const connectPayloads: unknown[] = [];
  const createPayloads: unknown[] = [];
  let mode: 'fail' | 'add' = 'fail';

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: { available: true, sessions: [], targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }] },
  }));
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: { agents: [agent('codex', { state: 'missing' })] },
  }));
  await page.route('**/api/mcp/agents/connect', async (route) => {
    connectPayloads.push(route.request().postDataJSON());
    await connectGate;
    if (mode === 'fail') {
      return route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'failed', reason: 'refresh mid-connect fail' } }] } });
    }
    return route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] } });
  });
  await page.route('**/api/terminals/feature-x/create', (route) => {
    createPayloads.push(route.request().postDataJSON());
    return route.fulfill({
      json: { terminal: { id: 'term-codex-1', workspace: 'feature-x', target: 'codex', label: 'Codex', cwd: feature.workspacePath, state: 'running' } },
    });
  });

  try {
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    const start = chat.getByRole('region', { name: 'Start a CLI session' });

    // Part 1: Clicking Refresh mid-Connect must not swallow a Connect failure alert.
    await start.getByRole('button', { name: 'Connect' }).click();
    await expect(start.getByRole('button', { name: 'Connecting…' })).toBeVisible();
    await start.getByRole('button', { name: 'Refresh the CLI tools' }).click();
    await page.waitForTimeout(50);
    releaseConnect();
    await expect(start.getByTestId('mcp-tools-status').getByRole('alert')).toContainText('Codex: refresh mid-connect fail');
    expect(connectPayloads).toHaveLength(1);

    // Part 2: Same-tick Start Codex + Connect (reverse order) sends one connect and one create.
    connectPayloads.length = 0;
    createPayloads.length = 0;
    mode = 'add';
    connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    await start.getByRole('button', { name: 'Refresh the CLI tools' }).click();
    await expect(start.getByRole('button', { name: 'Connect' })).toBeVisible();
    await page.evaluate(() => {
      const region = document.querySelector('[aria-label="Start a CLI session"]');
      const buttons = Array.from(region?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
      const connect = buttons.find((b) => b.textContent?.trim() === 'Connect');
      const startCodex = region?.querySelector('button[aria-label="Start Codex"]') as HTMLButtonElement | null;
      startCodex?.click();
      connect?.click();
    });
    await page.waitForTimeout(80);
    expect(connectPayloads).toHaveLength(1);
    releaseConnect();
    await expect(chat.locator('[data-testid="terminal-state"], [data-testid="terminal-disconnected"]')).toBeVisible();
    expect(createPayloads).toHaveLength(1);
    await expect(chat.getByRole('status').filter({ hasText: "Connected Codex to ContextSpace's tools first." })).toBeVisible();
  } finally {
    releaseConnect();
  }
});

test('external launch of a missing tool during Connect awaits matching connect or connects its own tool even if Connect rejects', async ({ page }) => {
  let codexOutcome: 'add' | 'error-500' = 'add';
  let codexConnected = false;
  let releaseCodexConnect!: () => void;
  let codexConnectGate = new Promise<void>((resolve) => { releaseCodexConnect = resolve; });
  const connectPayloads: Array<{ ids?: string[] }> = [];
  const createPayloads: Array<{ target?: string }> = [];

  await page.route('**/api/terminals/bootstrap', (route) => route.fulfill({ json: { token: 'test-token', expiresAt: Date.now() + 300_000 } }));
  await page.route('**/api/terminals/feature-x/status', (route) => route.fulfill({
    json: {
      available: true,
      sessions: [],
      targets: [{ id: 'codex', name: 'Codex', available: true, reason: null }],
    },
  }));
  await page.route('**/api/workspace/feature-x/sessions?*', (route) => {
    const src = new URL(route.request().url()).searchParams.get('source');
    if (src === 'codex') {
      return route.fulfill({
        json: {
          sessions: [{
            id: '22222222-2222-4222-8222-222222222222',
            assistant: 'codex',
            title: 'Saved Codex Thread',
            updatedAt: '2026-11-27T12:00:00Z',
            createdAt: '2026-11-27T11:00:00Z',
            messageCount: 3,
            workspacePath: feature.workspacePath,
            recordedCwd: feature.workspacePath,
            threadKind: 'main',
          }],
        },
      });
    }
    if (src === 'antigravity') {
      return route.fulfill({
        json: {
          sessions: [{
            id: '33333333-3333-4333-8333-333333333333',
            assistant: 'antigravity',
            title: 'Saved Antigravity Thread',
            updatedAt: '2026-11-27T11:30:00Z',
            createdAt: '2026-11-27T11:00:00Z',
            messageCount: 2,
            workspacePath: feature.workspacePath,
            recordedCwd: feature.workspacePath,
            threadKind: 'main',
          }],
        },
      });
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await page.route('**/api/mcp/agents', (route) => route.fulfill({
    json: {
      agents: [
        agent('codex', codexConnected ? { state: 'registered', serverName: 'contextspace-mcp' } : { state: 'missing' }),
        agent('antigravity', { state: 'missing' }),
      ],
    },
  }));
  await page.route('**/api/mcp/agents/connect', async (route) => {
    const body = route.request().postDataJSON() as { ids?: string[] };
    connectPayloads.push(body);
    if (body.ids?.includes('codex')) {
      await codexConnectGate;
      if (codexOutcome === 'error-500') {
        return route.fulfill({ status: 500, json: { error: 'codex 500 boom' } });
      }
      codexConnected = true;
      return route.fulfill({ json: { results: [{ id: 'codex', name: 'Codex', outcome: { result: 'added', how: 'codex mcp add' } }] } });
    }
    return route.fulfill({ json: { results: [{ id: 'antigravity', name: 'Antigravity', outcome: { result: 'added', how: 'agy mcp add' } }] } });
  });
  await page.route('**/api/terminals/feature-x/create', (route) => {
    const body = route.request().postDataJSON() as { target?: string };
    createPayloads.push(body);
    const target = body.target ?? 'codex';
    return route.fulfill({
      json: { terminal: { id: `term-${target}-${createPayloads.length}`, workspace: 'feature-x', target, label: target, cwd: feature.workspacePath, state: 'running' } },
    });
  });
  await page.routeWebSocket('**/ws/terminal', (ws) => {
    ws.onMessage((msg) => {
      const parsed = JSON.parse(String(msg));
      if (parsed.type === 'attach') {
        ws.send(JSON.stringify({ type: 'ready', terminal: { id: parsed.id, workspace: 'feature-x', target: 'codex', label: 'Codex', cwd: feature.workspacePath, state: 'running' }, truncated: false }));
        ws.send(JSON.stringify({ type: 'replayed' }));
      }
    });
  });

  try {
    // Part 1: External launch for the SAME missing tool (codex) awaits in-flight Connect instead of sending a second request.
    await page.goto('/#/workspaces/feature-x/sessions');
    await page.getByRole('button', { name: 'Open CLI Chat', exact: true }).click();
    const chat = page.getByRole('region', { name: 'CLI Chat', exact: true });
    await chat.getByRole('button', { name: 'Connect' }).click();
    await expect(chat.getByRole('button', { name: 'Connecting…' })).toBeVisible();

    await page.goto('/#/overview');
    await page.getByRole('button', { name: 'Open Saved Codex Thread with Codex in CLI chat' }).click();
    await page.waitForTimeout(80);
    expect(connectPayloads).toEqual([{ ids: ['codex'] }]);

    releaseCodexConnect();
    await expect(chat.getByTestId('terminal-state')).toBeVisible();
    expect(connectPayloads).toEqual([{ ids: ['codex'] }]);
    expect(createPayloads.map((p) => p.target)).toEqual(['codex']);
    await expect(chat.getByRole('status').filter({ hasText: "Connected Codex to ContextSpace's tools first." })).toBeVisible();
    await expect(chat.getByText(/Connected\. Sessions already running/)).toHaveCount(0);

    // Part 2: On a second empty tab, Connect runs for ['codex'] and rejects 500 while external launch arrives for a DIFFERENT missing tool (antigravity).
    connectPayloads.length = 0;
    createPayloads.length = 0;
    codexConnected = false;
    codexOutcome = 'error-500';
    codexConnectGate = new Promise<void>((resolve) => { releaseCodexConnect = resolve; });

    await chat.getByRole('button', { name: 'Start another CLI' }).click();
    await page.getByRole('menuitem', { name: 'Continue a saved conversation…' }).click();
    await chat.getByRole('button', { name: 'Refresh the CLI tools' }).click();
    await expect(chat.getByRole('button', { name: 'Connect' })).toBeVisible();
    await chat.getByRole('button', { name: 'Connect' }).click();
    await expect(chat.getByRole('button', { name: 'Connecting…' })).toBeVisible();

    await page.goto('/#/overview');
    await page.getByRole('button', { name: 'Open Saved Antigravity Thread with Antigravity in CLI chat' }).click();
    await page.waitForTimeout(80);
    releaseCodexConnect();

    await expect.poll(() => createPayloads.map((p) => p.target)).toEqual(['antigravity']);
    expect(connectPayloads).toEqual([{ ids: ['codex'] }, { ids: ['antigravity'] }]);
    await expect(chat.getByRole('status').filter({ hasText: "Connected Antigravity to ContextSpace's tools first." })).toBeVisible();
    await expect(chat.getByRole('alert')).toHaveCount(0);
  } finally {
    releaseCodexConnect();
  }
});
