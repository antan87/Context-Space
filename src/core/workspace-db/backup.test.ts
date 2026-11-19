import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { backupsDir, dbFilePath, getRevision, listBackups, listBlocks, localDay, maybeBackup, newId, createWorkspaceDb, restoreBackup, WorkspaceDbError } from './index.js';
import { SAMPLE_PLAN, apply, cleanTemp, idOf, openTest, rev, runChild, seeded, tempWorkspace, track } from './testing.js';

afterEach(cleanTemp);

const files = (ws: string) => (existsSync(backupsDir(ws)) ? readdirSync(backupsDir(ws)).sort() : []);

describe('daily backups (v5 point 7)', () => {
  it('makes one backup, checks it, and a second call the same day does nothing', async () => {
    const { ws } = await seeded();
    const first = await maybeBackup(ws);
    expect(first).toEqual({ status: 'made', file: `workspace-${localDay()}.db` });
    expect(await maybeBackup(ws)).toEqual({ status: 'exists', file: `workspace-${localDay()}.db` });
    expect(files(ws)).toEqual([`workspace-${localDay()}.db`]); // no temp or claim file is left behind
    const copy = new DatabaseSync(path.join(backupsDir(ws), first.file!), { readOnly: true });
    expect(Object.values(copy.prepare('PRAGMA integrity_check').get() as object)[0]).toBe('ok');
    expect(copy.prepare('SELECT count(*) AS n FROM blocks').get()).toEqual({ n: listBlocksCount(ws) });
    copy.close();
  });

  it('is one per day under concurrent attempts: in this process and in other processes', async () => {
    const { ws } = await seeded();
    const script = `
      import * as m from '<MODULE>';
      while (!(await import('node:fs')).existsSync(process.env.GO)) await new Promise((r) => setTimeout(r, 1));
      console.log(JSON.stringify(await m.maybeBackup(process.env.WS)));
    `;
    const go = path.join(ws, 'go');
    const kids = [runChild(script, { WS: ws, GO: go }), runChild(script, { WS: ws, GO: go })];
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(go, '1');
    const here = await Promise.all([maybeBackup(ws), maybeBackup(ws), maybeBackup(ws)]);
    await Promise.all(kids.map((k) => k.done));
    const statuses = [...here.map((r) => r.status), ...kids.map((k) => (JSON.parse(k.stdout().trim()) as { status: string }).status)];
    expect(statuses.filter((s) => s === 'made')).toHaveLength(1);
    expect(statuses.every((s) => ['made', 'exists', 'claimed'].includes(s))).toBe(true);
    expect(listBackups(ws)).toEqual([`workspace-${localDay()}.db`]);
    expect(files(ws).filter((n) => n.startsWith('.'))).toEqual([]); // temp and claim files are gone
  });

  it('an interrupted temp file is never mistaken for a backup, and a stale one is cleaned up', async () => {
    const { ws } = await seeded();
    mkdirSync(backupsDir(ws), { recursive: true });
    const half = path.join(backupsDir(ws), `.tmp-${localDay()}-999-deadbeef.db`);
    writeFileSync(half, 'half a database');
    writeFileSync(path.join(backupsDir(ws), 'workspace-2026-01-01.db.tmp'), 'not a backup either');
    expect(listBackups(ws)).toEqual([]);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(half, old, old);
    const result = await maybeBackup(ws);
    expect(result.status).toBe('made');
    expect(listBackups(ws)).toEqual([`workspace-${localDay()}.db`]);
    expect(existsSync(half)).toBe(false);
  });

  it('a claim left by a process that died is cleared after a while; a fresh one holds the day', async () => {
    const { ws } = await seeded();
    mkdirSync(backupsDir(ws), { recursive: true });
    const claim = path.join(backupsDir(ws), `.claim-${localDay()}`);
    writeFileSync(claim, '');
    expect(await maybeBackup(ws)).toEqual({ status: 'claimed' });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(claim, old, old);
    expect((await maybeBackup(ws)).status).toBe('made');
  });

  it('keeps 7, newest first, and drops the oldest', async () => {
    const { ws } = await seeded();
    for (let d = 1; d <= 10; d += 1) await maybeBackup(ws, { now: new Date(2026, 0, d, 12) });
    expect(listBackups(ws)).toEqual(['10', '09', '08', '07', '06', '05', '04'].map((day) => `workspace-2026-01-${day}.db`));
  });

  it('does nothing without a database', async () => {
    expect(await maybeBackup(tempWorkspace())).toEqual({ status: 'no_database' });
  });

  it('the first committed write of a day schedules the backup after commit, and later writes do not make another', async () => {
    const ws = tempWorkspace();
    const db = track(createWorkspaceDb(ws, { busy: 'cli' })); // backups on
    const { importPlanText } = await import('./index.js');
    await importPlanText(db, SAMPLE_PLAN, { by: 'import' });
    await db.idle();
    expect(listBackups(ws)).toEqual([`workspace-${localDay()}.db`]);
    const stat = (await import('node:fs')).statSync(path.join(backupsDir(ws), listBackups(ws)[0]!)).mtimeMs;
    await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }]);
    await db.idle();
    expect(listBackups(ws)).toHaveLength(1);
    expect((await import('node:fs')).statSync(path.join(backupsDir(ws), listBackups(ws)[0]!)).mtimeMs).toBe(stat);
  });
});

const listBlocksCount = (ws: string) => listBlocks(openTest(ws)).length;

describe('restore starts a new generation', () => {
  it('db_id changes, ids ever issued are carried over, the replaced file is kept, and the plan is the backup', async () => {
    const { ws, db } = await seeded();
    await maybeBackup(ws);
    const dbIdBefore = getRevision(db).dbId;
    const added = await apply(db, [{ op: 'add', kind: 'step', text: 'Made after the backup', under: idOf(db, 'Third checkpoint') }]);
    const lostId = added.newIds[0]!;
    db.close(); // Windows cannot replace a database file another connection still has open; the replaced-file rules are in runtime.test.ts
    const result = restoreBackup(ws, listBackups(ws)[0]!);
    expect(result.dbId).not.toBe(dbIdBefore);
    expect(result.keptAs).toMatch(/workspace\.db\.replaced-/);
    expect(existsSync(result.keptAs!)).toBe(true);
    const restored = openTest(ws);
    expect(getRevision(restored)).toEqual({ revision: 2, dbId: result.dbId }); // the backup was at revision 1, plus the restore entry
    expect(listBlocks(restored).some((b) => b.id === lostId)).toBe(false); // the step made after the backup is gone from the plan
    expect(restored.sqlite.prepare('SELECT 1 FROM ids_used WHERE id = ?').get(lostId)).toBeDefined(); // but its id is never reused
    expect(result.idsCarried).toBeGreaterThan(0);
    const [entry] = restored.sqlite.prepare("SELECT kind, summary, rows FROM changes WHERE kind = 'restore'").all() as Array<{ kind: string; summary: string; rows: string | null }>;
    expect(entry!.summary).toMatch(/restored from backup workspace-/);
    expect(entry!.rows).toBeNull();
    // a batch written against the old generation is refused, not rebased
    const stale = await (await import('./index.js')).applyBatch(restored, { ifRevision: 1, dbId: dbIdBefore, ops: [{ op: 'tick', id: idOf(restored, 'Write the file') }] }, { by: 'ai' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.errors[0]!.code).toBe('db_changed');
    // and a new id can still be made, and is not the lost one
    for (let i = 0; i < 50; i += 1) expect(newId(restored.sqlite, 'step')).not.toBe(lostId);
    // the plan keeps working
    expect(rev(restored)).toBe(2);
    expect((await apply(restored, [{ op: 'tick', id: idOf(restored, 'Write the file') }])).ok).toBe(true);
  });

  it('refuses a corrupt, missing or newer backup and leaves the live database alone', async () => {
    const { ws, db } = await seeded();
    mkdirSync(backupsDir(ws), { recursive: true });
    writeFileSync(path.join(backupsDir(ws), 'workspace-2026-02-01.db'), 'not a database at all, just words'.repeat(20));
    expect(() => restoreBackup(ws, 'workspace-2026-02-01.db')).toThrow(WorkspaceDbError);
    expect(() => restoreBackup(ws, 'workspace-2026-02-02.db')).toThrow(/There is no backup/);
    const newer = new DatabaseSync(path.join(backupsDir(ws), 'workspace-2026-02-03.db'));
    newer.exec('CREATE TABLE x (y); PRAGMA user_version = 99');
    newer.close();
    expect(() => restoreBackup(ws, 'workspace-2026-02-03.db')).toThrow(expect.objectContaining({ code: 'too_new' }));
    expect(db.isCurrent()).toBe(true);
    expect(files(ws).some((n) => n.startsWith('.restore'))).toBe(false);
    expect(readdirSync(path.join(ws, '.contextspace')).filter((n) => n.includes('replaced') || n.startsWith('.restore'))).toEqual([]);
    expect(existsSync(dbFilePath(ws))).toBe(true);
  });
});
