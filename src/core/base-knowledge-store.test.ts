/**
 * Base knowledge outlives workspaces: one user-level store per repository,
 * shared by every workspace, with an idempotent merge of the per-workspace
 * files earlier versions wrote.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';

import {
  mergeKnowledge,
  normalizeRemoteIdentity,
  resetBaseStoreIdentityCache,
  splitKnowledgeBlocks,
  storeDirName,
} from './base-knowledge-store.js';
import { addBaseKnowledge, insertUnderHeading, readBaseKnowledge, searchKnowledge } from './knowledge.js';
import { runHoldingStoreLock } from './base-knowledge-store.js';
import { resetMigrationPasses } from './adapters/local-storage.js';
import { acquireLock } from './locks.js';
import { deleteWorkspace, saveFeatureConfig } from './workspace.js';
import { PRIMARY_KNOWLEDGE_FILE } from './constants.js';
import type { Feature } from '../types.js';

const git = async (cwd: string, ...args: string[]) => (await execa('git', args, { cwd })).stdout.trim();

describe('repository identity', () => {
  it('normalizes the common remote spellings of one repository to one identity', () => {
    const same = [
      'https://github.com/Antan87/Context-Space.git',
      'https://user:token@github.com/antan87/context-space',
      'git@github.com:antan87/Context-Space.git',
      'ssh://git@github.com:22/antan87/Context-Space.git',
      'https://github.com/antan87/Context-Space/',
    ];
    expect(new Set(same.map(normalizeRemoteIdentity))).toEqual(new Set(['github.com/antan87/context-space']));

    const legacy = [
      'https://github.com/Antan87/NexusFlow.git',
      'https://user:token@github.com/antan87/nexusflow',
      'git@github.com:antan87/NexusFlow.git',
      'ssh://git@github.com:22/antan87/NexusFlow.git',
      'https://github.com/antan87/NexusFlow/',
    ];
    expect(new Set(legacy.map(normalizeRemoteIdentity))).toEqual(new Set(['github.com/antan87/nexusflow']));
  });

  it('treats local paths and file URLs as no remote identity', () => {
    for (const local of ['/srv/git/app.git', 'C:\\repos\\app', 'file:///srv/git/app.git', '../app.git', '']) {
      expect(normalizeRemoteIdentity(local)).toBeNull();
    }
  });

  it('gives same-named repositories with different origins different stores', () => {
    const a = storeDirName({ kind: 'remote', value: 'github.com/acme/api' });
    const b = storeDirName({ kind: 'remote', value: 'github.com/other/api' });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^acme-api-[0-9a-f]{12}$/);
    expect(storeDirName({ kind: 'remote', value: 'github.com/acme/api' })).toBe(a);
  });
});

describe('mergeKnowledge', () => {
  const base = '# Base Knowledge — api\n\n## Known Gotchas\n\n### 2026-09-01 — port\n**Gotcha:** 8080 is taken\n\n## Architecture Decisions\n- None recorded yet.\n';

  it('adds only new entries, under their section, and is idempotent', () => {
    const incoming = `${base}\n## Architecture Decisions\n\n### 2026-09-02 — queue\n**Decision:** use one queue\n- **2026-07-04:** old bullet learning\n`;
    const first = mergeKnowledge(base, incoming, 'ws-a', insertUnderHeading);
    expect(first.added).toBe(1);
    expect(first.content).toContain('### 2026-09-02 — queue');
    expect(first.content.match(/### 2026-09-01 — port/g)).toHaveLength(1);
    const again = mergeKnowledge(first.content, incoming, 'ws-a', insertUnderHeading);
    expect(again).toMatchObject({ added: 0, content: first.content });
  });

  it('keeps a same-titled entry with different content under a suffixed heading and reports it', () => {
    const incoming = '## Known Gotchas\n\n### 2026-09-01 — port\n**Gotcha:** 9090 is taken too\n';
    const merged = mergeKnowledge(base, incoming, 'ws-b', insertUnderHeading);
    expect(merged.conflicts).toEqual(['2026-09-01 — port']);
    expect(merged.content).toContain('### 2026-09-01 — port (from ws-b)\n**Gotcha:** 9090 is taken too');
    expect(merged.content).toContain('**Gotcha:** 8080 is taken');
    expect(mergeKnowledge(merged.content, incoming, 'ws-b', insertUnderHeading).added).toBe(0);
  });

  it('never treats an entry as present because it is a prefix of another', () => {
    const store = '## Known Gotchas\n\n- Use pnpm for installs, never npm\n';
    const merged = mergeKnowledge(store, '## Known Gotchas\n\n- Use pnpm\n', 'ws-a', insertUnderHeading);
    expect(merged.added).toBe(1);
    expect(merged.content).toMatch(/^- Use pnpm$/m);
    expect(merged.content).toContain('- Use pnpm for installs, never npm');
  });

  it('ignores template placeholders', () => {
    expect(splitKnowledgeBlocks('## Architecture Decisions\n- None recorded yet.\n')).toEqual([]);
  });
});

describe('user-level base knowledge (real git)', { timeout: 60_000 }, () => {
  let root: string;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-base-')));
    home = path.join(root, 'home');
    await fs.mkdir(home);
    // The first use of a store sweeps the configured workspaces folder.
    await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ version: '1.0.0', devDir: root, workspacesDir: path.join(root, 'workspaces') }));
    previousHome = process.env.CONTEXTSPACE_HOME;
    process.env.CONTEXTSPACE_HOME = home;
    resetBaseStoreIdentityCache();
    resetMigrationPasses();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CONTEXTSPACE_HOME;
    else process.env.CONTEXTSPACE_HOME = previousHome;
    resetBaseStoreIdentityCache();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  async function checkout(dir: string, origin: string | null): Promise<string> {
    const repo = path.join(root, dir);
    await fs.mkdir(repo, { recursive: true });
    await git(repo, 'init', '-b', 'main');
    if (origin) await git(repo, 'remote', 'add', 'origin', origin);
    return repo;
  }

  async function workspace(name: string, repos: string[], baseFiles: Record<string, string> = {}): Promise<string> {
    const workspacePath = path.join(root, 'workspaces', name);
    const feature: Feature = {
      id: name, mode: 'in-place', branchName: name, description: name, repos, originalRepos: repos,
      assistants: [], workspacePath, createdAt: new Date().toISOString(),
    };
    await saveFeatureConfig(workspacePath, feature);
    for (const [repo, content] of Object.entries(baseFiles)) {
      const dir = path.join(workspacePath, '.contextspace', 'base', repo);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, PRIMARY_KNOWLEDGE_FILE), content);
    }
    return workspacePath;
  }

  const legacy = (entries: string) => `# Base Codebase Knowledge — api\n\n## Discovered Gotchas & Watch-outs\n\n${entries}\n`;

  it('merges overlapping per-workspace files once, shares them, and keeps the originals', async () => {
    const api = await checkout('api', 'git@github.com:acme/api.git');
    const a = await workspace('ws-a', [api], { api: legacy('### 2026-09-01 — shared\n**Gotcha:** both saw this\n\n### 2026-09-02 — only-a\n**Gotcha:** a saw this') });
    const b = await workspace('ws-b', [api], { api: legacy('### 2026-09-01 — shared\n**Gotcha:** both saw this\n\n### 2026-09-03 — only-b\n**Gotcha:** b saw this') });

    // Opening either workspace finds both: the first use sweeps every workspace with the repo.
    const fromA = (await readBaseKnowledge(a, 'api'))!;
    const fromB = (await readBaseKnowledge(b, 'api'))!;
    expect(fromB).toBe(fromA);
    for (const title of ['shared', 'only-a', 'only-b']) expect(fromA).toContain(`— ${title}`);
    expect(fromA.match(/— shared/g)).toHaveLength(1);

    // Reading again changes nothing; the originals are still there.
    expect(await readBaseKnowledge(a, 'api')).toBe(fromA);
    await expect(fs.access(path.join(a, '.contextspace', 'base', 'api', PRIMARY_KNOWLEDGE_FILE))).resolves.toBeUndefined();
    const stores = await fs.readdir(path.join(home, 'base'));
    expect(stores).toHaveLength(1);
    const record = JSON.parse(await fs.readFile(path.join(home, 'base', stores[0]!, 'migrations.json'), 'utf8'));
    expect(record.identity).toMatchObject({ kind: 'remote', value: 'github.com/acme/api', repoName: 'api' });
    expect(Object.keys(record.sources)).toHaveLength(2);
  });

  it('knowledge promoted in one workspace survives its deletion and is found from another', async () => {
    const api = await checkout('api', 'https://github.com/acme/api.git');
    const a = await workspace('ws-a', [api]);
    const b = await workspace('ws-b', [api]);

    const written = await addBaseKnowledge(a, 'api', { type: 'gotcha', title: 'cache-warmup', message: 'Warm the cache before load tests.' });
    expect(path.normalize(written.location).startsWith(path.join(home, 'base'))).toBe(true);
    expect(written.commit.status).toBe('skipped');

    await deleteWorkspace(a);
    await expect(fs.access(a)).rejects.toThrow();

    expect(await readBaseKnowledge(b, 'api')).toContain('Warm the cache before load tests.');
    const found = await searchKnowledge(b, 'cache warmup', {});
    expect(found.some((result) => result.source === 'base' && result.text.includes('Warm the cache'))).toBe(true);
  });

  it('keeps same-named repositories with different origins apart, and falls back to the path without a remote', async () => {
    const acme = await checkout('acme/api', 'git@github.com:acme/api.git');
    const other = await checkout('other/api', 'git@github.com:other/api.git');
    const local = await checkout('local/api', null);
    const wsAcme = await workspace('ws-acme', [acme]);
    const wsOther = await workspace('ws-other', [other]);
    const wsLocal = await workspace('ws-local', [local]);

    await addBaseKnowledge(wsAcme, 'api', { type: 'gotcha', title: 'acme-only', message: 'Only true for acme.' });
    await addBaseKnowledge(wsLocal, 'api', { type: 'gotcha', title: 'local-only', message: 'Only true locally.' });

    expect(await readBaseKnowledge(wsOther, 'api')).toBeNull();
    expect(await readBaseKnowledge(wsLocal, 'api')).not.toContain('acme-only');
    const stores = await fs.readdir(path.join(home, 'base'));
    const withKnowledge = [];
    for (const store of stores) {
      if (await fs.access(path.join(home, 'base', store, PRIMARY_KNOWLEDGE_FILE)).then(() => true, () => false)) withKnowledge.push(store);
    }
    expect(withKnowledge).toHaveLength(2);
  });

  it('a migration interrupted before its record was saved does not duplicate entries when it runs again', async () => {
    const api = await checkout('api', 'git@github.com:acme/api.git');
    const a = await workspace('ws-a', [api], { api: legacy('### 2026-09-02 — only-a\n**Gotcha:** a saw this') });
    const first = (await readBaseKnowledge(a, 'api'))!;
    const [store] = await fs.readdir(path.join(home, 'base'));
    await fs.rm(path.join(home, 'base', store!, 'migrations.json'));
    resetBaseStoreIdentityCache();
    resetMigrationPasses();

    expect(await readBaseKnowledge(a, 'api')).toBe(first);
  });

  it('a workspace whose repository checkout is gone keeps reading its own copy', async () => {
    const a = await workspace('ws-a', [path.join(root, 'missing')], { missing: legacy('### 2026-09-02 — kept\n**Gotcha:** still readable') });
    expect(await readBaseKnowledge(a, 'missing')).toContain('still readable');
    await expect(fs.access(path.join(home, 'base'))).rejects.toThrow();
  });
  it('deleting a workspace nobody opened since the store existed first merges its knowledge', async () => {
    const api = await checkout('api', 'git@github.com:acme/api.git');
    const a = await workspace('ws-a', [api]);
    await addBaseKnowledge(a, 'api', { type: 'gotcha', title: 'from-a', message: 'Known from A.' });
    // Created after the store was swept, with an older per-workspace copy.
    const late = await workspace('ws-late', [api], { api: legacy('### 2026-09-05 — from-late\n**Gotcha:** only the late workspace knew') });
    resetMigrationPasses();

    const { deleteWorkspace: remove } = await import('./workspace.js');
    await remove(late);

    resetMigrationPasses();
    const content = (await readBaseKnowledge(a, 'api'))!;
    expect(content).toContain('only the late workspace knew');
    expect(content).toContain('Known from A.');
  });

  it('a migration that becomes due while a knowledge write holds the store lock does not wait on itself', async () => {
    const api = await checkout('api', 'git@github.com:acme/api.git');
    const a = await workspace('ws-a', [api]);
    await addBaseKnowledge(a, 'api', { type: 'gotcha', title: 'first', message: 'First entry.' });
    const [store] = await fs.readdir(path.join(home, 'base'));
    const storeFile = path.join(home, 'base', store!, PRIMARY_KNOWLEDGE_FILE);
    // A workspace-local copy changes after the store was used: a migration is pending again.
    const dir = path.join(a, '.contextspace', 'base', 'api');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, PRIMARY_KNOWLEDGE_FILE), legacy('### 2026-09-06 — pending\n**Gotcha:** merged under the held lock'));
    resetMigrationPasses();

    const release = await acquireLock(`${storeFile}.lock`, { staleMs: 60_000, timeoutMs: 1_000 });
    try {
      const started = Date.now();
      const content = await runHoldingStoreLock(storeFile, () => readBaseKnowledge(a, 'api'));
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(content).toContain('merged under the held lock');
    } finally {
      await release();
    }
  });
});
