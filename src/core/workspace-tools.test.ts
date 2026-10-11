import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { parse } from 'smol-toml';
import { BRAND_CONFIG } from './constants.js';
import { generateWorkspaceTools, CLI_LAUNCHER, CLI_ALIAS_LAUNCHER, CLAUDE_PLAN_PERMISSIONS } from './workspace-tools.js';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-tools-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const runtime = { command: process.execPath, entry: path.resolve('dist/index.js') };
it('provides an executable local CLI and selected-assistant MCP configs without npx', async () => {
  const outputs = await generateWorkspaceTools(root, ['claude', 'codex', 'copilot', 'antigravity'], runtime);
  expect(outputs).not.toContain('.cursor/mcp.json');
  expect((await (process.platform === 'win32' ? execa('cmd.exe', ['/d', '/c', path.join(root, `${CLI_LAUNCHER}.cmd`), 'isolate', '--help']) : execa(path.join(root, CLI_LAUNCHER), ['isolate', '--help']))).stdout).toContain('isolate');
  expect((await (process.platform === 'win32' ? execa('cmd.exe', ['/d', '/c', path.join(root, `${CLI_ALIAS_LAUNCHER}.cmd`), '--version']) : execa(path.join(root, CLI_ALIAS_LAUNCHER), ['--version']))).stdout).toMatch(/\d+\.\d+\.\d+/);
  for (const file of ['.mcp.json', '.vscode/mcp.json']) {
    const config = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    const server = (config.mcpServers ?? config.servers)[BRAND_CONFIG.mcp.serverName];
    expect(server).toMatchObject({ command: process.execPath, args: [runtime.entry, 'mcp', 'run', root, '--role', 'interactive'] });
  }
  const codex = parse(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8'));
  expect(codex.mcp_servers).toHaveProperty(BRAND_CONFIG.mcp.serverName);
});
it('preserves unrelated MCP settings across repeat generation and supports the desktop runtime', async () => {
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ custom: true, mcpServers: { other: { command: 'other' } } }));
  await fs.mkdir(path.join(root, '.codex'));
  await fs.writeFile(path.join(root, '.codex/config.toml'), 'model = "custom"\n[mcp_servers.other]\ncommand = "other"\n');
  const desktop = { ...runtime, electron: true };
  await generateWorkspaceTools(root, ['claude', 'codex'], desktop);
  const before = await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8');
  await generateWorkspaceTools(root, ['claude', 'codex'], desktop);
  expect(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8')).toBe(before);
  expect(parse(before)).toMatchObject({ model: 'custom', mcp_servers: { other: { command: 'other' }, [BRAND_CONFIG.mcp.serverName]: { env: { ELECTRON_RUN_AS_NODE: '1' } } } });
  expect(JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'))).toMatchObject({ custom: true, mcpServers: { other: { command: 'other' } } });
  expect(await fs.readFile(path.join(root, `${CLI_LAUNCHER}.cmd`), 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1');
});
it('rejects malformed configs and custom launchers instead of overwriting them', async () => {
  await fs.writeFile(path.join(root, '.mcp.json'), '{broken');
  await expect(generateWorkspaceTools(root, ['claude'], runtime)).rejects.toThrow();
  expect(await fs.readFile(path.join(root, '.mcp.json'), 'utf8')).toBe('{broken');
  await fs.writeFile(path.join(root, CLI_LAUNCHER), 'custom');
  await expect(generateWorkspaceTools(root, [], runtime)).rejects.toThrow('custom launcher');
});
it.skipIf(process.platform === 'win32')('rejects a linked config directory without writing outside the workspace', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-outside-'));
  try {
    await fs.symlink(outside, path.join(root, '.codex'));
    await expect(generateWorkspaceTools(root, ['codex'], runtime)).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});

it('removes only the legacy generated Cursor entry when Cursor is unselected', async () => {
  const target = path.join(root, '.cursor/mcp.json');
  await fs.mkdir(path.dirname(target));
  const legacy = { command: 'npx', args: ['-y', BRAND_CONFIG.mcp.packageName, 'mcp', 'run'] };
  await fs.writeFile(target, JSON.stringify({ mcpServers: { [BRAND_CONFIG.mcp.serverName]: legacy, other: { command: 'custom' } } }));
  await generateWorkspaceTools(root, ['claude'], runtime);
  expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ mcpServers: { other: { command: 'custom' } } });
  await fs.writeFile(target, JSON.stringify({ mcpServers: { [BRAND_CONFIG.mcp.serverName]: legacy } }));
  await generateWorkspaceTools(root, [], runtime);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('lets Claude Code run ctxspace plan without asking, keeping the settings already there', async () => {
  const settings = path.join(root, '.claude/settings.local.json');
  await fs.mkdir(path.dirname(settings));
  await fs.writeFile(settings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] } }));
  await generateWorkspaceTools(root, ['claude'], runtime);
  // A committed local file would wait for the folder's trust again, so it is never in the list to commit.
  expect(await generateWorkspaceTools(root, ['claude'], runtime)).not.toContain('.claude/settings.local.json');
  expect(JSON.parse(await fs.readFile(settings, 'utf8'))).toEqual({
    model: 'opus',
    permissions: { allow: ['Bash(npm test:*)', ...CLAUDE_PLAN_PERMISSIONS], deny: ['Bash(rm:*)'] },
  });
  expect(CLAUDE_PLAN_PERMISSIONS).toEqual(['Bash(ctxspace plan:*)', 'Bash(./.contextspace/bin/ctxspace plan:*)']);

  await fs.writeFile(settings, JSON.stringify({ permissions: { allow: 'everything' } }));
  await expect(generateWorkspaceTools(root, ['claude'], runtime)).rejects.toThrow('Invalid Claude settings');
  expect(JSON.parse(await fs.readFile(settings, 'utf8'))).toEqual({ permissions: { allow: 'everything' } });
});

it('writes no Claude settings when Claude is not selected', async () => {
  await generateWorkspaceTools(root, ['codex'], runtime);
  await expect(fs.stat(path.join(root, '.claude/settings.local.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
