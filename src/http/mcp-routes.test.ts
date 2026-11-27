import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MCP_REGISTRATION_NAME, type CommandRunner } from '../core/agent-mcp.js';
import { registerMcpRoutes } from './mcp-routes.js';

let home: string;
let installed: Set<string>;
let calls: Array<{ file: string; args: string[] }>;

function fakeCli(): CommandRunner {
  return async (file, args) => {
    const tool = path.win32.basename(file).replace(/\.(exe|cmd)$/i, '');
    calls.push({ file: tool, args });
    const [, , ...rest] = args;
    if (tool === 'claude') rest.splice(0, 2);
    const name = rest[0]!;
    const dash = rest.indexOf('--');
    const [command, ...commandArgs] = rest.slice(dash + 1);

    if (tool === 'claude') {
      const config = path.join(home, '.claude.json');
      const data = await fs.readFile(config, 'utf8').then(JSON.parse, () => ({}));
      data.mcpServers = { ...data.mcpServers, [name]: { type: 'stdio', command, args: commandArgs, env: {} } };
      await fs.writeFile(config, JSON.stringify(data), 'utf8');
    } else if (tool === 'codex') {
      const config = path.join(home, '.codex', 'config.toml');
      const data = await fs.readFile(config, 'utf8').then(parseToml, () => ({} as Record<string, any>));
      data.mcp_servers = { ...(data.mcp_servers as object), [name]: { command, args: commandArgs } };
      await fs.mkdir(path.dirname(config), { recursive: true });
      await fs.writeFile(config, stringifyToml(data), 'utf8');
    } else if (tool === 'agy') {
      const config = path.join(home, '.gemini', 'config', 'mcp_config.json');
      const data = await fs.readFile(config, 'utf8').then(JSON.parse, () => ({}));
      data.mcpServers = { ...data.mcpServers, [name]: { command, args: commandArgs } };
      await fs.mkdir(path.dirname(config), { recursive: true });
      await fs.writeFile(config, JSON.stringify(data), 'utf8');
    }
    return { exitCode: 0, stdout: `Added ${name}`, stderr: '' };
  };
}

function makeApp(run: CommandRunner = fakeCli()): Hono {
  const app = new Hono();
  registerMcpRoutes(app, {
    home,
    env: { PATH: '' },
    platform: 'linux',
    run,
    findBinary: (name) => (installed.has(name) ? `/fake/bin/${name}` : null),
  });
  return app;
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-mcp-routes-'));
  installed = new Set();
  calls = [];
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('MCP agent routes', () => {
  it('GET /api/mcp/agents returns { agents } reflecting temp home configs', async () => {
    installed = new Set(['claude', 'codex', 'pi']);
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { [MCP_REGISTRATION_NAME]: { command: 'npx', args: [] } },
    }), 'utf8');

    const app = makeApp();
    const res = await app.request('/api/mcp/agents');
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Array<{ id: string; status: { state: string } }> };
    expect(body.agents.map((a) => [a.id, a.status.state])).toEqual([
      ['claude', 'registered'],
      ['codex', 'missing'],
      ['antigravity', 'not-installed'],
      ['pi', 'unsupported'],
    ]);
  });

  it('POST /api/mcp/agents/connect with ids connects only those tools and leaves others untouched', async () => {
    installed = new Set(['claude', 'codex']);
    const app = makeApp();

    const res = await app.request('/api/mcp/agents/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['codex'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ id: string; outcome: { result: string } }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ id: 'codex', outcome: { result: 'added' } });
    expect(calls.map((c) => c.file)).toEqual(['codex']);

    const after = await (await app.request('/api/mcp/agents')).json() as { agents: Array<{ id: string; status: { state: string } }> };
    expect(after.agents.find((a) => a.id === 'codex')?.status.state).toBe('registered');
    expect(after.agents.find((a) => a.id === 'claude')?.status.state).toBe('missing');
  });

  it('POST /api/mcp/agents/connect with no body connects all missing installed tools', async () => {
    installed = new Set(['claude', 'codex']);
    const app = makeApp();

    const res = await app.request('/api/mcp/agents/connect', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ id: string; outcome: { result: string } }> };
    expect(body.results.filter((r) => r.outcome.result === 'added').map((r) => r.id)).toEqual(['claude', 'codex']);
  });

  it('returns failed outcomes when an agent CLI fails', async () => {
    installed = new Set(['codex']);
    const app = makeApp(async () => ({ exitCode: 2, stdout: '', stderr: 'permission denied' }));

    const res = await app.request('/api/mcp/agents/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['codex'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ id: string; outcome: { result: string; reason?: string } }> };
    expect(body.results[0]?.outcome).toMatchObject({ result: 'failed', reason: expect.stringContaining('permission denied') });
  });

  it('rejects malformed JSON, unknown agent ids, and extra fields with 400', async () => {
    const app = makeApp();
    for (const body of ['{nope', JSON.stringify({ ids: ['copilot'] }), JSON.stringify({ ids: ['codex'], extra: true })]) {
      const res = await app.request('/api/mcp/agents/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
    }
  });

  it('serializes concurrent connect requests so two never run at once', async () => {
    installed = new Set(['claude', 'codex']);
    const real = fakeCli();
    const entered: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWaiterDone!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      firstWaiterDone = resolve;
    });

    const app = makeApp(async (file, args, env) => {
      const tool = path.win32.basename(file);
      entered.push(tool);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (tool === 'claude') {
          releaseFirst();
          await holdFirst;
        }
        return await real(file, args, env);
      } finally {
        active -= 1;
      }
    });

    const req1 = app.request('/api/mcp/agents/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['claude'] }),
    });
    await firstEntered;
    const req2 = app.request('/api/mcp/agents/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['codex'] }),
    });
    // Give the event loop a chance; req2 must still wait behind req1.
    await new Promise((r) => setTimeout(r, 20));
    expect(maxActive).toBe(1);
    expect(entered).toEqual(['claude']);

    firstWaiterDone();
    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(maxActive).toBe(1);
    expect(calls.map((c) => c.file)).toEqual(['claude', 'codex']);
  });

  it('recovers the connect queue after a 500 error so subsequent connects still execute', async () => {
    installed = new Set(['codex']);
    let explode = true;
    const real = fakeCli();
    const app = new Hono();
    registerMcpRoutes(app, {
      home,
      env: { PATH: '' },
      platform: 'linux',
      run: real,
      findBinary: (name) => {
        if (explode) throw new Error('boom');
        return installed.has(name) ? `/fake/bin/${name}` : null;
      },
    });

    const first = await app.request('/api/mcp/agents/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['codex'] }),
    });
    expect(first.status).toBe(500);

    explode = false;
    const second = await app.request('/api/mcp/agents/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['codex'] }),
    });
    expect(second.status).toBe(200);
    const body = await second.json() as { results: Array<{ id: string; outcome: { result: string } }> };
    expect(body.results[0]).toMatchObject({ id: 'codex', outcome: { result: 'added' } });
  });
});
