import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { collectDiagnostics, previewDiagnostics, reviewedDiagnostics, readDiagnosticCandidate, saveDiagnosticFile } from './diagnostics.js';
import { getStorageProvider, setActiveStorageProvider } from './adapters/registry.js';
import { LocalStorageAdapter } from './adapters/local-storage.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

let root: string;
const canary = 'ghp_SENSITIVE_TEST_VALUE_123456789012345';
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cs-diagnostics-')));
  setActiveStorageProvider(getStorageProvider('local'));
});
afterEach(async () => { vi.restoreAllMocks(); setActiveStorageProvider(getStorageProvider('local')); await fs.rm(root, { recursive: true, force: true }); });

async function fixture(legacy = false) {
  const repo = path.join(root, canary);
  await fs.mkdir(repo);
  await fs.writeFile(path.join(root, legacy ? 'nexusflow.json' : 'contextspace.json'), JSON.stringify({
    id: canary, branchName: canary, description: canary, workspacePath: root, mode: 'in-place', repos: [repo],
    projectId: canary, env: { TOKEN: canary },
  }));
  await fs.writeFile(path.join(root, legacy ? 'nexusflow-knowledge.md' : 'contextspace-knowledge.md'), canary);
  // The plan file has one name, PLAN.md, whatever the brand of the rest.
  await fs.writeFile(path.join(root, 'PLAN.md'), canary);
  for (const dir of ['.contextspace', '.contextspace-logs', 'workrooms']) await fs.mkdir(path.join(root, dir));
  for (const file of ['.contextspace/chat.jsonl', '.contextspace-logs/service.log', 'workrooms/host-credential.json', 'contextspace-work.json']) {
    await fs.writeFile(path.join(root, file), canary);
  }
}

describe('status-only diagnostics', () => {
  it.each([false, true])('keeps primary/legacy profile contents untouched and never reads excluded content (%s)', async legacy => {
    await fixture(legacy);
    const read = vi.spyOn(fs, 'readFile');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
    const preview = await collectDiagnostics(root);
    const text = JSON.stringify(preview);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(root);
    expect(preview.report.sections.workspace).toMatchObject({ alias: 'workspace-1', repositoryCount: 1, projectLinked: true });
    expect(preview.report.sections.checks?.every(check => check.status === 'present')).toBe(true);
    expect(read.mock.calls.some(([filename]) => /knowledge|plan\.md|PLAN\.md|chat|service\.log|credential|contextspace-work/.test(String(filename)))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, 'contextspace-work.json'), 'utf8')).toBe(canary);
    expect(await fs.readFile(path.join(root, '.contextspace/chat.jsonl'), 'utf8')).toBe(canary);
  });

  it('does not invoke a plugin adapter or serialize its private name/settings/errors', async () => {
    await fixture();
    const adapter = new LocalStorageAdapter();
    Object.defineProperty(adapter, 'meta', { value: { name: canary } });
    const exists = vi.spyOn(adapter, 'workspaceFileExists').mockRejectedValue(new Error(canary));
    setActiveStorageProvider(adapter);
    const preview = await collectDiagnostics(root);
    expect(exists).not.toHaveBeenCalled();
    expect(preview.report.sections.workspace?.storage).toBe('plugin');
    expect(preview.report.sections.checks?.filter(c => c.id !== 'repository-directory').every(c => c.status === 'not-checked')).toBe(true);
    expect(preview.content).not.toContain(canary);
  });

  it('does not trust a replacement adapter merely because it calls itself local', async () => {
    await fixture();
    const replacement = new LocalStorageAdapter();
    const exists = vi.spyOn(replacement, 'workspaceFileExists').mockRejectedValue(new Error(canary));
    setActiveStorageProvider(replacement);
    const preview = await collectDiagnostics(root);
    expect(exists).not.toHaveBeenCalled();
    expect(preview.report.sections.workspace?.storage).toBe('plugin');
    expect(preview.report.sections.checks?.filter(c => c.id !== 'repository-directory').every(c => c.status === 'not-checked')).toBe(true);
  });

  it('exports the captured bytes after source changes, and binds confirmation to the redacted selection', async () => {
    await fixture();
    const original = await collectDiagnostics(root);
    const redacted = previewDiagnostics(original.report, ['runtime', 'workspace']);
    expect(original.report.sections.runtime).toBeDefined();
    expect(redacted.report.sections.runtime).toBeUndefined();
    expect(redacted.report.omittedSections).toEqual(['runtime', 'workspace']);
    expect(() => reviewedDiagnostics(redacted.report, original.digest)).toThrow('changed');
    await fs.rm(path.join(root, canary), { recursive: true });
    expect((await collectDiagnostics(root)).digest).not.toBe(original.digest);
    const file = path.join(root, 'candidate.json');
    await saveDiagnosticFile(file, redacted.content);
    const candidate = await readDiagnosticCandidate(file);
    const accepted = reviewedDiagnostics(candidate, redacted.digest);
    await saveDiagnosticFile(path.join(root, 'report.json'), accepted.content);
    expect(await fs.readFile(path.join(root, 'report.json'), 'utf8')).toBe(redacted.content);
    expect(createHash('sha256').update(accepted.content).digest('hex')).toBe(redacted.digest);
  });

  it('rejects unknown fields, arbitrary strings, unsupported schemas and false omission manifests', async () => {
    const preview = await collectDiagnostics();
    for (const invalid of [
      { ...preview.report, logs: canary },
      { ...preview.report, schemaVersion: 2 },
      { ...preview.report, omittedSections: [] },
      { ...preview.report, excludedData: [] },
      { ...preview.report, sections: { runtime: { ...preview.report.sections.runtime, platform: canary } } },
      { ...preview.report, sections: { checks: [{ id: 'repository-directory', target: canary, status: 'present' }] } },
    ]) expect(() => previewDiagnostics(invalid)).toThrow('Invalid diagnostic');
    expect(() => previewDiagnostics(preview.report, [canary])).toThrow('Invalid diagnostic');
  });

  it('reports missing repositories using fixed status codes and hides malformed-manifest errors', async () => {
    await fixture();
    await fs.rm(path.join(root, canary), { recursive: true });
    expect((await collectDiagnostics(root)).report.sections.checks?.[0]).toEqual({ id: 'repository-directory', target: 'repository-1', status: 'missing' });
    await fs.writeFile(path.join(root, 'contextspace.json'), canary);
    await expect(collectDiagnostics(root)).rejects.toThrow('Could not read workspace metadata');
  });
});

describe('diagnostic file failures', () => {
  it('preserves existing output, including a concurrent destination creation', async () => {
    const destination = path.join(root, 'existing.json');
    await fs.writeFile(destination, 'original');
    await expect(saveDiagnosticFile(destination, 'new')).rejects.toThrow('Could not save');
    expect(await fs.readFile(destination, 'utf8')).toBe('original');
    expect((await fs.readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('cleans staged bytes and retains sources when publication fails', async () => {
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error(canary), { code: 'EACCES' }));
    await expect(saveDiagnosticFile(path.join(root, 'report.json'), '{}')).rejects.toThrow('Could not save diagnostics.');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('refuses linked destinations/candidates and oversized or malformed candidates', async () => {
    const file = path.join(root, 'source');
    await fs.writeFile(file, canary);
    await fs.symlink(file, path.join(root, 'linked'));
    await expect(saveDiagnosticFile(path.join(root, 'linked'), '{}')).rejects.toThrow('Could not save');
    await expect(readDiagnosticCandidate(path.join(root, 'linked'))).rejects.toThrow('Could not read');
    await expect(readDiagnosticCandidate(file)).rejects.toThrow('Could not read');
    await fs.writeFile(file, ' '.repeat(1024 * 1024 + 2));
    await expect(readDiagnosticCandidate(file)).rejects.toThrow('Could not read');
    await expect(saveDiagnosticFile(path.join(root, 'missing', 'report'), '{}')).rejects.toThrow('Could not save');
  });
});
