import { afterEach, describe, expect, it } from 'vitest';

import { exportPlanMarkdown, getBlock, listBlocks, listCards, pruneHistory, type BatchResult, type Op } from './index.js';
import { apply, cleanTemp, idOf, rev, seeded, applyBatch } from './testing.js';

afterEach(cleanTemp);

type Db = Awaited<ReturnType<typeof seeded>>['db'];

const refused = (r: BatchResult) => {
  if (r.ok) throw new Error(`expected a refusal, got ok at revision ${r.revision}`);
  return r;
};
/** A batch written against `base`, applied now. */
const stale = (db: Db, base: number, ops: Op[]) => applyBatch(db, { ifRevision: base, ops }, { by: 'ai' });
const stalenessOf = (r: BatchResult) => {
  const e = refused(r).errors[0]!;
  expect(e.code).toBe('stale_revision');
  return e;
};

describe('footprint and rebase (v5 point 1)', () => {
  it('each target row: a change to the row a batch edits refuses it, naming the change and the row now', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    await apply(db, [{ op: 'tick', id }], 'user');
    const e = stalenessOf(await stale(db, 1, [{ op: 'edit', id, find: 'Write', replace: 'Save' }]));
    expect(e.message).toMatch(/ifRevision 1 is stale \(the workspace is at revision 2\), and 1 change since touches what your batch touches/);
    expect(e.message).toMatch(/r2 by user: tick .* "Write the file"/);
    expect(e.message).toMatch(new RegExp(`${id} is now rev 2, done: Write the file`));
    expect(e.message).toMatch(/resend with "ifRevision": 2/);
    expect(e.message).toMatch(/Nothing was applied/);
  });

  it('its parent: an add under a parent that another change added a child to is refused', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Third checkpoint');
    await apply(db, [{ op: 'add', kind: 'step', text: 'Someone else added this', under: cp }], 'user');
    const e = stalenessOf(await stale(db, 1, [{ op: 'add', kind: 'step', text: 'Mine', under: cp }]));
    expect(e.message).toContain(cp);
  });

  it('its parent before and after: a move away from a parent that gained a child, and into one that did, are both refused', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Query the report rows');
    const oldParent = idOf(db, 'Reports export to CSV');
    const newParent = idOf(db, 'Third checkpoint');
    await apply(db, [{ op: 'add', kind: 'step', text: 'New under old parent', under: oldParent }]);
    stalenessOf(await stale(db, 1, [{ op: 'move', id: step, under: newParent }]));
    const base = rev(db);
    await apply(db, [{ op: 'add', kind: 'step', text: 'New under new parent', under: newParent }]);
    stalenessOf(await stale(db, base, [{ op: 'move', id: step, under: newParent }]));
  });

  it('each anchor: placing after a block that has since changed is refused', async () => {
    const { db } = await seeded();
    const anchor = idOf(db, 'Query the report rows');
    await apply(db, [{ op: 'edit', id: anchor, find: 'Query', replace: 'Run' }]);
    stalenessOf(await stale(db, 1, [{ op: 'add', kind: 'step', text: 'After it', after: anchor }]));
  });

  it('round 3, reproduction 1: a stale move that follows its anchor into another checkpoint is refused', async () => {
    const { db } = await seeded();
    const a = idOf(db, 'Query the report rows'); // the anchor, in checkpoint 1
    const moving = idOf(db, 'Third checkpoint');
    const other = idOf(db, 'Second checkpoint');
    void moving;
    await apply(db, [{ op: 'move', id: a, under: other }]); // someone moved the anchor to another checkpoint
    const step = idOf(db, 'Write the file');
    const e = stalenessOf(await stale(db, 1, [{ op: 'move', id: step, after: a }])); // "put it after A", written when A was in checkpoint 1
    expect(e.message).toContain(a);
    // the file was not changed by the refused batch
    expect(getBlock(db, step)!.parentId).toBe(idOf(db, 'Reports export to CSV'));
  });

  it('every descendant of a removed item: round 3, reproduction 2, a stale cascade must not delete a child someone edited', async () => {
    const { db } = await seeded();
    const parent = idOf(db, 'Write the file');
    const child = idOf(db, 'Nested step one');
    const parentRev = getBlock(db, parent)!.rev;
    await apply(db, [{ op: 'edit', id: child, find: 'one', replace: 'one (the user added words here)' }], 'user');
    const e = stalenessOf(await stale(db, 1, [{ op: 'remove', id: parent, rev: parentRev, cascade: true }]));
    expect(e.message).toContain(child);
    expect(e.message).toContain('one (the user added words here)');
    expect(getBlock(db, child)).not.toBeNull();
    expect(getBlock(db, parent)).not.toBeNull();
  });

  it('every descendant of a moved item: a change to a nested step refuses a stale move of its ancestor', async () => {
    const { db } = await seeded();
    const parent = idOf(db, 'Write the file');
    await apply(db, [{ op: 'tick', id: idOf(db, 'Nested step one') }]);
    stalenessOf(await stale(db, 1, [{ op: 'move', id: parent, under: idOf(db, 'Third checkpoint') }]));
  });

  it('every dependent row: a change to a card that names the step refuses a stale remove of it', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Plain step with `code` and a <!-- comment -->');
    const added = await apply(db, [{ op: 'card.add', title: 'About the step', step }]);
    const base = rev(db);
    await apply(db, [{ op: 'card.update', id: added.newIds[0]!, title: 'Edited since' }]);
    const e = stalenessOf(await stale(db, base, [{ op: 'remove', id: step, rev: getBlock(db, step)!.rev }]));
    expect(e.message).toContain(added.newIds[0]!);
  });

  it('every dependent row: a link or position on a checkpoint node refuses a stale remove of the checkpoint', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Third checkpoint');
    const base = rev(db);
    await apply(db, [{ op: 'place', node: `checkpoint:${cp}`, x: 1, y: 1 }]);
    stalenessOf(await stale(db, base, [{ op: 'remove', id: cp, rev: getBlock(db, cp)!.rev }]));
  });

  it('the root order: a stale add or move at the top level is refused after another top-level change, and untouched when none', async () => {
    const { db } = await seeded();
    await apply(db, [{ op: 'add', kind: 'checkpoint', text: 'Added at the top level by someone' }]);
    const e = stalenessOf(await stale(db, 1, [{ op: 'add', kind: 'checkpoint', text: 'Mine, also at the top level' }]));
    expect(e.message).toMatch(/the order of the top level changed/);
    // a change inside a checkpoint does not touch the root order
    const { db: db2 } = await seeded();
    await apply(db2, [{ op: 'tick', id: idOf(db2, 'Write the file') }]);
    const ok = await stale(db2, 1, [{ op: 'add', kind: 'checkpoint', text: 'Top level, untouched root' }]);
    expect(ok.ok).toBe(true);
  });

  it('a rebase over a change that touched nothing in the footprint is applied and says so', async () => {
    const { db } = await seeded();
    await apply(db, [{ op: 'tick', id: idOf(db, 'Query the report rows') }], 'user');
    await apply(db, [{ op: 'card.add', title: 'A card' }], 'claude');
    const r = await stale(db, 1, [{ op: 'edit', id: idOf(db, 'Nested step two'), find: 'two', replace: 'two!' }]);
    if (!r.ok) throw new Error(r.errors[0]!.message);
    expect(r.revision).toBe(4);
    expect(r.rebased).toMatchObject({ from: 1, to: 3 });
    expect(r.rebased!.changes).toHaveLength(2);
    expect(r.rebased!.changes[0]).toMatch(/^r2 by user: tick/);
    expect(getBlock(db, idOf(db, 'Nested step two!'))).not.toBeNull();
  });

  it('place, link and unlink have no footprint: last write wins even over a newer one', async () => {
    const { db } = await seeded();
    const made = await apply(db, [{ op: 'card.add', title: 'A', as: 'a' }, { op: 'card.add', title: 'B', as: 'b' }]);
    const base = rev(db);
    await apply(db, [{ op: 'place', node: made.ids.a!, x: 1, y: 1 }]);
    const r = await stale(db, base, [{ op: 'place', node: made.ids.a!, x: 9, y: 9 }, { op: 'link', from: made.ids.a!, to: made.ids.b! }]);
    expect(r.ok).toBe(true);
  });

  it('a rebase is refused when the history in the range was pruned', async () => {
    const { db } = await seeded();
    await apply(db, [{ op: 'tick', id: idOf(db, 'Query the report rows') }]);
    await apply(db, [{ op: 'tick', id: idOf(db, 'Nested step one') }]);
    expect(pruneHistory(db, { keepRows: 1, keepDays: 0 })).toBeGreaterThan(0);
    const e = refused(await stale(db, 1, [{ op: 'edit', id: idOf(db, 'Nested step two'), find: 'two', replace: '2' }])).errors[0]!;
    expect(e.code).toBe('history_pruned');
    expect(e.message).toMatch(/not kept in full/);
    expect(e.message).toMatch(/send the batch with ifRevision 3/);
    // a batch written at the current revision needs no history
    expect((await apply(db, [{ op: 'edit', id: idOf(db, 'Nested step two'), find: 'two', replace: '2' }])).ok).toBe(true);
  });

  it('a rebase is refused when db_id changed, and so is an ifRevision from the future', async () => {
    const { db } = await seeded();
    await apply(db, [{ op: 'tick', id: idOf(db, 'Query the report rows') }]);
    const e = refused(await applyBatch(db, { ifRevision: 1, dbId: 'someotherdb', ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' })).errors[0]!;
    expect(e.code).toBe('db_changed');
    expect(e.message).toMatch(/is not the database you read/);
    const future = refused(await applyBatch(db, { ifRevision: 99, ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' })).errors[0]!;
    expect(future.code).toBe('bad_revision');
    const dbId = (db.sqlite.prepare("SELECT value FROM meta WHERE key = 'db_id'").get() as { value: string }).value;
    expect((await applyBatch(db, { ifRevision: 1, dbId, ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' })).ok).toBe(true);
  });

  it('a summary-only entry (legacy history) in the range refuses the rebase', async () => {
    const { db } = await seeded();
    db.sqlite.prepare("INSERT INTO changes(revision, kind, at, by, summary, rows) VALUES (2, 'legacy', ?, 'import', 'old entry', NULL)").run(new Date().toISOString());
    db.sqlite.prepare("UPDATE meta SET value = '2' WHERE key = 'revision'").run();
    const e = refused(await stale(db, 1, [{ op: 'tick', id: idOf(db, 'Write the file') }])).errors[0]!;
    expect(e.code).toBe('history_pruned');
  });

  it('aliases and prefixes are resolved before the check: a card named by its old uuid is still found in the footprint', async () => {
    const { db } = await seeded();
    const made = await apply(db, [{ op: 'card.add', title: 'Old' }]);
    const cardId = made.newIds[0]!;
    db.sqlite.prepare('UPDATE cards SET legacy_id = ? WHERE id = ?').run('aaaaaaaa-1111-4222-8333-444455556666', cardId);
    const base = rev(db);
    await apply(db, [{ op: 'card.update', id: cardId, title: 'Changed under its short id' }]);
    for (const alias of ['aaaaaaaa-1111-4222-8333-444455556666', 'aaaaaaaa-11']) {
      const e = stalenessOf(await stale(db, base, [{ op: 'card.update', id: alias, title: 'By alias' }]));
      expect(e.message).toContain(cardId);
    }
    expect(listCards(db)[0]!.title).toBe('Changed under its short id');
  });

  it('refusals leave the document exactly as it was', async () => {
    const { db } = await seeded();
    await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }]);
    const before = exportPlanMarkdown(db);
    const blocksBefore = listBlocks(db);
    stalenessOf(await stale(db, 1, [{ op: 'edit', id: idOf(db, 'Write the file'), find: 'Write', replace: 'Zzz' }]));
    expect(exportPlanMarkdown(db)).toBe(before);
    expect(listBlocks(db)).toEqual(blocksBefore);
  });
});
