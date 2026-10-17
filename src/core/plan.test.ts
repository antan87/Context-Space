import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import {
  PLAN_HISTORY_LIMIT,
  PLAN_STORE_FILE,
  PlanError,
  applyPlanChange,
  changePlan,
  emptyPlan,
  findItem,
  freshenPlan,
  heldUpBy,
  mutatePlan,
  planFocus,
  planSections,
  planStoreExists,
  readPlan,
  type PlanActor,
  type PlanChange,
  type PlanDocument,
} from './plan.js';
import { ANSWERED_IN_CHAT, PLAN_RULES, PLAN_SECTIONS, PLAN_STATUSES, STATUS_WORDS, itemLabel } from './plan-words.js';

const user: PlanActor = { by: 'user' };
const claude: PlanActor = { by: 'agent', harness: 'claude' };
const codex: PlanActor = { by: 'agent', harness: 'codex' };

let root: string;
const storePath = () => path.join(root, PLAN_STORE_FILE);
const change = (c: PlanChange, actor: PlanActor = user, options: { ifRevision?: number } = {}) => changePlan(root, c, { actor, ...options });

/** The CSV export example from the design: M1 done, M2 waits for T1 and Q1, M3 waits for M2. */
async function seedExample() {
  await change({ type: 'add', kind: 'milestone', title: 'Database query for report rows' });
  await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint', after: ['M1'] });
  await change({ type: 'add', kind: 'milestone', title: 'Export button in the UI', after: ['M2'] });
  await change({ type: 'add', kind: 'task', title: 'Background job queue', before: ['M2'] }, claude);
  await change({ type: 'add', kind: 'question', title: 'Which time zone should export timestamps use?', owner: 'user', before: ['M2'] }, codex);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-store-'));
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'test', branchName: 'test', repos: [], assistants: [] }));
});
afterEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.rm(root, { recursive: true, force: true });
});

describe('the words', () => {
  it('has a word and a meaning for every status, six sections and six rules', () => {
    for (const status of PLAN_STATUSES) expect(STATUS_WORDS[status].label).toMatch(/^[A-Z]/);
    expect(PLAN_STATUSES).toHaveLength(6);
    expect(PLAN_SECTIONS.map((section) => section.label)).toEqual(['Goal', 'Needs you', 'Milestones', 'Other open work', 'Done and dropped', 'What changed']);
    expect(PLAN_RULES).toHaveLength(6);
  });

  it('names an item by its code and its name, never the code alone', () => {
    expect(itemLabel({ id: 'M1', title: 'Database query' })).toBe('M1 Database query');
  });
});

describe('reading and writing the store', () => {
  it('starts empty, without creating a file just by reading', async () => {
    expect(await readPlan(root)).toEqual(emptyPlan());
    expect(await planStoreExists(root)).toBe(false);
  });

  it('gives new items codes by kind, writes them and bumps the revision once per change', async () => {
    await seedExample();
    const plan = await readPlan(root);
    expect(plan.items.map((item) => item.id)).toEqual(['M1', 'M2', 'M3', 'T1', 'Q1']);
    expect(plan.revision).toBe(5);
    expect(JSON.parse(await fs.readFile(storePath(), 'utf8')).revision).toBe(5);
  });

  it('says what waits for what in both directions, from waitsFor alone', async () => {
    await seedExample();
    const plan = await readPlan(root);
    expect(plan.items.find((item) => item.id === 'M2')!.waitsFor).toEqual(['M1', 'T1', 'Q1']);
    expect(heldUpBy(plan, 'M2').map((item) => item.id)).toEqual(['M3']);
  });

  it('labels every message with the code and the name', async () => {
    const { message } = await change({ type: 'add', kind: 'task', title: 'Cap exports at 50,000 rows' });
    expect(message).toBe('Added T1 Cap exports at 50,000 rows.');
    await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    const added = await change({ type: 'add', kind: 'task', title: 'Background job queue', before: ['M1'] });
    expect(added.message).toBe('Added T2 Background job queue. M1 CSV export endpoint now waits for it.');
  });

  it('refuses a stale revision and changes nothing', async () => {
    await seedExample();
    const error = await change({ type: 'start', id: 'T1' }, claude, { ifRevision: 2 }).catch((e) => e);
    expect(error).toBeInstanceOf(PlanError);
    expect(error.code).toBe('conflict');
    expect((await readPlan(root)).items.find((item) => item.id === 'T1')!.status).toBe('todo');
  });

  it('keeps every change when many writers change it at once', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'Base' });
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      change({ type: 'add', kind: 'task', title: `Task ${index}`, after: ['M1'] }, index % 2 ? claude : codex)));
    const plan = await readPlan(root);
    expect(plan.items).toHaveLength(13);
    expect(new Set(plan.items.map((item) => item.id)).size).toBe(13);
    expect(plan.revision).toBe(13);
  });

  it('keeps at most the last changes in an item\'s history', async () => {
    await change({ type: 'add', kind: 'task', title: 'Busy' });
    for (let index = 0; index < PLAN_HISTORY_LIMIT + 5; index += 1) {
      await change({ type: 'block', id: 'T1', reason: `Reason ${index}` });
    }
    const [item] = (await readPlan(root)).items;
    expect(item!.history).toHaveLength(PLAN_HISTORY_LIMIT);
    expect(item!.history.at(-1)!.note).toBe(`Reason ${PLAN_HISTORY_LIMIT + 4}`);
  });
});

describe('a damaged store fails closed', () => {
  it.each([
    ['not JSON', '{broken'],
    ['not a plan', JSON.stringify({ version: 1, revision: 1, updatedAt: '', items: [{ id: 'M1' }] })],
    ['an unknown wait', JSON.stringify({ version: 1, revision: 1, updatedAt: '', items: [{
      id: 'M1', kind: 'milestone', title: 'A', status: 'todo', waitsFor: ['X9'], createdAt: '', updatedAt: '', history: [] }] })],
    ['waits in a circle', JSON.stringify({ version: 1, revision: 1, updatedAt: '', items: [
      { id: 'M1', kind: 'milestone', title: 'A', status: 'todo', waitsFor: ['M2'], createdAt: '', updatedAt: '', history: [] },
      { id: 'M2', kind: 'milestone', title: 'B', status: 'todo', waitsFor: ['M1'], createdAt: '', updatedAt: '', history: [] }] })],
  ])('refuses %s, writes nothing and says how to restore it', async (_name, content) => {
    await fs.writeFile(storePath(), content);
    const read = await readPlan(root).catch((e) => e);
    expect(read).toBeInstanceOf(PlanError);
    expect(read.code).toBe('corrupt');
    expect(read.message).toContain('git checkout -- contextspace-plan.json');
    await expect(change({ type: 'add', kind: 'task', title: 'New' })).rejects.toMatchObject({ code: 'corrupt' });
    expect(await fs.readFile(storePath(), 'utf8')).toBe(content);
  });

  it('refuses a store written by a newer version instead of guessing', async () => {
    await fs.writeFile(storePath(), JSON.stringify({ version: 2, revision: 1, updatedAt: '', items: [] }));
    await expect(readPlan(root)).rejects.toThrow(/newer ContextSpace/);
  });

  it('recovers after the file is restored: the lock and queue were released', async () => {
    await fs.writeFile(storePath(), '{broken');
    await expect(change({ type: 'add', kind: 'task', title: 'New' })).rejects.toThrow();
    await fs.rm(storePath());
    await change({ type: 'add', kind: 'task', title: 'New' });
    expect((await readPlan(root)).items).toHaveLength(1);
  });

  it('leaves the last good copy when a write fails, and works again afterwards', async () => {
    await change({ type: 'add', kind: 'task', title: 'Kept' });
    const before = await fs.readFile(storePath(), 'utf8');
    const failing = new LocalStorageAdapter();
    failing.writeWorkspaceFile = async () => { throw new Error('disk full'); };
    setActiveStorageProvider(failing);
    await expect(change({ type: 'add', kind: 'task', title: 'Lost' })).rejects.toThrow('disk full');
    expect(await fs.readFile(storePath(), 'utf8')).toBe(before);
    setActiveStorageProvider(new LocalStorageAdapter());
    await change({ type: 'add', kind: 'task', title: 'Next' });
    expect((await readPlan(root)).items.map((item) => item.title)).toEqual(['Kept', 'Next']);
  });

  it('never writes a change that would break the plan', async () => {
    await change({ type: 'add', kind: 'task', title: 'A' });
    await change({ type: 'add', kind: 'task', title: 'B', after: ['T1'] });
    const error = await change({ type: 'edit', id: 'T1', after: ['T2'] }).catch((e) => e);
    expect(error.code).toBe('invalid');
    expect(error.message).toMatch(/circle: T1 A → T2 B → T1 A/);
    await expect(change({ type: 'edit', id: 'T1', after: ['T1'] })).rejects.toThrow(/waits for itself/);
    expect((await readPlan(root)).items[0]!.waitsFor).toEqual([]);
  });
});

describe('closing needs a reason', () => {
  it.each<[string, PlanChange]>([
    ['done', { type: 'done', id: 'T1', resolution: '  ' }],
    ['drop', { type: 'drop', id: 'T1', reason: '' }],
    ['later', { type: 'later', id: 'T1', revisitWhen: '\u0007' }],
    ['block', { type: 'block', id: 'T1', reason: ' \n ' }],
  ])('refuses %s without one', async (_name, closing) => {
    await change({ type: 'add', kind: 'task', title: 'Work' });
    await expect(change(closing)).rejects.toMatchObject({ code: 'invalid' });
    expect((await readPlan(root)).items[0]!.status).toBe('todo');
  });

  it('keeps dropped and later items, with their reason and history: nothing is deleted', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'User docs' });
    await change({ type: 'add', kind: 'decision', title: 'Excel export' });
    await change({ type: 'drop', id: 'M1', reason: 'Docs are generated automatically now' });
    await change({ type: 'later', id: 'D1', revisitWhen: 'After user feedback on CSV' });
    const plan = await readPlan(root);
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({ status: 'dropped', resolution: 'Docs are generated automatically now' });
    expect(plan.items[1]).toMatchObject({ status: 'later', revisitWhen: 'After user feedback on CSV' });
    expect(plan.items[0]!.history.map((entry) => entry.action)).toEqual(['added', 'dropped']);
  });

  it('answers a question with the answer, and only a question', async () => {
    await change({ type: 'add', kind: 'question', title: 'Maximum rows per export?' });
    await change({ type: 'add', kind: 'task', title: 'Not a question' });
    const { item } = await change({ type: 'answer', id: 'Q1', answer: '50,000 rows' });
    expect(item).toMatchObject({ status: 'done', resolution: '50,000 rows' });
    await expect(change({ type: 'answer', id: 'T1', answer: 'x' })).rejects.toThrow(/Only a question has an answer/);
  });

  it('lets the AI write the words over an answer given in the chat, and changes no other answer', async () => {
    await change({ type: 'add', kind: 'question', title: 'Which branch?', owner: 'user' }, claude);
    await change({ type: 'answer', id: 'Q1', answer: ANSWERED_IN_CHAT });
    const { item } = await change({ type: 'answer', id: 'Q1', answer: 'release, not main' }, claude);
    expect(item).toMatchObject({ status: 'done', resolution: 'release, not main' });
    expect(item.history.map((entry) => [entry.by, entry.action])).toEqual([['claude', 'added'], ['user', 'answered'], ['claude', 'answered']]);
    // Now it holds the developer's words, so it is settled like any other answer.
    await expect(change({ type: 'answer', id: 'Q1', answer: 'main' }, claude)).rejects.toThrow(/already done\. Reopen it first/);
  });

  it('cleans control characters and line breaks out of a reason', async () => {
    await change({ type: 'add', kind: 'task', title: 'Work' });
    const { item } = await change({ type: 'block', id: 'T1', reason: 'Need a key\u001b[31m\n\n2. fake' });
    expect(item.blockedReason).toBe('Need a key[31m 2. fake');
  });
});

describe('waiting and starting', () => {
  it('will not start an item while what it waits for is open, and says what it waits for', async () => {
    await seedExample();
    const error = await change({ type: 'start', id: 'M2' }).catch((e) => e);
    expect(error.code).toBe('waiting');
    expect(error.message).toBe(
      "Can't start M2 CSV export endpoint yet. It waits for: M1 Database query for report rows (To do), T1 Background job queue (To do), Q1 Which time zone should export timestamps use? (To do).",
    );
  });

  it('nothing starts by itself: finishing an item makes the next ready, not started', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'First' });
    await change({ type: 'add', kind: 'milestone', title: 'Second', after: ['M1'] });
    await change({ type: 'start', id: 'M1' });
    await change({ type: 'done', id: 'M1', resolution: 'Shipped' });
    const plan = await readPlan(root);
    expect(plan.items[1]!.status).toBe('todo');
    expect(planSections(plan).ready.map((item) => item.id)).toEqual(['M2']);
  });

  it('a dropped item no longer holds anything up', async () => {
    await change({ type: 'add', kind: 'question', title: 'Include archived reports?' });
    await change({ type: 'add', kind: 'task', title: 'Export', after: ['Q1'] });
    await change({ type: 'drop', id: 'Q1', reason: 'Archived reports are out of scope' });
    expect((await change({ type: 'start', id: 'T1' })).item.status).toBe('in_progress');
  });

  it('lets work change shape at any time: add what a running milestone now waits for', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await change({ type: 'start', id: 'M1' });
    await change({ type: 'add', kind: 'task', title: 'Background job queue', before: ['M1'] }, codex);
    await expect(change({ type: 'done', id: 'M1', resolution: 'Works' })).rejects.toMatchObject({ code: 'waiting' });
  });

  it('starting again ends a block or a later', async () => {
    await change({ type: 'add', kind: 'task', title: 'Work' });
    await change({ type: 'block', id: 'T1', reason: 'Waiting for keys' });
    const { item } = await change({ type: 'start', id: 'T1' });
    expect(item.status).toBe('in_progress');
    expect(item).not.toHaveProperty('blockedReason');
  });
});

describe('questions nobody needs answered any more', () => {
  it('withdraws a question for the user once everything it holds up is closed, and says so', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await change({ type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user', before: ['M1'] }, codex);
    const dropped = await change({ type: 'drop', id: 'M1', reason: 'Export moved to the reporting service' }, claude);
    expect(dropped.message).toMatch(/Withdrew Q1 Which time zone\?: Nothing waits for it any more: "CSV export endpoint" is closed\./);
    const question = findItem(await readPlan(root), 'Q1')!;
    expect(question).toMatchObject({ status: 'dropped', resolution: 'Nothing waits for it any more: "CSV export endpoint" is closed.' });
    expect(question.history.at(-1)).toMatchObject({ by: 'contextspace', action: 'dropped' });
  });

  it('keeps a question while something it holds up is still open, and one that holds nothing up', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await change({ type: 'add', kind: 'milestone', title: 'Export button' });
    await change({ type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user', before: ['M1', 'M2'] });
    await change({ type: 'add', kind: 'question', title: 'Dark mode later?', owner: 'user' });
    await change({ type: 'drop', id: 'M1', reason: 'Moved' });
    const plan = await readPlan(root);
    expect(findItem(plan, 'Q1')!.status).toBe('todo');
    expect(findItem(plan, 'Q2')!.status).toBe('todo');
  });

  it('leaves questions for an AI alone', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await change({ type: 'add', kind: 'question', title: 'Is the queue idempotent?', owner: 'claude', before: ['M1'] });
    await change({ type: 'drop', id: 'M1', reason: 'Moved' });
    expect(findItem(await readPlan(root), 'Q1')!.status).toBe('todo');
  });

  it('withdraws stale questions in a whole plan, writing only when it found one', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await change({ type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user', before: ['M1'] });
    await mutatePlan(root, (plan) => {
      // Closed by an older tool that did not withdraw the question.
      Object.assign(findItem(plan, 'M1')!, { status: 'done', resolution: 'Shipped' });
    });
    const revision = (await readPlan(root)).revision;
    expect((await freshenPlan(root)).map((item) => item.id)).toEqual(['Q1']);
    expect((await readPlan(root)).revision).toBe(revision + 1);
    expect(await freshenPlan(root)).toEqual([]);
    expect((await readPlan(root)).revision).toBe(revision + 1);
  });
});

describe('who may close what', () => {
  it('lets the AI close its own task', async () => {
    await change({ type: 'add', kind: 'task', title: 'Background job queue' }, claude);
    const result = await change({ type: 'done', id: 'T1', resolution: 'Runs in the background' }, claude);
    expect(result.outcome).toBe('applied');
    expect(result.item.status).toBe('done');
  });

  it('lets an AI tool close an item owned by the user or by another tool', async () => {
    await change({ type: 'add', kind: 'task', title: 'User task' });
    await change({ type: 'add', kind: 'task', title: 'Codex task', owner: 'codex' });
    expect((await change({ type: 'done', id: 'T1', resolution: 'Done' }, claude)).item.status).toBe('done');
    expect((await change({ type: 'drop', id: 'T2', reason: 'Not needed' }, claude)).item.status).toBe('dropped');
  });

  it('lets the AI finish a milestone itself, and names it in the history', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await change({ type: 'start', id: 'M1' }, claude);
    const done = await change({ type: 'done', id: 'M1', resolution: 'Tests pass on a1b2c3d' }, claude);
    expect(done.outcome).toBe('applied');
    expect(done.message).toBe('Done: M1 CSV export endpoint.');
    expect(done.item).toMatchObject({ status: 'done', resolution: 'Tests pass on a1b2c3d' });
    expect(done.item).not.toHaveProperty('proposal');
    expect(done.item.history.map((entry) => `${entry.by}:${entry.action}`)).toEqual(['user:added', 'claude:started', 'claude:done']);
    expect(planSections(await readPlan(root)).needsYou).toEqual([]);
  });

  it('lets the AI record the answer the user gave to their question', async () => {
    await change({ type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user' }, codex);
    const answered = await change({ type: 'answer', id: 'Q1', answer: 'UTC' }, codex);
    expect(answered.item).toMatchObject({ status: 'done', resolution: 'UTC' });
    expect(answered.item.history.at(-1)).toMatchObject({ by: 'codex', action: 'answered' });
  });

  it('lets the AI put off, drop and reopen a milestone', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'Database query' });
    await change({ type: 'add', kind: 'milestone', title: 'Old idea' });
    await change({ type: 'add', kind: 'milestone', title: 'Someday' });
    await change({ type: 'done', id: 'M1', resolution: 'Merged' });
    const reopened = await change({ type: 'reopen', id: 'M1', reason: 'Rows are missing' }, claude);
    expect(reopened.item).toMatchObject({ status: 'in_progress', reopenReason: 'Rows are missing', reopenedBy: 'agent', reopenCount: 1 });
    expect((await change({ type: 'drop', id: 'M2', reason: 'Covered by M1' }, claude)).item.status).toBe('dropped');
    expect((await change({ type: 'later', id: 'M3', revisitWhen: 'After the release' }, claude)).item.status).toBe('later');
  });

  it('lets the user accept or send back a proposal saved under the earlier rule, and only the user', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'CSV export endpoint' });
    await change({ type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user' });
    await mutatePlan(root, (plan) => {
      plan.items[0]!.proposal = { action: 'done', by: 'claude', note: 'Tests pass on a1b2c3d', at: '2026-10-01T00:00:00.000Z' };
      plan.items[1]!.proposal = { action: 'answer', by: 'codex', note: 'UTC', at: '2026-10-01T00:00:00.000Z' };
    });
    expect(planSections(await readPlan(root)).needsYou.map((item) => item.id)).toEqual(['M1', 'Q1']);

    await expect(change({ type: 'accept', id: 'M1' }, claude)).rejects.toThrow(/Only the user/);
    const accepted = await change({ type: 'accept', id: 'M1' });
    expect(accepted.item).toMatchObject({ status: 'done', resolution: 'Tests pass on a1b2c3d' });
    expect(accepted.item).not.toHaveProperty('proposal');
    expect(accepted.item.history.map((entry) => `${entry.by}:${entry.action}`)).toEqual(['user:added', 'user:accepted', 'user:done']);

    await expect(change({ type: 'reject', id: 'Q1', reason: '' })).rejects.toMatchObject({ code: 'invalid' });
    const rejected = await change({ type: 'reject', id: 'Q1', reason: 'Use the account time zone' });
    expect(rejected.item.status).toBe('todo');
    expect(rejected.item).not.toHaveProperty('proposal');
    expect(rejected.message).toBe('Sent back to codex: Q1 Which time zone? Use the account time zone');
  });

  it('will not finish a milestone with a check unless the check passed', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'Gate', gate: { required: true, command: 'npm test' } });
    await expect(change({ type: 'done', id: 'M1', resolution: 'Looks fine' })).rejects.toThrow(/has a check/);
    expect((await change({ type: 'done', id: 'M1', resolution: 'Passed on abc', checkPassed: true })).item.status).toBe('done');
  });

  it('will not accept when nothing waits to be accepted', async () => {
    await change({ type: 'add', kind: 'task', title: 'Work' });
    await expect(change({ type: 'accept', id: 'T1' })).rejects.toThrow(/nothing waiting/);
  });
});

describe('reopening and editing', () => {
  it('reopens finished work with a reason and counts it', async () => {
    await change({ type: 'add', kind: 'task', title: 'Work' });
    await change({ type: 'done', id: 'T1', resolution: 'Done' });
    const { item } = await change({ type: 'reopen', id: 'T1', reason: 'Edge case' });
    expect(item).toMatchObject({ status: 'in_progress', reopenCount: 1, reopenReason: 'Edge case' });
    expect(item).not.toHaveProperty('resolution');
    await expect(change({ type: 'reopen', id: 'T1', reason: 'x' })).resolves.toBeDefined();
    await change({ type: 'add', kind: 'task', title: 'Fresh' });
    await expect(change({ type: 'reopen', id: 'T2', reason: 'x' })).rejects.toThrow(/nothing to reopen/);
  });

  it('puts a reopened question back on the list: it is answered, not worked on', async () => {
    await change({ type: 'add', kind: 'question', title: 'Which branch?', owner: 'user' });
    await change({ type: 'answer', id: 'Q1', answer: 'main' });
    const { item } = await change({ type: 'reopen', id: 'Q1', reason: 'Asked again' }, claude);
    expect(item).toMatchObject({ status: 'todo', reopenCount: 1 });
  });

  it('will not change what a finished item waits for until it is reopened', async () => {
    await change({ type: 'add', kind: 'task', title: 'Done work' });
    await change({ type: 'add', kind: 'task', title: 'Other' });
    await change({ type: 'done', id: 'T1', resolution: 'Done' });
    await expect(change({ type: 'edit', id: 'T1', after: ['T2'] })).rejects.toThrow(/Reopen it before/);
    await expect(change({ type: 'add', kind: 'task', title: 'New', before: ['T1'] })).rejects.toThrow(/Reopen it first/);
  });

  it('records edits in the history and says nothing changed when nothing did', async () => {
    await change({ type: 'add', kind: 'task', title: 'Work' });
    const renamed = await change({ type: 'edit', id: 'T1', title: 'Better work' }, claude);
    expect(renamed.message).toBe('Changed T1 Better work: renamed from "Work".');
    expect((await change({ type: 'edit', id: 'T1', title: 'Better work' })).message).toBe('Nothing to change on T1 Better work.');
  });

  it('reports an unknown code plainly', async () => {
    await expect(change({ type: 'start', id: 'M9' })).rejects.toMatchObject({ code: 'not_found', message: 'There is no item "M9" in the plan. Read the plan to see the codes.' });
  });

  it('resolves items flexibly by case-insensitive code, full label, code prefix, or exact title', async () => {
    await seedExample();
    const plan = await readPlan(root);

    // findItem direct checks
    expect(findItem(plan, 'm2')?.id).toBe('M2');
    expect(findItem(plan, 'M2 CSV export endpoint')?.id).toBe('M2');
    expect(findItem(plan, 'M2: CSV export endpoint')?.id).toBe('M2');
    expect(findItem(plan, 'CSV export endpoint')?.id).toBe('M2');
    expect(findItem(plan, 'Non-existent')).toBeUndefined();

    // changePlan with case-insensitive code
    const started = await change({ type: 'start', id: 't1' }, claude);
    expect(started.item.id).toBe('T1');
    expect(started.item.status).toBe('in_progress');

    // changePlan with code prefix / label
    const done = await change({ type: 'done', id: 'T1 Background job queue', resolution: 'Queue is ready' }, claude);
    expect(done.item.id).toBe('T1');
    expect(done.item.status).toBe('done');

    // adding new work with --before pointing to full label
    const added = await change({ type: 'add', kind: 'question', title: 'Export format?', before: ['M2 CSV export endpoint'] });
    expect(added.item.id).toBe('Q2');
    const updatedPlan = await readPlan(root);
    expect(updatedPlan.items.find((item) => item.id === 'M2')!.waitsFor).toContain('Q2');
    expect(heldUpBy(updatedPlan, 'Q2 Export format?').map((item) => item.id)).toEqual(['M2']);
  });
});

describe('the sections everyone sees', () => {
  it('puts proposals and the user\'s open questions under Needs you, and the rest where the Plan tab shows them', async () => {
    await seedExample();
    await change({ type: 'done', id: 'M1', resolution: 'Merged' });
    await change({ type: 'start', id: 'T1' }, claude);
    await change({ type: 'done', id: 'T1', resolution: 'Runs in the background' }, claude);
    await change({ type: 'add', kind: 'question', title: 'Include archived reports?' }, claude);
    await change({ type: 'add', kind: 'decision', title: 'Excel export' });
    await change({ type: 'later', id: 'D1', revisitWhen: 'After feedback' });
    const sections = planSections(await readPlan(root));
    expect(sections.needsYou.map((item) => item.id)).toEqual(['Q1']);
    expect(sections.milestones.map((item) => item.id)).toEqual(['M1', 'M2', 'M3']);
    expect(sections.otherOpen.map((item) => item.id)).toEqual(['Q2', 'D1']);
    expect(sections.closed.map((item) => item.id)).toEqual(['M1', 'T1']);
    // Questions are answered, not started: only milestones and tasks are ready to start.
    expect(sections.ready.map((item) => item.id)).toEqual([]);
    expect(sections.counts).toMatchObject({ needsYou: 1, todo: 4, done: 2, later: 1 });
    expect(sections.changes[0]).toMatchObject({ itemId: 'D1', label: 'D1 Excel export', action: 'later' });
  });
});

describe('what is current and next', () => {
  it('is the first milestone in progress, and the first that can start', async () => {
    await seedExample();
    await change({ type: 'add', kind: 'milestone', title: 'Docs' });
    await change({ type: 'start', id: 'M1' });
    // M2 waits for T1 and Q1, and M3 for M2, so Next is M4, which can start.
    expect(planFocus(await readPlan(root))).toMatchObject({ current: { id: 'M1' }, next: { id: 'M4' }, nextWaitsFor: [] });
  });

  it('names what Next waits for when nothing can start, instead of naming work that cannot', async () => {
    await seedExample();
    await change({ type: 'done', id: 'M1', resolution: 'Merged' });
    const focus = planFocus(await readPlan(root));
    expect(focus.current).toBeUndefined();
    expect(focus.next?.id).toBe('M2');
    expect(focus.nextWaitsFor.map((item) => item.id)).toEqual(['T1', 'Q1']);
  });

  it('keeps a milestone current until it is done, and has no Next when all is done', async () => {
    await change({ type: 'add', kind: 'milestone', title: 'Only' });
    await change({ type: 'start', id: 'M1' });
    expect(planFocus(await readPlan(root))).toEqual({ current: expect.objectContaining({ id: 'M1' }), nextWaitsFor: [] });
    await change({ type: 'done', id: 'M1', resolution: 'Shipped' });
    expect(planFocus(await readPlan(root))).toEqual({ nextWaitsFor: [] });
  });
});

describe('applyPlanChange', () => {
  it('applies rules in memory, without a disk', () => {
    const plan: PlanDocument = emptyPlan();
    applyPlanChange(plan, { type: 'add', kind: 'milestone', title: 'In memory' }, user, '2026-10-10T00:00:00.000Z');
    expect(plan.items[0]).toMatchObject({ id: 'M1', status: 'todo', createdAt: '2026-10-10T00:00:00.000Z', owner: 'user' });
  });

  it('mutatePlan writes nothing when nothing changed', async () => {
    await change({ type: 'add', kind: 'task', title: 'Work' });
    const { changed, plan } = await mutatePlan(root, () => undefined);
    expect(changed).toBe(false);
    expect(plan.revision).toBe(1);
  });
});
