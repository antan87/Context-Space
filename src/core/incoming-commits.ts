/**
 * @module core/incoming-commits
 * Quietly checks each workspace repository's remote branch for commits pushed by
 * others that are not yet in `HEAD`. Never pulls, merges, rebases, or prompts:
 * it only updates objects and the single remote-tracking ref when someone reads
 * (at most every 5 minutes, or on explicit `?refresh=1` at most every 30 seconds),
 * stepping aside whenever Git holds a lock.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';
import { isGitRepo } from '../utils/git.js';
import { getWorkspaceRepoPaths } from '../utils/multi-git.js';
import { buildCommitUrl, extractRemoteHost, forgeKind, parseRemoteUrl, type ForgeKind, type ParsedRemote } from '../utils/pr.js';
import { DETAILED_COMMIT_FORMAT, parseDetailedCommitLog } from './whats-new.js';

export const INCOMING_COMMITS_LIMIT = 50;
export const STALE_FETCH_MS = 5 * 60_000;
export const REFRESH_THROTTLE_MS = 30_000;
export const BUSY_RETRY_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const READ_GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_BUFFER_BYTES = 8 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 500;
const HARD_DEADLINE_DELAY_MS = 2_000;
const REPO_STATE_TTL_MS = 24 * 60 * 60_000;
const MAX_REPO_STATES = 200;

export type IncomingState =
  | 'ok'
  | 'checking'
  | 'sign-in'
  | 'offline'
  | 'busy'
  | 'no-remote'
  | 'no-upstream'
  | 'error';

export interface IncomingHost {
  kind: ForgeKind;
  name: string;
}

export interface IncomingCommit {
  sha: string;
  author: string;
  subject: string;
  at: string;
  firstBodyLine?: string;
  fileCount?: number;
  incoming: true;
  webUrl?: string;
}

export interface IncomingRepo {
  repo: string;
  remote: string | null;
  branch: string | null;
  host: IncomingHost | null;
  lastFetchAt: string | null;
  fetching: boolean;
  state: IncomingState;
  message: string | null;
  behind: number;
  commits: IncomingCommit[];
  more: number;
}

export interface IncomingCommitsReport {
  at: string;
  repos: IncomingRepo[];
}

export type IncomingClock = Date | (() => Date | number);

export interface IncomingCommitsOptions {
  /** Ask for a fetch now, subject to the 30-second per-repository throttle. */
  refresh?: boolean;
  /** Injectable time source for tests. */
  now?: IncomingClock;
  /** Fetch time limit in ms before killing the subprocess (default 30_000). */
  fetchTimeoutMs?: number;
  /** Maximum in-memory repository state entries retained (default 200). */
  maxRepoStates?: number;
}

type FetchOutcome = 'ok' | 'sign-in' | 'offline' | 'busy' | 'no-upstream' | 'error';

interface RepoFetchEntry {
  targetKey: string;
  lastAttemptAt: number | null;
  lastFetchAt: string | null;
  lastReadAt: number;
  outcome: FetchOutcome | null;
  noUpstreamRefOid: string | null;
  errorDetail: string | null;
  errorHost: IncomingHost | null;
  inFlight: Promise<void> | null;
}

interface ResolvedTarget {
  gitDir: string;
  commonDir: string;
  branch: string | null;
  remote: string | null;
  remoteUrl: string | null;
  mergeRef: string | null;
  trackingRef: string | null;
  trackingRefOid: string | null;
  trackingRefExists: boolean;
  hasAnyRemote: boolean;
  host: IncomingHost | null;
  parsedRemote: ParsedRemote | null;
}

const repoStates = new Map<string, RepoFetchEntry>();
const commonDirTails = new Map<string, Promise<void>>();

/** Clears cached per-repository fetch timestamps and outcomes (for tests). */
export function resetIncomingCommitsState(): void {
  repoStates.clear();
  commonDirTails.clear();
}

/** Awaits any in-flight background fetches across the process (for tests). */
export async function waitForIncomingFetches(): Promise<void> {
  for (;;) {
    const active = Array.from(repoStates.values())
      .map((entry) => entry.inFlight)
      .filter((promise): promise is Promise<void> => promise !== null);
    if (active.length === 0) return;
    await Promise.allSettled(active);
  }
}

function resolveClock(now?: IncomingClock): () => number {
  if (typeof now === 'function') {
    return () => {
      const value = now();
      return value instanceof Date ? value.getTime() : value;
    };
  }
  if (now instanceof Date) {
    const fixed = now.getTime();
    return () => fixed;
  }
  return () => Date.now();
}

function displayForgeName(kind: ForgeKind, hostname: string): string {
  switch (kind) {
    case 'github': return 'GitHub';
    case 'azure': return 'Azure DevOps';
    case 'gitlab': return 'GitLab';
    case 'bitbucket': return 'Bitbucket';
    default: return hostname || 'local';
  }
}

/** Resolves a remote URL into a forge kind and human-friendly host name. */
export function resolveHostInfo(remoteUrl: string): { host: IncomingHost; parsed: ParsedRemote | null } {
  const parsed = parseRemoteUrl(remoteUrl);
  if (parsed) {
    return {
      host: { kind: parsed.kind, name: displayForgeName(parsed.kind, parsed.host) },
      parsed,
    };
  }
  const hostname = extractRemoteHost(remoteUrl) ?? 'local';
  const kind = hostname === 'local' ? 'unknown' : forgeKind(hostname);
  return {
    host: { kind, name: displayForgeName(kind, hostname) },
    parsed: null,
  };
}

const SIGN_IN_PATTERNS: RegExp[] = [
  /could not read Username/i,
  /could not read Password/i,
  /terminal prompts disabled/i,
  /unable to get password from user/i,
  /Authentication failed/i,
  /HTTP Basic:\s*Access denied/i,
  /Invalid username or (?:password|token)/i,
  /Invalid credentials/i,
  /Login failed/i,
  /You may not have access to this repository/i,
  /Support for password authentication was removed/i,
  /returned error:\s*40[13]\b/i,
  /\b401\s+Unauthorized\b/i,
  /\bHTTP\/[0-9.]+\s+40[13]\b/i,
  /Permission denied\s*\(/i,
  /Permission denied, please try again/i,
  /Public key authentication failed/i,
  /Host key verification failed/i,
  /sign_and_send_pubkey:.*signing failed/i,
  /Load key\s+.*:\s*Permission denied/i,
  /No interactive authentication/i,
];

const OFFLINE_PATTERNS: RegExp[] = [
  /Could not resolve host(?:name)?/i,
  /Could not resolve proxy/i,
  /Connection refused/i,
  /Could not connect to server/i,
  /Failed to connect to/i,
  /unable to access .*: Failed to connect/i,
  /\btimed out\b/i,
  /connection timeout/i,
  /Network is unreachable/i,
  /No route to host/i,
  /Temporary failure in name resolution/i,
  /Name or service not known/i,
  /nodename nor servname provided/i,
  /Connection reset by peer/i,
  /Recv failure:/i,
  /Send failure:/i,
  /Empty reply from server/i,
  /'?(?:\/|\.\.?[\\/]|[A-Za-z]:[\\/]|file:\/\/)[^'\n]*'?\s+does not appear to be a git repository/i,
];

const LOCK_BUSY_PATTERNS: RegExp[] = [
  /cannot lock ref\b/i,
  /Unable to create ['"]?[^'"\n]*lock['"]?:\s*File exists/i,
  /packed-refs\.lock/i,
];

function redactStderrCredentials(line: string): string {
  return line
    .replace(/(:\/\/)[^/\s'"]+@/g, '$1***@')
    .replace(/(^|[\s'"=(])([^:\s/@'"]+):[^/\s@'"]+@/g, '$1***@');
}

function firstNonEmptyStderrLine(stderr: string): string {
  const line = stderr
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ? redactStderrCredentials(line).slice(0, 300) : 'git fetch failed';
}

/**
 * Pure classifier distinguishing lock contention (`busy`), authentication
 * failures (`sign-in`), connectivity failures (`offline`), and other errors
 * (`error`) from Git stderr.
 */
export function classifyGitFetchError(
  stderr: string,
): { state: 'sign-in' | 'offline' | 'busy' | 'error'; detail: string } {
  const detail = firstNonEmptyStderrLine(stderr);
  if (LOCK_BUSY_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return { state: 'busy', detail };
  }
  if (SIGN_IN_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return { state: 'sign-in', detail };
  }
  if (OFFLINE_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return { state: 'offline', detail };
  }
  return { state: 'error', detail };
}

function isMissingRemoteRefError(stderr: string): boolean {
  return /couldn't find remote ref\b/i.test(stderr);
}

/** Ensures `BatchMode=yes` is present on an SSH command string without dropping existing flags. */
export function withBatchModeSsh(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return 'ssh -o BatchMode=yes';
  const replaced = trimmed.replace(/\bBatchMode\s*=\s*(?:no|ask)\b/gi, 'BatchMode=yes');
  if (/\bBatchMode\s*=\s*yes\b/i.test(replaced)) return replaced;
  return `${replaced} -o BatchMode=yes`;
}

async function runReadGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; exitCode?: number; stderr: string }> {
  try {
    const result = await execa('git', ['--no-optional-locks', ...args], {
      cwd,
      reject: false,
      timeout: READ_GIT_TIMEOUT_MS,
      stdin: 'ignore',
      maxBuffer: MAX_GIT_BUFFER_BYTES,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_ASKPASS: '',
        GIT_NO_LAZY_FETCH: '1',
      },
    });
    if (result.exitCode === 0) return { ok: true, stdout: result.stdout };
    return { ok: false, exitCode: result.exitCode, stderr: result.stderr || result.shortMessage || '' };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function readRefOid(repoPath: string, ref: string): Promise<string | null> {
  const res = await runReadGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const oid = res.ok ? res.stdout.trim() : '';
  return oid || null;
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  return (await readRefOid(repoPath, ref)) !== null;
}

async function readGitDirs(repoPath: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const res = await runReadGit(repoPath, ['rev-parse', '--git-dir', '--git-common-dir']);
  if (!res.ok) return null;
  const lines = res.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const rawGitDir = path.resolve(repoPath, lines[0]!);
  const rawCommonDir = path.resolve(repoPath, lines[1]!);
  const [gitDir, commonDir] = await Promise.all([
    fs.realpath(rawGitDir).catch(() => rawGitDir),
    fs.realpath(rawCommonDir).catch(() => rawCommonDir),
  ]);
  return { gitDir, commonDir };
}

function isValidBranchMergeRef(ref: string | null | undefined): ref is string {
  if (!ref || !ref.startsWith('refs/heads/')) return false;
  const branchPart = ref.slice('refs/heads/'.length);
  if (!branchPart) return false;
  return !ref.includes('*') && !ref.includes(':') && !/\s/.test(ref);
}

async function resolveRepoTarget(repoPath: string): Promise<ResolvedTarget | null> {
  const dirs = await readGitDirs(repoPath);
  if (!dirs) return null;

  const [branchRes, remotesRes] = await Promise.all([
    runReadGit(repoPath, ['symbolic-ref', '--short', 'HEAD']),
    runReadGit(repoPath, ['remote']),
  ]);

  if (!remotesRes.ok) return null;
  const branch = branchRes.ok && branchRes.stdout.trim() ? branchRes.stdout.trim() : null;
  const remotes = remotesRes.stdout
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean);

  if (remotes.length === 0) {
    return {
      ...dirs,
      branch,
      remote: null,
      remoteUrl: null,
      mergeRef: null,
      trackingRef: null,
      trackingRefOid: null,
      trackingRefExists: false,
      hasAnyRemote: false,
      host: null,
      parsedRemote: null,
    };
  }

  const defaultRemote = remotes.includes('origin') ? 'origin' : remotes[0]!;
  const orderedRemotes = [defaultRemote, ...remotes.filter((r) => r !== defaultRemote)];

  if (!branch) {
    return {
      ...dirs,
      branch: null,
      remote: null,
      remoteUrl: null,
      mergeRef: null,
      trackingRef: null,
      trackingRefOid: null,
      trackingRefExists: false,
      hasAnyRemote: true,
      host: null,
      parsedRemote: null,
    };
  }

  // 1. Check configured upstream (`@{u}`) first.
  const [cfgRemote, cfgMerge, upstreamSym] = await Promise.all([
    runReadGit(repoPath, ['config', '--get', `branch.${branch}.remote`]),
    runReadGit(repoPath, ['config', '--get', `branch.${branch}.merge`]),
    runReadGit(repoPath, ['rev-parse', '--symbolic-full-name', '@{u}']),
  ]);

  let remote: string | null = null;
  let mergeRef: string | null = null;
  let trackingRef: string | null = null;

  const configuredRemote = cfgRemote.ok ? cfgRemote.stdout.trim() : '';
  const configuredMerge = cfgMerge.ok ? cfgMerge.stdout.trim() : '';
  const candidateConfiguredMerge = configuredMerge
    ? (configuredMerge.startsWith('refs/') ? configuredMerge : `refs/heads/${configuredMerge}`)
    : '';
  if (configuredRemote && configuredRemote !== '.' && remotes.includes(configuredRemote) && configuredMerge) {
    remote = configuredRemote;
    if (isValidBranchMergeRef(candidateConfiguredMerge)) {
      mergeRef = candidateConfiguredMerge;
      const remoteBranch = mergeRef.slice('refs/heads/'.length);
      const sym = upstreamSym.ok ? upstreamSym.stdout.trim() : '';
      trackingRef = sym.startsWith('refs/remotes/') && !sym.includes('*') && !sym.includes(':')
        ? sym
        : `refs/remotes/${remote}/${remoteBranch}`;
    }
  } else if (configuredMerge && configuredRemote !== '.' && !isValidBranchMergeRef(candidateConfiguredMerge)) {
    remote = configuredRemote && remotes.includes(configuredRemote) ? configuredRemote : defaultRemote;
  } else {
    // 2. Otherwise pick a remote that already has `<remote>/<branch>`, or default to origin/first remote.
    const candidateRefs = orderedRemotes.map((r) => `refs/remotes/${r}/${branch}`);
    const existingRes = await runReadGit(repoPath, ['for-each-ref', '--format=%(refname)', ...candidateRefs]);
    const existingSet = new Set(
      existingRes.ok ? existingRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [],
    );
    const matchedRemote = orderedRemotes.find((r) => existingSet.has(`refs/remotes/${r}/${branch}`));
    remote = matchedRemote ?? defaultRemote;
    const candidateMergeRef = `refs/heads/${branch}`;
    if (isValidBranchMergeRef(candidateMergeRef)) {
      mergeRef = candidateMergeRef;
      trackingRef = `refs/remotes/${remote}/${branch}`;
    }
  }

  const [cfgUrlRes, trackingRefOid] = await Promise.all([
    runReadGit(repoPath, ['config', '--get', `remote.${remote}.url`]),
    trackingRef ? readRefOid(repoPath, trackingRef) : Promise.resolve(null),
  ]);
  const urlRes = cfgUrlRes.ok && cfgUrlRes.stdout.trim()
    ? cfgUrlRes
    : await runReadGit(repoPath, ['remote', 'get-url', remote]);
  const remoteUrl = urlRes.ok ? urlRes.stdout.trim() : null;
  const hostInfo = remoteUrl ? resolveHostInfo(remoteUrl) : null;

  return {
    ...dirs,
    branch,
    remote,
    remoteUrl,
    mergeRef,
    trackingRef,
    trackingRefOid,
    trackingRefExists: trackingRefOid !== null,
    hasAnyRemote: true,
    host: hostInfo?.host ?? null,
    parsedRemote: hostInfo?.parsed ?? null,
  };
}

function lockPathsFor(gitDir: string, commonDir: string, trackingRef: string | null): string[] {
  const paths = [
    path.join(gitDir, 'index.lock'),
    path.join(gitDir, 'HEAD.lock'),
    path.join(commonDir, 'packed-refs.lock'),
  ];
  if (trackingRef) {
    paths.push(`${path.join(commonDir, ...trackingRef.split('/'))}.lock`);
  }
  return paths;
}

async function hasBusyGitLock(gitDir: string, commonDir: string, trackingRef: string | null): Promise<boolean> {
  const checks = await Promise.all(
    lockPathsFor(gitDir, commonDir, trackingRef).map((lockPath) => fs.access(lockPath).then(() => true, () => false)),
  );
  return checks.some(Boolean);
}

type ActiveTarget = ResolvedTarget & {
  branch: string;
  remote: string;
  mergeRef: string;
  trackingRef: string;
};

async function runSingleFetch(
  repoPath: string,
  remote: string,
  mergeRef: string,
  trackingRef: string,
  timeoutMs: number,
): Promise<{ outcome: FetchOutcome; detail: string | null }> {
  if (
    !isValidBranchMergeRef(mergeRef)
    || !trackingRef.startsWith('refs/remotes/')
    || trackingRef.includes('*')
    || trackingRef.includes(':')
  ) {
    return { outcome: 'no-upstream', detail: 'Upstream ref is not a branch' };
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
  };

  const sshConfigArgs: string[] = [];
  if (env.GIT_SSH_COMMAND?.trim()) {
    env.GIT_SSH_COMMAND = withBatchModeSsh(env.GIT_SSH_COMMAND);
  } else {
    const coreSsh = await runReadGit(repoPath, ['config', '--get', 'core.sshCommand']);
    if (coreSsh.ok && coreSsh.stdout.trim()) {
      sshConfigArgs.push('-c', `core.sshCommand=${withBatchModeSsh(coreSsh.stdout.trim())}`);
    } else {
      env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    }
  }

  const args = [
    '-c',
    'credential.interactive=never',
    '-c',
    'http.lowSpeedLimit=1000',
    '-c',
    'http.lowSpeedTime=20',
    ...sshConfigArgs,
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    '--no-recurse-submodules',
    '--no-auto-maintenance',
    '--refmap=',
    remote,
    `+${mergeRef}:${trackingRef}`,
  ];

  const ac = new AbortController();
  const sub = execa('git', args, {
    cwd: repoPath,
    env,
    reject: false,
    detached: process.platform !== 'win32',
    stdin: 'ignore',
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    cancelSignal: ac.signal,
    gracefulCancel: false,
  });
  // Suppress late rejections if hard deadline settles first and pipes are torn down.
  void sub.catch(() => {});

  let timedOut = false;
  let settled = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let hardDeadlineTimer: NodeJS.Timeout | undefined;

  const killSubprocess = () => {
    if (process.platform === 'win32') {
      if (sub.pid) {
        execFile('taskkill', ['/pid', String(sub.pid), '/T', '/F'], { windowsHide: true }, () => {
          if (!settled) ac.abort();
        });
      } else {
        ac.abort();
      }
      return;
    }
    if (sub.pid) {
      try { process.kill(-sub.pid, 'SIGTERM'); } catch {}
      forceTimer = setTimeout(() => {
        try { process.kill(-sub.pid!, 'SIGKILL'); } catch {}
      }, FORCE_KILL_DELAY_MS);
      forceTimer.unref();
    } else {
      ac.abort();
    }
  };

  const hardDeadlinePromise = new Promise<{ timedOutByDeadline: true }>((resolve) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killSubprocess();
      hardDeadlineTimer = setTimeout(() => {
        settled = true;
        if (process.platform !== 'win32' && sub.pid) {
          try { process.kill(-sub.pid, 'SIGKILL'); } catch {}
        }
        ac.abort();
        try { (sub.stdin as { destroy?: () => void } | null)?.destroy?.(); } catch {}
        try { sub.stdout?.destroy(); } catch {}
        try { sub.stderr?.destroy(); } catch {}
        resolve({ timedOutByDeadline: true });
      }, HARD_DEADLINE_DELAY_MS);
      hardDeadlineTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();
  });

  try {
    const raceResult = await Promise.race([
      sub.then((result) => ({ timedOutByDeadline: false as const, result })),
      hardDeadlinePromise,
    ]);
    if (raceResult.timedOutByDeadline || timedOut) {
      return { outcome: 'offline', detail: 'Timed out checking remote' };
    }
    const { result } = raceResult;
    if (result.exitCode === 0) {
      return { outcome: 'ok', detail: null };
    }
    const stderr = result.stderr || result.shortMessage || 'git fetch failed';
    if (isMissingRemoteRefError(stderr)) {
      return { outcome: 'no-upstream', detail: firstNonEmptyStderrLine(stderr) };
    }
    const classified = classifyGitFetchError(stderr);
    return { outcome: classified.state, detail: classified.detail };
  } finally {
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceTimer) clearTimeout(forceTimer);
    if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);
  }
}

function targetKeyFor(target: ResolvedTarget): string {
  return `${target.remote ?? ''}\0${target.remoteUrl ?? ''}\0${target.mergeRef ?? ''}\0${target.trackingRef ?? ''}`;
}

function pruneRepoStates(nowMs: number, maxStates: number): void {
  const cap = Math.max(1, maxStates);
  for (const [key, entry] of repoStates) {
    if (entry.inFlight === null && nowMs - entry.lastReadAt >= REPO_STATE_TTL_MS) {
      repoStates.delete(key);
    }
  }
  while (repoStates.size > cap) {
    let evicted = false;
    for (const [key, entry] of repoStates) {
      if (entry.inFlight === null) {
        repoStates.delete(key);
        evicted = true;
        break;
      }
    }
    if (!evicted) break;
  }
}

function getOrCreateEntry(stateKey: string, targetKey: string, nowMs: number, maxStates: number): RepoFetchEntry {
  pruneRepoStates(nowMs, maxStates);
  const existing = repoStates.get(stateKey);
  if (existing) {
    existing.lastReadAt = nowMs;
    repoStates.delete(stateKey);
    repoStates.set(stateKey, existing);
    if (existing.targetKey !== targetKey && existing.inFlight === null) {
      existing.targetKey = targetKey;
      existing.lastAttemptAt = null;
      existing.lastFetchAt = null;
      existing.outcome = null;
      existing.noUpstreamRefOid = null;
      existing.errorDetail = null;
      existing.errorHost = null;
    }
    return existing;
  }
  const created: RepoFetchEntry = {
    targetKey,
    lastAttemptAt: null,
    lastFetchAt: null,
    lastReadAt: nowMs,
    outcome: null,
    noUpstreamRefOid: null,
    errorDetail: null,
    errorHost: null,
    inFlight: null,
  };
  repoStates.set(stateKey, created);
  pruneRepoStates(nowMs, maxStates);
  return created;
}

async function withCommonDirLock(commonDir: string, fn: () => Promise<void>): Promise<void> {
  const prev = commonDirTails.get(commonDir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  commonDirTails.set(commonDir, tail);
  await prev;
  try {
    await fn();
  } finally {
    release();
    if (commonDirTails.get(commonDir) === tail) {
      commonDirTails.delete(commonDir);
    }
  }
}

function startFetchEntry(
  entry: RepoFetchEntry,
  repoPath: string,
  target: ActiveTarget,
  clock: () => number,
  timeoutMs: number,
): Promise<void> {
  const run = (async () => {
    try {
      await withCommonDirLock(target.commonDir, async () => {
        const busy = await hasBusyGitLock(target.gitDir, target.commonDir, target.trackingRef);
        if (busy) {
          entry.lastAttemptAt = clock();
          entry.outcome = 'busy';
          entry.noUpstreamRefOid = null;
          entry.errorDetail = null;
          return;
        }

        const preFetchRefOid = await readRefOid(repoPath, target.trackingRef);
        const res = await runSingleFetch(repoPath, target.remote, target.mergeRef, target.trackingRef, timeoutMs);
        const finishedAt = clock();
        entry.lastAttemptAt = finishedAt;
        entry.outcome = res.outcome;
        entry.noUpstreamRefOid = res.outcome === 'no-upstream' ? preFetchRefOid : null;
        entry.errorDetail = res.detail;
        entry.errorHost = target.host;
        if (res.outcome === 'ok' || res.outcome === 'no-upstream') {
          entry.lastFetchAt = new Date(finishedAt).toISOString();
        }
      });
    } catch (error) {
      entry.lastAttemptAt = clock();
      entry.outcome = 'error';
      entry.noUpstreamRefOid = null;
      entry.errorDetail = firstNonEmptyStderrLine(error instanceof Error ? error.message : String(error));
      entry.errorHost = target.host;
    } finally {
      entry.inFlight = null;
    }
  })();

  entry.inFlight = run;
  return run;
}

function isMissingLazyObjectError(stderr: string): boolean {
  return /lazy fetching disabled|from promisor remote|unable to read [0-9a-f]{40,64}/i.test(stderr);
}

async function readIncomingRange(
  repoPath: string,
  trackingRef: string,
  parsedRemote: ParsedRemote | null,
): Promise<{ behind: number; commits: IncomingCommit[]; more: number; error?: string }> {
  const headExists = await refExists(repoPath, 'HEAD');
  let revRangeArgs = headExists
    ? ['--cherry-pick', '--right-only', `HEAD...${trackingRef}`]
    : [trackingRef];
  let countRes = await runReadGit(repoPath, ['rev-list', '--count', ...revRangeArgs, '--']);
  if (!countRes.ok && headExists && isMissingLazyObjectError(countRes.stderr)) {
    revRangeArgs = [`HEAD..${trackingRef}`];
    countRes = await runReadGit(repoPath, ['rev-list', '--count', ...revRangeArgs, '--']);
  }
  if (!countRes.ok) {
    return { behind: 0, commits: [], more: 0, error: firstNonEmptyStderrLine(countRes.stderr) };
  }
  let behind = Number.parseInt(countRes.stdout.trim(), 10) || 0;
  if (behind <= 0) {
    return { behind: 0, commits: [], more: 0 };
  }

  const runLog = (shortstat: boolean, rangeArgs: string[]) => runReadGit(repoPath, [
    'log',
    `--max-count=${INCOMING_COMMITS_LIMIT}`,
    ...(shortstat ? ['--shortstat'] : []),
    DETAILED_COMMIT_FORMAT,
    ...rangeArgs,
    '--',
  ]);

  let hasShortstat = true;
  let logRes = await runLog(true, revRangeArgs);
  if (!logRes.ok && isMissingLazyObjectError(logRes.stderr)) {
    hasShortstat = false;
    logRes = await runLog(false, revRangeArgs);
    if (!logRes.ok && headExists && revRangeArgs[0] === '--cherry-pick' && isMissingLazyObjectError(logRes.stderr)) {
      revRangeArgs = [`HEAD..${trackingRef}`];
      const fallbackCount = await runReadGit(repoPath, ['rev-list', '--count', ...revRangeArgs, '--']);
      if (fallbackCount.ok) {
        behind = Number.parseInt(fallbackCount.stdout.trim(), 10) || 0;
      }
      logRes = await runLog(false, revRangeArgs);
    }
  }
  if (!logRes.ok) {
    return { behind, commits: [], more: behind, error: firstNonEmptyStderrLine(logRes.stderr) };
  }
  const commits: IncomingCommit[] = parseDetailedCommitLog(logRes.stdout).map(({ fullSha, fileCount, ...commit }) => {
    const webUrl = parsedRemote && fullSha ? buildCommitUrl(parsedRemote, fullSha) : null;
    return {
      ...commit,
      ...(hasShortstat && fileCount !== undefined ? { fileCount } : {}),
      incoming: true,
      ...(webUrl !== null ? { webUrl } : {}),
    };
  });
  return {
    behind,
    commits,
    more: Math.max(0, behind - commits.length),
  };
}

function messageForState(
  state: IncomingState,
  host: IncomingHost | null,
  remote: string | null,
  branch: string | null,
  errorDetail: string | null,
  trackingRefExists = false,
): string | null {
  const hostName = host?.name ?? 'the remote';
  switch (state) {
    case 'ok':
      return null;
    case 'checking':
      return `Checking ${hostName}…`;
    case 'sign-in':
      return `Sign in to ${hostName} to see new commits`;
    case 'offline':
      return `Offline — could not reach ${hostName}`;
    case 'busy':
      return 'Git is busy right now — skipping check';
    case 'no-remote':
      return 'No remote configured for this repository';
    case 'no-upstream':
      if (!branch) return 'HEAD is detached — no branch to check';
      return trackingRefExists
        ? `${branch} is no longer on ${hostName}`
        : `Branch "${branch}" is not on ${remote ?? 'the remote'} yet`;
    case 'error':
      return errorDetail ?? 'Could not check for incoming commits';
  }
}

async function inspectRepo(
  repo: { name: string; path: string },
  options: { refresh: boolean; clock: () => number; fetchTimeoutMs: number; maxRepoStates: number },
): Promise<IncomingRepo> {
  const emptyRepo = (
    state: IncomingState,
    message: string,
    extra: Partial<IncomingRepo> = {},
  ): IncomingRepo => ({
    repo: repo.name,
    remote: null,
    branch: null,
    host: null,
    lastFetchAt: null,
    fetching: false,
    state,
    message,
    behind: 0,
    commits: [],
    more: 0,
    ...extra,
  });

  if (!(await isGitRepo(repo.path))) {
    const exists = await fs.stat(repo.path).then(() => true, () => false);
    return emptyRepo('error', exists ? 'This is not a git repository.' : 'The folder is missing.');
  }

  let target = await resolveRepoTarget(repo.path);
  if (!target) {
    return emptyRepo('error', 'Could not read git repository.');
  }
  if (!target.hasAnyRemote) {
    return emptyRepo('no-remote', messageForState('no-remote', null, null, target.branch, null)!, {
      branch: target.branch,
    });
  }
  if (!target.branch) {
    return emptyRepo('no-upstream', messageForState('no-upstream', null, null, null, null)!);
  }
  if (!target.remote || !target.mergeRef || !target.trackingRef) {
    return emptyRepo('no-upstream', `Branch "${target.branch}" does not track a branch`, {
      remote: target.remote,
      branch: target.branch,
      host: target.host,
    });
  }

  const activeTarget: ActiveTarget = {
    ...target,
    branch: target.branch,
    remote: target.remote,
    mergeRef: target.mergeRef,
    trackingRef: target.trackingRef,
  };

  const nowMs = options.clock();
  const stateKey = `${activeTarget.commonDir}\0${activeTarget.trackingRef}`;
  const entry = getOrCreateEntry(stateKey, targetKeyFor(activeTarget), nowMs, options.maxRepoStates);

  // If the tracking ref moved after a `no-upstream` fetch (e.g. `git push -u`), clear stale outcome and cooldown.
  if (
    entry.inFlight === null
    && entry.outcome === 'no-upstream'
    && activeTarget.trackingRefOid !== entry.noUpstreamRefOid
  ) {
    entry.outcome = null;
    entry.noUpstreamRefOid = null;
    entry.errorDetail = null;
    entry.errorHost = null;
    entry.lastAttemptAt = null;
  }

  // Check if another Git process holds a lock only when we are not already fetching it ourselves.
  const lockedExternally = entry.inFlight === null
    && await hasBusyGitLock(activeTarget.gitDir, activeTarget.commonDir, activeTarget.trackingRef);

  const staleCooldownMs = entry.outcome === 'busy' ? BUSY_RETRY_MS : STALE_FETCH_MS;
  if (!lockedExternally) {
    if (options.refresh) {
      if (entry.inFlight !== null) {
        await entry.inFlight;
      } else if (entry.lastAttemptAt === null || nowMs - entry.lastAttemptAt >= REFRESH_THROTTLE_MS) {
        await startFetchEntry(entry, repo.path, activeTarget, options.clock, options.fetchTimeoutMs);
      }
      // Re-read target after fetch in case the tracking ref was created.
      target = (await resolveRepoTarget(repo.path)) ?? target;
    } else if (entry.inFlight === null && (entry.lastAttemptAt === null || nowMs - entry.lastAttemptAt >= staleCooldownMs)) {
      startFetchEntry(entry, repo.path, activeTarget, options.clock, options.fetchTimeoutMs);
    }
  }

  // Re-check busy right before reporting if no fetch is active (e.g. a fetch just backed off due to lock).
  const busyNow = lockedExternally
    || (entry.inFlight === null && await hasBusyGitLock(target.gitDir, target.commonDir, target.trackingRef));

  const outcomeStale = entry.outcome === 'no-upstream' && target.trackingRefOid !== entry.noUpstreamRefOid;

  let state: IncomingState;
  let errorDetail: string | null = null;
  if (busyNow) {
    state = 'busy';
  } else if (!target.trackingRefExists && entry.inFlight !== null) {
    state = 'checking';
  } else if (entry.outcome && entry.outcome !== 'ok' && !outcomeStale) {
    state = entry.outcome;
    errorDetail = entry.errorDetail;
  } else if (target.trackingRefExists) {
    state = 'ok';
  } else {
    state = 'no-upstream';
  }

  const canReadLocalRef = Boolean(target.trackingRef && target.trackingRefExists && state !== 'no-upstream');
  const range = canReadLocalRef
    ? await readIncomingRange(repo.path, target.trackingRef!, target.parsedRemote)
    : { behind: 0, commits: [], more: 0 };

  if (range.error && state === 'ok') {
    state = 'error';
    errorDetail = range.error;
  }

  return {
    repo: repo.name,
    remote: target.remote,
    branch: target.branch,
    host: target.host,
    lastFetchAt: entry.lastFetchAt,
    fetching: entry.inFlight !== null,
    state,
    message: messageForState(
      state,
      state === 'sign-in' || state === 'offline' ? (entry.errorHost ?? target.host) : target.host,
      target.remote,
      target.branch,
      errorDetail,
      target.trackingRefExists,
    ),
    behind: range.behind,
    commits: range.commits,
    more: range.more,
  };
}

/**
 * Lists incoming commits (on each repository's remote branch and not in `HEAD`).
 * Normal reads return what is known immediately and trigger a background fetch
 * if the last attempt is older than 5 minutes. `refresh: true` fetches now,
 * throttled to once per 30 seconds per repository.
 */
export async function incomingCommits(
  workspacePath: string,
  options: IncomingCommitsOptions = {},
): Promise<IncomingCommitsReport> {
  const clock = resolveClock(options.now);
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxRepoStates = options.maxRepoStates ?? MAX_REPO_STATES;
  const refresh = options.refresh === true;
  const root = await fs.realpath(workspacePath).catch(() => path.resolve(workspacePath));
  const repos = await getWorkspaceRepoPaths(root).catch(() => []);
  const results = await Promise.all(
    repos.map(async (repo) => {
      try {
        return await inspectRepo(repo, { refresh, clock, fetchTimeoutMs, maxRepoStates });
      } catch (error) {
        return {
          repo: repo.name,
          remote: null,
          branch: null,
          host: null,
          lastFetchAt: null,
          fetching: false,
          state: 'error' as const,
          message: firstNonEmptyStderrLine(error instanceof Error ? error.message : String(error)),
          behind: 0,
          commits: [],
          more: 0,
        };
      }
    }),
  );

  return {
    at: new Date(clock()).toISOString(),
    repos: results,
  };
}
