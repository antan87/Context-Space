import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

import { registerBoardRoutes } from './board-routes.js';
import { BOARD_FILE } from '../core/board.js';
import { LocalStorageAdapter } from '../core/adapters/local-storage.js';
import { setActiveStorageProvider } from '../core/adapters/registry.js';
import { BOARD_EVENTS_FILE, SCREEN_EVENTS_FILE, listBoardEvents } from '../core/screen-events.js';

describe('board routes', () => {
  let root: string;
  let app: Hono;
  let storage: LocalStorageAdapter;
  const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ id: 'canvas', name: 'Canvas', branchName: 'canvas', repos: [], assistants: [], workspacePath: root, ...extra });
  const get = async (id = 'canvas') => {
    const response = await app.request(`/api/workspace/${id}/board`);
    return { status: response.status, body: await response.json() };
  };
  const post = async (body: unknown, id = 'canvas') => {
    const response = await app.request(`/api/workspace/${id}/board/changes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const note = (title: string, extra: Record<string, unknown> = {}) => ({ op: 'add_card', kind: 'note', title, ...extra });
  const stored = async () => JSON.parse(await fs.readFile(path.join(root, BOARD_FILE), 'utf8'));

  beforeEach(async () => {
    storage = new LocalStorageAdapter();
    setActiveStorageProvider(storage);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-routes-')));
    await fs.writeFile(path.join(root, 'contextspace.json'), manifest());
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'overview.html'), '<p>hi</p>');
    app = new Hono();
    registerBoardRoutes(app, async (id) => (id === 'canvas' ? root : null));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads an empty board for a workspace that has none', async () => {
    expect(await get()).toEqual({ status: 200, body: { version: 1, revision: 0, cards: [], links: [], positions: {} } });
    await expect(fs.access(path.join(root, BOARD_FILE))).rejects.toThrow();
  });

  it('applies changes as the user, in order, and returns the new board with what each made', async () => {
    const id = randomUUID();
    const { status, body } = await post({ changes: [
      note('Finding', { id, body: 'It leaks.', position: { x: 10, y: 20 } }),
      { op: 'add_card', kind: 'file', path: 'docs/overview.html', description: 'The page' },
      { op: 'link', from: id, to: 'checkpoint:reports-export', label: 'about' },
      { op: 'move', nodes: [{ id: 'checkpoint:reports-export', x: 300, y: 0 }] },
    ] });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      version: 1, revision: 1,
      cards: [{ id, kind: 'note', title: 'Finding', body: 'It leaks.', by: 'user' }, { kind: 'file', path: 'docs/overview.html', title: 'overview.html', by: 'user' }],
      links: [{ from: id, to: 'checkpoint:reports-export', label: 'about', by: 'user' }],
      positions: { [id]: { x: 10, y: 20 }, 'checkpoint:reports-export': { x: 300, y: 0 } },
      results: [{ op: 'add_card', id }, { op: 'add_card' }, { op: 'link' }, { op: 'move', count: 1 }],
    });
    const { results: _results, ...board } = body;
    expect(await get()).toEqual({ status: 200, body: board });
    expect(await stored()).toEqual(board);
  });

  it('tells the open screens, as the user', async () => {
    await post({ changes: [note('A')] });
    await post({ changes: [note('B')] });
    const events = await listBoardEvents(root);
    expect(events.map((event) => [event.harness, event.payload])).toEqual([['user', { revision: 1, changes: 1 }], ['user', { revision: 2, changes: 1 }]]);
    // The line says the person made it, not the AI.
    const ledger = (await fs.readFile(path.join(root, '.contextspace', BOARD_EVENTS_FILE), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(ledger.map((line) => line.author)).toEqual(['human', 'human']);
    await expect(fs.access(path.join(root, '.contextspace', SCREEN_EVENTS_FILE))).rejects.toThrow();
  });

  it('accepts the revision that was read, and refuses a stale one with 409', async () => {
    expect((await post({ revision: 0, changes: [note('A')] })).status).toBe(200);
    const stale = await post({ revision: 0, changes: [note('B')] });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/revision 1, not 0/);
    expect((await get()).body.cards.map((c: { title: string }) => c.title)).toEqual(['A']);
    expect((await post({ revision: 1, changes: [note('B')] })).status).toBe(200);
  });

  it('keeps two writers who change different things', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, n) => post({ changes: [note(`Card ${n}`)] })));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect((await get()).body).toMatchObject({ revision: 8, cards: expect.arrayContaining([expect.objectContaining({ title: 'Card 7' })]) });
    expect((await get()).body.cards).toHaveLength(8);
  });

  it('applies all of a list or none of it, with 400 and the change that failed', async () => {
    await post({ changes: [note('Existing')] });
    const before = await fs.readFile(path.join(root, BOARD_FILE), 'utf8');
    const refused = await post({ changes: [note('Would be added'), { op: 'remove_card', id: randomUUID() }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/no card with id/);
    expect(await fs.readFile(path.join(root, BOARD_FILE), 'utf8')).toBe(before);
  });

  it.each([
    ['a body that is not JSON', '{ nope', /must be JSON/],
    ['a body that is not an object', '[]', /Invalid input|expected object/],
    ['no changes', {}, /changes/],
    ['an empty list of changes', { changes: [] }, /at least one change/],
    ['a revision that is not a whole number', { revision: 1.5, changes: [note('A')] }, /revision/],
    ['a negative revision', { revision: -1, changes: [note('A')] }, /revision/],
    ['a field the request does not have', { changes: [note('A')], by: 'claude' }, /by/],
    ['a change that is not valid', { changes: [note('A'), { op: 'link', from: 'x', to: 'y' }] }, /Change 2, from/],
    ['an operation that does not exist', { changes: [{ op: 'explode' }] }, /"op" must be one of/],
    ['a title over the limit', { changes: [note('x'.repeat(201))] }, /Change 1, title/],
    ['a file that is outside the workspace', { changes: [{ op: 'add_card', kind: 'file', path: '../secret.md' }] }, /inside this workspace/],
    ['an absolute path', { changes: [{ op: 'add_card', kind: 'file', path: '/etc/passwd' }] }, /not inside the workspace/],
    ['a file that is not there', { changes: [{ op: 'add_card', kind: 'file', path: 'docs/missing.html' }] }, /no file/],
    ['a position that is out of bounds', { changes: [{ op: 'move', nodes: [{ id: 'checkpoint:a', x: 1e9, y: 0 }] }] }, /nodes\.0\.x/],
  ])('answers 400 for %s, and changes nothing', async (_name, body, message) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(message);
    await expect(fs.access(path.join(root, BOARD_FILE))).rejects.toThrow();
  });

  it('answers 413 for a request that is far too large', async () => {
    const response = await post({ changes: [note('A', { body: 'x'.repeat(1_100_000) })] });
    expect(response.status).toBe(413);
    expect(response.body.error).toMatch(/too large/);
    await expect(fs.access(path.join(root, BOARD_FILE))).rejects.toThrow();
  });

  it('answers 404 for a workspace it does not know, for reading and for changing', async () => {
    expect(await get('elsewhere')).toEqual({ status: 404, body: { error: 'Workspace not found.' } });
    expect(await post({ changes: [note('A')] }, 'elsewhere')).toEqual({ status: 404, body: { error: 'Workspace not found.' } });
  });

  it('refuses changes in an archived workspace with 409, and still reads it', async () => {
    await post({ changes: [note('Before')] });
    await fs.writeFile(path.join(root, 'contextspace.json'), manifest({ archivedAt: '2026-09-28T10:00:00.000Z' }));
    const refused = await post({ changes: [note('After')] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/archived/);
    expect((await get()).body.cards.map((c: { title: string }) => c.title)).toEqual(['Before']);
  });

  it('reports a board file that is not a board, and does not overwrite it', async () => {
    await fs.writeFile(path.join(root, BOARD_FILE), '{ broken');
    const read = await get();
    expect(read.status).toBe(500);
    expect(read.body.error).toMatch(/not valid JSON.*left as it is/);
    const change = await post({ changes: [note('A')] });
    expect(change.status).toBe(500);
    expect(await fs.readFile(path.join(root, BOARD_FILE), 'utf8')).toBe('{ broken');
  });

  it('reports a folder where the board file should be, and an unreadable board file, with 500 and without writing', async () => {
    await fs.mkdir(path.join(root, BOARD_FILE));
    const read = await get();
    expect(read.status).toBe(500);
    expect(read.body.error).toMatch(/could not be read.*left as it is/);
    const change = await post({ changes: [note('A')] });
    expect(change.status).toBe(500);
    expect((await fs.stat(path.join(root, BOARD_FILE))).isDirectory()).toBe(true);
  });

  it('forgets the place of a node when given null, and keeps room for new places', async () => {
    await post({ changes: [{ op: 'move', nodes: [{ id: 'checkpoint:a', x: 1, y: 2 }, { id: 'commit:api:abc1234', x: 3, y: 4 }] }] });
    const forgot = await post({ changes: [{ op: 'move', nodes: [{ id: 'checkpoint:a', x: null, y: null }] }] });
    expect(forgot.status).toBe(200);
    expect(forgot.body.positions).toEqual({ 'commit:api:abc1234': { x: 3, y: 4 } });
    expect((await get()).body.positions).toEqual({ 'commit:api:abc1234': { x: 3, y: 4 } });
    const half = await post({ changes: [{ op: 'move', nodes: [{ id: 'checkpoint:a', x: null, y: 4 }] }] });
    expect(half.status).toBe(400);
    expect(half.body.error).toMatch(/both as null/);
  });

  it('answers 500, and not 400, when something fails that the request did not cause, and recovers', async () => {
    // A write that fails.
    vi.spyOn(storage, 'writeWorkspaceFile').mockRejectedValueOnce(new Error('disk full'));
    const failed = await post({ changes: [note('A')] });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatch(/disk full/);
    await expect(fs.access(path.join(root, BOARD_FILE))).rejects.toThrow();
    // The lock was let go, so the same request goes through.
    expect((await post({ changes: [note('A')] })).status).toBe(200);

    // A lock that cannot be made, for a reason other than being busy.
    await fs.rm(path.join(root, '.contextspace'), { recursive: true, force: true });
    await fs.writeFile(path.join(root, '.contextspace'), 'a file where the folder goes');
    const noLock = await post({ changes: [note('B')] });
    expect(noLock.status).toBe(500);
    expect(noLock.body.error).toBeTruthy();
    await fs.rm(path.join(root, '.contextspace'), { force: true });
    expect((await post({ changes: [note('B')] })).status).toBe(200);
  });

  it('answers 500 for a file it may not look at, and 400 for a file that is wrong', async () => {
    if (process.getuid?.() === 0) return; // root can look at anything
    await fs.chmod(path.join(root, 'docs'), 0o000);
    try {
      const response = await post({ changes: [{ op: 'add_card', kind: 'file', path: 'docs/overview.html' }] });
      expect(response.status).toBe(500);
    } finally {
      await fs.chmod(path.join(root, 'docs'), 0o755);
    }
    expect((await post({ changes: [{ op: 'add_card', kind: 'file', path: 'docs/nope.html' }] })).status).toBe(400);
  });

  it('answers 404 when the workspace has gone while the request was in flight', async () => {
    await fs.rm(path.join(root, 'contextspace.json'));
    expect(await post({ changes: [note('A')] })).toEqual({ status: 404, body: { error: 'Workspace not found.' } });
    await fs.rm(root, { recursive: true, force: true });
    expect(await post({ changes: [note('A')] })).toEqual({ status: 404, body: { error: 'Workspace not found.' } });
    expect(await get()).toEqual({ status: 404, body: { error: 'Workspace not found.' } });
  });

  it('does not offer the other methods', async () => {
    expect((await app.request('/api/workspace/canvas/board', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await app.request('/api/workspace/canvas/board/changes')).status).toBe(404);
    expect((await app.request('/api/workspace/canvas/board', { method: 'DELETE' })).status).toBe(404);
  });
});
