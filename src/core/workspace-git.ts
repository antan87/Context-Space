/** Git history and optional remote synchronization for the workspace artifact repo. */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

import { readGenerationLock } from './generation-lock.js';
import { acquireLock } from './locks.js';
import { BRAND_NAME, CLI_NAME } from './constants.js';
import { WorkspaceMovedError, readSwitch } from './workspace-db-switch.js';
import { assertWorkspaceActive } from './archive-guard.js';
import { loadFeatureConfig } from './workspace.js';
import { readAppDb, withAppDbWriteLock } from './workspace-db-app.js';
import { readExportBytes } from './workspace-db-draft-files.js';
import { runGitDraftWithWriteLockHeld } from './workspace-db-write.js';
import { committedCheckoutText, committedDataExport, committedPlanExport, DATA_EXPORT, gitCommitId, latestExport, PLAN_EXPORT } from './workspace-db/export-records.js';
import { readImportRecord, WorkspaceDbError } from './workspace-db/index.js';

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
const DB_IGNORE = '.contextspace/.gitignore';
const PLAN_PAIR = [PLAN_EXPORT, DATA_EXPORT] as const;

function privateDbArtifact(file: string): boolean {
  return /^\.contextspace\/(?:drafts(?:\/|$)|\.export-|archive\/pre-db-|\.db-staging-|workspace\.db|backups(?:\/|$)|workspace-db-switch\.json$)/.test(file);
}

const localPullArtifact = (file: string) => privateDbArtifact(file)
  || file === '.contextspace/workspace-git.lock' || file === '.contextspace/plan-file.lock';

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
  const movedArtifacts = readSwitch(workspacePath)?.state === 'on' ? [DATA_EXPORT, DB_IGNORE] : [];
  const candidates = new Set([...CORE_ARTIFACTS, ...movedArtifacts, workspaceFile, ...Object.keys(lock?.outputs ?? {}), ...(await archivedFiles(workspacePath)), ...extra]);
  const safe = [...candidates].filter((item) =>
    item && !path.isAbsolute(item) && !item.replace(/\\/g, '/').split('/').includes('..'),
  );
  const present: string[] = [];
  for (const item of safe) {
    const relative = path.posix.normalize(item.replace(/\\/g, '/'));
    if (!privateDbArtifact(relative) && await exists(workspacePath, relative)) present.push(relative);
  }
  return present.sort();
}

async function lockWorkspaceGit(workspacePath: string) {
  return acquireLock(path.join(workspacePath, '.contextspace', 'workspace-git.lock'), {
    staleMs: 60_000, timeoutMs: 30_000,
    timeoutMessage: 'Another ContextSpace operation is updating the workspace artifact repository.',
  });
}

async function publishedPair(workspacePath: string): Promise<Map<string, Buffer> | null> {
  await runGitDraftWithWriteLockHeld(workspacePath, { type: 'draft-refresh' });
  const latest = await readAppDb(workspacePath, (view) => PLAN_PAIR.map((file) => latestExport(view.sqlite, file)?.text));
  const visible = await Promise.all(PLAN_PAIR.map((file) => readExportBytes(path.join(workspacePath, file))));
  const verified = await Promise.all(PLAN_PAIR.map(async (file, index) => {
    const text = latest[index];
    const bytes = visible[index];
    if (text === undefined || !bytes) return false;
    const observed = bytes.toString('utf8');
    return bytes.equals(Buffer.from(text)) || (bytes.equals(Buffer.from(observed)) && await committedCheckoutText(workspacePath, file, observed) === text);
  }));
  if (!verified.every(Boolean)) return null;
  return new Map(PLAN_PAIR.map((file, index) => [file, Buffer.from(latest[index]!)]));
}

/** Commit the selected artifacts through a private index. Git never rereads the validated pair. */
async function commitPublishedPair(workspacePath: string, message: string, targets: string[], pair: ReadonlyMap<string, Buffer>) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'contextspace-commit-'));
  const ordinary = { cwd: workspacePath };
  const isolated = { cwd: workspacePath, env: { GIT_INDEX_FILE: path.join(temp, 'index') } };
  try {
    const head = await execa('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { ...ordinary, reject: false });
    await execa('git', ['read-tree', head.exitCode === 0 ? head.stdout : '--empty'], isolated);
    const other = targets.filter((file) => !pair.has(file));
    if (other.length) await execa('git', ['add', '-A', '--', ...other], isolated);
    for (const [file, bytes] of pair) {
      // The export header covers exact bytes, including the plan's chosen line endings.
      const { stdout: oid } = await execa('git', ['hash-object', '-w', '--no-filters', '--stdin'], { ...isolated, input: bytes });
      await execa('git', ['update-index', '--add', '--cacheinfo', `100644,${oid},${file}`], isolated);
    }
    const diff = await execa('git', ['diff', '--cached', '--quiet'], { ...isolated, reject: false });
    if (diff.exitCode === 0) return { committed: false };
    if (diff.exitCode !== 1) throw new Error('Could not inspect staged workspace artifacts.');
    await execa('git', ['commit', '-m', message], isolated);
    const { stdout: sha } = await execa('git', ['rev-parse', 'HEAD'], ordinary);
    // Bring only these paths in the real index up to the commit. The working tree and unrelated staged paths stay put.
    await execa('git', ['reset', '--quiet', sha, '--', ...targets], ordinary).catch(() => {
      throw new Error(`Workspace artifacts were committed as ${sha}, but Git could not refresh their staging entries.`);
    });
    return { committed: true, sha };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function commitWorkspaceArtifacts(
  workspacePath: string,
  message: string,
  extra: string[] = [],
): Promise<{ committed: boolean; sha?: string }> {
  const release = await lockWorkspaceGit(workspacePath);
  try {
    const moved = readSwitch(workspacePath);
    const commit = async (includeExports: boolean, pinnedPair?: ReadonlyMap<string, Buffer>) => {
      const allowed = (file: string) => !privateDbArtifact(file) && (includeExports || !PLAN_PAIR.some((name) => name === file));
      await ensureWorkspaceGitRepository(workspacePath);
      const artifacts = (await managedWorkspaceArtifacts(workspacePath, extra)).filter(allowed);

      // Track deletion of a managed legacy file or a restored snapshot as well.
      const lock = await readGenerationLock(workspacePath);
      const workspaceFile = `${path.basename(workspacePath)}.code-workspace`;
      const candidates = new Set([...CORE_ARTIFACTS, DATA_EXPORT, DB_IGNORE, workspaceFile, ...Object.keys(lock?.outputs ?? {}), ...extra]);
      const deletedProbe = await execa('git', ['ls-files', '--deleted'], { cwd: workspacePath, reject: false });
      const deletedTracked = deletedProbe.exitCode === 0
        ? deletedProbe.stdout.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)
        : [];
      const deletedCandidates = deletedTracked.filter((item) => candidates.has(item) && allowed(item));

      const allTargets = [...new Set([...artifacts, ...deletedCandidates, ...(pinnedPair?.keys() ?? [])])];
      if (!allTargets.length) return { committed: false };
      if (pinnedPair) return commitPublishedPair(workspacePath, message, allTargets, pinnedPair);

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
    };
    if (!moved) return await commit(true);
    if (moved.state !== 'on') return await commit(false);
    return await withAppDbWriteLock(workspacePath, async () => {
      const pair = await publishedPair(workspacePath);
      return commit(Boolean(pair), pair ?? undefined);
    });
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

export type WorkspacePullResult = { status: 'pulled' } | { status: 'draft'; digest: string; pending: boolean };
const dirtyWorkspace = () => new Error('Workspace artifact repository has uncommitted changes; commit them before pulling.');

export async function pullWorkspaceArtifacts(workspacePath: string): Promise<WorkspacePullResult> {
  const moved = readSwitch(workspacePath);
  if (!moved) {
    await ensureWorkspaceGitRepository(workspacePath);
    if ((await changedWorkspacePaths(workspacePath, false)).length) throw dirtyWorkspace();
    const branch = await currentBranch(workspacePath);
    await execa('git', ['pull', '--rebase', 'origin', branch], { cwd: workspacePath });
    return { status: 'pulled' };
  }
  if (moved.state !== 'on') throw new WorkspaceMovedError(moved);
  const release = await lockWorkspaceGit(workspacePath);
  try {
    const validate = async () => {
      assertWorkspaceActive(await loadFeatureConfig(workspacePath), 'pull workspace artifacts');
      await readAppDb(workspacePath, (view) => {
        const record = readImportRecord(view);
        const active = readSwitch(workspacePath);
        if (record?.status !== 'done' || record.id !== active?.id) {
          throw new WorkspaceDbError('invalid', 'The workspace database does not match its completed move. See `ctxspace plan migrate --status` before pulling.');
        }
      });
    };
    await validate();
    await ensureWorkspaceGitRepository(workspacePath);
    if ((await changedWorkspacePaths(workspacePath, true)).some((file) => !PLAN_PAIR.some((name) => name === file))) throw dirtyWorkspace();
    const branch = await currentBranch(workspacePath);
    await execa('git', ['fetch', 'origin', branch], { cwd: workspacePath });
    const { stdout: incoming } = await execa('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { cwd: workspacePath });
    if (!gitCommitId(incoming)) throw new Error('Git did not return an exact fetched commit.');
    const { stdout: tracked } = await execa('git', ['ls-tree', '-r', '-z', '--name-only', incoming, '--', '.contextspace'], { cwd: workspacePath });
    if (tracked.split('\0').some((file) => file === '.contextspace' || localPullArtifact(file)
      || /^\.contextspace\/(?:state\.json|workspace-state\.json)$/.test(file))) {
      throw new Error('The fetched workspace contains local database files. Remove them from the incoming Git commit before pulling.');
    }
    return await withAppDbWriteLock(workspacePath, async () => {
      await validate();
      const dirty = await changedWorkspacePaths(workspacePath, true);
      if (dirty.some((file) => !PLAN_PAIR.some((name) => name === file))) throw dirtyWorkspace();
      if (await currentBranch(workspacePath) !== branch) throw new Error('The workspace artifact branch changed during the fetch. Try pulling again.');
      const git = (args: string[]) => execa('git', args, { cwd: workspacePath, reject: false });
      const head = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout;
      const common = gitCommitId(head) ? (await git(['merge-base', head, incoming])).stdout : '';
      const base = gitCommitId(common) ? await committedDataExport(workspacePath, common) : undefined;
      const data = await committedDataExport(workspacePath, incoming);
      const remotePlanChanged = base && data && base.digest !== data.digest;
      const localPlanChanged = common !== head && gitCommitId(common)
        && (await git(['diff', '--quiet', common, head, '--', ...PLAN_PAIR])).exitCode === 1;
      if (remotePlanChanged && (dirty.length || localPlanChanged)) {
        const saved = await runGitDraftWithWriteLockHeld(workspacePath, { type: 'draft-capture-git', data: data.text, mergeBase: common });
        return { status: 'draft', digest: saved.digest, pending: saved.status === 'pending' };
      }
      if (dirty.length) throw dirtyWorkspace();
      for (const dir of ['rebase-merge', 'rebase-apply']) {
        const marker = await git(['rev-parse', '--path-format=absolute', '--git-path', dir]);
        if (marker.exitCode === 0 && await fs.access(marker.stdout).then(() => true, () => false)) {
          throw new Error('The workspace already has a Git rebase in progress. Finish it before pulling.');
        }
      }
      if (head !== incoming) {
        const rebased = await git(['rebase', '--no-autostash', incoming]);
        if (rebased.exitCode !== 0) {
          await git(['rebase', '--abort']);
          throw rebased;
        }
      }
      const gitReceipt = common === head && base && data
        ? { data: data.text, plan: await committedPlanExport(workspacePath, incoming), base } : undefined;
      await runGitDraftWithWriteLockHeld(workspacePath, { type: 'draft-refresh', gitReceipt });
      return { status: 'pulled' };
    });
  } finally {
    await release();
  }
}

async function changedWorkspacePaths(workspacePath: string, moved: boolean): Promise<string[]> {
  const dirty = await execa('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], { cwd: workspacePath });
  return dirty.stdout.split('\0')
    .filter((entry) => entry && (!moved || !entry.startsWith('?? ') || !localPullArtifact(entry.slice(3))))
    .map((entry) => entry.slice(3));
}
