import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildReviewHistoryState,
  createReviewToken,
  getActiveReviewSession,
  isActiveReviewEntry,
  readReviewMarker,
  resetReviewHistoryForTests,
  retireReviewIfWorkspaceChanged,
  retireReviewToken,
  setActiveReviewSession,
  stripReviewHistoryState,
} from './reviewHistory.js';

describe('reviewHistory helpers', () => {
  beforeEach(() => {
    resetReviewHistoryForTests();
  });

  it('builds and reads marker state while dropping ephemeral chatDock marks', () => {
    const state = buildReviewHistoryState({ custom: 'keep', chatDock: 42 }, { workspace: 'demo', token: 't1' });
    expect(state).toEqual({ custom: 'keep', __review: { workspace: 'demo', token: 't1' } });
    expect(readReviewMarker(state)).toEqual({ workspace: 'demo', token: 't1' });
    expect(stripReviewHistoryState(state)).toEqual({ custom: 'keep' });
    expect(stripReviewHistoryState({ __review: { workspace: 'demo', token: 't1' }, chatDock: 1 })).toBeNull();
  });

  it('rejects malformed review markers', () => {
    for (const bad of [null, undefined, 'x', {}, { __review: null }, { __review: { workspace: '', token: 't1' } }, { __review: { workspace: 'demo' } }]) {
      expect(readReviewMarker(bad)).toBeNull();
    }
  });

  it('treats live tokens as active for the matching workspace and rejects retired or unknown (reloaded) tokens', () => {
    const t1 = createReviewToken('alpha');
    const state = buildReviewHistoryState(null, { workspace: 'alpha', token: t1 });
    expect(isActiveReviewEntry(state, 'alpha')).toBe(true);
    expect(isActiveReviewEntry(state, 'beta')).toBe(false);

    // Simulated reload: live set is empty even if state stayed in browser history
    expect(isActiveReviewEntry(state, 'alpha', new Set(), new Set())).toBe(false);

    // Workspace switch retirement prevents later Back navigation from reopening Review
    setActiveReviewSession({ workspace: 'alpha', token: t1, locationKey: 'k1' });
    expect(getActiveReviewSession()).toEqual({ workspace: 'alpha', token: t1, locationKey: 'k1' });
    expect(retireReviewIfWorkspaceChanged('alpha')).toBeNull();
    expect(retireReviewIfWorkspaceChanged('beta')).toBe('alpha');
    expect(getActiveReviewSession()).toBeNull();
    expect(isActiveReviewEntry(state, 'alpha')).toBe(false);

    const t2 = createReviewToken('beta');
    retireReviewToken(t2);
    expect(isActiveReviewEntry(buildReviewHistoryState(null, { workspace: 'beta', token: t2 }), 'beta')).toBe(false);
  });
});
