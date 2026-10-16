import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateProgression, validateOverrideReason } from './progression-policy.js';
import { changePlan, mutatePlan } from './plan.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';

const user = { actor: { by: 'user' } } as const;

describe('finishing and the plan', () => {
  let root: string;
  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'progression-plan-'));
    // No repositories, so only the plan decides.
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'f', branchName: 'f', repos: [], assistants: [], workspacePath: root }));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('is ready with an empty plan', async () => {
    expect(await evaluateProgression(root)).toMatchObject({ ready: true, blockers: [], warnings: [], plan: { blocking: [], open: [] } });
  });

  it('stops on what a milestone waits for, through what that waits for, and only warns about the rest', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'CSV export endpoint' }, user);
    await changePlan(root, { type: 'add', kind: 'task', title: 'Job queue', before: ['M1'] }, user);
    await changePlan(root, { type: 'add', kind: 'question', title: 'Which time zone?', owner: 'user', before: ['T1'] }, user);
    await changePlan(root, { type: 'add', kind: 'task', title: 'Docs' }, user);
    await changePlan(root, { type: 'add', kind: 'decision', title: 'Excel export' }, user);
    await changePlan(root, { type: 'later', id: 'D1', revisitWhen: 'after release' }, user);

    const decision = await evaluateProgression(root);
    expect(decision.ready).toBe(false);
    expect(decision.plan.blocking).toEqual([
      { id: 'T1', label: 'T1 Job queue', status: 'to do', heldUpBy: ['M1 CSV export endpoint'] },
      { id: 'Q1', label: 'Q1 Which time zone?', status: 'to do', heldUpBy: ['T1 Job queue'] },
    ]);
    expect(decision.blockers).toEqual([
      'M1 CSV export endpoint waits for T1 Job queue, which is to do. Finish, answer or drop it in the plan.',
      'T1 Job queue waits for Q1 Which time zone?, which is to do. Finish, answer or drop it in the plan.',
    ]);
    // Later counts as handled; the milestone itself and the other task only warn.
    expect(decision.warnings).toEqual(['M1 CSV export endpoint is still to do.', 'T2 Docs is still to do.']);

    await changePlan(root, { type: 'answer', id: 'Q1', answer: 'UTC' }, user);
    await changePlan(root, { type: 'drop', id: 'T1', reason: 'Exports are small enough' }, user);
    expect(await evaluateProgression(root)).toMatchObject({ ready: true, blockers: [] });
  });

  it('stops on a proposal saved under the earlier rule that still waits for the user\'s OK', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Endpoint' }, user);
    await changePlan(root, { type: 'add', kind: 'task', title: 'Job queue', owner: 'user', before: ['M1'] }, user);
    await mutatePlan(root, (plan) => {
      plan.items[1]!.proposal = { action: 'done', by: 'claude', note: 'Queue works', at: '2026-10-01T00:00:00.000Z' };
    });
    const decision = await evaluateProgression(root);
    expect(decision.plan.blocking).toEqual([expect.objectContaining({ id: 'T1', status: "waiting for the user's OK" })]);
    expect(decision.ready).toBe(false);
  });

  it('stops when the plan cannot be read, since nobody can tell what it waits for', async () => {
    await fs.writeFile(path.join(root, 'contextspace-plan.json'), '{ broken');
    const decision = await evaluateProgression(root);
    expect(decision.ready).toBe(false);
    expect(decision.blockers[0]).toMatch(/^The plan cannot be read: /);
  });

  it('asks the override for a reason that covers the plan too', () => {
    expect(validateOverrideReason('short')).toMatch(/why the workspace may be finished anyway/);
    expect(validateOverrideReason('The open question is answered in the PR')).toBeNull();
  });
});
