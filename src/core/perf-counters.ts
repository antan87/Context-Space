/**
 * Opt-in work counters for the performance rule checks in perf/.
 *
 * Enabled only when CONTEXTSPACE_PERF_COUNTERS=1. Counts child processes,
 * file reads and API requests without touching the code that does the work:
 * Node's child_process and fs/promises exports are wrapped and re-synced into
 * ES module bindings, so execa and the session readers are counted as-is.
 * Counting work instead of time gives the same answer on every machine.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

export const PERF_COUNTERS_ENV = 'CONTEXTSPACE_PERF_COUNTERS';

export interface ReadBucket {
  opens: number;
  readFiles: number;
  bytes: number;
}

export interface RequestCount {
  count: number;
  aborted: number;
}

export interface PerfCounters {
  since: string;
  spawns: Record<string, number>;
  /** Child processes attributed to the API request that started them. */
  spawnsByRequest: Record<string, Record<string, number>>;
  reads: Record<string, ReadBucket>;
  requests: Record<string, RequestCount>;
}

let counters: PerfCounters = emptyCounters();
let installed = false;
const currentRequest = new AsyncLocalStorage<string>();

function emptyCounters(): PerfCounters {
  return { since: new Date().toISOString(), spawns: {}, spawnsByRequest: {}, reads: {}, requests: {} };
}

export function perfCountersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PERF_COUNTERS_ENV] === '1';
}

export function snapshotPerfCounters(): PerfCounters {
  return structuredClone(counters);
}

export function resetPerfCounters(): void {
  counters = emptyCounters();
}

/** Groups a path by the history source or area it belongs to. */
export function readBucket(filePath: string, home = os.homedir()): string {
  const resolved = path.resolve(filePath);
  const within = (dir: string) => resolved === dir || resolved.startsWith(dir + path.sep);
  if (within(path.join(home, '.claude'))) return 'claude';
  if (within(path.join(home, '.codex'))) return 'codex';
  if (within(path.join(home, '.gemini')) || within(path.join(home, '.antigravity'))) return 'antigravity';
  if (within(path.join(home, '.copilot'))) return 'copilot';
  if (within(path.join(home, '.contextspace'))) return 'config';
  return 'other';
}

function bucket(name: string): ReadBucket {
  return (counters.reads[name] ??= { opens: 0, readFiles: 0, bytes: 0 });
}

function pathOf(target: unknown): string | null {
  if (typeof target === 'string') return target;
  if (target instanceof URL) return target.pathname;
  if (Buffer.isBuffer(target)) return target.toString();
  return null; // file descriptors and FileHandles are counted when opened
}

function countSpawn(command: unknown): void {
  const name = typeof command === 'string' ? path.basename(command).replace(/\.(exe|cmd|bat)$/i, '') : 'unknown';
  counters.spawns[name] = (counters.spawns[name] ?? 0) + 1;
  const request = currentRequest.getStore();
  if (request) {
    const byName = (counters.spawnsByRequest[request] ??= {});
    byName[name] = (byName[name] ?? 0) + 1;
  }
}

type MonkeypatchedFn = (this: unknown, ...args: unknown[]) => unknown;

interface PatchedFileHandle {
  read: (this: unknown, ...args: unknown[]) => Promise<{ bytesRead?: number } | undefined>;
  readFile: (this: unknown, ...args: unknown[]) => Promise<string | Buffer | { length?: number } | undefined>;
  [key: string]: unknown;
}

interface PatchedFsPromises {
  readFile: (this: unknown, ...args: unknown[]) => Promise<string | Buffer | { length?: number } | undefined>;
  open: (this: unknown, ...args: unknown[]) => Promise<PatchedFileHandle>;
  [key: string]: unknown;
}

/**
 * Wraps the process and file APIs once. Returns false (and does nothing)
 * unless the environment flag is set.
 */
export function installPerfCounters(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!perfCountersEnabled(env)) return false;
  if (installed) return true;
  installed = true;

  // ES namespace objects are frozen; patch the CommonJS exports and re-sync.
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as Record<string, MonkeypatchedFn | undefined>;
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'] as const) {
    const original = cp[name];
    if (typeof original !== 'function') continue;
    cp[name] = function countedChildProcess(this: unknown, command: unknown, ...rest: unknown[]) {
      countSpawn(name.startsWith('exec') && !name.startsWith('execFile') ? String(command).split(' ')[0] : command);
      return original.call(this, command, ...rest);
    };
  }

  const fsp = require('node:fs/promises') as PatchedFsPromises;
  const originalReadFile = fsp.readFile;
  fsp.readFile = async function countedReadFile(this: unknown, target: unknown, ...rest: unknown[]) {
    const result = await originalReadFile.call(this, target, ...rest);
    const filePath = pathOf(target);
    if (filePath) {
      const b = bucket(readBucket(filePath));
      b.readFiles += 1;
      b.bytes += typeof result === 'string' ? Buffer.byteLength(result) : result?.length ?? 0;
    }
    return result;
  };
  const originalOpen = fsp.open;
  fsp.open = async function countedOpen(this: unknown, target: unknown, ...rest: unknown[]) {
    const handle = await originalOpen.call(this, target, ...rest);
    const filePath = pathOf(target);
    if (filePath) {
      const name = readBucket(filePath);
      bucket(name).opens += 1;
      const originalRead = handle.read;
      handle.read = async function countedRead(this: unknown, ...args: unknown[]) {
        const out = await originalRead.apply(this, args);
        bucket(name).bytes += out?.bytesRead ?? 0;
        return out;
      };
      const originalHandleReadFile = handle.readFile;
      handle.readFile = async function countedHandleReadFile(this: unknown, ...args: unknown[]) {
        const out = await originalHandleReadFile.apply(this, args);
        bucket(name).readFiles += 1;
        bucket(name).bytes += typeof out === 'string' ? Buffer.byteLength(out) : out?.length ?? 0;
        return out;
      };
    }
    return handle;
  };

  syncBuiltinESMExports();
  return true;
}

/**
 * Records one API request and whether the client went away before it
 * finished, and runs `handle` so that processes it starts are attributed to it.
 */
export function countRequest<T>(method: string, requestPath: string, signal: AbortSignal | undefined, handle: () => Promise<T>): Promise<T> {
  const key = `${method} ${requestPath}`;
  const entry = () => (counters.requests[key] ??= { count: 0, aborted: 0 });
  entry().count += 1;
  signal?.addEventListener('abort', () => { entry().aborted += 1; }, { once: true });
  return currentRequest.run(key, handle);
}
