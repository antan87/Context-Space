import { afterEach, describe, expect, it } from 'vitest';

import { getNow, planView } from './index.js';
import { apply, cleanTemp, idOf, rev, seeded } from './testing.js';

afterEach(cleanTemp);

describe('planView', () => {
  it('starts with the title, revision, db and counts, then where we stopped, then a one-line legend', async () => {
    const { db } = await seeded();
    const lines = planView(db).split('\n');
    expect(lines[0]).toMatch(/^Sample plan · revision 1 · db [0-9a-f]{16} · \d+ open of \d+ items$/);
    expect(lines[1]).toBe('Where we stopped: Ship the export first. Then the reader.');
    expect(lines[2]).toMatch(/^id \[ \] open · \[x\] done/);
  });

  it('shows checkpoints with open work in full, and every other checkpoint as one line', async () => {
    const { db } = await seeded();
    const first = idOf(db, 'Reports export to CSV');
    const second = idOf(db, 'Second checkpoint');
    await apply(db, [{ op: 'tick', id: idOf(db, 'Write the file') }, { op: 'tick', id: idOf(db, 'Nested step one') }]);
    await apply(db, [{ op: 'answer', id: idOf(db, 'Should archived reports be exported?'), text: 'Yes' }]);
    const view = planView(db);
    expect(view).toContain(`  ${first} [x] Reports export to CSV (`); // everything under it is done: one line
    expect(view).toContain(`  ${second} [ ] Second checkpoint (+1 done)`); // still has an open item: in full, its done decision folded
    expect(view).toContain(`    ${idOf(db, 'Plain step with `code` and a <!-- comment -->')} [ ] Plain step`);
    expect(view).not.toContain('Which format first?');
    expect(view).not.toContain('Query the report rows');
  });

  it('lists open decisions with their suggested answers', async () => {
    const { db } = await seeded();
    const view = planView(db);
    expect(view).toContain(`${idOf(db, 'Should archived reports be exported?')} [ ] ? Should archived reports be exported?`);
    expect(view).toContain('suggested: Yes, all of them · Only the last year');
  });

  it('--all shows everything, headings included; an id shows one item with its rev, detail and children', async () => {
    const { db } = await seeded();
    const all = planView(db, { all: true });
    expect(all).toMatch(/h[0-9a-z]{5} ## Checkpoints/);
    expect(all).toContain('Query the report rows');
    const one = planView(db, { id: idOf(db, 'Write the file') });
    expect(one).toMatch(/^s[0-9a-z]{5} step rev 1 open\nWrite the file\n/);
    expect(one).toContain('A detail line under the step.');
    expect(one).toContain('items under it:');
    expect(one).toMatch(/s[0-9a-z]{5} \[ \] rev 1 Nested step one/);
    expect(planView(db, { id: 'snope00' })).toMatch(/^No plan block snope00/);
    const cp = planView(db, { id: idOf(db, 'Reports export to CSV') });
    expect(cp).toContain('check: npm test · never run');
  });

  it('marks the step Now names, and counts cards on a checkpoint', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Write the file');
    db.sqlite.prepare("INSERT INTO now(id, item_id, by, at) VALUES (1, ?, 'user', 'x')").run(step);
    expect(getNow(db)).toMatchObject({ itemId: step });
    const cp = idOf(db, 'Third checkpoint');
    await apply(db, [{ op: 'card.add', title: 'c1', area: `checkpoint:${cp}` }, { op: 'card.add', title: 'c2', step }]);
    const view = planView(db);
    expect(view).toContain(`${step} [ ] Write the file · 1c · NOW`);
    expect(view).toMatch(/Third checkpoint · 1c/);
    expect(rev(db)).toBe(2);
  });

  it('a removed Now step does not leave Now pointing at nothing', async () => {
    const { db } = await seeded();
    const step = idOf(db, 'Plain step with `code` and a <!-- comment -->');
    db.sqlite.prepare("INSERT INTO now(id, item_id, by, at) VALUES (1, ?, 'user', 'x')").run(step);
    await apply(db, [{ op: 'remove', id: step, rev: 1 }]);
    expect(getNow(db)).toBeNull();
  });

  it('stays near 6 KB on a plan with many open items, folds what does not fit, and the whole thing is still one command away', async () => {
    const lines = ['# Big plan', '', '## Where we stopped', '', 'Working on the middle.', '', '## Checkpoints', ''];
    for (let c = 0; c < 16; c += 1) {
      lines.push(`- [ ] **Checkpoint number ${c} with a reasonably long title so the line has some weight**`);
      for (let i = 0; i < 14; i += 1) lines.push(`  - [ ] Step ${c}.${i} says something fairly long about what has to be done and why it matters to whoever reads it later on`);
      lines.push(`  - [x] A finished step in ${c}`);
    }
    lines.push('', '## Fine tuning', '');
    for (let i = 0; i < 30; i += 1) lines.push(`- [ ] Loose item ${i} that someone will get to at the end of everything`);
    const { db } = await seeded(`${lines.join('\n')}\n`);
    const view = planView(db);
    expect(Buffer.byteLength(view)).toBeLessThan(6500);
    expect(view).toMatch(/Checkpoint number 15 .* \(14 open, 1 done\)/); // folded to one line with its counts
    expect(view).toMatch(/\(\+\d+ more open items outside the Checkpoints list: `ctxspace plan --all`\)/);
    expect(Buffer.byteLength(planView(db, { all: true }))).toBeGreaterThan(20_000);
    expect(planView(db, { budget: 1_000_000 })).toContain('Step 15.13');
    expect(planView(db, { budget: 0 })).not.toContain('Step 0.0 ');
  });
});
