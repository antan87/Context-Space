import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pa1-routes-'));
  await fs.writeFile(path.join(root, 'contextspace.json'), JSON.stringify({ id: 'demo', branchName: 'demo', repos: [], assistants: [], workspacePath: root }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const note = { path: 'gone.md', line: 2, endLine: 3, anchor: 'old\ntext', anchorCut: false, text: 'An answer', tag: 'todo' as const, harness: 'codex' };
it('lists open notes, saves Done, and refuses writes to an archived workspace', async () => {
  const { addLineNote } = await import('../core/line-notes.js');
  const { registerLineNoteRoutes } = await import('./line-note-routes.js');
  const n = await addLineNote(root, note);
  const app = new Hono(); registerLineNoteRoutes(app, async id => id === 'demo' ? root : null);
  expect((await (await app.request('/api/workspace/demo/line-notes')).json()).notes).toHaveLength(1);
  const manifest = path.join(root, 'contextspace.json');
  const config = JSON.parse(await fs.readFile(manifest, 'utf8'));
  await fs.writeFile(manifest, JSON.stringify({ ...config, archivedAt: new Date().toISOString() }));
  expect((await app.request(`/api/workspace/demo/line-notes/${n.id}/done`, { method: 'POST' })).status).toBe(409);
  await fs.writeFile(manifest, JSON.stringify(config));
  expect((await app.request(`/api/workspace/demo/line-notes/${n.id}/done`, { method: 'POST' })).status).toBe(200);
  expect((await (await app.request('/api/workspace/demo/line-notes')).json()).notes).toEqual([]);
  expect((await app.request('/api/workspace/missing/line-notes')).status).toBe(404);
});
it('news keeps deleted-file notes until Done and marks only the snapshot that was seen', async () => {
  const { addLineNote, readLineNotes } = await import('../core/line-notes.js');
  const { whatsNew, markSeen } = await import('../core/whats-new.js');
  const first = await addLineNote(root, note);
  const news = await whatsNew(root, 'user', { pending: true });
  expect(news.lineNotes?.items.map(n => n.id)).toEqual([first.id]);
  const second = await addLineNote(root, { ...note, text: 'Landed during reading' });
  await markSeen(root, 'user', news.at);
  expect((await whatsNew(root, 'user')).lineNotes?.items.map(n => n.id)).toEqual([second.id]);
  expect((await readLineNotes(root)).every(n => !n.doneAt)).toBe(true);
});
it('ignores the note store and its damaged recovery copies in existing workspaces', async () => {
  const { addLineNote } = await import('../core/line-notes.js');
  await addLineNote(root, note);
  expect(await fs.readFile(path.join(root, '.contextspace/.gitignore'), 'utf8')).toContain('line-notes.json*');
});
