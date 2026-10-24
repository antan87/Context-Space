/**
 * @module orchestration/runner
 * Manages the lifecycle of services — start, stop, status, and log streaming.
 * Uses PM2 for process management.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import { execa } from 'execa';

import type { ServiceConfig, RunningService, RunningState, ServiceFailure, ServiceStartResult } from '../types.js';
import { BRAND_CONFIG, getPm2ProcessPrefix } from '../core/constants.js';
import { findExecutable } from '../utils/user-paths.js';
import { isLocalPortListening } from '../utils/ports.js';
import { toErrorMessage, getErrorCode } from '../utils/errors.js';

/** PM2 process environment returned by `pm2 jlist`. */
export interface Pm2Env {
  status?: string;
  pm_uptime?: number;
  [key: string]: unknown;
}

/** PM2 process entry returned by `pm2 jlist`. */
export interface Pm2Process {
  name?: string;
  pid?: number;
  pm_id?: number;
  pm2_env?: Pm2Env;
  [key: string]: unknown;
}

/** Name of the state file that tracks running services. */
const PRIMARY_STATE_FILE = BRAND_CONFIG.files.runningState.primary;
const LEGACY_STATE_FILE = BRAND_CONFIG.files.runningState.legacy;

/**
 * Returns the path to the running-state file for a workspace.
 */
function getStatePath(workspacePath: string): string {
  return path.join(workspacePath, PRIMARY_STATE_FILE);
}

/** Stable, collision-free 8-char hash of the absolute workspace path. */
export function workspaceHash(workspacePath: string): string {
  return createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 8);
}

/** Workspace PM2 prefix embedding the workspace hash to eliminate prefix over-matching. */
export function pm2Prefix(workspacePath: string): string {
  return getPm2ProcessPrefix(workspacePath);
}

/** PM2 app name for a workspace service: `${prefix}${name}`. */
export function pm2AppName(workspacePath: string, serviceName: string): string {
  return `${pm2Prefix(workspacePath)}${serviceName}`;
}

/**
 * Log file for a service. Service names may contain '/' (nested packages,
 * e.g. `repo/sub`), which maps to a nested path under the log dir.
 */
export function serviceLogFile(logDir: string, serviceName: string): string {
  return path.join(logDir, `${serviceName}.log`);
}

/**
 * Launches a command under PM2 using the shared NexusFlow launch shape: delete
 * any same-named app first (idempotent restart), then start it with stdout and
 * stderr wired to a single log file and no interpreter (run the binary
 * directly). Shared by service and orchestrator starts so their logging and
 * restart behavior can never drift apart.
 */
export async function pm2Start(opts: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  logFile: string;
  /** Extra environment for this process; PM2 gives an app the environment it was started with. */
  env?: Record<string, string>;
}): Promise<void> {
  await execa('npx', ['pm2', 'delete', opts.name], { reject: false });
  await execa('npx', [
    'pm2',
    'start',
    opts.command,
    '--name',
    opts.name,
    '--cwd',
    opts.cwd,
    '-o',
    opts.logFile,
    '-e',
    opts.logFile,
    '--interpreter',
    'none',
    '--',
    ...opts.args,
  ], opts.env ? { env: opts.env } : undefined);
}

/**
 * Parses `pm2 jlist` output defensively. npx/pm2 can emit preamble lines before
 * the JSON array, which would make a bare JSON.parse throw and silently drop us
 * to stale cached state.
 */
export function parsePm2Json(stdout: string): Pm2Process[] {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed as Pm2Process[];
  } catch {}
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed as Pm2Process[];
    } catch {}
  }
  return [];
}

/**
 * Runs `pm2 jlist` once and returns the parsed process list, or null when PM2
 * could not be read, so callers can tell "nothing runs" from "unknown".
 * Callers iterating many workspaces should fetch this once and pass it into
 * {@link loadRunningState} to avoid spawning npx per workspace.
 */
export async function readPm2List(): Promise<Pm2Process[] | null> {
  try {
    const { stdout } = await execa('npx', ['pm2', 'jlist']);
    const list = parsePm2Json(stdout);
    return list.length > 0 || /\[\s*\]/.test(stdout) ? list : null;
  } catch {
    return null;
  }
}

/** {@link readPm2List}, treating an unreadable list as empty. */
export async function getPm2List(): Promise<Pm2Process[]> {
  return (await readPm2List()) ?? [];
}

/**
 * Reads the raw on-disk running state without reconciling it against PM2.
 * Callers that need the full recorded set — e.g. the stop path, which must
 * still tear down a crashed orchestrator that {@link loadRunningState} hides —
 * use this instead of the reconciled view.
 *
 * @param workspacePath - Workspace root path.
 */
export async function readRawRunningState(workspacePath: string): Promise<RunningState | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspacePath, PRIMARY_STATE_FILE), 'utf-8')) as RunningState;
  } catch {
    try {
      return JSON.parse(await fs.readFile(path.join(workspacePath, LEGACY_STATE_FILE), 'utf-8')) as RunningState;
    } catch {
      return null;
    }
  }
}

/**
 * Loads the running state from disk, syncing active status with PM2. Services
 * and pm2-mode orchestrators are verified against the live PM2 process list and
 * dropped when no longer online (crashed or stopped outside NexusFlow), so the
 * Services tab and dashboard count never show a phantom-running process.
 * One-shot tools (docker compose up -d) have no PM2 app or PID to verify; they
 * are passed through and cleared on explicit stop.
 *
 * @param workspacePath - Workspace root path.
 * @param pm2List - Optional pre-fetched `pm2 jlist` output (see {@link getPm2List}).
 */
export async function loadRunningState(workspacePath: string, pm2List?: Pm2Process[] | null): Promise<RunningState | null> {
  const state = await readRawRunningState(workspacePath);
  if (!state) return null;
  // Recorded failures and one-shot tools have nothing for PM2 to confirm.
  if (state.services.length === 0 && !(state.orchestrators ?? []).some((o) => o.mode === 'pm2' && o.pm2Name)) return state;

  try {
    // Query current PM2 process list to verify actual running status. When it
    // cannot be read, show what was recorded rather than declaring it stopped.
    const list = pm2List === undefined ? await readPm2List() : pm2List;
    if (!list) return state;
    const isOnline = (name: string): boolean => {
      const app = list.find((a) => a.name === name);
      return !!app && app.pm2_env?.status === 'online';
    };

    // A recorded service that is no longer online stopped without being asked
    // to; say so beside it instead of silently dropping it from the list.
    const checked = await Promise.all(state.services.map(async (service) => {
      const uniqueName = pm2AppName(workspacePath, service.name);
      const pm2App = list.find((app) => app.name === uniqueName);
      const running = pm2App && pm2App.pm2_env?.status === 'online';
      if (running) return { service: { ...service, pid: pm2App.pid || service.pid } };
      const status = pm2App?.pm2_env?.status;
      const output = status && service.logFile ? await lastLogLine(service.logFile) : undefined;
      const failure: ServiceFailure = {
        name: service.name,
        reason: status
          ? `Stopped unexpectedly (PM2 status: ${status}).${output ? ` Last output: "${output}".` : ' Its log shows why.'} Start it again when fixed.`
          : 'Stopped outside ContextSpace; no PM2 process remains. Start it again if you still need it.',
        at: new Date().toISOString(),
      };
      return { failure };
    }));
    const activeServices = checked.flatMap((entry) => (entry.service ? [entry.service] : []));
    const stoppedUnexpectedly = checked.flatMap((entry) => (entry.failure ? [entry.failure] : []));
    if (stoppedUnexpectedly.length > 0) {
      // Record each unexpected stop once: later reads then neither re-read its
      // log nor restamp it. Only the run seen here is moved, not a newer start.
      const seen = new Map(state.services.map((s) => [s.name, s.startedAt]));
      const gone = new Set(stoppedUnexpectedly.map((f) => f.name));
      await mutateRunningState(workspacePath, (current) => {
        const moved = new Set(current.services.filter((s) => gone.has(s.name) && seen.get(s.name) === s.startedAt).map((s) => s.name));
        return {
          ...current,
          services: current.services.filter((s) => !moved.has(s.name)),
          failures: [...(current.failures ?? []).filter((f) => !moved.has(f.name)), ...stoppedUnexpectedly.filter((f) => moved.has(f.name))],
        };
      });
    }

    const orchestrators = state.orchestrators?.filter(
      (o) => o.mode !== 'pm2' || !o.pm2Name || isOnline(o.pm2Name),
    );

    const recorded = (state.failures ?? []).filter((f) => !stoppedUnexpectedly.some((u) => u.name === f.name));
    return {
      ...state,
      services: activeServices,
      orchestrators,
      failures: [...recorded, ...stoppedUnexpectedly],
      updatedAt: new Date().toISOString(),
    };
  } catch {
    // Fallback to cached state on disk if PM2 query fails.
    return state;
  }
}

// ─── State mutation (serialized per workspace) ────────────────────────────────

/** Per-workspace promise chains so concurrent mutations never lose writes. */
const stateQueues = new Map<string, Promise<void>>();

/**
 * Applies a read-modify-write mutation to the raw on-disk running state,
 * serialized per workspace. The mutator receives the current state (a fresh
 * empty one when no file exists) and returns the state to persist; when both
 * services and orchestrators end up empty, the file is removed instead.
 */
export async function mutateRunningState(
  workspacePath: string,
  mutator: (state: RunningState) => RunningState,
): Promise<void> {
  const previous = stateQueues.get(workspacePath) ?? Promise.resolve();
  const next = previous.then(async () => {
    let state: RunningState;
    try {
      state = JSON.parse(await fs.readFile(getStatePath(workspacePath), 'utf-8')) as RunningState;
    } catch {
      state = { workspacePath, services: [], updatedAt: new Date().toISOString() };
    }

    const updated = mutator(state);
    updated.updatedAt = new Date().toISOString();

    if (updated.services.length === 0 && (updated.orchestrators?.length ?? 0) === 0 && (updated.failures?.length ?? 0) === 0) {
      await fs.unlink(getStatePath(workspacePath)).catch(() => {});
      return;
    }
    await fs.writeFile(getStatePath(workspacePath), JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  });
  // Keep the chain alive even when a link fails.
  stateQueues.set(workspacePath, next.catch(() => {}));
  return next;
}

// ─── Per-service lifecycle ────────────────────────────────────────────────────

/** Words that run the next word as the program. */
const COMMAND_PREFIXES = new Set(['exec', 'env', 'nohup', 'time']);
/** Shell words that are not programs; a line starting with one is not checked. */
const SHELL_BUILTINS = new Set(['cd', '.', 'source', 'export', 'set', 'test', '[', 'eval', 'if', 'for', 'while']);

/**
 * The program a service runs: its command, or for a Procfile line the first
 * word after `NAME=value` assignments and prefixes such as `exec`. Undefined
 * when the line starts with a shell builtin, which has nothing to find on PATH.
 */
export function serviceExecutable(service: ServiceConfig): string | undefined {
  if (service.source !== 'procfile') return service.command;
  let afterPrefix = false;
  for (const token of (service.display ?? '').trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const word = token.replace(/^['"]|['"]$/g, '');
    if (COMMAND_PREFIXES.has(word)) { afterPrefix = true; continue; }
    if (afterPrefix && word.startsWith('-')) continue;
    // The shell expands `$VAR` and `~`; we cannot know the result, so do not guess.
    if (!word || SHELL_BUILTINS.has(word) || word.includes('$') || word.startsWith('~')) return undefined;
    return word;
  }
  return undefined;
}

const where = (service: ServiceConfig) =>
  service.declaredIn ? ` in ${service.declaredIn.file} line ${service.declaredIn.line}` : '';

/**
 * Checks what would make a start fail before PM2 is involved: a program that
 * is not installed, or a port another process already holds. Returns the
 * reason to show beside the service, or null when it can start.
 */
export async function preflightService(service: ServiceConfig, opts: { checkPort?: boolean } = {}): Promise<string | null> {
  const executable = serviceExecutable(service);
  if (executable) {
    const found = /[\\/]/.test(executable)
      ? await fs.access(path.resolve(service.cwd, executable)).then(() => true, () => false)
      : !!findExecutable(executable, process.env);
    if (!found) return `"${executable}" was not found${/[\\/]/.test(executable) ? ` in ${service.cwd}` : ' on PATH'}. Install it, or change the command${where(service)}.`;
  }
  if (opts.checkPort !== false && service.port && await isLocalPortListening(service.port)) {
    return `Port ${service.port} is already in use by another process. Stop that process, or change the port${where(service)}.`;
  }
  return null;
}

/** The last non-empty line a service wrote, to explain a failed start. */
async function lastLogLine(logFile: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(logFile, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 2048);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf-8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 300);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Records why a service did not start, replacing its previous failure. */
async function recordFailure(workspacePath: string, name: string, reason: string): Promise<void> {
  await mutateRunningState(workspacePath, (state) => ({
    ...state,
    failures: [...(state.failures ?? []).filter((f) => f.name !== name), { name, reason, at: new Date().toISOString() }],
  }));
}

/** Records a service found online under PM2 as running, without restarting it. */
async function alreadyRunning(service: ServiceConfig, workspacePath: string, logFile: string, pid: number): Promise<ServiceStartResult> {
  await mutateRunningState(workspacePath, (state) => ({
    ...state,
    services: state.services.some((s) => s.name === service.name)
      ? state.services
      : [...state.services, { name: service.name, pid, config: service, startedAt: new Date().toISOString(), logFile }],
    failures: (state.failures ?? []).filter((f) => f.name !== service.name),
  }));
  console.log(chalk.dim(`  ${service.name} is already running (PID: ${pid}).`));
  return { name: service.name, status: 'running', pid };
}

/**
 * Starts ONE service under PM2 (deleting any same-named app first), resolves
 * its PID, and upserts it into the running state. A service that cannot start
 * (missing program, occupied port, no running PM2 process) is not started or
 * recorded as running; its reason is recorded beside it instead.
 *
 * @param opts.restart - The service may be running; skip the port check, since
 *   it would find the service's own port in use.
 */
export async function startService(
  service: ServiceConfig,
  workspacePath: string,
  logDir: string,
  opts: { restart?: boolean } = {},
): Promise<ServiceStartResult> {
  const logFile = serviceLogFile(logDir, service.name);
  const uniqueName = pm2AppName(workspacePath, service.name);
  const portStr = service.port ? ` on port ${service.port}` : '';
  const failed = async (reason: string): Promise<ServiceStartResult> => {
    console.error(chalk.red(`  ✖ ${service.name}: ${reason}`));
    await recordFailure(workspacePath, service.name, reason);
    return { name: service.name, status: 'failed', reason };
  };

  const problem = await preflightService(service, { checkPort: !opts.restart });
  if (problem) {
    // The port may be held by this service itself, already running: that is not a failure.
    const own = service.port && !opts.restart
      ? (await getPm2List()).find((app) => app.name === uniqueName && app.pm2_env?.status === 'online')
      : undefined;
    if (own?.pid) return alreadyRunning(service, workspacePath, logFile, own.pid);
    return failed(problem);
  }

  console.log(chalk.cyan(`  Starting ${chalk.bold(service.name)}${portStr} under PM2...`));
  console.log(chalk.dim(`    ${service.display ?? `${service.command} ${service.args.join(' ')}`} (in ${service.cwd})`));

  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });

    // Start under PM2 (pre-deletes any same-named app), wiring stdout+stderr to
    // the service log via the shared launch shape.
    await pm2Start({
      name: uniqueName,
      command: service.command,
      args: service.args,
      cwd: service.cwd,
      logFile,
      env: service.env,
    });

    // Retrieve the real PID from PM2
    const pm2List = await getPm2List();
    const pm2App = pm2List.find((app) => app.name === uniqueName);
    const pid = pm2App?.pid || 0;

    if (!pid || pm2App?.pm2_env?.status !== 'online') {
      const status = pm2App?.pm2_env?.status;
      const output = await lastLogLine(logFile);
      // Not tracked as running, so it must not keep running (or crash-looping) under PM2.
      await execa('npx', ['pm2', 'delete', uniqueName], { reject: false });
      return failed(`PM2 started it but it is not running${status ? ` (status: ${status})` : ''}.${output ? ` Last output: ${output}` : ' Check its log.'}`);
    }

    const running: RunningService = {
      name: service.name,
      pid,
      config: service,
      startedAt: new Date().toISOString(),
      logFile,
    };
    await mutateRunningState(workspacePath, (state) => ({
      ...state,
      services: [...state.services.filter((s) => s.name !== service.name), running],
      failures: (state.failures ?? []).filter((f) => f.name !== service.name),
    }));
    console.log(chalk.green(`  ✔ ${service.name} started under PM2 (PID: ${pid})`));
    return { name: service.name, status: 'running', pid };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return failed(`PM2 could not start it: ${msg}`);
  }
}

/**
 * Stops ONE service: deletes its PM2 app and removes it from the running
 * state. Returns whether a PM2 app or state entry existed for it.
 */
export async function stopService(workspacePath: string, serviceName: string): Promise<boolean> {
  const uniqueName = pm2AppName(workspacePath, serviceName);

  let existed = false;
  let deleteSuccess = true;
  const pm2List = await getPm2List();
  if (pm2List.some((app) => app.name === uniqueName)) {
    existed = true;
    const res = await execa('npx', ['pm2', 'delete', uniqueName], { reject: false });
    if (res.failed || (typeof res.exitCode === 'number' && res.exitCode !== 0)) {
      deleteSuccess = false;
    }
  }

  if (deleteSuccess) {
    await mutateRunningState(workspacePath, (state) => {
      if (state.services.some((s) => s.name === serviceName)) existed = true;
      return {
        ...state,
        services: state.services.filter((s) => s.name !== serviceName),
        failures: (state.failures ?? []).filter((f) => f.name !== serviceName),
      };
    });
  }

  return existed && deleteSuccess;
}

/**
 * Restarts ONE service. PM2 starts pre-delete the app, so this is startService
 * — kept as a named export for endpoint and UI clarity.
 */
export async function restartService(
  service: ServiceConfig,
  workspacePath: string,
  logDir: string,
): Promise<ServiceStartResult> {
  return startService(service, workspacePath, logDir, { restart: true });
}

/**
 * Starts all services in the given list using PM2.
 *
 * @param services      - Services to start.
 * @param workspacePath - Workspace root path.
 * @param logDir        - Directory to write log files to.
 */
export async function startServices(
  services: ServiceConfig[],
  workspacePath: string,
  logDir: string,
): Promise<ServiceStartResult[]> {
  await fs.mkdir(logDir, { recursive: true });
  // One failure does not stop the rest; each service keeps its own result. A
  // service already online is left running instead of being restarted.
  const online = new Map((await getPm2List())
    .filter((app): app is Pm2Process & { name: string; pid: number } => Boolean(app.pm2_env?.status === 'online' && app.pid && app.name))
    .map((app) => [app.name, app.pid]));
  const results: ServiceStartResult[] = [];
  for (const service of services) {
    const pid = online.get(pm2AppName(workspacePath, service.name));
    results.push(pid
      ? await alreadyRunning(service, workspacePath, serviceLogFile(logDir, service.name), pid)
      : await startService(service, workspacePath, logDir));
  }
  return results;
}

/**
 * Stops all services for a workspace under PM2. Orchestrator entries in the
 * running state are preserved — they are stopped separately.
 *
 * @param workspacePath - Workspace root path.
 */
export async function stopServices(workspacePath: string): Promise<void> {
  const workspaceId = path.basename(workspacePath);
  const prefix = pm2Prefix(workspacePath);

  console.log(chalk.cyan(`  Stopping all services under PM2 for workspace: ${workspaceId}...`));

  // Never tear down a recorded orchestrator as part of a service stop-all —
  // they are stopped separately. Exclude their PM2 app names by exact match
  // (not by an `orch-` name prefix) so a service literally named `orch-*` is
  // still stopped.
  const raw = await readRawRunningState(workspacePath);
  const orchNames = new Set(
    (raw?.orchestrators ?? [])
      .map((o) => o.pm2Name)
      .filter((n): n is string => typeof n === 'string'),
  );

  const failedApps = new Set<string>();
  try {
    const pm2List = await getPm2List();
    const targetApps = pm2List.filter(
      (app): app is Pm2Process & { name: string } => Boolean(app.name && app.name.startsWith(prefix) && !orchNames.has(app.name)),
    );

    if (targetApps.length === 0) {
      console.log(chalk.yellow('  No running services found for this workspace.'));
    } else {
      for (const app of targetApps) {
        console.log(chalk.dim(`    Stopping PM2 process: ${app.name}`));
        const res = await execa('npx', ['pm2', 'delete', app.name], { reject: false });
        if (res.failed || (typeof res.exitCode === 'number' && res.exitCode !== 0)) {
          failedApps.add(app.name);
        }
      }
      if (failedApps.size > 0) {
        console.error(chalk.red(`  ✖ Failed to stop some PM2 processes: ${Array.from(failedApps).join(', ')}`));
      } else {
        console.log(chalk.green(`  ✔ All services stopped.`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`  ✖ Failed to stop services via PM2: ${toErrorMessage(error)}`));
  }

  await mutateRunningState(workspacePath, (state) => ({
    ...state,
    services: state.services.filter((s) => failedApps.has(pm2AppName(workspacePath, s.name))),
    // Stop All is the user's reset: earlier start failures no longer apply.
    failures: [],
  }));
}

/**
 * Shows the status of all services in a workspace by querying PM2.
 *
 * @param workspacePath - Workspace root path.
 */
export async function getServiceStatus(workspacePath: string): Promise<void> {
  const prefix = pm2Prefix(workspacePath);

  try {
    const pm2List = await getPm2List();
    const targetApps = pm2List.filter(
      (app): app is Pm2Process & { name: string } => Boolean(app.name && app.name.startsWith(prefix)),
    );

    if (targetApps.length === 0) {
      console.log(chalk.yellow('  No running services found for this workspace in PM2.'));
      return;
    }

    for (const app of targetApps) {
      const name = app.name.substring(prefix.length);
      const running = app.pm2_env?.status === 'online';
      const status = running ? chalk.green('● running') : chalk.red(`● ${app.pm2_env?.status || 'stopped'}`);
      const pid = app.pid || 'N/A';
      const uptime = app.pm2_env?.pm_uptime ? new Date(app.pm2_env.pm_uptime).toLocaleTimeString() : 'unknown';

      console.log(
        `  ${status} ${chalk.bold(name)} (PID: ${pid}, since ${uptime})`,
      );
    }
  } catch (error) {
    console.error(chalk.red(`  ✖ Failed to query PM2 status: ${toErrorMessage(error)}`));
  }
}

/** Recursively collects all .log file paths within a directory. */
async function collectLogFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await collectLogFiles(fullPath);
        results.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.log')) {
        results.push(fullPath);
      }
    }
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      console.warn(chalk.yellow(`  Warning: could not read directory ${dir}: ${toErrorMessage(error)}`));
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
}

/**
 * Tails log files for all services in a workspace, including nested services.
 *
 * @param workspacePath - Workspace root path.
 * @param logDir        - Directory containing log files.
 * @param lines         - Number of lines to show per service.
 */
export async function showLogs(
  workspacePath: string,
  logDir: string,
  lines: number = 20,
): Promise<void> {
  const logFiles = await collectLogFiles(logDir);
  if (logFiles.length === 0) {
    console.log(chalk.yellow('  No log files found.'));
    return;
  }

  for (const filePath of logFiles) {
    const rel = path.relative(logDir, filePath);
    const serviceName = rel.replace(/\.log$/i, '').replace(/\\/g, '/');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const allLines = content.split('\n');
      const tail = allLines.slice(-lines).join('\n');

      console.log(chalk.bold.cyan(`\n─── ${serviceName} ───`));
      if (tail.trim()) {
        console.log(tail);
      } else {
        console.log(chalk.dim('  (no output yet)'));
      }
    } catch {
      console.log(chalk.dim(`  Could not read ${rel}`));
    }
  }
}
