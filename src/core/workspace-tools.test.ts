import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { parse, stringify } from 'smol-toml';
import { BRAND_CONFIG } from './constants.js';
import { generateWorkspaceTools, workspaceToolsNeedRepair, CLI_LAUNCHER, CLI_ALIAS_LAUNCHER, CLAUDE_CLI_PERMISSIONS } from './workspace-tools.js';
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

it('lets Claude Code run ctxspace plan, ask and knowledge search without asking, keeping the settings already there', async () => {
  const settings = path.join(root, '.claude/settings.local.json');
  await fs.mkdir(path.dirname(settings));
  await fs.writeFile(settings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] } }));
  await generateWorkspaceTools(root, ['claude'], runtime);
  // A committed local file would wait for the folder's trust again, so it is never in the list to commit.
  expect(await generateWorkspaceTools(root, ['claude'], runtime)).not.toContain('.claude/settings.local.json');
  expect(JSON.parse(await fs.readFile(settings, 'utf8'))).toEqual({
    model: 'opus',
    permissions: { allow: ['Bash(npm test:*)', ...CLAUDE_CLI_PERMISSIONS], deny: ['Bash(rm:*)'] },
  });
  expect(CLAUDE_CLI_PERMISSIONS).toEqual([
    'Bash(ctxspace plan:*)', 'Bash(./.contextspace/bin/ctxspace plan:*)',
    'Bash(ctxspace knowledge search:*)', 'Bash(./.contextspace/bin/ctxspace knowledge search:*)',
    'Bash(ctxspace ask:*)', 'Bash(./.contextspace/bin/ctxspace ask:*)',
  ]);
  // Nothing broad enough to let `knowledge add`, `promote` or `remote` through.
  expect(CLAUDE_CLI_PERMISSIONS.filter((rule) => /ctxspace (:|knowledge:)/.test(rule))).toEqual([]);

  await fs.writeFile(settings, JSON.stringify({ permissions: { allow: 'everything' } }));
  await expect(generateWorkspaceTools(root, ['claude'], runtime)).rejects.toThrow('Invalid Claude settings');
  expect(JSON.parse(await fs.readFile(settings, 'utf8'))).toEqual({ permissions: { allow: 'everything' } });
});

it('adds the newer rules to a workspace that only had the plan rules, once', async () => {
  const settings = path.join(root, '.claude/settings.local.json');
  await fs.mkdir(path.dirname(settings));
  await fs.writeFile(settings, JSON.stringify({ permissions: { allow: ['Bash(ctxspace plan:*)', 'Bash(./.contextspace/bin/ctxspace plan:*)'] } }));

  await generateWorkspaceTools(root, ['claude'], runtime);
  await generateWorkspaceTools(root, ['claude'], runtime);

  expect(JSON.parse(await fs.readFile(settings, 'utf8')).permissions.allow).toEqual(CLAUDE_CLI_PERMISSIONS);
});

it('writes no Claude settings when Claude is not selected', async () => {
  await generateWorkspaceTools(root, ['codex'], runtime);
  await expect(fs.stat(path.join(root, '.claude/settings.local.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

/** A fake installed copy of the CLI at `version`: the entry sits under a package.json of that version, as in the app and in npm. */
async function installRuntime(name: string, version: string, electron = false) {
  const dir = path.join(root, '..', `${path.basename(root)}-${name}`);
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: BRAND_CONFIG.mcp.packageName, version }));
  await fs.writeFile(path.join(dir, 'dist/index.js'), '');
  return { dir, runtime: { command: process.execPath, entry: path.join(dir, 'dist/index.js'), electron } };
}
/** Launchers write paths with forward slashes, even on Windows. */
const slashes = (value: string) => value.replaceAll('\\', '/');
const mcpEntry = async () => JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers[BRAND_CONFIG.mcp.serverName].args[0];

it('does not move a workspace to an older runtime', async () => {
  const app = await installRuntime('app', '2.42.0', true);
  const npm = await installRuntime('npm', '2.39.0');
  try {
    await generateWorkspaceTools(root, ['claude', 'codex'], app.runtime);
    const launcher = await fs.readFile(path.join(root, CLI_LAUNCHER), 'utf8');
    // The npm 2.39 program refreshes the workspace the app set up.
    await generateWorkspaceTools(root, ['claude', 'codex'], npm.runtime);
    expect(await fs.readFile(path.join(root, CLI_LAUNCHER), 'utf8')).toBe(launcher);
    expect(await mcpEntry()).toBe(app.runtime.entry);
    expect(JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers[BRAND_CONFIG.mcp.serverName].env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(parse(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8')).mcp_servers).toMatchObject({ [BRAND_CONFIG.mcp.serverName]: { args: [app.runtime.entry, 'mcp', 'run', root, '--role', 'interactive'] } });
  } finally { await fs.rm(app.dir, { recursive: true, force: true }); await fs.rm(npm.dir, { recursive: true, force: true }); }
});

it('moves a workspace up to a newer runtime, and every config with it', async () => {
  const old = await installRuntime('old', '2.39.0');
  const app = await installRuntime('app', '2.42.0', true);
  try {
    await generateWorkspaceTools(root, ['claude', 'codex', 'copilot'], old.runtime);
    await generateWorkspaceTools(root, ['claude', 'codex', 'copilot'], app.runtime);
    expect(await fs.readFile(path.join(root, CLI_LAUNCHER), 'utf8')).toContain(slashes(app.runtime.entry));
    expect(await mcpEntry()).toBe(app.runtime.entry);
    expect(JSON.parse(await fs.readFile(path.join(root, '.vscode/mcp.json'), 'utf8')).servers[BRAND_CONFIG.mcp.serverName].args[0]).toBe(app.runtime.entry);
  } finally { await fs.rm(old.dir, { recursive: true, force: true }); await fs.rm(app.dir, { recursive: true, force: true }); }
});

it('pulls a config left on an older runtime up to the newest one the workspace has', async () => {
  const old = await installRuntime('old', '2.39.0');
  const app = await installRuntime('app', '2.42.0');
  try {
    await generateWorkspaceTools(root, ['claude'], app.runtime);
    await fs.mkdir(path.join(root, '.codex'));
    await fs.writeFile(path.join(root, '.codex/config.toml'), stringify({ mcp_servers: { [BRAND_CONFIG.mcp.serverName]: { command: process.execPath, args: [old.runtime.entry, 'mcp', 'run', root, '--role', 'interactive'] } } }));
    await generateWorkspaceTools(root, ['claude', 'codex'], old.runtime);
    const entered = (parse(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8')).mcp_servers as any)[BRAND_CONFIG.mcp.serverName].args[0];
    expect(entered).toBe(app.runtime.entry);
  } finally { await fs.rm(old.dir, { recursive: true, force: true }); await fs.rm(app.dir, { recursive: true, force: true }); }
});

it('ignores a newer runtime that is gone, and one whose version it cannot read', async () => {
  const gone = await installRuntime('gone', '2.50.0');
  const current = await installRuntime('current', '2.42.0');
  try {
    await generateWorkspaceTools(root, ['claude'], gone.runtime);
    await fs.rm(gone.dir, { recursive: true, force: true });
    await generateWorkspaceTools(root, ['claude'], current.runtime);
    expect(await mcpEntry()).toBe(current.runtime.entry);
    // An entry outside any package of ours has no version to compare, so it never wins.
    const bare = path.join(root, 'bare/dist/index.js');
    await fs.mkdir(path.dirname(bare), { recursive: true });
    await fs.writeFile(bare, '');
    await generateWorkspaceTools(root, ['claude'], { command: process.execPath, entry: bare });
    expect(await mcpEntry()).toBe(current.runtime.entry);
  } finally { await fs.rm(gone.dir, { recursive: true, force: true }); await fs.rm(current.dir, { recursive: true, force: true }); }
});

it('keeps writing the running runtime on the first refresh and when versions match', async () => {
  const a = await installRuntime('a', '2.42.0');
  const b = await installRuntime('b', '2.42.0');
  try {
    await generateWorkspaceTools(root, ['claude'], a.runtime);
    expect(await mcpEntry()).toBe(a.runtime.entry);
    await generateWorkspaceTools(root, ['claude'], b.runtime);
    expect(await mcpEntry()).toBe(b.runtime.entry);
  } finally { await fs.rm(a.dir, { recursive: true, force: true }); await fs.rm(b.dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('says what is wrong when the program the launcher points at is gone', async () => {
  const app = await installRuntime('app', '2.42.0');
  try {
    await generateWorkspaceTools(root, ['claude'], app.runtime);
    await fs.rm(app.dir, { recursive: true, force: true });
    const result = await execa(path.join(root, CLI_LAUNCHER), ['plan'], { reject: false });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("ContextSpace's program is missing");
    expect(result.stdout).toBe('');
  } finally { await fs.rm(app.dir, { recursive: true, force: true }); }
});

it('asks for a repair when a launcher or config points at a program that is gone or older, and not otherwise', async () => {
  const old = await installRuntime('old', '2.39.0');
  const app = await installRuntime('app', '2.42.0');
  const next = await installRuntime('next', '2.43.0');
  try {
    expect(await workspaceToolsNeedRepair(root, app.runtime)).toBe(false); // nothing configured yet
    await generateWorkspaceTools(root, ['claude', 'codex'], app.runtime);
    expect(await workspaceToolsNeedRepair(root, app.runtime)).toBe(false);
    expect(await workspaceToolsNeedRepair(root, old.runtime)).toBe(false); // an older program never repairs a newer workspace
    expect(await workspaceToolsNeedRepair(root, next.runtime)).toBe(true);
    await fs.rm(app.dir, { recursive: true, force: true });
    expect(await workspaceToolsNeedRepair(root, next.runtime)).toBe(true);
    expect(await workspaceToolsNeedRepair(root, app.runtime)).toBe(true);
  } finally { for (const r of [old, app, next]) await fs.rm(r.dir, { recursive: true, force: true }); }
});

/** A fake copy at an exact folder, so its path can look like the app's temporary unpack folder. */
async function installAt(dir: string, version: string) {
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: BRAND_CONFIG.mcp.packageName, version }));
  await fs.writeFile(path.join(dir, 'dist/index.js'), '');
  return { command: process.execPath, entry: path.join(dir, 'dist/index.js'), electron: true };
}

it('moves a workspace off the temporary unpack folder onto a lasting copy of the same version', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-lasting-'));
  try {
    const temporary = await installAt(path.join(parent, 'appimage_extracted_0123456789abcdef'), '2.42.0');
    const lasting = await installAt(path.join(parent, 'lasting'), '2.42.0');
    await generateWorkspaceTools(root, ['claude'], temporary);
    expect(await workspaceToolsNeedRepair(root, temporary)).toBe(false); // nothing better exists yet
    expect(await workspaceToolsNeedRepair(root, lasting)).toBe(true);
    await generateWorkspaceTools(root, ['claude'], lasting);
    expect(await mcpEntry()).toBe(lasting.entry);
    expect(await fs.readFile(path.join(root, CLI_LAUNCHER), 'utf8')).toContain(slashes(lasting.entry));
    expect(await workspaceToolsNeedRepair(root, lasting)).toBe(false);
    // The temporary copy running later (say, from an old launcher) does not move the workspace back.
    await generateWorkspaceTools(root, ['claude'], temporary);
    expect(await mcpEntry()).toBe(lasting.entry);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
