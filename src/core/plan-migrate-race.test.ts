import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The move's file system calls, so a save can land exactly between its checks and its renames.
vi.mock('node:fs/promises', { spy: true });

import { getStorageProvider, setActiveStorageProvider } from './adapters/registry.js';
import { migrateWorkspace, restoreWorkspace, type MigrateOptions } from './plan-migrate.js';
import { defaultDeps, findOlderWriters } from './older-writers.js';
import { mutateWorkspaceState } from './workspace-state.js';
import { readSwitch } from './workspace-db-switch.js';
import { writeRootDocument } from './root-documents.js';

const PLAN = '# Plan\n\n## Checkpoints\n\n- [ ] Ship it\n  - [ ] Write it\n';
const BOARD = JSON.stringify({ version: 1, revision: 1, cards: [], links: [], positions: {} }, null, 2);
let root: string;

const opts = (): MigrateOptions => ({ by: 'user', backup: false, findOlderWriters: (r) => findOlderWriters(r, { ...defaultDeps, processes: async () => [] }) });
const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};
async function treeHash(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) await walk(full); else if (!rel.startsWith('.contextspace/archive/')) out[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(root);
  return out;
}

beforeEach(async () => {
  setActiveStorageProvider(getStorageProvider('local'));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-race-')));
  await write('contextspace.json', JSON.stringify({ id: 'race', name: 'Race', branchName: 'race', repos: [], assistants: [] }));
  await write('PLAN.md', PLAN);
  await write('contextspace-board.json', BOARD);
});
afterEach(async () => {
  vi.mocked(fs.rename).mockReset();
  await fs.rm(root, { recursive: true, force: true });
});

describe('a save that lands between the check and the rename', () => {
  it('goes back to its place, the move is undone, and the newer Board is the one in place', async () => {
    const real = vi.mocked(fs.rename).getMockImplementation() ?? (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    const newer = BOARD.replace('"revision": 1', '"revision": 2');
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from) === path.join(root, 'contextspace-board.json') && String(to).includes(`${path.sep}archive${path.sep}`)) {
        await (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile(from, newer); // an old writer, ignoring the locks
      }
      return real(from, to);
    });
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/stopped and was undone: contextspace-board\.json changed while it was being moved/);
    expect(await fs.readFile(path.join(root, 'contextspace-board.json'), 'utf8')).toBe(newer);
    expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toBe(PLAN);
    expect(readSwitch(root)).toBeNull();
    await expect(fs.access(path.join(root, '.contextspace', 'workspace.db'))).rejects.toThrow();
  });
});

describe('a file system error in the middle of the move', () => {
  it('says that nothing is lost and how to go on; migrate again finishes it', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!failed && String(from) === path.join(root, 'contextspace-board.json')) {
        failed = true;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return actual.rename(from, to);
    });
    const before = await treeHash();
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/The move stopped \(EBUSY[^)]*\)\. Nothing is lost[\s\S]*Run `ctxspace plan migrate` again to finish it, or `ctxspace plan restore \.contextspace\/archive\/pre-db-/);
    expect(readSwitch(root)?.state).toBe('moving');
    const result = await migrateWorkspace(root, opts());
    expect(result.how).toBe('resumed');
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(await treeHash()).toEqual(before);
  });
});

describe('a state file with the older name', () => {
  it('keeps the record when a later state write moves the file, and restore takes it out of both', async () => {
    await write('.contextspace-state.json', JSON.stringify({ workspacePath: root, repos: {}, updatedAt: '2026-11-01T00:00:00.000Z' }));
    const result = await migrateWorkspace(root, opts());
    expect(JSON.parse(await fs.readFile(path.join(root, '.contextspace-state.json'), 'utf8')).workspaceDb).toMatchObject({ id: result.id });
    // any other state write moves the file to its new name, the record with it
    await mutateWorkspaceState(root, (state) => { state.updatedAt = '2026-11-02T00:00:00.000Z'; });
    const primary = path.join(root, '.contextspace', 'state.json');
    expect(JSON.parse(await fs.readFile(primary, 'utf8')).workspaceDb).toMatchObject({ id: result.id });
    const restored = await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(JSON.parse(await fs.readFile(primary, 'utf8')).workspaceDb).toBeUndefined();
    expect(restored.notes.join('\n')).toMatch(/moved to \.contextspace\/state\.json after the move/);
    expect(readSwitch(root)).toBeNull();
    // one state file, not two: the older name is not brought back next to the one that replaced it
    await expect(fs.access(path.join(root, '.contextspace-state.json'))).rejects.toThrow();
    expect(restored.state).toBe('record taken out');
  });
});

describe('the move\'s records survive a power cut (fix round 2, B1)', () => {
  it('flushes each record\'s bytes before its rename, and the folders after', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const synced: string[] = [];
    vi.mocked(fs.open).mockImplementation((async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { synced.push(String(args[0])); return sync(); };
      return handle;
    }) as typeof fs.open);
    try {
      const result = await migrateWorkspace(root, opts());
      const dot = path.join(root, '.contextspace');
      const temp = (file: string) => synced.some((p) => p.startsWith(`${file}.tmp-`));
      expect(temp(path.join(dot, 'workspace-db-switch.json')), 'the switch').toBe(true);
      expect(temp(path.join(root, ...result.archive.split('/'), 'manifest.json')), 'the manifest').toBe(true);
      expect(temp(path.join(dot, 'state.json')), 'the state record').toBe(true);
      expect(synced.some((p) => p.startsWith(path.join(dot, `.PLAN.md.${result.id}`))), 'the new PLAN.md').toBe(true);
      expect(synced.some((p) => p.startsWith(path.join(dot, `.contextspace-data.json.${result.id}`))), 'the new contextspace-data.json').toBe(true);
      if (process.platform !== 'win32') {
        for (const dir of [root, dot, path.join(root, ...result.archive.split('/')), path.join(root, ...result.archive.split('/'), 'files'), path.join(dot, 'archive')]) {
          expect(synced, dir).toContain(dir);
        }
      }
    } finally {
      vi.mocked(fs.open).mockReset();
    }
  });
});

describe('fix round 3', () => {
  it('Windows: a save lands during the rename and the unlink after the link back fails (EBUSY): migrate again undoes it, keeping the save', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const newer = BOARD.replace('"revision": 1', '"revision": 2');
    const board = path.join(root, 'contextspace-board.json');
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from) === board && String(to).includes(`${path.sep}archive${path.sep}`)) await actual.writeFile(from, newer);
      return actual.rename(from, to);
    });
    vi.mocked(fs.unlink).mockImplementation(async (file) => {
      if (String(file).endsWith(`${path.sep}files${path.sep}contextspace-board.json`)) throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' });
      return actual.unlink(file);
    });
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/The move stopped \(EBUSY/);
    expect(readSwitch(root)?.state).toBe('moving'); // the newer Board now has two names: its place and the archive
    vi.mocked(fs.rename).mockReset();
    vi.mocked(fs.unlink).mockReset();
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/stopped and was undone[\s\S]*back in its place in that newer version: contextspace-board\.json/);
    expect(readSwitch(root)).toBeNull();
    expect(await fs.readFile(board, 'utf8')).toBe(newer);
    expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toBe(PLAN);
  });

  it.skipIf(process.platform === 'win32')('a mount that refuses a folder fsync (EPERM) does not stop the move or the restore', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementation((async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if ((await handle.stat()).isDirectory()) handle.sync = async () => { throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' }); };
      return handle;
    }) as typeof fs.open);
    try {
      const result = await migrateWorkspace(root, opts());
      await restoreWorkspace(root, result.archive, { by: 'user' });
      expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toBe(PLAN);
      expect(readSwitch(root)).toBeNull();
    } finally {
      vi.mocked(fs.open).mockReset();
    }
  });

  it('a file system that refuses chmod does not stop a document save', async () => {
    vi.mocked(fs.chmod).mockRejectedValue(Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' }));
    try {
      await write('notes.md', 'notes');
      await writeRootDocument(root, 'notes.md', 'saved');
      expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('saved');
    } finally {
      vi.mocked(fs.chmod).mockReset();
    }
  });
});
