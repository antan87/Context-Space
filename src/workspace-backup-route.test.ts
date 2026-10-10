import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';

import { app } from './server.js';
import * as configModule from './core/config.js';
import { PRIMARY_KNOWLEDGE_FILE, PRIMARY_MANIFEST_FILE } from './core/constants.js';
import { ensureWorkspaceGitRepository } from './core/workspace-git.js';
import { LocalStorageAdapter } from './core/adapters/local-storage.js';
import { setActiveStorageProvider } from './core/adapters/registry.js';

let root: string;

beforeEach(async () => {
  setActiveStorageProvider(new LocalStorageAdapter());
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-backup-route-'));
  vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
    version: '1.0', devDir: '/dev', workspacesDir: root, defaultAssistant: null, scanDepth: 2,
  } as any);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setActiveStorageProvider(new LocalStorageAdapter());
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

async function makeWorkspace(id: string, knowledge?: string) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, PRIMARY_MANIFEST_FILE), JSON.stringify({
    id, branchName: id, description: 'x', mode: 'in-place', repos: [], assistants: [], workspacePath: dir, createdAt: new Date().toISOString(),
  }), 'utf8');
  if (knowledge) await fs.writeFile(path.join(dir, PRIMARY_KNOWLEDGE_FILE), knowledge, 'utf8');
  await ensureWorkspaceGitRepository(dir);
  return dir;
}

const knowledge = '# Workspace Knowledge — ws\n\n## Known Gotchas\n\n- **2026-10-09:** a hard-won lesson that exists nowhere else\n';

describe('GET /api/workspace/:id/backup', () => {
  it('says the notes are at risk when there is no remote', async () => {
    await makeWorkspace('ws', knowledge);

    const res = await app.request('/api/workspace/ws/backup');
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.backup).toMatchObject({ atRisk: true, remote: { state: 'none' }, handWritten: { knowledgeEntries: 1, planningNotes: false } });
    expect(body.backup.message).toContain('`ctxspace remote add <git-url>`');
  });

  it('shows the remote, with any credential removed, and no risk once one is set', async () => {
    const dir = await makeWorkspace('ws', knowledge);
    await execa('git', ['remote', 'add', 'origin', 'https://someone:ghp_secrettoken@example.com/team/notes.git'], { cwd: dir });

    const res = await app.request('/api/workspace/ws/backup');
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain('ghp_secrettoken');
    expect(JSON.parse(text).backup).toMatchObject({ atRisk: false, message: null, remote: { state: 'configured', name: 'origin', url: 'https://***@example.com/team/notes.git' } });
  });

  it('refuses a workspace id that tries to leave the workspaces folder', async () => {
    await makeWorkspace('ws', knowledge);

    const res = await app.request('/api/workspace/..%2Fws/backup');

    expect(res.status).not.toBe(200);
  });
});

describe('the backup status stays read-only', () => {
  it('has no way to add a remote or push through the API', async () => {
    const dir = await makeWorkspace('ws', knowledge);
    const attempts = [
      app.request('/api/workspace/ws/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/evil.git' }) }),
      app.request('/api/workspace/ws/remote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/evil.git' }) }),
      app.request('/api/workspace/ws/remote/push', { method: 'POST' }),
    ];

    for (const res of await Promise.all(attempts)) expect(res.status).toBeGreaterThanOrEqual(400);
    const remotes = await execa('git', ['remote'], { cwd: dir });
    expect(remotes.stdout).toBe('');
  });
});
