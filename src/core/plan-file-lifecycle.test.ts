import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { advanceLifecycleStep, blockLifecycleStep, loadWorkspaceLifecycle, readWorkspaceLifecycle, reopenLifecycleStep, updateLifecyclePlan } from './lifecycle.js';
import { parsePlanFile } from './plan-file.js';
import { readPlanChanges } from './plan-file-store.js';

const check = vi.hoisted(() => ({ result: { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def' }] } as unknown }));
vi.mock('./verify.js', () => ({ verifyWorkspace: vi.fn(async () => check.result) }));

const PLAN = `# Reports

## Checkpoints

- [x] Report rows load fast
- [ ] Reports export to CSV
  Check: \`npm test\`
  - [x] Write the CSV writer
- [ ] Export button in the UI
`;

let root: string;
const file = async () => parsePlanFile(await fs.readFile(path.join(root, 'PLAN.md'), 'utf8'));

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plan-file-lifecycle-')));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [], assistants: [], workspacePath: root }));
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('the milestones, read from PLAN.md', () => {
  it('are the checkpoints in order: ticked is completed, the first open one is current, the next open one next', async () => {
    const lifecycle = await readWorkspaceLifecycle(root);
    expect(lifecycle.steps.map((step) => [step.id, step.status, step.requiresVerification ?? false])).toEqual([
      ['report-rows-load-fast', 'completed', false],
      ['reports-export-to-csv', 'in_progress', true],
      ['export-button-in-the-ui', 'pending', false],
    ]);
    expect(lifecycle).toMatchObject({ currentStepId: 'reports-export-to-csv', nextStepId: 'export-button-in-the-ui' });
    // Reading writes nothing older.
    await loadWorkspaceLifecycle(root, { includeFleet: false });
    await expect(fs.access(path.join(root, 'contextspace-plan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finish a checkpoint by running its check first, and tick it only when it passes', async () => {
    check.result = { overallStatus: 'fail', canProgress: false, repos: [{ headSha: 'abc1234def' }] };
    await expect(advanceLifecycleStep(root, 'reports-export-to-csv', 'complete', { by: 'agent', harness: 'claude' })).rejects.toThrow(/did not permit progress/);
    expect((await file()).checkpoints[1]!.done).toBe(false);
    check.result = { overallStatus: 'pass', canProgress: true, repos: [{ headSha: 'abc1234def' }] };
    const lifecycle = await advanceLifecycleStep(root, 'reports-export-to-csv', 'complete', { by: 'agent', harness: 'claude' });
    expect(lifecycle.steps[1]!.status).toBe('completed');
    expect((await readPlanChanges(root))[0]).toMatchObject({ by: 'claude', action: 'ticked', text: 'Reports export to CSV' });
  });

  it('reopen a finished checkpoint with what is wrong as a step under it', async () => {
    await reopenLifecycleStep(root, 'report-rows-load-fast', { reason: 'Slow again on big reports', by: 'user' });
    const checkpoint = (await file()).checkpoints[0]!;
    expect(checkpoint.done).toBe(false);
    expect(checkpoint.steps.map((step) => step.text)).toEqual(['Reopened: Slow again on big reports']);
    await expect(reopenLifecycleStep(root, 'export-button-in-the-ui', { reason: 'x', by: 'user' })).rejects.toThrow(/nothing to reopen/);
  });

  it('say that blocking and the old milestone list are written in PLAN.md now', async () => {
    await expect(blockLifecycleStep(root, 'export-button-in-the-ui', { reason: 'No design' })).rejects.toThrow(/under it, in the file/);
    await expect(updateLifecyclePlan(root, { revision: 0, steps: [] })).rejects.toThrow(/edit its Checkpoints list/);
  });
});
