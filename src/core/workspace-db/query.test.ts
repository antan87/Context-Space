import { afterEach, describe, expect, it } from 'vitest';

import { checkQueryText, listBlocks, QUERY_MAX_ROWS, runQuery, WorkspaceDbError } from './index.js';
import { cleanTemp, rev, seeded, tempWorkspace } from './testing.js';

afterEach(cleanTemp);

describe.each(['auto', 'off'] as const)('the query guard (v5 point 8), authorizer %s', (authorizer) => {
  const run = (ws: string, sql: string, extra: { timeoutMs?: number; maxRows?: number } = {}) => runQuery(ws, sql, { authorizer, ...extra });
  const refusal = async (ws: string, sql: string, pattern: RegExp) => {
    const error = await run(ws, sql).then(() => null, (e: unknown) => e);
    expect(error, sql).toBeInstanceOf(WorkspaceDbError);
    expect((error as WorkspaceDbError).code, sql).toBe('query_refused');
    expect((error as WorkspaceDbError).message, sql).toMatch(pattern);
  };

  it('answers a SELECT, and a WITH ... SELECT, with columns, rows and a time', async () => {
    const { ws } = await seeded();
    const r = await run(ws, "select id, name, kind from blocks where kind = 'checkpoint' order by ord");
    expect(r.columns).toEqual(['id', 'name', 'kind']);
    expect(r.rows.map((x) => x.name)).toEqual(['Reports export to CSV', 'Second checkpoint', 'Third checkpoint']);
    expect(r.truncated).toBe(false);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    const w = await run(ws, 'with open as (select id from blocks where done = 0) select count(*) as n from open;');
    expect((w.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it('refuses anything that is not one SELECT or WITH', async () => {
    const { ws, db } = await seeded();
    const before = rev(db);
    await refusal(ws, "update blocks set done = 1", /Only a single SELECT/);
    await refusal(ws, "delete from blocks", /Only a single SELECT/);
    await refusal(ws, "insert into ids_used(id) values ('zzzzzz')", /Only a single SELECT/);
    await refusal(ws, "drop table blocks", /Only a single SELECT/);
    await refusal(ws, "create table x (y)", /Only a single SELECT/);
    await refusal(ws, "pragma writable_schema = 1", /Only a single SELECT/);
    await refusal(ws, "pragma journal_mode = wal", /Only a single SELECT/);
    await refusal(ws, "attach database '/tmp/other.db' as o", /Only a single SELECT/);
    await refusal(ws, "vacuum", /Only a single SELECT/);
    await refusal(ws, "explain select 1", /Only a single SELECT/);
    await refusal(ws, '   ', /Give a SELECT/);
    expect(rev(db)).toBe(before);
    expect(listBlocks(db).length).toBeGreaterThan(10);
  });

  it('refuses trailing statements, however they are hidden, but not a semicolon inside a string or a comment', async () => {
    const { ws } = await seeded();
    await refusal(ws, 'select 1; select 2', /One statement only/);
    await refusal(ws, 'select 1; delete from blocks', /One statement only/);
    await refusal(ws, "select 1;\n-- harmless comment\nattach database 'x' as o", /One statement only/);
    await refusal(ws, "select 1 /* c */ ; /* d */ pragma user_version = 5", /One statement only/);
    await refusal(ws, "select 'unterminated", /unterminated/);
    expect((await run(ws, "select ';' as semi")).rows[0]).toEqual({ semi: ';' });
    expect((await run(ws, 'select 1 as one -- ; drop table blocks')).rows[0]).toEqual({ one: 1 });
    expect((await run(ws, 'select 1 as one;; ')).rows[0]).toEqual({ one: 1 });
  });

  it('a WITH that hides a write is stopped by the read-only connection, and nothing changes', async () => {
    const { ws, db } = await seeded();
    const before = db.sqlite.prepare('SELECT count(*) AS n FROM blocks').get();
    for (const sql of [
      "with x as (select 1) delete from blocks",
      "with x as (select 1) update blocks set done = 1",
      "with x as (select 1) insert into ids_used(id) values ('zzzzzz')",
      "with x as (select 1) replace into ids_used(id) values ('zzzzzz')",
    ]) {
      const error = await run(ws, sql).then(() => null, (e: unknown) => e);
      expect(error, sql).toBeInstanceOf(WorkspaceDbError);
      expect((error as WorkspaceDbError).message, sql).toMatch(/read-only|syntax error/i);
    }
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM blocks').get()).toEqual(before);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM ids_used WHERE id = 'zzzzzz'").get()).toEqual({ n: 0 });
  });

  it('stops at 200 rows and says so; a smaller cap is honoured; the cap cannot be raised', async () => {
    const { ws } = await seeded();
    const sql = 'with recursive n(i) as (select 1 union all select i + 1 from n where i < 1000) select i from n';
    const r = await run(ws, sql);
    expect(r.rows).toHaveLength(QUERY_MAX_ROWS);
    expect(r.truncated).toBe(true);
    const small = await run(ws, sql, { maxRows: 5 });
    expect(small.rows).toHaveLength(5);
    const big = await run(ws, sql, { maxRows: 5000 });
    expect(big.rows).toHaveLength(QUERY_MAX_ROWS);
    expect((await run(ws, 'select 1 as a')).truncated).toBe(false);
  });

  it('kills a runaway query at the time cap, and the next query works', async () => {
    const { ws } = await seeded();
    const started = Date.now();
    const error = await run(ws, 'with recursive r(n) as (select 1 union all select n + 1 from r) select count(*) from r', { timeoutMs: 400 }).then(() => null, (e: unknown) => e);
    const took = Date.now() - started;
    expect(error).toBeInstanceOf(WorkspaceDbError);
    expect((error as WorkspaceDbError).code).toBe('query_timeout');
    expect((error as WorkspaceDbError).message).toMatch(/stopped after 0\.4 s/);
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(2500);
    expect((await run(ws, 'select 1 as ok')).rows[0]).toEqual({ ok: 1 });
  });

  it('says what a wrong table or column is and where the schema is, and fails typed on a missing database', async () => {
    const { ws } = await seeded();
    await refusal(ws, 'select * from no_such_table', /no such table: no_such_table\. See `ctxspace plan schema`/);
    await refusal(ws, 'select nope from blocks', /no such column: nope/);
    await expect(run(tempWorkspace(), 'select 1')).rejects.toMatchObject({ code: 'missing' });
  });
});

describe('checkQueryText', () => {
  it('accepts a SELECT and a WITH and returns null', () => {
    expect(checkQueryText('SELECT 1')).toBeNull();
    expect(checkQueryText('  with a as (select 1) select * from a ;')).toBeNull();
    expect(checkQueryText('/* note */ select "a;b" from t')).toBeNull();
  });
  it('names the problem otherwise', () => {
    expect(checkQueryText('select 1; select 2')).toMatch(/One statement only/);
    expect(checkQueryText('update t set a = 1')).toMatch(/Only a single SELECT/);
    expect(checkQueryText('select /* open')).toMatch(/unterminated/);
  });
});
