import { afterEach, describe, expect, it } from 'vitest';

import { exportPlanMarkdown, getBlock, getCard, getItem, listBlocks, listCards, listLinks, listPositions, stripExport, type BatchResult } from './index.js';
import { SAMPLE_PLAN, apply, cleanTemp, idOf, rev, seeded, applyBatch } from './testing.js';

afterEach(cleanTemp);

const refused = (r: BatchResult) => {
  if (r.ok) throw new Error('expected a refusal');
  return r;
};

describe('applyBatch: the contract', () => {
  it('ifRevision is required, and the refusal says what to send', async () => {
    const { db } = await seeded();
    const r = refused(await applyBatch(db, { ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] } as never, { by: 'ai' }));
    expect(r.errors[0]).toMatchObject({ code: 'missing_revision' });
    expect(r.errors[0]!.message).toMatch(/"ifRevision" is required/);
  });

  it('is all or none, and every failing op is reported with its index and name', async () => {
    const { db } = await seeded();
    const before = exportPlanMarkdown(db);
    const r = refused(await applyBatch(db, { ifRevision: rev(db), ops: [
      { op: 'tick', id: idOf(db, 'Write the file') },
      { op: 'tick', id: 'snope00' },
      { op: 'edit', id: idOf(db, 'Query the report rows'), find: 'zzz', replace: 'y' },
    ] }, { by: 'ai' }));
    expect(r.errors.map((e) => [e.op, e.opName, e.code])).toEqual([[1, 'tick', 'not_found'], [2, 'edit', 'not_found']]);
    expect(r.errors[0]!.message).toMatch(/^op 1 \(tick snope00\): No plan block/);
    expect(r.note).toMatch(/All or none/);
    expect(exportPlanMarkdown(db)).toBe(before);
    expect(rev(db)).toBe(1);
  });

  it('names the likely field when an op has an unknown one', async () => {
    const { db } = await seeded();
    const r = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'add', kind: 'step', text: 'x', parent: idOf(db, 'Third checkpoint') }] }, { by: 'ai' }));
    expect(r.errors[0]!.message).toMatch(/no field "parent" \(did you mean "under"\?\)/);
  });

  it('unknown ops list the real ones', async () => {
    const { db } = await seeded();
    const r = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'frobnicate' }] }, { by: 'ai' }));
    expect(r.errors[0]!.message).toMatch(/Unknown op "frobnicate"\. Ops: add, reword/);
  });

  it('records who and bumps the revision once per batch', async () => {
    const { db } = await seeded();
    const result = await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }, { op: 'untick', id: idOf(db, 'Nested step two') }], 'codex');
    expect(result.revision).toBe(2);
    expect(getBlock(db, idOf(db, 'Write the file'))).toMatchObject({ done: true, rev: 2, updatedBy: 'codex' });
  });
});

describe('plan ops', () => {
  it('add: every kind, $ref, placement, and the id is never the words', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Third checkpoint');
    const r = await apply(db, [
      { op: 'add', kind: 'step', text: 'First new step', under: cp, as: 'a' },
      { op: 'add', kind: 'step', text: 'Nested under the new one', under: '$a', as: 'b' },
      { op: 'add', kind: 'decision', text: 'Which way?', under: '$a', suggested: ['Left', 'Right'], ifNoAnswer: 'left' },
      { op: 'add', kind: 'checkpoint', text: 'Fourth checkpoint', check: 'npm test' },
      { op: 'add', kind: 'prose', text: 'Free words.', after: '$b' },
      { op: 'add', kind: 'heading', text: 'Notes', level: 2, in: idOf(db, 'Fine tuning') },
    ]);
    expect(Object.keys(r.ids)).toEqual(['a', 'b']);
    const a = getItem(db, r.ids.a!)!;
    expect(a.item.parentId).toBe(cp);
    expect(getBlock(db, r.ids.b!)!.parentId).toBe(r.ids.a);
    expect(r.newIds).toHaveLength(6);
    for (const id of r.newIds) expect(id).toMatch(/^[a-z][0-9a-hjkmnp-tv-z]{5}$/);
    const text = stripExport(exportPlanMarkdown(db));
    expect(text).toContain('- [ ] **Fourth checkpoint**\n  Check: `npm test`');
    expect(text).toContain('    - [ ] Decide: Which way?\n      Suggested: Left · Right\n      If no answer: left');
    const decision = getItem(db, listBlocks(db).find((b) => b.name === 'Which way?')!.id)!;
    expect(decision.decision).toMatchObject({ suggested: ['Left', 'Right'], ifNoAnswer: 'left', answer: null });
    const fourth = getItem(db, idOf(db, 'Fourth checkpoint'))!;
    expect(fourth.check).toMatchObject({ kind: 'command', command: 'npm test' });
  });

  it('add needs a place, says how, and a ref to an unknown name is refused', async () => {
    const { db } = await seeded();
    const noPlace = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'add', kind: 'step', text: 'x' }] }, { by: 'ai' }));
    expect(noPlace.errors[0]!.message).toMatch(/Say where it goes: "under"/);
    const badRef = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'add', kind: 'step', text: 'x', under: '$nope' }] }, { by: 'ai' }));
    expect(badRef.errors[0]!.code).toBe('not_found');
  });

  it('reword needs rev, keeps the id and the cards, and says how to change part of a line instead', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    await apply(db, [{ op: 'card.add', title: 'Note', body: 'b', step: id }]);
    const noRev = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'reword', id, text: 'Write the CSV file' }] }, { by: 'ai' }));
    expect(noRev.errors[0]).toMatchObject({ code: 'rev_required', currentRev: 1 });
    expect(noRev.errors[0]!.message).toMatch(/needs its "rev" \(now 1/);
    expect(noRev.errors[0]!.message).toMatch(/"op":"edit"/);
    await apply(db, [{ op: 'reword', id, text: 'Write the CSV file', rev: 1 }]);
    expect(getBlock(db, id)).toMatchObject({ name: 'Write the CSV file', rev: 2 });
    expect(listCards(db)[0]!.stepId).toBe(id);
  });

  it('reword keeps checkpoint bold and the decision prefix', async () => {
    const { db } = await seeded();
    await apply(db, [
      { op: 'reword', id: idOf(db, 'Second checkpoint'), text: '2nd', rev: 1 },
      { op: 'reword', id: idOf(db, 'Which format first?'), text: 'Format first?', rev: 1 },
    ]);
    const text = stripExport(exportPlanMarkdown(db));
    expect(text).toContain('- [ ] **2nd**');
    expect(text).toContain('- [x] Decide: Format first?');
  });

  it('a rev that moved on is refused with the current text, rev and what to do', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    await apply(db, [{ op: 'edit', id, find: 'Write', replace: 'Save' }], 'someone');
    const r = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'reword', id, text: 'My words', rev: 1 }] }, { by: 'ai' }));
    expect(r.errors[0]).toMatchObject({ code: 'rev_conflict', currentRev: 2 });
    expect(r.errors[0]!.message).toMatch(/you sent rev 1, it is now rev 2, last changed at revision 2 by someone/);
    expect(r.errors[0]!.message).toMatch(/It now reads: Save the file/);
    expect(r.errors[0]!.message).toMatch(/resend with "rev": 2/);
  });

  it('edit changes one literal match, in the line or the detail, and refuses zero or many', async () => {
    const { db } = await seeded();
    const id = idOf(db, 'Write the file');
    await apply(db, [{ op: 'edit', id, find: 'file', replace: 'report' }, { op: 'edit', id, in: 'detail', find: 'A detail line', replace: 'One detail line' }]);
    const b = getBlock(db, id)!;
    expect(b.name).toBe('Write the report');
    expect(b.detail).toContain('One detail line under the step.');
    const none = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'edit', id, find: 'nothing', replace: 'x' }] }, { by: 'ai' }));
    expect(none.errors[0]!.message).toMatch(/not in the line of .*so nothing was changed\. Current line of .*: Write the report/);
    const many = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'edit', id, in: 'detail', find: 'e', replace: 'x' }] }, { by: 'ai' }));
    expect(many.errors[0]!.message).toMatch(/appears \d+ times/);
    const special = await apply(db, [{ op: 'edit', id: idOf(db, 'Query the report rows'), find: 'report rows', replace: '$1 (x) $& ok' }]);
    expect(special.ok).toBe(true);
    expect(getBlock(db, idOf(db, 'Query the $1 (x) $& ok'))!.name).toBe('Query the $1 (x) $& ok'); // literal, not a pattern
  });

  it('detail replaces the whole detail and needs rev; derived checks and decisions follow the text', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    const noRev = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'detail', id: cp, text: 'x' }] }, { by: 'ai' }));
    expect(noRev.errors[0]!.code).toBe('rev_required');
    await apply(db, [{ op: 'detail', id: cp, text: 'Outcome: now different', rev: 1 }]);
    expect(getItem(db, cp)!.check).toMatchObject({ kind: 'none', outcome: 'now different' });
  });

  it('move carries the subtree, re-indents it and keeps ids', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Write the file');
    const third = idOf(db, 'Third checkpoint');
    const nested = idOf(db, 'Nested step one');
    await apply(db, [{ op: 'move', id: step, under: third }]);
    expect(getBlock(db, step)!.parentId).toBe(third);
    expect(getBlock(db, nested)!.parentId).toBe(step);
    const text = stripExport(exportPlanMarkdown(db));
    expect(text).toContain('- [ ] **Third checkpoint**\n  - [ ] Write the file\n    A detail line under the step.');
    expect(text).toContain('\n    - [ ] Nested step one\n');
    expect(getBlock(db, step)!.rev).toBe(2);
    expect(getBlock(db, third)!.rev).toBe(2); // a new child bumps its parent
  });

  it('move relative to itself, or a checkpoint under an item, is refused', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Write the file');
    const self = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'move', id: step, under: idOf(db, 'Nested step one') }] }, { by: 'ai' }));
    expect(self.errors[0]!.message).toMatch(/relative to itself/);
    const cp = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'move', id: idOf(db, 'Third checkpoint'), under: step }] }, { by: 'ai' }));
    expect(cp.errors[0]!.message).toMatch(/cannot be nested/);
  });

  it('tick, untick and answer; a decision is answered, not ticked, and reopening takes the answer away', async () => {
    const { db } = await seeded();
    const q = idOf(db, 'Should archived reports be exported?');
    const tick = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'tick', id: q }] }, { by: 'ai' }));
    expect(tick.errors[0]!.message).toMatch(/is a decision: answer it with/);
    await apply(db, [{ op: 'answer', id: q, text: 'Only the last year' }], 'claude');
    expect(getItem(db, q)!.decision).toMatchObject({ answer: 'Only the last year', answeredBy: 'claude' });
    expect(getBlock(db, q)!.done).toBe(true);
    await apply(db, [{ op: 'answer', id: q, text: 'Yes, all of them' }], 'user');
    expect(getItem(db, q)!.decision).toMatchObject({ answer: 'Yes, all of them', answeredBy: 'user' });
    await apply(db, [{ op: 'untick', id: q }]);
    expect(getItem(db, q)!.decision).toMatchObject({ answer: null, answeredBy: null });
    expect(getBlock(db, q)!.done).toBe(false);
    expect(getBlock(db, q)!.detail).not.toMatch(/Answer:/);
  });

  it('remove needs rev, refuses nested items without cascade, and the cascade moves cards and links off what it removes', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    const step = idOf(db, 'Write the file');
    await apply(db, [
      { op: 'card.add', title: 'On the step', step, as: 'c1' },
      { op: 'card.add', title: 'In the checkpoint', area: `checkpoint:${cp}`, as: 'c2' },
    ]);
    const cards = listCards(db);
    await apply(db, [{ op: 'link', from: cards[1]!.id, to: `checkpoint:${cp}` }, { op: 'place', node: `checkpoint:${cp}`, x: 10, y: 20 }]);
    const noRev = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'remove', id: step }] }, { by: 'ai' }));
    expect(noRev.errors[0]!.code).toBe('rev_required');
    const nested = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'remove', id: step, rev: 1 }] }, { by: 'ai' }));
    expect(nested.errors[0]!.message).toMatch(/has 2 item\(s\) nested under it/);
    await apply(db, [{ op: 'remove', id: step, rev: 1, cascade: true }]);
    expect(getBlock(db, step)).toBeNull();
    expect(getBlock(db, idOf(db, 'Third checkpoint'))).not.toBeNull();
    expect(listCards(db).find((c) => c.title === 'On the step')).toMatchObject({ stepId: null }); // the card keeps its words
    await apply(db, [{ op: 'remove', id: cp, rev: getBlock(db, cp)!.rev, cascade: true }]);
    expect(listCards(db).find((c) => c.title === 'In the checkpoint')!.area).toBe('plan:own');
    expect(listLinks(db)).toHaveLength(0);
    expect(listPositions(db)).toHaveLength(0);
    expect(stripExport(exportPlanMarkdown(db))).not.toContain('Reports export to CSV');
  });

  it('block.set replaces prose or a heading verbatim and needs rev', async () => {
    const { db } = await seeded();
    const prose = listBlocks(db).find((b) => b.kind === 'prose' && b.text.includes('Ship the export'))!;
    const noRev = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'block.set', id: prose.id, text: 'x' }] }, { by: 'ai' }));
    expect(noRev.errors[0]!.code).toBe('rev_required');
    await apply(db, [{ op: 'block.set', id: prose.id, text: 'Ship the reader first.\n\n- a bullet that is not a task', rev: 1 }]);
    expect(stripExport(exportPlanMarkdown(db))).toBe(SAMPLE_PLAN.replace('Ship the export first. Then the reader.', 'Ship the reader first.\n\n- a bullet that is not a task'));
    const heading = listBlocks(db).find((b) => b.kind === 'heading' && b.name === 'Fine tuning')!;
    await apply(db, [{ op: 'block.set', id: heading.id, text: '## Polish', rev: 1 }]);
    expect(getBlock(db, heading.id)!.name).toBe('Polish');
  });
});

describe('Board ops', () => {
  it('cards: add, update, remove, with limits and short ids', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Reports export to CSV');
    const r = await apply(db, [{ op: 'card.add', title: 'A note', body: 'Words', area: `checkpoint:${cp}`, pinned: true, as: 'n' }, { op: 'card.add', kind: 'file', title: 'A file', path: 'docs/a.md', description: 'what it shows', look: 'new' }]);
    expect(r.ids.n).toMatch(/^k[0-9a-hjkmnp-tv-z]{5}$/);
    const card = getCard(db, r.ids.n!)!;
    expect(card).toMatchObject({ kind: 'note', title: 'A note', area: `checkpoint:${cp}`, pinned: true, rev: 1, by: 'user' });
    await apply(db, [{ op: 'card.update', id: card.id, title: 'Renamed', archived: true, rev: 1 }]);
    expect(getCard(db, card.id)).toMatchObject({ title: 'Renamed', archived: true, rev: 2 });
    const tooLong = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'card.add', title: 'x'.repeat(201) }] }, { by: 'ai' }));
    expect(tooLong.errors[0]!.message).toMatch(/"title" is 201 characters; keep it to 200/);
    const stale = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'card.update', id: card.id, title: 'x', rev: 1 }] }, { by: 'ai' }));
    expect(stale.errors[0]!.code).toBe('rev_conflict');
    await apply(db, [{ op: 'card.remove', id: card.id }]);
    expect(getCard(db, card.id)).toBeNull();
  });

  it('a card keeps its area and its step hint apart', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Write the file');
    const r = await apply(db, [{ op: 'card.add', title: 'Only a hint', step }]);
    expect(getCard(db, r.newIds[0]!)).toMatchObject({ stepId: step, area: null });
  });

  it('links are unique per pair and idempotent; unlink; place is last write wins; nodes are checked', async () => {
    const { db } = await seeded();
    const r = await apply(db, [{ op: 'card.add', title: 'A', as: 'a' }, { op: 'card.add', title: 'B', as: 'b' }]);
    const [a, b] = [r.ids.a!, r.ids.b!];
    await apply(db, [{ op: 'link', from: a, to: b, label: 'because' }, { op: 'link', from: a, to: b }]);
    expect(listLinks(db)).toHaveLength(1);
    await apply(db, [{ op: 'place', node: a, x: 1, y: 2 }, { op: 'place', node: a, x: 3, y: 4 }]);
    expect(listPositions(db)).toEqual([{ nodeId: a, x: 3, y: 4 }]);
    await apply(db, [{ op: 'link', from: a, to: 'commit:NexusFlow:96ca286' }]);
    const bad = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'link', from: a, to: 'nothing' }, { op: 'place', node: a, x: 1e9, y: 0 }] }, { by: 'ai' }));
    expect(bad.errors.map((e) => e.code)).toEqual(['not_found', 'invalid']);
    await apply(db, [{ op: 'unlink', from: a, to: b }]);
    expect(listLinks(db)).toHaveLength(1);
    await apply(db, [{ op: 'card.remove', id: a }]);
    expect(listLinks(db)).toHaveLength(0);
    expect(listPositions(db)).toHaveLength(0);
  });
});

describe('the file grammar wins', () => {
  it('moving a step to the top level of Checkpoints is refused, naming what it would read as', async () => {
    const { db } = await seeded();
    const before = exportPlanMarkdown(db);
    const step = idOf(db, 'Plain step with `code` and a <!-- comment -->');
    const r = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'move', id: step, after: idOf(db, 'Third checkpoint') }] }, { by: 'ai' }));
    expect(r.errors[0]).toMatchObject({ op: null, code: 'bad_structure' });
    expect(r.errors[0]!.message).toMatch(/would not read back as meant: step .* would read back as checkpoint/);
    expect(r.errors[0]!.message).toMatch(/put steps "under" a checkpoint/);
    expect(exportPlanMarkdown(db)).toBe(before);
  });

  it('a detail that would read as an item, or a heading inside prose, is refused', async () => {
    const { db } = await seeded();
    const cp = idOf(db, 'Third checkpoint');
    const asItem = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'detail', id: cp, rev: 1, text: 'Notes:\n- [ ] sneaky child' }] }, { by: 'ai' }));
    expect(asItem.errors[0]!.code).toBe('bad_structure');
    const prose = listBlocks(db).find((b) => b.kind === 'prose' && b.text.includes('Ship'))!;
    const asHeading = refused(await applyBatch(db, { ifRevision: 1, ops: [{ op: 'block.set', id: prose.id, rev: 1, text: 'words\n## A heading hiding in prose' }] }, { by: 'ai' }));
    expect(asHeading.errors[0]!.code).toBe('bad_structure');
  });

  it('a checkpoint added without a place goes after the last one, and a step cannot be added at the top of Checkpoints', async () => {
    const { db } = await seeded();
    const r = await apply(db, [{ op: 'add', kind: 'checkpoint', text: 'Last one' }]);
    const blocks = listBlocks(db).filter((b) => b.kind === 'checkpoint');
    expect(blocks[blocks.length - 1]!.id).toBe(r.newIds[0]);
    const top = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'add', kind: 'step', text: 'orphan', after: idOf(db, 'Third checkpoint') }] }, { by: 'ai' }));
    expect(top.errors[0]!.code).toBe('bad_structure');
  });
});

describe('aliases and prefixes', () => {
  it('a card is found by its old uuid or a unique prefix of it, in ops and in links', async () => {
    const { db } = await seeded();
    const r = await apply(db, [{ op: 'card.add', title: 'Old card', as: 'a' }, { op: 'card.add', title: 'Other card', as: 'b' }]);
    const uuid = '5b0e2c1a-1111-4222-8333-444455556666';
    db.sqlite.prepare('UPDATE cards SET legacy_id = ? WHERE id = ?').run(uuid, r.ids.a!);
    db.sqlite.prepare('UPDATE cards SET legacy_id = ? WHERE id = ?').run('5b0e2c99-1111-4222-8333-444455556666', r.ids.b!);
    await apply(db, [{ op: 'card.update', id: uuid, title: 'By uuid' }, { op: 'card.update', id: '5b0e2c1', title: 'By prefix' }]);
    expect(getCard(db, r.ids.a!)!.title).toBe('By prefix');
    const ambiguous = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'card.update', id: '5b0e2c', title: 'x' }] }, { by: 'ai' }));
    expect(ambiguous.errors[0]).toMatchObject({ code: 'ambiguous' });
    const tooShort = refused(await applyBatch(db, { ifRevision: rev(db), ops: [{ op: 'card.update', id: '5b0e', title: 'x' }] }, { by: 'ai' }));
    expect(tooShort.errors[0]).toMatchObject({ code: 'not_found' });
    await apply(db, [{ op: 'link', from: uuid, to: r.ids.b! }, { op: 'place', node: '5b0e2c1', x: 5, y: 6 }]);
    expect(listLinks(db)[0]).toMatchObject({ from: r.ids.a, to: r.ids.b });
    expect(listPositions(db)[0]!.nodeId).toBe(r.ids.a);
  });
});
