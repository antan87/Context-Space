import { describe, expect, it, vi } from 'vitest';
import { endWorkspaceSession } from './endWorkspaceSession.js';

const session = (id: string, state: 'running' | 'exited') => ({ id, state });

function fixture(sessions: ReturnType<typeof session>[], failing: string[] = []) {
  const request = vi.fn(async (_workspace: string, action: string) => {
    if (action === 'status') return { sessions };
    if (failing.some((id) => action === `${id}/stop`)) throw new Error('could not stop');
    return { success: true };
  });
  const closeTab = vi.fn();
  return { request: request as never, closeTab };
}

describe('endWorkspaceSession', () => {
  it('stops every running terminal of the workspace and closes its tab, leaving exited ones alone', async () => {
    const deps = fixture([session('one', 'running'), session('two', 'exited'), session('three', 'running')]);
    expect(await endWorkspaceSession('old', deps)).toEqual({ stopped: 2, failed: 0 });
    const actions = (deps.request as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([workspace, action]) => `${workspace}:${action}`);
    expect(actions).toEqual(['old:status', 'old:one/stop', 'old:three/stop']);
    expect(deps.closeTab).toHaveBeenCalledExactlyOnceWith('old');
  });

  it('closes the tab and counts the terminals it could not stop', async () => {
    const deps = fixture([session('one', 'running'), session('two', 'running')], ['two']);
    expect(await endWorkspaceSession('old', deps)).toEqual({ stopped: 1, failed: 1 });
    expect(deps.closeTab).toHaveBeenCalledWith('old');
  });

  it('closes the tab when there is nothing running, or the terminal service cannot be reached', async () => {
    const empty = fixture([]);
    expect(await endWorkspaceSession('old', empty)).toEqual({ stopped: 0, failed: 0 });
    expect(empty.closeTab).toHaveBeenCalledWith('old');

    const unreachable = { request: (async () => { throw new Error('offline'); }) as never, closeTab: vi.fn() };
    expect(await endWorkspaceSession('old', unreachable)).toEqual({ stopped: 0, failed: 0 });
    expect(unreachable.closeTab).toHaveBeenCalledWith('old');
  });
});
