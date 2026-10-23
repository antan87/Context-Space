import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveEvent, ScreenEvent } from '../../types';
import { FEED_MAX_EVENTS, addScreenEvent, cleanScreenEvent, connectScreenFeed, parseLiveFrame, type EventSourceLike } from './screenFeed';

const base = { id: 'e1', timestamp: '2026-10-02T10:00:00.000Z', harness: 'claude' };
const frame = (type: string, body: Record<string, unknown>) => JSON.stringify({ type, ...body });
const screen = (event: string, payload: unknown, extra: Record<string, unknown> = {}) => frame('screen', { event: { ...base, event, payload, ...extra } });

describe('cleanScreenEvent', () => {
  it('rebuilds each kind from its known fields and drops everything else', () => {
    expect(cleanScreenEvent({ ...base, event: 'next', payload: { title: 'Add tests', reason: 'No coverage', path: 'a.ts', repo: 'api', line: 3, evil: '<script>' }, extra: 1 }))
      .toEqual({ ...base, event: 'next', payload: { title: 'Add tests', reason: 'No coverage', path: 'a.ts', repo: 'api', line: 3 } });
    expect(cleanScreenEvent({ ...base, event: 'milestone_proposal', payload: { stepId: 'a', proposal: 'reopen', reason: 'Wrong', more: true } }))
      .toEqual({ ...base, event: 'milestone_proposal', payload: { stepId: 'a', proposal: 'reopen', reason: 'Wrong' } });
    expect(cleanScreenEvent({ ...base, event: 'milestone', payload: { stepId: 'a', state: 'blocked', note: 'Needs a key' } }))
      .toEqual({ ...base, event: 'milestone', payload: { stepId: 'a', state: 'blocked', note: 'Needs a key' } });
    expect(cleanScreenEvent({ ...base, event: 'show', payload: { view: 'diff' } })).toEqual({ ...base, event: 'show', payload: { view: 'diff' } });
    expect(cleanScreenEvent({ ...base, event: 'annotate', payload: { path: 'a.ts', line: 4, text: 'Why?', tag: 'nonsense' } }))
      .toEqual({ ...base, event: 'annotate', payload: { path: 'a.ts', line: 4, text: 'Why?', tag: 'question' } });
  });

  it('refuses events with a missing or wrongly typed field', () => {
    const bad: unknown[] = [
      null, 'x', 7, {}, { ...base, event: 'next' }, { ...base, event: 'next', payload: null },
      { ...base, event: 'next', payload: { title: '', reason: 'r' } },
      { ...base, event: 'next', payload: { title: 't', reason: 5 } },
      { ...base, event: 'milestone_proposal', payload: { stepId: 'a', proposal: 'delete', reason: 'r' } },
      { ...base, event: 'milestone', payload: { stepId: 'a', state: 'completed' } },
      { ...base, event: 'show', payload: { view: 'everything' } },
      { ...base, event: 'annotate', payload: { path: 'a.ts', line: 0, text: 't' } },
      { ...base, event: 'annotate', payload: { path: 'a.ts', line: 1.5, text: 't' } },
      { ...base, event: 'unknown', payload: {} },
      { id: 5, timestamp: base.timestamp, harness: 'x', event: 'next', payload: { title: 't', reason: 'r' } },
      { ...base, id: '', event: 'next', payload: { title: 't', reason: 'r' } },
    ];
    for (const raw of bad) expect(cleanScreenEvent(raw), JSON.stringify(raw)).toBeNull();
  });

  it('drops a bad line number or optional text instead of refusing the event', () => {
    expect(cleanScreenEvent({ ...base, event: 'next', payload: { title: 't', reason: 'r', path: 7, line: -2 } }))
      .toEqual({ ...base, event: 'next', payload: { title: 't', reason: 'r' } });
  });
});

describe('parseLiveFrame', () => {
  it('reads screen, question, answered and plan frames', () => {
    expect(parseLiveFrame(screen('next', { title: 't', reason: 'r' }))).toMatchObject({ type: 'screen', event: { event: 'next' } });
    expect(parseLiveFrame(frame('question', { request: { id: 'q', timestamp: base.timestamp, harness: 'claude', message: 'Which?', options: ['a', '', 'b', 4] } })))
      .toEqual({ type: 'question', request: { id: 'q', timestamp: base.timestamp, harness: 'claude', message: 'Which?', options: ['a', 'b'] } });
    expect(parseLiveFrame(frame('answered', { timestamp: base.timestamp }))).toEqual({ type: 'answered', timestamp: base.timestamp });
    expect(parseLiveFrame(frame('plan', { timestamp: base.timestamp }))).toEqual({ type: 'plan', timestamp: base.timestamp });
  });

  it('keeps at most six options on a question', () => {
    const options = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const live = parseLiveFrame(frame('question', { request: { id: 'q', timestamp: base.timestamp, harness: 'c', message: 'm', options } }));
    expect(live?.type === 'question' && live.request.options).toEqual(options.slice(0, 6));
  });

  it('returns null for anything malformed, never throwing', () => {
    for (const data of [undefined, null, 5, '', 'not json', '[]', 'null', '"x"', '{}', frame('screen', {}), frame('screen', { event: null }), frame('question', { request: { id: 'q' } }),
      frame('answered', {}), frame('answered', { timestamp: '' }), frame('plan', {}), frame('ping', {})]) {
      expect(parseLiveFrame(data), String(data)).toBeNull();
    }
  });
});

describe('board events', () => {
  const board = (payload: unknown, extra: Record<string, unknown> = {}) => screen('board', payload, extra);

  it('are read into their own kind of live event, never a screen event', () => {
    expect(parseLiveFrame(board({ revision: 12, changes: 2 }))).toEqual({ type: 'board', timestamp: base.timestamp, revision: 12 });
    expect(parseLiveFrame(board({ revision: 0, changes: 1, evil: '<script>' }, { harness: 'codex' }))).toEqual({ type: 'board', timestamp: base.timestamp, revision: 0 });
  });

  it('are not screen events: nothing that shows screen events can be handed one', () => {
    expect(cleanScreenEvent({ ...base, event: 'board', payload: { revision: 1, changes: 1 } })).toBeNull();
  });

  it('are dropped when malformed, never throwing', () => {
    for (const data of [board(null), board({}), board({ revision: '3', changes: 1 }), board({ revision: -1, changes: 1 }), board({ revision: 1.5, changes: 1 }), board({ revision: 1 }, { timestamp: '' }),
      frame('screen', { event: { ...base, event: 'board' } }), frame('board', { timestamp: base.timestamp, revision: 1 })]) {
      expect(parseLiveFrame(data), data).toBeNull();
    }
  });
});

describe('addScreenEvent', () => {
  const event = (id: string): ScreenEvent => ({ id, timestamp: base.timestamp, harness: 'c', event: 'next', payload: { title: id, reason: 'r' } });

  it('adds an event once, handing back the same list when it is already there', () => {
    const one = addScreenEvent([], event('a'));
    expect(one).toHaveLength(1);
    expect(addScreenEvent(one, event('a'))).toBe(one);
  });

  it('keeps the newest events when the list is full', () => {
    let list: readonly ScreenEvent[] = [];
    for (let i = 0; i < FEED_MAX_EVENTS + 5; i += 1) list = addScreenEvent(list, event(`e${i}`));
    expect(list).toHaveLength(FEED_MAX_EVENTS);
    expect(list[0]!.id).toBe('e5');
    expect(list.at(-1)!.id).toBe(`e${FEED_MAX_EVENTS + 4}`);
  });
});

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  constructor(readonly url: string) { FakeSource.all.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  close() { this.closed = true; this.readyState = 2; }
  emit(type: string, data?: unknown, lastEventId = '') { for (const listener of this.listeners.get(type) ?? []) listener({ data, lastEventId } as MessageEvent); }
}

describe('connectScreenFeed', () => {
  const lives: LiveEvent[] = [];
  const statuses: boolean[] = [];
  const connect = () => connectScreenFeed({
    url: (since) => `/feed${since ? `?since=${since}` : ''}`,
    onLive: (live) => lives.push(live),
    onStatus: (connected) => statuses.push(connected),
    createSource: (url) => new FakeSource(url),
    retryMs: 1000,
  });

  beforeEach(() => { vi.useFakeTimers(); FakeSource.all = []; lives.length = 0; statuses.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the stream, reports it open and passes events on', () => {
    connect();
    const [source] = FakeSource.all;
    expect(source!.url).toBe('/feed');
    source!.emit('open');
    source!.emit('screen', screen('next', { title: 't', reason: 'r' }), 'id-1');
    source!.emit('question', frame('question', { request: { id: 'q', timestamp: base.timestamp, harness: 'c', message: 'm' } }), 'id-2');
    expect(statuses).toEqual([true]);
    expect(lives.map((live) => live.type)).toEqual(['screen', 'question']);
  });

  it('passes a board event on as a board event, and resumes after it like any other', () => {
    connect();
    const [first] = FakeSource.all;
    first!.emit('screen', screen('board', { revision: 3, changes: 1 }), '2026-10-02T10:30:00.000Z');
    expect(lives).toEqual([{ type: 'board', timestamp: base.timestamp, revision: 3 }]);
    first!.readyState = 2;
    first!.emit('error');
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all[1]!.url).toBe('/feed?since=2026-10-02T10:30:00.000Z');
  });

  it('skips malformed frames and keeps going', () => {
    connect();
    const [source] = FakeSource.all;
    source!.emit('screen', 'garbage', 'id-1');
    source!.emit('screen', undefined);
    source!.emit('screen', screen('next', { title: 't', reason: 'r' }), 'id-2');
    expect(lives).toHaveLength(1);
  });

  it('leaves the browser to reconnect a dropped stream and only reports it as down', () => {
    connect();
    const [source] = FakeSource.all;
    source!.readyState = 0; // CONNECTING: the browser is retrying by itself
    source!.emit('error');
    vi.advanceTimersByTime(10_000);
    expect(statuses).toEqual([false]);
    expect(FakeSource.all).toHaveLength(1);
    expect(source!.closed).toBe(false);
  });

  it('opens a new stream after the browser gives up, resuming after the last event it saw', () => {
    connect();
    const [first] = FakeSource.all;
    first!.emit('screen', screen('next', { title: 't', reason: 'r' }), '2026-10-02T10:00:00.000Z');
    first!.readyState = 2;
    first!.emit('error');
    expect(first!.closed).toBe(true);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(2);
    expect(FakeSource.all[1]!.url).toBe('/feed?since=2026-10-02T10:00:00.000Z');
  });

  it('does not move the resume point for a frame it could not read', () => {
    connect();
    const [first] = FakeSource.all;
    first!.emit('screen', screen('next', { title: 't', reason: 'r' }), 'good');
    first!.emit('screen', 'garbage', 'bad');
    first!.readyState = 2;
    first!.emit('error');
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all[1]!.url).toBe('/feed?since=good');
  });

  it('stops for good when closed: no events, no status, no retry', () => {
    const connection = connect();
    const [source] = FakeSource.all;
    connection.close();
    expect(source!.closed).toBe(true);
    source!.emit('open');
    source!.emit('screen', screen('next', { title: 't', reason: 'r' }), 'id');
    expect(lives).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it('does not retry after being closed while waiting to retry', () => {
    const connection = connect();
    const [source] = FakeSource.all;
    source!.readyState = 2;
    source!.emit('error');
    connection.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeSource.all).toHaveLength(1);
  });

  it('ignores events from a stream it already replaced', () => {
    connect();
    const [first] = FakeSource.all;
    first!.readyState = 2;
    first!.emit('error');
    vi.advanceTimersByTime(1000);
    first!.emit('screen', screen('next', { title: 'late', reason: 'r' }), 'late');
    expect(lives).toEqual([]);
  });
});
