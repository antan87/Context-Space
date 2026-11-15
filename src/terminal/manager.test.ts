import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager, TerminalNotFoundError, type PtyProcess, type TerminalClient } from './manager.js';

function fixture(grace = 5000) {
  let output: (data: string) => void = () => {};
  let exit: (event: { exitCode: number }) => void = () => {};
  const pty = { pid: 123456, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), onData: vi.fn(fn => { output = fn; return { dispose() {} }; }), onExit: vi.fn(fn => { exit = fn; return { dispose() {} }; }) } as unknown as PtyProcess;
  const factory = vi.fn(async () => pty), terminate = vi.fn();
  const manager = new TerminalManager(factory, terminate, grace);
  const input = { owner: 'alice', workspace: 'workspace', cwd: '/workspace', target: 'shell', launchId: 'nonce', launch: { file: '/bin/sh', args: [], env: {}, label: 'Shell' } };
  const messages: Record<string, any>[] = [];
  const client: TerminalClient = { send: data => messages.push(JSON.parse(data)), close: vi.fn() };
  return { manager, input, client, factory, pty, terminate, messages, output: (data: string) => output(data), exit: (code: number) => exit({ exitCode: code }) };
}
afterEach(() => vi.useRealTimers());
describe('backend-owned terminals', () => {
  it('makes concurrent duplicate starts idempotent and prevents foreign control', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.manager.create(f.input), f.manager.create(f.input)]);
    expect(a.id).toBe(b.id); expect(f.factory).toHaveBeenCalledTimes(1);
    expect(Date.parse(a.startedAt)).not.toBeNaN();
    expect(f.manager.list('alice', 'workspace')[0]?.startedAt).toBe(a.startedAt);
    expect(() => f.manager.attach('bob', 'workspace', a.id, f.client)).toThrow('not found');
    expect(() => f.manager.stop('alice', 'other', a.id)).toThrow('not found');
    expect(f.manager.list('bob', 'workspace')).toEqual([]);
    f.manager.dispose();
  });
  it('preserves process and output through detach/reconnect, with one writer', async () => {
    const f = fixture(); const { id } = await f.manager.create(f.input);
    f.manager.attach('alice', 'workspace', id, f.client);
    const other = { send: vi.fn(), close: vi.fn() };
    f.output('hello'); f.manager.attach('alice', 'workspace', id, other);
    expect(f.client.close).toHaveBeenCalledOnce();
    expect(() => f.manager.control('alice', 'workspace', id, f.client, { type: 'input', data: 'stale' })).toThrow('no longer owns');
    f.manager.detach('alice', 'workspace', id, other); f.output(' while hidden');
    expect(f.terminate).not.toHaveBeenCalled();
    const returned = { send: vi.fn(), close: vi.fn() };
    f.manager.attach('alice', 'workspace', id, returned);
    expect(returned.send.mock.calls.flat().join('')).toContain(' while hidden');
    expect(() => f.manager.control('alice', 'workspace', id, other, { type: 'input', data: 'stale' })).toThrow('no longer owns');
    f.manager.control('alice', 'workspace', id, returned, { type: 'input', data: 'pwd\r' });
    expect(f.pty.write).toHaveBeenCalledWith('pwd\r');
    expect(f.factory).toHaveBeenCalledTimes(1); f.manager.dispose();
  });
  it('bounds replay and pauses a slow client until its output is acknowledged', async () => {
    const f = fixture(); const { id } = await f.manager.create(f.input);
    f.output('x'.repeat(600_000));
    f.manager.attach('alice', 'workspace', id, f.client);
    expect(f.messages[0].truncated).toBe(true);
    const chunks = f.messages.filter(m => m.type === 'output');
    const length = chunks.reduce((n, m) => n + m.data.length, 0);
    expect(length).toBeLessThanOrEqual(512 * 1024); expect(f.pty.pause).toHaveBeenCalledOnce();
    for (const chunk of chunks) f.manager.control('alice', 'workspace', id, f.client, { type: 'ack', count: chunk.data.length });
    expect(f.pty.resume).toHaveBeenCalledOnce();
    expect(() => f.manager.control('alice', 'workspace', id, f.client, { type: 'resize', cols: 999999, rows: -1 })).toThrow();
    expect(() => f.manager.control('alice', 'workspace', id, f.client, { type: 'input', data: 'x'.repeat(20_000) })).toThrow();
    f.manager.dispose();
  });
  it('lists one owner\'s running terminals in every workspace, with whether a window shows them and when they stop', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
    const outputs: ((data: string) => void)[] = [], exits: ((event: { exitCode: number }) => void)[] = [];
    const factory = vi.fn(async () => ({ pid: 1, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(),
      onData: vi.fn(fn => { outputs.push(fn); return { dispose() {} }; }), onExit: vi.fn(fn => { exits.push(fn); return { dispose() {} }; }) }) as unknown as PtyProcess);
    const manager = new TerminalManager(factory, vi.fn(), 5 * 60_000);
    const launch = { file: '/bin/sh', args: [], env: {}, label: 'Claude Code' };
    const shown = await manager.create({ owner: 'alice', workspace: 'alpha', cwd: '/alpha', target: 'claude', launchId: 'a', launch });
    const hidden = await manager.create({ owner: 'alice', workspace: 'beta', cwd: '/beta', target: 'claude', launchId: 'b', launch });
    await manager.create({ owner: 'bob', workspace: 'alpha', cwd: '/alpha', target: 'shell', launchId: 'c', launch });
    const client = { send: vi.fn(), close: vi.fn() };
    manager.attach('alice', 'alpha', shown.id, client);
    vi.setSystemTime(new Date('2026-10-04T10:00:05.000Z'));
    outputs[0]!('thinking...');

    const byWorkspace = (owner: string) => Object.fromEntries(manager.running(owner).map(terminal => [terminal.workspace, terminal]));
    expect(Object.keys(byWorkspace('alice')).sort()).toEqual(['alpha', 'beta']);
    expect(byWorkspace('alice').alpha).toMatchObject({ id: shown.id, target: 'claude', attached: true, lastOutputAt: '2026-10-04T10:00:05.000Z', stopsAt: undefined });
    // Never shown in a window: it stops when the grace period started at launch runs out.
    expect(byWorkspace('alice').beta).toMatchObject({ id: hidden.id, attached: false, lastOutputAt: undefined, stopsAt: '2026-10-04T10:05:00.000Z' });
    expect(Object.keys(byWorkspace('bob'))).toEqual(['alpha']);
    expect(manager.running('mallory')).toEqual([]);

    // Its chat closes: still running, and it says when it will stop.
    vi.setSystemTime(new Date('2026-10-04T10:01:00.000Z'));
    manager.detach('alice', 'alpha', shown.id, client);
    expect(byWorkspace('alice').alpha).toMatchObject({ attached: false, stopsAt: '2026-10-04T10:06:00.000Z' });
    // Shown again: no stop time.
    manager.attach('alice', 'alpha', shown.id, client);
    expect(byWorkspace('alice').alpha).toMatchObject({ attached: true, stopsAt: undefined });

    // An exited terminal is no longer running, though it is kept a while for its output.
    exits[1]!({ exitCode: 0 });
    expect(Object.keys(byWorkspace('alice'))).toEqual(['alpha']);
    expect(manager.list('alice', 'beta')).toHaveLength(1);
    manager.dispose();
  });
  it('expires abandoned sessions and terminates live processes on shutdown', async () => {
    vi.useFakeTimers(); const f = fixture(1000); const { id } = await f.manager.create(f.input);
    f.manager.attach('alice', 'workspace', id, f.client); await vi.advanceTimersByTimeAsync(1200);
    expect(f.terminate).not.toHaveBeenCalled();
    f.manager.detach('alice', 'workspace', id, f.client); await vi.advanceTimersByTimeAsync(1200);
    expect(f.terminate).toHaveBeenCalledOnce(); expect(f.manager.list('alice', 'workspace')).toEqual([]);
    await f.manager.create({ ...f.input, launchId: 'second' }); f.manager.dispose(); expect(f.terminate).toHaveBeenCalledTimes(2);
  });
  it('renews expiration timer for running sessions while owner is active', async () => {
    vi.useFakeTimers();
    let ownerActive = true;
    const f = fixture(1000);
    f.manager.setOwnerActiveChecker((owner) => owner === 'alice' && ownerActive);
    const { id } = await f.manager.create(f.input);
    f.manager.attach('alice', 'workspace', id, f.client);
    f.manager.detach('alice', 'workspace', id, f.client);
    // After 1 grace period (1000ms), owner is still active, so session should NOT terminate
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.manager.list('alice', 'workspace')).toHaveLength(1);

    // After another grace period, still active
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.manager.list('alice', 'workspace')).toHaveLength(1);

    // Now owner becomes inactive
    ownerActive = false;
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.terminate).toHaveBeenCalledOnce();
    expect(f.manager.list('alice', 'workspace')).toEqual([]);
    f.manager.dispose();
  });
  it('does not renew expiration for exited sessions even if owner is active', async () => {
    vi.useFakeTimers();
    const f = fixture(1000);
    f.manager.setOwnerActiveChecker(() => true);
    const { id } = await f.manager.create(f.input);
    f.manager.attach('alice', 'workspace', id, f.client);
    f.exit(0);
    expect(f.manager.list('alice', 'workspace')[0]?.state).toBe('exited');
    // After grace period, exited session should expire and be deleted despite active owner
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.manager.list('alice', 'workspace')).toEqual([]);
    f.manager.dispose();
  });
  it('reports whether an owner has any attached terminal sessions', async () => {
    const f = fixture();
    expect(f.manager.hasAttached('alice')).toBe(false);
    const { id } = await f.manager.create(f.input);
    expect(f.manager.hasAttached('alice')).toBe(false);
    f.manager.attach('alice', 'workspace', id, f.client);
    expect(f.manager.hasAttached('alice')).toBe(true);
    expect(f.manager.hasAttached('bob')).toBe(false);
    f.manager.detach('alice', 'workspace', id, f.client);
    expect(f.manager.hasAttached('alice')).toBe(false);
    f.manager.dispose();
  });
  it('does not renew expiration when manager is closing', async () => {
    vi.useFakeTimers();
    const f = fixture(1000);
    f.manager.setOwnerActiveChecker(() => true);
    const { id } = await f.manager.create(f.input);
    f.manager.attach('alice', 'workspace', id, f.client);
    f.manager.detach('alice', 'workspace', id, f.client);
    f.manager.dispose();
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.manager.list('alice', 'workspace')).toEqual([]);
  });
  it('releases failed launches and rejects concurrent resumes by another owner', async () => {
    const f = fixture(); f.factory.mockRejectedValueOnce(new Error('native load failed'));
    await expect(f.manager.create(f.input)).rejects.toThrow('native load');
    await expect(f.manager.create(f.input)).resolves.toHaveProperty('id');
    const resume = { ...f.input, target: 'codex', sessionId: 'saved', launchId: 'resume' };
    const starting = f.manager.create(resume);
    await expect(f.manager.create({ ...resume, owner: 'bob', launchId: 'other' })).rejects.toThrow('already starting');
    const saved = await starting;
    expect((await f.manager.create({ ...resume, launchId: 'again' })).id).toBe(saved.id);
    f.manager.dispose();
  });
  it('binds a conversation to the one fresh terminal that created it, so resume reuses that process', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-29T10:00:00Z') });
    const f = fixture(); const fresh = { ...f.input, target: 'claude', launchId: 'fresh' };
    const started = await f.manager.create(fresh);
    const claim = { owner: 'alice', workspace: 'workspace', target: 'claude', cwd: '/workspace', sessionId: 'conversation', createdAt: '2026-09-29T10:01:00Z', others: [] };
    // An idle terminal cannot have created a conversation that was recorded later.
    expect(f.manager.claimSession(claim)).toBeUndefined();
    f.manager.attach('alice', 'workspace', started.id, f.client);
    f.manager.control('alice', 'workspace', started.id, f.client, { type: 'input', data: 'hello\r' });
    expect(f.manager.claimSession({ ...claim, cwd: '/elsewhere' })).toBeUndefined();
    expect(f.manager.claimSession({ ...claim, target: 'codex' })).toBeUndefined();
    expect(f.manager.claimSession({ ...claim, createdAt: '2026-09-29T09:00:00Z' })).toBeUndefined();
    // Another browser's resume never rebinds this owner's terminal.
    expect(f.manager.claimSession({ ...claim, owner: 'bob' })).toBeUndefined();
    // Another conversation here since the terminal started makes ownership ambiguous.
    expect(f.manager.claimSession({ ...claim, others: [{ cwd: '/workspace', createdAt: '2026-09-29T10:02:00Z' }] })).toBeUndefined();
    const older = [{ cwd: '/workspace', createdAt: '2026-09-28T10:00:00Z' }, { cwd: '/elsewhere', createdAt: '2026-09-29T10:02:00Z' }];
    expect(f.manager.claimSession({ ...claim, others: older })).toMatchObject({ id: started.id, sessionId: 'conversation' });
    const resumed = await f.manager.create({ ...fresh, sessionId: 'conversation', launchId: 'resume' });
    expect(resumed.id).toBe(started.id); expect(f.factory).toHaveBeenCalledTimes(1);
    await expect(f.manager.create({ ...fresh, owner: 'bob', sessionId: 'conversation', launchId: 'foreign' })).rejects.toThrow('already has a running terminal');
    f.manager.dispose();
  });
  it('leaves an ambiguous or exited fresh terminal unbound', async () => {
    const f = fixture(); const fresh = { ...f.input, target: 'claude', launchId: 'a' };
    const typeInto = (m: typeof f, id: string) => { m.manager.attach('alice', 'workspace', id, m.client); m.manager.control('alice', 'workspace', id, m.client, { type: 'input', data: 'x' }); };
    typeInto(f, (await f.manager.create(fresh)).id);
    const second = { send: vi.fn(), close: vi.fn() }; const b = await f.manager.create({ ...fresh, launchId: 'b' });
    f.manager.attach('alice', 'workspace', b.id, second); f.manager.control('alice', 'workspace', b.id, second, { type: 'input', data: 'x' });
    const claim = { owner: 'alice', workspace: 'workspace', target: 'claude', cwd: '/workspace', sessionId: 'conversation', createdAt: new Date(Date.now() + 60_000).toISOString(), others: [] };
    expect(f.manager.claimSession(claim)).toBeUndefined();
    const single = fixture(); typeInto(single, (await single.manager.create(fresh)).id); single.exit(0);
    expect(single.manager.claimSession(claim)).toBeUndefined();
    f.manager.dispose(); single.manager.dispose();
  });
  it('counts a recently exited terminal as a possible owner of the conversation', async () => {
    const exits: ((event: { exitCode: number }) => void)[] = [];
    const makePty = () => ({ pid: 1, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn(fn => { exits.push(fn); }) }) as unknown as PtyProcess;
    const manager = new TerminalManager(vi.fn(async () => makePty()), vi.fn(), 60_000);
    const base = { owner: 'alice', workspace: 'workspace', cwd: '/workspace', target: 'claude', launch: { file: 'claude', args: [], env: {}, label: 'Claude' } };
    await manager.create({ ...base, launchId: 'first' });
    const second = await manager.create({ ...base, launchId: 'second' });
    exits[0]({ exitCode: 0 });
    const client = { send: vi.fn(), close: vi.fn() };
    manager.attach('alice', 'workspace', second.id, client); manager.control('alice', 'workspace', second.id, client, { type: 'input', data: 'x' });
    expect(manager.claimSession({ owner: 'alice', workspace: 'workspace', target: 'claude', cwd: '/workspace', sessionId: 'conversation', createdAt: new Date(Date.now() + 60_000).toISOString(), others: [] })).toBeUndefined();
    manager.dispose();
  });
  it('reuses a running conversation even at the terminal limit', async () => {
    const f = fixture(); const resume = { ...f.input, target: 'codex', sessionId: 'saved', launchId: 'resume' };
    const saved = await f.manager.create(resume);
    for (let i = 0; i < 7; i++) await f.manager.create({ ...f.input, launchId: `shell-${i}` });
    await expect(f.manager.create({ ...f.input, launchId: 'one-more' })).rejects.toThrow('limit');
    expect((await f.manager.create({ ...resume, launchId: 'again' })).id).toBe(saved.id);
    f.manager.dispose();
  });
  it('reports a missing terminal with a stable code', async () => {
    const f = fixture();
    expect(() => f.manager.attach('alice', 'workspace', 'gone', f.client)).toThrow(TerminalNotFoundError);
    let error: unknown; try { f.manager.stop('alice', 'workspace', 'gone'); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'terminal_not_found' });
  });
  it('does not write to an exited process', async () => {
    const f = fixture(); const { id } = await f.manager.create(f.input); f.manager.attach('alice', 'workspace', id, f.client);
    f.exit(7); expect(f.messages.at(-1)).toMatchObject({ type: 'exit', exitCode: 7 });
    expect(() => f.manager.control('alice', 'workspace', id, f.client, { type: 'input', data: 'lost' })).toThrow('exited');
    f.manager.dispose(); expect(f.terminate).not.toHaveBeenCalled();
  });
});
