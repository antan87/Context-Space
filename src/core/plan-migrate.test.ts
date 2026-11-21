import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { getStorageProvider, setActiveStorageProvider } from './adapters/registry.js';
import { migrateStatus, migrateWorkspace, recoverDatabase, restoreWorkspace, MoveRefusedError, type MigrateOptions, type MigrateStep } from './plan-migrate.js';
import { rehearseMigration } from './plan-migrate-rehearsal.js';
import { defaultDeps, findOlderWriters } from './older-writers.js';
import { readSwitch, SWITCH_FILE } from './workspace-db-switch.js';
import { listBlocks, listCards, openWorkspaceDb, readImportRecord, stripExport } from './workspace-db/index.js';
import { changePlanFile } from './plan-file-store.js';
import { changeBoard } from './board.js';
import { acquireLock } from './locks.js';

const PLAN = `# CSV export

Customers export their reports.

## Checkpoints

- [x] Report rows load fast
  - [x] Query the report rows
- [ ] Reports export to CSV
  Check: \`npm test\`
  - [x] Write the CSV writer
  - [ ] Add the Export button
  - [ ] Decide: Should archived reports be exported?
    Suggested: Yes, all of them · Only the last year
    If no answer: only the last year

## Steps

- [ ] Tidy the old export script
`;

const U = (n: number) => `${String(n).padStart(8, '0')}-1111-4222-8333-444455556666`;
const AT = '2026-11-01T10:00:00.000Z';
const card = (n: number, over: Record<string, unknown>) => ({ id: U(n), kind: 'note', title: `Card ${n}`, body: `Body ${n}`, pinned: false, archived: false, by: 'user', at: AT, updatedBy: 'user', updatedAt: AT, ...over });
const BOARD = {
  version: 1, revision: 7,
  cards: [card(1, { area: 'checkpoint:reports-export-to-csv', step: 'add-the-export-button' }), card(2, { area: 'plan:own', step: 'a-step-that-was-reworded' })],
  links: [{ id: U(11), from: U(1), to: 'checkpoint:reports-export-to-csv', label: 'serves', by: 'user', at: AT }],
  positions: { [U(1)]: { x: 10, y: 20 } },
};

let root: string;

const write = async (rel: string, text: string | Buffer) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};

async function fullWorkspace(plan = PLAN) {
  await write('PLAN.md', plan);
  await write('contextspace-board.json', JSON.stringify(BOARD, null, 2));
  await write('.contextspace/plan-changes.jsonl', `${JSON.stringify({ at: '2026-11-02T09:00:00.000Z', by: 'claude', action: 'ticked', kind: 'step', key: 'write-the-csv-writer', text: 'Write the CSV writer' })}\n`);
  await write('.contextspace/board-changes.jsonl', `${JSON.stringify({ at: '2026-11-02T08:00:00.000Z', by: 'user', revision: 3, action: 'add_card', id: U(1), text: 'Card 1' })}\n`);
  await write('.contextspace/plan-now.json', JSON.stringify({ key: 'add-the-export-button', by: 'claude', at: '2026-11-04T00:00:00.000Z' }));
  await write('.contextspace/plan-seen.json', JSON.stringify({ hash: 'abc', items: { 'write-the-csv-writer': { kind: 'step', text: 'Write the CSV writer', done: true } } }));
  await write('.contextspace/seen.json', JSON.stringify({ version: 1, readers: { claude: { at: '2026-11-05T00:00:00.000Z', repos: {}, knowledge: [], documents: [] } }, pending: {} }));
  // deliberately not in the form JSON.stringify(…, null, 2) makes: a put-back state file must be these exact bytes
  // (the path goes through JSON.stringify: a Windows path's backslashes are not valid JSON as they stand)
  await write('.contextspace/state.json', `{"workspacePath":${JSON.stringify(root)},"repos":{},"updatedAt":"${AT}","planChecks":{"reports-export-to-csv":{"lastVerificationStatus":"pass","canProgress":true,"at":"${AT}"}}}`);
}

/** sha256 of every file under the workspace, by relative path with `/`. */
async function treeHash(dir = root): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isDirectory()) await walk(full); else out[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

/** What the move adds and keeps after a restore: the archive, backups. Everything else must be exactly as before. */
const withoutMoveLeftovers = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).filter(([rel]) => !rel.startsWith('.contextspace/archive/') && !rel.startsWith('.contextspace/backups/')));

const noOlder = (r: string) => findOlderWriters(r, { ...defaultDeps, processes: async () => [] });
const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({ by: 'user', findOlderWriters: noOlder, backup: false, ...over });
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const there = (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false);

beforeEach(async () => {
  setActiveStorageProvider(getStorageProvider('local')); // the built-in one: the move refuses any other adapter
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-ws-')));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'csv', name: 'CSV export', branchName: 'feat/csv', description: 'Add CSV export', repos: [], assistants: [] }));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the move, all the way and back', () => {
  it('moves every source into the archive, writes the new PLAN.md and the snapshot, turns the switch on, and restore puts every byte back', async () => {
    await fullWorkspace();
    const before = await treeHash();
    const out = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-dry-')));
    try {
      await rehearseMigration(root, { out: path.join(out, 'o') });
      const dryPlan = await fs.readFile(path.join(out, 'o', 'PLAN.md'), 'utf8');
      expect(await treeHash()).toEqual(before); // the rehearsal changed nothing

      const result = await migrateWorkspace(root, opts());
      expect(result).toMatchObject({ workspace: root, how: 'fresh', counts: { items: 7, cards: 2, links: 1, positions: 1 } });
      expect(result.archive).toMatch(/^\.contextspace\/archive\/pre-db-/);
      expect(result.unmapped.map((u) => u.value)).toEqual(['a-step-that-was-reworded']);

      // the switch, the record, the database
      expect(readSwitch(root)).toMatchObject({ state: 'on', archive: result.archive, id: result.id });
      const state = JSON.parse(await read('.contextspace/state.json'));
      expect(state.workspaceDb).toMatchObject({ id: result.id, status: 'done', archive: result.archive });
      expect(state.planChecks['reports-export-to-csv']).toMatchObject({ canProgress: true }); // the rest of state.json stays
      const db = openWorkspaceDb(root, { busy: 'cli', readOnly: true, backups: false });
      try {
        expect(readImportRecord(db)).toMatchObject({ id: result.id, status: 'done' });
        expect(listBlocks(db).filter((b) => ['checkpoint', 'step', 'decision'].includes(b.kind))).toHaveLength(7);
        expect(listCards(db, { includeArchived: true })).toHaveLength(2);
      } finally { db.close(); }

      // the new PLAN.md is the database's export: the same plan as the dry run's, header and id comments apart
      const plan = await read('PLAN.md');
      expect(plan.split('\n')[0]).toMatch(/^<!-- Written by ContextSpace from the workspace database\./);
      expect(stripExport(plan)).toBe(PLAN);
      expect(stripExport(plan)).toBe(stripExport(dryPlan));
      expect(JSON.parse(await read('contextspace-data.json'))).toMatchObject({ format: 'contextspace-data' });

      // the old files are in the archive, byte for byte, and gone from their places
      for (const rel of ['contextspace-board.json', '.contextspace/plan-changes.jsonl', '.contextspace/board-changes.jsonl', '.contextspace/plan-now.json', '.contextspace/plan-seen.json', '.contextspace/seen.json']) {
        expect(await there(rel), rel).toBe(false);
      }
      const archived = await treeHash(path.join(root, result.archive, 'files'));
      for (const [rel, hash] of Object.entries(archived)) expect(hash, rel).toBe(before[rel]);
      expect(Object.keys(archived).sort()).toEqual(Object.keys(before).filter((r) => r !== 'contextspace.json').sort());
      const manifest = JSON.parse(await read(`${result.archive}/manifest.json`));
      expect(manifest.sources.find((s: { path: string }) => s.path === 'contextspace-board.json').sha256).toBe(before['contextspace-board.json']);

      const status = await migrateStatus(root);
      expect(status).toMatchObject({ moved: 'on', archive: result.archive, database: 'present', cameBack: [] });
      // the database and its backups stay out of Git
      expect((await read('.contextspace/.gitignore')).split('\n')).toEqual(expect.arrayContaining(['workspace.db*', 'backups/', '.db-staging-*']));

      const restored = await restoreWorkspace(root, result.archive, { by: 'user' });
      expect(restored.putBack.sort()).toEqual(Object.keys(before).filter((r) => !['contextspace.json', '.contextspace/state.json'].includes(r)).sort());
      expect(restored.state).toBe('put back as it was');
      expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
      expect(readSwitch(root)).toBeNull();
      // the database was moved aside, never deleted
      expect(await there(`${result.archive}/database/workspace.db`)).toBe(true);
      expect(await there('.contextspace/workspace.db')).toBe(false);
      expect((await migrateStatus(root)).moved).toBe('no');
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  });

  it('can move again after a restore, into a new archive', async () => {
    await fullWorkspace();
    const one = await migrateWorkspace(root, opts());
    await restoreWorkspace(root, one.archive, { by: 'user' });
    const two = await migrateWorkspace(root, opts());
    expect(two.archive).not.toBe(one.archive);
    expect((await migrateStatus(root)).earlier).toEqual([expect.objectContaining({ archive: one.archive, restoredAt: expect.any(String) })]);
  });

  it('moves a plan with CRLF line endings and keeps them in the new PLAN.md', async () => {
    const crlf = PLAN.replace(/\n/g, '\r\n');
    await fullWorkspace(crlf);
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    expect(result.counts.items).toBe(7);
    expect(result.unmapped.map((u) => u.value)).toEqual(['a-step-that-was-reworded']); // the CRLF plan's keys still map the cards
    const plan = await read('PLAN.md');
    expect(plan).toContain('\r\n');
    expect(plan.replace(/\r\n/g, '')).not.toContain('\n');
    expect(stripExport(plan)).toBe(crlf);
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
  });

  it('adds its Git ignore lines to a .contextspace/.gitignore that is there, and takes exactly those out again', async () => {
    await fullWorkspace();
    await write('.contextspace/.gitignore', 'line-notes.json*\nbackups/');
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    expect(await read('.contextspace/.gitignore')).toBe('line-notes.json*\nbackups/\nworkspace.db*\n.db-staging-*\n');
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
    // edited in between: only the move's lines come out
    const again = await migrateWorkspace(root, opts());
    await fs.appendFile(path.join(root, '.contextspace', '.gitignore'), 'mine\n');
    await restoreWorkspace(root, again.archive, { by: 'user' });
    expect(await read('.contextspace/.gitignore')).toBe('line-notes.json*\nbackups/\nmine\n');
  });

  it('moves a workspace with only a plan (no Board, no logs, no state file)', async () => {
    await write('PLAN.md', PLAN);
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    expect(result.moved).toEqual(['PLAN.md']);
    expect(result.kept).toEqual([]);
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before); // the state file the move made is gone again
  });
});

describe('an interruption after each step', () => {
  const STEPS: MigrateStep[] = ['snapshot', 'staged', 'recorded', 'database', 'plan', 'data', 'archived', 'switch'];
  class Stop extends Error {}
  const stopAfter = (step: MigrateStep) => opts({ afterStep: (at) => { if (at === step) throw new Stop(`stopped after ${step}`); } });

  for (const step of STEPS) {
    it(`after "${step}": migrate again finishes it, and restore then puts every byte back`, async () => {
      await fullWorkspace();
      const before = await treeHash();
      await expect(migrateWorkspace(root, stopAfter(step))).rejects.toThrow(Stop);
      if (step === 'switch') {
        await expect(migrateWorkspace(root, opts())).rejects.toThrow(/already moved/);
      } else {
        const result = await migrateWorkspace(root, opts());
        expect(result.how).toBe(['snapshot', 'staged'].includes(step) ? 'fresh' : step === 'recorded' ? 'restarted' : 'resumed');
      }
      const status = await migrateStatus(root);
      expect(status).toMatchObject({ moved: 'on', database: 'present', cameBack: [] });
      expect(stripExport(await read('PLAN.md'))).toBe(PLAN);
      expect((await fs.readdir(path.join(root, '.contextspace'))).filter((n) => n.startsWith('.db-staging-'))).toEqual([]);
      await restoreWorkspace(root, status.archive!, { by: 'user' });
      expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
    });

    it(`after "${step}": restore undoes it directly`, async () => {
      await fullWorkspace();
      const before = await treeHash();
      await expect(migrateWorkspace(root, stopAfter(step))).rejects.toThrow(Stop);
      const record = readSwitch(root);
      if (['snapshot', 'staged'].includes(step)) {
        // nothing was recorded, so nothing moved: every file is in its place, and there is nothing to restore
        expect(record).toBeNull();
        const tree = await treeHash();
        for (const [rel, hash] of Object.entries(before)) expect(tree[rel], rel).toBe(hash);
        const archives = await fs.readdir(path.join(root, '.contextspace', 'archive')).catch(() => []);
        expect(archives).toEqual([]);
        return;
      }
      expect(record?.state).toBe(step === 'switch' ? 'on' : 'moving');
      await restoreWorkspace(root, record!.archive!, { by: 'user' });
      expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
      expect(readSwitch(root)).toBeNull();
    });
  }

  for (const step of ['guarded', 'database', 'exports', 'files', 'state'] as const) {
    it(`a restore interrupted after "${step}" keeps every old writer refused, and running it again finishes it`, async () => {
      await fullWorkspace();
      const before = await treeHash();
      const result = await migrateWorkspace(root, opts());
      await expect(restoreWorkspace(root, result.archive, { by: 'user', afterStep: (at) => { if (at === step) throw new Stop(at); } })).rejects.toThrow(Stop);
      expect(readSwitch(root)?.state).toBe('restoring');
      const mid = await treeHash();
      await expect(changePlanFile(root, (text) => `${text}- [ ] x\n`, { by: 'user' })).rejects.toThrow(/being restored/);
      await expect(changeBoard(root, [{ op: 'add_card', kind: 'note', title: 'x' }], { by: 'user' })).rejects.toThrow(/being restored/);
      expect(await treeHash()).toEqual(mid);
      expect((await migrateStatus(root)).offers.join('\n')).toMatch(/A restore did not finish/);
      await restoreWorkspace(root, result.archive, { by: 'user' });
      expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
      expect(readSwitch(root)).toBeNull();
    });
  }

  it('a restore that was itself interrupted is finished by running it again', async () => {
    await fullWorkspace();
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    // stop the restore half way: the database is aside and one file is back, then the process "dies"
    await fs.writeFile(path.join(root, SWITCH_FILE), JSON.stringify({ state: 'restoring', archive: result.archive, id: result.id }));
    await fs.mkdir(path.join(root, result.archive, 'database'), { recursive: true });
    await fs.rename(path.join(root, '.contextspace', 'workspace.db'), path.join(root, result.archive, 'database', 'workspace.db'));
    await fs.link(path.join(root, result.archive, 'files', 'contextspace-board.json'), path.join(root, 'contextspace-board.json'));
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/restore of this workspace was interrupted/);
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
  });
});

describe('the locks the move takes', () => {
  for (const lock of ['.contextspace-plan.lock', '.contextspace-planning.lock', '.contextspace/plan-file.lock', '.contextspace/board.lock', '.contextspace/state.lock', '.contextspace/seen.lock']) {
    it(`waits for ${lock}, which a writer of the old files holds`, async () => {
      await fullWorkspace();
      const release = await acquireLock(path.join(root, ...lock.split('/')), { staleMs: 60_000, timeoutMs: 1_000, timeoutMessage: 'busy' });
      let done = false;
      const move = migrateWorkspace(root, opts({ findOlderWriters: async () => [] })).then((r) => { done = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      expect(readSwitch(root)).toBeNull(); // nothing recorded while the writer holds its lock
      await release();
      await expect(move).resolves.toMatchObject({ how: 'fresh' });
    });
  }
});

describe('refusals change nothing', () => {
  it('refuses when an older ContextSpace could still write the old files, and says what it found', async () => {
    await fullWorkspace();
    // the workspace's command line points at a backend without the switch
    const backend = path.join(root, '..', `${path.basename(root)}-old-backend`);
    await fs.mkdir(path.join(backend, 'dist', 'core'), { recursive: true });
    await fs.writeFile(path.join(backend, 'dist', 'index.js'), '');
    await fs.writeFile(path.join(backend, 'dist', 'core', 'plan-file-store.js'), '');
    await fs.writeFile(path.join(backend, 'package.json'), JSON.stringify({ version: '2.48.1' }));
    try {
      await write('.contextspace/bin/ctxspace', `#!/bin/sh\nexec '/x/contextspace-desktop' '${path.join(backend, 'dist', 'index.js')}' "$@"\n`);
      const before = await treeHash();
      const error = await migrateWorkspace(root, opts()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MoveRefusedError);
      expect((error as Error).message).toMatch(/2\.48\.1, which does not know the workspace database/);
      expect((error as Error).message).toMatch(/Nothing was changed/);
      expect(await treeHash()).toEqual(before);
      // once the backend knows the switch, the move goes ahead
      await fs.writeFile(path.join(backend, 'dist', 'core', 'workspace-db-switch.js'), '');
      await expect(migrateWorkspace(root, opts())).resolves.toMatchObject({ how: 'fresh' });
    } finally {
      await fs.rm(backend, { recursive: true, force: true });
    }
  });

  it('refuses a workspace that is already moved', async () => {
    await fullWorkspace();
    await migrateWorkspace(root, opts());
    const before = await treeHash();
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/already moved.*Nothing was changed/s);
    expect(await treeHash()).toEqual(before);
  });

  it('a file in the archive that changed since the move does not strand the workspace: it goes back in its place, and the restore says which (fix round 3)', async () => {
    await fullWorkspace();
    const result = await migrateWorkspace(root, opts());
    await fs.appendFile(path.join(root, result.archive, 'files', 'contextspace-board.json'), ' ');
    const changed = await read(`${result.archive}/files/contextspace-board.json`);
    const restored = await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(restored.newerInPlace).toEqual(['contextspace-board.json']);
    expect(await read('contextspace-board.json')).toBe(changed);
    expect(readSwitch(root)).toBeNull();
  });

  it('refuses a restore when the archive no longer holds the PLAN.md that was moved', async () => {
    await fullWorkspace();
    const result = await migrateWorkspace(root, opts());
    await fs.rm(path.join(root, result.archive, 'files', 'PLAN.md'));
    const before = await treeHash();
    await expect(restoreWorkspace(root, result.archive, { by: 'user' })).rejects.toThrow(/PLAN\.md: the archive's copy is missing/);
    expect(await treeHash()).toEqual(before);
  });

  it('refuses a restore of a finished move when an archived file is missing, whatever stands in its place (a hand edit, a file that came back)', async () => {
    await fullWorkspace();
    const result = await migrateWorkspace(root, opts());
    await fs.appendFile(path.join(root, 'PLAN.md'), '- [ ] typed by hand\n');
    await fs.rm(path.join(root, result.archive, 'files', 'PLAN.md'));
    await write('contextspace-board.json', '{"from":"an old binary"}');
    await fs.rm(path.join(root, result.archive, 'files', 'contextspace-board.json'));
    const before = await treeHash();
    const error = await restoreWorkspace(root, result.archive, { by: 'user' }).catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/PLAN\.md: the archive's copy is missing/);
    expect(error.message).toMatch(/contextspace-board\.json: the archive's copy is missing/);
    expect(await treeHash()).toEqual(before);
    expect(readSwitch(root)?.state).toBe('on');
  });

  it('refuses a restore of an unfinished move when the moved PLAN.md is gone and the one in its place was written from the database, even edited', async () => {
    await fullWorkspace();
    await expect(migrateWorkspace(root, opts({ afterStep: (s) => { if (s === 'plan') throw new Error('stop'); } }))).rejects.toThrow('stop');
    const record = readSwitch(root)!;
    expect(record.state).toBe('moving');
    await fs.appendFile(path.join(root, 'PLAN.md'), '- [ ] typed by hand\n');
    await fs.rm(path.join(root, record.archive!, 'files', 'PLAN.md'));
    const before = await treeHash();
    await expect(restoreWorkspace(root, record.archive!, { by: 'user' })).rejects.toThrow(/PLAN\.md: the archive no longer holds the PLAN\.md that was moved, and the PLAN\.md in its place was written from the database/);
    expect(await treeHash()).toEqual(before);
  });

  it('refuses a restore of an archive that is not this move\'s, or not an archive', async () => {
    await fullWorkspace();
    const result = await migrateWorkspace(root, opts());
    await fs.mkdir(path.join(root, '.contextspace', 'archive', 'pre-db-other'));
    await expect(restoreWorkspace(root, '.contextspace/archive/pre-db-other', { by: 'user' })).rejects.toThrow(new RegExp(`used ${result.archive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(restoreWorkspace(root, 'PLAN.md', { by: 'user' })).rejects.toThrow(/is not an archive of this workspace/);
    await expect(restoreWorkspace(root, '/tmp', { by: 'user' })).rejects.toThrow(/is not an archive of this workspace/);
  });

  it('refuses a stray database, an existing contextspace-data.json, a linked source and a corrupt Board, before anything moves', async () => {
    await fullWorkspace();
    const before = await treeHash();
    await write('.contextspace/workspace.db', 'someone\'s');
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/no finished move says it belongs/);
    await fs.rm(path.join(root, '.contextspace', 'workspace.db'));
    await write('contextspace-data.json', '{}');
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/contextspace-data\.json is already there/);
    await fs.rm(path.join(root, 'contextspace-data.json'));
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-outside-')));
    try {
      await fs.rename(path.join(root, '.contextspace', 'seen.json'), path.join(outside, 'seen.json'));
      await fs.symlink(path.join(outside, 'seen.json'), path.join(root, '.contextspace', 'seen.json'));
      await expect(migrateWorkspace(root, opts())).rejects.toThrow(/\.contextspace\/seen\.json is a link/);
      await fs.rm(path.join(root, '.contextspace', 'seen.json'));
      await fs.rename(path.join(outside, 'seen.json'), path.join(root, '.contextspace', 'seen.json'));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
    expect(await treeHash()).toEqual(before);
    await write('contextspace-board.json', '{ not json');
    const broken = await treeHash();
    const error = await migrateWorkspace(root, opts()).catch((e: unknown) => e) as MoveRefusedError;
    expect(error.message).toMatch(/would not hold everything[\s\S]*contextspace-board\.json/);
    expect(error.report?.exitCode).toBe(3);
    expect(await treeHash()).toEqual(broken);
    expect(readSwitch(root)).toBeNull();
  });

  it('refuses a workspace kept through another storage adapter', async () => {
    await fullWorkspace();
    setActiveStorageProvider(Object.create(new LocalStorageAdapter()) as LocalStorageAdapter);
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/storage adapter other than the built-in/);
    expect(await there('.contextspace/workspace.db')).toBe(false);
  });
});

describe('a source that changes during the move', () => {
  it('undoes the whole move and keeps both versions', async () => {
    await fullWorkspace();
    // the move stops after the database is in; then something that ignores the locks writes the Board
    await expect(migrateWorkspace(root, opts({ afterStep: (s) => { if (s === 'plan') throw new Error('stop'); } }))).rejects.toThrow('stop');
    await write('contextspace-board.json', JSON.stringify({ ...BOARD, revision: 8 }, null, 2));
    const edited = await read('contextspace-board.json');
    await expect(migrateWorkspace(root, opts())).rejects.toThrow(/stopped and was undone: contextspace-board\.json changed during the move/);
    expect(readSwitch(root)).toBeNull();
    expect(await read('contextspace-board.json')).toBe(edited); // the newer Board is the one in place
    expect(stripExport(await read('PLAN.md'))).toBe(PLAN);
    expect(await read('PLAN.md')).toBe(PLAN); // the original, not the export
    expect(await there('.contextspace/workspace.db')).toBe(false);
  });
});

describe('a database that goes missing after the move', () => {
  it('is told apart from a new workspace: status offers the newest backup, nothing starts empty, and the backup comes back', async () => {
    await fullWorkspace();
    const result = await migrateWorkspace(root, opts({ backup: true }));
    expect(result.backup).toMatch(/^\.contextspace\/backups\/workspace-\d{4}-\d{2}-\d{2}\.db$/);
    await fs.rename(path.join(root, '.contextspace', 'workspace.db'), path.join(root, '..', `${path.basename(root)}-gone.db`));
    try {
      const status = await migrateStatus(root);
      expect(status).toMatchObject({ moved: 'on', database: 'missing' });
      expect(status.offers.join('\n')).toMatch(/not a new workspace/);
      expect(status.offers.join('\n')).toContain(`--from-backup ${path.basename(result.backup!)}`);
      expect(status.offers.join('\n')).toContain('contextspace-data.json holds the plan');
      await expect(recoverDatabase(root, { by: 'user' })).rejects.toThrow(/will not start an empty one/);
      expect(await there('.contextspace/workspace.db')).toBe(false);
      await expect(recoverDatabase(root, { by: 'user', fromBackup: '../x.db' })).rejects.toThrow(/is not one of this workspace's backups/);
      const back = await recoverDatabase(root, { by: 'user', fromBackup: path.basename(result.backup!) });
      expect(back.from).toBe('backup');
      const db = openWorkspaceDb(root, { busy: 'cli', readOnly: true, backups: false });
      try { expect(readImportRecord(db)).toMatchObject({ id: result.id, status: 'done' }); } finally { db.close(); }
    } finally {
      await fs.rm(path.join(root, '..', `${path.basename(root)}-gone.db`), { force: true });
    }
  });

  it('recovers the database an interrupted backup restore had moved aside (.replaced-*), instead of calling it missing', async () => {
    await fullWorkspace();
    await migrateWorkspace(root, opts());
    const live = path.join(root, '.contextspace', 'workspace.db');
    const bytes = await fs.readFile(live);
    await fs.rename(live, `${live}.replaced-2026-11-20T10-00-00-000Z-abc123`);
    const status = await migrateStatus(root);
    expect(status.replaced).toBe('.contextspace/workspace.db.replaced-2026-11-20T10-00-00-000Z-abc123');
    expect(status.offers.join('\n')).toMatch(/interrupted restore/);
    const back = await recoverDatabase(root, { by: 'user' });
    expect(back).toMatchObject({ from: 'replaced', recovered: '.contextspace/workspace.db.replaced-2026-11-20T10-00-00-000Z-abc123' });
    expect((await fs.readFile(live)).equals(bytes)).toBe(true);
    expect((await migrateStatus(root)).database).toBe('present');
  });
});

describe('status', () => {
  it('lists a legacy file that came back after the move, and a hand edit of PLAN.md, once each, and restore keeps them', async () => {
    await fullWorkspace();
    const result = await migrateWorkspace(root, opts());
    await write('contextspace-board.json', '{"from":"an old binary"}');
    await fs.appendFile(path.join(root, 'PLAN.md'), '- [ ] A step typed into the file\n');
    const status = await migrateStatus(root);
    expect(status.cameBack.map((c) => c.path)).toEqual(['contextspace-board.json', 'PLAN.md']);
    const restored = await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(restored.cameBack.map((c) => c.path).sort()).toEqual(['PLAN.md', 'contextspace-board.json']);
    for (const c of restored.cameBack) expect(await there(c.keptAs)).toBe(true);
    expect(await read(restored.cameBack.find((c) => c.path === 'PLAN.md')!.keptAs)).toContain('A step typed into the file');
    expect(await read('PLAN.md')).toBe(PLAN);
  });

  it('says plainly when nothing was moved', async () => {
    await fullWorkspace();
    expect(await migrateStatus(root)).toMatchObject({ moved: 'no', database: 'none', offers: [] });
  });
});

describe('the older-ContextSpace check', () => {
  it('names a lock held by a live process, and a running older server of the same ContextSpace home, and nothing else', async () => {
    const backend = path.join(root, 'old');
    await fs.mkdir(path.join(backend, 'dist', 'core'), { recursive: true });
    await fs.writeFile(path.join(backend, 'dist', 'core', 'plan-file-store.js'), '');
    await fs.writeFile(path.join(backend, 'package.json'), JSON.stringify({ version: '2.40.0' }));
    const entry = path.join(backend, 'dist', 'index.js');
    const server = path.join(backend, 'dist', 'desktop-server.js');
    await write('.contextspace/board.lock', JSON.stringify({ pid: 4242 }));
    await write('.contextspace-plan.lock', JSON.stringify({ pid: 4242 })); // the older plan store's lock, at the workspace root
    await write('.contextspace/plan-file.lock', JSON.stringify({ pid: 4343 })); // a dead process: ignored
    const home = { HOME: '/home/someone' };
    const found = await findOlderWriters(root, {
      ...defaultDeps,
      selfPid: 1,
      env: home,
      pidAlive: (pid) => pid === 4242,
      commandOf: () => ({ args: ['node', entry, 'board'] }),
      processes: async () => [
        { pid: 10, args: ['electron', server], env: home },
        { pid: 11, args: ['electron', server], env: { HOME: '/home/other' } }, // another home: not this workspace's server
        { pid: 12, args: ['node', entry, 'mcp', 'run'], cwd: root },
        { pid: 13, args: ['node', entry, 'mcp', 'run'], cwd: '/elsewhere' },
        { pid: 14, args: ['node', '/not/contextspace/dist/index.js', 'ui'], env: home },
      ],
    });
    expect(found.map((f) => f.found)).toEqual([
      '.contextspace-plan.lock is held by process 4242',
      '.contextspace/board.lock is held by process 4242',
      `process 10: ${server}`,
      `process 12: ${entry} mcp run`,
    ]);
    expect(found[2]!.what).toMatch(/2\.40\.0 server is running \(the desktop app\)/);
    expect(found[2]!.stop).toMatch(/Quit the ContextSpace app/);
  });

  it('finds a backend started with a relative entry (`node dist/index.js ui`), resolved against its own folder, not this command\'s', async () => {
    // an older backend, and a newer one at the same relative path: the process's folder decides which it runs
    const old = path.join(root, 'old');
    const newer = path.join(root, 'newer');
    for (const dir of [old, newer]) {
      await fs.mkdir(path.join(dir, 'dist', 'core'), { recursive: true });
      await fs.writeFile(path.join(dir, 'dist', 'index.js'), '');
      await fs.writeFile(path.join(dir, 'dist', 'core', 'plan-file-store.js'), '');
    }
    await fs.writeFile(path.join(newer, 'dist', 'core', 'workspace-db-switch.js'), '');
    await fs.writeFile(path.join(old, 'package.json'), JSON.stringify({ version: '2.47.0' }));
    await write('.contextspace/board.lock', JSON.stringify({ pid: 4242 }));
    const home = { HOME: '/home/someone' };
    const deps = { ...defaultDeps, selfPid: 1, env: home, pidAlive: (pid: number) => pid === 4242 };
    const found = await findOlderWriters(root, {
      ...deps,
      commandOf: () => ({ args: ['node', 'dist/index.js', 'board'], cwd: old }),
      processes: async () => [
        { pid: 20, args: ['node', 'dist/index.js', 'ui', '--port', '3100'], cwd: old, env: home },
        { pid: 21, args: ['node', './dist/index.js', 'ui'], cwd: newer, env: home }, // knows the database
      ],
    });
    expect(found.map((f) => f.found)).toEqual(['.contextspace/board.lock is held by process 4242', 'process 20: ' + path.join(old, 'dist', 'index.js') + ' ui --port 3100']);
    expect(found[0]!.what).toMatch(/2\.47\.0 is writing/);
    expect(found[1]!.what).toMatch(/2\.47\.0 server is running \(`ctxspace ui`\)/);
  });

  it('judges a running backend by the code it started with: files updated after it started do not count', async () => {
    const backend = path.join(root, 'rebuilt');
    await fs.mkdir(path.join(backend, 'dist', 'core'), { recursive: true });
    await fs.writeFile(path.join(backend, 'dist', 'index.js'), '');
    await fs.writeFile(path.join(backend, 'dist', 'core', 'plan-file-store.js'), '');
    await fs.writeFile(path.join(backend, 'dist', 'core', 'workspace-db-switch.js'), ''); // written now
    const home = { HOME: '/home/someone' };
    const proc = (pid: number, startedAt: number) => ({ pid, args: ['node', 'dist/index.js', 'ui', '--port', '3100'], cwd: backend, env: home, startedAt });
    const found = await findOlderWriters(root, {
      ...defaultDeps, selfPid: 1, env: home, pidAlive: () => false,
      processes: async () => [proc(40, Date.now() - 3_600_000), proc(41, Date.now() + 5_000)],
    });
    expect(found.map((f) => f.found.split(':')[0])).toEqual(['process 40']);
    expect(found[0]!.what).toMatch(/started before its files were updated/);
  });

  it('finds an older MCP server or command that names this workspace in its arguments, wherever it runs and when its folder is unknown (macOS)', async () => {
    const backend = path.join(root, 'old');
    await fs.mkdir(path.join(backend, 'dist', 'core'), { recursive: true });
    await fs.writeFile(path.join(backend, 'dist', 'core', 'plan-file-store.js'), '');
    const entry = path.join(backend, 'dist', 'index.js');
    const found = await findOlderWriters(root, {
      ...defaultDeps, selfPid: 1, env: { HOME: '/home/someone' }, pidAlive: () => false,
      processes: async () => [
        { pid: 30, args: ['node', entry, 'mcp', 'run', root, '--role', 'interactive'], cwd: '/home/someone' },
        { pid: 31, args: ['node', entry, 'plan', 'done', 'x', '-w', root] }, // no folder known
        { pid: 32, args: ['node', entry, 'plan', `--workspace=${path.join(root, 'sub')}`] },
        { pid: 33, args: ['node', 'dist/index.js', 'mcp', 'run', root] }, // relative entry, no folder: it names the workspace
        { pid: 34, args: ['node', 'dist/index.js', 'mcp', 'run', '/somewhere/else'] }, // relative, no folder, not ours: unknown, skipped
        { pid: 35, args: ['node', entry, 'mcp', 'run', '/somewhere/else'], cwd: '/home/someone' },
      ],
    });
    expect(found.map((f) => f.found.split(':')[0])).toEqual(['process 30', 'process 31', 'process 32', 'process 33']);
    expect(found[3]!.what).toMatch(/cannot tell whether it knows the workspace database/);
  });
});

// ─── Fix round 2 ────────────────────────────────────────────────────────────

const stopAt = (step: MigrateStep) => opts({ afterStep: (at) => { if (at === step) throw new Error(`stopped after ${step}`); } });

describe('a switch or manifest a power cut left empty or garbled still leads to a working command', () => {
  for (const [what, text] of [['empty', ''], ['garbled', '{ "state": "on", "arch'], ['of an unknown state', '{"state":"bogus"}']] as const) {
    it(`a switch file that is ${what}: status names the move's archive, and restore undoes it byte for byte`, async () => {
      await fullWorkspace();
      const before = await treeHash();
      const result = await migrateWorkspace(root, opts());
      await fs.writeFile(path.join(root, SWITCH_FILE), text);
      const status = await migrateStatus(root);
      expect(status).toMatchObject({ moved: 'unreadable', archive: result.archive });
      expect(status.earlier.map((e) => e.archive)).not.toContain(result.archive);
      expect(status.offers.join('\n')).toContain(`ctxspace plan restore ${result.archive}`);
      await expect(migrateWorkspace(root, opts())).rejects.toThrow(/cannot be read/);
      const restored = await restoreWorkspace(root, result.archive, { by: 'user' });
      expect(restored.putBack).toContain('PLAN.md');
      expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
      expect(readSwitch(root)).toBeNull();
    });
  }

  it('an unreadable switch does not let an archive that was restored already be restored again', async () => {
    await fullWorkspace();
    const one = await migrateWorkspace(root, opts());
    await restoreWorkspace(root, one.archive, { by: 'user' });
    const two = await migrateWorkspace(root, opts());
    await fs.writeFile(path.join(root, SWITCH_FILE), '');
    await expect(restoreWorkspace(root, one.archive, { by: 'user' })).rejects.toThrow(/already restored/);
    expect((await migrateStatus(root)).archive).toBe(two.archive);
  });

  it('an empty manifest after a finished move: restore uses the copy in the state file', async () => {
    await fullWorkspace();
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    await fs.writeFile(path.join(root, result.archive, 'manifest.json'), '');
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
  });

  it('an empty manifest and no database to read a copy from: restore uses the copy in the state file', async () => {
    await fullWorkspace();
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    await fs.writeFile(path.join(root, result.archive, 'manifest.json'), '');
    const gone = path.join(root, '..', `${path.basename(root)}-gone.db`);
    await fs.rename(path.join(root, '.contextspace', 'workspace.db'), gone);
    try {
      await restoreWorkspace(root, result.archive, { by: 'user' });
      expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
    } finally {
      await fs.rm(gone, { force: true });
    }
  });

  it('an empty manifest and no state record: restore uses the copy in the database\'s import record', async () => {
    await fullWorkspace();
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    await fs.writeFile(path.join(root, result.archive, 'manifest.json'), '');
    const state = JSON.parse(await read('.contextspace/state.json'));
    delete state.workspaceDb;
    await write('.contextspace/state.json', JSON.stringify(state));
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
  });

  it('an empty switch and an empty manifest together: restore still works', async () => {
    await fullWorkspace();
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    await fs.writeFile(path.join(root, SWITCH_FILE), '');
    await fs.writeFile(path.join(root, result.archive, 'manifest.json'), '');
    expect((await migrateStatus(root)).archive).toBe(result.archive);
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
  });

  for (const step of ['recorded', 'database', 'archived'] as const) {
    it(`an empty manifest after a stop at "${step}": migrate again finishes the move`, async () => {
      await fullWorkspace();
      await expect(migrateWorkspace(root, stopAt(step))).rejects.toThrow(`stopped after ${step}`);
      const record = readSwitch(root)!;
      await fs.writeFile(path.join(root, record.archive!, 'manifest.json'), '');
      const result = await migrateWorkspace(root, opts());
      expect(result.how).toBe(step === 'recorded' ? 'restarted' : 'resumed');
      expect((await migrateStatus(root))).toMatchObject({ moved: 'on', database: 'present' });
    });
  }
});

describe('what an undone move says (N1)', () => {
  it('names a hand edit made during the move and where it is kept, instead of "every file is back as it was"', async () => {
    await fullWorkspace();
    await expect(migrateWorkspace(root, stopAt('plan'))).rejects.toThrow('stopped after plan');
    await fs.appendFile(path.join(root, 'PLAN.md'), '- [ ] typed into the new PLAN.md\n'); // a save during the move
    await write('contextspace-board.json', JSON.stringify({ ...BOARD, revision: 9 }, null, 2)); // and one that undoes it
    const error = await migrateWorkspace(root, opts()).catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/stopped and was undone: PLAN\.md was written again during the move/);
    const kept = /PLAN\.md is at (\S+?)[;.] /.exec(error.message)?.[1];
    expect(kept).toMatch(/\/came-back\/PLAN\.md$/);
    expect(await read(kept!)).toContain('typed into the new PLAN.md');
    expect(error.message).toMatch(/left in its place as it is \(the newer version\): contextspace-board\.json/);
    expect(error.message).not.toMatch(/^.*Every file is back as it was/);
    expect(await read('PLAN.md')).toBe(PLAN);
  });
});

describe('a refusal in the middle of a move (N2)', () => {
  it('says the workspace is still in the middle of a move, and how to go on', async () => {
    await fullWorkspace();
    await expect(migrateWorkspace(root, stopAt('database'))).rejects.toThrow('stopped after database');
    const error = await migrateWorkspace(root, opts({ findOlderWriters: async () => [{ what: 'An old one', found: 'here', stop: 'stop it' }] })).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(MoveRefusedError);
    expect(error.message).not.toMatch(/Nothing was changed/);
    expect(error.message).toMatch(/still in the middle of a move \(\.contextspace\/archive\/pre-db-[^)]+\)[\s\S]*Run `ctxspace plan migrate` again to finish it, or `ctxspace plan restore/);
    expect(readSwitch(root)?.state).toBe('moving');
  });
});

describe('one name for the live database (N3)', () => {
  it('a resume after a stop between linking the database in and removing the staged name leaves no second name', async () => {
    await fullWorkspace();
    await expect(migrateWorkspace(root, stopAt('database'))).rejects.toThrow('stopped after database');
    const manifest = JSON.parse(await read(`${readSwitch(root)!.archive}/manifest.json`));
    const live = path.join(root, '.contextspace', 'workspace.db');
    const staged = path.join(root, ...manifest.staging.split('/'), '.contextspace', 'workspace.db');
    await fs.link(live, staged); // as if the process stopped right after the link
    const result = await migrateWorkspace(root, opts());
    const ino = (await fs.stat(live)).ino;
    const sameFile: string[] = [];
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full); else if (full !== live && (await fs.stat(full)).ino === ino) sameFile.push(full);
      }
    };
    await walk(root);
    expect(sameFile).toEqual([]);
    expect(result.how).toBe('resumed');
  });
});

describe('a journal left behind by an interrupted restore (N4)', () => {
  it('follows its database into the archive when the restore runs again', async () => {
    await fullWorkspace();
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    await expect(restoreWorkspace(root, result.archive, { by: 'user', afterStep: (s) => { if (s === 'guarded') throw new Error('stop'); } })).rejects.toThrow('stop');
    // stopped after moving the database aside and before its journal
    const live = path.join(root, '.contextspace', 'workspace.db');
    await fs.mkdir(path.join(root, result.archive, 'database'), { recursive: true });
    await fs.rename(live, path.join(root, result.archive, 'database', 'workspace.db'));
    await fs.writeFile(`${live}-journal`, 'a hot journal');
    const restored = await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(await there('.contextspace/workspace.db-journal')).toBe(false);
    expect(await read(`${result.archive}/database/workspace.db-journal`)).toBe('a hot journal');
    expect(restored.databaseKeptAs).toEqual([`${result.archive}/database/workspace.db-journal`]);
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
  });
});

describe('the launchers, as generateWorkspaceTools writes them on every platform (N8)', () => {
  async function oldBackend(name: string) {
    const backend = path.join(root, name);
    await fs.mkdir(path.join(backend, 'dist', 'core'), { recursive: true });
    await fs.writeFile(path.join(backend, 'dist', 'index.js'), '');
    await fs.writeFile(path.join(backend, 'dist', 'core', 'plan-file-store.js'), '');
    await fs.writeFile(path.join(backend, 'package.json'), JSON.stringify({ version: '2.48.1' }));
    return path.join(backend, 'dist', 'index.js');
  }
  const deps = { ...defaultDeps, processes: async () => [] };

  it('reads the shell and the Windows form, and names one program once with every launcher that runs it', async () => {
    const entry = await oldBackend("it's old");
    const shell = `#!/bin/sh\n# Generated by ContextSpace: workspace CLI\n[ -f '${entry.replaceAll("'", "'\\''")}' ] || exit 127\nexport ELECTRON_RUN_AS_NODE=1\nexec '/x/contextspace-desktop' '${entry.replaceAll("'", "'\\''")}' "$@"\n`;
    const cmd = `@echo off\r\nrem Generated by ContextSpace: workspace CLI\r\nsetlocal DisableDelayedExpansion\r\nif not exist "${entry}" (echo gone 1>&2 & exit /b 127)\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\x\\contextspace-desktop.exe" "${entry.replaceAll('%', '%%')}" %*\r\nexit /b %errorlevel%\r\n`;
    for (const name of ['ctxspace', 'contextspace']) await write(`.contextspace/bin/${name}`, shell);
    for (const name of ['ctxspace.cmd', 'contextspace.cmd']) await write(`.contextspace/bin/${name}`, cmd);
    const found = await findOlderWriters(root, deps);
    expect(found).toHaveLength(1);
    expect(found[0]!.found).toBe(`.contextspace/bin/ctxspace, .contextspace/bin/contextspace, .contextspace/bin/ctxspace.cmd, .contextspace/bin/contextspace.cmd → ${entry}`);
    expect(found[0]!.what).toMatch(/2\.48\.1/);
  });

  it('a launcher in a shape ContextSpace does not write is refused, not passed', async () => {
    await write('.contextspace/bin/ctxspace', '#!/bin/sh\nnode /opt/somewhere/cli.js "$@"\n');
    const found = await findOlderWriters(root, deps);
    expect(found.map((f) => f.found)).toEqual(['.contextspace/bin/ctxspace']);
    expect(found[0]!.what).toMatch(/not in a form ContextSpace writes/);
    await fullWorkspace();
    await expect(migrateWorkspace(root, opts({ findOlderWriters: (r) => findOlderWriters(r, deps) }))).rejects.toThrow(/Nothing was changed[\s\S]*not in a form ContextSpace writes/);
  });
});

// ─── Fix round 3 ────────────────────────────────────────────────────────────

describe('a save that landed in the archive while the move was renaming it (fix round 3, Fable\'s RACE cases)', () => {
  const NEWER = '{"version":1,"revision":8,"cards":[],"links":[],"positions":{}}';
  async function race(variant: 'linked-both' | 'renamed-only') {
    await fullWorkspace();
    await expect(migrateWorkspace(root, stopAt('data'))).rejects.toThrow('stopped after data');
    const record = readSwitch(root)!;
    const live = path.join(root, 'contextspace-board.json');
    const archived = path.join(root, record.archive!, 'files', 'contextspace-board.json');
    await fs.writeFile(live, NEWER); // an editor or a git checkout, not waiting for any lock
    if (variant === 'linked-both') await fs.link(live, archived); else await fs.rename(live, archived);
    return record.archive!;
  }

  for (const variant of ['linked-both', 'renamed-only'] as const) {
    it(`${variant}: migrate again undoes the move, keeps the newer Board in its place and says so`, async () => {
      const archive = await race(variant);
      const error = await migrateWorkspace(root, opts()).catch((e: unknown) => e as Error);
      expect(error.message).toMatch(/stopped and was undone: the archive's copy of contextspace-board\.json is not the file that was moved/);
      expect(error.message).toMatch(/back in its place in that newer version: contextspace-board\.json/);
      expect(readSwitch(root)).toBeNull();
      expect(await read('contextspace-board.json')).toBe(NEWER);
      expect(await read('PLAN.md')).toBe(PLAN);
      expect(await there(`${archive}/files/contextspace-board.json`)).toBe(false);
      await expect(migrateWorkspace(root, opts())).resolves.toMatchObject({ how: 'fresh' }); // and the next move goes ahead
    });

    it(`${variant}: restore undoes it too`, async () => {
      const archive = await race(variant);
      const restored = await restoreWorkspace(root, archive, { by: 'user' });
      expect(restored.newerInPlace).toEqual(['contextspace-board.json']);
      expect(await read('contextspace-board.json')).toBe(NEWER);
      expect(readSwitch(root)).toBeNull();
    });
  }

  it('two different saves (one in the archive, one in place): the one in place stays, the other is kept in came-back/', async () => {
    const archive = await race('renamed-only');
    await write('contextspace-board.json', '{"third":"save"}');
    const restored = await restoreWorkspace(root, archive, { by: 'user' });
    expect(await read('contextspace-board.json')).toBe('{"third":"save"}');
    expect(restored.cameBack).toEqual([{ path: 'contextspace-board.json', keptAs: `${archive}/came-back/contextspace-board.json` }]);
    expect(await read(`${archive}/came-back/contextspace-board.json`)).toBe(NEWER);
  });

  it('when files are really gone, the words never send the person to a command that would refuse again', async () => {
    await fullWorkspace();
    await expect(migrateWorkspace(root, stopAt('archived'))).rejects.toThrow('stopped after archived');
    const archive = readSwitch(root)!.archive!;
    await fs.rm(path.join(root, archive, 'files', 'contextspace-board.json')); // gone from the archive, and not in its place
    const error = await migrateWorkspace(root, opts()).catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/contextspace-board\.json: it is in neither the archive nor the workspace/);
    expect(error.message).toMatch(/Bring those files back to [^\s]+\/files\/ \(from Git or a backup/);
    expect(error.message).not.toMatch(/Run `ctxspace plan migrate` again/);
    expect(readSwitch(root)?.state).toBe('moving');
  });
});

describe('a manifest lost after a restore stopped (fix round 3, note 2)', () => {
  it('is read from the database the restore had moved into the archive, and written back', async () => {
    await fullWorkspace();
    const before = await treeHash();
    const result = await migrateWorkspace(root, opts());
    await expect(restoreWorkspace(root, result.archive, { by: 'user', afterStep: (s) => { if (s === 'state') throw new Error('stop'); } })).rejects.toThrow('stop');
    await fs.writeFile(path.join(root, result.archive, 'manifest.json'), '');
    await restoreWorkspace(root, result.archive, { by: 'user' });
    expect(withoutMoveLeftovers(await treeHash())).toEqual(before);
    expect(JSON.parse(await read(`${result.archive}/manifest.json`))).toMatchObject({ id: result.id, archive: result.archive });
    expect(await read(`${result.archive}/manifest.json.damaged`)).toBe('');
  });
});

describe('a half-moved workspace that was copied (fix round 3, note 3)', () => {
  it('finishes in the copy and makes its backup there, never in the folder the move started in', async () => {
    await fullWorkspace();
    await expect(migrateWorkspace(root, stopAt('database'))).rejects.toThrow('stopped after database');
    const copy = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-copy-')));
    try {
      await fs.cp(root, copy, { recursive: true });
      const result = await migrateWorkspace(copy, opts({ backup: true }));
      expect(result.workspace).toBe(copy);
      expect(result.backup).toMatch(/^\.contextspace\/backups\//);
      expect((await fs.readdir(path.join(copy, '.contextspace', 'backups'))).length).toBe(1);
      expect(await there('.contextspace/backups')).toBe(false); // the original got nothing
    } finally {
      await fs.rm(copy, { recursive: true, force: true });
    }
  });
});
