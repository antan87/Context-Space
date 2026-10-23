import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PLAN_FILE } from './plan-file.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acknowledgeInputRequests } from './attention.js';
import { resolveWorkspaceChatLedger } from './constants.js';
import {
  BOARD_EVENTS_FILE,
  BOARD_EVENTS_MAX_BYTES,
  SCREEN_EVENTS_FILE,
  SCREEN_EVENTS_MAX_BYTES,
  SCREEN_EVENT_MAX_AGE_MS,
  SCREEN_EVENT_REPEAT_WINDOW_MS,
  SCREEN_EVENT_REPLAY_LIMIT,
  appendScreenEvent,
  listBoardEvents,
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
const boardFile = () => path.join(ledgerDir, BOARD_EVENTS_FILE);
const boardLines = async () => (await fs.readFile(boardFile(), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
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

  it('says the plan changed whenever its file does, but not for the plan as it was when the feed opened', async () => {
    await fs.writeFile(path.join(dir, PLAN_FILE), '# Plan\n');
    const controller = new AbortController();
    const feed = new Feed(watchLiveEvents(dir, { signal: controller.signal, pollMs: 10 }));
    expect(await feed.take(1, 200)).toHaveLength(0);

    await fs.writeFile(path.join(dir, PLAN_FILE), '# Plan\n\n- [x] A step an AI ticked itself\n');
    expect((await feed.take(1))[0]).toMatchObject({ type: 'plan' });
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

describe('board events', () => {
  const board = (payload: unknown) => entry({ event: 'board', payload });

  it('rebuilds the board event field by field', () => {
    expect(parseScreenEntry(board({ revision: 7, changes: 2, extra: 'dropped', title: 'dropped' }), NOW))
      .toEqual({ id: 'e1', timestamp: ago(MIN), harness: 'claude', event: 'board', payload: { revision: 7, changes: 2 } });
  });

  it.each([
    ['no revision', { changes: 1 }],
    ['a revision that is text', { revision: '7', changes: 1 }],
    ['a revision that is not whole', { revision: 1.5, changes: 1 }],
    ['a negative revision', { revision: -1, changes: 1 }],
    ['an absurd revision', { revision: 1e12, changes: 1 }],
    ['no change count', { revision: 7 }],
    ['a change count that is not a number', { revision: 7, changes: [] }],
    ['no payload', undefined],
  ])('drops a board event with %s', (_name, payload) => {
    expect(parseScreenEntry(board(payload), NOW)).toBeNull();
  });

  it('keeps two quick changes apart, because the revision makes each a different event, and still ignores a repeat', async () => {
    const first = await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 1, changes: 1 } }, NOW);
    const second = await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 2, changes: 1 } }, NOW + 1000);
    const repeat = await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 2, changes: 1 } }, NOW + 2000);
    expect([first.status, second.status, repeat.status]).toEqual(['shown', 'shown', 'already_shown']);
    expect((await listBoardEvents(dir, { now: NOW + 3000 })).map((event) => event.payload)).toEqual([{ revision: 1, changes: 1 }, { revision: 2, changes: 1 }]);
  });

  it('refuses to record a board event that is not usable', async () => {
    await expect(appendScreenEvent(dir, { event: 'board', payload: { revision: 'x', changes: 1 } as never }, NOW)).rejects.toThrow(/not a usable board event/);
    expect(await lines()).toEqual([]);
    expect(await boardLines()).toEqual([]);
  });

  it('leaves board events out of the replay, so a worked-on board cannot push the AI\'s earlier events out of the newest few', async () => {
    await appendScreenEvent(dir, { harness: 'claude', event: 'next', payload: { title: 'Answer two questions', reason: 'The build is paused on them' } }, NOW - 5 * MIN);
    await appendScreenEvent(dir, { harness: 'claude', event: 'show', payload: { view: 'document', path: 'plan.md' } }, NOW - 4 * MIN);
    for (let revision = 1; revision <= SCREEN_EVENT_REPLAY_LIMIT + 10; revision++) {
      await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision, changes: 1 } }, NOW - 3 * MIN + revision * 1000);
    }

    const controller = new AbortController();
    const seen: LiveEvent[] = [];
    const liveRevision = SCREEN_EVENT_REPLAY_LIMIT + 11;
    // A board event written after the screen connected is still delivered.
    setTimeout(() => {
      void appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: liveRevision, changes: 1 } }, NOW + 500)
        .then(() => setTimeout(() => controller.abort(), 150));
    }, 50);
    for await (const event of watchLiveEvents(dir, { signal: controller.signal, pollMs: 5, now: () => NOW + 1000 })) seen.push(event);

    const names = seen.map((live) => (live.type === 'screen' ? `${live.event.event}${live.event.event === 'board' ? `:${(live.event.payload as { revision: number }).revision}` : ''}` : live.type));
    expect(names).toEqual(['next', 'show', `board:${liveRevision}`]);
  });

  it('replays the newest few of the other events as before, with board events in between', async () => {
    for (let n = 1; n <= SCREEN_EVENT_REPLAY_LIMIT + 5; n++) {
      await appendScreenEvent(dir, { harness: 'claude', event: 'show', payload: { view: 'document', path: `doc-${n}.md` } }, NOW - 20 * MIN + n * 1000);
      await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: n, changes: 1 } }, NOW - 20 * MIN + n * 1000 + 500);
    }
    const controller = new AbortController();
    const seen: LiveEvent[] = [];
    setTimeout(() => controller.abort(), 100);
    for await (const event of watchLiveEvents(dir, { signal: controller.signal, pollMs: 5, now: () => NOW })) seen.push(event);
    const shows = seen.flatMap((live) => (live.type === 'screen' && live.event.event === 'show' ? [live.event.payload.path] : []));
    expect(shows).toHaveLength(SCREEN_EVENT_REPLAY_LIMIT);
    expect(shows[0]).toBe('doc-6.md');
    expect(seen.some((live) => live.type === 'screen' && live.event.event === 'board')).toBe(false);
  });

  it('writes who made the line: the AI by default, and the person for what they did at the app', async () => {
    await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 1, changes: 1 } }, NOW);
    await appendScreenEvent(dir, { harness: 'user', author: 'human', event: 'board', payload: { revision: 2, changes: 1 } }, NOW + 1000);
    expect((await boardLines()).map((line) => [line.harness, line.author])).toEqual([['claude', 'agent'], ['user', 'human']]);
  });
});

describe('the board ledger', () => {
  const boardEntry = (n: number, over: Record<string, unknown> = {}) => entry({
    id: `b${n}`, event: 'board', payload: { revision: n, changes: 1 }, timestamp: new Date(NOW - 2 * MIN + n).toISOString(), ...over,
  });
  const writeBoardLedger = async (...rows: Array<string | Record<string, unknown>>) => {
    await fs.mkdir(ledgerDir, { recursive: true });
    await fs.writeFile(boardFile(), `${rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')}\n`);
  };
  /** What a screen that connects now is sent at once, and then whatever is written within `ms`. */
  const connect = async (ms: number, options: { now?: number } = {}) => {
    const controller = new AbortController();
    const seen: LiveEvent[] = [];
    setTimeout(() => controller.abort(), ms);
    for await (const event of watchLiveEvents(dir, { signal: controller.signal, pollMs: 5, now: () => options.now ?? NOW })) seen.push(event);
    return seen;
  };
  const kinds = (seen: LiveEvent[]) => seen.map((live) => (live.type === 'screen' ? live.event.event : live.type));

  it('keeps board events in a file of their own beside the screen events, and only there', async () => {
    await appendScreenEvent(dir, { harness: 'claude', event: 'next', payload: { title: 'Answer', reason: 'Paused' } }, NOW - 5 * MIN);
    await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 1, changes: 1 } }, NOW - 4 * MIN);
    expect((await lines()).map((line) => line.event)).toEqual(['next']);
    expect((await boardLines()).map((line) => line.event)).toEqual(['board']);
    expect(path.dirname(boardFile())).toBe(path.dirname(file()));
    expect((await listScreenEvents(dir, { now: NOW })).map((event) => event.event)).toEqual(['next']);
    expect((await listBoardEvents(dir, { now: NOW })).map((event) => event.event)).toEqual(['board']);
  });

  it('cannot push an earlier suggestion out of the feed or the replay, however long a run of board events there is', async () => {
    await appendScreenEvent(dir, { harness: 'claude', event: 'next', payload: { title: 'Answer two questions', reason: 'The build is paused on them' } }, NOW - 5 * MIN);
    // Far more than the 256 KB the feed reads from the end of a ledger.
    await writeBoardLedger(...Array.from({ length: 2500 }, (_, n) => boardEntry(n + 1)));
    expect((await fs.stat(boardFile())).size).toBeGreaterThan(300 * 1024);
    const screenSize = (await fs.stat(file())).size;

    expect((await listScreenEvents(dir, { now: NOW })).map((event) => event.event)).toEqual(['next']);
    expect(kinds(await connect(100))).toEqual(['next']);

    // More of them, written the usual way, change neither the screen ledger nor what the screen is sent.
    for (let n = 2501; n <= 2510; n++) await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: n, changes: 1 } }, NOW - MIN + n);
    expect((await fs.stat(file())).size).toBe(screenSize);
    expect(kinds(await connect(100))).toEqual(['next']);
  });

  it('delivers a board event written after a screen connected, and none that were there before', async () => {
    await writeBoardLedger(boardEntry(1), boardEntry(2));
    const controller = new AbortController();
    const seen: LiveEvent[] = [];
    setTimeout(() => {
      void appendScreenEvent(dir, { harness: 'user', author: 'human', event: 'board', payload: { revision: 3, changes: 2 } }, NOW + 500)
        .then(() => setTimeout(() => controller.abort(), 150));
    }, 50);
    for await (const event of watchLiveEvents(dir, { signal: controller.signal, pollMs: 5, now: () => NOW + 1000 })) seen.push(event);
    expect(seen).toEqual([{ type: 'screen', event: expect.objectContaining({ event: 'board', harness: 'user', payload: { revision: 3, changes: 2 } }) }]);
  });

  it('skips a corrupt line in the ledger, and a line that is not a usable board event, and goes on to the next', async () => {
    await writeBoardLedger(
      'not json at all',
      '{"id":"cut","timestamp":"2026-10-02T11:58:00.000Z","harness":"cl',
      boardEntry(1, { payload: { revision: 'one', changes: 1 } }),
      boardEntry(2, { kind: 'input_request' }),
      boardEntry(3, { event: 'next', payload: { title: 'Not a board event', reason: 'In the wrong ledger' } }),
      boardEntry(4),
      '',
      boardEntry(5),
    );
    expect((await listBoardEvents(dir, { now: NOW })).map((event) => event.payload)).toEqual([{ revision: 4, changes: 1 }, { revision: 5, changes: 1 }]);

    // Written while a screen is connected, the good lines are delivered and the bad ones are not.
    await fs.rm(boardFile());
    const controller = new AbortController();
    const seen: LiveEvent[] = [];
    setTimeout(() => {
      void fs.writeFile(boardFile(), `garbage\n${JSON.stringify(boardEntry(6))}\n{"half":\n${JSON.stringify(boardEntry(7))}\n`)
        .then(() => setTimeout(() => controller.abort(), 150));
    }, 50);
    for await (const event of watchLiveEvents(dir, { signal: controller.signal, pollMs: 5, now: () => NOW })) seen.push(event);
    expect(seen.map((live) => (live.type === 'screen' ? live.event.payload : live.type))).toEqual([{ revision: 6, changes: 1 }, { revision: 7, changes: 1 }]);
  });

  it('keeps each kind in its own ledger: a board line in the screen ledger is not a screen event, and the other way round', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    await fs.writeFile(file(), `${JSON.stringify(boardEntry(1))}\n${JSON.stringify(entry({ id: 's1' }))}\n`);
    await writeBoardLedger(entry({ id: 's2' }), boardEntry(2));
    expect((await listScreenEvents(dir, { now: NOW })).map((event) => event.id)).toEqual(['s1']);
    expect((await listBoardEvents(dir, { now: NOW })).map((event) => event.id)).toEqual(['b2']);
    expect(kinds(await connect(100))).toEqual(['show']);
  });

  it('rotates, keeping one earlier file, when it grows past its limit, and leaves the screen ledger alone', async () => {
    await appendScreenEvent(dir, { harness: 'claude', event: 'next', payload: { title: 'Answer', reason: 'Paused' } }, NOW - 5 * MIN);
    const filler = Array.from({ length: Math.ceil(BOARD_EVENTS_MAX_BYTES / 120) + 100 }, (_, n) => JSON.stringify(boardEntry(n + 1)));
    await writeBoardLedger(...filler);
    expect((await fs.stat(boardFile())).size).toBeGreaterThan(BOARD_EVENTS_MAX_BYTES);
    await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 99999, changes: 1 } }, NOW - MIN);
    expect((await boardLines()).map((line) => line.payload.revision)).toEqual([99999]);
    expect((await fs.stat(`${boardFile()}.1`)).size).toBeGreaterThan(BOARD_EVENTS_MAX_BYTES);
    expect((await lines()).map((line) => line.event)).toEqual(['next']);
    await expect(fs.access(`${file()}.1`)).rejects.toThrow();
  });

  it('does not let a failed write to the ledger be mistaken for success', async () => {
    await fs.mkdir(boardFile(), { recursive: true });
    await expect(appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 1, changes: 1 } }, NOW)).rejects.toThrow();
    expect(await lines()).toEqual([]);
  });
});

describe('a connected feed', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const at = (n: number) => new Date(NOW - 10 * MIN + n).toISOString();
  const boardRow = (n: number) => JSON.stringify(entry({ id: `b${n}`, event: 'board', payload: { revision: n, changes: 1 }, timestamp: at(n) }));
  const showRow = (n: number) => JSON.stringify(entry({ id: `s${n}`, event: 'show', payload: { view: 'document', path: `doc-${n}.md` }, timestamp: at(n) }));
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => from + n);
  const append = async (target: string, rows: string[]) => { await fs.mkdir(ledgerDir, { recursive: true }); await fs.appendFile(target, `${rows.join('\n')}\n`); };
  const idOf = (live: LiveEvent) => (live.type === 'screen' ? live.event.id : live.type);

  /** A screen connected from now on: what it was sent, in order, and what the feed said it held after each read. */
  function connectFeed() {
    const controller = new AbortController();
    const delivered: string[] = [];
    const reads: Array<{ window: number; remembered: number }> = [];
    let firstRead!: () => void;
    const ready = new Promise<void>((resolve) => { firstRead = resolve; });
    const running = (async () => {
      for await (const live of watchLiveEvents(dir, { signal: controller.signal, pollMs: 5, now: () => NOW, onRead: (state) => { reads.push(state); firstRead(); } })) delivered.push(idOf(live));
    })();
    return {
      delivered, reads,
      /** Resolves once the feed has made its first read, which is what separates what was there from what is new. */
      ready,
      /** Waits until `count` events have been sent, or fails. */
      async until(count: number, ms = 15_000) {
        const deadline = Date.now() + ms;
        while (delivered.length < count && Date.now() < deadline) await sleep(10);
        expect(delivered.length).toBeGreaterThanOrEqual(count);
      },
      /** Gives the feed time to send anything it should not, then stops it. */
      async stop(settleMs = 150) { await sleep(settleMs); controller.abort(); await running; },
    };
  }
  const expectEachOnce = (delivered: string[], expected: string[]) => {
    expect(delivered).toHaveLength(expected.length);
    expect([...delivered].sort()).toEqual([...expected].sort());
    expect(new Set(delivered).size).toBe(delivered.length);
  };

  it('sends no event twice, however many sit inside the read windows, and remembers no more than the windows hold', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    const feed = connectFeed();
    await feed.ready;
    // About 215 KB of board lines and 170 KB of screen lines, each inside its 256 KB window: more than 2000 events together.
    for (let batch = 0; batch < 13; batch++) {
      await append(boardFile(), range(batch * 100 + 1, batch * 100 + 100).map(boardRow));
      if (batch < 9) await append(file(), range(batch * 100 + 1, batch * 100 + 100).map(showRow));
      await sleep(30);
    }
    await feed.until(2200);
    // A few more changes, written the usual way, while the windows hold more than 2000 events.
    for (let n = 1; n <= 3; n++) await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 5000 + n, changes: 1 } }, NOW - MIN + n);
    for (let n = 1; n <= 2; n++) await appendScreenEvent(dir, { harness: 'claude', event: 'show', payload: { view: 'document', path: `late-${n}.md` } }, NOW - MIN + n);
    await feed.until(2205);
    await feed.stop();

    expect(feed.delivered).toHaveLength(2205);
    expect(new Set(feed.delivered).size).toBe(2205);
    expect(Math.max(...feed.reads.map((read) => read.window))).toBeGreaterThan(2000);
    for (const read of feed.reads) expect(read.remembered).toBeLessThanOrEqual(read.window);
  });

  it('forgets events that have left the windows, so what it remembers follows the windows and not the number of events', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    const feed = connectFeed();
    await feed.ready;
    let written = 0;
    // 2800 board lines are about 465 KB: the window holds the newest 1500 or so.
    for (let batch = 0; batch < 28; batch++) {
      await append(boardFile(), range(batch * 100 + 1, batch * 100 + 100).map(boardRow));
      written += 100;
      await sleep(20);
    }
    await append(file(), range(1, 300).map(showRow));
    written += 300;
    await feed.until(3100);
    await feed.stop();

    expectEachOnce(feed.delivered, [...range(1, 2800).map((n) => `b${n}`), ...range(1, 300).map((n) => `s${n}`)]);
    const last = feed.reads.at(-1)!;
    expect(last.window).toBeLessThan(written - 500);
    expect(last.remembered).toBeLessThanOrEqual(last.window);
    expect(Math.max(...feed.reads.map((read) => read.remembered))).toBeLessThan(written - 500);
  });

  it('never sends an event that the first replay held back, however the windows move afterwards', async () => {
    // 600 screen events (the newest 50 are replayed) and 1500 board events (none is) are there before the screen connects.
    await append(file(), range(1, 600).map(showRow));
    await append(boardFile(), range(1, 1500).map(boardRow));
    const feed = connectFeed();
    await feed.ready;
    await feed.until(50);
    for (let batch = 0; batch < 7; batch++) {
      await append(boardFile(), range(1501 + batch * 100, 1600 + batch * 100).map(boardRow));
      await sleep(30);
    }
    await append(file(), range(601, 605).map(showRow));
    await feed.until(50 + 700 + 5);
    await feed.stop();

    expectEachOnce(feed.delivered, [...range(551, 605).map((n) => `s${n}`), ...range(1501, 2200).map((n) => `b${n}`)]);
    expect(Math.max(...feed.reads.map((read) => read.window))).toBeGreaterThan(2000);
    for (const read of feed.reads) expect(read.remembered).toBeLessThanOrEqual(read.window);
  });

  it('does not send events again when a ledger is missing for a moment and then comes back as it was', async () => {
    await fs.mkdir(ledgerDir, { recursive: true });
    const feed = connectFeed();
    await feed.ready;
    await append(boardFile(), range(1, 20).map(boardRow));
    await append(file(), range(1, 5).map(showRow));
    await feed.until(25);
    await fs.rename(boardFile(), `${boardFile()}.away`);
    await sleep(80);
    await fs.rename(`${boardFile()}.away`, boardFile());
    await sleep(80);
    // Something new still gets through after it.
    await append(boardFile(), [boardRow(21)]);
    await feed.until(26);
    await feed.stop();
    expectEachOnce(feed.delivered, [...range(1, 21).map((n) => `b${n}`), ...range(1, 5).map((n) => `s${n}`)]);
  });

  it('sends only the new event across a rotation of the board ledger', async () => {
    await append(boardFile(), range(1, Math.ceil(BOARD_EVENTS_MAX_BYTES / 120) + 100).map(boardRow));
    expect((await fs.stat(boardFile())).size).toBeGreaterThan(BOARD_EVENTS_MAX_BYTES);
    const feed = connectFeed();
    await feed.ready;
    await sleep(200);
    expect(feed.delivered).toEqual([]);
    await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 9001, changes: 1 } }, NOW - MIN);
    await feed.until(1);
    await appendScreenEvent(dir, { harness: 'claude', event: 'board', payload: { revision: 9002, changes: 1 } }, NOW - MIN + 1000);
    await feed.until(2);
    await feed.stop();
    expect((await fs.stat(`${boardFile()}.1`)).size).toBeGreaterThan(BOARD_EVENTS_MAX_BYTES);
    expect(feed.delivered).toHaveLength(2);
    expect(new Set(feed.delivered).size).toBe(2);
    // None of the events that were in the file before it was rotated (their ids are b1, b2, …) is sent again.
    expect(feed.delivered.filter((id) => /^b\d+$/.test(id))).toEqual([]);
  });
});
