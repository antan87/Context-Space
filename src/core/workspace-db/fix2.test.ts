/** Fix round 2 (review2.log): A, a read must never see uncommitted state; B, undo and dependents of a card. */
import { afterEach, describe, expect, it } from 'vitest';

import { exportPlanMarkdown, getRevision, listBlocks, listLinks, listPositions, planView, readWithRetry, WorkspaceDbError } from './index.js';
import { apply, applyBatch, cleanTemp, idOf, rev, runChild, seeded, undo } from './testing.js';

afterEach(cleanTemp);

describe('A. no read sees a commit that is still being retried', () => {
  it('exports, views and reads on a connection with a commit in retry show the committed state, even when the commit rolls back', async () => {
    const { ws, db } = await seeded(undefined, 'server');
    const reader = runChild(`
      import * as m from '<MODULE>';
      const db = m.openWorkspaceDb(process.env.WS, { busy: 'cli', backups: false });
      db.sqlite.exec('BEGIN'); db.sqlite.prepare('SELECT count(*) FROM blocks').get(); console.log('READING');
      await new Promise((r) => setTimeout(r, 3300));
      db.sqlite.exec('COMMIT');
    `, { WS: ws });
    await reader.waitFor('READING');
    const write = applyBatch(db, { ifRevision: 1, ops: [{ op: 'tick', id: idOf(db, 'Write the file') }] }, { by: 'ai' }).then((r) => r, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300)); // the commit is now being retried between timers
    // while the commit asks for the lock, SQLite refuses new readers (PENDING): a read waits between timers and then sees
    // only what was committed, which is revision 1 once the commit has given up
    const seen = {
      text: await readWithRetry(db, () => exportPlanMarkdown(db)), view: await readWithRetry(db, () => planView(db)),
      position: await readWithRetry(db, () => getRevision(db)), blocks: await readWithRetry(db, () => listBlocks(db)),
    };
    const outcome = await write;
    await reader.done;
    expect(outcome).toBeInstanceOf(WorkspaceDbError); // the commit gave up and rolled back
    expect(seen.position.revision).toBe(1);
    expect(seen.text).toContain('revision=1');
    expect(seen.text).toContain('- [ ] Write the file');
    expect(seen.view).toContain('revision 1');
    expect(seen.blocks.find((b) => b.name === 'Write the file')!.done).toBe(false);
    expect(rev(db)).toBe(1);
  }, 15_000);
});

describe('B. undo of a card add is refused while newer rows depend on the card', () => {
  it('a later link and position on the card refuse the undo, naming them; nothing changes', async () => {
    const { db } = await seeded();
    const added = await apply(db, [{ op: 'card.add', title: 'Mine', as: 'a' }, { op: 'card.add', title: 'Other', as: 'b' }]);
    const [a, b] = [added.ids.a!, added.ids.b!];
    await apply(db, [{ op: 'link', from: b, to: a }, { op: 'place', node: a, x: 3, y: 4 }]);
    const before = rev(db);
    const u = await undo(db, added.seq, { by: 'user' });
    expect(u.ok).toBe(false);
    if (!u.ok) {
      expect(u.errors[0]!.message).toMatch(/links .* points at|link .* points at/);
      expect(u.errors[0]!.message).toMatch(/position/);
    }
    expect(rev(db)).toBe(before);
    expect(listLinks(db)).toHaveLength(1);
    expect(listPositions(db)).toHaveLength(1);
  });

  it('a later answer (decision_meta) and a later run (check_runs) refuse the undo of the add of their item', async () => {
    const { db } = await seeded();
    const added = await apply(db, [{ op: 'add', kind: 'decision', text: 'Which one?', under: idOf(db, 'Third checkpoint'), suggested: ['A'] }]);
    await apply(db, [{ op: 'answer', id: added.newIds[0]!, text: 'A' }]);
    const u = await undo(db, added.seq, { by: 'user' });
    expect(u.ok).toBe(false);
  });
});
