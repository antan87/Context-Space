import { describe, expect, it } from 'vitest';

import type { RunningTerminal } from '../terminal/client.js';
import { WORKING_WINDOW_MS, liveSessions, liveText, runningFirst, workingIn } from './liveSessions.js';

const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const terminal = (workspace: string, extra: Partial<RunningTerminal> = {}): RunningTerminal => ({
  id: `${workspace}-${extra.target ?? 'claude'}`, workspace, target: 'claude', label: 'Claude Code', cwd: `/${workspace}`,
  startedAt: ago(600_000), state: 'running', attached: true, ...extra,
});

describe('liveSessions', () => {
  it('marks a CLI that printed a moment ago as working and one at its prompt as idle', () => {
    const live = liveSessions([
      terminal('alpha', { lastOutputAt: ago(2_000) }),
      terminal('beta', { lastOutputAt: ago(WORKING_WINDOW_MS + 1) }),
      terminal('gamma'),
    ], new Set(), NOW);
    expect(live.get('alpha')?.state).toBe('working');
    expect(live.get('beta')?.state).toBe('idle');
    expect(live.get('gamma')?.state).toBe('idle');
  });

  it('says waiting for you first, then that no chat is open, before working', () => {
    const live = liveSessions([
      terminal('alpha', { lastOutputAt: ago(1_000) }),
      terminal('beta', { lastOutputAt: ago(1_000), attached: false, stopsAt: new Date(NOW + 240_000).toISOString() }),
    ], new Set(['alpha']), NOW);
    expect(live.get('alpha')?.state).toBe('waiting');
    expect(live.get('beta')).toMatchObject({ state: 'closing', stopsAt: new Date(NOW + 240_000).toISOString() });
  });

  it('groups the terminals of one workspace: every tool once, in the order they started, and the last stop time', () => {
    const live = liveSessions([
      terminal('alpha', { target: 'shell', label: 'bash', startedAt: ago(10_000), attached: false, stopsAt: new Date(NOW + 60_000).toISOString() }),
      terminal('alpha', { id: 'a2', target: 'claude', startedAt: ago(20_000), attached: false, stopsAt: new Date(NOW + 200_000).toISOString() }),
      terminal('alpha', { id: 'a3', target: 'claude', startedAt: ago(5_000), attached: false, stopsAt: new Date(NOW + 100_000).toISOString() }),
    ], new Set(), NOW);
    expect(live.get('alpha')).toMatchObject({ targets: ['claude', 'shell'], state: 'closing', stopsAt: new Date(NOW + 200_000).toISOString() });
  });

  it('is shown as long as one of its terminals has a window', () => {
    const live = liveSessions([
      terminal('alpha', { attached: false, stopsAt: new Date(NOW + 60_000).toISOString() }),
      terminal('alpha', { id: 'a2', target: 'shell', attached: true }),
    ], new Set(), NOW);
    expect(live.get('alpha')).toMatchObject({ state: 'idle', stopsAt: undefined });
  });

  it('leaves out exited terminals and workspaces with nothing running', () => {
    const live = liveSessions([terminal('alpha', { state: 'exited' })], new Set(['alpha']), NOW);
    expect(live.size).toBe(0);
  });

  it('does not trust a malformed timestamp', () => {
    const live = liveSessions([terminal('alpha', { lastOutputAt: 'yesterday', attached: false, stopsAt: 'soon' })], new Set(), NOW);
    expect(live.get('alpha')).toMatchObject({ state: 'closing', stopsAt: undefined });
    expect(liveText(live.get('alpha')!, NOW)).toBe('Claude Code is running with no chat open');
  });
});

describe('workingIn', () => {
  it('is true while a running CLI in that workspace printed a moment ago, and false otherwise', () => {
    const terminals = [terminal('alpha', { lastOutputAt: ago(2_000) }), terminal('beta', { lastOutputAt: ago(WORKING_WINDOW_MS + 1) }),
      terminal('gamma', { lastOutputAt: ago(1_000), state: 'exited' })];
    expect(workingIn(terminals, 'alpha', NOW)).toBe(true);
    expect(workingIn(terminals, 'beta', NOW)).toBe(false);
    expect(workingIn(terminals, 'gamma', NOW)).toBe(false);
    expect(workingIn(undefined, 'alpha', NOW)).toBe(false);
  });
});

describe('liveText', () => {
  it('says who is running and what they are doing', () => {
    expect(liveText({ workspace: 'a', targets: ['claude'], state: 'working' }, NOW)).toBe('Claude Code is running and working');
    expect(liveText({ workspace: 'a', targets: ['codex', 'shell'], state: 'idle' }, NOW)).toBe('Codex and Shell are running and idle');
    expect(liveText({ workspace: 'a', targets: ['claude', 'codex', 'shell'], state: 'waiting' }, NOW)).toBe('Claude Code, Codex and Shell are running and waiting for you');
  });

  it('counts down to the stop of a CLI with no chat open', () => {
    expect(liveText({ workspace: 'a', targets: ['claude'], state: 'closing', stopsAt: new Date(NOW + 239_000).toISOString() }, NOW))
      .toBe('Claude Code is running with no chat open, and stops in 4 minutes');
    expect(liveText({ workspace: 'a', targets: ['claude'], state: 'closing', stopsAt: new Date(NOW + 30_000).toISOString() }, NOW))
      .toBe('Claude Code is running with no chat open, and stops within a minute');
  });
});

describe('runningFirst', () => {
  it('moves workspaces with a running CLI to the top and keeps the order inside each group', () => {
    const live = liveSessions([terminal('c'), terminal('a')], new Set(), NOW);
    const sorted = runningFirst(['a', 'b', 'c', 'd'].map((branchName) => ({ branchName })), live);
    expect(sorted.map((workspace) => workspace.branchName)).toEqual(['a', 'c', 'b', 'd']);
  });
});
