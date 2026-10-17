import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPortableWorkroomPreview } from './portable.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { getStorageProvider, setActiveStorageProvider } from '../core/adapters/registry.js';

const roots: string[] = [];
afterEach(async () => { setActiveStorageProvider(getStorageProvider('local')); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-portable-data-')); roots.push(root);
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'fixture', branchName: 'fixture', workspacePath: root, repos: [], createdAt: '2026-01-01T00:00:00Z' }));
  return root;
}

describe('Workroom data preview ownership', () => {
  it.each(['contextspace', 'nexusflow'])('includes the plan and the %s handoff, and warns without pretending to redact', async brand => {
    const root = await fixture();
    const plan = 'token=synthetic-value-that-should-be-reviewed';
    await fs.writeFile(path.join(root, 'PLAN.md'), plan);
    await fs.writeFile(path.join(root, `${brand}-handoff.md`), '# Handoff');
    const preview = await buildPortableWorkroomPreview(root);
    expect(preview.documents.plan).toBe(plan);
    expect(preview.documents.handoff).toBe('# Handoff');
    expect(preview.warnings.plan).toContain('Possible secret assignment detected.');
  });

  it('reads reviewed documents from their configured adapter, not stray local files', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, 'PLAN.md'), 'wrong local document');
    const adapter = new LocalStorageAdapter();
    adapter.readWorkspaceFile = async (_root, _id, name) => name === 'PLAN.md' ? 'adapter plan' : name === 'contextspace-handoff.md' ? 'adapter handoff' : '';
    setActiveStorageProvider(adapter);
    const preview = await buildPortableWorkroomPreview(root);
    expect(preview.documents.plan).toBe('adapter plan');
    expect(preview.documents.handoff).toBe('adapter handoff');
  });
});
