import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { listBlocks, type BatchResult } from './index.js';
import { apply, cleanTemp, idOf, rev, runChild, seeded, applyBatch } from './testing.js';

afterEach(cleanTemp);

describe('requests (v5 point 3)', () => {
  it('the same id and payload applies once and replays the first result', async () => {
    const { db } = await seeded();
    const batch = { ifRevision: 1, requestId: 'req-1', ops: [{ op: 'add' as const, kind: 'step', text: 'Once only', under: idOf(db, 'Third checkpoint') }] };
    const first = await applyBatch(db, batch, { by: 'ai' });
    const again = await applyBatch(db, batch, { by: 'ai' });
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again).toMatchObject({ revision: first.revision, seq: first.seq, newIds: first.newIds, replayed: true });
    expect(first.replayed).toBeUndefined();
    expect(rev(db)).toBe(2);
    expect(listBlocks(db).filter((b) => b.name === 'Once only')).toHaveLength(1);
  });

  it('the same id with another payload is refused and says so', async () => {
    const { db } = await seeded();
    const under = idOf(db, 'Third checkpoint');
    await applyBatch(db, { ifRevision: 1, requestId: 'req-2', ops: [{ op: 'add', kind: 'step', text: 'A', under }] }, { by: 'ai' });
    const r = await applyBatch(db, { ifRevision: 2, requestId: 'req-2', ops: [{ op: 'add', kind: 'step', text: 'B', under }] }, { by: 'ai' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({ code: 'request_reused' });
    expect(r.errors[0]!.message).toMatch(/already used with a different batch/);
    expect(listBlocks(db).some((b) => b.name === 'B')).toBe(false);
  });

  it('a retry after a lost response returns the stored result even though the revision has moved and the ops are now stale', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    const batch = { ifRevision: 1, requestId: 'lost-response', ops: [{ op: 'edit' as const, id, find: 'Write', replace: 'Save' }] };
    const first = await applyBatch(db, batch, { by: 'ai' }); // the response is "lost"
    await apply(db, [{ op: 'edit', id, find: 'Save', replace: 'Store' }], 'user'); // the user changed the same line since
    const retry: BatchResult = await applyBatch(db, batch, { by: 'ai' });
    expect(retry).toMatchObject({ ok: true, replayed: true, revision: first.ok ? first.revision : -1 });
    expect(listBlocks(db).find((b) => b.id === id)!.name).toBe('Store the file'); // the user's change is not undone by the retry
    // without the request id the same retry is refused as stale
    const noId = await applyBatch(db, { ifRevision: 1, ops: batch.ops }, { by: 'ai' });
    expect(noId.ok).toBe(false);
  });

  it('a refused batch does not use up its request id', async () => {
    const { db } = await seeded();
    const bad = await applyBatch(db, { ifRevision: 1, requestId: 'retry-me', ops: [{ op: 'tick', id: 'snope00' }] }, { by: 'ai' });
    expect(bad.ok).toBe(false);
    const good = await applyBatch(db, { ifRevision: 1, requestId: 'retry-me', ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' });
    expect(good.ok).toBe(true);
  });

  it('is kept 7 days: after that an id is treated as new', async () => {
    const { db } = await seeded();
    const under = idOf(db, 'Third checkpoint');
    await applyBatch(db, { ifRevision: 1, requestId: 'old-one', ops: [{ op: 'add', kind: 'step', text: 'First', under }] }, { by: 'ai' });
    db.sqlite.prepare('UPDATE requests SET at = ? WHERE request_id = ?').run(new Date(Date.now() - 8 * 86_400_000).toISOString(), 'old-one');
    await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }]); // any later write clears what has expired
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM requests').get()).toEqual({ n: 0 });
    const again = await applyBatch(db, { ifRevision: rev(db), requestId: 'old-one', ops: [{ op: 'add', kind: 'step', text: 'Second', under }] }, { by: 'ai' });
    expect(again.ok && !again.replayed).toBe(true);
  });

  it('rejects a request id that is not a short plain string', async () => {
    const { db } = await seeded();
    const r = await applyBatch(db, { ifRevision: 1, requestId: 'has spaces and ; quotes', ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' });
    expect(r.ok).toBe(false);
  });

  it('a concurrent retry from two child processes applies once; both get the same result', async () => {
    const { ws, db } = await seeded();
    const under = idOf(db, 'Third checkpoint');
    db.close();
    const go = path.join(ws, 'go');
    const script = `
      import * as m from '<MODULE>';
      import { existsSync } from 'node:fs';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      while (!existsSync(process.env.GO)) await new Promise((r) => setTimeout(r, 1));
      const r = await m.applyBatch(db, { ifRevision: 1, dbId: m.getRevision(db).dbId, requestId: 'race', ops: [{ op: 'add', kind: 'step', text: 'Raced', under: process.env.UNDER }] }, { by: 'child' });
      console.log(JSON.stringify(r));
      db.close();
    `;
    const children = [0, 1].map(() => runChild(script, { WS: ws, GO: go, UNDER: under }));
    await new Promise((r) => setTimeout(r, 500)); // both are open and polling
    writeFileSync(go, '1');
    const results = await Promise.all(children.map(async (c) => { await c.done; return JSON.parse(c.stdout().trim().split('\n').pop()!) as BatchResult; }));
    expect(existsSync(go)).toBe(true);
    for (const r of results) expect(r.ok).toBe(true);
    expect(results.filter((r) => r.ok && r.replayed).length).toBe(1);
    expect(results[0]).toMatchObject({ revision: 2 });
    expect(results[1]).toMatchObject({ revision: 2 });
    expect((results[0] as { newIds: string[] }).newIds).toEqual((results[1] as { newIds: string[] }).newIds);
    const { openTest } = await import('./testing.js');
    const check = openTest(ws);
    expect(listBlocks(check).filter((b) => b.name === 'Raced')).toHaveLength(1);
    expect(rev(check)).toBe(2);
  });
});
