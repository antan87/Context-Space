/**
 * @module core/analysis-cache
 * Persists per-repo analysis results in `.nexusflow-analysis-cache.json` at the
 * workspace root, keyed by this package's version plus a git content fingerprint
 * (HEAD SHA plus a signature of dirty files). Lets refresh/sync re-analyze only
 * repos whose content actually changed, while still re-running everything after
 * an upgrade so the generators never read stale analysis.
 */

import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import type { ProjectAnalysis } from '../types.js';
import { parsePorcelainZ } from '../utils/multi-git.js';
import { resolveWorkspaceFilePath, resolveWorkspaceFilePathSync, BRAND_NAME, CLI_NAME } from './constants.js';

/** Memoised own version; resolved once per process. */
let generatorVersion: string | undefined;

/**
 * This package's version, used as part of every repo fingerprint.
 *
 * Read locally rather than via `utils/update-check`, which drags config loading
 * and the network update check into `core/`.
 */
export function getGeneratorVersion(): string {
  if (generatorVersion !== undefined) return generatorVersion;

  let resolved: string | undefined;
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const manifest = path.join(dir, 'package.json');
      if (existsSync(manifest)) {
        resolved = (JSON.parse(readFileSync(manifest, 'utf-8')) as { version?: string }).version;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the warning below.
  }

  if (!resolved) {
    // Say so rather than degrade quietly. A constant prefix keeps cache hits
    // correct within one installed copy, but it stops an upgrade from
    // invalidating anything — which is the whole reason the version is in the
    // key, so a silent fallback would restore the bug it was added to fix.
    console.warn(
      `  ⚠ Could not read ${BRAND_NAME}'s own version, so cached analysis will not be ` +
      `invalidated by an upgrade. Run \`${CLI_NAME} refresh --force\` after upgrading.`,
    );
    resolved = 'unknown';
  }

  generatorVersion = resolved;
  return resolved;
}

/** A cached analysis result for a single repo. */
export interface AnalysisCacheEntry {
  /** Directory name of the repo. */
  repoName: string;
  /** Content fingerprint of the repo when the analysis ran. */
  fingerprint: string;
  /** ISO timestamp of when the analysis ran. */
  analyzedAt: string;
  /** The cached analysis result. */
  analysis: ProjectAnalysis;
}

/** On-disk shape of the analysis cache. */
export interface AnalysisCache {
  version: 1;
  /** Entries keyed by repo name. */
  repos: Record<string, AnalysisCacheEntry>;
}

/**
 * Returns the path to the analysis cache file for a workspace.
 */
export function getAnalysisCachePath(workspacePath: string): string {
  return resolveWorkspaceFilePathSync(workspacePath, 'analysisCache').path;
}

/**
 * Loads the analysis cache, returning an empty skeleton when the file does
 * not exist or cannot be parsed.
 *
 * @param workspacePath - Absolute path to the workspace root.
 */
export async function loadAnalysisCache(
  workspacePath: string,
): Promise<AnalysisCache> {
  try {
    const resolved = await resolveWorkspaceFilePath(workspacePath, 'analysisCache');
    const raw = await fs.readFile(resolved.path, 'utf-8');
    const cache = JSON.parse(raw) as AnalysisCache;
    if (!cache.repos || typeof cache.repos !== 'object') {
      cache.repos = {};
    }
    return cache;
  } catch {
    return { version: 1, repos: {} };
  }
}

/**
 * Saves the analysis cache, pruning entries for repos that are no longer in
 * the given list of current repo names.
 *
 * @param workspacePath    - Absolute path to the workspace root.
 * @param cache            - The cache to persist.
 * @param currentRepoNames - Names of repos currently in the workspace; when
 *                           provided, entries for other repos are dropped.
 */
export async function saveAnalysisCache(
  workspacePath: string,
  cache: AnalysisCache,
  currentRepoNames?: string[],
): Promise<void> {
  if (currentRepoNames) {
    for (const name of Object.keys(cache.repos)) {
      if (!currentRepoNames.includes(name)) {
        delete cache.repos[name];
      }
    }
  }
  const resolved = await resolveWorkspaceFilePath(workspacePath, 'analysisCache');
  const data = JSON.stringify(cache, null, 2) + '\n';
  await fs.writeFile(resolved.path, data, 'utf-8');
}

export interface RepoFingerprintOptions {
  /**
   * What to do with an uncommitted regular file when the platform has no no-follow open flag.
   * `'fail'` (default) returns null. `'metadata'` fingerprints it by `lstat` size and timestamps.
   */
  unsafeRead?: 'fail' | 'metadata';
  /** Test seam: pretend the platform does (true) or does not (false) have a no-follow open flag. */
  hasNoFollow?: boolean;
}

/**
 * Computes a content fingerprint for a repo: this package's version, the HEAD
 * commit SHA, and a hash of each dirty path plus its actual bytes (or symlink
 * target) when the tree is not clean. Editing, adding, or deleting an
 * uncommitted file therefore changes the fingerprint even when its size and
 * directory metadata stay unchanged. Platforms without a no-follow file-open
 * flag fail closed for dirty regular files and return `null`, forcing analysis
 * instead of reusing a cache based on an unsafe read.
 *
 * The version is part of the key so that upgrading NexusFlow re-runs the
 * analysis the generators read from. Keyed on repo content alone, an upgrade that
 * improved them reached no existing workspace until someone happened to run
 * `refresh --force`. Including the version costs one local re-analysis per
 * upgrade — file IO, no tokens — and makes stale context impossible to serve by
 * default.
 *
 * Freshness checks (`generation-lock`) may ask for `unsafeRead: 'metadata'`. Where the platform
 * cannot open a file without following links, they then get a fingerprint built from each
 * uncommitted file's size and timestamps instead of nothing. Reading metadata with `lstat` opens no
 * file and follows no link, so the race above does not apply. It is weaker than hashing the bytes
 * (an edit that keeps both the size and the timestamps goes unseen), which is acceptable for
 * "has this changed since the context was generated?" but not for reusing a cached analysis, so
 * the default stays fail-closed.
 *
 * @param repoPath - Absolute path to the repo root.
 * @returns The fingerprint, or null when git fails (caller should re-analyze).
 */
export async function getRepoFingerprint(
  repoPath: string,
  options: RepoFingerprintOptions = {},
): Promise<string | null> {
  try {
    const prefix = `nf${getGeneratorVersion()}:`;

    const { stdout: shaOut } = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
    });
    const sha = shaOut.trim();

    // `-uall` is essential: plain porcelain collapses an untracked directory to
    // `?? newdir/`, so editing a file inside it leaves the directory metadata
    // unchanged and used to produce a false cache hit / false "fresh" result.
    const { stdout: statusOut } = await execa('git', ['status', '--porcelain=v1', '-z', '-uall'], {
      cwd: repoPath,
    });
    const entries = parsePorcelainZ(statusOut);
    if (entries.length === 0) {
      return `${prefix}${sha}`;
    }

    const dirty = createHash('sha256');
    for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      dirty.update(entry.code).update('\0').update(entry.path).update('\0');
      const filePath = path.join(repoPath, entry.path);
      try {
        // Reading the link itself never follows it. For ordinary files, the
        // no-follow flag closes the lstat/read race where an untrusted worktree
        // could swap a checked file for a symlink before its bytes were read.
        const target = await fs.readlink(filePath);
        dirty.update('symlink\0').update(target);
      } catch {
        if (!(options.hasNoFollow ?? typeof constants.O_NOFOLLOW === 'number')) {
          // Windows does not expose O_NOFOLLOW. An ordinary read after the
          // failed readlink probe would reintroduce a symlink-swap race, so
          // disable cache reuse for this dirty snapshot and reanalyze it, unless
          // the caller only needs to notice a change and accepts metadata.
          if (options.unsafeRead !== 'metadata') return null;
          try {
            const stat = await fs.lstat(filePath);
            dirty.update('meta\0').update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`);
          } catch {
            dirty.update('missing\0');
          }
        } else {
          try {
            const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
            dirty.update('file\0').update(await fs.readFile(filePath, { flag: flags }));
          } catch {
            // Deletions have no bytes to read; their status and path above are the
            // complete retained state that must invalidate the snapshot.
            dirty.update('missing\0');
          }
        }
      }
      dirty.update('\0');
    }

    const dirtyHash = dirty.digest('hex').slice(0, 12);
    return `${prefix}${sha}+${dirtyHash}`;
  } catch {
    return null;
  }
}
