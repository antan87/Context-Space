import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanningNotes, savePlanningNotes, hasAuthoredPlanningRows, planningNotesAreAuthored, PLANNING_NOTES_FILE } from './planning-notes.js';
import { ensureWorkGuidance, loadWorkGuidance, WORK_GUIDANCE_FILE } from './work-guidance.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';
import { setActiveStorageProvider } from './adapters/registry.js';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-notes-'));
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'notes', branchName: 'notes', description: 'Plan', repos: [], assistants: [] }));
});
afterEach(async () => { vi.restoreAllMocks(); setActiveStorageProvider(new LocalStorageAdapter()); await fs.rm(root, { recursive: true, force: true }); });
it('reads the template while no notes file exists, never creates one, and initializes the brief once', async () => {
  // The notes file is retired: refresh moves it into the plan instead of creating it.
  const initial = await readPlanningNotes(root);
  expect(initial.content).toContain('Owner');
  await expect(fs.stat(path.join(root, PLANNING_NOTES_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  await savePlanningNotes(root, initial.revision, '# My authored release sequence\n');
  expect((await readPlanningNotes(root)).content).toBe('# My authored release sequence\n');
  await ensureWorkGuidance(root);
  const saved = await fs.readFile(path.join(root, WORK_GUIDANCE_FILE), 'utf8');
  await ensureWorkGuidance(root);
  expect(await fs.readFile(path.join(root, WORK_GUIDANCE_FILE), 'utf8')).toBe(saved);
  expect((await loadWorkGuidance(root)).revision).toBe(1);
});
it('rejects concurrent stale saves and permits retry after reloading', async () => {
  const initial = await readPlanningNotes(root);
  const writes = await Promise.allSettled([savePlanningNotes(root, initial.revision, 'A'), savePlanningNotes(root, initial.revision, 'B')]);
  expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  await savePlanningNotes(root, (await readPlanningNotes(root)).revision, 'Merged notes');
  expect((await readPlanningNotes(root)).content).toBe('Merged notes');
});
it('routes authored documents through configured storage and recovers from write failure', async () => {
  const adapter = new LocalStorageAdapter();
  const documents = new Map<string, string>();
  const read = vi.spyOn(adapter, 'readWorkspaceFile').mockImplementation(async (_root, _id, filename) => {
    if (!documents.has(filename)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return documents.get(filename)!;
  });
  const write = vi.spyOn(adapter, 'writeWorkspaceFile').mockImplementation(async (_root, _id, filename, content) => { documents.set(filename, content); });
  setActiveStorageProvider(adapter);
  const current = await readPlanningNotes(root);
  write.mockRejectedValueOnce(new Error('Offline'));
  await expect(savePlanningNotes(root, current.revision, 'new')).rejects.toThrow('Offline');
  expect((await readPlanningNotes(root)).revision).toBe(current.revision);
  await savePlanningNotes(root, current.revision, 'recovered');
  expect(read).toHaveBeenCalledWith(root, 'notes', PLANNING_NOTES_FILE);
  expect(documents.get(PLANNING_NOTES_FILE)).toBe('recovered');
  await expect(fs.stat(path.join(root, PLANNING_NOTES_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('tells the empty planning-notes template from notes that have been written', async () => {
  const initial = await readPlanningNotes(root);
  expect(hasAuthoredPlanningRows(initial.content)).toBe(false);
  expect(await planningNotesAreAuthored(root)).toBe(false);
  await savePlanningNotes(root, initial.revision, initial.content.replace('| --- | --- | --- | --- | --- |\n', '| --- | --- | --- | --- | --- |\n| m1 | Ship the producer | api | none | first |\n'));
  expect(await planningNotesAreAuthored(root)).toBe(true);
});
it('does not count prose, table headers or separators as authored planning rows', () => {
  expect(hasAuthoredPlanningRows('')).toBe(false);
  expect(hasAuthoredPlanningRows('# Plan\n\nSome prose that mentions | a pipe.\n')).toBe(false);
  expect(hasAuthoredPlanningRows('| A | B |\n| --- | --- |\n')).toBe(false);
  expect(hasAuthoredPlanningRows('| A | B |\r\n| :--- | ---: |\r\n')).toBe(false);
  expect(hasAuthoredPlanningRows('| A | B |\n| --- | --- |\n| 1 | 2 |\n')).toBe(true);
});
it('never throws when the planning notes cannot be read', async () => {
  await fs.rm(path.join(root, 'contextspace.json'));
  expect(await planningNotesAreAuthored(root)).toBe(false);
});
