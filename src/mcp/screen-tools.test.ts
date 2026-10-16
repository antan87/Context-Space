import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enabledTools, findTool, type ToolContext } from './tools.js';
import * as workspace from '../core/workspace.js';
import { PRIMARY_MANIFEST_FILE } from '../core/constants.js';
import { SCREEN_EVENTS_FILE } from '../core/screen-events.js';
import { setScreenSharing, saveScreenContext } from '../core/screen-context.js';
import { loadWorkspaceState, saveWorkspaceState } from '../core/workspace-state.js';
import { loadWorkspaceLifecycle } from '../core/lifecycle.js';
import { readPlan } from '../core/plan.js';
import type { LifecycleStep, NexusFlowConfig } from '../types.js';

vi.mock('../core/planning-refresh.js', () => ({ refreshPlanningContext: vi.fn(async () => ({ contextRefreshed: true })) }));
vi.mock('../utils/multi-git.js', () => ({ getWorkspaceRepos: vi.fn(async () => []) }));
import { refreshPlanningContext } from '../core/planning-refresh.js';
import { getWorkspaceRepos } from '../utils/multi-git.js';

const config: NexusFlowConfig = { version: '1.0', devDir: '/dev', workspacesDir: '/dev/workspaces', defaultAssistant: null, scanDepth: 2 };

let root: string;
let dir: string;

async function write(file: string, content = 'x\n') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-screen-tools-')));
  dir = path.join(root, 'ws-one');
  await write(path.join(dir, PRIMARY_MANIFEST_FILE), '{}\n');
  await write(path.join(dir, 'plan.md'), '# Plan\n\nStep one\nStep two\n');
  await write(path.join(dir, 'docs', 'notes.md'));
  await write(path.join(dir, 'NexusFlow', 'src', 'a.ts'), 'one\ntwo\nthree\n');
  await write(path.join(dir, 'NexusFlow', '.git', 'config'));
  await write(path.join(dir, 'blob.bin'), 'ab\u0000cd');
  await write(path.join(root, 'outside.txt'), 'secret');
  vi.spyOn(workspace, 'loadFeatureConfig').mockResolvedValue({
    id: 'ws-one', branchName: 'ws-one', description: 'x', mode: 'worktree', repos: [], assistants: [], workspacePath: dir, createdAt: new Date().toISOString(),
  });
  vi.mocked(getWorkspaceRepos).mockResolvedValue([{ name: 'NexusFlow', path: path.join(dir, 'NexusFlow'), branchName: 'b', defaultBranch: 'main' }]);
  vi.mocked(refreshPlanningContext).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(getWorkspaceRepos).mockResolvedValue([]);
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

const ctx = (): ToolContext => ({ config, workspacePath: dir });
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await findTool(name)!.handler(args, ctx());
  const text = result.content[0]!.text;
  return { isError: Boolean(result.isError), text, body: result.isError ? undefined : JSON.parse(text) };
};
const screenLines = async () => (await fs.readFile(path.join(dir, '.contextspace', SCREEN_EVENTS_FILE), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const seed = (steps: LifecycleStep[]) => saveWorkspaceState({ workspacePath: dir, repos: {}, updatedAt: '', lifecycle: { workspaceId: 'ws-one', flowType: 'feature', updatedAt: '', revision: 1, steps } });
// The lifecycle is a view over the plan store.
const stepsNow = async () => (await loadWorkspaceLifecycle(dir, { includeFleet: false })).steps;

describe('registration', () => {
  const names = ['show_in_reader', 'annotate_document', 'suggest_next', 'set_milestone', 'get_screen_context'];

  it('registers every screen tool with a strict schema and the right read-only hint', () => {
    for (const name of names) {
      const tool = findTool(name)!;
      expect(tool, name).toBeDefined();
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
      expect(tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false, readOnlyHint: name === 'get_screen_context' });
    }
  });

  it('tells the AI the rules in the descriptions', () => {
    expect(findTool('show_in_reader')!.description).toMatch(/only shows/i);
    expect(findTool('set_milestone')!.description).toMatch(/they can reopen it/i);
    expect(findTool('get_screen_context')!.description).toMatch(/do not ask the user to switch it on/i);
  });

  it('is offered to developer, interactive and full sessions only, and can be switched off by name', () => {
    for (const role of ['developer', 'interactive', 'full'] as const) {
      const offered = enabledTools(config, role).map((t) => t.name);
      for (const name of names) expect(offered, `${role} ${name}`).toContain(name);
    }
    for (const role of ['readonly', 'review', 'ci'] as const) {
      const offered = enabledTools(config, role).map((t) => t.name);
      for (const name of names) expect(offered, `${role} ${name}`).not.toContain(name);
    }
    expect(enabledTools(config, 'full', undefined, ['show_in_reader']).map((t) => t.name)).not.toContain('show_in_reader');
  });

  it('rejects input it does not know, so a typo is not silently ignored', async () => {
    const result = await call('show_in_reader', { path: 'plan.md', colour: 'red' });
    expect(result.isError).toBe(true);
    expect(await screenLines()).toEqual([]);
  });

  it('says so, plainly, when the workspace does not exist', async () => {
    vi.mocked(workspace.loadFeatureConfig).mockResolvedValue(null as never);
    const result = await call('suggest_next', { title: 'x', reason: 'y' });
    expect(result).toMatchObject({ isError: true, text: 'Workspace not found.' });
  });
});

describe('show_in_reader', () => {
  it('opens a document in the workspace folder and chooses the document view from its name', async () => {
    const { body } = await call('show_in_reader', { path: 'plan.md', line: 3, note: 'The risky step' });
    expect(body).toMatchObject({ status: 'shown', view: 'document', path: 'plan.md', line: 3 });
    expect(await screenLines()).toEqual([expect.objectContaining({ kind: 'screen_event', event: 'show', payload: { view: 'document', path: 'plan.md', line: 3, note: 'The risky step' } })]);
  });

  it('opens a file in a repository relative to that repository and chooses the file view', async () => {
    const { body } = await call('show_in_reader', { path: 'NexusFlow/src/a.ts', line: 2, endLine: 3 });
    expect(body).toMatchObject({ view: 'file', repo: 'NexusFlow', path: 'src/a.ts' });
    expect((await screenLines())[0].payload).toEqual({ view: 'file', repo: 'NexusFlow', path: 'src/a.ts', line: 2, endLine: 3 });
  });

  it('shows every change in a repository when given only the repository', async () => {
    const { body } = await call('show_in_reader', { repo: 'nexusflow' });
    expect(body).toMatchObject({ view: 'diff', repo: 'NexusFlow' });
    expect((await screenLines())[0].payload).toEqual({ view: 'diff', repo: 'NexusFlow' });
  });

  it('shows one file as a diff when asked', async () => {
    const { body } = await call('show_in_reader', { path: 'src/a.ts', view: 'diff' });
    expect(body).toMatchObject({ view: 'diff', repo: 'NexusFlow', path: 'src/a.ts' });
  });

  it.each([
    ['a path outside the workspace', { path: '../outside.txt' }, /outside/i],
    ['an absolute path outside the workspace', { path: '/etc/passwd' }, /outside/i],
    ['a file that does not exist', { path: 'nope.md' }, /does not exist/],
    ['Git internals', { path: 'NexusFlow/.git/config' }, /Git internals/],
    ['a folder shown as a document', { path: 'docs' }, /folder/],
    ['nothing to show', {}, /Give a path/],
    ['a document view with no path', { view: 'document', repo: 'NexusFlow' }, /Give a path/],
    ['an unknown repository', { repo: 'ghost' }, /not a repository/],
    ['an end line with no line', { path: 'plan.md', endLine: 4 }, /endLine needs a line/],
    ['an end line before the line', { path: 'plan.md', line: 5, endLine: 2 }, /cannot come before/],
    ['a line of zero', { path: 'plan.md', line: 0 }, /line/],
    ['a note that is too long', { path: 'plan.md', note: 'x'.repeat(301) }, /note/],
  ])('refuses %s with a clear message and writes nothing', async (_n, args, message) => {
    const result = await call('show_in_reader', args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
    expect(await screenLines()).toEqual([]);
  });

  it('refuses a symlink that leads out of the workspace', async () => {
    await fs.symlink(root, path.join(dir, 'escape'));
    const result = await call('show_in_reader', { path: 'escape/outside.txt' });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toMatch(/outside/i);
    expect(await screenLines()).toEqual([]);
  });

  it('ignores the same call made twice and says the user already has it', async () => {
    await call('show_in_reader', { harness: 'claude', path: 'plan.md' });
    const again = await call('show_in_reader', { harness: 'claude', path: 'plan.md' });
    expect(again.body).toMatchObject({ status: 'already_shown', message: expect.stringContaining('already') });
    expect(await screenLines()).toHaveLength(1);
  });

  it('never changes the file it shows', async () => {
    const before = await fs.readFile(path.join(dir, 'plan.md'), 'utf8');
    await call('show_in_reader', { path: 'plan.md', line: 2 });
    expect(await fs.readFile(path.join(dir, 'plan.md'), 'utf8')).toBe(before);
  });
});

describe('annotate_document', () => {
  it('leaves a note on a real line, defaulting to a question', async () => {
    const { body } = await call('annotate_document', { path: 'plan.md', line: 3, text: 'Does this break the order?' });
    expect(body).toMatchObject({ status: 'shown', path: 'plan.md', line: 3 });
    expect((await screenLines())[0]).toMatchObject({ event: 'annotate', payload: { path: 'plan.md', line: 3, text: 'Does this break the order?', tag: 'question' } });
  });

  it('accepts the last line and refuses one past it, saying how many there are', async () => {
    expect((await call('annotate_document', { path: 'NexusFlow/src/a.ts', line: 3, text: 'ok', tag: 'todo' })).isError).toBe(false);
    const result = await call('annotate_document', { path: 'NexusFlow/src/a.ts', line: 4, text: 'too far' });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('has 3 lines');
  });

  it('does not try to count lines in a binary file', async () => {
    expect((await call('annotate_document', { path: 'blob.bin', line: 99, text: 'x' })).isError).toBe(false);
  });

  it.each([
    ['text that is missing', { path: 'plan.md', line: 1 }],
    ['a line that is missing', { path: 'plan.md', text: 'x' }],
    ['a path outside', { path: '../outside.txt', line: 1, text: 'x' }],
    ['a folder', { path: 'docs', line: 1, text: 'x' }],
    ['an unknown tag', { path: 'plan.md', line: 1, text: 'x', tag: 'urgent' }],
  ])('refuses %s', async (_n, args) => {
    expect((await call('annotate_document', args)).isError).toBe(true);
    expect(await screenLines()).toEqual([]);
  });

  it('does not repeat an identical note', async () => {
    const args = { harness: 'claude', path: 'plan.md', line: 2, text: 'Same note', tag: 'risk' };
    await call('annotate_document', args);
    expect((await call('annotate_document', args)).body.status).toBe('already_shown');
    expect(await screenLines()).toHaveLength(1);
  });
});

describe('suggest_next', () => {
  it('records the suggestion with its reason', async () => {
    const { body } = await call('suggest_next', { title: 'Answer two questions', reason: 'The build is paused on them' });
    expect(body).toMatchObject({ status: 'shown', title: 'Answer two questions' });
    expect((await screenLines())[0]).toMatchObject({ event: 'next', payload: { title: 'Answer two questions', reason: 'The build is paused on them' } });
  });

  it('can point at a file, which must be inside the workspace', async () => {
    expect((await call('suggest_next', { title: 'Read it', reason: 'Written', path: 'plan.md', line: 2 })).isError).toBe(false);
    expect((await screenLines())[0].payload).toMatchObject({ path: 'plan.md', line: 2 });
    expect((await call('suggest_next', { title: 'Read it', reason: 'Written', path: '../outside.txt' })).isError).toBe(true);
  });

  it.each([['no reason', { title: 'x' }], ['no title', { reason: 'x' }], ['a very long title', { title: 'x'.repeat(121), reason: 'y' }]])('refuses %s', async (_n, args) => {
    expect((await call('suggest_next', args)).isError).toBe(true);
  });
});

describe('set_milestone', () => {
  const step = (id: string, status: LifecycleStep['status'], extra: Partial<LifecycleStep> = {}): LifecycleStep => ({ id, title: id.toUpperCase(), status, ...extra });

  it('starts a milestone that has not started, tells the screen and refreshes the generated context', async () => {
    await seed([step('plan', 'pending')]);
    const { body } = await call('set_milestone', { id: 'plan', state: 'in_progress' });
    expect(body).toMatchObject({ status: 'started', milestone: 'plan', contextRefreshed: true });
    // It still works for one release, and says which command replaces it.
    expect(body.deprecated).toContain('`ctxspace plan start|block|done <code>`');
    expect((await stepsNow())[0]!.status).toBe('in_progress');
    expect((await screenLines())[0]).toMatchObject({ event: 'milestone', payload: { stepId: 'plan', state: 'in_progress' } });
    expect(refreshPlanningContext).toHaveBeenCalledTimes(1);
  });

  it('does nothing, and writes nothing, for a milestone already in progress', async () => {
    await seed([step('plan', 'in_progress')]);
    expect((await call('set_milestone', { id: 'plan', state: 'in_progress' })).body.status).toBe('unchanged');
    expect(await screenLines()).toEqual([]);
  });

  it('starts a blocked milestone again, which ends the block', async () => {
    await seed([step('plan', 'blocked', { blockedReason: 'Waiting' })]);
    await call('set_milestone', { id: 'plan', state: 'in_progress' });
    const [plan] = await stepsNow();
    expect(plan!.status).toBe('in_progress');
    expect(plan).not.toHaveProperty('blockedReason');
  });

  it('will not start finished work, and says to reopen it with a note', async () => {
    await seed([step('plan', 'completed')]);
    const result = await call('set_milestone', { id: 'plan', state: 'in_progress' });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('Reopen it with a note');
    expect((await stepsNow())[0]!.status).toBe('completed');
  });

  it('will not start a milestone whose dependencies are not finished', async () => {
    await seed([step('a', 'in_progress'), step('b', 'pending', { dependsOn: ['a'] })]);
    const result = await call('set_milestone', { id: 'b', state: 'in_progress' });
    expect(result.isError).toBe(true);
    expect((await stepsNow())[1]!.status).toBe('pending');
    expect(await screenLines()).toEqual([]);
  });

  it('blocks a milestone with the reason and shows it', async () => {
    await seed([step('ship', 'in_progress')]);
    const { body } = await call('set_milestone', { id: 'ship', state: 'blocked', note: 'Waiting for the release owner' });
    expect(body).toMatchObject({ status: 'blocked' });
    expect((await stepsNow())[0]).toMatchObject({ status: 'blocked', blockedReason: 'Waiting for the release owner' });
    expect((await screenLines())[0]).toMatchObject({ event: 'milestone', payload: { stepId: 'ship', state: 'blocked', note: 'Waiting for the release owner' } });
  });

  it.each([['blocked'], ['reopened'], ['done']])('requires a note for %s', async (state) => {
    await seed([step('a', 'completed'), step('b', 'in_progress')]);
    const result = await call('set_milestone', { id: state === 'reopened' ? 'a' : 'b', state });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toMatch(/Add a note/);
  });

  it('cannot block finished work', async () => {
    await seed([step('plan', 'completed')]);
    expect((await call('set_milestone', { id: 'plan', state: 'blocked', note: 'x' })).isError).toBe(true);
  });

  it('reopens finished work as the AI, with the reason, and shows it', async () => {
    await seed([step('plan', 'completed', { completedAt: '2026-10-01T00:00:00.000Z' })]);
    const { body } = await call('set_milestone', { harness: 'claude', id: 'plan', state: 'reopened', note: 'Review found a gap in step 2' });
    expect(body).toMatchObject({ status: 'reopened' });
    expect((await stepsNow())[0]).toMatchObject({ status: 'in_progress', reopenReason: 'Review found a gap in step 2' });
    expect((await readPlan(dir)).items[0]!.history!.at(-1)).toMatchObject({ by: 'claude', action: 'reopened' });
    expect((await screenLines())[0]).toMatchObject({ event: 'milestone', payload: { stepId: 'plan', state: 'reopened', note: 'Review found a gap in step 2' } });
  });

  it('finishes a milestone as the AI when it judges the work done, and shows it', async () => {
    await seed([step('plan', 'in_progress')]);
    const { body } = await call('set_milestone', { harness: 'claude', id: 'plan', state: 'done', note: 'All tests pass' });
    expect(body).toMatchObject({ status: 'done', message: expect.stringContaining('they can reopen it') });
    expect((await stepsNow())[0]!.status).toBe('completed');
    expect((await readPlan(dir)).items[0]).toMatchObject({ status: 'done', resolution: 'All tests pass' });
    expect((await readPlan(dir)).items[0]!.history!.at(-1)).toMatchObject({ by: 'claude', action: 'done' });
    expect((await screenLines())[0]).toMatchObject({ event: 'milestone', payload: { stepId: 'plan', state: 'done', note: 'All tests pass' } });
  });

  it('refuses what makes no sense: reopening unfinished work, finishing work that never started or already finished', async () => {
    await seed([step('a', 'in_progress'), step('b', 'pending'), step('c', 'completed'), step('d', 'verified')]);
    expect((await call('set_milestone', { id: 'a', state: 'reopened', note: 'x' })).text).toMatch(/nothing to reopen/);
    // Passed its check but not finished: the user sees it in progress, so there is nothing to reopen.
    expect((await call('set_milestone', { id: 'd', state: 'reopened', note: 'x' })).text).toMatch(/nothing to reopen/);
    expect((await call('set_milestone', { id: 'b', state: 'done', note: 'x' })).text).toMatch(/cannot be finished/);
    expect((await call('set_milestone', { id: 'c', state: 'done', note: 'x' })).text).toMatch(/cannot be finished/);
    expect(await screenLines()).toEqual([]);
  });

  it('points an unknown id back to get_work_context', async () => {
    await seed([step('plan', 'pending')]);
    expect((await call('set_milestone', { id: 'ghost', state: 'in_progress' })).text).toContain('get_work_context');
  });

  it('refuses a state it does not know', async () => {
    await seed([step('plan', 'pending')]);
    expect((await call('set_milestone', { id: 'plan', state: 'completed' })).isError).toBe(true);
  });
});

describe('get_screen_context', () => {
  it('says sharing is off, and tells the AI to ask in the chat, by default', async () => {
    const { body } = await call('get_screen_context', {});
    expect(body).toMatchObject({ shared: false });
    expect(body.message).toMatch(/chat/);
  });

  it('returns the view once the user has switched sharing on', async () => {
    await setScreenSharing(dir, true);
    await saveScreenContext(dir, { viewing: { path: 'plan.md', line: 3 }, selection: 'Step two' });
    const { body } = await call('get_screen_context', {});
    expect(body).toMatchObject({ shared: true, context: { viewing: { path: 'plan.md', line: 3 }, selection: 'Step two' } });
  });

  it('returns nothing after sharing is switched off again', async () => {
    await setScreenSharing(dir, true);
    await saveScreenContext(dir, { selection: 'private' });
    await setScreenSharing(dir, false);
    const { text } = await call('get_screen_context', {});
    expect(text).not.toContain('private');
  });
});
