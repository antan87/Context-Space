import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { openWorkspaceDb, listBlocks, listCards, listLinks, listPositions, getNow, listChanges, listCheckRuns, exportPortableSnapshot } from './workspace-db/index.js';
import { rehearseMigration, renderRehearsal, rehearsalExitCode, matchPlanItems, relativePosix } from './plan-migrate-rehearsal.js';
import { parsePlanFile, planItems } from './plan-file.js';

const PLAN = `# CSV export

Customers export their reports.

## Checkpoints

- [x] Report rows load fast
  - [x] Query the report rows
- [ ] Reports export to CSV
  Check: \`npm test\`
  - [x] Write the CSV writer
  - [ ] Add the Export button
  - [ ] Decide: Should archived reports be exported?
    Suggested: Yes, all of them · Only the last year
    If no answer: only the last year

## Steps

- [ ] Tidy the old export script
`;

const U = (n: number) => `${String(n).padStart(8, '0')}-1111-4222-8333-444455556666`;
const AT = '2026-11-01T10:00:00.000Z';
const card = (n: number, over: Record<string, unknown>) => ({ id: U(n), kind: 'note', title: `Card ${n}`, body: `Body ${n}`, pinned: false, archived: false, by: 'user', at: AT, updatedBy: 'user', updatedAt: AT, ...over });

const BOARD = {
  version: 1, revision: 7,
  cards: [
    card(1, { area: 'checkpoint:reports-export-to-csv', step: 'add-the-export-button', look: 'Read this', lookAt: AT, pinned: true }),
    card(2, { kind: 'file', body: undefined, path: 'docs/spec.md', description: 'The spec', area: 'plan:own', by: 'claude' }),
    card(3, { area: 'checkpoint:gone-checkpoint', step: 'a-step-that-was-reworded' }),
    card(4, { about: 'commit:NexusFlow:96ca286', archived: true }),
  ],
  links: [
    { id: U(11), from: U(1), to: 'checkpoint:reports-export-to-csv', label: 'serves', by: 'user', at: AT },
    { id: U(12), from: U(2), to: U(1), by: 'claude', at: AT },
    { id: U(13), from: U(3), to: 'checkpoint:old-checkpoint', by: 'user', at: AT },
  ],
  positions: { [U(1)]: { x: 10, y: 20 }, 'checkpoint:reports-export-to-csv': { x: 100, y: 200 }, 'checkpoint:gone-checkpoint': { x: 1, y: 2 } },
};

const planChange = (over: Record<string, unknown>) => JSON.stringify({ at: '2026-11-02T09:00:00.000Z', by: 'claude', action: 'ticked', kind: 'step', key: 'write-the-csv-writer', text: 'Write the CSV writer', ...over });
const boardChange = (over: Record<string, unknown>) => JSON.stringify({ at: '2026-11-02T08:00:00.000Z', by: 'user', revision: 3, action: 'add_card', id: U(1), text: 'Card 1', ...over });

let root: string;
let scratch: string;

const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};

async function fullWorkspace() {
  await write('PLAN.md', PLAN);
  await write('contextspace-board.json', JSON.stringify(BOARD, null, 2));
  await write('.contextspace/plan-changes.jsonl', `${planChange({})}\nthis line is not json\n${planChange({ at: '2026-11-03T09:00:00.000Z', action: 'answered', kind: 'decision', key: 'should-archived-reports-be-exported', text: 'Should archived reports be exported?', note: 'Yes' })}\n`);
  await write('.contextspace/board-changes.jsonl', `${boardChange({})}\n${boardChange({ at: '2026-11-02T08:30:00.000Z', action: 'move', id: U(1), text: 'moved' })}\n`);
  await write('.contextspace/plan-now.json', JSON.stringify({ key: 'add-the-export-button', by: 'claude', at: '2026-11-04T00:00:00.000Z' }));
  await write('.contextspace/plan-seen.json', JSON.stringify({ hash: 'abc', items: { 'write-the-csv-writer': { kind: 'step', text: 'Write the CSV writer', done: true }, 'a-removed-step': { kind: 'step', text: 'Gone', done: false } } }));
  await write('.contextspace/seen.json', JSON.stringify({ version: 1, readers: { claude: { at: '2026-11-05T00:00:00.000Z', repos: { NexusFlow: 'abc1234' }, knowledge: ['k1'], documents: [] }, user: { at: '2026-11-06T00:00:00.000Z', repos: {}, knowledge: [], documents: [] } }, pending: { claude: { at: '2026-11-07T00:00:00.000Z', repos: { NexusFlow: 'def5678' }, knowledge: ['k1', 'k2'], documents: [] } } }));
  await write('.contextspace/state.json', JSON.stringify({ workspacePath: root, repos: {}, updatedAt: AT, planChecks: { 'reports-export-to-csv': { lastVerificationSha: 'abc1234', lastVerificationStatus: 'pass', canProgress: true, at: '2026-11-04T10:00:00.000Z' }, 'no-such-checkpoint': { lastVerificationStatus: 'fail', canProgress: false } } }));
}

/** A hash of every file under a folder, by relative path: nothing may be added, removed or changed. */
async function treeHash(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { out[`${path.relative(dir, full)}/`] = 'dir'; await walk(full); } else out[path.relative(dir, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rehearse-ws-')));
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rehearse-out-')));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'csv', name: 'CSV export', branchName: 'feat/csv', description: 'Add CSV export', repos: [], assistants: [] }));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('the rehearsal on a full workspace', () => {
  it('counts every kind of data and remaps every reference it can', async () => {
    await fullWorkspace();
    const out = path.join(scratch, 'out');
    const report = await rehearseMigration(root, { out });
    expect(report.plan).toMatchObject({ source: 'file', items: 7 });
    expect(report.counts.blocksByKind).toEqual({ heading: 3, prose: 4, checkpoint: 2, step: 4, decision: 1 });
    expect(report.counts).toMatchObject({ cards: 4, links: 3, positions: 3, checkRuns: 1, now: 1, seenReaders: 2 });
    expect(report.counts.history).toEqual({ plan: 2, board: 2, total: 4 });
    expect(report.remapped).toMatchObject({ cardAreas: 1, cardSteps: 1, linkEnds: 5, positions: 2, now: 1, checks: 1 });
    expect(report.roundTrip.identical).toBe(true);
    expect(report.folder).toBe(out);

    // the database really holds it
    const db = openWorkspaceDb(out, { busy: 'cli', readOnly: true, backups: false });
    try {
      const blocks = listBlocks(db);
      const checkpoint = blocks.find((b) => b.name === 'Reports export to CSV')!;
      const step = blocks.find((b) => b.name === 'Add the Export button')!;
      const cards = listCards(db, { includeArchived: true });
      const one = cards.find((c) => c.legacyId === U(1))!;
      expect(one.id).toMatch(/^k[0-9a-z]{5}$/);
      expect(one).toMatchObject({ title: 'Card 1', area: `checkpoint:${checkpoint.id}`, stepId: step.id, look: 'Read this', pinned: true });
      const three = cards.find((c) => c.legacyId === U(3))!;
      expect(three).toMatchObject({ area: null, stepId: null });
      expect(cards.find((c) => c.legacyId === U(2))).toMatchObject({ kind: 'file', path: 'docs/spec.md', area: 'plan:own' });
      expect(cards.find((c) => c.legacyId === U(4))).toMatchObject({ about: 'commit:NexusFlow:96ca286', archived: true });
      const links = listLinks(db);
      expect(links.find((l) => l.id === U(11))).toMatchObject({ from: one.id, to: `checkpoint:${checkpoint.id}`, label: 'serves' });
      expect(links.find((l) => l.id === U(12))).toMatchObject({ from: cards.find((c) => c.legacyId === U(2))!.id, to: one.id });
      expect(links.find((l) => l.id === U(13))!.to).toBe('checkpoint:old-checkpoint'); // listed, kept as it was
      const positions = listPositions(db);
      expect(positions.find((p) => p.nodeId === one.id)).toMatchObject({ x: 10, y: 20 });
      expect(positions.find((p) => p.nodeId === `checkpoint:${checkpoint.id}`)).toMatchObject({ x: 100, y: 200 });
      expect(getNow(db)).toMatchObject({ itemId: step.id, by: 'claude' });
      const runs = listCheckRuns(db, checkpoint.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ legacy: true, status: 'passed', sha: 'abc1234', checkKind: 'command', command: 'npm test' });
      const history = listChanges(db, { limit: 50 });
      const legacy = history.filter((h) => h.kind === 'legacy');
      expect(legacy).toHaveLength(4);
      expect((db.sqlite.prepare("SELECT count(*) AS n FROM changes WHERE kind = 'legacy' AND rows IS NOT NULL").get() as { n: number }).n).toBe(0); // summaries only: no Undo
      expect(legacy.map((h) => h.summary).join('\n')).toContain('Write the CSV writer');
      const seen = db.sqlite.prepare('SELECT reader, pending FROM seen ORDER BY reader').all() as Array<{ reader: string; pending: string }>;
      expect(seen.map((r) => r.reader)).toEqual(['#plan-file', 'claude', 'user']);
      expect(JSON.parse(seen.find((r) => r.reader === 'claude')!.pending)).toMatchObject({ knowledge: ['k1', 'k2'] });
      expect(JSON.parse(seen.find((r) => r.reader === 'user')!.pending)).toEqual([]);
      const planSeen = JSON.parse((db.sqlite.prepare("SELECT seen FROM seen WHERE reader = '#plan-file'").get() as { seen: string }).seen) as { hash: string; items: Record<string, unknown> };
      const writer = blocks.find((b) => b.name === 'Write the CSV writer')!;
      expect(planSeen.hash).toBe('abc');
      expect(Object.keys(planSeen.items).sort()).toEqual([writer.id, 'a-removed-step'].sort()); // a live item by its id, a gone one by its old key
    } finally { db.close(); }
  });

  it('lists what it could not map, with the card and its old key, and exits 3', async () => {
    await fullWorkspace();
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    const by = (what: string) => report.unmapped.filter((u) => u.what === what);
    expect(by('card.step')).toEqual([expect.objectContaining({ card: U(3), title: 'Card 3', value: 'a-step-that-was-reworded' })]);
    expect(by('card.area')).toEqual([expect.objectContaining({ card: U(3), value: 'checkpoint:gone-checkpoint' })]);
    expect(by('link.to')).toEqual([expect.objectContaining({ value: 'checkpoint:old-checkpoint' })]);
    expect(by('position')).toEqual([expect.objectContaining({ value: 'checkpoint:gone-checkpoint' })]);
    expect(by('check')).toEqual([expect.objectContaining({ value: 'no-such-checkpoint' })]);
    expect(report.unmapped).toHaveLength(5);
    expect(rehearsalExitCode(report)).toBe(3);
    const text = renderRehearsal(report);
    expect(text).toContain('Card 3');
    expect(text).toContain('a-step-that-was-reworded');
  });

  it('names an unreadable log line and keeps the rest (listed, so exit 3)', async () => {
    await fullWorkspace();
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.skipped).toEqual([expect.objectContaining({ input: '.contextspace/plan-changes.jsonl', skipped: expect.stringContaining('1 line') })]);
  });

  it('writes a portable snapshot beside the database and says its size and what one tick changes', async () => {
    await fullWorkspace();
    const out = path.join(scratch, 'out');
    const report = await rehearseMigration(root, { out });
    const file = path.join(out, 'contextspace-data.json');
    const text = await fs.readFile(file, 'utf8');
    expect(report.snapshot).toMatchObject({ file, bytes: Buffer.byteLength(text) });
    expect(report.snapshot.tick).toMatchObject({ changedLines: expect.any(Number) });
    expect(report.snapshot.tick!.changedLines).toBeGreaterThan(0);
    expect(report.snapshot.tick!.changedLines).toBeLessThan(10);
    // the database in `out` was not ticked by the simulation
    const db = openWorkspaceDb(out, { busy: 'cli', readOnly: true, backups: false });
    try { expect(exportPortableSnapshot(db)).toBe(text); expect(listBlocks(db).find((b) => b.name === 'Add the Export button')!.done).toBe(false); } finally { db.close(); }
    expect(await fs.readFile(path.join(out, 'PLAN.md'), 'utf8')).toContain('<!-- Written by ContextSpace');
  });

  it('changes nothing in the workspace: every file hashes the same before and after, and no file appears', async () => {
    await fullWorkspace();
    const before = await treeHash(root);
    await rehearseMigration(root, { out: path.join(scratch, 'out') });
    await rehearseMigration(root);
    expect(await treeHash(root)).toEqual(before);
  });

  it('refuses an out folder inside the workspace, and one that already holds a database', async () => {
    await fullWorkspace();
    await expect(rehearseMigration(root, { out: path.join(root, '.contextspace') })).rejects.toThrow(/inside the workspace/);
    await expect(rehearseMigration(root, { out: path.join(root, '.contextspace', 'dry') })).rejects.toThrow(/inside the workspace/);
    await expect(rehearseMigration(root, { out: path.join(root, 'elsewhere') })).rejects.toThrow(/inside the workspace/);
    const link = path.join(scratch, 'link');
    await fs.symlink(path.join(root, '.contextspace'), link);
    await expect(rehearseMigration(root, { out: path.join(link, 'x') })).rejects.toThrow(/inside the workspace/);
    const out = path.join(scratch, 'out');
    await rehearseMigration(root, { out });
    await expect(rehearseMigration(root, { out })).rejects.toThrow(/not empty/);
  });
});

describe('the unhappy paths', () => {
  it('a clean plan with no board exits 0 and round trips', async () => {
    await write('PLAN.md', PLAN);
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.unmapped).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.duplicateKeys).toEqual([]);
    expect(report.roundTrip.identical).toBe(true);
    expect(rehearsalExitCode(report)).toBe(0);
    expect(renderRehearsal(report)).toContain('Everything maps');
  });

  it('names a corrupt board file and still imports the plan and the other inputs', async () => {
    await fullWorkspace();
    await write('contextspace-board.json', '{ "version": 1, "cards": [');
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.skipped).toContainEqual(expect.objectContaining({ input: 'contextspace-board.json', skipped: expect.stringContaining('whole board') }));
    expect(report.counts).toMatchObject({ cards: 0, links: 0, positions: 0, now: 1 });
    expect(report.plan.items).toBe(7);
    expect(report.roundTrip.identical).toBe(true);
    expect(rehearsalExitCode(report)).toBe(3);
  });

  it('names cards, links and positions the board would not load', async () => {
    await fullWorkspace();
    const bad = { ...BOARD, cards: [...BOARD.cards, { id: 'not-a-uuid', kind: 'note', title: 'x' }, card(9, { kind: 'file', path: '/etc/passwd' })], links: [...BOARD.links, { id: 'nope' }], positions: { ...BOARD.positions, junk: { x: 1, y: 1 } } };
    await write('contextspace-board.json', JSON.stringify(bad));
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.skipped).toContainEqual(expect.objectContaining({ input: 'contextspace-board.json', skipped: expect.stringMatching(/2 of 6 cards/) }));
    expect(report.skipped).toContainEqual(expect.objectContaining({ input: 'contextspace-board.json', skipped: expect.stringMatching(/1 of 4 links/) }));
    expect(report.skipped).toContainEqual(expect.objectContaining({ input: 'contextspace-board.json', skipped: expect.stringMatching(/1 of 4 positions/) }));
    expect(report.counts.cards).toBe(4);
  });

  it('names unreadable seen, now and state files', async () => {
    await fullWorkspace();
    await write('.contextspace/seen.json', '{oops');
    await write('.contextspace/plan-now.json', '[]');
    await write('.contextspace/plan-seen.json', 'nope');
    await write('.contextspace/state.json', '{"x":');
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.skipped.map((s) => s.input)).toEqual(expect.arrayContaining(['.contextspace/plan-now.json', '.contextspace/plan-seen.json', '.contextspace/seen.json', '.contextspace/state.json']));
    expect(report.counts).toMatchObject({ now: 0, seenReaders: 0, checkRuns: 0 });
  });

  it('treats {} as a cleared Now (how the app keeps one), and maps a copy suffix on a checkpoint node (#2)', async () => {
    await fullWorkspace();
    await write('.contextspace/plan-now.json', '{}\n');
    await write('contextspace-board.json', JSON.stringify({ ...BOARD, links: [{ id: U(14), from: U(2), to: 'checkpoint:reports-export-to-csv#2', by: 'user', at: AT }], positions: { 'checkpoint:reports-export-to-csv#2': { x: 5, y: 6 } } }));
    const out = path.join(scratch, 'out');
    const report = await rehearseMigration(root, { out });
    expect(report.skipped.map((s) => s.input)).not.toContain('.contextspace/plan-now.json');
    expect(report.counts.now).toBe(0);
    const db = openWorkspaceDb(out, { busy: 'cli', readOnly: true, backups: false });
    try {
      const checkpoint = listBlocks(db).find((b) => b.name === 'Reports export to CSV')!;
      expect(listLinks(db)[0]!.to).toBe(`checkpoint:${checkpoint.id}#2`);
      expect(listPositions(db)).toEqual([{ nodeId: `checkpoint:${checkpoint.id}#2`, x: 5, y: 6 }]);
    } finally { db.close(); }
  });

  it('lists a Now that names a step that is gone or done', async () => {
    await fullWorkspace();
    await write('.contextspace/plan-now.json', JSON.stringify({ key: 'write-the-csv-writer', by: 'claude', at: AT }));
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.unmapped).toContainEqual(expect.objectContaining({ what: 'now', value: 'write-the-csv-writer', reason: expect.stringContaining('done') }));
    expect(report.counts.now).toBe(0);
  });

  it('reports duplicate plan keys, and which item each reference went to', async () => {
    await write('PLAN.md', `# P

## Checkpoints

- [ ] Top
  - [ ] Foo
  - [ ] Foo
  - [ ] Foo
`);
    await write('contextspace-board.json', JSON.stringify({ version: 1, revision: 1, cards: [card(1, { area: 'checkpoint:top', step: 'foo' }), card(2, { step: 'foo-2' }), card(3, { step: 'foo-3' }), card(4, { step: 'foo-4' })], links: [], positions: {} }));
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.duplicateKeys).toHaveLength(1);
    const dup = report.duplicateKeys[0]!;
    expect(dup.key).toBe('foo');
    expect(dup.items.map((i) => i.key)).toEqual(['foo', 'foo-2', 'foo-3']);
    const ids = dup.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
    const refs = dup.references.map((r) => `${r.what}:${r.card}:${r.value}->${r.wentTo}`);
    expect(refs).toContain(`card.step:${U(1)}:foo->${ids[0]}`);
    expect(refs).toContain(`card.step:${U(2)}:foo-2->${ids[1]}`);
    expect(refs).toContain(`card.step:${U(3)}:foo-3->${ids[2]}`);
    expect(report.unmapped.map((u) => u.value)).toEqual(['foo-4']);
    expect(rehearsalExitCode(report)).toBe(3);
    expect(renderRehearsal(report)).toMatch(/foo-2/);
  });

  it('the packet case Foo, Foo, Foo-2: the shared key foo-2 is ambiguous, every item is listed, and a reference to it is not sent anywhere', async () => {
    await write('PLAN.md', `# P

## Checkpoints

- [ ] Top
  - [ ] Foo
  - [ ] Foo
  - [ ] Foo-2
`);
    await write('contextspace-board.json', JSON.stringify({ version: 1, revision: 1, cards: [card(1, { step: 'foo' }), card(2, { step: 'foo-2' })], links: [], positions: {} }));
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.duplicateKeys).toHaveLength(1);
    const dup = report.duplicateKeys[0]!;
    expect(dup.items).toHaveLength(3);
    expect(new Set(dup.items.map((i) => i.id)).size).toBe(3); // no item disappears
    expect(dup.items.map((i) => i.text)).toEqual(['Foo', 'Foo', 'Foo-2']);
    const bad = report.unmapped.filter((u) => u.what === 'card.step');
    expect(bad).toEqual([expect.objectContaining({ card: U(2), value: 'foo-2', reason: expect.stringMatching(/ambiguous/), candidates: [dup.items[1]!.id, dup.items[2]!.id] })]);
    expect(dup.references).toContainEqual(expect.objectContaining({ card: U(2), value: 'foo-2', ambiguous: true }));
    expect(dup.references).toContainEqual(expect.objectContaining({ card: U(1), value: 'foo', wentTo: dup.items[0]!.id }));
    const db = openWorkspaceDb(path.join(scratch, 'out'), { busy: 'cli', readOnly: true, backups: false });
    try { expect(listCards(db).find((c) => c.legacyId === U(2))!.stepId).toBeNull(); } finally { db.close(); }
    expect(rehearsalExitCode(report)).toBe(3);
    expect(renderRehearsal(report)).toMatch(/ambiguous/);
  });

  it('a card is mapped only to a step (today\'s Board matches only steps); a checkpoint or decision key is listed', async () => {
    await write('PLAN.md', PLAN);
    await write('contextspace-board.json', JSON.stringify({ version: 1, revision: 1, cards: [card(1, { step: 'reports-export-to-csv' }), card(2, { step: 'should-archived-reports-be-exported' }), card(3, { step: 'add-the-export-button' })], links: [], positions: {} }));
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.unmapped.filter((u) => u.what === 'card.step').map((u) => u.value)).toEqual(['reports-export-to-csv', 'should-archived-reports-be-exported']);
    expect(report.unmapped[0]!.reason).toMatch(/not a step/);
    expect(report.remapped.cardSteps).toBe(1);
  });

  it('reads a workspace that has only the older contextspace-plan.json as the PLAN.md it would become', async () => {
    const { changePlan } = await import('./plan.js');
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export endpoint' }, { actor: { by: 'user' } });
    // the older store holds it; make the state of the world exactly "only contextspace-plan.json"
    await fs.rm(path.join(root, 'PLAN.md'), { force: true });
    await fs.access(path.join(root, 'contextspace-plan.json'));
    const before = await treeHash(root);
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.plan.source).toBe('store');
    expect(report.plan.items).toBeGreaterThan(0);
    expect(report.roundTrip.identical).toBe(true);
    expect(await treeHash(root)).toEqual(before);
    await expect(fs.access(path.join(root, 'PLAN.md'))).rejects.toThrow();
  });

  it('a workspace with no plan at all says so and exits 3', async () => {
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.plan.source).toBe('none');
    expect(report.skipped).toContainEqual(expect.objectContaining({ input: 'PLAN.md' }));
    expect(rehearsalExitCode(report)).toBe(3);
  });

  it('says an older plan store with no items holds no plan, rather than that it is missing', async () => {
    await write('contextspace-plan.json', JSON.stringify({ version: 1, revision: 1, updatedAt: AT, items: [], imports: [] }));
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.plan.source).toBe('none');
    expect(report.skipped).toEqual([expect.objectContaining({ input: 'contextspace-plan.json', problem: expect.stringContaining('no plan items') })]);
  });

  it('fails (exit 1) and shows the difference when the export is not the source', async () => {
    await write('PLAN.md', PLAN);
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out'), exportHook: (t: string) => t.replace('Customers export', 'Customers EXPORT') });
    expect(report.roundTrip.identical).toBe(false);
    expect(report.roundTrip.differences![0]).toMatchObject({ line: 3, source: 'Customers export their reports.', export: 'Customers EXPORT their reports.' });
    expect(rehearsalExitCode(report)).toBe(1);
    expect(renderRehearsal(report)).toContain('Customers EXPORT');
  });
});


describe('paths in the report', () => {
  it('are workspace-relative with / on every platform, even when the platform joins with \\', () => {
    expect(relativePosix('C:\\ws', 'C:\\ws\\.contextspace\\state.json', path.win32)).toBe('.contextspace/state.json');
    expect(relativePosix('/ws', '/ws/.contextspace-state.json', path.posix)).toBe('.contextspace-state.json');
  });

  it('name an older state file with / (the Not read list leaves it out, and a corrupt one is named with /)', async () => {
    await write('PLAN.md', PLAN);
    await write('.contextspace/state.json', '{"x":');
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.skipped.map((x) => x.input)).toContain('.contextspace/state.json');
    expect([...report.skipped.map((x) => x.input), ...report.notRead].some((x) => x.includes('\\'))).toBe(false);
  });
});

describe('fix round 1', () => {
  const stateOnly = (name: string) => write(name, JSON.stringify({ workspacePath: root, repos: {}, updatedAt: AT, planChecks: { 'reports-export-to-csv': { lastVerificationSha: 'abc1234', lastVerificationStatus: 'pass', canProgress: true, at: AT } } }));

  it('reads the plan checks from the older state file name the app falls back to', async () => {
    await write('PLAN.md', PLAN);
    await stateOnly('.contextspace-state.json');
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.counts.checkRuns).toBe(1);
    expect(report.unmapped).toEqual([]);
    expect(report.notRead).not.toContain('.contextspace-state.json');
  });

  it('names an unreadable older state file too', async () => {
    await write('PLAN.md', PLAN);
    await write('.contextspace-state.json', '{"x":');
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.skipped).toContainEqual(expect.objectContaining({ input: '.contextspace-state.json' }));
  });

  it('carries the older store\'s milestone checks (planEvidence) over, and lists one it cannot place', async () => {
    const { changePlan } = await import('./plan.js');
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export endpoint' }, { actor: { by: 'user' } });
    const { readPlanReadOnly } = await import('./lifecycle.js');
    const milestone = (await readPlanReadOnly(root)).items.find((i) => i.kind === 'milestone')!;
    await write('.contextspace-state.json', JSON.stringify({ workspacePath: root, repos: {}, updatedAt: AT, planEvidence: { [milestone.id]: { lastVerificationStatus: 'pass', canProgress: true, at: AT }, M99: { lastVerificationStatus: 'fail', canProgress: false } } }));
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.plan.source).toBe('store');
    expect(report.counts.checkRuns).toBe(1);
    expect(report.unmapped).toContainEqual(expect.objectContaining({ what: 'check', value: 'M99' }));
  });

  describe('--out', () => {
    it('refuses a folder that exists and is not empty', async () => {
      const out = path.join(scratch, 'busy');
      await fs.mkdir(out);
      await fs.writeFile(path.join(out, 'precious.txt'), 'keep me');
      await expect(rehearseMigration(root, { out })).rejects.toThrow(/not empty/);
      expect(await fs.readFile(path.join(out, 'precious.txt'), 'utf8')).toBe('keep me');
      expect(await fs.readdir(out)).toEqual(['precious.txt']);
      const file = path.join(scratch, 'afile');
      await fs.writeFile(file, 'x');
      await expect(rehearseMigration(root, { out: file })).rejects.toThrow(/not empty|not a folder/);
    });

    it('accepts an existing empty folder', async () => {
      const out = path.join(scratch, 'empty');
      await fs.mkdir(out);
      await write('PLAN.md', PLAN);
      expect((await rehearseMigration(root, { out })).roundTrip.identical).toBe(true);
    });

    it('refuses the brand home, anything inside it, by env, by default folder and through a link', async () => {
      const home = path.join(scratch, 'brand-home');
      await fs.mkdir(home);
      const saved = { c: process.env.CONTEXTSPACE_HOME, n: process.env.NEXUSFLOW_HOME };
      try {
        process.env.CONTEXTSPACE_HOME = home;
        await expect(rehearseMigration(root, { out: path.join(home, 'sub') })).rejects.toThrow(/brand home/);
        await expect(rehearseMigration(root, { out: home })).rejects.toThrow(/brand home/);
        const link = path.join(scratch, 'homelink');
        await fs.symlink(home, link);
        await expect(rehearseMigration(root, { out: path.join(link, 'x') })).rejects.toThrow(/brand home/);
        delete process.env.CONTEXTSPACE_HOME;
        process.env.NEXUSFLOW_HOME = home;
        await expect(rehearseMigration(root, { out: path.join(home, 'sub2') })).rejects.toThrow(/brand home/);
      } finally {
        if (saved.c === undefined) delete process.env.CONTEXTSPACE_HOME; else process.env.CONTEXTSPACE_HOME = saved.c;
        if (saved.n === undefined) delete process.env.NEXUSFLOW_HOME; else process.env.NEXUSFLOW_HOME = saved.n;
      }
      for (const dir of ['.contextspace', '.nexusflow']) await expect(rehearseMigration(root, { out: path.join(os.homedir(), dir, 'rehearsal-should-not-exist') })).rejects.toThrow(/brand home/);
      expect(await fs.readdir(home)).toEqual([]);
    });

    it('refuses a folder inside another workspace (a manifest, a PLAN.md or the older plan above it), through links', async () => {
      for (const marker of ['contextspace.json', 'nexusflow.json', 'PLAN.md', 'contextspace-plan.json']) {
        const other = path.join(scratch, `other-${marker}`);
        await fs.mkdir(other);
        await fs.writeFile(path.join(other, marker), marker === 'PLAN.md' ? '# x' : '{}');
        await expect(rehearseMigration(root, { out: path.join(other, 'new') })).rejects.toThrow(/another workspace/);
        expect(await fs.readdir(other)).toEqual([marker]);
      }
      const other = path.join(scratch, 'other-linked');
      await fs.mkdir(other);
      await fs.writeFile(path.join(other, 'contextspace.json'), '{}');
      const link = path.join(scratch, 'otherlink');
      await fs.symlink(other, link);
      await expect(rehearseMigration(root, { out: path.join(link, 'new') })).rejects.toThrow(/another workspace/);
      const busy = path.join(scratch, 'busy-link-target');
      await fs.mkdir(busy);
      await fs.writeFile(path.join(busy, 'a'), 'a');
      await fs.symlink(busy, path.join(scratch, 'busylink'));
      await expect(rehearseMigration(root, { out: path.join(scratch, 'busylink') })).rejects.toThrow(/not empty/);
    });
  });

  it('the tick simulation does not use the system temp folder', async () => {
    await write('PLAN.md', PLAN);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = path.join(scratch, 'no', 'such', 'tmp');
    try {
      const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
      expect(report.snapshot.tick.changedLines).toBeGreaterThan(0);
      expect(await fs.readdir(path.join(scratch, 'out'))).not.toContainEqual(expect.stringMatching(/tick/)); // cleaned up
    } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  });

  it('names an unreadable PLAN.md or a corrupt contextspace-plan.json instead of throwing, and goes on', async () => {
    await fs.mkdir(path.join(root, 'PLAN.md'));
    await write('contextspace-board.json', JSON.stringify(BOARD));
    const report = await rehearseMigration(root, { out: path.join(scratch, 'a') });
    expect(report.skipped).toContainEqual(expect.objectContaining({ input: 'PLAN.md', problem: expect.stringMatching(/could not be read/) }));
    expect(report.plan.source).toBe('none');
    expect(rehearsalExitCode(report)).toBe(3);
    await fs.rm(path.join(root, 'PLAN.md'), { recursive: true });
    await write('contextspace-plan.json', '{ not json');
    const again = await rehearseMigration(root, { out: path.join(scratch, 'b') });
    expect(again.skipped).toContainEqual(expect.objectContaining({ input: 'contextspace-plan.json', problem: expect.stringMatching(/could not be read/) }));
    expect(rehearsalExitCode(again)).toBe(3);
  });

  it('removes the temp folder it made when the rehearsal fails after choosing it, and leaves a user\'s --out alone', async () => {
    await write('PLAN.md', PLAN);
    const temps = async () => (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('contextspace-rehearsal-'));
    const before = await temps();
    const boom = () => { throw new Error('boom'); };
    await expect(rehearseMigration(root, { exportHook: boom })).rejects.toThrow(/boom/);
    expect(await temps()).toEqual(before);
    const out = path.join(scratch, 'mine');
    await expect(rehearseMigration(root, { out, exportHook: boom })).rejects.toThrow(/boom/);
    await fs.access(out);
  });

  it('matches plan items to blocks by place and by words, and fails loudly on a mismatch', async () => {
    const text = '## Checkpoints\n\n- [ ] Alpha\n  - [ ] Beta\n';
    const items = planItems(parsePlanFile(text));
    const block = (id: string, kind: string, name: string) => ({ id, kind, name }) as never;
    const ok = matchPlanItems(items, [block('c1', 'checkpoint', 'Alpha'), block('s1', 'step', 'Beta')]);
    expect(ok.problems).toEqual([]);
    expect(ok.keys.get('beta')).toBe('s1');
    const swapped = matchPlanItems(items, [block('c1', 'checkpoint', 'Alpha'), block('s1', 'step', 'Gamma')]);
    expect(swapped.problems.join('\n')).toMatch(/"Beta".*"Gamma"/);
    expect(swapped.keys.has('beta')).toBe(false);
    expect(matchPlanItems(items, [block('c1', 'checkpoint', 'Alpha')]).problems.join('\n')).toMatch(/2 items.*1/);
  });

  it('lists the .contextspace files it did not read under "Not read"', async () => {
    await fullWorkspace();
    await write('.contextspace/chat.jsonl', '{}\n');
    await write('.contextspace/board-events.jsonl', '{}\n');
    await write('.contextspace/plan-changes.jsonl.tmp-1-abc', 'x');
    const report = await rehearseMigration(root, { out: path.join(scratch, 'out') });
    expect(report.notRead).toEqual(['.contextspace/board-events.jsonl', '.contextspace/chat.jsonl', '.contextspace/plan-changes.jsonl.tmp-1-abc']);
    expect(renderRehearsal(report)).toMatch(/Not read: .*chat\.jsonl/);
    expect(rehearsalExitCode(report)).toBe(3); // still only for the unmapped/skipped of the full workspace
  });
});
