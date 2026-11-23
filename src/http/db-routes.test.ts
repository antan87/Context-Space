/**
 * DB3b: the app's routes on a workspace moved to its database. Each test starts from a real move (`migrateWorkspace`) of a
 * small workspace, then drives the same HTTP routes the app uses. The unhappy paths come first: a change made since the
 * person read is refused and never written over, a hand edit of PLAN.md is never overwritten, a busy database says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';

import { registerPlanFileRoutes } from './plan-file-routes.js';
import { registerBoardRoutes } from './board-routes.js';
import { registerNewsRoutes } from './news-routes.js';
import { registerCommitNotesRoutes } from './commit-notes-routes.js';
import { getStorageProvider, setActiveStorageProvider } from '../core/adapters/registry.js';
import { migrateStatus, migrateWorkspace, restoreWorkspace, type MigrateOptions } from '../core/plan-migrate.js';
import { closeAppDb, readAppDb, restoreBackupForApp } from '../core/workspace-db-app.js';
import { exportSeams } from '../core/workspace-db-exports.js';
import { planDbSeams } from '../core/plan-db-app.js';
import { dbPollToken, watchLiveEvents } from '../core/screen-events.js';
import { workspaceNeeds } from '../core/needs-you.js';
import { applyBatch, beginImmediate, dbFilePath, maybeBackup, openWorkspaceDb, openWorkspaceDbAsync, readDbId, readRevision, restoreBackup, getCard, listBackups, type WorkspaceDb } from '../core/workspace-db/index.js';
import { SWITCH_FILE, readSwitch } from '../core/workspace-db-switch.js';
import { readBoard } from '../core/board.js';
import { acquireLock } from '../core/locks.js';

const check = vi.hoisted(() => ({
  result: { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def' }] } as unknown,
  handler: null as null | ((root: string, options?: { command?: string }) => Promise<unknown>),
  commands: [] as Array<string | undefined>,
}));
vi.mock('../core/verify.js', () => ({
  verifyWorkspace: vi.fn(async (workspaceRoot: string, options?: { command?: string }) => {
    check.commands.push(options?.command);
    if (check.handler) return check.handler(workspaceRoot, options);
    return check.result;
  }),
}));

const PLAN = `# CSV export

What it is for.

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
- [ ] Docs

## Steps

- [ ] Tidy the old export script
`;

const U = (n: number) => `${String(n).padStart(8, '0')}-1111-4222-8333-444455556666`;
const AT = '2026-11-01T10:00:00.000Z';
const BOARD = {
  version: 1, revision: 7,
  cards: [
    { id: U(1), kind: 'note', title: 'Export notes', body: 'The person wrote this.', pinned: false, archived: false, by: 'user', at: AT, updatedBy: 'user', updatedAt: AT, area: 'checkpoint:reports-export-to-csv', step: 'add-the-export-button' },
    { id: U(2), kind: 'note', title: 'Loose', body: 'Loose body', pinned: false, archived: false, by: 'claude', at: AT, updatedBy: 'claude', updatedAt: AT, area: 'plan:own' },
  ],
  links: [{ id: U(11), from: U(1), to: 'checkpoint:reports-export-to-csv', label: 'serves', by: 'user', at: AT }],
  positions: { [U(1)]: { x: 10, y: 20 } },
};

let root: string;
let app: Hono;
const opened: WorkspaceDb[] = [];

const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await app.request(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* plain text error */ }
  return { status: response.status, body: parsed };
}
const getPlan = async () => (await call('GET', '/api/workspace/csv/plan')).body;
const getBoard = async () => (await call('GET', '/api/workspace/csv/board')).body;
const changePlan = (change: unknown) => call('POST', '/api/workspace/csv/plan', { change });
const changeBoard = (changes: unknown[], extra: Record<string, unknown> = {}) => call('POST', '/api/workspace/csv/board/changes', { changes, ...extra });

/** A separate connection, as another process (an AI's CLI in DB3c) would have. */
function other(): WorkspaceDb {
  const db = openWorkspaceDb(root, { busy: 'cli', backups: false });
  opened.push(db);
  return db;
}
async function aiApplies(ops: unknown[]): Promise<void> {
  const db = other();
  const result = await applyBatch(db, { ops: ops as any, ifRevision: readRevision(db.sqlite), dbId: readDbId(db.sqlite) }, { by: 'claude' });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

const itemOf = (plan: any, words: string) => {
  const all = [...plan.checkpoints, ...plan.checkpoints.flatMap((cp: any) => [...cp.steps, ...cp.decisions]), ...plan.steps, ...plan.decisions];
  const found = all.find((item: any) => (item.title ?? item.text ?? item.question) === words);
  if (!found) throw new Error(`no item "${words}"`);
  return found;
};
const idOf = (plan: any, words: string): string => itemOf(plan, words).key;
const observed = (plan: any, words: string) => ({ rev: itemOf(plan, words).rev, dbId: plan.dbId });

beforeEach(async () => {
  setActiveStorageProvider(getStorageProvider('local'));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'db-routes-')));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'csv', name: 'CSV export', branchName: 'feat/csv', description: 'Add CSV export', repos: [], assistants: [] }));
  await write('PLAN.md', PLAN);
  await write('contextspace-board.json', JSON.stringify(BOARD, null, 2));
  await write('.contextspace/plan-now.json', JSON.stringify({ key: 'add-the-export-button', by: 'claude', at: '2026-11-04T00:00:00.000Z' }));
  const options: MigrateOptions = { by: 'user', findOlderWriters: async () => [], backup: false };
  await migrateWorkspace(root, options);
  app = new Hono();
  const resolve = async (id: string) => (id === 'csv' ? root : null);
  registerPlanFileRoutes(app, resolve);
  registerBoardRoutes(app, resolve);
  registerNewsRoutes(app, resolve);
  registerCommitNotesRoutes(app, resolve);
});

afterEach(async () => {
  exportSeams.beforeSwap = undefined;
  exportSeams.link = undefined;
  planDbSeams.afterRead = undefined;
  check.handler = null;
  check.commands = [];
  check.result = { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def' }] };
  for (const db of opened.splice(0)) { try { db.close(); } catch { /* closed */ } }
  await closeAppDb();
  await fs.rm(root, { recursive: true, force: true });
});

describe('a change made since the person read it is refused, never written over', () => {
  it('the note-loss proof: an AI edits a note while the person edits it; the save is refused with the note as it is now, and the AI words stay', async () => {
    const board = await getBoard();
    const note = board.cards.find((c: any) => c.title === 'Export notes');
    expect(note).toMatchObject({ id: expect.stringMatching(/^k[0-9a-z]{5}$/), rev: 1, body: 'The person wrote this.' });
    // the person opens the dialog (rev 1); meanwhile an AI changes the same note
    await aiApplies([{ op: 'card.update', id: note.id, body: 'The AI added a finding.' }]);
    const save = await changeBoard([{ op: 'update_card', id: note.id, rev: note.rev, title: 'Export notes', body: 'What the person typed.' }], { dbId: board.dbId });
    expect(save.status).toBe(409);
    expect(save.body).toMatchObject({ code: 'rev_conflict', current: { id: note.id, rev: 2, body: 'The AI added a finding.', updatedBy: 'claude' } });
    expect(save.body.error).toMatch(/changed by someone else while you were editing/);
    expect((await getBoard()).cards.find((c: any) => c.id === note.id).body).toBe('The AI added a finding.');
    // overwriting on purpose: the person sends the rev they were shown in the conflict
    const again = await changeBoard([{ op: 'update_card', id: note.id, rev: save.body.current.rev, body: 'What the person typed.' }], { dbId: board.dbId });
    expect(again.status).toBe(200);
    expect(again.body.cards.find((c: any) => c.id === note.id)).toMatchObject({ body: 'What the person typed.', rev: 3, updatedBy: 'user' });
  });

  it.each([true, false])('refuses an unversioned legacy note draft (with dbId: %s)', async (sendDbId) => {
    const board = await getBoard();
    const note = board.cards.find((card: any) => card.title === 'Export notes');
    await aiApplies([{ op: 'card.update', id: note.id, body: 'Newer answer from the AI.' }]);
    const result = await changeBoard([{ op: 'update_card', id: U(1), body: 'Old draft' }], sendDbId ? { dbId: board.dbId } : {});
    expect(result).toMatchObject({ status: 409, body: { current: { id: note.id, rev: 2, body: 'Newer answer from the AI.' } } });
    expect(result.body.error).toMatch(/read.*again/i);
    expect((await getBoard()).cards.find((card: any) => card.id === note.id).body).toBe('Newer answer from the AI.');
  });

  it('removing a note that an AI changed meanwhile is refused too', async () => {
    const board = await getBoard();
    const note = board.cards.find((c: any) => c.title === 'Loose');
    await aiApplies([{ op: 'card.update', id: note.id, title: 'Loose, renamed by the AI' }]);
    const gone = await changeBoard([{ op: 'remove_card', id: note.id, rev: note.rev }], { dbId: board.dbId, revision: board.revision });
    expect(gone.status).toBe(409);
    expect((await getBoard()).cards.some((c: any) => c.id === note.id)).toBe(true);
  });

  it('a tick of a step an AI reworded since is refused, and the AI wording stays', async () => {
    const plan = await getPlan();
    const id = idOf(plan, 'Add the Export button');
    await aiApplies([{ op: 'edit', id, find: 'Export button', replace: 'Export menu' }]);
    const tick = await changePlan({ type: 'tick', key: id, done: true, expected: 'Add the Export button', ...observed(plan, 'Add the Export button') });
    expect(tick.status).toBe(409);
    expect(tick.body.error).toMatch(/now reads "Add the Export menu"/);
    const after = await getPlan();
    expect(after.checkpoints[1].steps.find((s: any) => s.key === id)).toMatchObject({ text: 'Add the Export menu', done: false });
  });

  it('a tick with a stale rev is refused even when the words are the same', async () => {
    const plan = await getPlan();
    const id = idOf(plan, 'Add the Export button');
    const rev = plan.checkpoints[1].steps.find((s: any) => s.key === id).rev;
    await aiApplies([{ op: 'detail', id, text: 'A note under it', rev }]);
    const tick = await changePlan({ type: 'tick', key: id, done: true, expected: 'Add the Export button', ...observed(plan, 'Add the Export button'), rev });
    expect(tick.status).toBe(409);
  });

  it('an answer to a decision an AI answered meanwhile is refused, and the AI answer stays', async () => {
    const plan = await getPlan();
    const id = plan.waiting[0];
    const rev = plan.checkpoints[1].decisions[0].rev;
    await aiApplies([{ op: 'answer', id, text: 'Only the last year' }]);
    const answer = await call('POST', `/api/workspace/csv/plan/decisions/${id}/answer`, { answer: 'Yes, all of them', rev, dbId: plan.dbId });
    expect(answer.status).toBe(409);
    expect((await getPlan()).checkpoints[1].decisions[0]).toMatchObject({ answer: 'Only the last year' });
  });

  it('an unversioned untick shows the current decision answer without clearing it', async () => {
    const decision = (await getPlan()).waiting[0];
    await aiApplies([{ op: 'answer', id: decision, text: 'Only the last year' }]);
    const untick = await changePlan({ type: 'tick', key: decision, done: false, expected: 'Should archived reports be exported?' });
    expect(untick).toMatchObject({ status: 409, body: { current: { answer: 'Only the last year', rev: 2 } } });
    expect(untick.body.error).toContain(`ctxspace plan ${decision}`);
    expect((await getPlan()).checkpoints[1].decisions[0]).toMatchObject({ answer: 'Only the last year' });
  });

  it('an unversioned first answer cannot overwrite an answer saved during submission', async () => {
    const decision = (await getPlan()).waiting[0];
    planDbSeams.afterRead = async () => { planDbSeams.afterRead = undefined; await aiApplies([{ op: 'answer', id: decision, text: 'Only the last year' }]); };
    const answer = await changePlan({ type: 'answer', key: decision, answer: 'Yes, all of them', expected: 'Should archived reports be exported?' });
    expect(answer).toMatchObject({ status: 409, body: { current: { answer: 'Only the last year', rev: 2 } } });
    expect((await getPlan()).checkpoints[1].decisions[0]).toMatchObject({ answer: 'Only the last year' });
  });

  it('an AI change that lands between the app reading the item and applying the change is refused in the same transaction', async () => {
    const plan = await getPlan();
    const decision = plan.waiting[0];
    planDbSeams.afterRead = async () => { planDbSeams.afterRead = undefined; await aiApplies([{ op: 'answer', id: decision, text: 'Only the last year' }]); };
    const answer = await changePlan({ type: 'answer', key: decision, answer: 'Yes, all of them', expected: 'Should archived reports be exported?', ...observed(plan, 'Should archived reports be exported?') });
    expect(answer.status).toBe(409);
    expect((await getPlan()).checkpoints[1].decisions[0]).toMatchObject({ answer: 'Only the last year' });
    const step = idOf(plan, 'Add the Export button');
    planDbSeams.afterRead = async () => { planDbSeams.afterRead = undefined; await aiApplies([{ op: 'edit', id: step, find: 'button', replace: 'menu' }]); };
    const tick = await changePlan({ type: 'tick', key: step, done: true, expected: 'Add the Export button', ...observed(plan, 'Add the Export button') });
    expect(tick.status).toBe(409);
    expect((await getPlan()).checkpoints[1].steps.find((s: any) => s.key === step)).toMatchObject({ text: 'Add the Export menu', done: false });
  });

  it('a board change against another database (a restored backup) is refused', async () => {
    const note = (await getBoard()).cards[0];
    const change = await changeBoard([{ op: 'update_card', id: note.id, title: 'x' }], { dbId: 'ffffffffffffffff' });
    expect(change.status).toBe(409);
    expect(change.body.code).toBe('db_changed');
  });
});

describe('the exports: written after each change, fenced, never over a hand edit', () => {
  it('PLAN.md and contextspace-data.json follow a tick; the header names the new revision', async () => {
    const plan = await getPlan();
    const id = idOf(plan, 'Tidy the old export script');
    const tick = await changePlan({ type: 'tick', key: id, done: true, expected: 'Tidy the old export script', ...observed(plan, 'Tidy the old export script') });
    expect(tick.status).toBe(200);
    const text = await read('PLAN.md');
    expect(text).toMatch(new RegExp(`- \\[x\\] Tidy the old export script <!-- ${id} -->`));
    expect(text.split('\n')[0]).toMatch(new RegExp(`db=${plan.dbId} revision=${plan.revision + 1} `));
    const data = JSON.parse(await read('contextspace-data.json'));
    expect(data.revision).toBe(plan.revision + 1);
    expect(data.blocks.find((b: any) => b.id === id).done).toBe(true);
  });

  it('a drag changes neither committed file, header included', async () => {
    const before = { plan: await read('PLAN.md'), data: await read('contextspace-data.json') };
    const note = (await getBoard()).cards[0];
    const moved = await changeBoard([{ op: 'move', nodes: [{ id: note.id, x: 300, y: 400 }] }]);
    expect(moved.status).toBe(200);
    expect(moved.body.positions[note.id]).toEqual({ x: 300, y: 400 });
    expect(await read('PLAN.md')).toBe(before.plan);
    expect(await read('contextspace-data.json')).toBe(before.data);
  });

  it('a hand edit of PLAN.md is never written over: the change goes into the database and the edit stays as it is', async () => {
    const handEdited = `${await read('PLAN.md')}\n- [ ] A line someone typed by hand\n`;
    await write('PLAN.md', handEdited);
    const plan = await getPlan();
    const tick = await changePlan({ type: 'tick', key: idOf(plan, 'Docs'), done: true, expected: 'Docs', ...observed(plan, 'Docs') });
    expect(tick.status).toBe(200);
    expect(await read('PLAN.md')).toBe(handEdited);
    expect(JSON.parse(await read('contextspace-data.json')).blocks.find((b: any) => b.id === idOf(plan, 'Docs')).done).toBe(true);
  });

  it('never replaces a newer export with an older one', async () => {
    const plan = await getPlan();
    // another process published an export of this database at a later revision
    const current = await read('PLAN.md');
    const lines = current.split('\n');
    const newer = lines[0]!.replace(/revision=\d+/, `revision=${plan.revision + 50}`);
    await write('PLAN.md', [newer, ...lines.slice(1)].join('\n'));
    const kept = await read('PLAN.md');
    const tick = await changePlan({ type: 'tick', key: idOf(plan, 'Docs'), done: true, expected: 'Docs', ...observed(plan, 'Docs') });
    expect(tick.status).toBe(200);
    expect(await read('PLAN.md')).toBe(kept);
  });

  it('a save that lands while the export is being swapped in is kept, not overwritten', async () => {
    const plan = await getPlan();
    const save = '# Someone saved this in an editor\n';
    exportSeams.beforeSwap = async (file) => { if (file === 'PLAN.md') await write('PLAN.md', save); };
    const tick = await changePlan({ type: 'tick', key: idOf(plan, 'Docs'), done: true, expected: 'Docs', ...observed(plan, 'Docs') });
    expect(tick.status).toBe(200);
    expect(await read('PLAN.md')).toBe(save);
  });
});

describe('reads and writes go through the database', () => {
  it('the plan keeps today’s shape, keyed by id, with rev, revision and dbId; Now and the proof come from the database', async () => {
    const plan = await getPlan();
    expect(plan).toMatchObject({ file: 'PLAN.md', source: 'file', store: 'database', title: 'CSV export', intro: 'What it is for.', revision: expect.any(Number), dbId: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const cp = plan.checkpoints[1];
    expect(cp).toMatchObject({ key: expect.stringMatching(/^c[0-9a-z]{5}$/), id: cp.key, title: 'Reports export to CSV', check: 'npm test', rev: 1 });
    expect(cp.steps.map((s: any) => s.text)).toEqual(['Write the CSV writer', 'Add the Export button']);
    expect(cp.decisions[0]).toMatchObject({ question: 'Should archived reports be exported?', checkpoint: cp.key, suggested: ['Yes, all of them', 'Only the last year'] });
    expect(plan.waiting).toEqual([cp.decisions[0].key]);
    expect(plan.now).toMatchObject({ key: idOf(plan, 'Add the Export button'), by: 'claude' });
    expect(plan.steps[0]).toMatchObject({ text: 'Tidy the old export script', key: expect.stringMatching(/^s/) });
  });

  it('the board keeps today’s shape with card ids, revs, and areas and steps that name plan ids', async () => {
    const plan = await getPlan();
    const board = await getBoard();
    expect(board).toMatchObject({ version: 1, store: 'database', revision: plan.revision, dbId: plan.dbId });
    const note = board.cards.find((c: any) => c.title === 'Export notes');
    expect(note).toMatchObject({ kind: 'note', area: `checkpoint:${plan.checkpoints[1].key}`, step: idOf(plan, 'Add the Export button'), rev: 1, by: 'user' });
    expect(board.links[0]).toMatchObject({ from: note.id, to: `checkpoint:${plan.checkpoints[1].key}`, label: 'serves' });
    expect(board.positions[note.id]).toEqual({ x: 10, y: 20 });
  });

  it('a reworded step keeps its cards', async () => {
    const plan = await getPlan();
    const id = idOf(plan, 'Add the Export button');
    await aiApplies([{ op: 'reword', id, text: 'Add an Export menu', rev: 1 }]);
    const note = (await getBoard()).cards.find((c: any) => c.title === 'Export notes');
    expect(note.step).toBe(id);
    expect((await getPlan()).checkpoints[1].steps.find((s: any) => s.key === id).text).toBe('Add an Export menu');
  });

  it('ticks, answers, adds a step and a decision, reopens, and runs a checkpoint check before ticking it', async () => {
    let plan = await getPlan();
    const cp = plan.checkpoints[1];
    expect((await changePlan({ type: 'answer', key: cp.decisions[0].key, answer: 'Only the last year', expected: cp.decisions[0].question, rev: cp.decisions[0].rev, dbId: plan.dbId })).status).toBe(200);
    expect((await changePlan({ type: 'add', step: 'Write the docs page', checkpoint: plan.checkpoints[2].key })).status).toBe(200);
    expect((await changePlan({ type: 'add', step: 'A loose one' })).status).toBe(200);
    expect((await changePlan({ type: 'decide', checkpoint: cp.key, decision: { question: 'Zip large files?', suggested: ['Yes', 'No'] } })).status).toBe(200);
    plan = await getPlan();
    expect(plan.checkpoints[1].decisions[0]).toMatchObject({ done: true, answer: 'Only the last year' });
    expect(plan.checkpoints[2].steps.map((s: any) => s.text)).toEqual(['Write the docs page']);
    expect(plan.steps.map((s: any) => s.text)).toEqual(['Tidy the old export script', 'A loose one']);
    expect(plan.checkpoints[1].decisions[1]).toMatchObject({ question: 'Zip large files?', suggested: ['Yes', 'No'] });
    // the checkpoint has a check: a failing one keeps it open
    const checkpointRev = plan.checkpoints[1].rev;
    check.result = { overallStatus: 'fail', canProgress: false, repos: [] };
    const failed = await changePlan({ type: 'tick', key: cp.key, done: true, expected: cp.title, rev: checkpointRev, dbId: plan.dbId });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatch(/stays open: its check failed/);
    check.result = { overallStatus: 'pass', canProgress: true, repos: [] };
    const passed = await changePlan({ type: 'tick', key: cp.key, done: true, expected: cp.title, rev: checkpointRev, dbId: plan.dbId });
    expect(passed.status).toBe(200);
    expect(passed.body.plan.checkpoints[1]).toMatchObject({ done: true, proof: { canProgress: true, lastVerificationStatus: 'pass' } });
    const reopened = await changePlan({ type: 'reopen', key: cp.key, reason: 'The button is missing', expected: cp.title, rev: passed.body.plan.checkpoints[1].rev, dbId: plan.dbId });
    expect(reopened.status).toBe(200);
    expect(reopened.body.plan.checkpoints[1]).toMatchObject({ done: false });
    expect(reopened.body.plan.checkpoints[1].steps.at(-1).text).toBe('Reopened: The button is missing');
    // the plan tab's "what changed" reads the history
    expect(reopened.body.plan.changes.slice(0, 2).map((c: any) => `${c.by} ${c.action} ${c.text}`).sort()).toEqual(['user added Reopened: The button is missing', 'user unticked Reports export to CSV']);
  });

  it('Now is set and cleared in the database; a heading for steps and a done step are refused', async () => {
    const plan = await getPlan();
    const step = idOf(plan, 'Tidy the old export script');
    const set = await call('POST', '/api/workspace/csv/plan/now', { key: step });
    expect(set.status).toBe(200);
    expect(set.body.plan.now).toMatchObject({ key: step, by: 'user' });
    const done = await call('POST', '/api/workspace/csv/plan/now', { key: idOf(plan, 'Write the CSV writer') });
    expect(done.status).toBe(400);
    expect(done.body.error).toMatch(/already done/);
    const clear = await call('POST', '/api/workspace/csv/plan/now', { clear: true });
    expect(clear.body.plan.now).toBeNull();
    expect(await fs.access(path.join(root, '.contextspace/plan-now.json')).then(() => true, () => false)).toBe(false);
  });

  it('adds, edits, links, moves and removes a note on the board', async () => {
    const plan = await getPlan();
    const area = `checkpoint:${plan.checkpoints[2].key}`;
    const added = await changeBoard([{ op: 'add_card', kind: 'note', title: 'New note', body: 'b', area, position: { x: 1, y: 2 } }]);
    expect(added.status).toBe(200);
    const id = added.body.results[0].id;
    expect(added.body.cards.find((c: any) => c.id === id)).toMatchObject({ title: 'New note', area, rev: 1, by: 'user' });
    expect(added.body.positions[id]).toEqual({ x: 1, y: 2 });
    const edited = await changeBoard([{ op: 'update_card', id, rev: 1, body: 'edited', step: idOf(plan, 'Add the Export button') }], { dbId: plan.dbId });
    // a step puts the card in its checkpoint's area
    expect(edited.body.cards.find((c: any) => c.id === id)).toMatchObject({ body: 'edited', area: `checkpoint:${plan.checkpoints[1].key}`, rev: 2 });
    const linked = await changeBoard([{ op: 'link', from: id, to: area }, { op: 'move', nodes: [{ id, x: null, y: null }] }]);
    expect(linked.body.links.some((l: any) => l.from === id && l.to === area)).toBe(true);
    expect(linked.body.positions[id]).toBeUndefined();
    const removed = await changeBoard([{ op: 'remove_card', id, rev: 2 }], { dbId: plan.dbId, revision: linked.body.revision });
    expect(removed.status).toBe(200);
    expect(removed.body.cards.some((c: any) => c.id === id)).toBe(false);
    expect(removed.body.links.some((l: any) => l.from === id)).toBe(false);
  });

  it('a card moved from the old file still answers to its old uuid', async () => {
    const changed = await changeBoard([{ op: 'update_card', id: U(1), pinned: true }]);
    expect(changed.status).toBe(200);
    expect(changed.body.cards.find((c: any) => c.title === 'Export notes').pinned).toBe(true);
  });

  it('what a reader saw is kept in the database, without a new revision', async () => {
    const before = await dbPollToken(root);
    const news = await call('GET', '/api/workspace/csv/news?reader=user');
    expect(news.status).toBe(200);
    expect(news.body.problems.join(' ')).not.toMatch(/not recorded/);
    const seen = await call('POST', '/api/workspace/csv/news/seen', { reader: 'user', at: news.body.at });
    expect(seen).toMatchObject({ status: 200, body: { ok: true } });
    const db = other();
    const row = db.sqlite.prepare("SELECT seen, pending FROM seen WHERE reader = 'user'").get() as { seen: string; pending: string };
    expect(JSON.parse(row.seen).at).toBe(news.body.at);
    expect(row.pending).toBe('[]');
    expect(await dbPollToken(root)).toBe(before);
    // marking the same report twice is the old "the list changed"
    expect((await call('POST', '/api/workspace/csv/news/seen', { reader: 'user', at: news.body.at })).status).toBe(409);
  });

  it('the plan news and Needs you read the database', async () => {
    const plan = await getPlan();
    await aiApplies([{ op: 'tick', id: idOf(plan, 'Docs') }]);
    const news = await call('GET', '/api/workspace/csv/news?reader=user&since=2020-01-01T00:00:00Z');
    expect(news.body.plan.items.map((c: any) => `${c.by} ${c.action} ${c.text}`)).toContain('claude ticked Docs');
    const needs = await workspaceNeeds('csv', root);
    expect(needs.questions.map((q) => q.id)).toEqual([plan.waiting[0]]);
    expect(needs.closedByAi.map((c) => c.id)).toContain(idOf(plan, 'Docs'));
  });

  it('the old Board file reader still refuses a moved workspace (the CLI and MCP are DB3c)', async () => {
    await expect(readBoard(root)).rejects.toThrow(/moved to the workspace database/);
  });

  it('a move or restore in progress refuses with the switch’s sentence', async () => {
    const record = JSON.parse(await read(SWITCH_FILE));
    await write(SWITCH_FILE, JSON.stringify({ ...record, state: 'restoring' }));
    const plan = await call('GET', '/api/workspace/csv/plan');
    expect(plan.status).toBe(409);
    expect(plan.body.error).toMatch(/being restored/);
    expect((await call('GET', '/api/workspace/csv/board')).status).toBe(409);
  });
});

describe('the move can still be undone after the app changed things', () => {
  it('status does not call the app’s PLAN.md a hand edit, and the restore keeps the app’s exports and puts every old file back', async () => {
    const plan = await getPlan();
    expect((await changePlan({ type: 'tick', key: idOf(plan, 'Docs'), done: true, expected: 'Docs', ...observed(plan, 'Docs') })).status).toBe(200);
    expect((await changeBoard([{ op: 'add_card', kind: 'note', title: 'After the move', body: 'x' }])).status).toBe(200);
    const status = await migrateStatus(root);
    expect(status.cameBack.map((c) => c.path)).not.toContain('PLAN.md');
    await closeAppDb(root);
    const result = await restoreWorkspace(root, readSwitch(root)!.archive!, { by: 'user' });
    expect(result.cameBack).toEqual([]);
    expect(result.exportsKeptAs.some((p) => p.endsWith('exports/PLAN.md'))).toBe(true);
    expect(await read('PLAN.md')).toBe(PLAN);
    expect(JSON.parse(await read('contextspace-board.json'))).toEqual(BOARD);
    expect(await fs.access(path.join(root, SWITCH_FILE)).then(() => true, () => false)).toBe(false);
  });
});

describe('the poll token, busy, and a backup restore with connections open', () => {
  it('the poll token is db_id:revision and moves with every change', async () => {
    const plan = await getPlan();
    expect(await dbPollToken(root)).toBe(`${plan.dbId}:${plan.revision}`);
    await aiApplies([{ op: 'tick', id: idOf(plan, 'Docs') }]);
    expect(await dbPollToken(root)).toBe(`${plan.dbId}:${plan.revision + 1}`);
  });

  it('the live feed sends plan and board events when the database changes, including a restore at the same revision', async () => {
    const plan = await getPlan();
    const controller = new AbortController();
    const seen: string[] = [];
    const feed = (async () => {
      for await (const live of watchLiveEvents(root, { pollMs: 20, signal: controller.signal })) {
        seen.push(live.type === 'screen' ? `screen:${live.event.event}` : live.type);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.filter((t) => t === 'plan' || t === 'screen:board')).toEqual([]);
    await aiApplies([{ op: 'tick', id: idOf(plan, 'Docs') }]);
    await expect.poll(() => seen.filter((t) => t === 'screen:board').length, { timeout: 3000 }).toBeGreaterThanOrEqual(1);
    expect(seen).toContain('plan');
    // a backup restored over it: a new db_id, which the token notices whatever the revision
    await maybeBackup(root);
    const before = seen.length;
    await restoreBackupForApp(root, listBackups(root)[0]!);
    await expect.poll(() => seen.slice(before).includes('screen:board'), { timeout: 3000 }).toBe(true);
    controller.abort();
    await feed;
  });

  it('a read that keeps meeting another process’s write lock ends in a bounded "Busy, try again", and the server answers meanwhile', async () => {
    // a write that waits on another process's lock: the app answers "busy" within about 2 s, and its event loop stays free
    const holder = other();
    holder.sqlite.exec('PRAGMA busy_timeout = 0');
    holder.sqlite.exec('BEGIN EXCLUSIVE');
    try {
      const started = Date.now();
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 20);
      const plan = await call('GET', '/api/workspace/csv/plan');
      clearInterval(timer);
      expect(plan.status).toBe(503);
      expect(plan.body).toMatchObject({ code: 'busy' });
      expect(plan.body.error).toMatch(/^Busy, try again/);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(ticks).toBeGreaterThan(20);
    } finally {
      holder.sqlite.exec('ROLLBACK');
    }
    expect((await call('GET', '/api/workspace/csv/plan')).status).toBe(200);
  });

  it('a backup restore is fenced: this process reopens, another connection gets "replaced", the token changes, and the replaced file is kept in the archive', async () => {
    const plan = await getPlan();
    await maybeBackup(root);
    const backup = listBackups(root)[0]!;
    // something done after the backup, then a connection held open elsewhere
    await aiApplies([{ op: 'tick', id: idOf(plan, 'Docs') }]);
    const elsewhere = other();
    const tokenBefore = await dbPollToken(root);
    const restored = await restoreBackupForApp(root, backup);
    expect(restored.keptIn).toMatch(/archive[\\/]replaced[\\/]workspace\.db\.replaced-/);
    expect((await fs.readdir(path.join(root, '.contextspace'))).filter((n) => n.includes('.replaced-'))).toEqual([]);
    await expect(beginImmediate(elsewhere)).rejects.toMatchObject({ code: 'replaced' });
    const after = await getPlan();
    expect(after.dbId).not.toBe(plan.dbId);
    expect(after.checkpoints[2].done).toBe(false); // the tick after the backup is gone with the restore
    expect(await dbPollToken(root)).not.toBe(tokenBefore);
    // the exports follow the restored database (the old generation's untouched export may be replaced)
    expect((await read('PLAN.md')).split('\n')[0]).toContain(`db=${after.dbId}`);
    expect(sha(await read('PLAN.md'))).not.toBe('');
  });

  it('a backup restore waits for another process’s write lock between timers, and gives up as busy with nothing changed', async () => {
    await getPlan();
    await maybeBackup(root);
    const backup = listBackups(root)[0]!;
    const holder = other();
    holder.sqlite.exec('PRAGMA busy_timeout = 0');
    // held for a moment: the restore waits, the event loop keeps running, then it goes ahead
    holder.sqlite.exec('BEGIN IMMEDIATE');
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    setTimeout(() => holder.sqlite.exec('ROLLBACK'), 300);
    const restored = await restoreBackupForApp(root, backup);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(10);
    expect(restored.dbId).toBe((await getPlan()).dbId);
    // held all along: busy, and the database is the one it was
    const before = await dbPollToken(root);
    const again = other();
    again.sqlite.exec('PRAGMA busy_timeout = 0');
    again.sqlite.exec('BEGIN IMMEDIATE');
    try {
      await expect(restoreBackupForApp(root, backup, { waitMs: 300 })).rejects.toMatchObject({ code: 'busy', message: expect.stringMatching(/^Busy, try again/) });
    } finally {
      again.sqlite.exec('ROLLBACK');
    }
    expect(await dbPollToken(root)).toBe(before);
    expect((await call('GET', '/api/workspace/csv/plan')).status).toBe(200);
  });

  it('a write after the database file was replaced under the connection writes nothing to the old file and is made on the new one', async () => {
    const plan = await getPlan();
    await getBoard(); // the app's connection is open
    await maybeBackup(root);
    const { restoreBackup } = await import('../core/workspace-db/index.js');
    restoreBackup(root, listBackups(root)[0]!); // as another process would
    const stale = await changePlan({ type: 'tick', key: idOf(plan, 'Docs'), done: true, expected: 'Docs', ...observed(plan, 'Docs') });
    expect(stale.body.code).toBe('db_changed');
    const restored = await getPlan();
    const tick = await changePlan({ type: 'tick', key: idOf(restored, 'Docs'), done: true, expected: 'Docs', ...observed(restored, 'Docs') });
    expect(tick.status).toBe(200);
    const db = other();
    expect(getCard(db, (await getBoard()).cards[0].id)).not.toBeNull();
    expect((db.sqlite.prepare('SELECT done FROM blocks WHERE id = ?').get(idOf(plan, 'Docs')) as { done: number }).done).toBe(1);
    // the export of the replaced generation is ours: the next change writes PLAN.md again, from the restored database
    expect((await read('PLAN.md')).split('\n')[0]).toContain(`db=${readDbId(db.sqlite)}`);
    expect(await read('PLAN.md')).toMatch(new RegExp(`- \\[x\\] Docs <!-- ${idOf(plan, 'Docs')} -->`));
  });

  it('an export of another database (another clone) is left as it is', async () => {
    const plan = await getPlan();
    const lines = (await read('PLAN.md')).split('\n');
    const foreign = [lines[0]!.replace(/db=[0-9a-f]+/, 'db=0123456789abcdef'), ...lines.slice(1)].join('\n');
    await write('PLAN.md', foreign);
    expect((await changePlan({ type: 'tick', key: idOf(plan, 'Docs'), done: true, expected: 'Docs', ...observed(plan, 'Docs') })).status).toBe(200);
    expect(await read('PLAN.md')).toBe(foreign);
  });
});

describe('DB3b fix round 1: data-safety regressions', () => {
  // Finding 1
  it('applyForApp retries getRevision through brief locks on plan and board writes, and answers 503 Busy when held past the bound', async () => {
    const plan = await getPlan();
    const stepId = idOf(plan, 'Add the Export button');
    const board = await getBoard();
    const note = board.cards[0];
    const holder = other();
    holder.sqlite.exec('PRAGMA busy_timeout = 0');

    // Brief lock on POST /plan/now { clear: true } (calls applyForApp directly)
    holder.sqlite.exec('BEGIN EXCLUSIVE');
    const t1 = setTimeout(() => { try { holder.sqlite.exec('ROLLBACK'); } catch { /* released */ } }, 120);
    const clearRes = await call('POST', '/api/workspace/csv/plan/now', { clear: true });
    clearTimeout(t1);
    expect(clearRes.status).toBe(200);

    // Brief lock starting right before applyForApp on tick
    planDbSeams.afterRead = () => {
      planDbSeams.afterRead = undefined;
      holder.sqlite.exec('BEGIN EXCLUSIVE');
      setTimeout(() => { try { holder.sqlite.exec('ROLLBACK'); } catch { /* released */ } }, 120);
    };
    const tickRes = await call('POST', `/api/workspace/csv/plan/steps/${stepId}/tick`, { done: true, expected: 'Add the Export button', ...observed(plan, 'Add the Export button') });
    expect(tickRes.status).toBe(200);

    // Brief bursts on POST /board/changes must retry cleanly and never return HTTP 500 "database is locked"
    let stop = false;
    const hammer = (async () => {
      while (!stop) {
        try {
          holder.sqlite.exec('BEGIN EXCLUSIVE');
          await new Promise((r) => setTimeout(r, 8));
          holder.sqlite.exec('ROLLBACK');
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 12));
      }
    })();
    try {
      for (let i = 0; i < 15; i += 1) {
        const res = await changeBoard([{ op: 'update_card', id: note.id, rev: note.rev + i, title: `Burst ${i}` }], { dbId: board.dbId });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
    } finally {
      stop = true;
      await hammer;
      try { holder.sqlite.exec('ROLLBACK'); } catch { /* ignore */ }
    }

    // Lock held past 2 s -> 503 Busy, try again on both plan and board writes (never 400/500 "database is locked")
    holder.sqlite.exec('BEGIN EXCLUSIVE');
    try {
      const busyPlan = await call('POST', '/api/workspace/csv/plan/now', { clear: true });
      expect(busyPlan.status).toBe(503);
      expect(busyPlan.body).toMatchObject({ code: 'busy' });
      expect(busyPlan.body.error).toMatch(/^Busy, try again/);

      const busyBoard = await changeBoard([{ op: 'update_card', id: note.id, pinned: true }]);
      expect(busyBoard.status).toBe(503);
      expect(busyBoard.body).toMatchObject({ code: 'busy' });
      expect(busyBoard.body.error).toMatch(/^Busy, try again/);
    } finally {
      holder.sqlite.exec('ROLLBACK');
    }
  });

  it('changeBoardDb forwards dbId into applyForApp even when revision and dbId are omitted, refusing a restore between read and write', async () => {
    const note = (await getBoard()).cards[0];
    await maybeBackup(root);
    const backup = listBackups(root)[0]!;
    const release = await acquireLock(path.join(root, '.contextspace', 'plan-file.lock'), { staleMs: 60_000, timeoutMs: 5_000, timeoutMessage: 'busy' });
    const reqP = changeBoard([{ op: 'update_card', id: note.id, pinned: !note.pinned }]);
    await new Promise((r) => setTimeout(r, 80)); // known snapshot read completes; writeAppDb now waits on plan-file.lock
    restoreBackup(root, backup);
    await release();
    const res = await reqP;
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'db_changed' });
    expect((await getBoard()).cards[0].pinned).toBe(note.pinned);
  });

  // Finding 2
  it('readPlanDb keys every item by its own database id, never colliding on duplicate slugs (steps, checkpoints, decisions, nested parents)', async () => {
    const dupRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'db-routes-dup-')));
    try {
      await fs.writeFile(path.join(dupRoot, 'contextspace.json'), JSON.stringify({ id: 'dup', name: 'Dup', branchName: 'feat/dup', description: 'dup', repos: [], assistants: [] }));
      await fs.writeFile(path.join(dupRoot, 'PLAN.md'), [
        '# Dup',
        '',
        '## Checkpoints',
        '',
        '- [ ] Phase',
        '  - [ ] Foo',
        '  - [ ] Foo',
        '  - [ ] Foo-2',
        '  - [ ] Decide: Q1',
        '    - [ ] Step directly under decision',
        '- [ ] Phase',
        '  - [ ] Group',
        '    - [ ] Child 1',
        '  - [ ] Group',
        '    - [ ] Child 2',
        '    - [ ] Decide: Nested Q',
        '      - [ ] Step under nested decision',
        '  - [ ] Group-2',
        '    - [ ] Child 3',
        '  - [ ] Decide: Q2',
        '- [ ] Phase-2',
        '  - [ ] Step C',
        '  - [ ] Decide: Q3',
        '',
      ].join('\n'));
      await migrateWorkspace(dupRoot, { by: 'user', findOlderWriters: async () => [], backup: false });

      const dupApp = new Hono();
      registerPlanFileRoutes(dupApp, async (id) => (id === 'dup' ? dupRoot : null));
      const req = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
        const r = await dupApp.request(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        return { status: r.status, body: await r.json() as any };
      };

      const plan = (await req('GET', '/api/workspace/dup/plan')).body;
      const db = openWorkspaceDb(dupRoot, { busy: 'cli', backups: false });
      opened.push(db);
      const realCps = db.sqlite.prepare("SELECT id, name FROM blocks WHERE kind = 'checkpoint' ORDER BY ord").all() as Array<{ id: string; name: string }>;
      const realSteps = db.sqlite.prepare("SELECT id, name, parent_id FROM blocks WHERE kind = 'step' ORDER BY ord").all() as Array<{ id: string; name: string; parent_id: string | null }>;

      // All 3 checkpoints have distinct ids matching SQLite, and each decision points at its own checkpoint
      expect(plan.checkpoints.map((cp: any) => cp.key)).toEqual(realCps.map((r) => r.id));
      expect(new Set(plan.checkpoints.map((cp: any) => cp.key)).size).toBe(3);
      expect(plan.checkpoints[0].decisions[0].checkpoint).toBe(realCps[0]!.id);
      expect(plan.checkpoints[1].decisions.find((d: any) => d.question === 'Q2').checkpoint).toBe(realCps[1]!.id);
      expect(plan.checkpoints[2].decisions[0].checkpoint).toBe(realCps[2]!.id);

      // Nested step parents match real enclosing step ids (and a step directly under a decision has no step parent, while one under outer step -> decision has outer step as parent)
      const cp1Steps = plan.checkpoints[0].steps;
      expect(cp1Steps.find((s: any) => s.text === 'Step directly under decision').parent).toBeUndefined();
      const cp2Steps = plan.checkpoints[1].steps;
      const [g1, c1, g2, c2, underNestedDec, g3, c3] = cp2Steps;
      expect(new Set([g1.key, g2.key, g3.key]).size).toBe(3);
      expect(c1.parent).toBe(g1.key);
      expect(c2.parent).toBe(g2.key);
      expect(underNestedDec.parent).toBe(g2.key);
      expect(c3.parent).toBe(g3.key);

      // Ticking the second "Foo" ticks ONLY the second "Foo", leaving "Foo-2" unticked
      const [foo1, foo2, fooDash2] = cp1Steps;
      expect(new Set([foo1.key, foo2.key, fooDash2.key]).size).toBe(3);
      const tickRes = await req('POST', `/api/workspace/dup/plan/steps/${foo2.key}/tick`, { done: true, expected: 'Foo', rev: foo2.rev, dbId: plan.dbId });
      expect(tickRes.status).toBe(200);
      const afterRows = db.sqlite.prepare("SELECT id, name, done FROM blocks WHERE id IN (?, ?, ?) ORDER BY ord").all(foo1.key, foo2.key, fooDash2.key) as Array<{ id: string; name: string; done: number }>;
      expect(afterRows).toEqual([
        { id: foo1.key, name: 'Foo', done: 0 },
        { id: foo2.key, name: 'Foo', done: 1 },
        { id: fooDash2.key, name: 'Foo-2', done: 0 },
      ]);
      // And Foo-2 can still be ticked cleanly
      const tickDash2 = await req('POST', `/api/workspace/dup/plan/steps/${fooDash2.key}/tick`, { done: true, expected: 'Foo-2', rev: fooDash2.rev, dbId: plan.dbId });
      expect(tickDash2.status).toBe(200);
      expect(realSteps.length).toBeGreaterThan(0);
    } finally {
      await closeAppDb(dupRoot);
      await fs.rm(dupRoot, { recursive: true, force: true });
    }
  });

  // Finding 3 (backend vanished step/area plain reporting)
  it('a note save naming a vanished checkpoint or step reports it plainly without CLI jargon', async () => {
    const plan = await getPlan();
    const note = (await getBoard()).cards[0];
    const docsId = idOf(plan, 'Docs');
    const stepId = idOf(plan, 'Tidy the old export script');
    await aiApplies([{ op: 'remove', id: docsId, rev: 1 }, { op: 'remove', id: stepId, rev: 1 }]);

    const badArea = await changeBoard([{ op: 'update_card', id: note.id, area: `checkpoint:${docsId}` }]);
    expect(badArea.status).toBe(400);
    expect(badArea.body.error).toMatch(/area is no longer on the plan/i);
    expect(badArea.body.error).not.toMatch(/ctxspace plan/);

    const badStep = await changeBoard([{ op: 'update_card', id: note.id, step: stepId }]);
    expect(badStep.status).toBe(400);
    expect(badStep.body.error).toMatch(/step is no longer on the plan/i);
  });

  // Finding 4
  it('a closed WorkspaceDb reports isCurrent() === false and readerConnection() throws replaced without opening a reader', async () => {
    const db = await openWorkspaceDbAsync(root, { busy: 'server' });
    db.close();
    expect(db.isCurrent()).toBe(false);
    expect(() => db.readerConnection()).toThrow(/replaced/);
  });

  it('in-flight GET /plan and GET /board sleeping in readWithRetry survive restoreBackupForApp and succeed on the restored database', async () => {
    await getPlan();
    await getBoard();
    await maybeBackup(root);
    const backup = listBackups(root)[0]!;

    const holder = other();
    holder.sqlite.exec('PRAGMA busy_timeout = 0');
    holder.sqlite.exec('BEGIN EXCLUSIVE');
    const planPromise = call('GET', '/api/workspace/csv/plan');
    const boardPromise = call('GET', '/api/workspace/csv/board');
    // After 100 ms both reads are sleeping inside readWithRetry
    await new Promise((r) => setTimeout(r, 100));
    holder.sqlite.exec('ROLLBACK');
    holder.sqlite.exec('BEGIN IMMEDIATE');
    const restorePromise = restoreBackupForApp(root, backup);
    const releaseTimer = setTimeout(() => { try { holder.sqlite.exec('ROLLBACK'); } catch { /* ignore */ } }, 400);
    const [planRes, boardRes, restored] = await Promise.all([planPromise, boardPromise, restorePromise]);
    clearTimeout(releaseTimer);
    try { holder.sqlite.exec('ROLLBACK'); } catch { /* ignore */ }

    expect(planRes.status, JSON.stringify(planRes.body)).toBe(200);
    expect(planRes.body.dbId).toBe(restored.dbId);
    expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(200);
    expect(boardRes.body.dbId).toBe(restored.dbId);
  });

  it('connection() retiring an old handle waits for entry.gate, and closeAppDb never detaches a newly opened live handle', async () => {
    // Part A: connection() must not bypass entry.gate after await retire(old)
    await getPlan();
    await maybeBackup(root);
    const backup = listBackups(root)[0]!;

    let releasePending!: () => void;
    const pendingJob = new Promise<void>((resolve) => { releasePending = resolve; });
    await readAppDb(root, (v) => {
      const tracked = pendingJob.finally(() => { v.pending.delete(tracked); });
      v.pending.add(tracked);
    });
    // Replace workspace.db externally so entry.db.isCurrent() becomes false
    const midRestore = restoreBackup(root, backup);
    // Start a read -> enters connection(), sees !isCurrent(), awaits retire(old) (blocked on pendingJob)
    const readP = call('GET', '/api/workspace/csv/plan');
    await new Promise((r) => setTimeout(r, 20));
    // Start restoreBackupForApp while a holder delays restoreBackupAsync so entry.gate stays closed after pendingJob resolves
    const holder = other();
    holder.sqlite.exec('PRAGMA busy_timeout = 0');
    holder.sqlite.exec('BEGIN IMMEDIATE');
    const restoreP = restoreBackupForApp(root, backup);
    await new Promise((r) => setTimeout(r, 30));
    releasePending(); // retire(old) completes while restoreP still holds entry.gate!
    await new Promise((r) => setTimeout(r, 100));
    holder.sqlite.exec('ROLLBACK');
    const [readRes, finalRestored] = await Promise.all([readP, restoreP]);
    expect(readRes.status).toBe(200);
    expect(finalRestored.dbId).not.toBe(midRestore.dbId);
    expect(readRes.body.dbId).toBe(finalRestored.dbId);

    // Part B: closeAppDb must not detach a freshly opened db2 from held
    let releaseClose!: () => void;
    const holdClose = new Promise<void>((resolve) => { releaseClose = resolve; });
    await readAppDb(root, (v) => {
      const tracked = holdClose.finally(() => { v.pending.delete(tracked); });
      v.pending.add(tracked);
    });
    const closeP = closeAppDb(root); // nulls entry.db, awaits retire(db1)
    await new Promise((r) => setTimeout(r, 20));
    // Concurrent read opens db2 into entry.db while closeP is still retiring db1
    let db2Current!: () => boolean;
    await readAppDb(root, (v) => { db2Current = () => v.isCurrent(); });
    expect(db2Current()).toBe(true);
    releaseClose();
    await closeP;
    // A second closeAppDb MUST still find and close db2 (it must not have been detached!)
    await closeAppDb(root);
    expect(db2Current()).toBe(false);
  });

  // Finding 5
  it('ticking a checked checkpoint whose words or Check: changed before startCheckRun refuses with 409 and runs nothing', async () => {
    const plan = await getPlan();
    const cp = plan.checkpoints[1];
    planDbSeams.afterRead = async () => {
      planDbSeams.afterRead = undefined;
      await aiApplies([
        { op: 'reword', id: cp.key, text: 'Reports export to CSV v2', rev: cp.rev },
        { op: 'edit', id: cp.key, in: 'detail', find: '`npm test`', replace: '`false`' },
      ]);
    };
    const tick = await changePlan({ type: 'tick', key: cp.key, done: true, expected: cp.title, rev: cp.rev, dbId: plan.dbId });
    expect(tick.status).toBe(409);
    expect(tick.body.code).toBe('rev_conflict');
    expect(check.commands).toEqual([]);
    const db = other();
    const row = db.sqlite.prepare('SELECT name, done FROM blocks WHERE id = ?').get(cp.key) as { name: string; done: number };
    expect(row).toEqual({ name: 'Reports export to CSV v2', done: 0 });
    expect(db.sqlite.prepare('SELECT id FROM check_runs WHERE item_id = ?').all(cp.key)).toEqual([]);
  });

  it('POST /checkpoints/:key/check runs the live command from under the write lock and never forges a pass for a changed command', async () => {
    const plan = await getPlan();
    const cp = plan.checkpoints[1];
    check.handler = async (_r, opts) => (
      opts?.command === 'npm run strict'
        ? { overallStatus: 'fail', canProgress: false, repos: [] }
        : { overallStatus: 'pass', canProgress: true, repos: [] }
    );
    planDbSeams.afterRead = async () => {
      planDbSeams.afterRead = undefined;
      await aiApplies([{ op: 'edit', id: cp.key, in: 'detail', find: '`npm test`', replace: '`npm run strict`' }]);
    };
    const res = await call('POST', `/api/workspace/csv/plan/checkpoints/${cp.key}/check`);
    expect(res.status).toBe(200);
    expect(check.commands).toEqual(['npm run strict']);
    expect(res.body.message).toMatch(/failed/);
    const db = other();
    const runs = db.sqlite.prepare('SELECT command, status FROM check_runs WHERE item_id = ?').all(cp.key);
    expect(runs).toEqual([{ command: 'npm run strict', status: 'failed' }]);
  });

  it('POST /checkpoints/:key/check maps busy to 503 and mid-flight switch flips (restoring / off) to 409', async () => {
    const plan = await getPlan();
    const cp = plan.checkpoints[1];

    // Busy DB during startCheckRun -> 503 busy (never 400)
    const holder = other();
    holder.sqlite.exec('PRAGMA busy_timeout = 0');
    holder.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const busy = await call('POST', `/api/workspace/csv/plan/checkpoints/${cp.key}/check`);
      expect(busy.status).toBe(503);
      expect(busy.body).toMatchObject({ code: 'busy' });
      expect(busy.body.error).toMatch(/^Busy, try again/);
    } finally {
      holder.sqlite.exec('ROLLBACK');
    }

    // Mid-flight on -> restoring -> 409 moved
    const origSwitch = await read(SWITCH_FILE);
    planDbSeams.afterRead = async () => {
      planDbSeams.afterRead = undefined;
      await write(SWITCH_FILE, JSON.stringify({ ...JSON.parse(origSwitch), state: 'restoring' }));
    };
    const restoring = await call('POST', `/api/workspace/csv/plan/checkpoints/${cp.key}/check`);
    expect(restoring.status).toBe(409);
    expect(restoring.body).toMatchObject({ code: 'moved' });
    await write(SWITCH_FILE, origSwitch);

    // Mid-flight on -> off -> 409 replaced
    planDbSeams.afterRead = async () => {
      planDbSeams.afterRead = undefined;
      await fs.unlink(path.join(root, SWITCH_FILE));
    };
    const off = await call('POST', `/api/workspace/csv/plan/checkpoints/${cp.key}/check`);
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ code: 'replaced' });
    await write(SWITCH_FILE, origSwitch);
  });

  // Finding 6a & 6b
  it('POST /plan/now reports 503 busy and 409 missing instead of swallowing errors as 404', async () => {
    const plan = await getPlan();
    const stepId = idOf(plan, 'Tidy the old export script');

    const holder = other();
    holder.sqlite.exec('PRAGMA busy_timeout = 0');
    holder.sqlite.exec('BEGIN EXCLUSIVE');
    try {
      const busy = await call('POST', '/api/workspace/csv/plan/now', { key: stepId });
      expect(busy.status).toBe(503);
      expect(busy.body).toMatchObject({ code: 'busy' });
      expect(busy.body.error).toMatch(/^Busy, try again/);
    } finally {
      holder.sqlite.exec('ROLLBACK');
    }

    // Deleted workspace.db -> 409 missing (never 404)
    for (const db of opened.splice(0)) { try { db.close(); } catch { /* closed */ } }
    await closeAppDb(root);
    await fs.unlink(dbFilePath(root));
    const missing = await call('POST', '/api/workspace/csv/plan/now', { key: stepId });
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({ code: 'missing' });
  });

  it('GET /commit-notes maps moving/restoring/unreadable switches to 409 and busy DB to 503', async () => {
    const origSwitch = await read(SWITCH_FILE);
    for (const mode of ['moving', 'restoring', 'unreadable'] as const) {
      if (mode === 'unreadable') await write(SWITCH_FILE, '{not json');
      else await write(SWITCH_FILE, JSON.stringify({ ...JSON.parse(origSwitch), state: mode }));
      const res = await call('GET', '/api/workspace/csv/commit-notes');
      expect(res.status, mode).toBe(409);
      expect(res.body).toMatchObject({ code: 'moved' });
      expect(res.body.error).toBeTruthy();
    }
    await write(SWITCH_FILE, origSwitch);

    const holder = other();
    holder.sqlite.exec('PRAGMA busy_timeout = 0');
    holder.sqlite.exec('BEGIN EXCLUSIVE');
    try {
      const busy = await call('GET', '/api/workspace/csv/commit-notes');
      expect(busy.status).toBe(503);
      expect(busy.body).toMatchObject({ code: 'busy' });
      expect(busy.body.error).toMatch(/^Busy, try again/);
    } finally {
      holder.sqlite.exec('ROLLBACK');
    }
  });

  // Finding 7
  it('publishOne leaves a symlink or directory landing in beforeSwap intact at PLAN.md instead of overwriting or stranding it', async () => {
    const plan = await getPlan();
    const s1 = idOf(plan, 'Docs');
    const s2 = idOf(plan, 'Tidy the old export script');

    // Symlink pointing to a copy of the current export
    const currentText = await read('PLAN.md');
    const outsideTarget = path.join(root, '.contextspace', 'outside-copy.md');
    await fs.writeFile(outsideTarget, currentText);
    exportSeams.beforeSwap = async (file) => {
      if (file === 'PLAN.md') {
        await fs.unlink(path.join(root, 'PLAN.md'));
        await fs.symlink(outsideTarget, path.join(root, 'PLAN.md'));
      }
    };
    const r1 = await changePlan({ type: 'tick', key: s1, done: true, expected: 'Docs', ...observed(plan, 'Docs') });
    exportSeams.beforeSwap = undefined;
    expect(r1.status).toBe(200);
    expect((await fs.lstat(path.join(root, 'PLAN.md'))).isSymbolicLink()).toBe(true);

    // Put back a regular export so the directory race hits the rename path
    await fs.unlink(path.join(root, 'PLAN.md'));
    await write('PLAN.md', currentText);

    // Directory appearing at PLAN.md right before swap
    exportSeams.beforeSwap = async (file) => {
      if (file === 'PLAN.md') {
        await fs.unlink(path.join(root, 'PLAN.md'));
        await fs.mkdir(path.join(root, 'PLAN.md'));
        await fs.writeFile(path.join(root, 'PLAN.md', 'important.txt'), 'keep me');
      }
    };
    const r2 = await changePlan({ type: 'tick', key: s2, done: true, expected: 'Tidy the old export script', ...observed(plan, 'Tidy the old export script') });
    exportSeams.beforeSwap = undefined;
    expect(r2.status).toBe(200);
    const stat = await fs.lstat(path.join(root, 'PLAN.md'));
    expect(stat.isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(root, 'PLAN.md', 'important.txt'), 'utf8')).toBe('keep me');
    const drafts = await fs.readdir(path.join(root, '.contextspace', 'drafts')).catch(() => []);
    expect(drafts).toEqual([]);
  });

  it('publishOne falls back on EINVAL from fs.link and restores PLAN.md if placement fails after rename', async () => {
    const plan = await getPlan();
    const s1 = idOf(plan, 'Docs');
    const s2 = idOf(plan, 'Tidy the old export script');

    // Non-NTFS Windows volume returns EINVAL on fs.link -> exclusive copy fallback succeeds
    exportSeams.link = async () => { throw Object.assign(new Error('EINVAL: invalid argument, link'), { code: 'EINVAL' }); };
    const r1 = await changePlan({ type: 'tick', key: s1, done: true, expected: 'Docs', ...observed(plan, 'Docs') });
    exportSeams.link = undefined;
    expect(r1.status).toBe(200);
    const afterEinval = await read('PLAN.md');
    expect(afterEinval).toContain('- [x] Docs');
    expect(await fs.readdir(path.join(root, '.contextspace', 'drafts')).catch(() => [])).toEqual([]);

    // Unexpected failure after fs.rename(target, aside) -> original PLAN.md is put back, never left missing
    exportSeams.link = async () => { throw Object.assign(new Error('EIO: disk failure'), { code: 'EIO' }); };
    const r2 = await changePlan({ type: 'tick', key: s2, done: true, expected: 'Tidy the old export script', ...observed(plan, 'Tidy the old export script') });
    exportSeams.link = undefined;
    expect(r2.status).toBe(200);
    expect(await read('PLAN.md')).toBe(afterEinval);
    expect(await fs.readdir(path.join(root, '.contextspace', 'drafts')).catch(() => [])).toEqual([]);
  });
});
