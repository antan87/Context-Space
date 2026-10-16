import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  INPUT_REQUEST_DISPLAY_LIMIT,
  INPUT_REQUEST_HARNESS_LIMIT,
  INPUT_REQUEST_LIST_LIMIT,
  INPUT_REQUEST_MAX_AGE_MS,
  acknowledgeInputRequests,
  latestInputRequest,
  listOpenInputRequests,
} from './attention.js';

const cleanup: string[] = [];

afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
});

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

async function workspace(configDir = '.contextspace') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-attention-'));
  cleanup.push(dir);
  await fs.mkdir(path.join(dir, configDir), { recursive: true });
  return { dir, ledger: path.join(dir, configDir, 'chat.jsonl') };
}

const line = (entry: Record<string, unknown>) => JSON.stringify(entry) + '\n';
const request = (over: Record<string, unknown> = {}) => ({
  id: 'r1', timestamp: ago(MIN), harness: 'claude', author: 'agent', kind: 'input_request', message: 'Which branch?', ...over,
});

describe('latestInputRequest', () => {
  it('returns null when the workspace has no ledger', async () => {
    const { dir } = await workspace();
    expect(await latestInputRequest(dir, NOW)).toBeNull();
  });

  it('returns null for a directory that does not exist', async () => {
    expect(await latestInputRequest(path.join(os.tmpdir(), 'cs-attention-missing-dir'), NOW)).toBeNull();
  });

  it('returns the request with its id, time, harness and message', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request()), 'utf8');
    expect(await latestInputRequest(dir, NOW)).toEqual({
      id: 'r1', timestamp: ago(MIN), harness: 'claude', message: 'Which branch?',
    });
  });

  it('returns the newest request and ignores ordinary handoffs after it', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger,
      line(request({ id: 'a', timestamp: ago(30 * MIN), message: 'First?' }))
      + line(request({ id: 'b', timestamp: ago(10 * MIN), message: 'Second?' }))
      + line({ id: 'c', timestamp: ago(MIN), author: 'agent', message: 'Progress note' }),
      'utf8');
    expect((await latestInputRequest(dir, NOW))?.message).toBe('Second?');
  });

  it('picks the newest by time, not by position in the file', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger,
      line(request({ id: 'new', timestamp: ago(MIN), message: 'Newest' }))
      + line(request({ id: 'old', timestamp: ago(20 * MIN), message: 'Older' })),
      'utf8');
    expect((await latestInputRequest(dir, NOW))?.id).toBe('new');
  });

  it('skips malformed and truncated lines', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, 'not json\n' + line(request()) + '{"kind":"input_request","message":"cut off', 'utf8');
    expect((await latestInputRequest(dir, NOW))?.message).toBe('Which branch?');
  });

  describe('ignores entries that should not raise an alert', () => {
    it.each([
      ['older than the maximum age', request({ timestamp: ago(INPUT_REQUEST_MAX_AGE_MS + MIN) })],
      ['dated far in the future', request({ timestamp: new Date(NOW + 60 * MIN).toISOString() })],
      ['without a timestamp', request({ timestamp: undefined })],
      ['with an unparseable timestamp', request({ timestamp: 'yesterday-ish' })],
      ['with an empty message', request({ message: '   ' })],
      ['with a non-string message', request({ message: { nested: true } })],
      ['of another kind', request({ kind: 'note' })],
    ])('an entry %s', async (_label, entry) => {
      const { dir, ledger } = await workspace();
      await fs.writeFile(ledger, line(entry), 'utf8');
      expect(await latestInputRequest(dir, NOW)).toBeNull();
    });

    it('accepts a request a little ahead of this clock', async () => {
      const { dir, ledger } = await workspace();
      await fs.writeFile(ledger, line(request({ timestamp: new Date(NOW + 2 * MIN).toISOString() })), 'utf8');
      expect(await latestInputRequest(dir, NOW)).not.toBeNull();
    });
  });

  it('strips control characters and bounds the message length', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ message: `\u001b[31mred\u0007 alert\u0000${'x'.repeat(INPUT_REQUEST_DISPLAY_LIMIT * 2)}` })), 'utf8');
    const result = await latestInputRequest(dir, NOW);
    expect(result?.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(result?.message.startsWith('[31mred alert')).toBe(true);
    expect(result?.message.length).toBe(INPUT_REQUEST_DISPLAY_LIMIT);
  });

  it('falls back to defaults for a missing id and harness', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ id: undefined, harness: undefined })), 'utf8');
    const result = await latestInputRequest(dir, NOW);
    expect(result?.harness).toBe('agent');
    expect(result?.id).toBe(ago(MIN));
  });

  it('finds a request at the end of a ledger larger than the tail it reads', async () => {
    const { dir, ledger } = await workspace();
    const filler = Array.from({ length: 2500 }, (_, i) => line({ id: `h${i}`, timestamp: ago(40 * MIN), author: 'agent', message: `Handoff ${i} ${'y'.repeat(40)}` })).join('');
    expect(filler.length).toBeGreaterThan(64 * 1024);
    await fs.writeFile(ledger, filler + line(request({ message: 'Buried at the end?' })), 'utf8');
    expect((await latestInputRequest(dir, NOW))?.message).toBe('Buried at the end?');
  });

  it('finds a request that has more than 64 KB of newer entries after it', async () => {
    const { dir, ledger } = await workspace();
    const after = Array.from({ length: 2500 }, (_, i) => line({ id: `n${i}`, timestamp: ago(MIN / 2), author: 'agent', message: `Handoff ${i} ${'z'.repeat(40)}` })).join('');
    expect(after.length).toBeGreaterThan(64 * 1024);
    await fs.writeFile(ledger, line(request({ message: 'Still waiting?' })) + after, 'utf8');
    expect((await latestInputRequest(dir, NOW))?.message).toBe('Still waiting?');
  });

  it('does not look past the last 512 KB, which bounds the cost of a poll', async () => {
    const { dir, ledger } = await workspace();
    const after = Array.from({ length: 12_000 }, (_, i) => line({ id: `n${i}`, timestamp: ago(MIN / 2), author: 'agent', message: `Handoff ${i} ${'z'.repeat(40)}` })).join('');
    expect(after.length).toBeGreaterThan(512 * 1024);
    await fs.writeFile(ledger, line(request({ message: 'Too far back' })) + after, 'utf8');
    expect(await latestInputRequest(dir, NOW)).toBeNull();
  });

  it('keeps the request when a newer entry follows it in the same small file', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ message: 'Question' })) + line({ id: 'h', timestamp: ago(MIN / 2), author: 'agent', message: 'note' }), 'utf8');
    expect((await latestInputRequest(dir, NOW))?.message).toBe('Question');
  });

  it('strips control characters from the harness name and bounds its length', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ harness: `cl\u001bau\u0000de${'x'.repeat(100)}` })), 'utf8');
    const result = await latestInputRequest(dir, NOW);
    expect(result?.harness).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(result?.harness.length).toBe(INPUT_REQUEST_HARNESS_LIMIT);
    expect(result?.harness.startsWith('claude')).toBe(true);
  });

  it('does not misread the line cut by the tail boundary', async () => {
    const { dir, ledger } = await workspace();
    // A fake request sits right where the tail starts; it must not parse as a whole line.
    const filler = line({ id: 'pad', timestamp: ago(40 * MIN), message: 'p'.repeat(70 * 1024) });
    await fs.writeFile(ledger, filler + line(request({ message: 'Real one' })), 'utf8');
    expect((await latestInputRequest(dir, NOW))?.message).toBe('Real one');
  });

  it('reads a legacy .nexusflow ledger', async () => {
    const { dir, ledger } = await workspace('.nexusflow');
    await fs.writeFile(ledger, line(request({ message: 'From a legacy workspace' })), 'utf8');
    expect((await latestInputRequest(dir, NOW))?.message).toBe('From a legacy workspace');
  });

  it('takes the newest across a legacy and a primary ledger', async () => {
    const { dir, ledger: primary } = await workspace('.contextspace');
    await fs.mkdir(path.join(dir, '.nexusflow'), { recursive: true });
    await fs.writeFile(path.join(dir, '.nexusflow', 'chat.jsonl'), line(request({ id: 'legacy', timestamp: ago(MIN), message: 'Legacy is newer' })), 'utf8');
    await fs.writeFile(primary, line(request({ id: 'primary', timestamp: ago(15 * MIN), message: 'Primary is older' })), 'utf8');
    expect((await latestInputRequest(dir, NOW))?.id).toBe('legacy');
  });

  it('skips a ledger whose last write is older than the cutoff without reading it', async () => {
    const { dir, ledger } = await workspace();
    // The entry claims to be recent, but the file was last written long ago.
    await fs.writeFile(ledger, line(request()), 'utf8');
    const old = new Date(NOW - INPUT_REQUEST_MAX_AGE_MS - 60 * MIN);
    await fs.utimes(ledger, old, old);
    expect(await latestInputRequest(dir, NOW)).toBeNull();
  });

  it('treats an unreadable ledger as no alert', async () => {
    const { dir, ledger } = await workspace();
    await fs.mkdir(ledger); // a directory where the file should be
    expect(await latestInputRequest(dir, NOW)).toBeNull();
  });
});

const ack = (over: Record<string, unknown> = {}) => ({
  id: 'k1', timestamp: ago(MIN), harness: 'developer', author: 'human', kind: 'input_ack', message: 'Marked answered', ...over,
});

describe('listOpenInputRequests', () => {
  it('returns an empty list without a ledger, and for a directory that does not exist', async () => {
    const { dir } = await workspace();
    expect(await listOpenInputRequests(dir, NOW)).toEqual([]);
    expect(await listOpenInputRequests(path.join(os.tmpdir(), 'cs-attention-missing-dir-2'), NOW)).toEqual([]);
  });

  it('lists every open request, the one waiting longest first, without the internal time field', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger,
      line(request({ id: 'b', timestamp: ago(10 * MIN), message: 'Second?' }))
      + line(request({ id: 'a', timestamp: ago(30 * MIN), message: 'First?' }))
      + line({ id: 'n', timestamp: ago(MIN), author: 'agent', message: 'Progress note' }),
      'utf8');
    const open = await listOpenInputRequests(dir, NOW);
    expect(open.map((r) => r.id)).toEqual(['a', 'b']);
    expect(open[0]).toEqual({ id: 'a', timestamp: ago(30 * MIN), harness: 'claude', message: 'First?' });
  });

  it('drops requests older than the alert window and requests with no message or a bad timestamp', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger,
      line(request({ id: 'old', timestamp: ago(INPUT_REQUEST_MAX_AGE_MS + MIN) }))
      + line(request({ id: 'empty', message: '   ' }))
      + line(request({ id: 'badtime', timestamp: 'yesterday' }))
      + line(request({ id: 'future', timestamp: new Date(NOW + 60 * MIN).toISOString() }))
      + 'not json at all\n'
      + line(request({ id: 'ok' })),
      'utf8');
    expect((await listOpenInputRequests(dir, NOW)).map((r) => r.id)).toEqual(['ok']);
  });

  it('counts a request written twice with the same id once', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ id: 'dup' })) + line(request({ id: 'dup' })), 'utf8');
    expect(await listOpenInputRequests(dir, NOW)).toHaveLength(1);
  });

  it('keeps only the newest requests when there are more than the limit, still oldest first', async () => {
    const { dir, ledger } = await workspace();
    const total = INPUT_REQUEST_LIST_LIMIT + 5;
    await fs.writeFile(ledger, Array.from({ length: total }, (_, i) =>
      line(request({ id: `r${i}`, timestamp: ago((total - i) * MIN) }))).join(''), 'utf8');
    const open = await listOpenInputRequests(dir, NOW);
    expect(open).toHaveLength(INPUT_REQUEST_LIST_LIMIT);
    expect(open[0]!.id).toBe('r5');
    expect(open.at(-1)!.id).toBe(`r${total - 1}`);
  });

  it('hides requests that were acknowledged, and shows ones asked after the acknowledgement', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger,
      line(request({ id: 'before', timestamp: ago(20 * MIN) }))
      + line(ack({ timestamp: ago(10 * MIN) }))
      + line(request({ id: 'after', timestamp: ago(5 * MIN) })),
      'utf8');
    expect((await listOpenInputRequests(dir, NOW)).map((r) => r.id)).toEqual(['after']);
  });

  it('keeps a request that arrived in the same instant as an acknowledgement, because showing a question twice is safer than hiding one', async () => {
    const { dir, ledger } = await workspace();
    const at = ago(5 * MIN);
    await fs.writeFile(ledger, line(ack({ timestamp: at })) + line(request({ id: 'same', timestamp: at })), 'utf8');
    expect((await listOpenInputRequests(dir, NOW)).map((r) => r.id)).toEqual(['same']);
  });

  it('ignores an acknowledgement stamped in the future so it cannot hide real questions', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ id: 'q' })) + line(ack({ timestamp: new Date(NOW + 60 * MIN).toISOString() })), 'utf8');
    expect((await listOpenInputRequests(dir, NOW)).map((r) => r.id)).toEqual(['q']);
  });

  it('finds an open request that sits far back behind a lot of later ledger entries', async () => {
    const { dir, ledger } = await workspace();
    const filler = line({ id: 'f', timestamp: ago(MIN), author: 'agent', message: 'x'.repeat(2000) });
    await fs.writeFile(ledger, line(request({ id: 'deep', timestamp: ago(60 * MIN) })) + filler.repeat(100), 'utf8');
    expect((await listOpenInputRequests(dir, NOW)).map((r) => r.id)).toEqual(['deep']);
  });
});

describe('latestInputRequest and acknowledgements', () => {
  it('returns null once the newest request has been acknowledged', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ timestamp: ago(10 * MIN) })) + line(ack({ timestamp: ago(5 * MIN) })), 'utf8');
    expect(await latestInputRequest(dir, NOW)).toBeNull();
  });

  it('returns a request asked after an acknowledgement', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger,
      line(request({ id: 'old', timestamp: ago(10 * MIN) })) + line(ack({ timestamp: ago(5 * MIN) })) + line(request({ id: 'new', timestamp: ago(MIN) })),
      'utf8');
    expect((await latestInputRequest(dir, NOW))?.id).toBe('new');
  });

  it('treats a request buried behind an acknowledgement as answered, however far back it sits', async () => {
    const { dir, ledger } = await workspace();
    const filler = line({ id: 'f', timestamp: ago(MIN), author: 'agent', message: 'x'.repeat(2000) });
    // The request is older than the first 64 KB tail but also older than the acknowledgement that sits inside it.
    await fs.writeFile(ledger, line(request({ id: 'buried', timestamp: ago(60 * MIN) })) + filler.repeat(40) + line(ack({ timestamp: ago(2 * MIN) })) + filler.repeat(5), 'utf8');
    expect(await latestInputRequest(dir, NOW)).toBeNull();
  });
});

describe('acknowledgeInputRequests', () => {
  it('records an acknowledgement, reports the questions it answered and clears the alert', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ id: 'a', timestamp: ago(20 * MIN) })) + line(request({ id: 'b', timestamp: ago(10 * MIN) })), 'utf8');
    const result = await acknowledgeInputRequests(dir, NOW);
    expect(result).toMatchObject({ acknowledged: 2, timestamp: new Date(NOW).toISOString() });
    // The questions themselves, so the same ones in the plan can be answered too.
    expect(result.requests.map((answered) => answered.id)).toEqual(['a', 'b']);
    expect(await latestInputRequest(dir, NOW)).toBeNull();
    expect(await listOpenInputRequests(dir, NOW)).toEqual([]);
    const written = (await fs.readFile(ledger, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(written.at(-1)).toMatchObject({ kind: 'input_ack', author: 'human', timestamp: new Date(NOW).toISOString() });
  });

  it('works on a workspace with no ledger yet and answers nothing', async () => {
    const { dir } = await workspace();
    expect(await acknowledgeInputRequests(dir, NOW)).toEqual({ acknowledged: 0, timestamp: new Date(NOW).toISOString(), requests: [] });
  });

  it('does not hide a question asked after the acknowledgement', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ id: 'a', timestamp: ago(20 * MIN) })), 'utf8');
    await acknowledgeInputRequests(dir, NOW - 5 * MIN);
    await fs.appendFile(ledger, line(request({ id: 'later', timestamp: ago(MIN) })), 'utf8');
    expect((await listOpenInputRequests(dir, NOW)).map((r) => r.id)).toEqual(['later']);
  });
});

describe('answer options on a request', () => {
  it('are returned with the request, cleaned, cut to length and without blanks or repeats', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({
      options: ['Remove it', '  Keep it \n', '', 'Remove it', 42, null, '\u0007Both', 'x'.repeat(200)],
    })), 'utf8');
    const found = await latestInputRequest(dir, NOW);
    expect(found?.options).toEqual(['Remove it', 'Keep it', 'Both', 'x'.repeat(80)]);
  });

  it('are limited to six', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ options: Array.from({ length: 12 }, (_, i) => `Option ${i}`) })), 'utf8');
    expect((await latestInputRequest(dir, NOW))?.options).toEqual(['Option 0', 'Option 1', 'Option 2', 'Option 3', 'Option 4', 'Option 5']);
  });

  it('are left out entirely when the ledger holds anything but a usable list', async () => {
    const { dir, ledger } = await workspace();
    for (const options of ['Remove it', {}, [], ['  ', '\n'], null]) {
      await fs.writeFile(ledger, line(request({ options })), 'utf8');
      expect(await latestInputRequest(dir, NOW)).not.toHaveProperty('options');
    }
  });

  it('come back from the open list as well as from the alert', async () => {
    const { dir, ledger } = await workspace();
    await fs.writeFile(ledger, line(request({ id: 'a', options: ['Yes', 'No'] })), 'utf8');
    expect((await listOpenInputRequests(dir, NOW))[0]).toMatchObject({ id: 'a', options: ['Yes', 'No'] });
  });
});
