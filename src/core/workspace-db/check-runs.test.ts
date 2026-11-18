import { afterEach, describe, expect, it } from 'vitest';

import { finishCheckRun, getBlock, listBlocks, listCheckRuns, startCheckRun, type BatchResult, type Op } from './index.js';
import { contentHash } from './check-runs.js';
import { apply, cleanTemp, idOf, rev, seeded, applyBatch } from './testing.js';

afterEach(cleanTemp);

type Db = Awaited<ReturnType<typeof seeded>>['db'];

const attempt = (db: Db, ops: Op[]): Promise<BatchResult> => applyBatch(db, { ifRevision: rev(db), ops }, { by: 'ai' });
const refusal = (r: BatchResult) => {
  if (r.ok) throw new Error('expected a refusal');
  expect(r.errors[0]!.code).toBe('check_required');
  return r.errors[0]!;
};
function hashOf(db: Db, id: string): string {
  const b = db.sqlite.prepare('SELECT text, detail FROM blocks WHERE id = ?').get(id) as { text: string; detail: string };
  return contentHash(b.text, b.detail);
}
async function passingRun(db: Db, id: string) {
  const run = await startCheckRun(db, id, { by: 'user' });
  return finishCheckRun(db, run.id, { exitCode: 0 , dbId: run.dbId});
}

describe('check runs (v5 point 5)', () => {
  it('tick with no run is refused, naming the check and what to run', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint'); // Check: the workspace checks
    const e = refusal(await attempt(db, [{ op: 'tick', id: cp }]));
    expect(e.message).toMatch(/cannot be ticked: it has the check the workspace checks, and no passing run matches it at rev 1 \(it has never been run\)/);
    expect(e.message).toMatch(/Run `ctxspace plan done .*`/);
    expect(getBlock(db, cp)!.done).toBe(false);
  });

  it('a run is written before the check runs, captures the check and rev, and changes nothing else', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    const before = rev(db);
    const run = await startCheckRun(db, cp, { by: 'claude', sha: 'abc1234' });
    expect(run).toMatchObject({ itemId: cp, itemRev: 1, checkKind: 'workspace', command: null, status: 'running', legacy: false, by: 'claude', sha: 'abc1234' });
    expect(run.dbId).toMatch(/^[0-9a-f]{16}$/);
    expect(rev(db)).toBe(before); // a run does not touch the plan or its revision
    expect((await attempt(db, [{ op: 'tick', id: cp }])).ok).toBe(false); // still running: it does not count
    const done = await finishCheckRun(db, run.id, { exitCode: 0 , dbId: run.dbId});
    expect(done).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(done.finishedAt).not.toBeNull();
    await expect(finishCheckRun(db, run.id, { exitCode: 0 , dbId: run.dbId})).rejects.toThrow(/already finished/);
  });

  it('a matching passing run allows the tick, and the tick still needs only that run', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    await passingRun(db, cp);
    await apply(db, [{ op: 'tick', id: cp }]);
    expect(getBlock(db, cp)!.done).toBe(true);
  });

  it('a failed run, or one that ended in error, does not count', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    const failed = await startCheckRun(db, cp, { by: 'user' });
    await finishCheckRun(db, failed.id, { exitCode: 1 , dbId: failed.dbId});
    const errored = await startCheckRun(db, cp, { by: 'user' });
    await finishCheckRun(db, errored.id, { exitCode: 0, error: true , dbId: errored.dbId});
    const e = refusal(await attempt(db, [{ op: 'tick', id: cp }]));
    expect(e.message).toMatch(/last run \(#\d+\) is error/);
  });

  it('a stale rev is refused: the run was at rev 1 and the checkpoint is now rev 2', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    await passingRun(db, cp);
    await apply(db, [{ op: 'edit', id: cp, find: 'Second', replace: '2nd' }]);
    const e = refusal(await attempt(db, [{ op: 'tick', id: cp }]));
    expect(e.message).toMatch(/was at rev 1 and it is now rev 2/);
    await passingRun(db, cp); // a new run at rev 2 passes
    expect((await attempt(db, [{ op: 'tick', id: cp }])).ok).toBe(true);
  });

  it('a changed check is refused: a run for the old command does not prove the new one', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV'); // ticked, Check: `npm test`
    await apply(db, [{ op: 'untick', id: cp }]);
    await passingRun(db, cp);
    await apply(db, [{ op: 'edit', id: cp, in: 'detail', find: 'npm test', replace: 'npm run lint' }]);
    const e = refusal(await attempt(db, [{ op: 'tick', id: cp }]));
    expect(e.message).toMatch(/no passing run matches it at rev 3/);
  });

  it('changing the check and ticking in one batch is refused', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    await apply(db, [{ op: 'untick', id: cp }]);
    await passingRun(db, cp); // a passing run of `npm test` at the current rev
    const e = refusal(await attempt(db, [{ op: 'edit', id: cp, in: 'detail', find: 'npm test', replace: 'true' }, { op: 'tick', id: cp }]));
    expect(e.message).toMatch(/changes the check to `true` and ticks the checkpoint in one go/);
    expect(getBlock(db, cp)!.done).toBe(false);
  });

  it('changing the check of a ticked checkpoint is refused: the tick proved the old one', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    const e = refusal(await attempt(db, [{ op: 'edit', id: cp, in: 'detail', find: 'npm test', replace: 'true' }]));
    expect(e.message).toMatch(/is ticked and this batch changes its check to `true`.*Untick it, change the check/);
  });

  it('an add that is already ticked is refused when it has a check, and allowed when it has none', async () => {
    const { db } = await seeded();
    const e = refusal(await attempt(db, [{ op: 'add', kind: 'checkpoint', text: 'Pre-ticked', check: 'npm test', done: true }]));
    expect(e.message).toMatch(/cannot be added already ticked/);
    expect((await attempt(db, [{ op: 'add', kind: 'checkpoint', text: 'No check, ticked', done: true }])).ok).toBe(true);
    expect(listBlocks(db).some((b) => b.name === 'Pre-ticked')).toBe(false);
  });

  it('a checkpoint without a Check: line is ticked with no run', async () => {
    const { db } = await seeded();
    expect((await attempt(db, [{ op: 'tick', id: idOf(db, 'Third checkpoint') }])).ok).toBe(true);
  });

  it('a legacy run never counts, even a passing one at the right rev', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    const dbId = (db.sqlite.prepare("SELECT value FROM meta WHERE key = 'db_id'").get() as { value: string }).value;
    db.sqlite.prepare("INSERT INTO check_runs(item_id, item_rev, content_hash, db_id, check_kind, command, status, exit_code, started_at, finished_at, by, legacy) VALUES (?, 1, ?, ?, 'workspace', NULL, 'passed', 0, ?, ?, 'import', 1)")
      .run(cp, hashOf(db, cp), dbId, new Date().toISOString(), new Date().toISOString());
    const e = refusal(await attempt(db, [{ op: 'tick', id: cp }]));
    expect(e.message).toMatch(/only runs are old imported evidence, which never counts/);
  });

  it('a run from another database never counts (a restored backup changes db_id)', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    db.sqlite.prepare("INSERT INTO check_runs(item_id, item_rev, content_hash, db_id, check_kind, command, status, exit_code, started_at, finished_at, by, legacy) VALUES (?, 1, 'x', 'otherdb', 'workspace', NULL, 'passed', 0, ?, ?, 'user', 0)")
      .run(cp, new Date().toISOString(), new Date().toISOString());
    refusal(await attempt(db, [{ op: 'tick', id: cp }]));
  });

  it('untick then tick again needs a fresh run: the untick moved the rev', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    await passingRun(db, cp);
    await apply(db, [{ op: 'tick', id: cp }]);
    await apply(db, [{ op: 'untick', id: cp }]);
    refusal(await attempt(db, [{ op: 'tick', id: cp }]));
  });

  it('rewording a ticked checkpoint needs no new proof, and the run guard only looks at what the batch changed', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    expect(getBlock(db, cp)!.done).toBe(true); // ticked in the sample, with no run on record
    expect((await attempt(db, [{ op: 'reword', id: cp, text: 'Reports export to CSV and JSON', rev: 1 }])).ok).toBe(true);
  });

  it('only a checkpoint with a check can have a run, and runs are listed newest first', async () => {
    const { db } = await seeded();
    await expect(startCheckRun(db, idOf(db, 'Third checkpoint'), { by: 'user' })).rejects.toThrow(/has no Check: line/);
    await expect(startCheckRun(db, idOf(db, 'Write the file'), { by: 'user' })).rejects.toThrow(/only a checkpoint has a check/);
    const cp = idOf(db, 'Second checkpoint');
    await passingRun(db, cp);
    await passingRun(db, cp);
    expect(listCheckRuns(db, cp).map((r) => r.id)).toEqual([2, 1]);
  });
});
