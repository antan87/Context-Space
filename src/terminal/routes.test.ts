import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalAccess, containedTerminalCwd, registerTerminalRoutes, trustedTerminalOrigin } from './routes.js';
import { TerminalManager, type PtyProcess } from './manager.js';

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe('terminal execution boundary', () => {
  it('requires an exact local origin and rejects missing, hostile, other-port and opaque origins', () => {
    const url = 'http://localhost:3000/ws/terminal';
    expect(trustedTerminalOrigin('http://localhost:3000', url)).toBe(true);
    for (const bad of [undefined, 'null', 'http://evil.example', 'http://localhost:3001', 'http://localhost:3000.evil.example', 'http://user@localhost:3000', 'http://localhost:3000/path']) expect(trustedTerminalOrigin(bad, url)).toBe(false);
    expect(trustedTerminalOrigin('http://localhost:5173', url, 'http://localhost:5173')).toBe(true);
    expect(trustedTerminalOrigin('https://evil.example', url, 'https://evil.example')).toBe(false);
  });
  it('binds short-lived access to one owner and preserves ownership when refreshing', () => {
    vi.useFakeTimers(); const access = new TerminalAccess(); const a = access.bootstrap(), b = access.bootstrap();
    expect(access.validate(a.owner, a.token)).toBe(true); expect(access.validate(b.owner, a.token)).toBe(false);
    expect(access.bootstrap(a.owner).token).toBe(a.token);
    expect(access.isActive(a.owner)).toBe(true);
    expect(access.isActive(b.owner)).toBe(true);
    expect(access.isActive('unknown')).toBe(false);
    vi.advanceTimersByTime(4 * 60_000);
    expect(access.bootstrap(a.owner).expiresAt).toBe(a.expiresAt);
    expect(access.isActive(a.owner)).toBe(true);
    vi.advanceTimersByTime(60_000 + 1); expect(access.validate(a.owner, a.token)).toBe(false);
    expect(access.isActive(a.owner)).toBe(true);
    vi.advanceTimersByTime(4 * 60_000);
    expect(access.isActive(a.owner)).toBe(false);
    const again = access.bootstrap(a.owner); expect(again.owner).toBe(a.owner); expect(again.token).not.toBe(a.token);
    expect(access.isActive(a.owner)).toBe(true);
    vi.advanceTimersByTime(4 * 60_000);
    expect(access.isActive(a.owner)).toBe(true);
    access.touch(a.owner);
    vi.advanceTimersByTime(2 * 60_000);
    expect(access.isActive(a.owner)).toBe(true);
    vi.advanceTimersByTime(3 * 60_000 + 1);
    expect(access.isActive(a.owner)).toBe(false);
  });
  it('rejects traversal and symlink launch directories', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cs-terminal-')); dirs.push(parent);
    const root = path.join(parent, 'workspace'); await mkdir(root); await mkdir(path.join(root, 'repo')); await mkdir(path.join(parent, 'outside'));
    expect(await containedTerminalCwd(root, 'repo')).toBe(await realpath(path.join(root, 'repo')));
    await expect(containedTerminalCwd(root, '../outside')).rejects.toThrow('inside');
    await symlink(path.join(parent, 'outside'), path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(containedTerminalCwd(root, 'escape')).rejects.toThrow('inside');
  });
  it('will not mint cross-origin access or list sessions with another browser token', async () => {
    const app = new Hono(); const resolve = vi.fn(async () => '/workspace');
    registerTerminalRoutes(app, vi.fn() as any, resolve);
    for (const origin of ['http://evil.example', 'http://localhost:4321']) {
      expect((await app.request('http://localhost/api/terminals/bootstrap', { method: 'POST', headers: { origin, 'x-contextspace-terminal': 'bootstrap' } })).status).toBe(403);
    }
    const bootstrap = await app.request('http://localhost/api/terminals/bootstrap', { method: 'POST', headers: { origin: 'http://localhost', 'x-contextspace-terminal': 'bootstrap' } });
    expect(bootstrap.status).toBe(200);
    const { token } = await bootstrap.json(); const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    expect((await app.request('http://localhost/api/terminals/workspace/status', { method: 'POST', headers: { origin: 'http://localhost', 'x-contextspace-terminal': token } })).status).toBe(403);
    expect((await app.request('http://localhost/api/terminals/workspace/status', { method: 'POST', headers: { origin: 'http://localhost', 'x-contextspace-terminal': 'fake', cookie } })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('lists running terminals across workspaces only for the browser that owns them', async () => {
    const app = new Hono(); const resolve = vi.fn(async () => '/workspace');
    const factory = vi.fn(async () => ({ pid: 1, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), onData: vi.fn(() => ({ dispose() {} })), onExit: vi.fn(() => ({ dispose() {} })) }) as unknown as PtyProcess);
    const manager = new TerminalManager(factory, vi.fn());
    registerTerminalRoutes(app, vi.fn() as any, resolve, manager);
    const bootstrap = await app.request('http://localhost/api/terminals/bootstrap', { method: 'POST', headers: { origin: 'http://localhost', 'x-contextspace-terminal': 'bootstrap' } });
    const { token } = await bootstrap.json(); const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
    const owner = cookie.split('=')[1]!;
    const launch = { file: '/bin/sh', args: [], env: {}, label: 'Shell' };
    await manager.create({ owner, workspace: 'alpha', cwd: '/alpha', target: 'shell', launchId: 'a', launch });
    await manager.create({ owner, workspace: 'beta', cwd: '/beta', target: 'claude', launchId: 'b', launch });
    await manager.create({ owner: 'someone-else', workspace: 'gamma', cwd: '/gamma', target: 'shell', launchId: 'c', launch });
    const listed = await app.request('http://localhost/api/terminals/running', { method: 'POST', headers: { origin: 'http://localhost', 'x-contextspace-terminal': token, cookie } });
    expect(listed.status).toBe(200);
    const { sessions } = await listed.json() as { sessions: { workspace: string; attached: boolean }[] };
    expect(sessions.map(session => session.workspace).sort()).toEqual(['alpha', 'beta']);
    expect(sessions.every(session => session.attached === false)).toBe(true);
    // Without this browser's token, or from another site, nothing is listed.
    expect((await app.request('http://localhost/api/terminals/running', { method: 'POST', headers: { origin: 'http://localhost', 'x-contextspace-terminal': 'fake', cookie } })).status).toBe(403);
    expect((await app.request('http://localhost/api/terminals/running', { method: 'POST', headers: { origin: 'http://evil.example', 'x-contextspace-terminal': token, cookie } })).status).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    manager.dispose();
  });
});
