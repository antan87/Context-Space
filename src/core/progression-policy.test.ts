import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateProgression, validateOverrideReason } from './progression-policy.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';


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

  it('stops on a checkpoint that is not ticked, and only warns about other open steps and decisions', async () => {
    await fs.writeFile(path.join(root, 'PLAN.md'), [
      '# CSV export', '', '## Checkpoints', '',
      '- [x] Report rows load fast',
      '- [ ] CSV export endpoint', '  - [x] Job queue', '  - [ ] Decide: Which time zone?',
      '', '## Steps', '', '- [ ] Docs', '- [x] Tidy up', '', '## Decisions', '', '- [ ] Decide: Keep the PDF export?', '',
    ].join('\n'));

    const decision = await evaluateProgression(root);
    expect(decision.ready).toBe(false);
    expect(decision.plan.blocking).toEqual([{ id: 'csv-export-endpoint', label: 'CSV export endpoint', status: '1 of 1 steps done', heldUpBy: [] }]);
    expect(decision.blockers).toEqual(['The checkpoint "CSV export endpoint" is not done (1 of 1 steps done). Tick it in PLAN.md once it is, or rewrite the plan.']);
    expect(decision.warnings).toEqual(['"Docs" is still open.', '"Keep the PDF export?" is still waiting for your answer.']);

    await fs.writeFile(path.join(root, 'PLAN.md'), '# CSV export\n\n## Checkpoints\n\n- [x] Report rows load fast\n- [x] CSV export endpoint\n');
    expect(await evaluateProgression(root)).toMatchObject({ ready: true, blockers: [] });
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
