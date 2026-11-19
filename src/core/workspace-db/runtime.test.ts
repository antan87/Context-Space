import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { dbFilePath, exportPlanMarkdown, getRevision, listBlocks, openWorkspaceDb, planView, restoreBackup, maybeBackup, schemaText, WorkspaceDbError } from './index.js';
import { SAMPLE_PLAN, apply, cleanTemp, idOf, openTest, rev, runChild, seeded, tempWorkspace, applyBatch, track } from './testing.js';

afterEach(cleanTemp);

const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];

describe('opening', () => {
  it('sets the journal policy and the busy wait for the mode', () => {
    const ws = tempWorkspace();
    const cli = openTest(ws, 'cli');
    expect(pragma(cli.sqlite, 'journal_mode')).toBe('delete');
    expect(pragma(cli.sqlite, 'synchronous')).toBe(2); // FULL
    expect(pragma(cli.sqlite, 'foreign_keys')).toBe(1);
    expect(pragma(cli.sqlite, 'busy_timeout')).toBe(5000);
    expect(pragma(cli.sqlite, 'user_version')).toBe(1);
    const server = openTest(ws, 'server');
    expect(pragma(server.sqlite, 'busy_timeout')).toBe(0);
    expect(pragma(server.sqlite, 'journal_mode')).toBe('delete');
  });

  it('a new database is migrated once and reopens as is', () => {
    const ws = tempWorkspace();
    const a = openTest(ws);
    const id = getRevision(a).dbId;
    a.close();
    const b = openTest(ws);
    expect(getRevision(b)).toEqual({ revision: 0, dbId: id });
    expect(b.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: schemaText().split('\n').filter((l) => /^[a-z_]+: /.test(l)).length + 1 }); // + sqlite_sequence
  });

  it('opens read-only without migrating, and a write on it is refused with a typed error', async () => {
    const ws = tempWorkspace();
    expect(() => openTest(ws, 'cli', { readOnly: true })).toThrow(expect.objectContaining({ code: 'missing' }));
    openTest(ws).close();
    const ro = openTest(ws, 'cli', { readOnly: true });
    await expect(applyBatch(ro, { ifRevision: 0, ops: [{ op: 'add', kind: 'prose', text: 'x', in: 'h' }] }, { by: 'ai' })).rejects.toMatchObject({ code: 'read_only' });
    expect(() => ro.sqlite.exec("INSERT INTO ids_used(id) VALUES ('x')")).toThrow();
  });

  it('fails closed on a corrupt file: a typed error, the bytes untouched, no empty database made', () => {
    const ws = tempWorkspace();
    mkdirSync(path.join(ws, '.contextspace'));
    const file = dbFilePath(ws);
    const junk = Buffer.from('this is not a sqlite database, it is only words '.repeat(40));
    writeFileSync(file, junk);
    let error: unknown;
    try { openTest(ws); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(WorkspaceDbError);
    expect((error as WorkspaceDbError).code).toBe('corrupt');
    expect((error as WorkspaceDbError).message).toMatch(/not changed and nothing was started from an empty copy/);
    expect(readFileSync(file).equals(junk)).toBe(true);
    expect(() => openTest(ws, 'cli', { readOnly: true })).toThrow(expect.objectContaining({ code: 'corrupt' }));
  });

  it('fails closed on a database from a newer version, and leaves it byte for byte', () => {
    const ws = tempWorkspace();
    openTest(ws).close();
    const raw = new DatabaseSync(dbFilePath(ws));
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    const before = readFileSync(dbFilePath(ws));
    expect(() => openTest(ws)).toThrow(expect.objectContaining({ code: 'too_new' }));
    expect(() => openTest(ws, 'server', { readOnly: true })).toThrow(expect.objectContaining({ code: 'too_new' }));
    expect(readFileSync(dbFilePath(ws)).equals(before)).toBe(true);
  });

  it('a file that is a database but not ours fails typed, and keeps its tables', () => {
    const ws = tempWorkspace();
    mkdirSync(path.join(ws, '.contextspace'));
    const raw = new DatabaseSync(dbFilePath(ws));
    raw.exec('CREATE TABLE blocks (x)');
    raw.close();
    expect(() => openTest(ws)).toThrow(WorkspaceDbError);
    const after = track(new DatabaseSync(dbFilePath(ws)));
    expect(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 1 });
    expect(Object.values(after.prepare('PRAGMA user_version').get() as object)[0]).toBe(0);
  });

  it('each migration is atomic: a process killed in the middle leaves nothing half-made', async () => {
    const ws = tempWorkspace();
    const script = `
      import * as m from '<MODULE>';
      m.createWorkspaceDb(process.env.WS, { busy: 'cli', backups: false, migrations: [{ version: 1, run(db) {
        for (const s of m.createStatements()) db.exec(s);
        db.exec("INSERT INTO meta(key, value) VALUES ('db_id', 'half')");
        console.log('INSIDE');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
      } }] });
    `;
    const child = runChild(script, { WS: ws });
    await child.waitFor('INSIDE');
    child.proc.kill('SIGKILL');
    await child.done;
    const peek = new DatabaseSync(dbFilePath(ws));
    expect(peek.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
    expect(Object.values(peek.prepare('PRAGMA user_version').get() as object)[0]).toBe(0);
    peek.close();
    const db = openTest(ws);
    expect(getRevision(db).dbId).not.toBe('half');
    expect(pragma(db.sqlite, 'user_version')).toBe(1);
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM blocks').get()).toEqual({ n: 0 });
  });

  it('two processes opening a new database at once migrate it once', async () => {
    const ws = tempWorkspace();
    const script = `
      import * as m from '<MODULE>';
      const db = m.createWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      console.log(JSON.stringify(m.getRevision(db)));
    `;
    const kids = [runChild(script, { WS: ws }), runChild(script, { WS: ws }), runChild(script, { WS: ws })];
    await Promise.all(kids.map((k) => k.done));
    const ids = kids.map((k) => (JSON.parse(k.stdout().trim()) as { dbId: string }).dbId);
    expect(new Set(ids).size).toBe(1);
  });
});

describe('contention in separate processes', () => {
  it('two writers and a reader lose no write, and the reader only ever sees whole commits', async () => {
    const { ws, db } = await seeded();
    const parents = [idOf(db, 'Third checkpoint'), idOf(db, 'Reports export to CSV')];
    const baseItems = (exportPlanMarkdown(db).match(/<!-- [a-z][0-9a-hjkmnp-tv-z]{5} -->/g) ?? []).length;
    db.close();
    const writer = `
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      let ok = 0; let busy = 0;
      for (let i = 0; i < 20; i += 1) {
        const { revision, dbId } = m.getRevision(db);
        const r = await m.applyBatch(db, { ifRevision: revision, dbId, ops: [{ op: 'add', kind: 'step', text: process.env.TAG + ' ' + i, under: process.env.UNDER }] }, { by: process.env.TAG });
        if (r.ok) ok += 1; else { console.log(JSON.stringify(r.errors[0])); }
      }
      console.log(JSON.stringify({ ok, busy }));
    `;
    const reader = `
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false, readOnly: true });
      let last = 0; let reads = 0; let torn = 0;
      const stop = Date.now() + 2500;
      while (Date.now() < stop) {
        // one export is one snapshot: its revision and its items must agree (the import is r1; every later revision adds one step)
        const e = m.exportPlan(db);
        const items = (e.text.match(/<!-- [a-z][0-9a-hjkmnp-tv-z]{5} -->/g) ?? []).length;
        if (items !== Number(process.env.BASE) + (e.revision - 1)) torn += 1;
        if (e.revision < last) torn += 1;
        last = e.revision; reads += 1;
        await new Promise((r) => setTimeout(r, 2));
      }
      console.log(JSON.stringify({ reads, torn }));
    `;
    const a = runChild(writer, { WS: ws, TAG: 'writer-a', UNDER: parents[0]! });
    const b = runChild(writer, { WS: ws, TAG: 'writer-b', UNDER: parents[1]! });
    const r = runChild(reader, { WS: ws, BASE: String(baseItems) });
    await Promise.all([a.done, b.done, r.done]);
    const lastLine = (c: typeof a) => JSON.parse(c.stdout().trim().split('\n').pop()!) as Record<string, number>;
    expect(lastLine(a)).toMatchObject({ ok: 20 });
    expect(lastLine(b)).toMatchObject({ ok: 20 });
    expect(lastLine(r).torn).toBe(0);
    expect(lastLine(r).reads).toBeGreaterThan(10);
    const check = openTest(ws);
    expect(rev(check)).toBe(41);
    const names = listBlocks(check).map((x) => x.name);
    for (let i = 0; i < 20; i += 1) { expect(names).toContain(`writer-a ${i}`); expect(names).toContain(`writer-b ${i}`); }
    expect(check.sqlite.prepare('SELECT count(*) AS n FROM changes').get()).toEqual({ n: 41 });
    expect(Object.values(check.sqlite.prepare('PRAGMA integrity_check').get() as object)[0]).toBe('ok');
  }, 30_000);

  it('server mode answers a timer within 100 ms while another process holds the write lock, then writes when it is free', async () => {
    const { ws, db } = await seeded(SAMPLE_PLAN, 'server');
    const holder = `
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      db.sqlite.exec('BEGIN IMMEDIATE');
      console.log('HELD');
      await new Promise((r) => setTimeout(r, Number(process.env.HOLD)));
      db.sqlite.exec('ROLLBACK');
      console.log('FREE');
    `;
    const child = runChild(holder, { WS: ws, HOLD: '700' });
    await child.waitFor('HELD');
    let worst = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 10);
    const started = Date.now();
    const result = await applyBatch(db, { ifRevision: 1, ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' });
    clearInterval(timer);
    await child.done;
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(500); // it really waited for the other process
    expect(worst).toBeLessThan(100);
  });

  it('server mode gives up with a typed busy error after about 2 s, and changes nothing', async () => {
    const { ws, db } = await seeded(SAMPLE_PLAN, 'server');
    const holder = `
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      db.sqlite.exec('BEGIN IMMEDIATE');
      console.log('HELD');
      await new Promise((r) => setTimeout(r, 3200));
      db.sqlite.exec('ROLLBACK');
    `;
    const child = runChild(holder, { WS: ws });
    await child.waitFor('HELD');
    let worst = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 10);
    const started = Date.now();
    const error = await applyBatch(db, { ifRevision: 1, ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' }).catch((e: unknown) => e);
    clearInterval(timer);
    const took = Date.now() - started;
    expect(error).toBeInstanceOf(WorkspaceDbError);
    expect((error as WorkspaceDbError).code).toBe('busy');
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3000);
    expect(worst).toBeLessThan(100);
    await child.done;
    expect(rev(db)).toBe(1);
    expect((await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }])).ok).toBe(true);
  }, 15_000);

  it('cli mode waits inside SQLite, and a write while another holds it for a short time succeeds', async () => {
    const { ws } = await seeded();
    const holder = `
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      db.sqlite.exec('BEGIN IMMEDIATE');
      console.log('HELD');
      await new Promise((r) => setTimeout(r, 400));
      db.sqlite.exec('ROLLBACK');
    `;
    const child = runChild(holder, { WS: ws });
    await child.waitFor('HELD');
    const db = openTest(ws, 'cli');
    const r = await applyBatch(db, { ifRevision: 1, ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' });
    expect(r.ok).toBe(true);
    await child.done;
  });
});

describe('stdout stays clean', () => {
  it('a child that imports the module, writes and prints JSON has stdout the parent can parse', async () => {
    const ws = tempWorkspace();
    const script = `
      import * as m from '<MODULE>';
      const db = m.createWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      await m.importPlanText(db, '# T\\n\\n## Checkpoints\\n\\n- [ ] **One**\\n  - [ ] a step\\n', { by: 'child' });
      const view = m.planView(db);
      const rows = await m.runQuery(process.env.WS, 'select count(*) as n from blocks');
      process.stdout.write(JSON.stringify({ revision: m.getRevision(db).revision, viewLines: view.split('\\n').length, n: rows.rows[0].n }));
    `;
    const child = runChild(script, { WS: ws });
    const { code } = await child.done;
    expect(code).toBe(0);
    expect(JSON.parse(child.stdout())).toMatchObject({ revision: 1, n: 6 });
    // anything Node says about the experimental feature goes to stderr, never stdout
    expect(child.stdout()).not.toMatch(/ExperimentalWarning|experimental/i);
  });
});

describe('a replaced file', () => {
  // POSIX: the restore replaces the file under a live connection, which then gets `replaced`. Windows cannot replace an open file: see the next test.
  it.skipIf(process.platform === 'win32')('a connection opened before a restore is refused with a typed error and loses nothing', async () => {
    const { ws, db } = await seeded();
    await maybeBackup(ws);
    await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }]);
    expect(db.isCurrent()).toBe(true);
    const name = (await import('./index.js')).listBackups(ws)[0]!;
    const result = restoreBackup(ws, name);
    expect(db.isCurrent()).toBe(false);
    await expect(applyBatch(db, { ifRevision: 2, ops: [{ op: 'tick', id: idOf(db, 'Nested step one') }] }, { by: 'ai' })).rejects.toMatchObject({ code: 'replaced' });
    const fresh = openTest(ws);
    expect(getRevision(fresh).dbId).toBe(result.dbId);
    expect(existsSync(result.keptAs!)).toBe(true);
    expect(planView(fresh)).toContain('revision 2');
  });

  // The Windows rule: a restore never replaces a file another connection has open. It says so, changes nothing, and the open connection keeps working.
  it.skipIf(process.platform !== 'win32')('on Windows a restore under an open connection fails with file_in_use and changes nothing', async () => {
    const { ws, db } = await seeded();
    await maybeBackup(ws);
    await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }]);
    const dbIdBefore = getRevision(db).dbId;
    const name = (await import('./index.js')).listBackups(ws)[0]!;
    expect(() => restoreBackup(ws, name)).toThrow(expect.objectContaining({ code: 'file_in_use' }));
    expect(db.isCurrent()).toBe(true);
    expect(getRevision(db)).toEqual({ revision: 2, dbId: dbIdBefore });
    expect((await apply(db, [{ op: 'tick', id: idOf(db, 'Nested step one') }])).ok).toBe(true);
    expect(readdirSync(path.join(ws, '.contextspace')).filter((n) => n.startsWith('.restore'))).toEqual([]);
  });
});
