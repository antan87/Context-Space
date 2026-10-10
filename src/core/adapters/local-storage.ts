import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { StoragePort, StorageAdapterMeta } from '../ports/storage.js';
import { atomicWriteFile, atomicWriteJson } from '../../resources/fs-safety.js';
import { resolveWorkspaceConfigDir } from '../constants.js';
import { acquireLock } from '../locks.js';
import {
  holdsStoreLock,
  mergeKnowledge,
  repoIdentityAsync,
  sourceRepoPath,
  storeDirFor,
  workspaceRepoIdentity,
  type RepoIdentity,
} from '../base-knowledge-store.js';

const MIGRATION_PASS_TTL_MS = 10_000;
const recentMigrationPasses = new Map<string, number>();

/** Test hook: forget which migration passes ran recently. */
export function resetMigrationPasses(): void {
  recentMigrationPasses.clear();
}

/** Per-source record of what was merged into a store file. */
interface StoreMigrations {
  identity?: RepoIdentity & { repoName: string };
  /** When every workspace in the workspaces folder was checked for older copies. */
  sweptAt?: string;
  sources: Record<string, { file: string; sha256: string; mergedAt: string; workspace: string; added: number; conflicts: string[] }>;
}

export class LocalStorageAdapter implements StoragePort {
  readonly meta: StorageAdapterMeta = {
    name: 'local',
    displayName: 'Local Workspace',
    description: 'Write context files directly into the workspace directory.',
    configFields: [],
  };

  /**
   * Base files outlive workspaces: they live in the user-level store keyed by
   * repository identity, shared by every workspace that includes the repo.
   * When the identity cannot be resolved (no manifest naming the repo, or its
   * checkout is gone) the workspace-local location is used, as before.
   */
  private baseFilePath(workspacePath: string, repoName: string, filename: string): string {
    const identity = workspaceRepoIdentity(workspacePath, repoName);
    return identity ? path.join(storeDirFor(identity), filename) : this.workspaceBaseFilePath(workspacePath, repoName, filename);
  }

  /**
   * Per-repo base files inside a workspace: where earlier versions kept them.
   * Their own directory keeps them apart from workspace-level files that share
   * a filename, and from each other across repos.
   */
  private workspaceBaseFilePath(workspacePath: string, repoName: string, filename: string): string {
    const configDir = resolveWorkspaceConfigDir(workspacePath).path;
    return path.join(configDir, 'base', repoName, filename);
  }

  /**
   * Merges this workspace's own copies of a base file into the user-level
   * store, once per source content. Idempotent; the originals are kept.
   */
  private async migrateWorkspaceBaseFile(workspacePath: string, repoName: string, filename: string): Promise<void> {
    const identity = workspaceRepoIdentity(workspacePath, repoName);
    if (!identity) return;
    const storeFile = path.join(storeDirFor(identity), filename);
    const recordPath = path.join(path.dirname(storeFile), 'migrations.json');
    const names = [filename, this.getFallbackFilename(filename)].filter((name): name is string => Boolean(name));
    const collect = async (owners: Array<{ workspacePath: string; repoName: string }>) => {
      const found: Array<{ file: string; content: string; sha256: string; workspace: string }> = [];
      const seen = new Set<string>();
      for (const owner of owners) {
        for (const name of names) {
          for (const file of [
            this.workspaceBaseFilePath(owner.workspacePath, owner.repoName, name),
            this.legacyBaseFilePath(owner.workspacePath, owner.repoName, name),
          ]) {
            const key = path.resolve(file);
            if (seen.has(key) || key === path.resolve(storeFile)) continue;
            seen.add(key);
            const content = await fs.readFile(file, 'utf8').catch(() => null);
            if (content === null) continue;
            found.push({ file, content, sha256: createHash('sha256').update(content).digest('hex'), workspace: owner.workspacePath });
          }
        }
      }
      return found;
    };
    // One knowledge operation reads, checks and writes the store several
    // times; after a pass, skip further passes for this workspace briefly.
    const memoKey = `${path.resolve(storeFile)}\0${path.resolve(workspacePath)}`;
    const lastPass = recentMigrationPasses.get(memoKey);
    if (lastPass !== undefined && Date.now() - lastPass < MIGRATION_PASS_TTL_MS) return;

    const readRecordQuick = async () => fs.readFile(recordPath, 'utf8').then((raw) => JSON.parse(raw) as StoreMigrations, () => null);
    const quick = await readRecordQuick();
    // The first use of a store checks every workspace that includes the repo,
    // so knowledge promoted in a workspace nobody has opened since is not missed.
    // A sweep that could not list the workspaces is not recorded as done.
    const swept = quick?.sweptAt ? [] : await workspacesWithRepo(identity);
    const sweepComplete = Boolean(quick?.sweptAt) || swept !== null;
    const owners = [{ workspacePath, repoName }, ...(swept ?? [])];
    const sources = await collect(owners);
    if (sources.length === 0 && quick?.sweptAt) {
      recentMigrationPasses.set(memoKey, Date.now());
      return;
    }

    const readRecord = async (): Promise<StoreMigrations> => {
      try {
        const parsed = JSON.parse(await fs.readFile(recordPath, 'utf8')) as StoreMigrations;
        return { ...parsed, sources: parsed.sources ?? {} };
      } catch {
        return { sources: {} };
      }
    };
    const pending = (record: StoreMigrations) => sources.filter((source) => record.sources[source.file]?.sha256 !== source.sha256);
    if (pending(await readRecord()).length === 0 && (quick?.sweptAt || !sweepComplete)) {
      recentMigrationPasses.set(memoKey, Date.now());
      return;
    }

    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    // A knowledge write already holding this store's lock merges under it.
    const held = holdsStoreLock(storeFile);
    const release = held ? async () => {} : await acquireLock(`${storeFile}.lock`, {
      staleMs: 60_000,
      timeoutMs: 30_000,
      timeoutMessage: `Another process is updating the base knowledge of ${repoName}. Retry the operation.`,
    });
    try {
      const record = await readRecord();
      const todo = pending(record);
      if (todo.length === 0 && (record.sweptAt || !sweepComplete)) return;
      const { insertUnderHeading } = await import('../knowledge.js');
      let content = await fs.readFile(storeFile, 'utf8').catch(() => null);
      for (const source of todo) {
        const origin = path.basename(source.workspace);
        let added = 0;
        let conflicts: string[] = [];
        if (content === null) {
          content = source.content;
          added = 1;
        } else {
          const merged = mergeKnowledge(content, source.content, origin, insertUnderHeading);
          content = merged.content;
          added = merged.added;
          conflicts = merged.conflicts;
        }
        record.sources[source.file] = {
          file: filename,
          sha256: source.sha256,
          mergedAt: new Date().toISOString(),
          workspace: source.workspace,
          added,
          conflicts,
        };
      }
      if (content !== null) await atomicWriteFile(storeFile, content);
      record.identity = { ...identity, repoName };
      if (sweepComplete) record.sweptAt ??= new Date().toISOString();
      await atomicWriteJson(recordPath, record);
      recentMigrationPasses.set(memoKey, Date.now());
    } finally {
      await release();
    }
  }

  private legacyBaseFilePath(workspacePath: string, repoName: string, filename: string): string {
    return path.join(workspacePath, '.nexusflow', 'base', repoName, filename);
  }

  private getFallbackFilename(filename: string): string | null {
    if (filename === 'contextspace-knowledge.md') return 'nexusflow-knowledge.md';
    if (filename === 'contextspace-plan.md') return 'nexusflow-plan.md';
    if (filename === 'contextspace-overview.md') return 'nexusflow-overview.md';
    if (filename === 'contextspace-handoff.md') return 'nexusflow-handoff.md';
    if (filename === 'contextspace.json') return 'nexusflow.json';
    if (filename === 'contextspace.lock') return 'nexusflow.lock';
    return null;
  }

  async writeWorkspaceFile(workspacePath: string, featureId: string, filename: string, content: string): Promise<void> {
    const filePath = path.join(workspacePath, filename);
    await atomicWriteFile(filePath, content);
  }

  async readWorkspaceFile(workspacePath: string, featureId: string, filename: string): Promise<string> {
    const filePath = path.join(workspacePath, filename);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const fallback = this.getFallbackFilename(filename);
      if (fallback) {
        const fallbackPath = path.join(workspacePath, fallback);
        return await fs.readFile(fallbackPath, 'utf8');
      }
      throw error;
    }
  }

  async workspaceFileExists(workspacePath: string, featureId: string, filename: string): Promise<boolean> {
    const filePath = path.join(workspacePath, filename);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      const fallback = this.getFallbackFilename(filename);
      if (fallback) {
        try {
          await fs.access(path.join(workspacePath, fallback));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  async deleteWorkspaceFile(workspacePath: string, featureId: string, filename: string): Promise<void> {
    await fs.rm(path.join(workspacePath, filename), { force: true });
  }

  resolveWorkspaceFileUrl(workspacePath: string, featureId: string, filename: string): string {
    return path.join(workspacePath, filename).replace(/\\/g, '/');
  }

  async writeBaseFile(workspacePath: string, repoName: string, filename: string, content: string): Promise<void> {
    await this.migrateWorkspaceBaseFile(workspacePath, repoName, filename);
    const filePath = this.baseFilePath(workspacePath, repoName, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, content);
  }

  async readBaseFile(workspacePath: string, repoName: string, filename: string): Promise<string> {
    await this.migrateWorkspaceBaseFile(workspacePath, repoName, filename);
    const filePath = this.baseFilePath(workspacePath, repoName, filename);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const legacyPath = this.legacyBaseFilePath(workspacePath, repoName, filename);
      try {
        return await fs.readFile(legacyPath, 'utf8');
      } catch {
        throw error;
      }
    }
  }

  async baseFileExists(workspacePath: string, repoName: string, filename: string): Promise<boolean> {
    await this.migrateWorkspaceBaseFile(workspacePath, repoName, filename);
    const filePath = this.baseFilePath(workspacePath, repoName, filename);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      const legacyPath = this.legacyBaseFilePath(workspacePath, repoName, filename);
      try {
        await fs.access(legacyPath);
        return true;
      } catch {
        return false;
      }
    }
  }

  resolveBaseFileUrl(workspacePath: string, repoName: string, filename: string): string {
    return this.baseFilePath(workspacePath, repoName, filename).replace(/\\/g, '/');
  }

  async deleteWorkspace(workspacePath: string, featureId: string): Promise<void> {
    // NOP - workspace files are inside workspacePath, which is deleted directly on
    // workspace removal. Base knowledge lives in the user-level store and survives.
  }
}

/**
 * Every workspace in the configured workspaces folder that includes the
 * repository with this identity, with the folder name it uses there.
 */
async function workspacesWithRepo(identity: RepoIdentity): Promise<Array<{ workspacePath: string; repoName: string }> | null> {
  try {
    const [{ loadConfig }, { listWorkspaces }] = await Promise.all([import('../config.js'), import('../workspace.js')]);
    const config = await loadConfig({ quiet: true });
    const owners: Array<{ workspacePath: string; repoName: string }> = [];
    for (const feature of await listWorkspaces(config.workspacesDir)) {
      for (const repo of feature.repos) {
        const name = path.basename(repo);
        const source = sourceRepoPath(feature.workspacePath, name);
        const candidate = source ? await repoIdentityAsync(source) : null;
        if (candidate && candidate.kind === identity.kind && candidate.value === identity.value) {
          owners.push({ workspacePath: feature.workspacePath, repoName: name });
        }
      }
    }
    return owners;
  } catch {
    // Unknown: the next use tries the sweep again.
    return null;
  }
}
