import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { changePlan } from './plan.js';
import { addToPlan, answerDecision, setDone } from './plan-file.js';
import { changePlanFile, movePlanToFile, readPlanChanges, readPlanChecks, readPlanFile, runPlanCheck } from './plan-file-store.js';
import { loadWorkspaceState, mutateWorkspaceState } from './workspace-state.js';

vi.mock('./verify.js', () => ({
  verifyWorkspace: vi.fn(async () => ({ repos: [{ headSha: 'c9043b3aaaa' }], overallStatus: 'passed', canProgress: true })),
}));

let root: string;
const user = { actor: { by: 'user' } } as const;
const PLAN = '# Reports\n\n## Checkpoints\n\n- [ ] Reports export to CSV\n  Check: `npm test`\n  - [ ] Write the CSV writer\n  - [ ] Decide: Export archived reports?\n';

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plan-file-')));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [], assistants: [], workspacePath: root }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const exists = (file: string) => fs.access(path.join(root, file)).then(() => true, () => false);

describe('reading the plan', () => {
  it('reads PLAN.md, or no plan at all', async () => {
    expect((await readPlanFile(root)).source).toBe('none');
    await fs.writeFile(path.join(root, 'PLAN.md'), PLAN);
    const read = await readPlanFile(root);
    expect(read.source).toBe('file');
    expect(read.plan.checkpoints[0]!.steps.map((step) => step.text)).toEqual(['Write the CSV writer']);
  });

  it('shows an older store as the PLAN.md it will become, without writing anything', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Reports export to CSV' }, user);
    const read = await readPlanFile(root);
    expect(read.source).toBe('store');
    expect(read.plan.title).toBe('Reports');
    expect(read.plan.checkpoints.map((checkpoint) => checkpoint.title)).toEqual(['Reports export to CSV']);
    expect(await exists('PLAN.md')).toBe(false);
    expect(await exists('contextspace-plan.json')).toBe(true);
  });
});

describe('changing the plan', () => {
  it('moves an older store over on the first change, with its checks, and keeps the old file in the archive', async () => {
    await changePlan(root, { type: 'add', kind: 'milestone', title: 'Reports export to CSV' }, user);
    await mutateWorkspaceState(root, (state) => { state.planEvidence = { M1: { canProgress: true, lastVerificationStatus: 'passed', at: '2026-10-16T10:00:00.000Z' } }; });
    const read = await changePlanFile(root, (text) => setDone(text, 'reports-export-to-csv', true), { by: 'user' });
    expect(read.source).toBe('file');
    expect(read.plan.checkpoints[0]!.done).toBe(true);
    expect(await exists('contextspace-plan.json')).toBe(false);
    expect(await exists('contextspace-plan.md')).toBe(false);
    expect((await fs.readdir(path.join(root, '.contextspace/archive'))).some((file) => file.startsWith('contextspace-plan-'))).toBe(true);
    expect((await readPlanChecks(root))['reports-export-to-csv']).toMatchObject({ canProgress: true });
    expect((await readPlanChanges(root)).map((change) => `${change.by} ${change.action} ${change.text}`)).toEqual(['user ticked Reports export to CSV']);
    expect(await movePlanToFile(root)).toBe(false);
  });

  it('logs what an AI changed in the file itself, apart from what the user changed in the app', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), PLAN);
    await readPlanFile(root);
    expect(await readPlanChanges(root)).toEqual([]);
    await fs.writeFile(path.join(root, 'PLAN.md'), addToPlan(setDone(PLAN, 'write-the-csv-writer', true), { step: 'Add the button' }, { checkpoint: 'reports-export-to-csv' }).text);
    await changePlanFile(root, (text) => answerDecision(text, 'export-archived-reports', 'Yes'), { by: 'user' });
    expect((await readPlanChanges(root)).map((change) => `${change.by} ${change.action} ${change.kind} ${change.text}${change.note ? `: ${change.note}` : ''}`)).toEqual([
      'user answered decision Export archived reports?: Yes',
      'file added step Add the button',
      'file ticked step Write the CSV writer',
    ]);
  });

  it('writes nothing when the change changes nothing', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), PLAN);
    const before = (await fs.stat(path.join(root, 'PLAN.md'))).mtimeMs;
    await changePlanFile(root, (text) => text, { by: 'user' });
    expect((await fs.stat(path.join(root, 'PLAN.md'))).mtimeMs).toBe(before);
  });
});

describe('a checkpoint check', () => {
  it('runs its command and keeps the result as its proof, without ticking it', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), PLAN);
    const { verifyWorkspace } = await import('./verify.js');
    const evidence = await runPlanCheck(root, 'reports-export-to-csv');
    expect(verifyWorkspace).toHaveBeenCalledWith(root, expect.objectContaining({ command: 'npm test' }));
    expect(evidence).toMatchObject({ canProgress: true, lastVerificationSha: 'c9043b3aaaa' });
    expect((await loadWorkspaceState(root)).planChecks?.['reports-export-to-csv']).toMatchObject({ canProgress: true });
    expect((await readPlanFile(root)).plan.checkpoints[0]!.done).toBe(false);
    await expect(runPlanCheck(root, 'nope')).rejects.toThrow(/no checkpoint/);
  });
});
