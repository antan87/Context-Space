import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { execa } from 'execa';
import { registerNewsRoutes } from './news-routes.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';

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
});
