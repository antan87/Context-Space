import { afterEach, describe, expect, it } from 'vitest';

import { exportPortableSnapshot, listBlocks } from './index.js';
import { SAMPLE_PLAN, apply, cleanTemp, seeded } from './testing.js';

afterEach(cleanTemp);

const addCard = (db: Parameters<typeof apply>[0], extra: Record<string, unknown> = {}) =>
  apply(db, [{ op: 'card.add', as: 'a', kind: 'note', title: 'A note', body: 'Words', ...extra } as never]);

describe('the portable snapshot', () => {
  it('pins its shape: a header, then plan, blocks, decisions, checks, cards and links, and nothing local', async () => {
    const { db } = await seeded(SAMPLE_PLAN);
    const made = await addCard(db);
    const cardId = made.ids.a!;
    const text = exportPortableSnapshot(db);
    const snap = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(snap)).toEqual(['format', 'version', 'db_id', 'revision', 'digest', 'plan', 'blocks', 'decisions', 'checks', 'cards', 'links']);
    expect(snap).toMatchObject({ format: 'contextspace-data', version: 1 });
    expect(snap.digest).toMatch(/^[0-9a-f]{16}$/);
    // history, seen, drafts, runs, positions and row revisions stay out
    for (const left of ['changes', 'history', 'seen', 'drafts', 'check_runs', 'runs', 'positions', 'requests', 'exports']) expect(snap).not.toHaveProperty(left);
    expect(text).not.toMatch(/"rev"/);
    const blocks = snap.blocks as Array<Record<string, unknown>>;
    expect(blocks.length).toBe(listBlocks(db).length);
    expect(Object.keys(blocks[0]!)).toEqual(['id', 'kind', 'parent_id', 'text', 'name', 'detail', 'done']);
    expect(blocks.map((b) => b.id)).toEqual(listBlocks(db).map((b) => b.id)); // document order
    const cards = snap.cards as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(1);
    expect(Object.keys(cards[0]!)).toEqual(['id', 'legacy_id', 'kind', 'title', 'body', 'path', 'description', 'area', 'step_id', 'about', 'look', 'look_at', 'pinned', 'archived', 'by', 'at', 'updated_by', 'updated_at']);
    expect(cards[0]).toMatchObject({ id: cardId, title: 'A note', pinned: false, archived: false });
    const decisions = snap.decisions as Array<Record<string, unknown>>;
    expect(decisions.length).toBeGreaterThan(0);
    expect(Object.keys(decisions[0]!)).toEqual(['item_id', 'suggested', 'if_no_answer', 'answer', 'answered_by', 'answered_at']);
    expect(Array.isArray(decisions[0]!.suggested)).toBe(true);
    expect(Object.keys((snap.checks as Array<Record<string, unknown>>)[0]!)).toEqual(['item_id', 'kind', 'command', 'outcome']);
    expect(snap.plan).toEqual({ eol: 'lf', trailing_newline: false });
  });

  it('is deterministic, sorted and pretty-printed: twice gives the same bytes', async () => {
    const { db } = await seeded();
    await addCard(db);
    await addCard(db, { as: 'b', title: 'Another' });
    await addCard(db, { as: 'c', title: 'A third' });
    const one = exportPortableSnapshot(db);
    const two = exportPortableSnapshot(db);
    expect(two).toBe(one);
    expect(one.endsWith('}\n')).toBe(true);
    expect(one).toContain('\n  "blocks": [\n    {\n      "id": ');
    const snap = JSON.parse(one) as { cards: Array<{ id: string }> };
    expect(snap.cards.map((c) => c.id)).toEqual([...snap.cards.map((c) => c.id)].sort());
  });

  it('leaves positions out (a drag must not change a committed file) unless asked, and a drag changes nothing else', async () => {
    const { db } = await seeded();
    const made = await addCard(db);
    const before = exportPortableSnapshot(db);
    await apply(db, [{ op: 'place', node: made.ids.a!, x: 10, y: 20 } as never]);
    const after = exportPortableSnapshot(db);
    // only the revision (and so the digest) in the header moved; the data did not
    const strip = (t: string) => JSON.stringify({ ...JSON.parse(t), revision: 0, digest: '' });
    expect(strip(after)).toBe(strip(before));
    expect(after).not.toContain('"positions"');
    const withPositions = JSON.parse(exportPortableSnapshot(db, { positions: true })) as { positions: Array<{ node_id: string; x: number; y: number }> };
    expect(withPositions.positions).toEqual([{ node_id: made.ids.a!, x: 10, y: 20 }]);
  });

  it('carries who answered a decision, and the check of a checkpoint', async () => {
    const { db } = await seeded();
    const snap = JSON.parse(exportPortableSnapshot(db)) as { decisions: Array<{ item_id: string; answer: string | null; answered_by: string | null }>; checks: Array<{ kind: string }> };
    const answered = snap.decisions.find((d) => d.answer);
    expect(answered).toBeDefined();
    expect(snap.checks.some((c) => c.kind !== 'none')).toBe(true);
  });
});
