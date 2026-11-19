/** Fix round 1: one group per finding of the Sol review (review1.log). Each test failed on the first freeze. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import * as api from './index.js';
import { applyBatch, dbFilePath, exportPlan, getBlock, getItem, listBlocks, listCards, maybeBackup, listBackups, restoreBackup, runQuery, startCheckRun, finishCheckRun, importPlanText, openWorkspaceDb, stripExport, WorkspaceDbError, planView, type BatchResult, type Op } from './index.js';
import { SAMPLE_PLAN, apply, cleanTemp, idOf, openTest, rev, runChild, seeded, tempWorkspace, track, undo } from './testing.js';

afterEach(cleanTemp);

type Db = Awaited<ReturnType<typeof seeded>>['db'];
const dbOf = (db: Db) => (db.sqlite.prepare("SELECT value FROM meta WHERE key = 'db_id'").get() as { value: string }).value;
/** A batch with its generation, written against `base`. */
const at = (db: Db, base: number, ops: Op[], extra: Record<string, unknown> = {}) => applyBatch(db, { ifRevision: base, dbId: dbOf(db), ops, ...extra } as never, { by: 'ai' });
const refused = (r: BatchResult) => { if (r.ok) throw new Error(`expected a refusal, got ok at r${r.revision}`); return r.errors[0]!; };
const worstGap = async <T>(run: () => Promise<T>): Promise<{ value: T | undefined; error: unknown; worst: number; took: number }> => {
  let worst = 0; let last = Date.now();
  const timer = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 5);
  const started = Date.now();
  let value: T | undefined; let error: unknown;
  try { value = await run(); } catch (e) { error = e; }
  await new Promise((r) => setTimeout(r, 25)); // let a timer that was held back by a blocking call fire and be counted
  clearInterval(timer);
  return { value, error, worst, took: Date.now() - started };
};

describe('1. a stale cascade uses the range it deletes', () => {
  it('prose between the children is in the footprint: a stale remove after an edit of it is refused', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    const prose = listBlocks(db).find((b) => b.kind === 'prose' && b.text.includes('A paragraph between two items'))!;
    await apply(db, [{ op: 'block.set', id: prose.id, text: 'Someone wrote this prose.', rev: 1 }]);
    const e = refused(await at(db, 1, [{ op: 'remove', id: cp, rev: 1, cascade: true }]));
    expect(e.code).toBe('stale_revision');
    expect(getBlock(db, prose.id)!.text).toContain('Someone wrote this prose.');
  });

  it('a card detached from the step since the base counts as a conflict', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Plain step with `code` and a <!-- comment -->');
    const made = await apply(db, [{ op: 'card.add', title: 'About it', step }]);
    const base = rev(db);
    await apply(db, [{ op: 'card.update', id: made.newIds[0]!, step: null }]);
    expect(refused(await at(db, base, [{ op: 'remove', id: step, rev: 1 }])).code).toBe('stale_revision');
  });

  it('a link that was deleted since the base counts as a conflict (really a link, not a position)', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Third checkpoint');
    const made = await apply(db, [{ op: 'card.add', title: 'A' }]);
    await apply(db, [{ op: 'link', from: made.newIds[0]!, to: `checkpoint:${cp}` }]);
    const base = rev(db);
    await apply(db, [{ op: 'unlink', from: made.newIds[0]!, to: `checkpoint:${cp}` }]);
    expect(refused(await at(db, base, [{ op: 'remove', id: cp, rev: 1 }])).code).toBe('stale_revision');
  });
});

describe('2. undo', () => {
  it('is refused when a newer card, position or link points at what it would delete; nothing is cleared silently', async () => {
    const { db } = await seeded();
    const added = await apply(db, [{ op: 'add', kind: 'checkpoint', text: 'Temporary checkpoint' }]);
    const x = added.newIds[0]!;
    const made = await apply(db, [{ op: 'card.add', title: 'Later card', step: x, area: `checkpoint:${x}` }, { op: 'place', node: `checkpoint:${x}`, x: 1, y: 2 }]);
    const before = JSON.stringify(listCards(db));
    const u = await undo(db, added.seq, { by: 'user' });
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.errors[0]!.message).toMatch(new RegExp(`${made.newIds[0]}|checkpoint:${x}`));
    expect(JSON.stringify(listCards(db))).toBe(before);
    expect(getBlock(db, x)).not.toBeNull();
  });

  it('is refused when the result would not read back as meant (a step left where a checkpoint would be read)', async () => {
    const { db } = await seeded();
    const heading = await apply(db, [{ op: 'add', kind: 'heading', text: 'Notes', after: idOf(db, 'Third checkpoint') }]);
    await apply(db, [{ op: 'add', kind: 'step', text: 'Loose under notes', in: heading.newIds[0]! }]);
    const u = await undo(db, heading.seq, { by: 'user' });
    expect(u.ok).toBe(false);
    expect(stripExport(api.exportPlanMarkdown(db))).toContain('## Notes');
  });

  it('records the derived section changes a heading add causes', async () => {
    const { db } = await seeded();
    const second = idOf(db, 'Second checkpoint');
    const r = await apply(db, [{ op: 'add', kind: 'heading', text: 'Notes', level: 3, after: idOf(db, 'Reports export to CSV') }]);
    const rows = JSON.parse((db.sqlite.prepare('SELECT rows FROM changes WHERE seq = ?').get(r.seq) as { rows: string }).rows) as Array<{ id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>;
    const row = rows.find((x) => x.id === second);
    expect(row, 'the block whose section changed is in the record').toBeDefined();
    expect(row!.before!.section_id).not.toBe(row!.after!.section_id);
  });
});

describe('3. restore', () => {
  it('works over a corrupt live file: the damaged file is kept aside, never deleted', async () => {
    const { ws, db } = await seeded();
    await maybeBackup(ws);
    db.close();
    const junk = Buffer.from('not a database '.repeat(100));
    writeFileSync(dbFilePath(ws), junk);
    const result = restoreBackup(ws, listBackups(ws)[0]!);
    expect(readFileSync(result.keptAs!).equals(junk)).toBe(true);
    expect(listBlocks(openTest(ws)).length).toBeGreaterThan(10);
  });

  // POSIX: a file can be deleted while a connection has it open. Windows refuses (EPERM), see the twin below.
  it.skipIf(process.platform === 'win32')('a connection whose file vanished fails closed instead of writing into an unlinked file', async () => {
    const { ws, db } = await seeded();
    rmSync(dbFilePath(ws));
    await expect(at(db, 1, [{ op: 'tick', id: idOf(db, 'Write the file') }])).rejects.toMatchObject({ code: 'replaced' });
  });

  it.runIf(process.platform === 'win32')('on Windows the open database file cannot be deleted, and the connection stays current and writable', async () => {
    const { ws, db } = await seeded();
    expect(() => rmSync(dbFilePath(ws))).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(EPERM|EBUSY|EACCES)$/) }));
    expect(existsSync(dbFilePath(ws))).toBe(true);
    expect(db.isCurrent()).toBe(true);
    expect((await at(db, 1, [{ op: 'tick', id: idOf(db, 'Write the file') }])).ok).toBe(true);
  });

  // POSIX mechanism: another process renames a file over the live one. Windows refuses that rename while the file is open; its rule is in runtime.test.ts (`file_in_use`).
  it.skipIf(process.platform === 'win32')('a writer waiting for the lock while the file is replaced gets `replaced`, not a write into the old file', async () => {
    const { ws, db } = await seeded();
    await maybeBackup(ws);
    const holder = runChild(`
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      db.sqlite.exec('BEGIN IMMEDIATE'); console.log('HELD');
      await new Promise((r) => setTimeout(r, 900));
      db.sqlite.exec('ROLLBACK');
    `, { WS: ws });
    await holder.waitFor('HELD');
    const swapper = runChild(`
      import { renameSync, copyFileSync } from 'node:fs';
      await new Promise((r) => setTimeout(r, 250));
      copyFileSync(process.env.BK, process.env.LIVE + '.new');
      renameSync(process.env.LIVE + '.new', process.env.LIVE);
    `, { BK: path.join(ws, '.contextspace', 'backups', listBackups(ws)[0]!), LIVE: dbFilePath(ws) });
    const result = await at(db, 1, [{ op: 'tick', id: idOf(db, 'Write the file') }]).then(() => 'wrote', (e: unknown) => (e as WorkspaceDbError).code);
    await Promise.all([holder.done, swapper.done]);
    expect(result).toBe('replaced');
  });

  it('a stale hot journal beside the live file is moved aside with it, not left to be applied to the restored file', async () => {
    const { ws, db } = await seeded();
    await maybeBackup(ws);
    db.close();
    writeFileSync(`${dbFilePath(ws)}-journal`, Buffer.alloc(512, 7));
    const r = restoreBackup(ws, listBackups(ws)[0]!);
    expect(existsSync(`${dbFilePath(ws)}-journal`)).toBe(false);
    // SQLite itself discards a journal with no valid header when the live file is opened for the scan; a valid one would have been moved aside
    expect(readFileSync(r.keptAs!).length).toBeGreaterThan(0);
  });
});

describe('4. generation and request replay', () => {
  it('a batch must carry dbId with ifRevision', async () => {
    const { db } = await seeded();
    const e = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] } as never, { by: 'ai' }));
    expect(e.code).toBe('missing_revision');
    expect(e.message).toMatch(/dbId/);
  });

  it('after a restore that lands on the same revision, an old batch (no dbId, or the old one) is refused, and an exact retry is not replayed', async () => {
    const { ws, db } = await seeded();
    await maybeBackup(ws);
    const oldId = dbOf(db);
    const first = await at(db, 1, [{ op: 'tick', id: idOf(db, 'Write the file') }], { requestId: 'before-restore' });
    expect(first.ok).toBe(true);
    db.close(); // Windows cannot replace a database file another connection still has open; the replaced-file rules are in runtime.test.ts
    restoreBackup(ws, listBackups(ws)[0]!);
    const fresh = openTest(ws);
    expect(rev(fresh)).toBe(2);
    const noId = refused(await applyBatch(fresh, { ifRevision: 2, ops: [{ op: 'tick', id: idOf(fresh, 'Nested step one') }] } as never, { by: 'ai' }));
    expect(['missing_revision', 'db_changed']).toContain(noId.code);
    const retry = await applyBatch(fresh, { ifRevision: 1, dbId: oldId, requestId: 'before-restore', ops: [{ op: 'tick', id: idOf(fresh, 'Write the file') }] }, { by: 'ai' });
    expect(refused(retry).code).toBe('db_changed');
  });

  it('a request older than 7 days is ignored at lookup, with no unrelated write to prune it', async () => {
    const { db } = await seeded();
    const under = idOf(db, 'Third checkpoint');
    await at(db, 1, [{ op: 'add', kind: 'step', text: 'First', under }], { requestId: 'aged' });
    db.sqlite.prepare('UPDATE requests SET at = ?').run(new Date(Date.now() - 8 * 86_400_000).toISOString());
    const again = await at(db, 2, [{ op: 'add', kind: 'step', text: 'Second', under }], { requestId: 'aged' });
    expect(again.ok && !again.replayed).toBe(true);
  });

  it('finishing a check run needs the generation it was started in', async () => {
    const { db } = await seeded();
    const run = await startCheckRun(db, idOf(db, 'Second checkpoint'), { by: 'user' });
    await expect(finishCheckRun(db, run.id, { exitCode: 0, dbId: 'another-generation' } as never)).rejects.toThrow(/generation|db_id|another database/i);
    expect((await finishCheckRun(db, run.id, { exitCode: 0, dbId: dbOf(db) } as never)).status).toBe('passed');
  });
});

describe('5. a run proves the content it ran against', () => {
  const passing = async (db: Db, id: string) => finishCheckRun(db, (await startCheckRun(db, id, { by: 'user' })).id, { exitCode: 0, dbId: dbOf(db) } as never);

  it('rewording the checkpoint and ticking it in one batch is refused, however fresh the run', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    await passing(db, cp);
    const e = refused(await at(db, 1, [{ op: 'edit', id: cp, find: 'Second', replace: 'Changed' }, { op: 'tick', id: cp }]));
    expect(e.code).toBe('check_required');
    expect(getBlock(db, cp)!.done).toBe(false);
  });

  it('editing the detail and ticking in one batch is refused; a plain tick with the run still works', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    await passing(db, cp);
    expect(refused(await at(db, 1, [{ op: 'edit', id: cp, in: 'detail', find: 'the workspace checks', replace: 'the workspace checks.' }, { op: 'tick', id: cp }])).code).toBe('check_required');
    expect((await at(db, 1, [{ op: 'tick', id: cp }])).ok).toBe(true);
  });

  it('unticking and reticking a completed checkpoint in one batch needs proof; untouched historical completions stay exempt', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV'); // ticked on import, no run
    expect(refused(await at(db, 1, [{ op: 'untick', id: cp }, { op: 'tick', id: cp }])).code).toBe('check_required');
    expect((await at(db, 1, [{ op: 'edit', id: idOf(db, 'Write the file'), find: 'Write', replace: 'Save' }])).ok).toBe(true); // the completed checkpoint is not touched
  });

  it('undo never needs a run: undoing an untick restores the exact ticked row, and undoing a tick reopens it', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Second checkpoint');
    await passing(db, cp);
    const ticked = await at(db, 1, [{ op: 'tick', id: cp }]);
    const unticked = await at(db, 2, [{ op: 'untick', id: cp }]);
    if (!ticked.ok || !unticked.ok) throw new Error('setup');
    const redo = await undo(db, unticked.seq, { by: 'user' });
    expect(redo.ok).toBe(true);
    expect(getBlock(db, cp)!.done).toBe(true);
    expect((await undo(db, ticked.seq, { by: 'user' })).ok).toBe(false); // the row moved on since: refused, not a bypass
  });
});

describe('6. destinations', () => {
  it('a stale default add does not follow a renamed Checkpoints heading to the second one', async () => {
    const { db } = await seeded('# T\n\n## Checkpoints\n\n## Checkpoints\n');
    const first = listBlocks(db).filter((b) => b.kind === 'heading' && b.name === 'Checkpoints')[0]!;
    await apply(db, [{ op: 'block.set', id: first.id, text: '## Notes', rev: 1 }]);
    expect(refused(await at(db, 1, [{ op: 'add', kind: 'checkpoint', text: 'New one' }])).code).toBe('stale_revision');
  });

  it('a stale drag by uuid prefix is refused when the prefix names another card now', async () => {
    const { db } = await seeded();
    const made = await apply(db, [{ op: 'card.add', title: 'A' }]);
    const a = made.newIds[0]!;
    db.sqlite.prepare('UPDATE cards SET legacy_id = ? WHERE id = ?').run('aaaaaaaa-1111-4222-8333-444455556666', a);
    const base = rev(db);
    await apply(db, [{ op: 'card.remove', id: a }]);
    const b = (await apply(db, [{ op: 'card.add', title: 'B' }])).newIds[0]!;
    db.sqlite.prepare('UPDATE cards SET legacy_id = ? WHERE id = ?').run('aaaaaaab-1111-4222-8333-444455556666', b);
    const e = refused(await at(db, base, [{ op: 'place', node: 'aaaaaa', x: 5, y: 5 }]));
    expect(e.code).toBe('stale_revision');
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM positions').get()).toEqual({ n: 0 });
  });

  it('coordinates on a stable node stay last-write-wins', async () => {
    const { db } = await seeded();
    const a = (await apply(db, [{ op: 'card.add', title: 'A' }])).newIds[0]!;
    const base = rev(db);
    await apply(db, [{ op: 'place', node: a, x: 1, y: 1 }]);
    expect((await at(db, base, [{ op: 'place', node: a, x: 9, y: 9 }])).ok).toBe(true);
  });

  it('a row added earlier in the same batch needs no rev', async () => {
    const { db } = await seeded();
    const r = await at(db, 1, [{ op: 'add', kind: 'step', text: 'Temp', under: idOf(db, 'Third checkpoint'), as: 'n' }, { op: 'reword', id: '$n', text: 'Renamed' }, { op: 'remove', id: '$n' }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe('7. snapshot reads', () => {
  it('an export is one snapshot: a commit between its reads cannot give old text with a new revision', async () => {
    const { ws, db } = await seeded();
    const other = openTest(ws, 'server');
    const realReader = db.readerConnection();
    let attempted: unknown = 'not tried';
    const proxy = new Proxy(realReader, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/FROM meta/.test(sql) && attempted === 'not tried') {
              attempted = 'tried';
              try {
                other.sqlite.exec('BEGIN IMMEDIATE');
                other.sqlite.prepare("UPDATE blocks SET done = 1, text = replace(text, '[ ]', '[x]') WHERE name = 'Write the file'").run();
                other.sqlite.prepare("UPDATE meta SET value = '2' WHERE key = 'revision'").run();
                other.sqlite.exec('COMMIT');
                attempted = 'committed';
              } catch { try { other.sqlite.exec('ROLLBACK'); } catch { /* none */ } attempted = 'blocked'; }
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    db.readerConnection = () => proxy;
    const out = exportPlan(db);
    const ticked = out.text.includes('- [x] Write the file');
    expect(ticked).toBe(out.revision === 2); // the checkbox and the revision come from the same moment
    expect(attempted).not.toBe('not tried');
  });
});

describe('8. the event loop', () => {
  it('a server-mode open answers a timer within 100 ms while another process holds an exclusive lock, then opens', async () => {
    const { ws } = await seeded();
    const holder = runChild(`
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      db.sqlite.exec('BEGIN EXCLUSIVE'); console.log('HELD');
      await new Promise((r) => setTimeout(r, 700));
      db.sqlite.exec('ROLLBACK');
    `, { WS: ws });
    await holder.waitFor('HELD');
    const open = (api as unknown as { openWorkspaceDbAsync?: typeof openWorkspaceDb }).openWorkspaceDbAsync;
    const r = await worstGap(async () => (open ? await open(ws, { busy: 'server', backups: false }) : openWorkspaceDb(ws, { busy: 'server', backups: false })));
    await holder.done;
    if (r.value) track(r.value as { close(): void });
    expect(r.error).toBeUndefined();
    expect(r.worst).toBeLessThan(100);
  });

  it('a commit that meets a reader is retried between timers, not failed or blocked', async () => {
    const { ws, db } = await seeded(SAMPLE_PLAN, 'server');
    const reader = runChild(`
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      db.sqlite.exec('BEGIN'); db.sqlite.prepare('SELECT count(*) FROM blocks').get(); console.log('READING');
      await new Promise((r) => setTimeout(r, 600));
      db.sqlite.exec('COMMIT');
    `, { WS: ws });
    await reader.waitFor('READING');
    const r = await worstGap(() => at(db, 1, [{ op: 'tick', id: idOf(db, 'Write the file') }]));
    await reader.done;
    expect(r.error).toBeUndefined();
    expect((r.value as BatchResult).ok).toBe(true);
    expect(r.worst).toBeLessThan(100);
  });

  it('the daily backup does its work off the event loop', async () => {
    const { ws, db } = await seeded();
    db.sqlite.exec('BEGIN');
    const ins = db.sqlite.prepare('INSERT INTO ids_used(id) VALUES (?)');
    for (let i = 0; i < 400_000; i += 1) ins.run(`x${i.toString(36).padStart(7, '0')}`);
    db.sqlite.exec('COMMIT');
    const r = await worstGap(() => maybeBackup(ws));
    expect(r.error).toBeUndefined();
    expect(r.worst).toBeLessThan(100);
  }, 60_000);

  it('a backup is published whole (link or rename of a finished temp file): no copy fallback that can leave a partial file', () => {
    const code = readFileSync(new URL('./backup.ts', import.meta.url), 'utf8');
    expect(code.slice(code.indexOf('export async function maybeBackup'), code.indexOf('function rotate'))).not.toMatch(/COPYFILE_EXCL|copyFileSync/);
  });
});

describe('9. open is not create, and the file must be ours', () => {
  it('opening a missing database for writing does not create one', () => {
    const ws = tempWorkspace();
    expect(() => openWorkspaceDb(ws, { busy: 'cli', backups: false })).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(existsSync(dbFilePath(ws))).toBe(false);
  });

  it('a foreign database at version 0 is refused and left alone', () => {
    const ws = tempWorkspace();
    mkdirSync(path.join(ws, '.contextspace'));
    const raw = new DatabaseSync(dbFilePath(ws));
    raw.exec('CREATE TABLE unrelated (x)');
    raw.close();
    expect(() => api.createWorkspaceDb(ws, { busy: 'cli', backups: false })).toThrow(WorkspaceDbError);
    expect(() => openWorkspaceDb(ws, { busy: 'cli', backups: false })).toThrow(WorkspaceDbError);
    const after = track(new DatabaseSync(dbFilePath(ws)));
    expect((after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)).toEqual(['unrelated']);
  });

  it('a matching user_version is not enough: a missing marker, table or column is refused', async () => {
    const { ws, db } = await seeded();
    db.close();
    const raw = new DatabaseSync(dbFilePath(ws));
    raw.exec("DELETE FROM meta WHERE key = 'db_id'");
    raw.close();
    expect(() => openWorkspaceDb(ws, { busy: 'cli', backups: false })).toThrow(WorkspaceDbError);
    const ws2 = (await seeded()).ws;
    const r2 = new DatabaseSync(dbFilePath(ws2));
    r2.exec('ALTER TABLE cards DROP COLUMN look');
    r2.close();
    expect(() => openWorkspaceDb(ws2, { busy: 'cli', backups: false })).toThrow(WorkspaceDbError);
  });

  it('bootstrap only on a pristine database: an old stamped id cannot come back for other text', async () => {
    const { db } = await seeded('- [ ] one <!-- sabcde -->\n');
    await at(db, 1, [{ op: 'remove', id: 'sabcde', rev: 1 }]);
    await expect(importPlanText(db, '- [ ] different words <!-- sabcde -->\n', { by: 'import' })).rejects.toThrow(WorkspaceDbError);
    expect(listBlocks(db)).toHaveLength(0);
  });
});

describe('10. markdown', () => {
  const CRLF = '# T\r\n\r\n## Checkpoints\r\n\r\n- [ ] **One**\r\n  Check: `npm test`\r\n  - [ ] a step\r\n- [ ] **Two**\r\n';
  it('a CRLF plan imports its checkboxes as items and exports with CRLF', async () => {
    const { db } = await seeded(CRLF);
    expect(listBlocks(db).filter((b) => b.kind === 'checkpoint').map((b) => b.name)).toEqual(['One', 'Two']);
    expect(listBlocks(db).filter((b) => b.kind === 'step')).toHaveLength(1);
    expect(stripExport(api.exportPlanMarkdown(db))).toBe(CRLF);
    expect(api.exportPlanMarkdown(db)).toMatch(/-->\r\n# T/);
  });

  it('a Check: inside a code fence does not override the real check; the same for Answer:', async () => {
    const plan = '## Checkpoints\n\n- [ ] **One**\n  Check: `npm test`\n  ```text\n  Check: `fake`\n  ```\n  - [ ] Decide: Which?\n    Answer: real\n    ```text\n    Answer: example\n    ```\n';
    const { db } = await seeded(plan);
    expect(getItem(db, idOf(db, 'One'))!.check).toMatchObject({ command: 'npm test' });
    const q = idOf(db, 'Which?');
    expect(getItem(db, q)!.decision!.answer).toBe('real');
    await at(db, 1, [{ op: 'untick', id: q }]).then((r) => expect(r.ok).toBe(true));
    expect(getBlock(db, q)!.detail).toContain('Answer: example');
    expect(getBlock(db, q)!.detail).not.toContain('Answer: real');
    expect(getItem(db, q)!.decision!.answer).toBeNull();
  });
});

describe('11. query', () => {
  it.each(['auto', 'off'] as const)('rejects table-valued PRAGMA functions with the authorizer %s', async (authorizer) => {
    const { ws } = await seeded();
    for (const sql of ["select * from pragma_table_info('blocks')", 'select * from "pragma_table_info"(\'blocks\')', 'select * from PRAGMA_database_list']) {
      await expect(runQuery(ws, sql, { authorizer }), sql).rejects.toMatchObject({ code: 'query_refused' });
    }
  });

  it('validates the limits: NaN, zero, negative and non-integers are refused; large values are clamped', async () => {
    const { ws } = await seeded();
    for (const bad of [Number.NaN, 0, -1, 1.5, Infinity]) {
      await expect(runQuery(ws, 'select 1', { maxRows: bad }), `maxRows ${bad}`).rejects.toMatchObject({ code: 'query_refused' });
      await expect(runQuery(ws, 'select 1', { timeoutMs: bad }), `timeoutMs ${bad}`).rejects.toMatchObject({ code: 'query_refused' });
    }
    const big = await runQuery(ws, 'with recursive n(i) as (select 1 union all select i + 1 from n where i < 900) select i from n', { maxRows: 1e9 });
    expect(big.rows).toHaveLength(200);
  });
});

describe('later: what ships', () => {
  it('the test helpers are excluded from the build', () => {
    const tsconfig = readFileSync(new URL('../../../tsconfig.json', import.meta.url), 'utf8');
    expect(tsconfig).toMatch(/workspace-db\/testing\.ts/);
    expect(readdirSync(new URL('./', import.meta.url)).includes('testing.ts')).toBe(true);
  });
});
