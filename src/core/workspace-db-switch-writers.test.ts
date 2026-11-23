import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getStorageProvider, setActiveStorageProvider } from './adapters/registry.js';
import { legacyDefaultSteps } from './legacy-lifecycle.js';
import { advanceLifecycleStep, blockLifecycleStep, loadWorkspaceLifecycle, readWorkspaceLifecycle, reopenLifecycleStep, updateLifecyclePlan } from './lifecycle.js';
import { PlanError, changePlan, mutatePlan, readPlan } from './plan.js';
import { importPlanningNotes, preparePlan } from './plan-import.js';
import { PLANNING_NOTES_FILE, readPlanningNotes, savePlanningNotes } from './planning-notes.js';
import { moveRootDocument, writeRootDocument } from './root-documents.js';
import { SWITCH_FILE, WorkspaceMovedError } from './workspace-db-switch.js';
import { mutateWorkspaceState } from './workspace-state.js';
import { pullWorkspaceArtifacts } from './workspace-git.js';

/**
 * The writers of the older plan (contextspace-plan.json, the lifecycle and evidence in state.json, the planning notes)
 * and the documents panel. They take over whenever a workspace has no PLAN.md: a workspace that only ever had the older
 * store, a restore between putting the old files back and clearing the switch, or a PLAN.md deleted after the move.
 */

let root: string;
const ARCHIVE = '.contextspace/archive/pre-db-2026-11-20T00-00-00-000Z-abcd';

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

async function refusedAndUnchanged(act: () => Promise<unknown>, type: new (...args: never[]) => Error = Error): Promise<void> {
  const before = await treeHash();
  const error = await act().then(() => null, (e: unknown) => e);
  expect(error, 'the writer was not refused').toBeInstanceOf(type);
  expect((error as Error).message).toMatch(/moved to the workspace database|being restored from the workspace database|being moved to the workspace database/);
  expect(await treeHash()).toEqual(before);
}

/** An older lifecycle in state.json, worked on (so it is moved into the plan store, not dropped as an unused template). */
async function legacyWorkspace() {
  const steps = legacyDefaultSteps('feature', 'old', 'feat/old');
  steps[0] = { ...steps[0]!, status: 'completed' };
  await write('.contextspace/state.json', JSON.stringify({ workspacePath: root, repos: {}, updatedAt: '2026-11-01T00:00:00.000Z', lifecycle: { workspaceId: 'old', flowType: 'feature', steps, updatedAt: '2026-11-01T00:00:00.000Z' } }));
  return steps;
}

const turnOn = (state: 'on' | 'moving' | 'restoring') => write(SWITCH_FILE, JSON.stringify({ state, archive: ARCHIVE, id: 'abc' }));

beforeEach(async () => {
  setActiveStorageProvider(getStorageProvider('local'));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'switch-writers-')));
  await write('contextspace.json', JSON.stringify({ id: 'old', name: 'Old', branchName: 'feat/old', repos: [], assistants: [], workspacePath: root }));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the older plan store (contextspace-plan.json) and the lifecycle, with no PLAN.md and the switch on', () => {
  async function storeWorkspace(state: 'on' | 'moving' | 'restoring') {
    const steps = await legacyWorkspace();
    await loadWorkspaceLifecycle(root, { includeFleet: false }); // switch off: the lifecycle moves into the store, as today
    const plan = await readPlan(root);
    expect(plan.items.length).toBeGreaterThan(0);
    await turnOn(state);
    return { steps, plan };
  }

  it('the store itself (mutatePlan, changePlan) refuses, for every switch state', async () => {
    for (const state of ['on', 'moving', 'restoring'] as const) {
      const { plan } = await storeWorkspace(state);
      const item = plan.items[1]!;
      await refusedAndUnchanged(() => mutatePlan(root, (p) => { p.items[0]!.title = 'changed'; }), PlanError);
      await refusedAndUnchanged(() => changePlan(root, { type: 'start', id: item.id }, { actor: { by: 'user' } }), PlanError);
      await fs.rm(path.join(root, SWITCH_FILE));
    }
  });

  it('advance, reopen, block and the milestone editor refuse while restoring', async () => {
    const { plan } = await storeWorkspace('restoring');
    const pending = plan.items[1]!;
    const done = plan.items.find((i) => i.status === 'done')!;
    await refusedAndUnchanged(() => advanceLifecycleStep(root, pending.id, 'start', { by: 'user' }), WorkspaceMovedError);
    await refusedAndUnchanged(() => reopenLifecycleStep(root, done.id, { reason: 'again', by: 'user' }), WorkspaceMovedError);
    await refusedAndUnchanged(() => blockLifecycleStep(root, pending.id, { reason: 'waiting' }), WorkspaceMovedError);
    await refusedAndUnchanged(() => updateLifecyclePlan(root, { revision: plan.revision, steps: [] }), WorkspaceMovedError);
  });

  it('refuses to show an older lifecycle when the moved database is missing, and writes nothing', async () => {
    await legacyWorkspace();
    await turnOn('on');
    const before = await treeHash();
    await expect(loadWorkspaceLifecycle(root, { includeFleet: false })).rejects.toMatchObject({ code: 'missing' });
    await expect(readWorkspaceLifecycle(root)).rejects.toMatchObject({ code: 'missing' });
    expect(await treeHash()).toEqual(before);
  });

  it('state.json: the plan\'s fields (evidence, lifecycle, checks) are refused, everything else is written as before', async () => {
    await legacyWorkspace();
    await turnOn('on');
    await refusedAndUnchanged(() => mutateWorkspaceState(root, (s) => { s.planEvidence = { x: { lastVerificationStatus: 'pass', canProgress: true } as never }; }), WorkspaceMovedError);
    await refusedAndUnchanged(() => mutateWorkspaceState(root, (s) => { s.lifecycle!.steps = []; }), WorkspaceMovedError);
    await refusedAndUnchanged(() => mutateWorkspaceState(root, (s) => { s.planChecks = {}; }), WorkspaceMovedError);
    await mutateWorkspaceState(root, (s) => { s.repos.NexusFlow = { lastSyncAt: '2026-11-20T00:00:00.000Z' } as never; });
    expect(JSON.parse(await fs.readFile(path.join(root, '.contextspace', 'state.json'), 'utf8')).repos.NexusFlow).toBeDefined();
  });
});

describe('the older planning notes (contextspace-milestones.md), with the switch on', () => {
  it('saving them refuses', async () => {
    await turnOn('on');
    const { revision } = await readPlanningNotes(root);
    await refusedAndUnchanged(() => savePlanningNotes(root, revision, '# Notes\n'), WorkspaceMovedError);
  });

  it('importing them refuses, and preparing the plan reads it as it is without moving anything', async () => {
    await write(PLANNING_NOTES_FILE, '# Milestones\n\n| ID | Milestone |\n| --- | --- |\n| m1 | Ship it |\n');
    await turnOn('restoring');
    await refusedAndUnchanged(() => importPlanningNotes(root), WorkspaceMovedError);
    const before = await treeHash();
    await preparePlan(root);
    expect(await treeHash()).toEqual(before);
  });
});

describe('the documents panel (PUT documents, POST documents/move)', () => {
  it('never saves or moves ContextSpace\'s own store files, switch or not', async () => {
    await write('contextspace-board.json', '{}');
    await write('notes.md', 'notes');
    const before = await treeHash();
    await expect(writeRootDocument(root, 'contextspace-board.json', '{"cards":[]}')).rejects.toThrow(/ContextSpace's own store file/);
    await expect(writeRootDocument(root, 'contextspace-data.json', '{}')).rejects.toThrow(/ContextSpace's own store file/);
    await expect(moveRootDocument(root, 'contextspace-board.json', 'board.json')).rejects.toThrow(/ContextSpace's own store file/);
    await expect(moveRootDocument(root, 'docs-plan.json', 'contextspace-plan.json')).rejects.toThrow();
    expect(await treeHash()).toEqual(before);
  });

  it('refuses to save, move in or move out PLAN.md and the planning notes while the switch is on', async () => {
    await write('PLAN.md', '# Plan\n');
    await write('notes.md', 'notes');
    await turnOn('on');
    await refusedAndUnchanged(() => writeRootDocument(root, 'PLAN.md', '# Mine\n'), WorkspaceMovedError);
    await refusedAndUnchanged(() => writeRootDocument(root, PLANNING_NOTES_FILE, '# Notes\n'), WorkspaceMovedError);
    await refusedAndUnchanged(() => moveRootDocument(root, 'PLAN.md', 'old-plan.md'), WorkspaceMovedError);
    await fs.rm(path.join(root, 'PLAN.md'));
    await refusedAndUnchanged(() => moveRootDocument(root, 'notes.md', 'PLAN.md'), WorkspaceMovedError);
    // any other document saves as before
    await writeRootDocument(root, 'notes.md', 'more notes');
    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('more notes');
  });

  it('saves through a temp file and a rename, so a reader never meets half a document', async () => {
    await write('notes.md', 'notes');
    const before = (await fs.stat(path.join(root, 'notes.md'))).ino;
    await writeRootDocument(root, 'notes.md', 'new');
    expect((await fs.stat(path.join(root, 'notes.md'))).ino).not.toBe(before); // a new file renamed in, not the old one written over
    expect((await fs.readdir(root)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('a saved document keeps its permission bits (fix round 2, N7)', () => {
  it.skipIf(process.platform === 'win32')('0600 stays 0600 and an executable stays executable, through the temp file and rename', async () => {
    for (const mode of [0o600, 0o755, 0o640, 0o664, 0o666]) {
      await write('notes.md', 'notes');
      await fs.chmod(path.join(root, 'notes.md'), mode);
      await writeRootDocument(root, 'notes.md', `saved with ${mode.toString(8)}`);
      expect((await fs.stat(path.join(root, 'notes.md'))).mode & 0o7777).toBe(mode);
    }
    // a new document gets the usual bits
    await writeRootDocument(root, 'fresh.md', 'new');
    expect((await fs.stat(path.join(root, 'fresh.md'))).mode & 0o200).toBe(0o200);
  });
});

describe('the workspace\'s own Git (ctxspace remote pull)', () => {
  it('does not pull into a moved workspace: a pull would rewrite PLAN.md and bring archived files back', async () => {
    await turnOn('on');
    await refusedAndUnchanged(() => pullWorkspaceArtifacts(root), WorkspaceMovedError); // not even a git init
  });
});
