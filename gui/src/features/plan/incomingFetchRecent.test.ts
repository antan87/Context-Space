import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { applyIncomingReport, ensureWatcher, newsKey, recentCommitsKey, type IncomingCommitsReport } from './whatsNew';

const report = (fetching: boolean): IncomingCommitsReport => ({
  at: '2026-11-10T12:00:00Z',
  repos: [{
    repo: 'app', remote: 'origin', branch: 'feat/x', host: null, lastFetchAt: null, fetching, state: fetching ? 'checking' : 'ok',
    message: null, behind: 0, commits: [], more: 0,
  }],
});

describe('an automatic incoming fetch completing', () => {
  it('reads Recent Commits again (it settled first, before the PR head was fetched), as well as the news', () => {
    const client = new QueryClient();
    client.setQueryData(recentCommitsKey('demo'), { at: 'x', from: 'y', commits: [] });
    client.setQueryData(newsKey('demo'), { empty: true });
    const watcher = ensureWatcher(client, 'demo');
    // Ordering: Recent Commits has settled; the fetch is still running...
    applyIncomingReport(client, 'demo', watcher, report(true));
    expect(client.getQueryState(recentCommitsKey('demo'))?.isInvalidated).toBe(false);
    // ...then the fetch completes.
    applyIncomingReport(client, 'demo', watcher, report(false));
    expect(client.getQueryState(newsKey('demo'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(recentCommitsKey('demo'))?.isInvalidated).toBe(true);
  });
});
