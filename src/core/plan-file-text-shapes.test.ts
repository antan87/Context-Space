import { afterEach, describe, expect, it } from 'vitest';
import { getBlock } from './workspace-db/index.js';
import { applyBatch as realApplyBatch, type BatchInput } from './workspace-db/batch.js';
import { applyBatch, apply, cleanTemp, dbIdOf, idOf, rev, seeded } from './workspace-db/testing.js';
import { renderPlanFileInstructions } from './plan-file-text.js';

afterEach(cleanTemp);

/** Every op shape AGENTS.md shows (in backticks, starting with {"op":), as the AI would copy it. */
const shapes = () => [...renderPlanFileInstructions(true).matchAll(/`(\{"op":[^`]+\})`/g)].map((m) => m[1]!);
const opName = (shape: string) => /^\{"op":"([^"]+)"(?:,"kind":"([^"]+)")?/.exec(shape)!.slice(1).filter(Boolean).join(':');
const json = (text: string) => JSON.stringify(text).slice(1, -1);

/** Fills only the placeholders (`<...>`) of a shape with real values. A field the shape leaves out stays out, so the batch is refused. */
type Db = Awaited<ReturnType<typeof seeded>>['db'];
type Ids = Record<string, string>;
/** The ids are read once: an `edit` shape renames the item, and the later shapes still name it by its id. */
const NAMES = ['Write the file', 'Nested step one', 'Second checkpoint', 'Should archived reports be exported?', 'A step in a later section'];
const idsOf = (db: Db): Ids => Object.fromEntries(NAMES.map((n) => [n, idOf(db, n)]));
function fill(db: Db, shape: string, ids: Ids): string {
  const id = (name: string) => ids[name]!;
  const write = id('Write the file');
  const sub = (pairs: Array<[string | RegExp, string]>) => pairs.reduce((text, [from, to]) => text.split(from as string).join(to), shape);
  switch (opName(shape)) {
    case 'tick': return sub([['<id>', id('Nested step one')]]);
    case 'detail': {
      const old = getBlock(db, write)!.detail; // the lines as `ctxspace plan <id>` prints them
      return shape.replace(/<ALL[^>]*>/, json(`${old}\nWorks now: the file is written.`)).split('<id>').join(write).split('<rev>').join(String(getBlock(db, write)!.rev));
    }
    case 'edit': return sub([['<id>', write], ['<old words>', 'Write'], ['<new words>', 'Create']]);
    case 'add:step': return sub([['<words>', 'A new child step'], ['<id>', write]]);
    case 'add:decision': return sub([['<question>', 'Which one?'], ['<id>', id('Second checkpoint')], ['<a>', 'Yes'], ['<b>', 'No']]);
    case 'answer': { const d = id('Should archived reports be exported?'); return sub([['<decision id>', d], ['<their words>', 'Yes, in Settings'], ['<rev>', String(getBlock(db, d)!.rev)]]); }
    case 'now': return sub([['<step id>', id('A step in a later section')]]);
    case 'card.add': return sub([['<path>', 'board-pictures/x.png'], ['<id>', write]]);
    default: throw new Error(`no filler for ${shape}`);
  }
}

describe('every op shape in AGENTS.md (database text) is accepted by the real batch path', () => {
  it('shows the ops the packet names, each shape once', () => {
    expect(shapes().map(opName).sort()).toEqual(['add:decision', 'add:step', 'answer', 'card.add', 'detail', 'edit', 'now', 'tick']);
  });

  for (const mode of ['ifRevision and dbId', 'dbId only'] as const) {
    it(`applies every shape as shown, with ${mode}`, async () => {
      const { db } = await seeded();
      const ids = idsOf(db);
      for (const shape of shapes()) {
        const filled = fill(db, shape, ids);
        expect(filled, `a placeholder is left in ${shape}`).not.toMatch(/<[^>]+>/);
        const op = JSON.parse(filled) as never;
        // `dbId only` is how the CLI and MCP take it: the AI sends no ifRevision, the write fills in the current one (implicitRevision), and a row that needs a rev carries it.
        const r = mode === 'dbId only'
          ? await realApplyBatch(db, { ops: [op], ifRevision: rev(db), dbId: dbIdOf(db) } as unknown as BatchInput, { by: 'ai', implicitRevision: true })
          : await applyBatch(db, { ifRevision: rev(db), ops: [op] }, { by: 'ai' });
        expect(r.ok, `${shape}: ${r.ok ? '' : r.errors.map((e) => e.message).join(' | ')}`).toBe(true);
      }
    });
  }

  it('a shape that drops a field it needs is refused (rev on detail, find on edit)', async () => {
    const { db } = await seeded();
    const ids = idsOf(db);
    for (const [shape, field] of [[shapes().find((s) => opName(s) === 'detail')!, '"rev":<rev>,'], [shapes().find((s) => opName(s) === 'edit')!, '"find":"<old words>",']] as const) {
      const cut = shape.replace(field, '');
      expect(cut).not.toBe(shape);
      const r = await applyBatch(db, { ifRevision: rev(db), ops: [JSON.parse(fill(db, cut, ids)) as never] }, { by: 'ai' });
      expect(r.ok).toBe(false);
    }
  });

  it('the detail shape keeps the old lines on an item that has them, and works on one with none', async () => {
    const { db } = await seeded();
    const ids = idsOf(db);
    const write = ids['Write the file']!;
    expect(getBlock(db, write)!.detail).toContain('A detail line under the step.');
    const r = await applyBatch(db, { ifRevision: rev(db), ops: [JSON.parse(fill(db, shapes().find((s) => opName(s) === 'detail')!, ids)) as never] }, { by: 'ai' });
    expect(r.ok).toBe(true);
    expect(getBlock(db, write)!.detail).toContain('A detail line under the step.');
    expect(getBlock(db, write)!.detail).toContain('Works now: the file is written.');
    const later = idOf(db, 'A step in a later section');
    expect(getBlock(db, later)!.detail).toBe('');
    await apply(db, [{ op: 'detail', id: later, rev: getBlock(db, later)!.rev, text: 'Works now: it shows.' }]);
    expect(getBlock(db, later)!.detail.trim()).toBe('Works now: it shows.');
  });
});
