import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acknowledgeInputRequests } from './attention.js';
import { resolveWorkspaceChatLedger } from './constants.js';
import {
  SCREEN_EVENTS_FILE,
  SCREEN_EVENTS_MAX_BYTES,
  SCREEN_EVENT_MAX_AGE_MS,
  SCREEN_EVENT_REPEAT_WINDOW_MS,
  SCREEN_EVENT_REPLAY_LIMIT,
  appendScreenEvent,
  listScreenEvents,
  parseScreenEntry,
  watchLiveEvents,
  type LiveEvent,
} from './screen-events.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let dir: string;
let ledgerDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-events-'));
  ledgerDir = (await resolveWorkspaceChatLedger(dir)).chatDir;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); });

const file = () => path.join(ledgerDir, SCREEN_EVENTS_FILE);
const lines = async () => (await fs.readFile(file(), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e1', timestamp: ago(MIN), harness: 'claude', author: 'agent', kind: 'screen_event', event: 'show',
  payload: { view: 'document', path: 'plan.md', line: 12 }, ...over,
});

describe('parseScreenEntry', () => {
  it('reads each kind of event and keeps only the fields it knows', () => {
    expect(parseScreenEntry(entry(), NOW)).toEqual({ id: 'e1', timestamp: ago(MIN), harness: 'claude', event: 'show', payload: { view: 'document', path: 'plan.md', line: 12 } });
    expect(parseScreenEntry(entry({ event: 'annotate', payload: { path: 'a.ts', line: 3, text: 'Why?', tag: 'risk', extra: 'dropped' } }), NOW)!.payload)
      .toEqual({ path: 'a.ts', line: 3, text: 'Why?', tag: 'risk' });
    expect(parseScreenEntry(entry({ event: 'next', payload: { title: 'Answer', reason: 'Build is paused', path: 'plan.md', line: 2, junk: 1 } }), NOW)!.payload)
      .toEqual({ title: 'Answer', reason: 'Build is paused', path: 'plan.md', line: 2 });
    expect(parseScreenEntry(entry({ event: 'milestone', payload: { stepId: 'plan', state: 'blocked', note: 'Waiting' } }), NOW)!.payload)
      .toEqual({ stepId: 'plan', state: 'blocked', note: 'Waiting' });
    expect(parseScreenEntry(entry({ event: 'milestone_proposal', payload: { stepId: 'plan', proposal: 'reopen', reason: 'Gap' } }), NOW)!.payload)
      .toEqual({ stepId: 'plan', proposal: 'reopen', reason: 'Gap' });
  });

  it('defaults an annotation to a question and a harness to agent', () => {
    const parsed = parseScreenEntry(entry({ harness: '\u0007', event: 'annotate', payload: { path: 'a.ts', line: 1, text: 'x', tag: 'nonsense' } }), NOW)!;
    expect(parsed.harness).toBe('agent');
    expect((parsed.payload as { tag: string }).tag).toBe('question');
  });

  it('lets a diff name no file, but nothing else may', () => {
    expect(parseScreenEntry(entry({ payload: { view: 'diff', repo: 'NexusFlow' } }), NOW)!.payload).toEqual({ view: 'diff', repo: 'NexusFlow' });
    expect(parseScreenEntry(entry({ payload: { view: 'document' } }), NOW)).toBeNull();
    expect(parseScreenEntry(entry({ payload: { view: 'file' } }), NOW)).toBeNull();
  });

  it.each([
    ['an absolute path', { view: 'file', path: '/etc/passwd' }],
    ['a climbing path', { view: 'file', path: '../../etc/passwd' }],
    ['a Windows path', { view: 'file', path: 'C:\\Windows\\a' }],
    ['Git internals', { view: 'file', path: '.git/config' }],
    ['an unknown view', { view: 'terminal', path: 'a' }],
    ['no payload fields', {}],
  ])('drops a show event with %s', (_n, payload) => {
    expect(parseScreenEntry(entry({ payload }), NOW)).toBeNull();
  });

  it('ignores an end line before the start line and a line that is not a positive whole number', () => {
    expect(parseScreenEntry(entry({ payload: { view: 'file', path: 'a', line: 10, endLine: 4 } }), NOW)!.payload).toEqual({ view: 'file', path: 'a', line: 10 });
    expect(parseScreenEntry(entry({ payload: { view: 'file', path: 'a', line: 0 } }), NOW)!.payload).toEqual({ view: 'file', path: 'a' });
    expect(parseScreenEntry(entry({ payload: { view: 'file', path: 'a', line: 1.5 } }), NOW)!.payload).toEqual({ view: 'file', path: 'a' });
  });

  it.each([
    ['an annotation without text', { event: 'annotate', payload: { path: 'a', line: 1 } }],
    ['an annotation without a line', { event: 'annotate', payload: { path: 'a', text: 'x' } }],
    ['a suggestion without a reason', { event: 'next', payload: { title: 'x' } }],
    ['a milestone event with a bad id', { event: 'milestone', payload: { stepId: '../x', state: 'blocked' } }],
    ['a milestone event with an unknown state', { event: 'milestone', payload: { stepId: 'a', state: 'completed' } }],
    ['a proposal with an unknown kind', { event: 'milestone_proposal', payload: { stepId: 'a', proposal: 'delete', reason: 'x' } }],
    ['a proposal without a reason', { event: 'milestone_proposal', payload: { stepId: 'a', proposal: 'reopen' } }],
    ['an unknown event', { event: 'shell', payload: { cmd: 'rm -rf /' } }],
    ['a payload that is not an object', { payload: 'plan.md' }],
    ['a missing id', { id: undefined }],
    ['an empty id', { id: '' }],
    ['a bad timestamp', { timestamp: 'yesterday' }],
    ['a timestamp from the future', { timestamp: new Date(NOW + 60 * MIN).toISOString() }],
    ['another kind of entry', { kind: 'input_request' }],
  ])('drops %s', (_n, over) => {
    expect(parseScreenEntry(entry(over), NOW)).toBeNull();
  });

  it('cleans and cuts text so a ledger cannot reshape the screen or overflow it', () => {
    const parsed = parseScreenEntry(entry({ event: 'next', payload: { title: 'x'.repeat(500), reason: 'Line\u001b[31m\none', path: 'a' } }), NOW)!;
    const payload = parsed.payload as { title: string; reason: string };
    expect(payload.title).toHaveLength(120);
    expect(payload.reason).toBe('Line[31m one');
  });

  it('is null for anything that is not an object', () => {
    for (const value of [null, undefined, 'x', 7, []]) expect(parseScreenEntry(value, NOW)).toBeNull();
  });
});

describe('appendScreenEvent', () => {
  it('writes one line, in its own file and not in the chat ledger', async () => {
    const result = await appendScreenEvent(dir, { harness: 'claude', event: 'show', payload: { view: 'document', path: 'plan.md' } }, NOW);
    expect(result.status).toBe('shown');
    const written = await lines();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: 'screen_event', author: 'agent', harness: 'claude', event: 'show', timestamp: new Date(NOW).toISOString() });
    expect(written[0].id).toBe(result.event.id);
    const chat = (await resolveWorkspaceChatLedger(dir)).chatPath;
    expect(await fs.readFile(chat, 'utf8').catch(() => '')).toBe('');
  });

  it('does not write a second line for the same event from the same agent inside the repeat window', async () => {
    const input = { harness: 'claude', event: 'show', payload: { view: 'document', path: 'plan.md', line: 3 } } as const;
    const first = await appendScreenEvent(dir, input, NOW);
    const second = await appendScreenEvent(dir, input, NOW + 30_000);
    expect(second.status).toBe('already_shown');
    expect(second.event.id).toBe(first.event.id);
    expect(await lines()).toHaveLength(1);
  });

  it('writes again once the window has passed, for a different agent, or for different content', async () => {
    const input = { harness: 'claude', event: 'show', payload: { view: 'document', path: 'plan.md' } } as const;
    await appendScreenEvent(dir, input, NOW);
    expect((await appendScreenEvent(dir, input, NOW + SCREEN_EVENT_REPEAT_WINDOW_MS + 1)).status).toBe('shown');
    expect((await appendScreenEvent(dir, { ...input, harness: 'codex' }, NOW + SCREEN_EVENT_REPEAT_WINDOW_MS + 2)).status).toBe('shown');
    expect((await appendScreenEvent(dir, { ...input, payload: { view: 'document', path: 'other.md' } }, NOW + SCREEN_EVENT_REPEAT_WINDOW_MS + 3)).status).toBe('shown');
    expect(await lines()).toHaveLength(4);
  });

  it('treats the same content spelled differently as the same event', async () => {
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Answer', reason: 'Paused' } }, NOW);
    const again = await appendScreenEvent(dir, { event: 'next', payload: { title: '  Answer ', reason: 'Paused\n' } }, NOW + 1000);
    expect(again.status).toBe('already_shown');
  });

  it('refuses an unusable payload and writes nothing', async () => {
    await expect(appendScreenEvent(dir, { event: 'show', payload: { view: 'file', path: '/etc/passwd' } }, NOW)).rejects.toThrow(/not a usable show event/);
    await expect(appendScreenEvent(dir, { event: 'annotate', payload: { path: 'a', line: 0, text: 'x', tag: 'risk' } }, NOW)).rejects.toThrow();
    expect(await lines()).toEqual([]);
  });

  it('records one line when the same event is written twice at the same moment', async () => {
    const input = { harness: 'claude', event: 'next', payload: { title: 'Answer', reason: 'Paused' } } as const;
    const results = await Promise.all(Array.from({ length: 6 }, () => appendScreenEvent(dir, input, NOW)));
    expect(results.filter((r) => r.status === 'shown')).toHaveLength(1);
    expect(await lines()).toHaveLength(1);
  });

  it('keeps every line whole when different events are written at once', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendScreenEvent(dir, { event: 'next', payload: { title: `Step ${i}`, reason: 'r'.repeat(250) } }, NOW)));
    expect(await lines()).toHaveLength(20);
  });

  it('rotates a ledger that has grown past its limit and keeps the new event in a fresh file', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    await fs.writeFile(file(), 'x'.repeat(SCREEN_EVENTS_MAX_BYTES + 10));
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Fresh', reason: 'After rotation' } }, NOW);
    expect(await lines()).toHaveLength(1);
    expect((await fs.stat(`${file()}.1`)).size).toBeGreaterThan(SCREEN_EVENTS_MAX_BYTES);
  });
});

describe('listScreenEvents', () => {
  it('is empty without a ledger', async () => {
    expect(await listScreenEvents(dir, { now: NOW })).toEqual([]);
  });

  it('returns events oldest first and skips corrupt, invalid and out-of-window lines', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    await fs.writeFile(file(), [
      JSON.stringify(entry({ id: 'b', timestamp: ago(10 * MIN) })),
      'not json',
      JSON.stringify(entry({ id: 'bad', payload: { view: 'file', path: '/etc/passwd' } })),
      JSON.stringify(entry({ id: 'old', timestamp: ago(SCREEN_EVENT_MAX_AGE_MS + MIN) })),
      JSON.stringify(entry({ id: 'a', timestamp: ago(30 * MIN) })),
    ].join('\n') + '\n');
    expect((await listScreenEvents(dir, { now: NOW })).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('honours since and limit, keeping the newest when it cuts', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    await fs.writeFile(file(), [30, 20, 10, 5].map((m) => JSON.stringify(entry({ id: `m${m}`, timestamp: ago(m * MIN) }))).join('\n') + '\n');
    expect((await listScreenEvents(dir, { now: NOW, sinceMs: NOW - 15 * MIN })).map((e) => e.id)).toEqual(['m10', 'm5']);
    expect((await listScreenEvents(dir, { now: NOW, limit: 2 })).map((e) => e.id)).toEqual(['m10', 'm5']);
  });
});

/** Reads from a live feed with a deadline, keeping an unfinished read between calls so no event is lost to a timeout. */
class Feed {
  private pending: Promise<IteratorResult<LiveEvent>> | undefined;
  constructor(private readonly generator: AsyncGenerator<LiveEvent>) {}

  async take(count: number, ms = 3000): Promise<LiveEvent[]> {
    const got: LiveEvent[] = [];
    const deadline = Date.now() + ms;
    while (got.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      this.pending ??= this.generator.next();
      const next = await Promise.race([this.pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(remaining, 250)))]);
      if (next === null) continue;
      this.pending = undefined;
      if (next.done) break;
      got.push(next.value);
    }
    return got;
  }
}

describe('watchLiveEvents', () => {
  it('replays what is recent, then yields each new event as it is written', async () => {
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Earlier', reason: 'Replayed' } }, Date.now() - MIN);
    const controller = new AbortController();
    const feed = new Feed(watchLiveEvents(dir, { signal: controller.signal, pollMs: 10 }));
    const replay = await feed.take(1);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ type: 'screen', event: { event: 'next', payload: { title: 'Earlier' } } });

    await appendScreenEvent(dir, { event: 'show', payload: { view: 'document', path: 'plan.md' } });
    const live = await feed.take(1);
    expect(live[0]).toMatchObject({ type: 'screen', event: { event: 'show', payload: { path: 'plan.md' } } });
    controller.abort();
  });

  it('yields an event only once, however many times the ledger is read', async () => {
    const controller = new AbortController();
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Once', reason: 'Only once' } });
    const feed = new Feed(watchLiveEvents(dir, { signal: controller.signal, pollMs: 10 }));
    const got = await feed.take(5, 400);
    expect(got).toHaveLength(1);
    controller.abort();
  });

  it('carries questions and their answers from the chat ledger', async () => {
    const chat = (await resolveWorkspaceChatLedger(dir)).chatPath;
    await fs.mkdir(path.dirname(chat), { recursive: true });
    const controller = new AbortController();
    const feed = new Feed(watchLiveEvents(dir, { signal: controller.signal, pollMs: 10 }));
    expect(await feed.take(1, 200)).toHaveLength(0);

    await fs.appendFile(chat, JSON.stringify({ id: 'q1', timestamp: new Date().toISOString(), harness: 'claude', author: 'agent', kind: 'input_request', message: 'Which branch?', options: ['main', 'dev'] }) + '\n');
    const question = (await feed.take(1))[0]!;
    expect(question).toMatchObject({ type: 'question', request: { id: 'q1', message: 'Which branch?', options: ['main', 'dev'] } });

    await acknowledgeInputRequests(dir);
    expect((await feed.take(1))[0]).toMatchObject({ type: 'answered' });
    controller.abort();
  });

  it('replays at most the newest events to a screen that has just opened', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    const total = SCREEN_EVENT_REPLAY_LIMIT + 10;
    await fs.writeFile(file(), Array.from({ length: total }, (_, i) => JSON.stringify(entry({ id: `n${i}`, timestamp: new Date(Date.now() - (total - i) * 1000).toISOString(), payload: { view: 'document', path: `d${i}.md` } }))).join('\n') + '\n');
    const controller = new AbortController();
    const got = await new Feed(watchLiveEvents(dir, { signal: controller.signal, pollMs: 10 })).take(total, 800);
    controller.abort();
    expect(got).toHaveLength(SCREEN_EVENT_REPLAY_LIMIT);
    expect((got[0] as { event: { id: string } }).event.id).toBe('n10');
  });

  it('never sends the events it held back from a first replay, even after the ledger changes', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    const total = SCREEN_EVENT_REPLAY_LIMIT + 10;
    await fs.writeFile(file(), Array.from({ length: total }, (_, i) => JSON.stringify(entry({ id: `n${i}`, timestamp: new Date(Date.now() - (total - i) * 1000).toISOString(), payload: { view: 'document', path: `d${i}.md` } }))).join('\n') + '\n');
    const controller = new AbortController();
    const feed = new Feed(watchLiveEvents(dir, { signal: controller.signal, pollMs: 10 }));
    expect(await feed.take(total, 800)).toHaveLength(SCREEN_EVENT_REPLAY_LIMIT);
    // One more event: only it arrives, not the ten older ones the first replay left out.
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'New', reason: 'Just now' } });
    const after = await feed.take(total, 800);
    controller.abort();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ type: 'screen', event: { event: 'next', payload: { title: 'New' } } });
  });

  it('skips lines that are not usable instead of stopping', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    await fs.writeFile(file(), 'garbage\n' + JSON.stringify(entry({ id: 'bad', payload: { view: 'file', path: '../x' } })) + '\n' + JSON.stringify(entry({ id: 'good', timestamp: new Date().toISOString() })) + '\n');
    const controller = new AbortController();
    const got = await new Feed(watchLiveEvents(dir, { signal: controller.signal, pollMs: 10 })).take(3, 500);
    controller.abort();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ event: { id: 'good' } });
  });

  it('only replays events newer than the point a reconnecting screen last saw', async () => {
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Old', reason: 'Seen already' } }, Date.now() - 5 * MIN);
    const since = Date.now() - MIN;
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'New', reason: 'Missed while away' } });
    const controller = new AbortController();
    const got = await new Feed(watchLiveEvents(dir, { since, signal: controller.signal, pollMs: 10 })).take(3, 500);
    controller.abort();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ event: { payload: { title: 'New' } } });
  });

  it('stops promptly when it is aborted, even while waiting between polls', async () => {
    const controller = new AbortController();
    const feed = watchLiveEvents(dir, { signal: controller.signal, pollMs: 60_000 });
    const pending = feed.next();
    setTimeout(() => controller.abort(), 50);
    const result = await Promise.race([pending, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000))]);
    expect(result).toMatchObject({ done: true });
  });

  it('works for a workspace that has no ledger at all', async () => {
    const controller = new AbortController();
    const feed = new Feed(watchLiveEvents(path.join(dir, 'does-not-exist'), { signal: controller.signal, pollMs: 10 }));
    expect(await feed.take(1, 150)).toEqual([]);
    controller.abort();
  });
});
