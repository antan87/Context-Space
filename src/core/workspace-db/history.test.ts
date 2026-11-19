import { afterEach, describe, expect, it } from 'vitest';

import { exportPlanMarkdown, getBlock, getItem, listBlocks, listCards, listChanges, stripExport, type BatchResult } from './index.js';
import { apply, cleanTemp, idOf, rev, seeded, applyBatch, undo } from './testing.js';

afterEach(cleanTemp);

type Db = Awaited<ReturnType<typeof seeded>>['db'];
interface Row { table: string; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }

const rowsOf = (db: Db, seq: number): Row[] => JSON.parse((db.sqlite.prepare('SELECT rows FROM changes WHERE seq = ?').get(seq) as { rows: string }).rows) as Row[];
const plain = (db: Db) => stripExport(exportPlanMarkdown(db));
const failed = (r: Awaited<ReturnType<typeof undo>>) => {
  if (r.ok) throw new Error('expected undo to be refused');
  return r.errors[0]!;
};

describe('history rows (v5 point 2)', () => {
  it('an add records the new row and its parent, and no sibling: order is not renumbered', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    const before = listBlocks(db).map((b) => [b.id, b.ord, b.rev]);
    const r = await apply(db, [{ op: 'add', kind: 'step', text: 'Between', after: idOf(db, 'Query the report rows') }]);
    const rows = rowsOf(db, r.seq);
    expect(rows.map((x) => `${x.table}:${x.before === null ? 'new' : 'changed'}`).sort()).toEqual([`blocks:changed`, `blocks:new`]);
    const added = rows.find((x) => x.before === null)!;
    expect(added.after).toMatchObject({ kind: 'step', parent_id: cp, rev: 1, created_by: 'user' });
    expect(typeof added.after!.ord).toBe('number');
    expect(rows.find((x) => x.before !== null)!.id).toBe(cp); // the parent's order changed
    // every other row is untouched, ord included
    const after = listBlocks(db).filter((b) => before.some(([id]) => id === b.id));
    for (const [id, ord, revision] of before) {
      const now = after.find((b) => b.id === id)!;
      expect(now.ord).toBe(ord);
      expect(now.rev).toBe(id === cp ? revision + 1 : revision);
    }
  });

  it('a move records ord and parent for the whole subtree', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Write the file');
    const r = await apply(db, [{ op: 'move', id: step, under: idOf(db, 'Third checkpoint') }]);
    const rows = rowsOf(db, r.seq);
    const nestedRow = rows.find((x) => x.id === idOf(db, 'Nested step one'))!;
    expect(nestedRow.before!.ord).not.toBe(nestedRow.after!.ord);
    expect(nestedRow.after!.text).toBe(nestedRow.before!.text); // the subtree keeps its indent relative to the moved step
    const moved = rows.filter((x) => x.before && x.after && (x.before.parent_id !== x.after.parent_id || x.before.ord !== x.after.ord)).map((x) => x.id);
    expect(moved).toContain(step);
    expect(moved).toContain(idOf(db, 'Nested step one'));
    expect(moved).toContain(idOf(db, 'Nested step two'));
    const stepRow = rows.find((x) => x.id === step)!;
    expect(stepRow.before!.parent_id).toBe(idOf(db, 'Reports export to CSV'));
    expect(stepRow.after!.parent_id).toBe(idOf(db, 'Third checkpoint'));
    expect(stepRow.before!.ord).not.toBe(stepRow.after!.ord);
  });

  it('a move to another indent re-indents the item and its detail in the record', async () => {
    const { db } = await seeded();
    const nested = idOf(db, 'Nested step one');
    const r = await apply(db, [{ op: 'move', id: nested, under: idOf(db, 'Third checkpoint') }]);
    const row = rowsOf(db, r.seq).find((x) => x.id === nested)!;
    expect(row.before!.text).toBe('    - [ ] Nested step one');
    expect(row.after!.text).toBe('  - [ ] Nested step one');
  });

  it('derived rows are recorded: an answer changes blocks, decisions and decision_meta', async () => {
    const { db } = await seeded();
    const q = idOf(db, 'Should archived reports be exported?');
    const r = await apply(db, [{ op: 'answer', id: q, text: 'Yes' }], 'claude');
    const rows = rowsOf(db, r.seq);
    expect(rows.map((x) => x.table).sort()).toEqual(['blocks', 'decision_meta', 'decisions']);
    expect(rows.find((x) => x.table === 'decisions')).toMatchObject({ before: { answer: null }, after: { answer: 'Yes' } });
    expect(rows.find((x) => x.table === 'decision_meta')).toMatchObject({ before: null, after: { answered_by: 'claude' } });
  });

  it('a cascade records everything it changed: blocks, derived rows, cards, links and positions', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    const made = await apply(db, [{ op: 'card.add', title: 'In area', area: `checkpoint:${cp}`, as: 'c' }, { op: 'card.add', title: 'On step', step: idOf(db, 'Write the file') }]);
    await apply(db, [{ op: 'link', from: made.ids.c!, to: `checkpoint:${cp}` }, { op: 'place', node: `checkpoint:${cp}`, x: 3, y: 4 }]);
    const r = await apply(db, [{ op: 'remove', id: cp, rev: getBlock(db, cp)!.rev, cascade: true }]);
    const rows = rowsOf(db, r.seq);
    const tables = new Set(rows.map((x) => x.table));
    for (const t of ['blocks', 'checks', 'decisions', 'cards', 'links', 'positions']) expect(tables.has(t), t).toBe(true);
    expect(rows.filter((x) => x.table === 'blocks' && x.after === null).length).toBeGreaterThanOrEqual(6);
    expect(rows.find((x) => x.table === 'cards' && x.id === made.ids.c)).toMatchObject({ before: { area: `checkpoint:${cp}` }, after: { area: 'plan:own' } });
  });

  it('every write lands in one row of changes with who, a summary and the revision', async () => {
    const { db } = await seeded();
    await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }], 'codex');
    const [latest] = listChanges(db, { limit: 1 });
    expect(latest).toMatchObject({ revision: 2, kind: 'batch', by: 'codex' });
    expect(latest!.summary).toMatch(/^tick .* "Write the file"/);
  });
});

describe('undo', () => {
  it('undoes an add: the row goes, the parent returns to its rev content, and the file is as before', async () => {
    const { db } = await seeded();
    const before = plain(db);
    const r = await apply(db, [{ op: 'add', kind: 'step', text: 'Temporary', under: idOf(db, 'Third checkpoint') }]);
    expect(plain(db)).not.toBe(before);
    const u = await undo(db, r.seq, { by: 'user' });
    expect(u.ok).toBe(true);
    expect(plain(db)).toBe(before);
    expect(rev(db)).toBe(3);
    expect(getBlock(db, r.newIds[0]!)).toBeNull();
    expect(listChanges(db, { limit: 1 })[0]).toMatchObject({ kind: 'undo', undoes: r.seq });
  });

  it('undoes a move with its order, parent and indentation', async () => {
    const { db } = await seeded();
    const before = plain(db);
    const ords = listBlocks(db).map((b) => [b.id, b.ord, b.parentId, b.text]);
    const r = await apply(db, [{ op: 'move', id: idOf(db, 'Write the file'), under: idOf(db, 'Third checkpoint') }]);
    expect((await undo(db, r.seq, { by: 'user' })).ok).toBe(true);
    expect(plain(db)).toBe(before);
    expect(listBlocks(db).map((b) => [b.id, b.ord, b.parentId, b.text])).toEqual(ords);
  });

  it('undoes a cascade remove: blocks, derived rows, card hints, links and positions come back', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    const step = idOf(db, 'Write the file');
    const made = await apply(db, [{ op: 'card.add', title: 'In area', area: `checkpoint:${cp}`, as: 'c' }, { op: 'card.add', title: 'On step', step }]);
    await apply(db, [{ op: 'link', from: made.ids.c!, to: `checkpoint:${cp}` }, { op: 'place', node: `checkpoint:${cp}`, x: 3, y: 4 }]);
    const before = plain(db);
    const cardsBefore = listCards(db).map((c) => [c.id, c.area, c.stepId]);
    const removal = await apply(db, [{ op: 'remove', id: cp, rev: getBlock(db, cp)!.rev, cascade: true }]);
    expect(getBlock(db, cp)).toBeNull();
    const u = await undo(db, removal.seq, { by: 'user' });
    expect(u.ok).toBe(true);
    expect(plain(db)).toBe(before);
    expect(listCards(db).map((c) => [c.id, c.area, c.stepId])).toEqual(cardsBefore);
    expect(getItem(db, cp)!.check).toMatchObject({ kind: 'command', command: 'npm test' });
    expect(getItem(db, idOf(db, 'Which format first?'))!.decision).toMatchObject({ answer: 'CSV' });
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM links').get()).toEqual({ n: 1 });
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM positions').get()).toEqual({ n: 1 });
  });

  it('undoes an answer: the decision is open again with no answer or meta', async () => {
    const { db } = await seeded();
    const q = idOf(db, 'Should archived reports be exported?');
    const r = await apply(db, [{ op: 'answer', id: q, text: 'Yes' }]);
    expect((await undo(db, r.seq, { by: 'user' })).ok).toBe(true);
    expect(getItem(db, q)!.decision).toMatchObject({ answer: null, answeredBy: null });
    expect(getBlock(db, q)!.done).toBe(false);
  });

  it('a row never takes its rev back: an undone row comes back at a higher rev', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    const r = await apply(db, [{ op: 'tick', id }]);
    expect(getBlock(db, id)!.rev).toBe(2);
    await undo(db, r.seq, { by: 'user' });
    expect(getBlock(db, id)).toMatchObject({ done: false, rev: 3 });
  });

  it('is refused when a row it changed has moved on, naming the row; nothing changes', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    const first = await apply(db, [{ op: 'tick', id }]);
    await apply(db, [{ op: 'edit', id, find: 'Write', replace: 'Save' }], 'someone');
    const before = plain(db);
    const e = failed(await undo(db, first.seq, { by: 'user' }));
    expect(e.code).toBe('undo_refused');
    expect(e.message).toMatch(/cannot be undone: 1 row has changed since/);
    expect(e.message).toMatch(new RegExp(`blocks ${id} is now rev 3: Save the file`));
    expect(e.message).toMatch(/Undo the later changes first/);
    expect(plain(db)).toBe(before);
  });

  it('is refused when the item it added was moved or the parent it bumped changed again', async () => {
    const { db } = await seeded();
    const added = await apply(db, [{ op: 'add', kind: 'step', text: 'New', under: idOf(db, 'Third checkpoint') }]);
    await apply(db, [{ op: 'add', kind: 'step', text: 'Newer', under: idOf(db, 'Third checkpoint') }]); // bumps the parent again
    expect(failed(await undo(db, added.seq, { by: 'user' })).message).toMatch(/1 row has changed since/);
  });

  it('is refused twice, for a missing change, and for summary-only history', async () => {
    const { db } = await seeded();
    const r = await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }]);
    await undo(db, r.seq, { by: 'user' });
    expect(failed(await undo(db, r.seq, { by: 'user' })).message).toMatch(/already undone by change/);
    expect(failed(await undo(db, 9999, { by: 'user' })).message).toMatch(/There is no change 9999/);
    const imported = (db.sqlite.prepare("SELECT seq FROM changes WHERE kind = 'import'").get() as { seq: number }).seq;
    expect(failed(await undo(db, imported, { by: 'user' })).message).toMatch(/summary from the old history/);
  });

  it('an undo can be undone', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    const r = await apply(db, [{ op: 'tick', id }]);
    const u = await undo(db, r.seq, { by: 'user' });
    if (!u.ok) throw new Error('undo failed');
    expect((await undo(db, u.seq, { by: 'user' })).ok).toBe(true);
    expect(getBlock(db, id)!.done).toBe(true);
  });

  it('an undone change is skipped by a later rebase check no differently: its rows are in the history', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    const r = await apply(db, [{ op: 'tick', id }]);
    await undo(db, r.seq, { by: 'user' });
    const out: BatchResult = await applyBatch(db, { ifRevision: 1, ops: [{ op: 'edit', id, find: 'Write', replace: 'Save' }] }, { by: 'ai' });
    expect(out.ok).toBe(false); // r2 (tick) and r3 (undo) both touched it
  });
});

describe('order stays right when gaps run out', () => {
  it('many adds at the same spot keep document order, and a respread touches only the neighbourhood', async () => {
    const { db } = await seeded();
    const anchor = idOf(db, 'Query the report rows');
    const texts: string[] = [];
    const touched: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      texts.unshift(`Inserted ${i}`);
      const r = await apply(db, [{ op: 'add', kind: 'step', text: `Inserted ${i}`, after: anchor }]);
      touched.push(rowsOf(db, r.seq).length);
    }
    const names = listBlocks(db).filter((b) => b.kind === 'step').map((b) => b.name);
    const at = names.indexOf('Query the report rows');
    expect(names.slice(at + 1, at + 71)).toEqual(texts);
    const ords = listBlocks(db).map((b) => b.ord);
    expect(new Set(ords).size).toBe(ords.length);
    expect([...ords].sort((a, b) => a - b)).toEqual(ords);
    expect(Math.max(...touched)).toBeGreaterThan(2); // the gap did run out at some point
    expect(Math.max(...touched)).toBeLessThan(listBlocks(db).length / 2); // and only a neighbourhood was spread
    expect(stripExport(exportPlanMarkdown(db)).indexOf('Inserted 69')).toBeLessThan(stripExport(exportPlanMarkdown(db)).indexOf('Inserted 0'));
  });

  it('appending many steps under one checkpoint, the common case, never touches rows elsewhere', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Third checkpoint');
    const untouched = listBlocks(db).filter((b) => b.id !== cp).map((b) => [b.id, b.ord]);
    for (let i = 0; i < 40; i += 1) await apply(db, [{ op: 'add', kind: 'step', text: `Appended ${i}`, under: cp }]);
    const now = new Map(listBlocks(db).map((b) => [b.id, b.ord]));
    for (const [id, ord] of untouched) expect(now.get(id)).toBe(ord);
  });
});
