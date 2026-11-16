import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { progressFactsKey } from '../../lib/api/queries.js';
import type { LiveEvent, ScreenEvent } from '../../types.js';
import { boardKey } from '../board/boardData.js';
import { planFileKey } from '../plan/planFile.js';
import { EMPTY_FEED, REFRESH_DELAY_MS, createLiveFeedHub, type FeedState } from './liveFeedHub.js';
import type { ScreenFeedOptions } from './screenFeed.js';

const next = (id: string): ScreenEvent => ({ id, timestamp: '2026-10-23T10:00:00.000Z', harness: 'claude', event: 'next', payload: { title: id, reason: 'r' } });

/** A stand-in for the connection: the hub's callbacks are driven by hand. */
class FakeFeed {
  opened: ScreenFeedOptions[] = [];
  closed = 0;
  connect = (options: ScreenFeedOptions) => {
    this.opened.push(options);
    return { close: () => { this.closed += 1; } };
  };
  get current() { return this.opened.at(-1)!; }
  live(event: LiveEvent) { this.current.onLive(event); }
  status(connected: boolean) { this.current.onStatus?.(connected); }
}

describe('liveFeedHub', () => {
  let feed: FeedState[];
  let queryClient: QueryClient;
  let invalidated: unknown[];
  let fake: FakeFeed;
  let hub: ReturnType<typeof createLiveFeedHub>;
  const listen = (workspace = 'demo') => hub.subscribe(workspace, queryClient, (state) => feed.push(state));

  beforeEach(() => {
    vi.useFakeTimers();
    feed = [];
    invalidated = [];
    queryClient = new QueryClient();
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(async (filters) => { invalidated.push(filters?.queryKey); });
    fake = new FakeFeed();
    hub = createLiveFeedHub(fake.connect);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('opens one connection for everything that listens to a workspace, and closes it after the last one stops', () => {
    const stopStrip = listen();
    const stopBoard = listen();
    expect(fake.opened).toHaveLength(1);
    stopStrip();
    expect(fake.closed).toBe(0);
    stopBoard();
    expect(fake.closed).toBe(1);
    // Listening again opens a new one.
    listen();
    expect(fake.opened).toHaveLength(2);
  });

  it('keeps a connection for each workspace', () => {
    const stopOne = listen('one');
    listen('two');
    expect(fake.opened.map((options) => options.url(undefined))).toEqual([expect.stringContaining('/api/workspace/one/screen-events'), expect.stringContaining('/api/workspace/two/screen-events')]);
    stopOne();
    expect(fake.closed).toBe(1);
  });

  it('tells a listener at once what is kept, and then what changes', () => {
    listen();
    expect(feed).toEqual([EMPTY_FEED]);
    fake.status(true);
    fake.live({ type: 'screen', event: next('a') });
    expect(feed.at(-1)).toEqual({ connected: true, events: [next('a')] });
  });

  it('gives a listener that comes late the events the stream already sent, which it does not send again', () => {
    listen();
    fake.status(true);
    fake.live({ type: 'screen', event: next('a') });
    fake.live({ type: 'screen', event: next('b') });
    const late: FeedState[] = [];
    hub.subscribe('demo', queryClient, (state) => late.push(state));
    expect(fake.opened).toHaveLength(1);
    expect(late).toEqual([{ connected: true, events: [next('a'), next('b')] }]);
    fake.live({ type: 'screen', event: next('c') });
    expect(late.at(-1)!.events.map((event) => event.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps an event once, and never a board event', () => {
    listen();
    fake.live({ type: 'screen', event: next('a') });
    fake.live({ type: 'screen', event: next('a') });
    fake.live({ type: 'board', timestamp: '2026-10-23T10:00:00.000Z', revision: 3 });
    expect(feed.at(-1)!.events).toEqual([next('a')]);
  });

  it('forgets what it kept when the last listener goes, so the next one gets what the stream replays', () => {
    const stop = listen();
    fake.live({ type: 'screen', event: next('a') });
    stop();
    feed = [];
    listen();
    expect(feed).toEqual([EMPTY_FEED]);
  });

  it('reads the board again after a board event, a burst of them once, and nothing else', () => {
    listen();
    for (const revision of [2, 3, 4]) fake.live({ type: 'board', timestamp: '2026-10-23T10:00:00.000Z', revision });
    expect(invalidated).toEqual([]);
    vi.advanceTimersByTime(REFRESH_DELAY_MS - 1);
    expect(invalidated).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(invalidated).toEqual([boardKey('demo')]);
    vi.advanceTimersByTime(5000);
    expect(invalidated).toEqual([boardKey('demo')]);
  });

  it('reads the board again whenever the connection opens, because the stream does not replay board events', () => {
    listen();
    fake.status(true);
    expect(invalidated).toEqual([boardKey('demo')]);
    fake.status(false);
    expect(invalidated).toHaveLength(1);
    fake.status(true);
    expect(invalidated).toEqual([boardKey('demo'), boardKey('demo')]);
    expect(feed.map((state) => state.connected)).toEqual([false, true, false, true]);
  });

  it('reads the plan and what hangs on it when the plan changes, and the facts after any event', () => {
    listen();
    fake.live({ type: 'plan', timestamp: '2026-10-23T10:00:00.000Z' });
    expect(invalidated).toContainEqual(planFileKey('demo'));
    expect(invalidated).toContainEqual(['needs-you']);
    expect(invalidated).not.toContainEqual(progressFactsKey('demo'));
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(invalidated).toContainEqual(progressFactsKey('demo'));
    invalidated.length = 0;
    fake.live({ type: 'screen', event: next('a') });
    fake.live({ type: 'screen', event: next('b') });
    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    expect(invalidated).toEqual([progressFactsKey('demo')]);
  });

  it('reads nothing after the last listener has gone', () => {
    const stop = listen();
    fake.live({ type: 'board', timestamp: '2026-10-23T10:00:00.000Z', revision: 2 });
    fake.live({ type: 'screen', event: next('a') });
    stop();
    vi.advanceTimersByTime(10_000);
    expect(invalidated).toEqual([]);
  });

  it('can be stopped twice, and one stop does not end what another listener started', () => {
    const stop = listen();
    listen();
    stop();
    stop();
    expect(fake.closed).toBe(0);
  });
});
