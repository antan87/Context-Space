/**
 * @module core/workspace-state
 * Persists per-repo sync/validation state for a workspace in a single
 * `.nexusflow-state.json` file at the workspace root.
 *
 * Mirrors the lightweight state-file pattern used by `orchestration/runner.ts`
 * for running services. Tracks, per repo: when it was last synced, the
 * classified result, whether it is pending re-validation, and the last
 * validation outcome — so agents no longer need to hand-roll their own state.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { acquireLock, createMutationQueue } from './locks.js';
import { atomicWriteJson } from '../resources/fs-safety.js';

import type { RepoSyncState, SyncStatus, WorkspaceState, WorkspaceVerificationReport } from '../types.js';
import { BRAND_CONFIG, resolveWorkspaceFilePath, resolveWorkspaceFilePathSync } from './constants.js';

/**
 * Returns the path to the workspace state file (primary or legacy fallback).
 */
export function getStatePath(workspacePath: string): string {
  return resolveWorkspaceFilePathSync(workspacePath, 'state').path;
}

/**
 * Loads the workspace state from disk, returning an empty skeleton when the
 * file does not exist or cannot be parsed. Mutations use strict reads to avoid
 * overwriting unreadable or corrupt state.
 *
 * @param workspacePath - Absolute path to the workspace root.
 */
export async function loadWorkspaceState(
  workspacePath: string,
  options: { strict?: boolean } = {},
): Promise<WorkspaceState> {
  try {
    const resolved = await resolveWorkspaceFilePath(workspacePath, 'state');
    const raw = await fs.readFile(resolved.path, 'utf-8');
    const state = JSON.parse(raw) as WorkspaceState;
    // Defend against a malformed/legacy file lacking the repos map.
    if (!state.repos || typeof state.repos !== 'object') {
      state.repos = {};
    }
    state.workspacePath = workspacePath;
    return state;
  } catch (error) {
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      workspacePath,
      repos: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Saves the workspace state to disk.
 *
 * @param state - The state to persist. Its `updatedAt` is refreshed on write.
 */
export async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  const primaryPath = path.join(state.workspacePath, BRAND_CONFIG.files.state.primary);
  const toWrite: WorkspaceState = { ...state, updatedAt: new Date().toISOString() };
  await atomicWriteJson(primaryPath, toWrite);
  const legacyFiles = [
    BRAND_CONFIG.files.state.legacy,
    ...(BRAND_CONFIG.files.state.fallbacks ?? []),
  ];
  for (const file of legacyFiles) {
    const candidatePath = path.join(state.workspacePath, file);
    if (candidatePath !== primaryPath) {
      try {
        await fs.unlink(candidatePath);
      } catch {}
    }
  }
}

const runWorkspaceConfigMutation = createMutationQueue();

/** Mutate fresh state under a cross-process lock; keep callbacks short and synchronous. */
export async function mutateWorkspaceState<T>(
  workspacePath: string,
  mutation: (state: WorkspaceState) => T,
): Promise<T> {
  return runWorkspaceConfigMutation(async () => {
    const root = await fs.realpath(workspacePath);
    const lockPath = resolveWorkspaceFilePathSync(root, 'stateLock').path;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const release = await acquireLock(lockPath, {
      staleMs: 60_000,
      timeoutMs: 10_000,
      timeoutMessage: 'Workspace state is busy. Retry the operation.',
    });
    try {
      const state = await loadWorkspaceState(root, { strict: true });
      const result = mutation(state);
      await saveWorkspaceState(state);
      return result;
    } finally {
      await release();
    }
  });
}

/**
 * Records the outcome of a sync attempt for a single repo and persists it.
 *
 * Sets `pendingValidation` to true when new commits were pulled in
 * (`status === 'rebased'`), signalling that the repo should be re-validated.
 *
 * @param workspacePath - Absolute path to the workspace root.
 * @param repoName      - Directory name of the repo.
 * @param result        - The classified sync status and message.
 * @returns The updated per-repo state entry.
 */
export async function recordRepoSync(
  workspacePath: string,
  repoName: string,
  result: { status: SyncStatus; message: string },
): Promise<RepoSyncState> {
  return mutateWorkspaceState(workspacePath, (state) => {
    const existing = state.repos[repoName] ?? { repoName };

    const updated: RepoSyncState = {
      ...existing,
      repoName,
      lastSyncedAt: new Date().toISOString(),
      lastSyncStatus: result.status,
      lastSyncMessage: result.message,
      // New commits landed → the repo needs re-validation. Preserve an existing
      // pending flag otherwise (a no-op sync doesn't clear prior pending work).
      pendingValidation:
        result.status === 'rebased' ? true : existing.pendingValidation ?? false,
    };

    state.repos[repoName] = updated;
    return updated;
  });
}

/**
 * Records the result of a validation run (e.g. tests/e2e) for a repo and clears
 * its pending-validation flag. Provided for the validation flow that consumes
 * `pendingValidation`.
 *
 * @param workspacePath - Absolute path to the workspace root.
 * @param repoName      - Directory name of the repo.
 * @param result        - Whether validation passed or failed.
 * @returns The updated per-repo state entry.
 */
export async function markValidated(
  workspacePath: string,
  repoName: string,
  result: 'pass' | 'fail',
): Promise<RepoSyncState> {
  return mutateWorkspaceState(workspacePath, (state) => {
    const existing = state.repos[repoName] ?? { repoName };

    const updated: RepoSyncState = {
      ...existing,
      repoName,
      lastValidationResult: result,
      lastValidatedAt: new Date().toISOString(),
      pendingValidation: false,
    };

    state.repos[repoName] = updated;
    return updated;
  });
}

/**
 * Records a full mechanical verification report for the workspace, updating
 * both top-level workspace state and individual repo validation results.
 *
 * @param workspacePath - Absolute path to the workspace root.
 * @param report        - The aggregate verification report to persist.
 * @returns The updated workspace state.
 */
export async function recordVerificationReport(
  workspacePath: string,
  report: WorkspaceVerificationReport,
): Promise<WorkspaceState> {
  return mutateWorkspaceState(workspacePath, (state) => {
    state.lastVerification = report;

    for (const repoReport of report.repos) {
      const existing = state.repos[repoReport.repoName] ?? { repoName: repoReport.repoName };
      const passed = repoReport.status === 'pass' || repoReport.status === 'pass_dirty';

      state.repos[repoReport.repoName] = {
        ...existing,
        repoName: repoReport.repoName,
        lastValidationResult: passed ? 'pass' : repoReport.status === 'no-tests' ? (existing.lastValidationResult ?? null) : 'fail',
        lastValidatedAt: repoReport.verifiedAt,
        pendingValidation: passed ? false : existing.pendingValidation,
        lastVerification: repoReport,
      };
    }

    return state;
  });
}

/**
 * Retrieves the latest recorded verification report for a workspace, if any.
 *
 * @param workspacePath - Absolute path to the workspace root.
 * @returns The last verification report or null if none recorded.
 */
export async function getLastVerificationReport(
  workspacePath: string,
): Promise<WorkspaceVerificationReport | null> {
  const state = await loadWorkspaceState(workspacePath);
  return state.lastVerification ?? null;
}

