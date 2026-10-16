/**
 * @module core/lasting-runtime
 * A copy of the CLI and MCP server that outlives the desktop app's temporary unpack folder.
 *
 * A Linux AppImage unpacks itself under /tmp (/tmp/appimage_extracted_<md5>, or /tmp/.mount_<random>), which
 * is wiped on restart. A workspace whose launcher and MCP configs point there has no AI tools until the app has run
 * again. Windows and macOS installs have stable paths, so only the AppImage needs this.
 *
 * The copy is the Electron binary and its libraries, which run the CLI as Node, plus the backend: dist, package.json
 * and node_modules. The platform-native agent binaries (~675 MB) and node-pty are left out: the CLI, `plan` and
 * `mcp run` do not use them, and the app runs its own full copy for agent sessions.
 *
 * Layout under ~/.local/share/contextspace/cli:
 *   <version>/runtime/   the Electron binary and libraries
 *   <version>/backend/   dist, package.json, node_modules
 *   current -> <version> what workspaces point at, so an app update moves every workspace at once
 *   bin/ctxspace         a launcher for `current`, for AI agents registered at user level (ctxspace mcp setup)
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliRuntime } from './workspace-tools.js';
import { isVersionAfter } from './versions.js';
import { getGeneratorVersion } from './analysis-cache.js';

const COMPLETE_MARKER = '.complete';
/** Newest versions kept: a running MCP server may still be reading the one before. */
const KEPT_VERSIONS = 2;
/** Files beside the Electron binary that it needs to start as Node. */
const RUNTIME_FILE = /\.(so(\.\d+)*|dat|bin)$/;
/** Native agent binaries, one package per platform, and the terminal addon: large, and not used by the CLI. */
const LEFT_OUT = [/(^|\/)node_modules\/@openai\/codex-(linux|darwin|win32)/, /(^|\/)node_modules\/@anthropic-ai\/claude-agent-sdk-(linux|darwin|win32)/, /(^|\/)node_modules\/node-pty(\/|$)/];

export interface LastingRuntimeOptions {
  /** The runtime running now, inside the unpack folder. */
  source: CliRuntime;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** The version being installed; this package's own by default. */
  version?: string;
}

export function lastingRuntimeRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'contextspace', 'cli');
}

/** The launcher AI agents are registered with at user level, once a lasting copy exists. */
export function lastingLauncherPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(lastingRuntimeRoot(env, home), 'bin', 'ctxspace');
}

/** Whether a runtime path is in an AppImage's unpack or mount folder, which does not survive a restart. */
export function isTemporaryRuntimePath(entry: string): boolean {
  return /(^|[\\/])(appimage_extracted_[0-9a-f]+|\.mount_[^\\/]+)[\\/]/.test(entry);
}

function runsFromAppImage({ source, env = process.env, platform = process.platform }: LastingRuntimeOptions): boolean {
  return platform === 'linux' && Boolean(env.APPIMAGE) && Boolean(env.APPDIR) && source.entry.startsWith(path.join(env.APPDIR!, path.sep));
}

/** The lasting runtime already installed, if any, as workspaces would point at it. */
export function installedLastingRuntime(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): CliRuntime {
  const current = path.join(lastingRuntimeRoot(env, home), 'current');
  return { command: path.join(current, 'runtime', 'contextspace-desktop'), entry: path.join(current, 'backend', 'dist', 'index.js'), electron: true };
}

const exists = (target: string) => fs.access(target).then(() => true, () => false);

async function copyRuntime(source: CliRuntime, target: string): Promise<void> {
  const runtimeSource = path.dirname(source.command);
  const backendSource = path.resolve(path.dirname(source.entry), '..');
  await fs.mkdir(path.join(target, 'runtime'), { recursive: true });
  for (const entry of await fs.readdir(runtimeSource, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === path.basename(source.command) || RUNTIME_FILE.test(entry.name))) {
      await fs.copyFile(path.join(runtimeSource, entry.name), path.join(target, 'runtime', entry.name));
    }
  }
  await fs.cp(backendSource, path.join(target, 'backend'), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (from) => !LEFT_OUT.some((pattern) => pattern.test(path.relative(backendSource, from).replaceAll('\\', '/'))),
  });
  await fs.chmod(path.join(target, 'runtime', path.basename(source.command)), 0o755);
}

async function installedVersions(root: string): Promise<string[]> {
  const names = await fs.readdir(root).catch(() => [] as string[]);
  return names.filter((name) => /^\d+\.\d+\.\d+/.test(name)).sort((a, b) => (isVersionAfter(a, b) ? -1 : isVersionAfter(b, a) ? 1 : 0));
}

/** A launcher that follows `current`, so it keeps working across app updates. */
async function writeLauncher(root: string): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const current = path.join(root, 'current');
  const script = `#!/bin/sh\n# Generated by ContextSpace: lasting CLI\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(path.join(current, 'runtime', 'contextspace-desktop'))} ${quote(path.join(current, 'backend', 'dist', 'index.js'))} "$@"\n`;
  const target = path.join(root, 'bin', 'ctxspace');
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await fs.readFile(target, 'utf8').catch(() => undefined) === script) return;
  const staging = `${target}.tmp-${process.pid}`;
  await fs.writeFile(staging, script, { mode: 0o755 });
  await fs.rename(staging, target);
}

async function pointCurrentAt(root: string, version: string): Promise<void> {
  const link = path.join(root, `.current-${process.pid}`);
  await fs.rm(link, { force: true });
  await fs.symlink(version, link);
  await fs.rename(link, path.join(root, 'current'));
}

/**
 * Copies the running runtime to a lasting place and points `current` at it. Does nothing, and returns null, unless
 * this is an AppImage on Linux. Never points `current` at an older version than the one it already points at.
 *
 * @returns The runtime workspaces should point at, or null when the running one is already lasting.
 */
export async function ensureLastingRuntime(options: LastingRuntimeOptions): Promise<CliRuntime | null> {
  if (!runsFromAppImage(options)) return null;
  const { source, env = process.env } = options;
  const root = lastingRuntimeRoot(env, options.home);
  const version = options.version ?? getGeneratorVersion();
  const installed = installedLastingRuntime(env, options.home);

  // Rebuilding an AppImage without bumping its version must still replace the copy.
  const appImage = await fs.stat(env.APPIMAGE!).catch(() => undefined);
  const stamp = appImage ? `${appImage.size}:${Math.trunc(appImage.mtimeMs)}` : 'unknown';
  const target = path.join(root, version);
  const marker = path.join(target, COMPLETE_MARKER);
  const current = await fs.readFile(marker, 'utf8').catch(() => undefined);

  if (current !== stamp || !(await exists(path.join(target, 'backend', 'dist', 'index.js')))) {
    await fs.mkdir(root, { recursive: true });
    const staging = path.join(root, `.staging-${process.pid}-${Date.now()}`);
    try {
      await copyRuntime(source, staging);
      await fs.writeFile(path.join(staging, COMPLETE_MARKER), stamp);
      const replaced = `${staging}-replaced`;
      if (await exists(target)) await fs.rename(target, replaced);
      await fs.rename(staging, target);
      await fs.rm(replaced, { recursive: true, force: true });
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  const [newest] = await installedVersions(root);
  if (newest && isVersionAfter(newest, version) && await exists(installed.entry)) {
    // A newer copy is already current: an older app does not move workspaces back.
    await writeLauncher(root);
    return installed;
  }
  await pointCurrentAt(root, version);
  await writeLauncher(root);
  for (const old of (await installedVersions(root)).slice(KEPT_VERSIONS)) {
    await fs.rm(path.join(root, old), { recursive: true, force: true }).catch(() => {});
  }
  return installed;
}

let started: Promise<CliRuntime | null> | undefined;

/** Starts the copy in the background, once. A failure is reported and leaves the temporary runtime in use. */
export function startLastingRuntime(options: LastingRuntimeOptions): Promise<CliRuntime | null> {
  started ??= ensureLastingRuntime(options).catch((error: unknown) => {
    console.warn(`Could not keep a lasting copy of the CLI: ${(error as Error).message}`);
    return null;
  });
  return started;
}

/** The lasting runtime once the background copy has finished, or null when it was not started or did not apply. */
export async function startedLastingRuntime(): Promise<CliRuntime | null> {
  return started ? await started : null;
}
