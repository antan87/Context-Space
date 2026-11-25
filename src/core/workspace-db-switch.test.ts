import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verify = vi.hoisted(() => ({ during: undefined as undefined | (() => Promise<void>) }));
vi.mock('./verify.js', () => ({
  verifyWorkspace: async () => {
    await verify.during?.();
    return { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def5678' }] };
  },
}));

import { getStorageProvider, setActiveStorageProvider } from './adapters/registry.js';
import { BoardConflictError, changeBoard, readBoard } from './board.js';
import { defaultDeps, findOlderWriters } from './older-writers.js';
import { PlanFileError, parsePlanFile, planItems, setDone } from './plan-file.js';
import { changePlanFile, clearPlanNow, movePlanToFile, readPlanFile, runPlanCheck, setPlanNow } from './plan-file-store.js';
import { migrateWorkspace, restoreWorkspace } from './plan-migrate.js';
import { markSeen, NewsChangedError, whatsNew } from './whats-new.js';
import { SWITCH_FILE, WorkspaceMovedError, readSwitch } from './workspace-db-switch.js';
import { closeAppDb, readAppDb } from './workspace-db-app.js';
import * as appDb from './workspace-db-app.js';
import * as locks from './locks.js';
import * as attention from './attention.js';
import { askUser } from './ask-user.js';
import { registerBoardRoutes } from '../http/board-routes.js';
import { registerPlanFileRoutes } from '../http/plan-file-routes.js';
import { registerNewsRoutes } from '../http/news-routes.js';
import { findTool, type ToolContext } from '../mcp/tools.js';
import { planAdd, planAnswer, planCheck, planDone, planLog, planMigrate, planNow, planRestore, planShow, registerPlanCommand } from '../commands/plan.js';
import { boardDbForApp, changeBoardDb, readBoardDb } from './board-db-app.js';
import { newsCommand } from '../commands/news.js';
import { buildContextContent } from '../generators/base.js';
import { loadFeatureConfig } from './workspace.js';
import { advanceLifecycleStep, readWorkspaceLifecycle } from './lifecycle.js';
import { answerChatQuestionsInPlan } from './plan-questions.js';
import { planDbParts, readPlanDb } from './plan-db-app.js';
import { changePlan } from './plan.js';
import { generateContextFiles } from '../generators/index.js';
import { dbFilePath, ID_PATTERN, listBlocks, WorkspaceDbError } from './workspace-db/index.js';
import { dbPollToken } from './screen-events.js';
import { renderPlanFileInstructions } from './plan-file-text.js';
import { askCommand } from '../commands/ask.js';
import { noteAddCommand } from '../commands/note.js';
import * as commitNotes from './commit-notes.js';
import { reconcileWorkspaceResources } from '../resources/materializer.js';
import { saveWorkspaceSkillsConfig } from '../utils/skills-catalog.js';
import type { NexusFlowConfig } from '../types.js';

const PLAN = `# CSV export

## Checkpoints

- [ ] Reports export to CSV
  Check: \`npm test\`
  - [x] Write the CSV writer
  - [ ] Add the Export button
  - [ ] Decide: Include headers?
`;
const AT = '2026-11-01T10:00:00.000Z';
const readAppDbOriginal = readAppDb;
const OLD_STRATEGY = `# Team Strategy: Plan, Implement, Review

1. Read the current assignment, the plan (\`PLAN.md\`) and relevant approved
   sources. Resolve important unknowns and write observable acceptance criteria in
   the existing plan, editing \`PLAN.md\` directly. Do not create a second plan.`;

let root: string;
let archive: string;

const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};

async function treeHash(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full); else out[path.relative(root, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(root);
  return out;
}

const MOVED = /^This workspace was moved to the workspace database\. Undo it with `ctxspace plan restore \.contextspace\/archive\/pre-db-[^`]+`\.$/;

/** Runs `act`, which must be refused with the moved sentence, and checks that no file anywhere in the workspace changed. */
async function refusedAndUnchanged(act: () => Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> {
  const before = await treeHash();
  const error = await act().then(() => null, (e: unknown) => e);
  expect(error, 'the writer was not refused').toBeInstanceOf(type);
  expect((error as Error).message).toMatch(MOVED);
  expect(await treeHash()).toEqual(before);
}

beforeEach(async () => {
  setActiveStorageProvider(getStorageProvider('local'));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'switch-ws-')));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'csv', name: 'CSV export', branchName: 'feat/csv', description: 'CSV', repos: [], assistants: [], workspacePath: root, teamworkInstructions: OLD_STRATEGY }));
  await write('PLAN.md', PLAN);
  await write('contextspace-board.json', JSON.stringify({ version: 1, revision: 1, cards: [], links: [], positions: {} }));
  await write('.contextspace/plan-now.json', JSON.stringify({ key: 'add-the-export-button', by: 'claude', at: AT }));
  await write('.contextspace/seen.json', JSON.stringify({ version: 1, readers: { claude: { at: AT, repos: {}, knowledge: [], documents: [] } }, pending: {} }));
  await write('.contextspace/state.json', JSON.stringify({ workspacePath: root, repos: {}, updatedAt: AT, planChecks: {} }));
  const result = await migrateWorkspace(root, { by: 'user', backup: false, findOlderWriters: (r) => findOlderWriters(r, { ...defaultDeps, processes: async () => [] }) });
  archive = result.archive;
  expect(readSwitch(root)?.state).toBe('on');
  verify.during = undefined;
});
afterEach(async () => {
  await closeAppDb(); // the app's connections, and the backup a write scheduled, end before the folder goes
  await fs.rm(root, { recursive: true, force: true });
});

describe('with the switch on, every old writer refuses and writes nothing', () => {
  it('the plan store: a change to PLAN.md', async () => {
    await refusedAndUnchanged(() => changePlanFile(root, (text) => setDone(text, 'add-the-export-button', true, 'Add the Export button'), { by: 'user' }), PlanFileError);
  });

  it('the plan store: Now, set and cleared', async () => {
    await refusedAndUnchanged(() => setPlanNow(root, 'add-the-export-button', 'claude'), PlanFileError);
    await refusedAndUnchanged(() => clearPlanNow(root), PlanFileError);
  });

  it('the Board: a change, and a read (no empty board that would look like lost cards)', async () => {
    await refusedAndUnchanged(() => changeBoard(root, [{ op: 'add_card', kind: 'note', title: 'New' }], { by: 'user' }), BoardConflictError);
    await refusedAndUnchanged(() => readBoard(root), BoardConflictError);
  });

  it('seen: marking a report seen; a news report is still made but records nothing, and says why', async () => {
    await refusedAndUnchanged(() => markSeen(root, 'claude', AT), WorkspaceMovedError);
    const before = await treeHash();
    const news = await whatsNew(root, 'claude', { mark: true, now: new Date('2026-11-20T10:00:00.000Z') });
    expect(news.problems.join('\n')).toMatch(/moved to the workspace database[\s\S]*not recorded as seen/);
    const pending = await whatsNew(root, 'user', { pending: true });
    expect(pending.problems.join('\n')).toMatch(/not recorded as seen/);
    expect(await treeHash()).toEqual(before);
  });

  it('the plan checks in state.json: refused before a check runs, and again under the state lock when the move lands during the check', async () => {
    let ran = false;
    verify.during = async () => { ran = true; };
    await refusedAndUnchanged(() => runPlanCheck(root, 'reports-export-to-csv'), PlanFileError);
    expect(ran).toBe(false); // refused before the check ran, not only after
    // the switch goes on while the check runs: its result must not land in state.json
    const result = await restoreWorkspace(root, archive, { by: 'user' });
    expect(result.putBack).toContain('PLAN.md');
    const stateBefore = await fs.readFile(path.join(root, '.contextspace', 'state.json'), 'utf8');
    verify.during = async () => { await fs.writeFile(path.join(root, SWITCH_FILE), JSON.stringify({ state: 'on', archive })); };
    await expect(runPlanCheck(root, 'reports-export-to-csv')).rejects.toThrow(MOVED);
    expect(await fs.readFile(path.join(root, '.contextspace', 'state.json'), 'utf8')).toBe(stateBefore);
  });

  it('an HTTP write route (DB3b): with the move finished the Board, the plan and seen write the database and no old file; mid-move they answer 409 with the sentence', async () => {
    const app = new Hono();
    registerBoardRoutes(app, async () => root);
    registerPlanFileRoutes(app, async () => root);
    registerNewsRoutes(app, async () => root);
    const call = async (url: string, body?: unknown) => {
      const response = await app.request(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { error: string } & Record<string, any> };
    };
    // the old files the move archived, and the copied state file
    const OLD = ['contextspace-board.json', '.contextspace/board-changes.jsonl', '.contextspace/plan-changes.jsonl', '.contextspace/plan-now.json', '.contextspace/plan-seen.json', '.contextspace/seen.json', 'contextspace-plan.json'];
    const oldState = async () => Object.fromEntries(await Promise.all([...OLD, '.contextspace/state.json'].map(async (rel) => [rel, await fs.readFile(path.join(root, rel), 'utf8').catch(() => null)])));
    const before = await oldState();

    // mid-move or mid-restore: refused, nothing written
    const record = readSwitch(root)!;
    await fs.writeFile(path.join(root, SWITCH_FILE), JSON.stringify({ ...record, state: 'restoring' }));
    const midTree = await treeHash();
    const refused = await call('/api/workspace/csv/board/changes', { changes: [{ op: 'add_card', kind: 'note', title: 'New' }] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/being restored/);
    expect((await call('/api/workspace/csv/plan')).status).toBe(409);
    expect(await treeHash()).toEqual(midTree);
    await fs.writeFile(path.join(root, SWITCH_FILE), JSON.stringify(record));

    const board = await call('/api/workspace/csv/board/changes', { changes: [{ op: 'add_card', kind: 'note', title: 'New' }] });
    expect(board.status).toBe(200);
    expect(board.body.cards.map((c: { title: string }) => c.title)).toContain('New');
    const plan = (await call('/api/workspace/csv/plan')).body;
    const step = plan.checkpoints[0].steps.find((s: { text: string }) => s.text === 'Add the Export button');
    const tick = await call(`/api/workspace/csv/plan/steps/${step.key}/tick`, { done: true, expected: 'Add the Export button', rev: step.rev, dbId: plan.dbId });
    expect(tick.status).toBe(200);
    const news = await call('/api/workspace/csv/news?reader=user');
    const seen = await call('/api/workspace/csv/news/seen', { reader: 'user', at: news.body.at });
    expect(seen.status).toBe(200);
    expect(await oldState()).toEqual(before);
  });

  it('a switch file that cannot be read still counts as on', async () => {
    await fs.writeFile(path.join(root, SWITCH_FILE), '{ not json');
    const before = await treeHash();
    await expect(changePlanFile(root, (text) => `${text}x\n`, { by: 'user' })).rejects.toThrow(/cannot be read\)\. Nothing was written/);
    await expect(changeBoard(root, [{ op: 'add_card', kind: 'note', title: 'New' }], { by: 'user' })).rejects.toThrow(/cannot be read/);
    expect(await treeHash()).toEqual(before);
  });
});

describe('moved CLI and MCP entry points', () => {
  const config: NexusFlowConfig = { version: '1.0', devDir: '/dev', workspacesDir: '/dev/workspaces', defaultAssistant: null, scanDepth: 2 };
  const call = (name: string, args: Record<string, unknown> = {}) => findTool(name)!.handler(args, { config, workspacePath: root } satisfies ToolContext);
  const json = async (name: string, args?: Record<string, unknown>) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text);
  };
  const context = (print: (text: string) => void = () => undefined) => ({ workspacePath: root, by: 'codex', json: true, print });

  const routes = () => {
    const app = new Hono();
    registerBoardRoutes(app, async () => root);
    registerPlanFileRoutes(app, async () => root);
    return (url: string, body: unknown) => app.request('/api/workspace/csv' + url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  };

  it.each(['answer', 'untick'])('requires an observed revision to %s an answered decision', async (op) => {
    const { read } = await planDbParts(root);
    const id = read.plan.checkpoints[0]!.decisions[0]!.key;
    await json('change_plan', { ops: [{ op: 'answer', id, text: 'Monday' }] });
    const change = { op, id, ...(op === 'answer' ? { text: 'Friday' } : {}) };
    const refused = await call('change_plan', { ops: [change] });
    expect(JSON.parse(refused.content[0]!.text)).toMatchObject({ ok: false, errors: [{
      code: 'rev_required', currentRev: read.revs.get(id)! + 1, message: expect.stringContaining('Monday'),
    }] });
    expect(refused.content[0]!.text).toContain(`ctxspace plan ${id}`);
    const current = (await planDbParts(root)).read;
    expect(current.plan.checkpoints[0]!.decisions[0]!.answer).toBe('Monday');
    const guard = op === 'answer' ? { rev: current.revs.get(id) } : {};
    await json('change_plan', {
      dbId: current.dbId, ...(op === 'untick' ? { ifRevision: current.revision } : {}), ops: [{ ...change, ...guard }],
    });
    expect((await planDbParts(root)).read.plan.checkpoints[0]!.decisions[0]!.answer).toBe(op === 'answer' ? 'Friday' : undefined);
  });

  it.each(['board_remove_card', 'change_plan'])('requires a revision that covers newly added links for %s', async (tool) => {
    const { card, dbId } = await json('board_add_card', { kind: 'note', title: 'Keep this card' });
    const before = await boardDbForApp(root);
    const cp = (await planDbParts(root)).read.plan.checkpoints[0]!;
    await json('board_link', { from: card.id, to: `checkpoint:${cp.key}`, label: 'New dependency' });
    const remove = (revision?: number) => call(tool, tool === 'board_remove_card'
      ? { id: card.id, rev: card.rev, dbId, revision }
      : { dbId, ifRevision: revision, ops: [{ op: 'card.remove', id: card.id, rev: card.rev }] });
    const missing = await remove();
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/current|now at/);
    const stale = await remove(before.revision);
    expect(stale.isError).toBe(true);
    const current = await boardDbForApp(root);
    expect(current.cards).toContainEqual(card);
    expect(current.links).toMatchObject([{ from: card.id, label: 'New dependency' }]);
    expect((await remove(current.revision)).isError).not.toBe(true);
    expect((await boardDbForApp(root)).links).toEqual([]);
  });

  it('returns the IDs used by repeated adds, and explains safe retries in the CLI and MCP', async () => {
    const input = { kind: 'note', title: 'Identical cards' };
    const first = await json('board_add_card', input);
    const second = await json('board_add_card', input);
    expect(second.card.id).not.toBe(first.card.id);
    expect(first.requestId).toEqual(expect.any(String));
    expect(second.requestId).not.toBe(first.requestId);
    expect(await json('board_add_card', { ...input, requestId: first.requestId })).toMatchObject({ card: first.card, requestId: first.requestId });
    expect((await boardDbForApp(root)).cards).toHaveLength(2);

    const batch = { ops: [{ op: 'card.add', ...input }] };
    const program = new Command().exitOverride().configureOutput({ writeOut: () => undefined });
    registerPlanCommand(program, (error) => { throw error; });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await program.parseAsync(['node', 'ctxspace', 'plan', 'apply', JSON.stringify(batch), '-w', root, '--json']);
      const saved = JSON.parse(out.mock.calls.at(-1)![0]);
      expect(saved).toMatchObject({ ok: true, requestId: expect.any(String) });
      expect(await json('change_plan', { ...batch, requestId: saved.requestId })).toMatchObject({ requestId: saved.requestId, replayed: true });
      expect((await json('change_plan', { ops: [{ op: 'add', kind: 'step', text: 'Batch step', under: (await planDbParts(root)).read.plan.checkpoints[0]!.key }] }))).toHaveProperty('requestId');
    } finally { out.mockRestore(); }
    expect(program.commands[0]!.commands.find((cmd) => cmd.name() === 'apply')!.description()).toMatch(/pass.*requestId/i);
    for (const name of ['board_add_card', 'change_plan']) expect(findTool(name)!.description).toMatch(/pass.*requestId/i);
  });

  it('explains when the receipt for an unchanged retry belongs to a restored database', async () => {
    const input = { kind: 'note', title: 'Already saved', requestId: 'restored-receipt' };
    const { dbId } = await json('board_add_card', input);
    const replacement = new DatabaseSync(dbFilePath(root));
    try {
      replacement.prepare("UPDATE meta SET value = ? WHERE key = 'db_id'").run('another-generation');
      replacement.prepare("INSERT INTO meta (key, value) VALUES ('former_db_ids', ?)").run(JSON.stringify([dbId]));
    } finally { replacement.close(); }
    const result = await call('board_add_card', input);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/database was restored/i);
    expect((await boardDbForApp(root)).cards).toHaveLength(1);
  });

  it('answers a committed Add step while plan reads are busy and replays the submission', async () => {
    const post = routes();
    const dbId = (await planDbParts(root)).read.dbId;
    const add = { requestId: 'app-step', store: 'database', dbId, change: { type: 'add', step: 'One added step' } };
    const read = vi.spyOn(appDb, 'readAppDb').mockImplementation((dir, query) => {
      if (query === readPlanDb) return readAppDbOriginal(dir, query);
      return readAppDbOriginal(dir, (view) => {
        const answer = query(view);
        if (answer && typeof answer === 'object' && 'store' in answer && answer.store === 'database') {
          throw new WorkspaceDbError('busy', 'Busy, try again.');
        }
        return answer;
      });
    });
    try {
      const noId = await post('/plan', { change: { type: 'add', step: 'ID generated by the server' } });
      expect(noId.status).toBe(200);
      expect(await noId.json()).toHaveProperty('requestId', expect.any(String));
      expect((await post('/plan', { requestId: add.requestId, change: add.change })).status).toBe(409);
      const first = await post('/plan', add);
      const retry = await post('/plan', add);
      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(await first.json()).toMatchObject({ requestId: add.requestId, plan: { steps: expect.arrayContaining([expect.objectContaining({ text: 'One added step' })]) } });
      expect(await retry.json()).toMatchObject({ requestId: add.requestId, plan: { steps: expect.arrayContaining([expect.objectContaining({ text: 'One added step' })]) } });
      expect((await post('/plan', { ...add, change: { ...add.change, step: 'Different step' } })).status).toBe(400);
    } finally { read.mockRestore(); }
    expect((await planDbParts(root)).read.plan.steps.map((step) => step.text)).toEqual(['ID generated by the server', 'One added step']);
  });

  it.each(['file', 'database'])('round 3 refuses an Add step retry from the %s store after cutover', async (store) => {
    const post = routes();
    if (store === 'file') await restoreWorkspace(root, archive, { by: 'user' });
    const step = 'One step before cutover';
    const add = {
      requestId: 'cutover-step', store, change: { type: 'add', step },
      ...(store === 'database' ? { dbId: (await planDbParts(root)).read.dbId } : {}),
    };
    expect((await post('/plan', add)).status).toBe(200);
    if (store === 'file') await migrateWorkspace(root, { backup: false, by: 'user', findOlderWriters: async () => [] });
    else {
      // This simulates stopping the app before running the separate restore command.
      await closeAppDb(root);
      await restoreWorkspace(root, archive, { by: 'user' });
    }
    const before = await treeHash();
    const retry = await post('/plan', add);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: expect.stringMatching(/plan.*moved|plan.*restored/i) });
    expect(await treeHash()).toEqual(before);
    if (store === 'file') expect((await planDbParts(root)).read.plan.steps.filter((s) => s.text === step)).toHaveLength(1);
    else expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toBe(PLAN);
  });

  it('round 3 refuses an Add step from an earlier database generation', async () => {
    const { dbId } = (await planDbParts(root)).read;
    const post = routes();
    const replacement = new DatabaseSync(dbFilePath(root));
    try { replacement.prepare("UPDATE meta SET value = ? WHERE key = 'db_id'").run('replacement'); }
    finally { replacement.close(); }
    const retry = await post('/plan', { requestId: 'old-generation', store: 'database', dbId, change: { type: 'add', step: 'Do not add' } });
    expect(retry.status).toBe(409);
    expect((await planDbParts(root)).read.plan.steps).toEqual([]);
  });

  it.each([false, true])('round 3 refuses implicit ask, note and plan writes from a copy (nested: %s)', async (nested) => {
    const copy = await fs.mkdtemp(path.join(nested ? root : os.tmpdir(), 'switch-copy-'));
    const cwd = path.join(copy, 'repo');
    await fs.mkdir(cwd);
    await fs.copyFile(path.join(root, 'contextspace.json'), path.join(copy, 'contextspace.json'));
    const before = await treeHash();
    const chdir = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const note = vi.spyOn(commitNotes, 'addCommitNote').mockRejectedValue(new Error('Reached the note writer'));
    const exitCode = process.exitCode;
    const plan = (workspace: string[] = []) => {
      const program = new Command().exitOverride();
      registerPlanCommand(program, (error) => { throw error; });
      return program.parseAsync(['node', 'ctxspace', 'plan', 'add', 'From a copy', ...workspace]);
    };
    try {
      const ask = await askCommand('From a copy?', {}).catch((e: Error) => e.message);
      await noteAddCommand('HEAD', 'From a copy');
      const add = await plan().catch((e: Error) => e.message);
      expect({ ask, note: error.mock.lastCall?.[0], add, writes: note.mock.calls.length, tree: await treeHash() }).toEqual({
        ask: expect.stringContaining('this folder may be a copy'), note: expect.stringContaining('this folder may be a copy'),
        add: expect.stringContaining('this folder may be a copy'), writes: 0, tree: before,
      });
      expect(await fs.readdir(copy)).toEqual(['contextspace.json', 'repo']);

      await plan(['-w', root]);
      await askCommand('Explicit question?', { workspace: root });
      await noteAddCommand('HEAD', 'Explicit note', { workspace: root });
      expect(note).toHaveBeenCalledWith(root, expect.objectContaining({ text: 'Explicit note' }));
      const { read } = await planDbParts(root);
      expect(read.plan.steps.map((step) => step.text)).toContain('From a copy');
      expect([...read.plan.decisions, ...read.plan.checkpoints.flatMap((cp) => cp.decisions)].map((d) => d.question)).toContain('Explicit question?');
    } finally {
      process.exitCode = exitCode;
      chdir.mockRestore(); log.mockRestore(); error.mockRestore(); note.mockRestore();
      await fs.rm(copy, { recursive: true, force: true });
    }
  });

  it.each([false, true])('round 3 requires a workspace revision and lists checkpoint removal effects (cascade: %s)', async (cascade) => {
    const { newIds: [id] } = await json('change_plan', { ops: [{ op: 'add', kind: 'checkpoint', text: 'Leaf to remove' }] });
    const before = (await planDbParts(root)).read;
    const area = `checkpoint:${id}`;
    const { card } = await json('board_add_card', { kind: 'note', title: 'Keep this note', area });
    await json('board_link', { from: card.id, to: area, label: 'New dependency' });
    await json('change_plan', { ops: [{ op: 'place', node: area, x: 10, y: 20 }] });
    const board = await boardDbForApp(root);
    const link = board.links[0]!;
    const ops = [{ op: 'remove', id, rev: before.revs.get(id), ...(cascade ? { cascade: true } : {}) }];
    const remove = (ifRevision?: number) => ({ ops, dbId: before.dbId, ifRevision });
    const refused = await call('change_plan', remove());
    expect(JSON.parse(refused.content[0]!.text)).toMatchObject({ ok: false, errors: [{ code: 'missing_revision' }] });
    const stale = await call('change_plan', remove(before.revision));
    expect(JSON.parse(stale.content[0]!.text)).toMatchObject({ ok: false, errors: [{ code: 'stale_revision' }] });
    expect(await boardDbForApp(root)).toEqual(board);
    const saved = await json('change_plan', remove(board.revision));
    expect(saved.changed).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`remove ${id}`)),
      expect.stringMatching(new RegExp(`${card.id}.*plan:own`)),
      expect.stringMatching(new RegExp(`remove.*link.*${link.id}`)),
      expect.stringMatching(new RegExp(`remove.*position.*${area}`)),
    ]));
    const after = await boardDbForApp(root);
    expect(after.cards[0]).toMatchObject({ id: card.id, area: 'plan:own' });
    expect(after.links).toEqual([]);
    expect(after.positions).not.toHaveProperty(area);
  });

  it('round 3 refreshes both managed lifecycle skill copies on migrate and restore and reports a conflict', async () => {
    await restoreWorkspace(root, archive, { by: 'user' });
    await fs.rm(path.join(root, 'PLAN.md'));
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'From the old plan' }, { actor: { by: 'user' } });
    const plan = path.join(root, 'contextspace-plan.json');
    const bytes = await fs.readFile(plan);
    const id = 'nexusflow-lifecycle';
    const skill = 'SKILL.md';
    const reference = 'references/epic-deliverables.md';
    const oldSource = path.join(root, 'old-skill');
    await write(`old-skill/${skill}`, `---\nname: ${id}\ndescription: Old lifecycle\n---\nEdit PLAN.md directly.\n`);
    await write(`old-skill/${reference}`, 'Write each checkpoint in PLAN.md.\n');
    await saveWorkspaceSkillsConfig(root, { enabledSkills: [id] });
    const installOld = () => reconcileWorkspaceResources(root, [], [{ id, name: id, title: 'Lifecycle', category: 'workflows', description: 'Old lifecycle', content: '', custom: false, sourcePath: oldSource }], []);
    const output: string[] = [];
    const cli = context((line) => output.push(line));
    const move = () => planMigrate(cli, {}, { backup: false, findOlderWriters: async () => [] });
    const checkCopies = async () => {
      for (const folder of ['.agents', '.claude']) {
        for (const file of [skill, reference]) {
          expect(await fs.readFile(path.join(root, folder, 'skills', id, file), 'utf8')).toContain('ctxspace plan apply');
        }
      }
    };
    await installOld();
    await move();
    expect(JSON.parse(output.at(-1)!)).not.toHaveProperty('instructionsProblem');
    await checkCopies();

    await installOld();
    await planRestore(cli, JSON.parse(output.at(-1)!).archive);
    await checkCopies();
    await expect(fs.readFile(plan)).resolves.toEqual(bytes);
    await expect(fs.access(path.join(root, 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    const modified = path.join(root, '.agents/skills', id, reference);
    await fs.appendFile(modified, '\nMy edits.');
    await move();
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ ok: true, instructionsProblem: expect.stringContaining('was modified') });
    expect(readSwitch(root)?.state).toBe('on');
    await planRestore(cli, JSON.parse(output.at(-1)!).archive);
    expect(JSON.parse(output.at(-1)!).notes).toContainEqual(expect.stringContaining('was modified'));
    expect(readSwitch(root)).toBeNull();
    await expect(fs.readFile(plan)).resolves.toEqual(bytes);
    expect(await fs.readFile(modified, 'utf8')).toContain('My edits.');
  });

  it('round 3 replays a CLI add after its checkpoint is renamed', async () => {
    const out: string[] = [];
    const cli = context((line) => out.push(line));
    const { read } = await planDbParts(root);
    const cp = read.plan.checkpoints[0]!;
    const add = (step = 'One shortcut step') => planAdd(cli, { step }, cp.title, 'shortcut-replay');
    await add();
    const live = (await planDbParts(root)).read;
    await json('change_plan', { dbId: live.dbId, ops: [{ op: 'reword', id: cp.key, rev: live.revs.get(cp.key), text: 'Renamed checkpoint' }] });
    await add();
    expect(JSON.parse(out[1]!)).toMatchObject({ key: JSON.parse(out[0]!).key, requestId: 'shortcut-replay' });
    await expect(add('Different step')).rejects.toThrow(/used with a different batch/);
    expect((await planDbParts(root)).read.plan.checkpoints[0]!.steps.filter((s) => s.text === 'One shortcut step')).toHaveLength(1);
  });

  it('refuses CLI shortcuts from a copy whose manifest points to the original', async () => {
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-copy-'));
    const before = await treeHash();
    const chdir = vi.spyOn(process, 'cwd').mockReturnValue(copy);
    const fail = vi.fn();
    try {
      await fs.copyFile(path.join(root, 'contextspace.json'), path.join(copy, 'contextspace.json'));
      const program = new Command().exitOverride();
      registerPlanCommand(program, fail);
      await program.parseAsync(['node', 'ctxspace', 'plan', 'add', 'Wrong workspace']);
      expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('this folder may be a copy') }));
      expect(await treeHash()).toEqual(before);
    } finally {
      chdir.mockRestore();
      await fs.rm(copy, { recursive: true, force: true });
    }
  });

  it('regenerates instructions without migrating a restored legacy plan', async () => {
    await restoreWorkspace(root, archive, { by: 'user' });
    await fs.rm(path.join(root, 'PLAN.md'));
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'From the old plan' }, { actor: { by: 'user' } });
    const file = path.join(root, 'contextspace-plan.json');
    const bytes = await fs.readFile(file);
    const moved = await migrateWorkspace(root, { backup: false, by: 'user', findOlderWriters: async () => [] });
    const output: string[] = [];
    await planRestore(context((line) => output.push(line)), moved.archive);
    expect(JSON.parse(output[0]!).putBack).toContain('contextspace-plan.json');
    await expect(fs.readFile(file)).resolves.toEqual(bytes);
    await expect(fs.access(path.join(root, 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain(renderPlanFileInstructions());
  });

  it.each([OLD_STRATEGY, '# Team Strategy: Epic & Multi-PR Slices\n\n2. In `PLAN.md`, write each outcome as a checkpoint with its acceptance criteria, a'])(
    'renders moved instructions in the output folder for the saved %s',
    async (strategy) => {
      const feature = { ...(await loadFeatureConfig(root))!, workspacePath: path.join(root, 'file-workspace'), teamworkInstructions: strategy };
      const inPlace = await buildContextContent({ feature: { ...feature, workspacePath: root }, repos: [] });
      expect(inPlace.split('## How to work together')[1]).toContain('ctxspace plan apply');
      await generateContextFiles({ feature, repos: [], analysis: new Map() }, [], root, { commitArtifacts: false, quiet: true });
      const content = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
      expect(content).toContain(renderPlanFileInstructions(true));
      expect(content).not.toMatch(/editing `PLAN.md` directly|In `PLAN.md`, write each outcome/);
      expect(content.split('## How to work together')[1]).toContain('ctxspace plan apply');
    },
  );

  it('reports a detected draft through MCP without applying its text', async () => {
    const source = await fs.readFile(path.join(root, 'PLAN.md'), 'utf8');
    await write('PLAN.md', source.replace('Add the Export button', 'Add the draft text'));
    await dbPollToken(root);
    expect(await json('read_plan')).toMatchObject({ pendingDrafts: 1, notice: expect.stringContaining('Plan drafts are pending') });
    expect((await planDbParts(root)).read.plan.checkpoints[0]!.steps.some((step) => step.text === 'Add the Export button')).toBe(true);
  });

  it('bounds three queued MCP adds from submission while the plan lock is held', async () => {
    const release = await locks.acquireLock(path.join(root, '.contextspace', 'plan-file.lock'), {
      staleMs: 60_000, timeoutMs: 100, timeoutMessage: 'Lock already held',
    });
    const start = performance.now();
    try {
      const results = await Promise.all(['A', 'B', 'C'].map(async (title) => ({
        result: await call('board_add_card', { kind: 'note', title }),
        elapsed: performance.now() - start,
      })));
      for (const { result, elapsed } of results) {
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toMatch(/Busy, try again/i);
        expect(elapsed, JSON.stringify(results)).toBeGreaterThan(1500);
        expect(elapsed, JSON.stringify(results)).toBeLessThan(3000);
      }
    } finally { await release(); }
    expect((await boardDbForApp(root)).cards).toEqual([]);
  });

  it('refuses a stale decision answer and returns the answer that was saved meanwhile', async () => {
    const { read } = await planDbParts(root);
    const decision = read.plan.checkpoints[0]!.decisions[0]!;
    const rev = read.revs.get(decision.key);
    await json('change_plan', { dbId: read.dbId, ops: [{ op: 'answer', id: decision.key, rev, text: 'Monday' }] });
    const post = routes();
    const answer = await post(`/plan/decisions/${decision.key}/answer`, {
      answer: 'Friday', expected: decision.question, rev, dbId: read.dbId,
    });
    const current = (await planDbParts(root)).read.plan.checkpoints[0]!.decisions[0]!;
    expect({ status: answer.status, saved: current.answer }).toEqual({ status: 409, saved: 'Monday' });
    expect(await answer.json()).toMatchObject({ code: 'rev_conflict', current: { answer: 'Monday', rev: rev! + 1 } });
    const missing = await post(`/plan/decisions/${decision.key}/answer`, { answer: 'Friday', expected: decision.question });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ current: { answer: 'Monday' } });
  });

  it('accepts a first HTTP answer without a rev and requires a rev to replace it', async () => {
    const { read } = await planDbParts(root);
    const decision = read.plan.checkpoints[0]!.decisions[0]!;
    const post = routes();
    const url = `/plan/decisions/${decision.key}/answer`;
    expect((await post(url, { answer: 'Monday', expected: decision.question })).status).toBe(200);
    const reply = await post(url, { answer: 'Friday', expected: decision.question });
    expect(reply.status).toBe(409);
    expect(await reply.json()).toMatchObject({ current: { answer: 'Monday' } });
  });

  it('returns a committed Board add without a second Board read and replays the same request', async () => {
    const post = routes();
    const add = { requestId: 'app-add', changes: [{ op: 'add_card', kind: 'note', title: 'One card' }] };
    const read = vi.spyOn(appDb, 'readAppDb').mockImplementation((dir, query) => {
      if (query === readBoardDb) return Promise.reject(new WorkspaceDbError('busy', 'Busy, try again. Nothing was changed.'));
      return readAppDbOriginal(dir, query);
    });
    let first: Response;
    let replay: Response;
    try {
      first = await post('/board/changes', add);
      replay = await post('/board/changes', add);
    } finally { read.mockRestore(); }
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect((await boardDbForApp(root)).cards.map((card) => card.title)).toEqual(['One card']);
  });

  it('replays an MCP Board add after its default step changes', async () => {
    const input = { requestId: 'mcp-add', kind: 'note', title: 'One card' };
    const first = await json('board_add_card', input);
    await planDone(context(), 'Add the Export button');
    const retry = await json('board_add_card', input);
    expect(retry.card).toEqual(first.card);
    expect((await boardDbForApp(root)).cards).toHaveLength(1);
    expect((await call('board_add_card', { ...input, title: 'Another card' })).isError).toBe(true);
  });

  it('protects descendants of a cascade and requires the observed rev for replacing card content', async () => {
    const { read } = await planDbParts(root);
    const cp = read.plan.checkpoints[0]!;
    const child = cp.decisions[0]!;
    await json('change_plan', { dbId: read.dbId, ops: [{ op: 'answer', id: child.key, rev: read.revs.get(child.key), text: 'Keep me' }] });
    const remove = { op: 'remove', id: cp.key, rev: read.revs.get(cp.key), cascade: true };
    const noRevision = await call('change_plan', { dbId: read.dbId, ops: [remove] });
    expect(JSON.parse(noRevision.content[0]!.text)).toMatchObject({ ok: false, errors: [{ code: 'missing_revision' }] });
    const stale = await call('change_plan', { dbId: read.dbId, ifRevision: read.revision, ops: [remove] });
    expect(JSON.parse(stale.content[0]!.text)).toMatchObject({ ok: false, errors: [{ code: 'stale_revision' }] });
    expect((await planDbParts(root)).read.plan.checkpoints[0]!.decisions[0]!.answer).toBe('Keep me');
    const { card } = await json('board_add_card', { kind: 'note', title: 'Draft', body: 'My new text' });
    const before = await boardDbForApp(root);
    const unversioned = await call('change_plan', { dbId: read.dbId, ops: [{ op: 'card.update', id: card.id, body: 'Older text' }] });
    expect(JSON.parse(unversioned.content[0]!.text)).toMatchObject({ ok: false, errors: [{ code: 'rev_required', message: expect.stringContaining('My new text') }] });
    const boardUpdate = await call('board_update_card', { id: card.id, body: 'Older text', dbId: read.dbId });
    expect(boardUpdate.isError).toBe(true);
    expect(boardUpdate.content[0]!.text).toContain('My new text');
    expect(await boardDbForApp(root)).toEqual(before);
  });

  it('requires the observed database generation with workspace or row revisions', async () => {
    const { card } = await json('board_add_card', { kind: 'note', title: 'New generation', body: 'Keep me' });
    const board = await boardDbForApp(root);
    const replacement = new DatabaseSync(dbFilePath(root));
    try { replacement.prepare("UPDATE meta SET value = ? WHERE key = 'db_id'").run('another-generation'); }
    finally { replacement.close(); }
    for (const input of [
      { ifRevision: board.revision, ops: [{ op: 'now', id: null }] },
      { ops: [{ op: 'card.update', id: card.id, rev: card.rev, body: 'From old generation' }] },
    ]) {
      const result = await call('change_plan', input);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, errors: [{ code: 'db_changed' }] });
    }
    expect((await call('board_update_card', { id: card.id, rev: card.rev, body: 'From old generation' })).isError).toBe(true);
    expect((await boardDbForApp(root)).cards[0]).toMatchObject({ body: 'Keep me' });
  });

  it('refuses database guards on a restored file card', async () => {
    await restoreWorkspace(root, archive, { by: 'user' });
    const added = await json('board_add_card', { kind: 'note', title: 'Files', body: 'Keep me' });
    for (const guard of [{ dbId: 'old' }, { rev: 1 }]) {
      expect((await call('board_update_card', { id: added.card.id, body: 'From the database', ...guard })).isError).toBe(true);
    }
    expect((await readBoard(root)).cards[0]).toMatchObject({ body: 'Keep me' });
  });

  it('commits two Now selections in arrival order when the first is waiting for the lock', async () => {
    const { read } = await planDbParts(root);
    const stepA = read.plan.checkpoints[0]!.steps[1]!.key;
    await planAdd(context(), { step: 'A second open step' }, read.plan.checkpoints[0]!.key);
    const stepB = (await planDbParts(root)).read.plan.checkpoints[0]!.steps.at(-1)!.key;
    const acquire = locks.acquireLock;
    let attempts = 0;
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lock = vi.spyOn(locks, 'acquireLock').mockImplementation(async (file, options) => {
      if (file.endsWith('plan-file.lock') && attempts++ === 0) {
        waiting.resolve();
        await release.promise;
      }
      return acquire(file, options);
    });
    try {
      const post = routes();
      const first = post('/plan/now', { key: stepA });
      await waiting.promise;
      const second = post('/plan/now', { key: stepB });
      await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 100))]);
      release.resolve();
      expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([200, 200]);
    } finally {
      release.resolve();
      lock.mockRestore();
    }
    expect((await planDbParts(root)).now?.key).toBe(stepB);
  });

  it('does not post an ask alert when a move refuses its decision', async () => {
    await restoreWorkspace(root, archive, { by: 'user' });
    const latest = vi.spyOn(attention, 'latestInputRequest').mockImplementationOnce(async () => {
      await write(SWITCH_FILE, JSON.stringify({ state: 'moving', archive }));
      return null;
    });
    try {
      await expect(askUser(root, { message: 'Will it ship?' })).rejects.toThrow(/being moved/);
    } finally { latest.mockRestore(); }
    expect(await attention.latestInputRequest(root)).toBeNull();
  });

  it('lets an ask finish its decision and alert before a concurrent move takes its snapshot', async () => {
    await restoreWorkspace(root, archive, { by: 'user' });
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const latest = vi.spyOn(attention, 'latestInputRequest').mockImplementationOnce(async () => {
      entered.resolve();
      await proceed.promise;
      return null;
    });
    const ask = askUser(root, { message: 'Ship this version?' });
    await entered.promise;
    const snapshot = Promise.withResolvers<void>();
    const move = migrateWorkspace(root, {
      by: 'user', backup: false, findOlderWriters: async () => [],
      afterStep: (step) => { if (step === 'snapshot') snapshot.resolve(); },
    });
    try {
      const state = await Promise.race([snapshot.promise.then(() => 'snapshot'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 100))]);
      expect(state).toBe('waiting');
    } finally {
      proceed.resolve();
      await Promise.allSettled([ask, move]);
      latest.mockRestore();
    }
    expect((await ask).planQuestion).toBe('Ship this version?');
    await move;
    expect((await planDbParts(root)).read.plan.checkpoints[0]!.decisions).toContainEqual(expect.objectContaining({ question: 'Ship this version?' }));
    expect((await attention.latestInputRequest(root))?.message).toBe('Ship this version?');
  });

  it('regenerates moved and restored instructions and directs plan edit to apply', async () => {
    const program = new Command().exitOverride();
    const failure = vi.fn();
    registerPlanCommand(program, failure);
    await program.parseAsync(['node', 'ctxspace', 'plan', 'edit', '-w', root]);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('ctxspace plan apply') }));
    const feature = (await loadFeatureConfig(root))!;
    const rendered = await buildContextContent({ feature, repos: [], analysis: new Map() });
    expect(rendered).not.toContain('editing `PLAN.md` directly');
    await restoreWorkspace(root, archive, { by: 'user' });
    const oldPlan = await fs.readFile(path.join(root, 'PLAN.md'));
    const output: string[] = [];
    await planMigrate(context((line) => output.push(line)), {}, { backup: false, findOlderWriters: async () => [] });
    const moved = JSON.parse(output.pop()!);
    expect(moved).toMatchObject({ ok: true });
    expect(moved).not.toHaveProperty('instructionsProblem');
    const generated = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(generated).toContain('ctxspace plan apply');
    expect(generated).not.toContain('editing `PLAN.md` directly');
    await planRestore(context((line) => output.push(line)), moved.archive);
    expect(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')).toContain(renderPlanFileInstructions());
    expect(await fs.readFile(path.join(root, 'PLAN.md'))).toEqual(oldPlan);
  });

  it.each([true, false])('accepts two updates to the same card in one Board batch (row rather than workspace revision: %s)', async (explicit) => {
    const { card } = await json('board_add_card', { kind: 'note', title: 'Draft' });
    const { dbId, revision } = await boardDbForApp(root);
    const observed = explicit ? { rev: card.rev } : {};
    const result = await changeBoardDb(root, [
      { op: 'update_card', id: card.id, title: 'New title', ...observed },
      { op: 'update_card', id: card.id, body: 'New body', ...observed },
    ], { by: 'user', dbId, ...(explicit ? {} : { revision }) });
    expect(result.board.cards[0]).toMatchObject({ title: 'New title', body: 'New body' });
  });

  it.each(['moving', 'restoring', 'unreadable'])('refuses %s at the entry points before any writes', async (state) => {
    const record = readSwitch(root)!;
    await write(SWITCH_FILE, state === 'unreadable' ? '{' : JSON.stringify({ ...record, state }));
    const before = await treeHash();
    for (const cmd of [() => planShow(context()), () => planDone(context(), 'Add the Export button'), () => planNow(context(), '', true)]) {
      await expect(cmd()).rejects.toThrow(/move|restor|cannot be read/i);
    }
    for (const name of ['read_plan', 'board_read', 'set_current_step', 'notes_on_commit', 'change_plan', 'get_work_context']) {
      const result = await call(name, name === 'set_current_step' ? { clear: true } : name === 'change_plan' ? { ops: [{ op: 'now', id: null }] } : {});
      expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/mov|restor|cannot be read/i) }] });
    }
    expect(await treeHash()).toEqual(before);
  });

  it('refuses a bad batch atomically, reports each bad op and rejects a stale revision with the current value', async () => {
    const original = await planDbParts(root);
    const step = original.read.plan.checkpoints[0]!.steps[1]!;
    const rev = original.read.revision;
    const batch = (ops: unknown[], ifRevision = rev) => ({ ops, ifRevision, dbId: original.read.dbId });
    const bytes = await fs.readFile(path.join(root, 'PLAN.md'));
    const bad = await call('change_plan', batch([{ op: 'card.add', kind: 'note', title: 'Rolled back' }, { op: 'mistake' }, { op: 'constructor' }]));
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0]!.text)).toMatchObject({ ok: false, revision: rev, errors: [{ op: 1 }, { op: 2 }] });
    expect(await fs.readFile(path.join(root, 'PLAN.md'))).toEqual(bytes);
    expect((await boardDbForApp(root)).cards).toEqual([]);
    expect((await planDbParts(root)).read.plan.checkpoints[0]!.steps[1]!.done).toBe(false);
    await json('change_plan', batch([{ op: 'now', id: null }]));
    const stale = await call('change_plan', batch([{ op: 'tick', id: step.key }]));
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content[0]!.text)).toMatchObject({ ok: false, revision: rev + 1, errors: [{ code: 'stale_revision' }] });
    expect((await planDbParts(root)).read.plan.checkpoints[0]!.steps[1]!.done).toBe(false);
  });

  it('sets a section by block id and refuses stale section revisions and replaced database IDs', async () => {
    const heading = await readAppDb(root, (db) => listBlocks(db).find((block) => block.kind === 'heading' && block.text === '# CSV export'));
    const { dbId } = (await planDbParts(root)).read;
    const op = { op: 'section.set', id: heading!.id, rev: heading!.rev, text: '# CSV export trail' };
    await json('change_plan', { dbId, ops: [op] });
    const stale = await call('change_plan', { dbId, ops: [op] });
    expect(JSON.parse(stale.content[0]!.text)).toMatchObject({ ok: false, errors: [{ code: 'rev_conflict', currentRev: heading!.rev + 1 }] });
    const replaced = await call('change_plan', { dbId: 'another-db', ops: [{ op: 'now', id: null }] });
    expect(JSON.parse(replaced.content[0]!.text)).toMatchObject({ ok: false, errors: [{ code: 'db_changed' }] });
    expect((await planDbParts(root)).read.plan.title).toBe('CSV export trail');
  });

  it('replays a CLI requestId without ifRevision and exports just one card', async () => {
    const out: string[] = [];
    const failures: unknown[] = [];
    const batch = JSON.stringify({ requestId: 'retry', ops: [{ op: 'card.add', kind: 'note', title: 'One note' }] });
    for (let i = 0; i < 2; i++) {
      const program = new Command().exitOverride();
      registerPlanCommand(program, (error) => { failures.push(error); });
      const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
      try { await program.parseAsync(['node', 'ctxspace', 'plan', 'apply', batch, '-w', root, '--json']); }
      catch (error) { failures.push(error); }
      finally { log.mockRestore(); }
    }
    expect(failures).toEqual([]);
    const [first, second] = out.map((line) => JSON.parse(line));
    expect(second).toMatchObject({ revision: first.revision, replayed: true });
    expect((await boardDbForApp(root)).cards.map(c => c.title)).toEqual(['One note']);
    expect(await fs.readFile(path.join(root, 'contextspace-data.json'), 'utf8')).toContain('One note');
  });

  it('uses stable IDs in plan reads and shortcuts, records checks and advances the app poll token', async () => {
    const app = new Hono();
    registerPlanFileRoutes(app, async () => root);
    const url = '/api/workspace/csv/plan';
    const live = await (await app.request(url)).json();
    const original = await planDbParts(root);
    const { key, steps, decisions } = original.read.plan.checkpoints[0]!;
    const step = steps[1]!;
    const [decision] = decisions;
    const out: string[] = [];
    await planShow({ ...context(line => out.push(line)), json: false });
    expect(out.pop()).toContain(`${step!.key} [ ] Add the Export button`);
    expect(await json('read_plan')).toMatchObject({ checkpoints: [{ id: key, steps: [{ id: expect.any(String) }, { id: step!.key, rev: expect.any(Number) }] }] });
    await planNow(context(), step!.key);
    expect((await planDbParts(root)).now).toMatchObject({ key: step!.key, by: 'codex' });
    await planNow(context(), '', true);
    expect((await planDbParts(root)).now).toBeNull();
    await planAnswer(context(), decision!.key, 'Yes');
    await expect(planAnswer(context(), decision!.key, 'No')).rejects.toThrow(/rev 2: "Yes"/);
    await planAdd(context(), { step: 'New step' }, key);
    await planAdd(context(), { decision: { question: 'Which format?', suggested: ['CSV'] } });
    await planCheck(context(line => out.push(line)), key);
    expect(JSON.parse(out.pop()!)).toMatchObject({ proof: { canProgress: true } });
    await planDone(context(), step!.key);
    await planDone(context(), key);
    await planLog(context(line => out.push(line)));
    expect(JSON.parse(out.pop()!).changes).toEqual(expect.arrayContaining([expect.objectContaining({ key: step!.key, by: 'codex', action: 'ticked' })]));
    const updated = await (await app.request(url)).json();
    expect(updated.revision).toBeGreaterThan(live.revision);
    expect(await dbPollToken(root)).toContain(String(updated.revision));
    expect(updated.checkpoints[0]).toMatchObject({ done: true, steps: expect.arrayContaining([{ ...updated.checkpoints[0].steps[1], id: step!.key, done: true }]) });
  });

  it('advances the app poll token when a CLI check finishes without ticking the checkpoint', async () => {
    const before = await planDbParts(root);
    const token = await dbPollToken(root);
    await planCheck(context(), before.read.plan.checkpoints[0]!.key);
    const after = await planDbParts(root);
    expect(after.read.revision).toBe(before.read.revision);
    expect(await dbPollToken(root)).not.toBe(token);
    expect(after.read.plan.checkpoints[0]!.done).toBe(false);
  });

  it('sets Now and uses short card ids in all MCP Board tools, rejecting stale card revisions', async () => {
    const { read } = await planDbParts(root);
    const cp = read.plan.checkpoints[0]!;
    const id = cp.steps[1]!.key;
    await json('set_current_step', { step: id, harness: 'codex' });
    expect((await planDbParts(root)).now).toMatchObject({ key: id, by: 'codex' });
    await json('set_current_step', { clear: true });
    expect((await planDbParts(root)).now).toBeNull();
    const first = await json('board_add_card', { kind: 'note', title: 'From MCP', area: `checkpoint:${cp.key}`, step: id });
    const card = first.card;
    expect(card).toMatchObject({ id: /^k/, step: id, rev: 1 });
    const full = await json('board_read', { cardId: card.id });
    expect(full.card).toEqual(card);
    const edit = await json('board_update_card', { id: card.id, dbId: read.dbId, rev: card.rev, body: 'Keep my edit' });
    expect(edit.card.rev).toBeGreaterThan(card.rev);
    const stale = await call('board_update_card', { id: card.id, dbId: read.dbId, rev: card.rev, body: 'Stale' });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toMatch(/rev 2/i);
    await json('board_move', { nodes: [{ id: card.id, x: 5, y: 12 }] });
    const linked = await json('board_link', { from: card.id, to: `checkpoint:${cp.key}` });
    const board = await json('board_read');
    expect(board.board.positions[card.id]).toEqual({ x: 5, y: 12 });
    expect(board.board.cards[0].body).toBe('Keep my edit');
    expect(board.areas.current).toBe(`checkpoint:${cp.key}`);
    await json('board_unlink', { id: linked.link.id });
    const removal = await boardDbForApp(root);
    await json('board_remove_card', { id: card.id, dbId: removal.dbId, revision: removal.revision, rev: edit.card.rev });
    expect((await boardDbForApp(root)).cards).toEqual([]);
  });

  it('returns busy on a held SQLite lock and a held plan lock without writing', async () => {
    const original = await planDbParts(root);
    const id = original.read.plan.checkpoints[0]!.steps[1]!.key;
    const holder = new DatabaseSync(dbFilePath(root));
    const lockPath = '.contextspace/plan-file.lock';
    const before = await treeHash();
    try {
      holder.exec('BEGIN IMMEDIATE');
      await expect(planDone(context(), id)).rejects.toThrow(/Busy, try again/);
      holder.exec('ROLLBACK');
    } finally { holder.close(); }
    expect(await treeHash()).toEqual(before);
    await write(lockPath, JSON.stringify({ pid: process.pid }));
    try {
      const blocked = await call('change_plan', { ops: [{ op: 'tick', id }] });
      expect(blocked).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Busy, try again') }] });
    } finally { await fs.rm(path.join(root, lockPath)); }
    expect(await treeHash()).toEqual(before);
  }, 12_000);

  it('uses the database for work context, lifecycle checks, and decisions linked to a chat request', async () => {
    const [cp] = (await readWorkspaceLifecycle(root)).steps;
    expect(cp!.id).toMatch(/^c[0-9a-z]{5}$/);
    expect(await json('get_work_context')).toMatchObject({ plan: expect.stringContaining(cp!.id) });
    const asked = await json('request_user_input', { message: 'May we ship?', options: ['Yes'], harness: 'codex' });
    expect(asked.planQuestion).toBe('May we ship?');
    await expect(answerChatQuestionsInPlan(root, ['May we ship?'])).resolves.toEqual(['May we ship?']);
    const answered = await planDbParts(root);
    expect(answered.read.plan.checkpoints[0]!.decisions).toContainEqual(expect.objectContaining({ question: 'May we ship?', done: true }));
    await advanceLifecycleStep(root, cp!.id, 'verify', { by: 'agent', harness: 'codex' });
    expect((await planDbParts(root)).checks[cp!.id]).toMatchObject({ canProgress: true, lastVerificationSha: 'abc1234def5678' });
  });

  it('reads and marks CLI news in the database, and promotes only the pending report the reader saw', async () => {
    await planDone({ ...context(), by: 'claude' }, 'Add the Export button');
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await newsCommand({ workspace: root, as: 'codex', json: true });
      const report = JSON.parse(output.mock.lastCall![0]);
      expect(report.plan.items).toContainEqual(expect.objectContaining({ text: 'Add the Export button' }));
      await newsCommand({ workspace: root, as: 'codex', json: true, peek: true });
      expect(JSON.parse(output.mock.lastCall![0]).basis).toBe('last-look');
    } finally { output.mockRestore(); }
    const first = await whatsNew(root, 'reviewer', { database: true, pending: true, now: new Date('2026-11-22T15:00:00Z') });
    const second = await whatsNew(root, 'reviewer', { database: true, pending: true, now: new Date('2026-11-22T15:01:00Z') });
    await expect(markSeen(root, 'reviewer', first.at, { database: true })).rejects.toBeInstanceOf(NewsChangedError);
    await markSeen(root, 'reviewer', second.at, { database: true });
    await expect(fs.access(path.join(root, '.contextspace', 'seen.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renders short moved instructions in generated AGENTS.md and keeps the file instructions after restore', async () => {
    const feature = (await loadFeatureConfig(root))!;
    const rendered = await buildContextContent({ feature, repos: [], analysis: new Map() });
    const moved = rendered.match(/## Plan[\s\S]*?(?=\n\n## Where to look)/)![0];
    expect(Buffer.byteLength(moved)).toBeLessThanOrEqual(1400);
    expect(moved).toMatch(/ctxspace plan.*ctxspace plan apply/s);
    const example = JSON.parse(moved.match(/ctxspace plan apply '({[^\n]+})'/)![1]!);
    expect(example.ops[0]).toEqual({ op: 'tick', id: expect.stringMatching(ID_PATTERN) });
    await closeAppDb(root);
    await restoreWorkspace(root, archive, { by: 'user' });
    expect(await buildContextContent({ feature, repos: [], analysis: new Map() })).toContain(renderPlanFileInstructions());
  });
});

describe('reads with the switch on', () => {
  it('the plan reads as the plan that was moved (same items and keys), and reading it writes nothing', async () => {
    const before = await treeHash();
    const read = await readPlanFile(root);
    expect(read.text).toBe(PLAN);
    expect(planItems(read.plan).map((i) => i.key)).toEqual(planItems(parsePlanFile(PLAN)).map((i) => i.key));
    expect(await movePlanToFile(root)).toBe(false);
    expect(await treeHash()).toEqual(before);
  });
});

describe('with the switch off again', () => {
  it('every writer works exactly as before', async () => {
    await restoreWorkspace(root, archive, { by: 'user' });
    await changePlanFile(root, (text) => setDone(text, 'add-the-export-button', true, 'Add the Export button'), { by: 'user' });
    expect(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8')).toContain('- [x] Add the Export button');
    await changeBoard(root, [{ op: 'add_card', kind: 'note', title: 'New' }], { by: 'user' });
    expect((await readBoard(root)).cards.map((c) => c.title)).toEqual(['New']);
    await clearPlanNow(root);
    await markSeen(root, 'claude', AT).catch((error: unknown) => { expect((error as Error).name).toBe('NewsChangedError'); });
  });
});

describe('readSwitch reads first and looks after (CodeQL: no check-then-read)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-switch-read-')); await fs.mkdir(path.join(dir, '.contextspace'), { recursive: true }); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('no file is off', () => {
    expect(readSwitch(dir)).toBeNull();
  });

  it('a switch that cannot be parsed counts as on (unreadable)', async () => {
    await fs.writeFile(path.join(dir, ...SWITCH_FILE.split('/')), '{"state":');
    expect(readSwitch(dir)).toEqual({ state: 'unreadable' });
  });

  it('a folder where the switch should be counts as on (unreadable)', async () => {
    await fs.mkdir(path.join(dir, ...SWITCH_FILE.split('/')));
    expect(readSwitch(dir)).toEqual({ state: 'unreadable' });
  });

  it.skipIf(process.platform === 'win32')('a dangling link where the switch should be still counts as on (unreadable), never as off', async () => {
    await fs.symlink(path.join(dir, 'gone.json'), path.join(dir, ...SWITCH_FILE.split('/')));
    expect(readSwitch(dir)).toEqual({ state: 'unreadable' });
  });

  it('a regular file at .contextspace counts as off (ENOTDIR)', async () => {
    await fs.rm(path.join(dir, '.contextspace'), { recursive: true, force: true });
    await fs.writeFile(path.join(dir, '.contextspace'), 'not a folder');
    expect(readSwitch(dir)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('a link at the switch pointing through a regular file still counts as on (unreadable)', async () => {
    const file = path.join(dir, 'plain-file');
    await fs.writeFile(file, 'x');
    await fs.symlink(path.join(file, 'child.json'), path.join(dir, ...SWITCH_FILE.split('/')));
    expect(readSwitch(dir)).toEqual({ state: 'unreadable' });
  });
});
