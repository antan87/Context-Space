import { beforeEach, afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWorkspaceLifecycle, updateLifecyclePlan, renderLifecyclePlan } from './lifecycle.js';
import { loadWorkspaceState, saveWorkspaceState } from './workspace-state.js';
import { legacyDefaultSteps } from './legacy-lifecycle.js';
import { planStoreExists } from './plan.js';
import { addWorkDocument, updateWorkDocument, getWorkContext } from './work-guidance.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'optional-milestones-'));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'test', branchName: 'test', description: 'Document browser', repos: [], assistants: [] }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('keeps a new plan empty and supports adding and removing feature-specific outcomes', async () => {
  const initial = await loadWorkspaceLifecycle(root);
  expect(initial.steps).toEqual([]);
  expect(renderLifecyclePlan(initial)).toBe('');
  const added = await updateLifecyclePlan(root, { revision: 0, steps: [{ id: 'docs', title: 'Open root documents' }] });
  expect(added.steps[0]).toMatchObject({ title: 'Open root documents', status: 'pending' });
  const cleared = await updateLifecyclePlan(root, { revision: added.revision, steps: [] });
  expect(cleared.steps).toEqual([]);
  expect(cleared.currentStepId).toBeUndefined();
  expect((await loadWorkspaceLifecycle(root)).steps).toEqual([]);
  await expect(updateLifecyclePlan(root, { revision: added.revision, steps: added.steps })).rejects.toThrow('another session');
});

it.each(['quick', 'feature', 'epic'] as const)('retires only an untouched legacy %s template', async (flowType) => {
  const steps = legacyDefaultSteps(flowType, 'test', 'test');
  await saveWorkspaceState({ workspacePath: root, repos: {}, updatedAt: '', lifecycle: {
    workspaceId: 'test', flowType, currentStepId: steps[0].id, steps, updatedAt: '',
  } });
  expect((await getWorkContext(root)).lifecycle?.steps).toEqual([]);
  expect((await loadWorkspaceState(root)).lifecycle?.steps).toEqual(steps);
  expect((await loadWorkspaceLifecycle(root)).steps).toEqual([]);
  // Retired, not moved: the template never becomes part of the plan store.
  expect((await loadWorkspaceState(root)).lifecycle).toMatchObject({ steps: [], movedToPlanAt: expect.any(String) });
  expect(await planStoreExists(root)).toBe(false);
});

it.each(['edited', 'progressed', 'saved'] as const)('preserves an %s legacy plan', async (kind) => {
  const steps = legacyDefaultSteps('feature', 'test', 'test');
  if (kind === 'edited') steps[0].title = 'Open Markdown reports';
  if (kind === 'progressed') steps[0].status = 'completed';
  await saveWorkspaceState({ workspacePath: root, repos: {}, updatedAt: '', lifecycle: {
    workspaceId: 'test', flowType: 'feature', currentStepId: steps[0].id, steps, updatedAt: '', ...(kind === 'saved' ? { revision: 1 } : {}),
  } });
  expect((await loadWorkspaceLifecycle(root)).steps).toEqual(steps);
});

it('rejects dangling dependencies and preserves the saved plan after a failed removal', async () => {
  const plan = await updateLifecyclePlan(root, { revision: 0, steps: [{ id: 'docs', title: 'Browse documents' }, { id: 'preview', title: 'Preview documents', dependsOn: ['docs'] }] });
  await expect(updateLifecyclePlan(root, { revision: plan.revision, steps: [plan.steps[1]] })).rejects.toThrow('does not name a milestone');
  expect((await loadWorkspaceLifecycle(root)).steps).toEqual(plan.steps);
});

it('requires moving document scopes before deleting a referenced milestone', async () => {
  const plan = await updateLifecyclePlan(root, { revision: 0, steps: [{ id: 'docs', title: 'Browse documents' }] });
  const guidance = await addWorkDocument(root, 0, { title: 'Evidence', role: 'evidence', content: 'Screenshot notes', scope: { milestoneId: 'docs' } });
  await expect(updateLifecyclePlan(root, { revision: plan.revision, steps: [] })).rejects.toThrow('Move the assignment and document scopes');
  await updateWorkDocument(root, guidance.documents[0].id, guidance.revision, { ...guidance.documents[0], scope: {} });
  expect((await updateLifecyclePlan(root, { revision: plan.revision, steps: [] })).steps).toEqual([]);
});
