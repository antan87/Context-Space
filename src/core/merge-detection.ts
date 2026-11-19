/**
 * @module core/merge-detection
 * Decides whether a branch tip is already part of a repository's default
 * branch. Archive uses it to tell delivered work from parked work, and branch
 * cleanup uses it to decide what may be deleted.
 *
 * Two kinds of evidence count, in order:
 *
 * 1. **Ancestry** — the tip is an ancestor of the fetched remote default
 *    branch (merge commits and fast-forwards).
 * 2. **A merged pull request for that exact tip** — squash and rebase merges
 *    rewrite commits, so ancestry misses them. `gh` must report a merged PR
 *    whose head SHA equals the tip; a PR whose head moved on does not count.
 *
 * Anything else is "not proven merged". Callers must treat that as "keep".
 */

import { execa } from 'execa';

import { detectGh, formatRemoteRepo, parseRemoteUrl, type GhStatus } from '../utils/pr.js';

/** Which evidence proved a merge, or `none`. */
export type MergeEvidence = 'ancestor' | 'pull-request' | 'none';

/** Outcome of {@link checkMerged}. */
export interface MergeCheck {
  merged: boolean;
  evidence: MergeEvidence;
  /** One sentence for reports: why the tip is or is not considered merged. */
  detail: string;
  /** The merged PR that proved it, when {@link evidence} is `pull-request`. */
  prUrl?: string;
}

/** Input for {@link checkMerged}. */
export interface MergeCheckInput {
  /** Repository (or worktree) to run Git and `gh` in. */
  repoPath: string;
  /** The commit to test, normally the branch tip. */
  sha: string;
  /** Branch name used to look up pull requests; omit for a detached HEAD. */
  branch?: string | null;
  defaultBranch: string;
  remoteUrl?: string | null;
  /** Consult `gh` for squash/rebase merges (default true). */
  usePullRequests?: boolean;
}

const GH_STATUS_TTL_MS = 5 * 60_000;
const BRANCH_PR_TTL_MS = 5 * 60_000;
const ghExecEnv = () => ({
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
});

interface BranchPrCacheEntry {
  at: number;
  value?: BranchPullRequest[];
  inFlight: Promise<BranchPullRequest[]> | null;
  hadTimeout: boolean;
  /** Set when the last `gh pr list` failed: {@link value} is then the last good result, kept (stale) instead of erased. */
  failedAt?: number;
}

/** After a failed `gh pr list`, the next plain read waits this long before asking again (an explicit refresh asks at once). */
const BRANCH_PR_FAILURE_RETRY_MS = 30_000;
/** At most this many `gh pr list` processes run at once, across every repository. */
const MAX_CONCURRENT_GH_PR_LISTS = 2;
let ghPrListRunning = 0;
const ghPrListWaiters: Array<() => void> = [];

async function withGhPrListSlot<T>(task: () => Promise<T>): Promise<T> {
  if (ghPrListRunning >= MAX_CONCURRENT_GH_PR_LISTS) {
    await new Promise<void>((resolve) => ghPrListWaiters.push(resolve));
  } else {
    ghPrListRunning += 1;
  }
  try {
    return await task();
  } finally {
    const next = ghPrListWaiters.shift();
    if (next) next();
    else ghPrListRunning -= 1;
  }
}

type PullRequestsSettledListener = (repoPath: string) => void;

let ghStatus: { at: number; status: GhStatus } | null = null;
let ghStatusInFlight: Promise<GhStatus> | null = null;
let cacheGen = 0;
const branchPrCache = new Map<string, BranchPrCacheEntry>();
const pullRequestSettledListeners = new Set<PullRequestsSettledListener>();

/** Subscribes to background pull-request fetches that finished after an initial caller timed out. */
export function subscribePullRequestsSettled(listener: PullRequestsSettledListener): () => void {
  pullRequestSettledListeners.add(listener);
  return () => {
    pullRequestSettledListeners.delete(listener);
  };
}

function notifyPullRequestsSettled(repoPath: string): void {
  for (const listener of [...pullRequestSettledListeners]) {
    listener(repoPath);
  }
}

/**
 * `gh` availability, cached briefly and coalesced across concurrent callers:
 * a long-running app server notices a later `gh auth login` without probing `gh`
 * once per repository.
 */
function ghAvailable(forceRefresh = false): Promise<GhStatus> {
  if (ghStatusInFlight) return ghStatusInFlight;
  if (!forceRefresh && ghStatus && Date.now() - ghStatus.at <= GH_STATUS_TTL_MS) {
    return Promise.resolve(ghStatus.status);
  }
  const gen = cacheGen;
  const probe = detectGh()
    .then((status) => {
      if (cacheGen === gen) {
        ghStatus = { at: Date.now(), status };
      }
      return status;
    })
    .finally(() => {
      if (ghStatusInFlight === probe) {
        ghStatusInFlight = null;
      }
    });
  ghStatusInFlight = probe;
  return probe;
}

/** Test hook: forget the cached `gh` detection and pull request lists. */
export function resetMergeDetectionCache(): void {
  cacheGen += 1;
  ghStatus = null;
  ghStatusInFlight = null;
  branchPrCache.clear();
}

/**
 * Marks cached branch pull request lookups stale (and refreshes `gh` auth probing on next call)
 * so explicit user actions like "Check now" or `?refresh=1` preserve prior PRs for
 * stale-while-revalidate and avoid duplicating an in-flight `gh` call.
 */
export function clearBranchPullRequestCache(repoPaths?: string[]): void {
  ghStatus = null;
  if (!repoPaths) {
    for (const entry of branchPrCache.values()) {
      entry.at = 0;
      entry.failedAt = undefined;
    }
    return;
  }
  const prefixes = repoPaths.map((p) => `${p}\0`);
  for (const [key, entry] of branchPrCache.entries()) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      entry.at = 0;
      entry.failedAt = undefined;
    }
  }
}

/**
 * Updates `origin/<defaultBranch>` so ancestry is judged against the remote's
 * current state. Never throws; a failed fetch leaves the last fetched state.
 *
 * @returns An error message when the fetch failed, otherwise `null`.
 */
export async function fetchDefaultBranch(repoPath: string, defaultBranch: string): Promise<string | null> {
  const result = await execa(
    'git',
    ['fetch', '--quiet', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`],
    { cwd: repoPath, reject: false, timeout: 60_000 },
  ).catch((error: unknown) => ({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }));
  if (result.exitCode === 0) return null;
  const first = String(result.stderr ?? '').split('\n').find((line) => line.trim()) ?? 'git fetch failed';
  return first.trim();
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repoPath, reject: false });
  return result.exitCode === 0;
}

/** The ref ancestry is judged against: the remote default, else the local one. */
export async function resolveDefaultRef(repoPath: string, defaultBranch: string): Promise<string | null> {
  for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
    if (await refExists(repoPath, ref)) return ref;
  }
  return null;
}

async function isAncestor(repoPath: string, sha: string, ref: string): Promise<boolean> {
  const result = await execa('git', ['merge-base', '--is-ancestor', sha, ref], { cwd: repoPath, reject: false });
  return result.exitCode === 0;
}

export interface GhPullRequest {
  url?: string;
  headRefOid?: string;
  baseRefName?: string;
}

export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface BranchPullRequest {
  number: number;
  title: string;
  state: PullRequestState;
  url: string;
  baseRefName?: string;
  headRefOid?: string;
  mergeCommitOid?: string;
}

interface RawBranchPullRequest {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  url?: unknown;
  baseRefName?: unknown;
  headRefOid?: unknown;
  mergeCommit?: { oid?: unknown } | null;
}

function normalizePrState(state: unknown): PullRequestState | null {
  if (typeof state !== 'string') return null;
  const upper = state.toUpperCase();
  if (upper === 'OPEN' || upper === 'MERGED' || upper === 'CLOSED') return upper;
  return null;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** Parses raw JSON output from `gh pr list --json number,title,state,url,baseRefName,headRefOid,mergeCommit`. */
export function parseBranchPullRequests(stdout: string): BranchPullRequest[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const prs: BranchPullRequest[] = [];
  for (const item of raw as RawBranchPullRequest[]) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.number !== 'number' || !Number.isInteger(item.number) || item.number <= 0) continue;
    if (typeof item.title !== 'string') continue;
    const state = normalizePrState(item.state);
    if (!state) continue;
    if (!isHttpUrl(item.url)) continue;
    const mergeOid =
      item.mergeCommit && typeof item.mergeCommit === 'object' && typeof item.mergeCommit.oid === 'string' && item.mergeCommit.oid
        ? item.mergeCommit.oid
        : undefined;
    prs.push({
      number: item.number,
      title: item.title,
      state,
      url: item.url,
      ...(typeof item.baseRefName === 'string' && item.baseRefName ? { baseRefName: item.baseRefName } : {}),
      ...(typeof item.headRefOid === 'string' && item.headRefOid ? { headRefOid: item.headRefOid } : {}),
      ...(mergeOid ? { mergeCommitOid: mergeOid } : {}),
    });
  }
  return prs;
}

async function runGhPrList(repoPath: string, args: string[]): Promise<string | null> {
  return withGhPrListSlot(async () => {
    const result = await execa('gh', ['pr', 'list', ...args], {
      cwd: repoPath,
      reject: false,
      timeout: 30_000,
      stdin: 'ignore',
      env: ghExecEnv(),
    }).catch(() => null);
    if (!result || result.exitCode !== 0) return null;
    return result.stdout;
  });
}

class GhPrListFailed extends Error {}

/**
 * Lists GitHub pull requests whose head branch matches `branch`, optionally bounding the wait
 * so callers like `/recent-commits` never stall on `gh` network calls. When `waitMs` expires,
 * the cached/empty list is returned with `pending: true` while the background fetch finishes
 * and fires {@link subscribePullRequestsSettled}.
 */
export async function listBranchPullRequestsState(
  repoPath: string,
  branch: string | null | undefined,
  remoteUrl: string | null | undefined,
  options: { refresh?: boolean; waitMs?: number } = {},
): Promise<{ prs: BranchPullRequest[]; pending: boolean; hasCached: boolean; stale: boolean }> {
  if (!branch || !remoteUrl) return { prs: [], pending: false, hasCached: false, stale: false };
  const parsedRemote = parseRemoteUrl(remoteUrl);
  if (parsedRemote?.kind !== 'github') return { prs: [], pending: false, hasCached: false, stale: false };
  // The same repository the app label names: `gh` must not fall back to its own default repository (a fork or an upstream).
  const remoteRepo = formatRemoteRepo(parsedRemote);
  if (!remoteRepo) return { prs: [], pending: false, hasCached: false, stale: false };

  // The remote is part of the key, so changing it never reuses the old remote's entry.
  const cacheKey = `${repoPath}\0${branch}\0${remoteRepo.toLowerCase()}`;
  let entry = branchPrCache.get(cacheKey);
  if (!options.refresh && entry && entry.value !== undefined && !entry.inFlight && entry.at > 0 && Date.now() - entry.at <= BRANCH_PR_TTL_MS && entry.failedAt === undefined) {
    return { prs: entry.value, pending: false, hasCached: true, stale: false };
  }
  if (!options.refresh && entry && !entry.inFlight && entry.failedAt !== undefined && Date.now() - entry.failedAt <= BRANCH_PR_FAILURE_RETRY_MS) {
    return { prs: entry.value ?? [], pending: false, hasCached: entry.value !== undefined, stale: entry.value !== undefined };
  }

  if (
    !options.refresh
    && !entry?.inFlight
    && !ghStatusInFlight
    && ghStatus
    && Date.now() - ghStatus.at <= GH_STATUS_TTL_MS
    && (!ghStatus.status.installed || !ghStatus.status.authenticated)
  ) {
    return { prs: entry?.value ?? [], pending: false, hasCached: entry?.value !== undefined, stale: entry?.value !== undefined };
  }

  if (!entry?.inFlight) {
    const gen = cacheGen;
    const targetEntry: BranchPrCacheEntry = entry ?? { at: 0, inFlight: null, hadTimeout: false };
    targetEntry.hadTimeout = false;
    branchPrCache.set(cacheKey, targetEntry);

    const fetchPromise = (async (): Promise<BranchPullRequest[]> => {
      const gh = await ghAvailable(Boolean(options.refresh));
      // A failed probe (signed out, gh gone) with PRs already known keeps them, stale, like a failed `pr list`; with none known it is just "no PRs".
      if (!gh.installed || !gh.authenticated) {
        if (targetEntry.value !== undefined) throw new GhPrListFailed();
        return [];
      }
      const stdout = await runGhPrList(repoPath, [
        '--repo',
        remoteRepo,
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,title,state,url,baseRefName,headRefOid,mergeCommit',
        '--limit',
        '50',
      ]);
      // A failed gh keeps the last good result (stale) rather than replacing it with an empty one.
      if (stdout === null) throw new GhPrListFailed();
      return parseBranchPullRequests(stdout);
    })()
      .then((prs) => {
        if (cacheGen === gen) {
          targetEntry.at = Date.now();
          targetEntry.value = prs;
          targetEntry.failedAt = undefined;
        }
        return prs;
      }, (error: unknown) => {
        if (!(error instanceof GhPrListFailed)) throw error;
        if (cacheGen === gen) targetEntry.failedAt = Date.now();
        return targetEntry.value ?? [];
      })
      .finally(() => {
        const timedOut = targetEntry.hadTimeout;
        if (targetEntry.inFlight === fetchPromise) {
          targetEntry.inFlight = null;
          targetEntry.hadTimeout = false;
        }
        if (cacheGen === gen && timedOut) {
          notifyPullRequestsSettled(repoPath);
        }
      });

    targetEntry.inFlight = fetchPromise;
    entry = targetEntry;
  }

  const inFlight = entry.inFlight!;
  const settledResult = (prs: BranchPullRequest[]) => ({
    prs,
    pending: false,
    hasCached: true,
    stale: entry!.failedAt !== undefined && entry!.value !== undefined,
  });
  if (options.waitMs === undefined) {
    return settledResult(await inFlight);
  }
  if (entry.hadTimeout) {
    return { prs: entry.value ?? [], pending: true, hasCached: entry.value !== undefined, stale: false };
  }
  if (options.waitMs <= 0) {
    entry.hadTimeout = true;
    return { prs: entry.value ?? [], pending: true, hasCached: entry.value !== undefined, stale: false };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    inFlight.then((prs) => ({ done: true as const, prs })),
    new Promise<{ done: false }>((resolve) => {
      timer = setTimeout(() => resolve({ done: false }), options.waitMs);
      timer.unref?.();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (settled.done) {
    return settledResult(settled.prs);
  }
  entry.hadTimeout = true;
  return { prs: entry.value ?? [], pending: true, hasCached: entry.value !== undefined, stale: false };
}

/**
 * Lists GitHub pull requests whose head branch matches `branch`.
 * Cached per repo+branch for 5 minutes unless `options.refresh` is true.
 * Never throws or surfaces an error when `gh` is absent, logged out, or the host is not GitHub.
 */
export async function listBranchPullRequests(
  repoPath: string,
  branch: string | null | undefined,
  remoteUrl: string | null | undefined,
  options: { refresh?: boolean } = {},
): Promise<BranchPullRequest[]> {
  const { prs } = await listBranchPullRequestsState(repoPath, branch, remoteUrl, options);
  return prs;
}

async function mergedPullRequestFor(input: MergeCheckInput): Promise<GhPullRequest | null> {
  if (!input.branch || !input.remoteUrl) return null;
  if (parseRemoteUrl(input.remoteUrl)?.kind !== 'github') return null;
  const remoteRepo = formatRemoteRepo(parseRemoteUrl(input.remoteUrl));
  if (!remoteRepo) return null;
  const gh = await ghAvailable();
  if (!gh.installed || !gh.authenticated) return null;
  const stdout = await runGhPrList(input.repoPath, [
    '--repo',
    remoteRepo,
    '--state',
    'merged',
    '--head',
    input.branch,
    '--json',
    'url,headRefOid,baseRefName',
    '--limit',
    '50',
  ]);
  if (stdout === null) return null;
  let prs: GhPullRequest[];
  try {
    prs = JSON.parse(stdout) as GhPullRequest[];
  } catch {
    return null;
  }
  return findMergedPullRequest(prs, input.sha, input.defaultBranch);
}

/**
 * The merged PR that proves `sha` landed on `defaultBranch`: its head must be
 * exactly that commit. A PR merged from an earlier tip proves nothing about
 * commits added afterwards.
 */
export function findMergedPullRequest(prs: GhPullRequest[], sha: string, defaultBranch: string): GhPullRequest | null {
  return prs.find((pr) => pr.headRefOid === sha && pr.baseRefName === defaultBranch) ?? null;
}

/**
 * Decides whether `sha` is proven merged into the default branch.
 * Never throws: an unreadable repository reports "not proven merged".
 */
export async function checkMerged(input: MergeCheckInput): Promise<MergeCheck> {
  const ref = await resolveDefaultRef(input.repoPath, input.defaultBranch);
  if (ref && await isAncestor(input.repoPath, input.sha, ref)) {
    return {
      merged: true,
      evidence: 'ancestor',
      detail: `contained in ${ref.replace(/^refs\/(remotes\/)?(heads\/)?/, '')}`,
    };
  }
  if (input.usePullRequests !== false) {
    const pr = await mergedPullRequestFor(input);
    if (pr) {
      return {
        merged: true,
        evidence: 'pull-request',
        detail: `merged through ${pr.url ?? 'a pull request'} at this exact commit`,
        prUrl: pr.url,
      };
    }
  }
  return {
    merged: false,
    evidence: 'none',
    detail: ref
      ? `not contained in ${ref.replace(/^refs\/(remotes\/)?(heads\/)?/, '')} and no merged pull request for this exact commit`
      : `default branch "${input.defaultBranch}" not found`,
  };
}
