/** Git history and optional remote synchronization for the workspace artifact repo. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';

import { readGenerationLock } from './generation-lock.js';
import { acquireLock } from './locks.js';
import { BRAND_NAME, CLI_NAME } from './constants.js';

const CORE_ARTIFACTS = [
  '.gitignore',
  'AGENTS.md',
  'CLAUDE.md',
  // No longer generated; listed so a refresh's removal of an old one is committed.
  'WORKSPACE.md',
  'contextspace.json',
  'contextspace.lock',
  'contextspace-knowledge.md',
  // The board's cards, links and places: authored by people and AIs, so it travels with the plan.
  'contextspace-board.json',
  'PLAN.md',
  'contextspace-plan.md',
  'contextspace-plan.json',
  'contextspace-milestones.md',
  '.contextspace/resources.json',
  '.contextspace/resources.lock.json',
  'nexusflow.json',
  'nexusflow.lock',
  'nexusflow-knowledge.md',
  'nexusflow-plan.md',
  '.nexusflow/resources.json',
  '.nexusflow/resources.lock.json',
  '.vscode/settings.json',
  '.cursor/mcp.json',
];

async function exists(workspacePath: string, relativePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(workspacePath, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function ensureWorkspaceGitRepository(workspacePath: string): Promise<void> {
  const probe = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: workspacePath, reject: false });
  if (probe.exitCode !== 0 || path.resolve(probe.stdout.trim()) !== path.resolve(workspacePath)) {
    await execa('git', ['init'], { cwd: workspacePath });
  }
  const name = await execa('git', ['config', '--local', 'user.name'], { cwd: workspacePath, reject: false });
  if (name.exitCode !== 0 || !name.stdout.trim()) {
    await execa('git', ['config', '--local', 'user.name', BRAND_NAME], { cwd: workspacePath });
  }
  const email = await execa('git', ['config', '--local', 'user.email'], { cwd: workspacePath, reject: false });
  if (email.exitCode !== 0 || !email.stdout.trim()) {
    await execa('git', ['config', '--local', 'user.email', `${CLI_NAME}@local`], { cwd: workspacePath });
  }
}

/** Older planning files, and the plan store PLAN.md replaced, are kept here (core/plan-import, core/plan-file-store), and committed. */
const ARCHIVE_DIR = '.contextspace/archive';

async function archivedFiles(workspacePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(workspacePath, ARCHIVE_DIR), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && (entry.name.endsWith('.md') || /^contextspace-plan-.*\.json$/.test(entry.name))).map((entry) => `${ARCHIVE_DIR}/${entry.name}`);
  } catch {
    return [];
  }
}

export async function managedWorkspaceArtifacts(workspacePath: string, extra: string[] = []): Promise<string[]> {
  const lock = await readGenerationLock(workspacePath);
  const workspaceFile = `${path.basename(workspacePath)}.code-workspace`;
  const candidates = new Set([...CORE_ARTIFACTS, workspaceFile, ...Object.keys(lock?.outputs ?? {}), ...(await archivedFiles(workspacePath)), ...extra]);
  const safe = [...candidates].filter((item) =>
    item && !path.isAbsolute(item) && !item.replace(/\\/g, '/').split('/').includes('..'),
  );
  const present: string[] = [];
  for (const item of safe) if (await exists(workspacePath, item)) present.push(item.replace(/\\/g, '/'));
  return present.sort();
}

export async function commitWorkspaceArtifacts(
  workspacePath: string,
  message: string,
  extra: string[] = [],
): Promise<{ committed: boolean; sha?: string }> {
  await fs.mkdir(path.join(workspacePath, '.contextspace'), { recursive: true });
  const release = await acquireLock(path.join(workspacePath, '.contextspace', 'workspace-git.lock'), {
    staleMs: 60_000, timeoutMs: 30_000,
    timeoutMessage: 'Another ContextSpace operation is updating the workspace artifact repository.',
  });
  try {
    await ensureWorkspaceGitRepository(workspacePath);
    const artifacts = await managedWorkspaceArtifacts(workspacePath, extra);

    // Also discover any tracked candidate artifacts that were deleted on disk (e.g. legacy files after migration)
    const lock = await readGenerationLock(workspacePath);
    const workspaceFile = `${path.basename(workspacePath)}.code-workspace`;
    const candidates = new Set([...CORE_ARTIFACTS, workspaceFile, ...Object.keys(lock?.outputs ?? {}), ...extra]);
    const deletedProbe = await execa('git', ['ls-files', '--deleted'], { cwd: workspacePath, reject: false });
    const deletedTracked = deletedProbe.exitCode === 0
      ? deletedProbe.stdout.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)
      : [];
    const deletedCandidates = deletedTracked.filter((item) => candidates.has(item));

    const allTargets = [...artifacts, ...deletedCandidates];
    if (!allTargets.length) return { committed: false };

    if (artifacts.length) {
      await execa('git', ['add', '--', ...artifacts], { cwd: workspacePath });
    }
    if (deletedCandidates.length) {
      await execa('git', ['add', '-A', '--', ...deletedCandidates], { cwd: workspacePath });
    }

    const diff = await execa('git', ['diff', '--cached', '--quiet', '--', ...allTargets], { cwd: workspacePath, reject: false });
    if (diff.exitCode === 0) return { committed: false };
    if (diff.exitCode !== 1) throw new Error('Could not inspect staged workspace artifacts.');
    await execa('git', ['commit', '-m', message, '--', ...allTargets], { cwd: workspacePath });
    const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: workspacePath });
    return { committed: true, sha: stdout.trim() };
  } finally {
    await release();
  }
}

export async function commitExactWorkspaceArtifacts(
  workspacePath: string,
  message: string,
  relativePaths: string[],
): Promise<{ committed: boolean; sha?: string }> {
  await fs.mkdir(path.join(workspacePath, '.contextspace'), { recursive: true });
  const release = await acquireLock(path.join(workspacePath, '.contextspace', 'workspace-git.lock'), {
    staleMs: 60_000, timeoutMs: 30_000,
    timeoutMessage: 'Another ContextSpace operation is updating the workspace artifact repository.',
  });
  try {
    await ensureWorkspaceGitRepository(workspacePath);
    const artifacts = (await managedWorkspaceArtifacts(workspacePath, relativePaths))
      .filter((item) => relativePaths.map((candidate) => candidate.replace(/\\/g, '/')).includes(item));
    if (!artifacts.length) return { committed: false };
    await execa('git', ['add', '--', ...artifacts], { cwd: workspacePath });
    const diff = await execa('git', ['diff', '--cached', '--quiet', '--', ...artifacts], { cwd: workspacePath, reject: false });
    if (diff.exitCode === 0) return { committed: false };
    if (diff.exitCode !== 1) throw new Error('Could not inspect staged workspace artifacts.');
    await execa('git', ['commit', '-m', message, '--', ...artifacts], { cwd: workspacePath });
    const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: workspacePath });
    return { committed: true, sha: stdout.trim() };
  } finally {
    await release();
  }
}

export async function addWorkspaceRemote(workspacePath: string, url: string): Promise<void> {
  await ensureWorkspaceGitRepository(workspacePath);
  const existing = await execa('git', ['remote', 'get-url', 'origin'], { cwd: workspacePath, reject: false });
  if (existing.exitCode === 0) throw new Error(`Workspace remote "origin" already exists (${existing.stdout.trim()}).`);
  await execa('git', ['remote', 'add', 'origin', url], { cwd: workspacePath });
}

/** Whether the workspace artifact repository has a remote, and where. `url` is safe to display. */
export type WorkspaceRemote =
  | { state: 'configured'; name: string; url: string }
  | { state: 'none' };

/** A remote URL that is safe to show: a `user:token@` part is replaced, since a URL can embed a credential. */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@');
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  const real = (target: string) => fs.realpath(target).catch(() => path.resolve(target));
  return (await real(a)) === (await real(b));
}

/**
 * Read-only: runs `git remote` and nothing that touches the network. A workspace folder that is
 * not its own git repository (nothing has been committed yet) has no remote.
 */
export async function getWorkspaceRemote(workspacePath: string): Promise<WorkspaceRemote> {
  const top = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: workspacePath, reject: false });
  if (top.exitCode !== 0 || !(await sameDirectory(top.stdout.trim(), workspacePath))) return { state: 'none' };
  const list = await execa('git', ['remote'], { cwd: workspacePath, reject: false });
  const names = list.exitCode === 0 ? list.stdout.split('\n').map((name) => name.trim()).filter(Boolean) : [];
  const name = names.includes('origin') ? 'origin' : names[0];
  if (!name) return { state: 'none' };
  const url = await execa('git', ['remote', 'get-url', name], { cwd: workspacePath, reject: false });
  return { state: 'configured', name, url: redactRemoteUrl(url.exitCode === 0 ? url.stdout.trim() : '') };
}

async function currentBranch(workspacePath: string): Promise<string> {
  const { stdout } = await execa('git', ['branch', '--show-current'], { cwd: workspacePath });
  const branch = stdout.trim();
  if (!branch) throw new Error('Workspace artifact repository is in detached HEAD state.');
  return branch;
}

export async function pushWorkspaceArtifacts(workspacePath: string): Promise<void> {
  await ensureWorkspaceGitRepository(workspacePath);
  const branch = await currentBranch(workspacePath);
  await execa('git', ['push', '-u', 'origin', branch], { cwd: workspacePath });
}

export async function pullWorkspaceArtifacts(workspacePath: string): Promise<void> {
  await ensureWorkspaceGitRepository(workspacePath);
  const dirty = await execa('git', ['status', '--porcelain'], { cwd: workspacePath });
  if (dirty.stdout.trim()) throw new Error('Workspace artifact repository has uncommitted changes; commit them before pulling.');
  const branch = await currentBranch(workspacePath);
  await execa('git', ['pull', '--rebase', 'origin', branch], { cwd: workspacePath });
}
