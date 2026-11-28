import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import { getStorageProvider, setActiveStorageProvider } from './adapters/registry.js';
import { createWorkspace } from './workspace.js';
import { migrateWorkspace, restoreWorkspace } from './plan-migrate.js';
import { readSwitch } from './workspace-db-switch.js';
import { applyPlanBatch, planDbText } from './plan-db-command.js';
import { planShow } from '../commands/plan.js';
import type { Feature, RepoInfo } from '../types.js';

// A new workspace starts on the workspace database. Real files, real Git (a scratch source repository), no mocks.
let tmp: string;
let source: string;
let previous = getStorageProvider('local');

const noOlderWriters = { findOlderWriters: async () => [] };

async function repoInfo(): Promise<RepoInfo> {
  source = path.join(tmp, 'src', 'api');
  await fs.mkdir(source, { recursive: true });
  const git = (...args: string[]) => execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: source });
  await git('init', '-b', 'main');
  await fs.writeFile(path.join(source, 'a.txt'), 'a');
  await git('add', '.');
  await git('commit', '-m', 'first');
  return { name: 'api', path: source, defaultBranch: 'main' };
}

function feature(id: string, repo: RepoInfo, mode: 'worktree' | 'in-place', over: Partial<Feature> = {}): Feature {
  const workspacePath = path.join(tmp, 'ws', id);
  return {
    id, branchName: id, mode, name: 'Export reports', description: 'Customers export their reports.',
    repos: mode === 'in-place' ? [repo.path] : [path.join(workspacePath, repo.name)],
    originalRepos: [repo.path], assistants: ['claude'], workspacePath, createdAt: '2026-11-28T00:00:00.000Z', ...over,
  };
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexusflow-newdb-')));
  await fs.mkdir(path.join(tmp, 'ws'), { recursive: true });
  setActiveStorageProvider(getStorageProvider('local'));
});
afterEach(async () => {
  setActiveStorageProvider(previous);
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('a new workspace starts on the database', () => {
  for (const mode of ['worktree', 'in-place'] as const) {
    it(`${mode} mode: the switch is on, the plan has the title, the description and Checkpoints, and the archive restores`, async () => {
      const repo = await repoInfo();
      const f = feature(`new-${mode}`, repo, mode);
      const notes: string[] = [];
      await createWorkspace(f, [repo], undefined, { onNote: (n) => notes.push(n), move: noOlderWriters });
      expect(notes).toEqual([]);
      const record = readSwitch(f.workspacePath);
      expect(record?.state).toBe('on');
      const view = await planDbText(f.workspacePath, { all: true });
      expect(view).toContain('Export reports');
      expect(view).toContain('Checkpoints');
      expect(await fs.readFile(path.join(f.workspacePath, 'PLAN.md'), 'utf8')).toContain('Customers export their reports.'); // the export of the database plan
      const restored = await restoreWorkspace(f.workspacePath, record!.archive!, { by: 'test' });
      expect(restored.state).not.toBe('moving');
      expect(readSwitch(f.workspacePath)).toBeNull();
      expect(await fs.readFile(path.join(f.workspacePath, 'PLAN.md'), 'utf8')).toContain('## Checkpoints');
    });
  }

  it('an AI can add the first checkpoint with an op, and the plan hint goes away', async () => {
    const repo = await repoInfo();
    const f = feature('first-checkpoint', repo, 'in-place', { name: undefined, description: '' });
    await createWorkspace(f, [repo], undefined, { move: noOlderWriters });
    expect(await planDbText(f.workspacePath)).toContain('No checkpoint yet. Add the first one with {"op":"add","kind":"checkpoint"');
    await applyPlanBatch(f.workspacePath, { ops: [{ op: 'add', kind: 'checkpoint', text: 'A first outcome' }] }, 'claude');
    const after = await planDbText(f.workspacePath);
    expect(after).toContain('A first outcome');
    expect(after).not.toContain('No checkpoint yet');
    expect(after).toContain('first-checkpoint'); // no name: the title is the id
  });

  it('a refused move leaves a files workspace with no PLAN.md, a note naming `ctxspace plan migrate`, and creation succeeds', async () => {
    const repo = await repoInfo();
    const f = feature('refused', repo, 'in-place');
    const notes: string[] = [];
    const older = [{ what: 'an older ContextSpace is running', found: 'pid 1', stop: 'stop it' }];
    await expect(createWorkspace(f, [repo], undefined, { onNote: (n) => notes.push(n), move: { findOlderWriters: async () => older } })).resolves.toBe(f.workspacePath);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('This new workspace stays on files (The move was not started: a ContextSpace that does not know the workspace database could still write this workspace\'s old files, and what they wrote would be lost). Run `ctxspace plan migrate` to move it later.');
    expect(readSwitch(f.workspacePath)).toBeNull();
    // The starter plan stays, so the note's advice works: run the move again with nothing refusing it.
    expect(await fs.readFile(path.join(f.workspacePath, 'PLAN.md'), 'utf8')).toBe('# Export reports\n\nCustomers export their reports.\n\n## Checkpoints\n');
    await migrateWorkspace(f.workspacePath, { by: 'test', ...noOlderWriters });
    expect(readSwitch(f.workspacePath)?.state).toBe('on');
    expect(existsSync(path.join(f.workspacePath, 'nexusflow.json')) || existsSync(path.join(f.workspacePath, 'contextspace.json'))).toBe(true);
  });

  it('another storage adapter keeps the workspace on files, says why, and still creates it', async () => {
    const repo = await repoInfo();
    const f = feature('adapter', repo, 'in-place');
    const notes: string[] = [];
    setActiveStorageProvider(Object.create(getStorageProvider('local')));
    await createWorkspace(f, [repo], undefined, { onNote: (n) => notes.push(n), move: noOlderWriters });
    expect(notes[0]).toMatch(/^This new workspace stays on files \(.*storage adapter.*\)\. Run `ctxspace plan migrate`/);
    expect(notes[0]).not.toContain('Nothing was changed');
    expect(existsSync(path.join(f.workspacePath, 'PLAN.md'))).toBe(true);
  });

  it('a description cannot add plan structure', async () => {
    const repo = await repoInfo();
    const f = feature('desc', repo, 'in-place', { description: 'Intro\n## Checkpoints\n- [ ] step\n# Title\n  * [x] done' });
    await createWorkspace(f, [repo], undefined, { move: noOlderWriters });
    const view = await planDbText(f.workspacePath, { all: true });
    expect(view).toContain('0 open of 0 items');
    expect(view.match(/## Checkpoints/g)).toHaveLength(1);
    expect(view.match(/^\S+ # /gm)).toHaveLength(1);
    expect(await fs.readFile(path.join(f.workspacePath, 'PLAN.md'), 'utf8')).toContain('\\## Checkpoints');
    await applyPlanBatch(f.workspacePath, { ops: [{ op: 'add', kind: 'checkpoint', text: 'First' }] }, 'claude');
    expect(await planDbText(f.workspacePath)).toContain('First');
  });

  it('the hint is for a database plan only: a files workspace prints what it printed before', async () => {
    const repo = await repoInfo();
    const f = feature('files-only', repo, 'in-place');
    await createWorkspace(f, [repo], undefined, { move: { findOlderWriters: async () => [{ what: 'x', found: 'y', stop: 'z' }] } });
    await fs.writeFile(path.join(f.workspacePath, 'PLAN.md'), '# Files\n\n## Checkpoints\n');
    const printed: string[] = [];
    await planShow({ workspacePath: f.workspacePath, by: 'claude', json: false, print: (t) => printed.push(t), now: new Date() });
    expect(printed.join('\n')).not.toContain('No checkpoint yet');
  });
});
