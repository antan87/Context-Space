/**
 * @module core/agent-mcp
 * Makes the ContextSpace MCP server available to the AI agents the user runs.
 *
 * One unbound server is registered per agent, at user level. It finds the
 * workspace from the agent's working directory, so it works in every workspace
 * with no per-workspace config. Per-workspace configs embed the running app's
 * path, which for a desktop install is a temporary extraction that changes or
 * disappears, and some agents hold a project-level server until it is approved.
 *
 * An existing entry is never replaced. Codex and Antigravity overwrite a
 * same-named server silently, so registration is only attempted when none of the
 * known server names is present.
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { parse as parseToml } from 'smol-toml';

import { BRAND_CONFIG, CLI_NAME, ENGINE_NPM_PACKAGE } from './constants.js';
import { lastingLauncherPath } from './lasting-runtime.js';
import { HARNESSES, type McpHarnessId } from '../harnesses/registry.js';
import { atomicWriteJson } from '../resources/fs-safety.js';
import { findExecutable, getAugmentedPath } from '../utils/user-paths.js';

/** The harnesses with `mcp: true` in the registry. TARGETS below has exactly one target for each. */
export type McpAgentId = McpHarnessId;

export interface McpServerDefinition {
  command: string;
  args: string[];
}

/**
 * Shared by every registration; matches what `ctxspace mcp setup` writes for editors.
 *
 * Once the app has kept a lasting copy of the CLI (Linux AppImage), that is what is registered: the app's own
 * version, and it survives a restart. Otherwise it falls back to npx. npm publishing is deprecated, so npx only
 * ever reaches the last package published (2.39), and the package must carry `@latest` or npx keeps running whatever
 * copy is already in its cache. Where there is no lasting copy yet, that is the best this machine can do.
 */
export function unboundMcpServer(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): McpServerDefinition {
  const launcher = lastingLauncherPath(env, home);
  if (existsSync(launcher)) return { command: launcher, args: ['mcp', 'run', '--role', 'interactive'] };
  return { command: 'npx', args: ['-y', `${ENGINE_NPM_PACKAGE}@latest`, 'mcp', 'run', '--role', 'interactive'] };
}

/**
 * What an AI agent is registered with. On Windows `npx` is really `npx.cmd`, a batch shim, and the
 * agents start the server directly rather than through a shell, so a bare `npx` never connects.
 * `cmd /c` runs the shim the way a prompt would; it is the form Claude Code, Codex and Antigravity
 * document for Windows. Elsewhere this is exactly `unboundMcpServer()`.
 *
 * Only agent registration uses this. `unboundMcpServer()` stays as it was for the editor configs
 * `ctxspace mcp setup` writes, so what they get on Windows is unchanged.
 */
export function agentMcpServer(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): McpServerDefinition {
  const server = unboundMcpServer(env, home);
  return platform === 'win32' && server.command === 'npx' ? { command: 'cmd', args: ['/c', server.command, ...server.args] } : server;
}

/** The name new registrations use. */
export const MCP_REGISTRATION_NAME = BRAND_CONFIG.mcp.serverName;

/** Any of these means the server is already available, whoever registered it. */
const KNOWN_SERVER_NAMES: readonly string[] = [
  BRAND_CONFIG.mcp.serverName,
  BRAND_CONFIG.mcp.legacyServerName,
  BRAND_CONFIG.mcp.adapterServerName,
  BRAND_CONFIG.mcp.legacyAdapterServerName,
];

export type AgentMcpState =
  | { state: 'not-installed' }
  /** `stale`: it runs the npm package, which stopped at 2.39, while a lasting copy of the app's version exists. */
  | { state: 'registered'; serverName: string; stale?: string }
  | { state: 'missing' }
  /** Installed, but it cannot use MCP servers until `reason` is resolved. */
  | { state: 'unsupported'; reason: string }
  /** A config file exists but could not be read; it is left alone. */
  | { state: 'unreadable'; reason: string };

export interface AgentMcpStatus {
  id: McpAgentId;
  name: string;
  /** The config file inspected, for messages. */
  configPath: string;
  status: AgentMcpState;
}

export type AgentMcpOutcome =
  | { result: 'not-installed' }
  | { result: 'added'; how: string }
  | { result: 'already'; serverName: string; stale?: string }
  | { result: 'would-add'; how: string }
  | { result: 'skipped'; reason: string }
  | { result: 'failed'; reason: string };

export interface AgentMcpResult {
  id: McpAgentId;
  name: string;
  outcome: AgentMcpOutcome;
}

export interface CommandOutcome {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CommandOutcome>;

export interface AgentMcpOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Runs an agent CLI. Replaced in tests. */
  run?: CommandRunner;
  /** Report what would change without changing anything. */
  dryRun?: boolean;
  /** Finds an agent's executable. Replaced in tests, which cannot fake another platform's PATH rules. */
  findBinary?: (name: string) => string | null;
}

const defaultRunner: CommandRunner = async (file, args, env) => {
  const result = await execa(file, args, { env, extendEnv: false, reject: false, timeout: 30_000, stdin: 'ignore' });
  return { exitCode: result.exitCode, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
};

interface Context {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  run: CommandRunner;
  find: (name: string) => string | null;
}

function contextOf(options: AgentMcpOptions): Context {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  // A desktop app often starts with a narrower PATH than the user's shell.
  const searchEnv = { ...env, PATH: getAugmentedPath(env, platform, home) };
  return {
    env: searchEnv,
    home,
    platform,
    run: options.run ?? defaultRunner,
    find: options.findBinary ?? ((name) => findExecutable(name, searchEnv, platform)),
  };
}

interface AgentTarget {
  id: McpAgentId;
  name: string;
  binary: string;
  configPath(ctx: Context): string;
  /** Server names present in the agent's user-level config. Throws when the file is unreadable. */
  readServers(ctx: Context): Promise<string[]>;
  /** A reason this agent cannot use MCP servers even once registered, or null. */
  unsupported?(ctx: Context): Promise<string | null>;
  /** What a named server is set to run, when the config says. Used to spot a registration that runs the npm package. */
  readDefinition?(ctx: Context, name: string): Promise<{ command?: unknown; args?: unknown } | undefined>;
  register(ctx: Context, binaryPath: string, definition: McpServerDefinition): Promise<{ how: string }>;
  /** What registering would do, for a dry run. Defaults to the agent's own `mcp add`. */
  plan?(ctx: Context): string;
}

async function readJsonServers(file: string, keys: readonly string[]): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!raw.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
  for (const key of keys) {
    const servers = (parsed as Record<string, unknown>)[key];
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) return Object.keys(servers);
  }
  return [];
}

async function readJsonDefinition(file: string, name: string): Promise<{ command?: unknown; args?: unknown } | undefined> {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
  return parsed?.mcpServers?.[name];
}

async function runAdd(ctx: Context, binaryPath: string, args: string[], label: string): Promise<{ how: string }> {
  const outcome = await ctx.run(binaryPath, args, ctx.env);
  if (outcome.exitCode !== 0) {
    const detail = (outcome.stderr || outcome.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' ');
    throw new Error(`${label} exited with code ${outcome.exitCode ?? 'unknown'}${detail ? `: ${detail}` : ''}`);
  }
  return { how: label };
}

const TARGETS: readonly AgentTarget[] = [
  {
    id: 'claude',
    name: HARNESSES.claude.name,
    binary: HARNESSES.claude.binary,
    configPath: (ctx) => ctx.env.CLAUDE_CONFIG_DIR
      ? path.join(ctx.env.CLAUDE_CONFIG_DIR, '.claude.json')
      : path.join(ctx.home, '.claude.json'),
    readServers(ctx) { return readJsonServers(this.configPath(ctx), ['mcpServers']); },
    readDefinition(ctx, name) { return readJsonDefinition(this.configPath(ctx), name); },
    register: (ctx, bin, def) => runAdd(
      ctx, bin, ['mcp', 'add', '--scope', 'user', MCP_REGISTRATION_NAME, '--', def.command, ...def.args], 'claude mcp add',
    ),
  },
  {
    id: 'codex',
    name: HARNESSES.codex.name,
    binary: HARNESSES.codex.binary,
    configPath: (ctx) => path.join(ctx.env.CODEX_HOME || path.join(ctx.home, '.codex'), 'config.toml'),
    async readServers(ctx) {
      let raw: string;
      try {
        raw = await fs.readFile(this.configPath(ctx), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const servers = parseToml(raw).mcp_servers;
      return servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
    },
    async readDefinition(ctx, name) {
      const servers = parseToml(await fs.readFile(this.configPath(ctx), 'utf8')).mcp_servers as Record<string, { command?: unknown; args?: unknown }> | undefined;
      return servers?.[name];
    },
    register: (ctx, bin, def) => runAdd(
      ctx, bin, ['mcp', 'add', MCP_REGISTRATION_NAME, '--', def.command, ...def.args], 'codex mcp add',
    ),
  },
  {
    id: 'antigravity',
    name: HARNESSES.antigravity.name,
    binary: HARNESSES.antigravity.binary,
    configPath: (ctx) => path.join(ctx.home, '.gemini', 'config', 'mcp_config.json'),
    readServers(ctx) { return readJsonServers(this.configPath(ctx), ['mcpServers']); },
    readDefinition(ctx, name) { return readJsonDefinition(this.configPath(ctx), name); },
    register: (ctx, bin, def) => runAdd(
      ctx, bin, ['mcp', 'add', MCP_REGISTRATION_NAME, '--', def.command, ...def.args], 'agy mcp add',
    ),
  },
  {
    // Pi has no MCP of its own; the pi-mcp-adapter package adds it and reads this shared file.
    id: 'pi',
    name: HARNESSES.pi.name,
    binary: HARNESSES.pi.binary,
    configPath: (ctx) => path.join(ctx.home, '.config', 'mcp', 'mcp.json'),
    plan(ctx) { return `write ${this.configPath(ctx)}`; },
    async readServers(ctx) {
      // The adapter also reads these tool-agnostic locations.
      const files = [
        this.configPath(ctx),
        path.join(ctx.home, '.agents', 'mcp.json'),
        path.join(ctx.home, '.agents', 'mcp', 'mcp.json'),
      ];
      return (await Promise.all(files.map((file) => readJsonServers(file, ['mcpServers'])))).flat();
    },
    async unsupported(ctx) {
      const settings = path.join(ctx.env.PI_CODING_AGENT_DIR || path.join(ctx.home, '.pi', 'agent'), 'settings.json');
      try {
        const parsed = JSON.parse(await fs.readFile(settings, 'utf8')) as { packages?: unknown };
        const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
        if (packages.some((entry) => typeof entry === 'string' && entry.includes('pi-mcp-adapter'))) return null;
      } catch {
        // No readable settings: treat the adapter as absent.
      }
      return 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter';
    },
    async register(ctx, _bin, def) {
      const file = this.configPath(ctx);
      let config: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
        config = parsed as Record<string, unknown>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const existing = config.mcpServers;
      if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
        throw new Error('"mcpServers" is not an object');
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteJson(file, {
        ...config,
        mcpServers: { ...(existing as Record<string, unknown> | undefined), [MCP_REGISTRATION_NAME]: { command: def.command, args: def.args } },
      });
      return { how: `wrote ${file}` };
    },
  },
];

/** A registration that runs the npm package, when the app's own lasting copy could be registered instead. */
async function staleRegistration(target: AgentTarget, ctx: Context, name: string): Promise<{ stale?: string }> {
  if (unboundMcpServer(ctx.env, ctx.home).command === 'npx') return {};
  try {
    const definition = await target.readDefinition?.(ctx, name);
    const line = [definition?.command, ...(Array.isArray(definition?.args) ? definition.args : [])].join(' ');
    if (/\bnpx\b/.test(line) && line.includes(ENGINE_NPM_PACKAGE)) {
      return { stale: `"${name}" runs the npm package, which stopped at 2.39. Remove it from ${target.configPath(ctx)}, then run ${CLI_NAME} mcp setup again to use this app's version.` };
    }
  } catch { /* an unreadable definition is not a reason to warn */ }
  return {};
}

async function inspectTarget(target: AgentTarget, ctx: Context): Promise<AgentMcpStatus> {
  const base = { id: target.id, name: target.name, configPath: target.configPath(ctx) };
  if (!ctx.find(target.binary)) return { ...base, status: { state: 'not-installed' } };

  const reason = await target.unsupported?.(ctx);
  if (reason) return { ...base, status: { state: 'unsupported', reason } };

  let servers: string[];
  try {
    servers = await target.readServers(ctx);
  } catch (error) {
    return { ...base, status: { state: 'unreadable', reason: `${base.configPath}: ${(error as Error).message}` } };
  }
  const present = KNOWN_SERVER_NAMES.find((name) => servers.includes(name));
  if (present) return { ...base, status: { state: 'registered', serverName: present, ...(await staleRegistration(target, ctx, present)) } };
  // On Windows the registration goes through `cmd /c` (see agentMcpServer). It has been checked against
  // the agents' config files, not yet against a live connection on Windows, so setup says how to confirm it.
  return { ...base, status: { state: 'missing' } };
}

/** Whether each supported agent is installed and has the server. Reads config files only. */
export async function inspectAgentMcp(options: AgentMcpOptions = {}): Promise<AgentMcpStatus[]> {
  const ctx = contextOf(options);
  return Promise.all(TARGETS.map((target) => inspectTarget(target, ctx)));
}

/**
 * Registers the server with every installed agent that lacks it. An agent that
 * already has it, cannot use it yet, or has an unreadable config is left alone.
 */
export async function registerAgentMcp(options: AgentMcpOptions = {}): Promise<AgentMcpResult[]> {
  const ctx = contextOf(options);
  const definition = agentMcpServer(ctx.platform, ctx.env, ctx.home);
  const results: AgentMcpResult[] = [];

  for (const target of TARGETS) {
    const { status } = await inspectTarget(target, ctx);
    const done = (outcome: AgentMcpOutcome) => results.push({ id: target.id, name: target.name, outcome });

    switch (status.state) {
      case 'not-installed': done({ result: 'not-installed' }); continue;
      case 'registered': done({ result: 'already', serverName: status.serverName, ...(status.stale ? { stale: status.stale } : {}) }); continue;
      case 'unsupported': done({ result: 'skipped', reason: status.reason }); continue;
      case 'unreadable': done({ result: 'skipped', reason: `left alone, could not read ${status.reason}` }); continue;
      case 'missing': break;
    }

    const binaryPath = ctx.find(target.binary)!;
    if (options.dryRun) {
      done({ result: 'would-add', how: target.plan?.(ctx) ?? `${target.binary} mcp add` });
      continue;
    }
    try {
      const { how } = await target.register(ctx, binaryPath, definition);
      // Trust the config, not the exit code: a CLI can report success and change nothing.
      const after = await inspectTarget(target, ctx);
      if (after.status.state === 'registered') done({ result: 'added', how });
      else done({ result: 'failed', reason: `${how} finished but ${target.name} still does not list the server` });
    } catch (error) {
      done({ result: 'failed', reason: (error as Error).message });
    }
  }
  return results;
}
