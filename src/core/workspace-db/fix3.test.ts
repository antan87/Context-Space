/** Fix round 3 (review3.log): findings 1, 2, 3 and 5, and the later check-run case. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { backupsDir, finishCheckRun, getBlock, listBackups, listBlocks, listCards, listLinks, localDay, maybeBackup, restoreBackup, startCheckRun, undo } from './index.js';
import { apply, cleanTemp, dbIdOf, idOf, openTest, rev, seeded } from './testing.js';

afterEach(cleanTemp);

type Db = Awaited<ReturnType<typeof seeded>>['db'];
const undoAs = (db: Db, seq: number, dbId = dbIdOf(db)) => undo(db, seq, { by: 'user', dbId } as never);

describe('1. undo cannot restore a reference to something that is gone', () => {
  it('link A-B, remove A, remove B, undo the removal of A: refused, naming B', async () => {
    const { db } = await seeded();
    const made = await apply(db, [{ op: 'card.add', title: 'A', as: 'a' }, { op: 'card.add', title: 'B', as: 'b' }]);
    const [a, b] = [made.ids.a!, made.ids.b!];
    await apply(db, [{ op: 'link', from: a, to: b }]);
    const removeA = await apply(db, [{ op: 'card.remove', id: a }]);
    await apply(db, [{ op: 'card.remove', id: b }]);
    const before = rev(db);
    const u = await undoAs(db, removeA.seq);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.errors[0]!.message).toContain(b);
    expect(rev(db)).toBe(before);
    expect(listLinks(db)).toHaveLength(0);
    expect(listCards(db)).toHaveLength(0);
  });
});

describe('2. undo is bound to its generation', () => {
  it('an undo naming the old generation does not undo a new change that landed at the same seq', async () => {
    const { ws, db } = await seeded();
    await maybeBackup(ws);
    const oldId = dbIdOf(db);
    await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }]);
    const oldSeq = (await apply(db, [{ op: 'tick', id: idOf(db, 'Nested step one') }])).seq;
    db.close(); // Windows cannot replace a database file another connection still has open; the replaced-file rules are in runtime.test.ts
    restoreBackup(ws, listBackups(ws)[0]!);
    const fresh = openTest(ws);
    const landed = await apply(fresh, [{ op: 'tick', id: idOf(fresh, 'Query the report rows') }]);
    expect(landed.seq).toBe(oldSeq); // the same number, another database
    const u = await undoAs(fresh, oldSeq, oldId);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.errors[0]!.message).toMatch(/generation|db_id|another database/i);
    expect(getBlock(fresh, idOf(fresh, 'Query the report rows'))!.done).toBe(true);
  });
});

describe('3. a commit that succeeded is never reported as failed', () => {
  /** After the next COMMIT succeeds, another connection takes the lock: a read on this connection is then refused. */
  const lockAfterCommit = (db: Db, other: Db) => {
    const real = db.sqlite;
    (db as { sqlite: unknown }).sqlite = new Proxy(real, {
      get(target, prop) {
        if (prop === 'exec') {
          return (sql: string) => {
            target.exec(sql);
            if (sql === 'COMMIT') { other.sqlite.exec('BEGIN EXCLUSIVE'); (db as { sqlite: unknown }).sqlite = real; }
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };

  it('start returns its run, a retry returns the same run (no second row), and finish reports success', async () => {
    const { ws, db } = await seeded(undefined, 'server');
    const other = openTest(ws, 'server');
    const cp = idOf(db, 'Second checkpoint');
    lockAfterCommit(db, other);
    const run = await startCheckRun(db, cp, { by: 'user' });
    other.sqlite.exec('ROLLBACK');
    expect(run.status).toBe('running');
    const retry = await startCheckRun(db, cp, { by: 'user' });
    expect(retry.id).toBe(run.id);
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM check_runs').get()).toEqual({ n: 1 });
    lockAfterCommit(db, other);
    const done = await finishCheckRun(db, run.id, { exitCode: 0, dbId: run.dbId });
    other.sqlite.exec('ROLLBACK');
    expect(done.status).toBe('passed');
  });
});

describe('5. the daily backup is never replaced', () => {
  it('a daily file that appears after the claim is left alone, and no temp file stays', async () => {
    const { ws } = await seeded();
    const dir = backupsDir(ws);
    const final = path.join(dir, `workspace-${localDay()}.db`);
    const result = await maybeBackup(ws, {
      hooks: { afterClaim: () => writeFileSync(final, 'another process made this one') },
    } as never);
    expect(result.status).toBe('exists');
    expect(readFileSync(final, 'utf8')).toBe('another process made this one');
    expect(readdirSync(dir).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('and one that appears between the copy and the publish is not replaced either', async () => {
    const { ws } = await seeded();
    const final = path.join(backupsDir(ws), `workspace-${localDay()}.db`);
    const result = await maybeBackup(ws, { hooks: { beforePublish: () => writeFileSync(final, 'first') } } as never);
    expect(result.status).toBe('exists');
    expect(readFileSync(final, 'utf8')).toBe('first');
    expect(existsSync(final)).toBe(true);
  });
});

describe('later: a check run is a dependent too', () => {
  it('undoing the add of a checkpoint is refused while a later run references it', async () => {
    const { db } = await seeded();
    const added = await apply(db, [{ op: 'add', kind: 'checkpoint', text: 'Has a run', check: 'npm test' }]);
    const run = await startCheckRun(db, added.newIds[0]!, { by: 'user' });
    await finishCheckRun(db, run.id, { exitCode: 0, dbId: run.dbId });
    const u = await undoAs(db, added.seq);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.errors[0]!.message).toMatch(/check_runs/);
    expect(listBlocks(db).some((x) => x.id === added.newIds[0])).toBe(true);
  });
});
