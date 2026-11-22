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
import { markSeen, whatsNew } from './whats-new.js';
import { SWITCH_FILE, WorkspaceMovedError, readSwitch } from './workspace-db-switch.js';
import { closeAppDb } from './workspace-db-app.js';
import { registerBoardRoutes } from '../http/board-routes.js';
import { registerPlanFileRoutes } from '../http/plan-file-routes.js';
import { registerNewsRoutes } from '../http/news-routes.js';
import { findTool, type ToolContext } from '../mcp/tools.js';
import { planDone, registerPlanCommand } from '../commands/plan.js';
import type { NexusFlowConfig } from '../types.js';

const PLAN = `# CSV export

## Checkpoints

- [ ] Reports export to CSV
  Check: \`npm test\`
  - [x] Write the CSV writer
  - [ ] Add the Export button
`;
const AT = '2026-11-01T10:00:00.000Z';

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
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'csv', name: 'CSV export', branchName: 'feat/csv', description: 'CSV', repos: [], assistants: [], workspacePath: root }));
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
    const tick = await call(`/api/workspace/csv/plan/steps/${step.key}/tick`, { done: true, expected: 'Add the Export button' });
    expect(tick.status).toBe(200);
    const news = await call('/api/workspace/csv/news?reader=user');
    const seen = await call('/api/workspace/csv/news/seen', { reader: 'user', at: news.body.at });
    expect(seen.status).toBe(200);
    expect(await oldState()).toEqual(before);
  });

  it('a CLI verb: ctxspace plan done', async () => {
    await refusedAndUnchanged(() => planDone({ workspacePath: root, by: 'claude', json: false, print: () => undefined }, 'Add the Export button'), PlanFileError);
    const failures: string[] = [];
    const program = new Command().exitOverride();
    registerPlanCommand(program, (error) => { failures.push(error instanceof Error ? error.message : String(error)); });
    const before = await treeHash();
    await program.parseAsync(['node', 'ctxspace', 'plan', 'done', 'Add the Export button', '-w', root]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(MOVED);
    expect(await treeHash()).toEqual(before);
  });

  it('an MCP tool: board_add_card', async () => {
    const config: NexusFlowConfig = { version: '1.0', devDir: '/dev', workspacesDir: '/dev/workspaces', defaultAssistant: null, scanDepth: 2 };
    const ctx: ToolContext = { config, workspacePath: root };
    const before = await treeHash();
    const result = await findTool('board_add_card')!.handler({ kind: 'note', title: 'New' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/This workspace was moved to the workspace database\. Undo it with `ctxspace plan restore/);
    expect(await treeHash()).toEqual(before);
  });

  it('a switch file that cannot be read still counts as on', async () => {
    await fs.writeFile(path.join(root, SWITCH_FILE), '{ not json');
    const before = await treeHash();
    await expect(changePlanFile(root, (text) => `${text}x\n`, { by: 'user' })).rejects.toThrow(/cannot be read\)\. Nothing was written/);
    await expect(changeBoard(root, [{ op: 'add_card', kind: 'note', title: 'New' }], { by: 'user' })).rejects.toThrow(/cannot be read/);
    expect(await treeHash()).toEqual(before);
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
