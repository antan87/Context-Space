import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { invalidateDeliveryState } from './queries.js';
import { newsKey, recentCommitsKey } from '../../features/plan/whatsNew.js';

describe('delivery state refresh', () => {
  it('refetches active board queries for the changed workspace only', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const fetchers = Array.from({ length: 6 }, () => vi.fn(async () => 'data'));
    const keys = [newsKey('demo'), recentCommitsKey('demo'), newsKey('other'), recentCommitsKey('other'), ['board-commit', 'demo', 'billing', 'abc1234'], ['board-commit', 'other', 'billing', 'abc1234']];
    const observers = keys.map((queryKey, index) => new QueryObserver(client, { queryKey, queryFn: fetchers[index]! }));
    const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
    await Promise.all(observers.map((observer) => observer.refetch()));
    fetchers.forEach((fetcher) => fetcher.mockClear());
    await invalidateDeliveryState(client, 'demo');
    expect(fetchers.map((fetcher) => fetcher.mock.calls.length)).toEqual([1, 1, 0, 0, 1, 0]);
    unsubscribe.forEach((stop) => stop());
    client.clear();
  });
});
