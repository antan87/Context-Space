/** Workspace-local access to the installed CLI, including desktop's bundled runtime. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify, type TomlTable } from 'smol-toml';
import type { AIAssistant } from '../types.js';
import { BRAND_CONFIG } from './constants.js';
import { assertNoLinkedPathComponents, atomicWriteFile } from '../resources/fs-safety.js';
import { isVersionAfter } from './versions.js';
import { installedLastingRuntime, isTemporaryRuntimePath, startedLastingRuntime } from './lasting-runtime.js';

export const CLI_LAUNCHER = '.contextspace/bin/ctxspace';
export const CLI_ALIAS_LAUNCHER = '.contextspace/bin/contextspace';
/** Claude Code permission rules for the plan command, from PATH and from the workspace's own copy. */
export const CLAUDE_PLAN_PERMISSIONS = ['Bash(ctxspace plan:*)', `Bash(./${CLI_LAUNCHER} plan:*)`];
export interface CliRuntime { command: string; entry: string; electron?: boolean }
export function currentCliRuntime(): CliRuntime {
  return { command: process.execPath, entry: fileURLToPath(new URL('../index.js', import.meta.url)), electron: Boolean(process.versions.electron) };
}

/**
 * The runtime to write into workspaces. A Linux AppImage unpacks to a temporary folder, so there it is the lasting
 * copy: the one just made, or one an earlier run left that is not older than this program.
 */
export async function runningCliRuntime(): Promise<CliRuntime> {
  const started = await startedLastingRuntime();
  if (started) return started;
  const own = currentCliRuntime();
  if (isTemporaryRuntimePath(own.entry)) {
    const installed = installedLastingRuntime();
    if (await runtimeExists(installed) && !isVersionAfter(await runtimeVersion(own.entry), await runtimeVersion(installed.entry))) return installed;
  }
  return own;
}

/** The version of the package an entry file ships in: the nearest package.json above it. */
export async function runtimeVersion(entry: string): Promise<string | undefined> {
  let dir = path.dirname(entry);
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      return manifest.name === BRAND_CONFIG.mcp.packageName ? manifest.version : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const SHELL_ARG = "'((?:[^']|'\\\\'')*)'";
const unquoteShell = (value: string) => value.replaceAll("'\\''", "'");

/** Every runtime this workspace's launcher and MCP configs already point at, as written by an earlier refresh. */
async function configuredRuntimes(root: string): Promise<CliRuntime[]> {
  const found: CliRuntime[] = [];
  const read = async (relative: string) => {
    try { return await fs.readFile(path.join(root, relative), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
  };
  const launcher = await read(CLI_LAUNCHER);
  const exec = launcher ? new RegExp(`^exec ${SHELL_ARG} ${SHELL_ARG} "\\$@"$`, 'm').exec(launcher) : null;
  const servers: unknown[] = [];
  for (const [relative, key] of [['.mcp.json', 'mcpServers'], ['.cursor/mcp.json', 'mcpServers'], ['.vscode/mcp.json', 'servers']]) {
    try { servers.push(JSON.parse((await read(relative)) ?? 'null')?.[key]?.[BRAND_CONFIG.mcp.serverName]); } catch { /* an unreadable config is rewritten below, or reported there */ }
  }
  try { servers.push((parse((await read('.codex/config.toml')) ?? '').mcp_servers as Record<string, unknown> | undefined)?.[BRAND_CONFIG.mcp.serverName]); } catch { /* same */ }
  for (const server of servers as Array<{ command?: unknown; args?: unknown; env?: { ELECTRON_RUN_AS_NODE?: unknown } } | undefined>) {
    if (typeof server?.command === 'string' && Array.isArray(server.args) && typeof server.args[0] === 'string' && server.args[1] === 'mcp') {
      found.push({ command: server.command, entry: server.args[0], electron: server.env?.ELECTRON_RUN_AS_NODE === '1' });
    }
  }
  // Last: the launcher writes paths with forward slashes, so on a tie the configs' own form wins and nothing churns.
  if (launcher && exec) found.push({ command: unquoteShell(exec[1]), entry: unquoteShell(exec[2]), electron: launcher.includes('ELECTRON_RUN_AS_NODE=1') });
  return found;
}

const runtimeExists = async (runtime: CliRuntime) => {
  try {
    await fs.access(runtime.entry);
    if (path.isAbsolute(runtime.command)) await fs.access(runtime.command);
    return true;
  } catch { return false; }
};

/**
 * The runtime a refresh writes: the one running it, unless the workspace already points at a newer one that is still
 * there (or at the same version outside the temporary unpack folder). An older program refreshing a workspace must not move its tools back — that is how a workspace kept
 * running 2.39 after the app moved to 2.42.
 */
export async function chooseCliRuntime(root: string, running: CliRuntime): Promise<CliRuntime> {
  let chosen = running;
  let chosenVersion = await runtimeVersion(running.entry);
  for (const candidate of await configuredRuntimes(root)) {
    if (!await runtimeExists(candidate)) continue;
    const version = await runtimeVersion(candidate.entry);
    // The same version outside the app's temporary unpack folder beats the copy in it: it outlasts a restart.
    const sameButLasting = version === chosenVersion && isTemporaryRuntimePath(chosen.entry) && !isTemporaryRuntimePath(candidate.entry);
    if (isVersionAfter(version, chosenVersion) || sameButLasting) { chosen = candidate; chosenVersion = version; }
  }
  return chosen;
}

/**
 * Whether the running program should rewrite this workspace's tools: some launcher or MCP config points at a program
 * that is no longer there, at an older version than this one, or into the app's temporary unpack folder when a lasting
 * copy exists.
 */
export async function workspaceToolsNeedRepair(root: string, running?: CliRuntime): Promise<boolean> {
  const target = await chooseCliRuntime(root, running ?? await runningCliRuntime());
  const targetVersion = await runtimeVersion(target.entry);
  for (const candidate of await configuredRuntimes(root)) {
    if (!await runtimeExists(candidate)) return true;
    if (isVersionAfter(targetVersion, await runtimeVersion(candidate.entry))) return true;
    if (isTemporaryRuntimePath(candidate.entry) && !isTemporaryRuntimePath(target.entry)) return true;
  }
  return false;
}

export async function generateWorkspaceTools(root: string, assistants: AIAssistant[], running?: CliRuntime): Promise<string[]> {
  const runtime = await chooseCliRuntime(root, running ?? await runningCliRuntime());
  const outputs: string[] = [];
  const marker = 'Generated by ContextSpace: workspace CLI';
  /** Writes a file; `commit: false` keeps it out of the returned list, which the workspace commits. */
  const write = async (relative: string, content: string, { commit = true } = {}) => {
    const target = path.join(root, relative);
    await assertNoLinkedPathComponents(root, target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    let existing: string | undefined;
    try { existing = await fs.readFile(target, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing !== content) await atomicWriteFile(target, content);
    if (commit) outputs.push(relative);
  };
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const cmdQuote = (value: string) => {
    if (/["\r\n]/.test(value)) throw new Error('The CLI runtime path cannot be represented in a Windows launcher.');
    return `"${value.replaceAll('%', '%%')}"`;
  };
  const gone = `ContextSpace's program is missing. Open the ContextSpace app to put it back, then try again.`;
  const shellLauncher = `#!/bin/sh\n# ${marker}\n[ -f ${shellQuote(runtime.entry.replaceAll('\\', '/'))} ] || { echo ${shellQuote(gone)} >&2; exit 127; }\n${runtime.electron ? 'export ELECTRON_RUN_AS_NODE=1\n' : ''}exec ${shellQuote(runtime.command.replaceAll('\\', '/'))} ${shellQuote(runtime.entry.replaceAll('\\', '/'))} "$@"\n`;
  const cmdLauncher = `@echo off\r\nrem ${marker}\r\nsetlocal DisableDelayedExpansion\r\nif not exist ${cmdQuote(runtime.entry)} (echo ${gone} 1>&2 & exit /b 127)\r\n${runtime.electron ? 'set "ELECTRON_RUN_AS_NODE=1"\r\n' : ''}${cmdQuote(runtime.command)} ${cmdQuote(runtime.entry)} %*\r\nexit /b %errorlevel%\r\n`;
  const launchers = [
    [CLI_LAUNCHER, shellLauncher],
    [`${CLI_LAUNCHER}.cmd`, cmdLauncher],
    [CLI_ALIAS_LAUNCHER, shellLauncher],
    [`${CLI_ALIAS_LAUNCHER}.cmd`, cmdLauncher],
  ];
  for (const [relative, content] of launchers) {
    await assertNoLinkedPathComponents(root, path.join(root, relative));
    try {
      if (!(await fs.readFile(path.join(root, relative), 'utf8')).includes(marker)) throw new Error(`Refusing to overwrite a custom launcher: ${relative}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await write(relative, content);
  }
  await fs.chmod(path.join(root, CLI_LAUNCHER), 0o755);
  await fs.chmod(path.join(root, CLI_ALIAS_LAUNCHER), 0o755);

  const server = { command: runtime.command, args: [runtime.entry, 'mcp', 'run', root, '--role', 'interactive'],
    ...(runtime.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}) };
  const configs: Array<[string, string]> = [];
  if (assistants.includes('claude') || assistants.includes('copilot')) configs.push(['.mcp.json', 'mcpServers']);
  if (assistants.includes('cursor')) configs.push(['.cursor/mcp.json', 'mcpServers']);
  if (assistants.includes('copilot')) configs.push(['.vscode/mcp.json', 'servers']);
  // Antigravity uses a user-level MCP configuration. Do not write its global config on refresh.
  for (const [relative, key] of configs) {
    await assertNoLinkedPathComponents(root, path.join(root, relative));
    let config: Record<string, any> = {};
    try { config = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!config || Array.isArray(config) || typeof config !== 'object' || (config[key] && (Array.isArray(config[key]) || typeof config[key] !== 'object'))) throw new Error(`Invalid MCP configuration: ${relative}`);
    config[key] = { ...config[key], [BRAND_CONFIG.mcp.serverName]: { ...(key === 'servers' ? { type: 'stdio' } : {}), ...server } };
    await write(relative, JSON.stringify(config, null, 2) + '\n');
  }
  // Remove only the exact Cursor server emitted unconditionally by older versions.
  // Leave custom entries and other servers alone when Cursor is not selected.
  if (!assistants.includes('cursor')) {
    const target = path.join(root, '.cursor/mcp.json');
    await assertNoLinkedPathComponents(root, target);
    let old: Record<string, any> | undefined;
    try { old = JSON.parse(await fs.readFile(target, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const prior = old?.mcpServers?.[BRAND_CONFIG.mcp.serverName];
    if (prior?.command === 'npx' && Object.keys(prior).length === 2 &&
        JSON.stringify(prior.args) === JSON.stringify(['-y', BRAND_CONFIG.mcp.packageName, 'mcp', 'run'])) {
      delete old!.mcpServers[BRAND_CONFIG.mcp.serverName];
      if (Object.keys(old!.mcpServers).length === 0) delete old!.mcpServers;
      if (Object.keys(old!).length === 0) await fs.unlink(target);
      else await atomicWriteFile(target, JSON.stringify(old, null, 2) + '\n');
    }
  }
  // Claude Code may run `ctxspace plan` without asking each time: it only changes the plan, as the AI.
  // The rules go in the local file, which is never committed: Claude Code applies allow rules from the
  // shared .claude/settings.json, or from a tracked local file, only after a person trusts the folder,
  // and never in `claude -p` or SDK runs.
  if (assistants.includes('claude')) {
    const relative = '.claude/settings.local.json';
    await assertNoLinkedPathComponents(root, path.join(root, relative));
    let config: Record<string, any> = {};
    try { config = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const permissions = config?.permissions ?? {};
    if (!config || Array.isArray(config) || typeof config !== 'object' || !permissions || Array.isArray(permissions) || typeof permissions !== 'object'
      || (permissions.allow !== undefined && !Array.isArray(permissions.allow))) throw new Error(`Invalid Claude settings: ${relative}`);
    const allow: unknown[] = permissions.allow ?? [];
    config.permissions = { ...permissions, allow: [...allow, ...CLAUDE_PLAN_PERMISSIONS.filter((rule) => !allow.includes(rule))] };
    await write(relative, JSON.stringify(config, null, 2) + '\n', { commit: false });
  }
  if (assistants.includes('codex')) {
    const relative = '.codex/config.toml';
    await assertNoLinkedPathComponents(root, path.join(root, relative));
    let config: TomlTable = {};
    try { config = parse(await fs.readFile(path.join(root, relative), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const existing = config.mcp_servers;
    if (existing && (typeof existing !== 'object' || Array.isArray(existing))) throw new Error('Invalid Codex mcp_servers table.');
    config.mcp_servers = { ...(existing as Record<string, any>), [BRAND_CONFIG.mcp.serverName]: server };
    await write(relative, stringify(config));
  }
  return outputs;
}
