import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as workspace from './workspace.js';
import * as config from './config.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
import { loadWorkspaceLifecycle, advanceLifecycleStep, updateLifecyclePlan, renderLifecyclePlan } from './lifecycle.js';
import { loadWorkspaceState, saveWorkspaceState } from './workspace-state.js';
import { addWorkDocument, loadWorkGuidance, updateWorkGuidance, updateWorkDocument, readWorkDocument, getWorkContext, WORK_GUIDANCE_FILE, WORK_ASSIGNMENT_FILE } from './work-guidance.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'work-guidance-'));
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({
    id: 'test', branchName: 'test', description: 'Improve invoice performance', flowType: 'feature', workType: 'performance', repos: [], assistants: [], workspacePath: root,
  }));
  const lifecycle = await loadWorkspaceLifecycle(root);
  // An authored plan fixture, independent of new-workspace defaults.
  lifecycle.steps = [
    { id: 'step_discovery', title: 'Measure current invoice timings', status: 'in_progress' },
    { id: 'step_implementation', title: 'Optimize invoice lookup', status: 'pending', dependsOn: ['step_discovery'] },
    { id: 'step_verification', title: 'Compare timings', status: 'pending', dependsOn: ['step_implementation'], requiresVerification: true },
    { id: 'step_ship', title: 'Roll out invoice lookup', status: 'pending', dependsOn: ['step_verification'] },
  ];
  lifecycle.currentStepId = 'step_discovery';
  const state = await loadWorkspaceState(root);
  await saveWorkspaceState({ ...state, lifecycle });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.rm(root, { recursive: true, force: true });
});

const source = (title = 'PO requirements') => ({ title, role: 'requirements', content: '# Requirements\n\nKeep original formatting.\n' });

describe('source documents and assignments', () => {
  it('protects active project sources before workspace deletion touches stored files', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'contextspace.json'), 'utf8'));
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ ...manifest, projectId: 'project' }));
    vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: root } as any);
    vi.spyOn(workspace, 'listWorkspaces').mockResolvedValue([]);
    const guidance = await addWorkDocument(root, 0, { ...source(), scope: { project: true } });
    await expect(workspace.deleteWorkspace(root)).rejects.toThrow('owns active project documents');
    expect((await readWorkDocument(root, guidance.documents[0].id)).content).toBe(source().content);
    await updateWorkDocument(root, guidance.documents[0].id, guidance.revision, { ...guidance.documents[0], status: 'superseded' });
    await workspace.deleteWorkspace(root);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives a workspace with no description an empty objective, not a missing one', async () => {
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'test', branchName: 'test', repos: [], assistants: [], workspacePath: root }));
    const guidance = await loadWorkGuidance(root);
    expect(guidance.assignment.objective).toBe('');
    expect(JSON.parse(JSON.stringify(guidance)).assignment).toHaveProperty('objective', '');
  });

  it('preserves the source and defaults documents to draft', async () => {
    const guidance = await addWorkDocument(root, 0, source());
    expect(guidance.documents[0].status).toBe('draft');
    const read = await readWorkDocument(root, guidance.documents[0].id);
    expect(read.content).toBe(source().content);
    expect((await loadWorkGuidance(root)).workType).toBe('performance');
    expect((await getWorkContext(root)).assignment).toContain('requirements, draft');
  });

  it('changes labels without changing the original, and excludes superseded documents from the assignment', async () => {
    let guidance = await addWorkDocument(root, 0, source());
    const doc = guidance.documents[0];
    guidance = await updateWorkDocument(root, doc.id, guidance.revision, { ...doc, status: 'approved' });
    expect((await getWorkContext(root)).assignment).toContain('requirements, approved');
    await updateWorkDocument(root, doc.id, guidance.revision, { ...doc, status: 'superseded' });
    expect((await getWorkContext(root)).assignment).not.toContain('PO requirements');
    expect((await readWorkDocument(root, doc.id)).content).toBe(source().content);
  });

  it('includes only workspace and active milestone sources', async () => {
    let guidance = await addWorkDocument(root, 0, source('Shared'));
    guidance = await addWorkDocument(root, guidance.revision, { ...source('Implementation-only'), scope: { milestoneId: 'step_implementation' } });
    guidance = await addWorkDocument(root, guidance.revision, { ...source('Review-only'), scope: { milestoneId: 'step_ship' } });
    await updateWorkGuidance(root, { ...guidance, assignment: { stage: 'design', objective: 'Design the change', expectedOutput: 'A proposal', stopCondition: 'Before implementation', milestoneId: 'step_implementation' } });
    const context = await getWorkContext(root);
    expect(context.assignment).toContain('Shared');
    expect(context.assignment).toContain('Implementation-only');
    expect(context.assignment).not.toContain('Review-only');
    expect(context.assignment).toContain('stops before implementation');
    expect(context.assignment).toContain('A proposal');
  });

  it('rejects stale saves and releases the lock for a later retry', async () => {
    const results = await Promise.allSettled([addWorkDocument(root, 0, source('A')), addWorkDocument(root, 0, source('B'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const saved = await loadWorkGuidance(root);
    expect(saved.documents).toHaveLength(1);
    await addWorkDocument(root, saved.revision, source('Retry'));
    expect((await loadWorkGuidance(root)).documents).toHaveLength(2);
  });

  it('rejects unknown scopes, unsafe URLs, and corrupt state without replacing it', async () => {
    await expect(addWorkDocument(root, 0, { ...source(), scope: { milestoneId: 'missing' } })).rejects.toThrow('existing milestone');
    await expect(addWorkDocument(root, 0, { title: 'Unsafe', role: 'reference', url: 'file:///etc/passwd' })).rejects.toThrow('HTTP');
    await fs.writeFile(path.join(root, WORK_GUIDANCE_FILE), '{bad');
    await expect(addWorkDocument(root, 0, source())).rejects.toThrow();
    expect(await fs.readFile(path.join(root, WORK_GUIDANCE_FILE), 'utf8')).toBe('{bad');
  });

  it('shares project sources by reference and immediately respects a superseded source', async () => {
    const other = path.join(root, 'other-workspace');
    await fs.mkdir(other);
    const owner = { id: 'owner', branchName: 'owner', description: 'Project requirements', repos: [], assistants: [], projectId: 'project', workspacePath: root };
    const child = { ...owner, id: 'child', branchName: 'child', workspacePath: other };
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify(owner));
    await fs.writeFile(path.join(other, 'contextspace.json'), JSON.stringify(child));
    vi.spyOn(config, 'loadConfig').mockResolvedValue({ workspacesDir: root } as any);
    vi.spyOn(workspace, 'listWorkspaces').mockResolvedValue([owner, child] as any);
    const guidance = await addWorkDocument(root, 0, { ...source(), status: 'approved', scope: { project: true } });
    const document = guidance.documents[0];
    const context = await getWorkContext(other);
    expect(context.sharedDocuments).toHaveLength(1);
    expect(context.assignment).toContain('PO requirements');
    expect((await readWorkDocument(other, document.id)).content).toBe(source().content);
    await updateWorkDocument(root, document.id, guidance.revision, { ...document, status: 'superseded' });
    expect((await getWorkContext(other)).assignment).not.toContain('PO requirements');
    expect((await readWorkDocument(other, document.id)).document.status).toBe('superseded');
  });

  it('rejects project scope without a project and refuses linked source files', async () => {
    await expect(addWorkDocument(root, 0, { ...source(), scope: { project: true } })).rejects.toThrow('registered project');
    const guidance = await addWorkDocument(root, 0, source());
    const document = guidance.documents[0];
    const original = path.join(root, document.filename!);
    await fs.unlink(original);
    const target = path.join(root, 'target.txt');
    await fs.writeFile(target, 'not an attached document');
    // Junctions work without Developer Mode on Windows; directory links must also be refused.
    await fs.symlink(process.platform === 'win32' ? root : target, original, process.platform === 'win32' ? 'junction' : 'file');
    await expect(readWorkDocument(root, document.id)).rejects.toThrow();
  });

  it('uses the selected storage adapter for both sources and guidance', async () => {
    const files = new Map<string, string>();
    class InMemoryAdapter extends LocalStorageAdapter {
      override async readWorkspaceFile(_root: string, _id: string, filename: string) {
        if (!files.has(filename)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files.get(filename)!;
      }
      override async writeWorkspaceFile(_root: string, _id: string, filename: string, content: string) { files.set(filename, content); }
      override resolveWorkspaceFileUrl(_root: string, _id: string, filename: string) { return `https://storage.example/${filename}`; }
    }
    setActiveStorageProvider(new InMemoryAdapter());
    const guidance = await addWorkDocument(root, 0, source());
    expect(files.has(WORK_GUIDANCE_FILE)).toBe(true);
    expect(files.has(WORK_ASSIGNMENT_FILE)).toBe(true);
    expect((await readWorkDocument(root, guidance.documents[0].id)).location).toContain('https://storage.example/');
    expect((await getWorkContext(root)).assignment).toContain('https://storage.example/');
  });

  it('reports a projection write failure without losing the authoritative saved assignment', async () => {
    class FailingProjection extends LocalStorageAdapter {
      override async writeWorkspaceFile(root: string, id: string, filename: string, content: string) {
        if (filename === WORK_ASSIGNMENT_FILE) throw new Error('read only projection');
        return super.writeWorkspaceFile(root, id, filename, content);
      }
    }
    setActiveStorageProvider(new FailingProjection());
    await expect(addWorkDocument(root, 0, source())).rejects.toThrow('Brief saved');
    expect((await getWorkContext(root)).guidance.documents).toHaveLength(1);
    expect((await getWorkContext(root)).assignment).toContain('PO requirements');
  });
});

describe('editable milestone definitions', () => {
  it('clears a custom verification command so the default gate can be used again', async () => {
    let lifecycle = (await loadWorkspaceLifecycle(root, { includeFleet: false }));
    lifecycle = await updateLifecyclePlan(root, { revision: 0, steps: lifecycle.steps.map((step) => ({ ...step,
      ...(step.id === 'step_implementation' ? { requiresVerification: true, verificationCommand: 'npm run special-test' } : {}),
    })) });
    lifecycle = await updateLifecyclePlan(root, { revision: lifecycle.revision, steps: lifecycle.steps.map((step) => ({ ...step,
      ...(step.id === 'step_implementation' ? { verificationCommand: '' } : {}),
    })) });
    expect(lifecycle.steps.find((step) => step.id === 'step_implementation')).toMatchObject({ requiresVerification: true });
    expect((await loadWorkspaceLifecycle(root, { includeFleet: false })).steps.find((step) => step.id === 'step_implementation')?.verificationCommand).toBeUndefined();
  });

  it('preserves progress and exports the same milestone definitions', async () => {
    let lifecycle = await advanceLifecycleStep(root, 'step_discovery', 'complete');
    const steps = lifecycle.steps.map((step) => ({ ...step, title: step.id === 'step_implementation' ? 'Optimize invoice lookup' : step.title }));
    lifecycle = await updateLifecyclePlan(root, { revision: lifecycle.revision, steps: [...steps, { id: 'rollout', title: 'Roll out gradually', dependsOn: ['step_ship'] }] });
    expect(lifecycle.steps[0].status).toBe('completed');
    // Nothing starts by itself: the next milestone is ready, not started.
    expect(lifecycle.steps[1].status).toBe('pending');
    expect(lifecycle.steps.at(-1)?.status).toBe('pending');
    expect(renderLifecyclePlan(lifecycle)).toContain('Optimize invoice lookup');
    expect(renderLifecyclePlan(lifecycle)).toContain('Roll out gradually');
  });

  it('rejects cycles and stale plan revisions without losing saved steps', async () => {
    const lifecycle = (await loadWorkspaceLifecycle(root, { includeFleet: false }));
    const cycle = lifecycle.steps.map((step) => ({ ...step, dependsOn: step.id === 'step_discovery' ? ['step_ship'] : step.dependsOn }));
    await expect(updateLifecyclePlan(root, { revision: 0, steps: cycle })).rejects.toThrow('cycle');
    await updateLifecyclePlan(root, { revision: 0, steps: lifecycle.steps });
    await expect(updateLifecyclePlan(root, { revision: 0, steps: lifecycle.steps })).rejects.toThrow('another session');
    expect((await loadWorkspaceLifecycle(root, { includeFleet: false })).steps).toHaveLength(4);
  });

  it('validates retained dependencies when optional fields are omitted from an edit', async () => {
    const lifecycle = (await loadWorkspaceLifecycle(root, { includeFleet: false }));
    const steps = lifecycle.steps.map((step) => ({ id: step.id, title: step.title,
      ...(step.id === 'step_discovery' ? { dependsOn: ['step_ship'] } : {}),
    }));
    await expect(updateLifecyclePlan(root, { revision: 0, steps })).rejects.toThrow('cycle');
    expect((await loadWorkspaceLifecycle(root, { includeFleet: false })).revision ?? 0).toBe(0);
  });

  it('blocks changing completed gate dependencies', async () => {
    const lifecycle = await advanceLifecycleStep(root, 'step_discovery', 'complete');
    const steps = lifecycle.steps.map((step) => step.id === 'step_discovery' ? { ...step, requiresVerification: true } : step);
    await expect(updateLifecyclePlan(root, { revision: lifecycle.revision, steps })).rejects.toThrow('Completed milestone');
  });
});
