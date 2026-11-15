import { describe, expect, it } from 'vitest';
import { computeMountedWorkspaces } from './chatMountedWorkspaces.js';

describe('computeMountedWorkspaces', () => {
  it('returns empty array when openTabs is empty', () => {
    expect(computeMountedWorkspaces([], null, null, false)).toEqual([]);
    expect(computeMountedWorkspaces([], 'alpha', null, false)).toEqual([]);
  });

  it('mounts single active workspace', () => {
    const mounted = computeMountedWorkspaces(['alpha'], 'alpha', null, false);
    expect(mounted).toEqual(['alpha']);
  });

  it('keeps previous workspace mounted when switching between 2 workspaces', () => {
    // Open alpha
    const step1 = computeMountedWorkspaces(['alpha'], 'alpha', null, false, []);
    expect(step1).toEqual(['alpha']);

    // Open beta
    const step2 = computeMountedWorkspaces(['alpha', 'beta'], 'beta', null, false, step1);
    expect(step2).toEqual(['beta', 'alpha']);

    // Switch back to alpha
    const step3 = computeMountedWorkspaces(['alpha', 'beta'], 'alpha', null, false, step2);
    expect(step3).toEqual(['alpha', 'beta']);

    // Switch to beta again
    const step4 = computeMountedWorkspaces(['alpha', 'beta'], 'beta', null, false, step3);
    expect(step4).toEqual(['beta', 'alpha']);
  });

  it('bounds mounted workspaces to 2 when visiting 5 workspaces sequentially (LRU eviction)', () => {
    const all = ['ws1', 'ws2', 'ws3', 'ws4', 'ws5'];

    // 1. Visit ws1
    let mounted = computeMountedWorkspaces(all, 'ws1', null, false, []);
    expect(mounted).toEqual(['ws1']);

    // 2. Visit ws2
    mounted = computeMountedWorkspaces(all, 'ws2', null, false, mounted);
    expect(mounted).toEqual(['ws2', 'ws1']);

    // 3. Visit ws3 -> ws1 drops out
    mounted = computeMountedWorkspaces(all, 'ws3', null, false, mounted);
    expect(mounted).toEqual(['ws3', 'ws2']);

    // 4. Visit ws4 -> ws2 drops out
    mounted = computeMountedWorkspaces(all, 'ws4', null, false, mounted);
    expect(mounted).toEqual(['ws4', 'ws3']);

    // 5. Visit ws5 -> ws3 drops out
    mounted = computeMountedWorkspaces(all, 'ws5', null, false, mounted);
    expect(mounted).toEqual(['ws5', 'ws4']);
    expect(mounted).toHaveLength(2);
    expect(mounted).not.toContain('ws1');
    expect(mounted).not.toContain('ws2');
    expect(mounted).not.toContain('ws3');
  });

  it('unmounts closed tab immediately even if it was active or recently mounted', () => {
    // ws1 and ws2 open, ws2 active
    const step1 = computeMountedWorkspaces(['ws1', 'ws2'], 'ws2', null, false, ['ws2', 'ws1']);
    expect(step1).toEqual(['ws2', 'ws1']);

    // ws2 is closed, fallback to ws1 as active
    const step2 = computeMountedWorkspaces(['ws1'], 'ws1', null, false, step1);
    expect(step2).toEqual(['ws1']);
    expect(step2).not.toContain('ws2');
  });

  it('supports split mode with both active panes mounted plus up to 1 recent inactive pane', () => {
    const tabs = ['alpha', 'beta', 'gamma'];
    // Previously alpha was open
    const prev = ['alpha'];

    // Split mode with alpha and beta
    const splitMounted = computeMountedWorkspaces(tabs, 'alpha', 'beta', true, prev);
    expect(splitMounted).toContain('alpha');
    expect(splitMounted).toContain('beta');
    expect(splitMounted.length).toBeLessThanOrEqual(3);

    // If gamma was in previous, up to 1 inactive is kept
    const withInactive = computeMountedWorkspaces(tabs, 'alpha', 'beta', true, ['gamma', 'alpha']);
    expect(withInactive).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('deduplicates when splitTab equals activeTab', () => {
    const mounted = computeMountedWorkspaces(['alpha'], 'alpha', 'alpha', true, []);
    expect(mounted).toEqual(['alpha']);
  });

  it('ignores workspaces not in openTabs even if passed as activeTab', () => {
    const mounted = computeMountedWorkspaces(['alpha'], 'nonexistent', null, false, ['alpha']);
    expect(mounted).toEqual(['alpha']);
  });

  it('keeps workspaces with running sessions mounted even when LRU capacity is exceeded', () => {
    const all = ['ws1', 'ws2', 'ws3', 'ws4', 'ws5'];
    // ws1 has a running session in background
    let mounted = computeMountedWorkspaces(all, 'ws1', null, false, [], 2, ['ws1']);
    expect(mounted).toEqual(['ws1']);

    // Visit ws2
    mounted = computeMountedWorkspaces(all, 'ws2', null, false, mounted, 2, ['ws1']);
    expect(mounted).toEqual(['ws2', 'ws1']);

    // Visit ws3: ws1 MUST stay mounted because it has a running session! ws2 drops out.
    mounted = computeMountedWorkspaces(all, 'ws3', null, false, mounted, 2, ['ws1']);
    expect(mounted).toContain('ws3');
    expect(mounted).toContain('ws1');
    expect(mounted).not.toContain('ws2');

    // Visit ws4: ws1 still running, so it stays mounted
    mounted = computeMountedWorkspaces(all, 'ws4', null, false, mounted, 2, ['ws1']);
    expect(mounted).toContain('ws4');
    expect(mounted).toContain('ws1');
    expect(mounted).not.toContain('ws3');

    // Visit ws5: ws1 still running, ws5 active
    mounted = computeMountedWorkspaces(all, 'ws5', null, false, mounted, 2, ['ws1']);
    expect(mounted).toContain('ws5');
    expect(mounted).toContain('ws1');
    expect(mounted).toHaveLength(2);
  });

  it('keeps multiple running workspaces mounted alongside the active workspace', () => {
    const all = ['ws1', 'ws2', 'ws3', 'ws4'];
    // ws1 and ws2 both have running sessions; ws3 is active
    const mounted = computeMountedWorkspaces(all, 'ws3', null, false, ['ws4'], 2, ['ws1', 'ws2']);
    expect(mounted).toContain('ws3');
    expect(mounted).toContain('ws1');
    expect(mounted).toContain('ws2');
    // ws4 is inactive, so it is not mounted
    expect(mounted).not.toContain('ws4');
  });

  it('does not mount running workspaces that are not in openTabs', () => {
    const mounted = computeMountedWorkspaces(['ws1'], 'ws1', null, false, [], 2, ['ws2', 'ws3']);
    expect(mounted).toEqual(['ws1']);
    expect(mounted).not.toContain('ws2');
    expect(mounted).not.toContain('ws3');
  });

  it('evicts previously running workspace once its session finishes', () => {
    const all = ['ws1', 'ws2', 'ws3'];
    // ws1 running, ws2 active
    let mounted = computeMountedWorkspaces(all, 'ws2', null, false, ['ws1'], 2, ['ws1']);
    expect(mounted).toEqual(['ws2', 'ws1']);

    // ws1 finishes (no longer in runningWorkspaces), switch to ws3
    mounted = computeMountedWorkspaces(all, 'ws3', null, false, mounted, 2, []);
    expect(mounted).toEqual(['ws3', 'ws2']);
    expect(mounted).not.toContain('ws1');
  });
});
