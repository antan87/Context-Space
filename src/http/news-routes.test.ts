import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { execa } from 'execa';
import { registerNewsRoutes } from './news-routes.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { resetMergeDetectionCache } from '../core/merge-detection.js';
import { gitOnlyDir, pathWith, writeGhJson, writeGhNode } from '../test-support/fake-gh.js';

describe('news routes', () => {
  let root: string;
  let app: Hono;
  const get = async (query = '') => {
    const response = await app.request(`/api/workspace/reports/news${query}`);
    return { status: response.status, body: await response.json() };
  };
  const post = async (body: unknown, id = 'reports') => {
    const response = await app.request(`/api/workspace/${id}/news/seen`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const seenFile = () => path.join(root, '.contextspace/seen.json');
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  beforeEach(async () => {
    setActiveStorageProvider(new LocalStorageAdapter());
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'news-routes-')));
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [], assistants: [], workspacePath: root }));
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'export-flow.png'), 'png');
    app = new Hono();
    registerNewsRoutes(app, async (id) => (id === 'reports' ? root : null));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('reads the report for the user without marking the user as having looked', async () => {
    const first = await get('?reader=user');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      reader: 'user', basis: 'first-look', empty: false,
      documents: { items: [{ name: 'docs/export-flow.png', kind: 'image', change: 'changed' }], more: 0 },
    });
    expect((await get('?reader=user')).body.documents).toEqual(first.body.documents);
    const seen = JSON.parse(await fs.readFile(seenFile(), 'utf8'));
    expect(seen.readers).toEqual({});
    expect(seen.pending.user.at).toBeTruthy();
  });

  it('reads as the user when no reader is named, and as another reader when one is', async () => {
    expect((await get()).body.reader).toBe('user');
    expect((await get('?reader=Claude')).body.reader).toBe('claude');
  });

  it('marks the user as having looked at the list last read, and then shows only what changed after', async () => {
    const report = (await get('?reader=user')).body;
    expect(await post({ reader: 'user', at: report.at })).toEqual({ status: 200, body: { ok: true } });
    expect(JSON.parse(await fs.readFile(seenFile(), 'utf8')).readers.user.at).toBe(report.at);

    const after = (await get('?reader=user')).body;
    expect(after).toMatchObject({ basis: 'last-look', from: report.at, empty: true });
    // Another reader is unaffected.
    expect((await get('?reader=codex')).body).toMatchObject({ basis: 'first-look', empty: false });
  });

  it('says the list changed, with 409, when the time is not the one last read, and marks nothing', async () => {
    const older = (await get()).body;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = (await get()).body;
    expect(older.at).not.toBe(newer.at);
    expect(await post({ reader: 'user', at: older.at })).toEqual({ status: 409, body: { error: 'The list changed; read it again.' } });
    expect((await post({ reader: 'user', at: new Date().toISOString() })).status).toBe(409);
    expect((await post({ reader: 'codex', at: newer.at })).status).toBe(409);
    expect(JSON.parse(await fs.readFile(seenFile(), 'utf8')).readers).toEqual({});
    expect((await post({ reader: 'user', at: newer.at })).status).toBe(200);
    // Once marked, the same list cannot be marked again.
    expect((await post({ reader: 'user', at: newer.at })).status).toBe(409);
  });

  describe('with a repository and knowledge', () => {
    let api: string;
    const commit = async (subject: string) => {
      await fs.writeFile(path.join(api, `${subject}.txt`), subject);
      await execa('git', ['add', '.'], { cwd: api });
      await execa('git', ['-c', 'user.name=Anna', '-c', 'user.email=a@example.com', 'commit', '-m', subject], { cwd: api });
    };
    const lessons = (...titles: string[]) => fs.writeFile(path.join(root, 'contextspace-knowledge.md'),
      `# Knowledge\n\n## Known Gotchas\n\n${titles.map((title) => `### ${new Date().toISOString().slice(0, 10)} — ${title}\n**Gotcha:** Because.\n`).join('\n')}`);
    const subjects = (body: any) => body.commits[0].commits.map((entry: { subject: string }) => entry.subject);

    beforeEach(async () => {
      api = path.join(root, 'api');
      await fs.mkdir(api);
      await execa('git', ['init', '-b', 'main'], { cwd: api });
      await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [api], assistants: [], workspacePath: root }));
      await commit('Start the exporter');
      await lessons('First lesson');
    });

    it('shows a commit and a knowledge entry that landed between reading the list and marking it, next time', async () => {
      const shown = (await get()).body;
      expect(subjects(shown)).toEqual(['Start the exporter']);
      expect(shown.knowledge.items.map((entry: { title: string }) => entry.title)).toEqual(['First lesson']);

      await commit('Landed after the list was read');
      await lessons('First lesson', 'Second lesson');
      expect(await post({ reader: 'user', at: shown.at })).toEqual({ status: 200, body: { ok: true } });

      const next = (await get()).body;
      expect(next).toMatchObject({ basis: 'last-look', from: shown.at, empty: false });
      expect(subjects(next)).toEqual(['Landed after the list was read']);
      expect(next.knowledge.items.map((entry: { title: string }) => entry.title)).toEqual(['Second lesson']);
    });
  });

  it('writes nothing into an archived workspace: the list is read, and nothing can be marked', async () => {
    await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'reports', repos: [], assistants: [], workspacePath: root, archivedAt: '2026-09-28T10:00:00.000Z' }));
    const report = await get();
    expect(report).toMatchObject({ status: 200, body: { basis: 'first-look', empty: false } });
    await expect(fs.access(seenFile())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(root, '.contextspace'))).rejects.toMatchObject({ code: 'ENOENT' });

    const marked = await post({ reader: 'user', at: report.body.at });
    expect(marked.status).toBe(409);
    expect(marked.body.error).toContain('archived');
    await expect(fs.access(seenFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reaches back to a time asked for', async () => {
    await fs.utimes(path.join(root, 'docs', 'export-flow.png'), hoursAgo(10), hoursAgo(10));
    expect((await get(`?since=${encodeURIComponent(hoursAgo(1).toISOString())}`)).body).toMatchObject({ basis: 'time', empty: true });
    expect((await get(`?since=${encodeURIComponent(hoursAgo(12).toISOString())}`)).body).toMatchObject({ basis: 'time', empty: false });
  });

  it('refuses what is not a reader or a time, an unknown workspace and a body with more than it needs', async () => {
    expect((await get('?reader=../x')).status).toBe(400);
    expect((await get('?reader=')).status).toBe(400);
    expect((await get('?since=whenever')).body.error).toContain('date and time');
    expect((await post({ reader: 'user' })).status).toBe(400);
    expect((await post({ reader: 'user', at: 'yesterday' })).status).toBe(400);
    expect((await post({ reader: 'user', at: new Date().toISOString(), extra: true })).status).toBe(400);
    expect((await post({ reader: '__proto__', at: new Date().toISOString() })).status).toBe(400);
    expect((await app.request('/api/workspace/other/news')).status).toBe(404);
    expect((await post({ reader: 'user', at: new Date().toISOString() }, 'other')).status).toBe(404);
    await expect(fs.access(seenFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a body that is too large and one that is not JSON', async () => {
    const big = await app.request('/api/workspace/reports/news/seen', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reader: 'user', at: new Date().toISOString(), pad: 'x'.repeat(5000) }),
    });
    expect(big.status).toBe(413);
    const broken = await app.request('/api/workspace/reports/news/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ nope' });
    expect(broken.status).toBe(400);
  });

  it('serves the Board its recent commits without touching the pending record, and a read with since does not replace it', async () => {
    const report = (await get('?reader=user')).body;
    const recent = await (await app.request('/api/workspace/reports/recent-commits')).json();
    expect(recent).toMatchObject({ commits: [] });
    await get(`?reader=user&since=${encodeURIComponent(hoursAgo(5).toISOString())}`);
    // the first report is still the one that can be marked
    expect(await post({ reader: 'user', at: report.at })).toEqual({ status: 200, body: { ok: true } });
  });

  it('includes branch, distinct base, and remoteRepo on /recent-commits and accepts ?refresh=1', async () => {
    const originalPath = process.env.PATH ?? '';
    const tmpBin = path.join(root, 'bin');
    await fs.mkdir(tmpBin, { recursive: true });
    await writeGhJson(tmpBin, '[]');
    process.env.PATH = pathWith(tmpBin, originalPath);
    resetMergeDetectionCache();
    try {
      const repo = path.join(root, 'app');
      await fs.mkdir(repo);
      await execa('git', ['init', '-b', 'main'], { cwd: repo });
      await execa('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execa('git', ['remote', 'add', 'origin', 'git@github.com:org/upstream-app.git'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['commit', '-m', 'Base commit'], { cwd: repo });
      await execa('git', ['checkout', '-b', 'feat/branch'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['commit', '-m', 'Branch commit'], { cwd: repo });

      await fs.writeFile(
        path.join(root, 'contextspace.json'),
        JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'feat/branch', repos: [repo], assistants: [], workspacePath: root }),
      );

      const recent = await (await app.request('/api/workspace/reports/recent-commits?refresh=1')).json();
      expect(recent.commits[0]).toMatchObject({
        repo: 'app',
        remoteRepo: 'org/upstream-app',
        branch: 'feat/branch',
        base: 'main',
      });
      expect(recent.commits[0].commits.map((c: { subject: string }) => c.subject)).toContain('Branch commit');
      await expect(fs.access(seenFile())).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.env.PATH = originalPath;
      resetMergeDetectionCache();
    }
  });

  it('serves cached PRs until a second ?refresh=1 request busts the branch PR cache', async () => {
    const originalPath = process.env.PATH ?? '';
    const tmpBin = path.join(root, 'bin-refresh');
    const stateFile = path.join(root, 'pr-state.txt');
    await fs.mkdir(tmpBin, { recursive: true });
    await fs.writeFile(stateFile, 'OPEN');
    await writeGhNode(tmpBin, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'pr') {
  const state = fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8').trim();
  console.log(JSON.stringify([{ number: 10, title: 'Refresh test PR', state, url: 'https://github.com/org/upstream-app/pull/10', baseRefName: 'main', headRefOid: 'deadbeef', mergeCommit: null }]));
  process.exit(0);
}
process.exit(1);
`);
    process.env.PATH = pathWith(tmpBin, originalPath);
    resetMergeDetectionCache();
    try {
      const repo = path.join(root, 'app-refresh');
      await fs.mkdir(repo);
      await execa('git', ['init', '-b', 'main'], { cwd: repo });
      await execa('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execa('git', ['remote', 'add', 'origin', 'git@github.com:org/upstream-app.git'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['commit', '-m', 'Base commit'], { cwd: repo });
      await execa('git', ['checkout', '-b', 'feat/branch'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['commit', '-m', 'Branch commit'], { cwd: repo });
      await fs.writeFile(
        path.join(root, 'contextspace.json'),
        JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'feat/branch', repos: [repo], assistants: [], workspacePath: root }),
      );

      const first = await (await app.request('/api/workspace/reports/recent-commits?refresh=1')).json();
      expect(first.commits[0].pullRequests?.[0]?.state).toBe('OPEN');

      await fs.writeFile(stateFile, 'MERGED');
      const cached = await (await app.request('/api/workspace/reports/recent-commits')).json();
      expect(cached.commits[0].pullRequests?.[0]?.state).toBe('OPEN');

      const refreshed = await (await app.request('/api/workspace/reports/recent-commits?refresh=1')).json();
      expect(refreshed.commits[0].pullRequests?.[0]?.state).toBe('MERGED');
    } finally {
      process.env.PATH = originalPath;
      resetMergeDetectionCache();
    }
  });

  // The route waits for GitHub for at most 1 s ON PURPOSE (the coordinator chose it so a first load usually
  // shows PRs already settled). It must never wait longer, whatever gh does, even if every gh call is held forever.
  it('waits on GitHub for a bounded 1 s on purpose and still answers within about 1.5 s while every gh call is held forever', async () => {
    const originalPath = process.env.PATH ?? '';
    const heldBin = path.join(root, 'bin-held');
    const gitBin = await gitOnlyDir(path.join(root, 'bin-git-held'));
    // Held "forever" for this test's purposes: it outlives the test, and execa's own timeout kills it.
    await writeGhNode(heldBin, 'setTimeout(() => process.exit(1), 60000);\n');
    process.env.PATH = pathWith(heldBin, gitBin);
    resetMergeDetectionCache();
    try {
      const repo = path.join(root, 'app-held');
      await fs.mkdir(repo);
      await execa('git', ['init', '-b', 'main'], { cwd: repo });
      await execa('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execa('git', ['remote', 'add', 'origin', 'git@github.com:org/upstream-app.git'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['commit', '-m', 'Base commit'], { cwd: repo });
      await execa('git', ['checkout', '-b', 'feat/branch'], { cwd: repo });
      await fs.writeFile(
        path.join(root, 'contextspace.json'),
        JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'feat/branch', repos: [repo], assistants: [], workspacePath: root }),
      );
      const start = Date.now();
      const res = await app.request('/api/workspace/reports/recent-commits');
      const elapsedMs = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsedMs).toBeLessThan(1_500);
      expect(elapsedMs).toBeGreaterThanOrEqual(900);
      const body = await res.json();
      expect(body.commits[0]).toMatchObject({ repo: 'app-held', branch: 'feat/branch', prsPending: true });
    } finally {
      process.env.PATH = originalPath;
      resetMergeDetectionCache();
    }
  });

  it('answers within ~2s with branches and prsPending when gh hangs, populates PRs after gh settles, and omits PRs silently when gh is missing (ENOENT)', async () => {
    const originalPath = process.env.PATH ?? '';
    const tmpBin = path.join(root, 'bin-hang');
    const gitOnlyBin = await gitOnlyDir(path.join(root, 'bin-git-only'));
    await writeGhNode(tmpBin, `const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[0] === 'auth') { process.exit(0); }
if (args[0] === 'pr') {
  setTimeout(() => {
    console.log(JSON.stringify([{
      number: 42,
      title: 'Slow PR',
      state: 'OPEN',
      url: 'https://github.com/org/upstream-app/pull/42',
      baseRefName: 'main',
      headRefOid: 'deadbeef',
      mergeCommit: null,
    }]));
    process.exit(0);
  }, 1500);
} else {
  process.exit(1);
}
`);
    resetMergeDetectionCache();
    try {
      const repo = path.join(root, 'app-hang');
      await fs.mkdir(repo);
      await execa('git', ['init', '-b', 'main'], { cwd: repo });
      await execa('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execa('git', ['remote', 'add', 'origin', 'git@github.com:org/upstream-app.git'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['commit', '-m', 'Base commit'], { cwd: repo });
      await execa('git', ['checkout', '-b', 'feat/branch'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['commit', '-m', 'Branch commit'], { cwd: repo });
      await fs.writeFile(
        path.join(root, 'contextspace.json'),
        JSON.stringify({ id: 'reports', name: 'Reports', branchName: 'feat/branch', repos: [repo], assistants: [], workspacePath: root }),
      );

      // 1. Missing gh (ENOENT): answers immediately with no PR line, no loading flag, and no error
      process.env.PATH = gitOnlyBin;
      resetMergeDetectionCache();
      const missingRes = await app.request('/api/workspace/reports/recent-commits');
      expect(missingRes.status).toBe(200);
      const missingBody = await missingRes.json();
      expect(missingBody.commits[0]).toMatchObject({ repo: 'app-hang', branch: 'feat/branch', base: 'main' });
      expect(missingBody.commits[0].pullRequests).toBeUndefined();
      expect(missingBody.commits[0].prsPending).toBeUndefined();
      expect(missingBody.commits[0].problem).toBeUndefined();

      // 2. Hanging gh: answers within < 2s with branches + prsPending, then later returns PR #42
      process.env.PATH = pathWith(tmpBin, gitOnlyBin);
      resetMergeDetectionCache();
      const start = Date.now();
      const firstRes = await app.request('/api/workspace/reports/recent-commits');
      const elapsedMs = Date.now() - start;
      expect(firstRes.status).toBe(200);
      expect(elapsedMs).toBeLessThan(2_000);
      const firstBody = await firstRes.json();
      expect(firstBody.commits[0]).toMatchObject({
        repo: 'app-hang',
        branch: 'feat/branch',
        base: 'main',
        prsPending: true,
      });
      expect(firstBody.commits[0].pullRequests).toBeUndefined();

      // Wait for the background gh lookup to settle
      let settled = firstBody;
      const deadline = Date.now() + 3_000;
      while (settled.commits[0].prsPending && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        settled = await (await app.request('/api/workspace/reports/recent-commits')).json();
      }
      expect(settled.commits[0].prsPending).toBeUndefined();
      expect(settled.commits[0].pullRequests?.[0]?.number).toBe(42);
    } finally {
      process.env.PATH = originalPath;
      resetMergeDetectionCache();
    }
  });
});
