import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from './server.js';
import * as configModule from './core/config.js';
import { BOARD_EVENTS_FILE, appendScreenEvent } from './core/screen-events.js';

let root: string;
let dir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-screen-routes-'));
  dir = path.join(root, 'ws');
  await fs.mkdir(path.join(dir, '.contextspace'), { recursive: true });
  vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
    version: '1.0', devDir: '/dev', workspacesDir: root, defaultAssistant: null, scanDepth: 2,
  } as any);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

async function call(method: 'GET' | 'PUT', url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Reads frames off a server-sent event stream until `until` says enough, with a deadline, then closes it. */
async function readFrames(res: Response, until: (frames: Array<{ event: string; id?: string; data: any }>) => boolean, ms = 4000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ event: string; id?: string; data: any }> = [];
  let buffer = '';
  const deadline = Date.now() + ms;
  // An unfinished read is kept between turns of the loop: abandoning it would let it swallow the next chunk.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  try {
    while (!until(frames) && Date.now() < deadline) {
      pending ??= reader.read();
      const chunk = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 300))]);
      if (chunk === null) continue;
      pending = undefined;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame: { event: string; id?: string; data: any } = { event: 'message', data: undefined };
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) frame.event = line.slice(6).trim();
          else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
          else if (line.startsWith('data:')) frame.data = JSON.parse(line.slice(5).trim());
        }
        frames.push(frame);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

describe('sharing what the user is looking at', () => {
  it('is off by default', async () => {
    expect(await call('GET', '/api/workspace/ws/screen-sharing')).toMatchObject({ status: 200, body: { enabled: false } });
  });

  it('is switched on and off by the user, and says when', async () => {
    const on = await call('PUT', '/api/workspace/ws/screen-sharing', { enabled: true });
    expect(on).toMatchObject({ status: 200, body: { enabled: true } });
    expect(typeof on.body.updatedAt).toBe('string');
    expect((await call('GET', '/api/workspace/ws/screen-sharing')).body.enabled).toBe(true);
    expect((await call('PUT', '/api/workspace/ws/screen-sharing', { enabled: false })).body.enabled).toBe(false);
  });

  it.each([[{}], [{ enabled: 'true' }], [{ enabled: 1 }], [{ enabled: null }]])('refuses %j as the setting', async (payload) => {
    const { status, body } = await call('PUT', '/api/workspace/ws/screen-sharing', payload);
    expect(status).toBe(400);
    expect(body.error).toMatch(/enabled/);
  });

  it('refuses a view while sharing is off, and stores nothing', async () => {
    const { status, body } = await call('PUT', '/api/workspace/ws/screen-context', { viewing: { path: 'plan.md' } });
    expect(status).toBe(409);
    expect(body.code).toBe('sharing_off');
    expect(await fs.readdir(path.join(dir, '.contextspace'))).not.toContain('screen-context.json');
  });

  it('stores a cleaned view once sharing is on, and shows the user exactly what the AI would see', async () => {
    await call('PUT', '/api/workspace/ws/screen-sharing', { enabled: true });
    const put = await call('PUT', '/api/workspace/ws/screen-context', { viewing: { path: 'plan.md', line: 3 }, selection: 'Step\u0007 two', reviewed: ['plan.md', '/etc/hosts'] });
    expect(put.status).toBe(200);
    expect(put.body.context).toMatchObject({ viewing: { path: 'plan.md', line: 3 }, selection: 'Step two', reviewed: ['plan.md'] });
    const seen = await call('GET', '/api/workspace/ws/screen-context');
    expect(seen.body).toMatchObject({ shared: true, context: { viewing: { path: 'plan.md' } } });
  });

  it('tells a caller who asks while sharing is off only that it is off', async () => {
    const { body } = await call('GET', '/api/workspace/ws/screen-context');
    expect(body).toMatchObject({ shared: false });
    expect(body).not.toHaveProperty('context');
  });

  it('deletes the stored view when sharing is switched off', async () => {
    await call('PUT', '/api/workspace/ws/screen-sharing', { enabled: true });
    await call('PUT', '/api/workspace/ws/screen-context', { selection: 'private' });
    await call('PUT', '/api/workspace/ws/screen-sharing', { enabled: false });
    expect(JSON.stringify((await call('GET', '/api/workspace/ws/screen-context')).body)).not.toContain('private');
  });

  it('copes with a body that is not JSON by storing an empty view', async () => {
    await call('PUT', '/api/workspace/ws/screen-sharing', { enabled: true });
    const res = await app.request('/api/workspace/ws/screen-context', { method: 'PUT', body: 'not json' });
    expect(res.status).toBe(200);
  });

  it.each(['GET', 'PUT'] as const)('refuses a workspace id outside the workspaces folder (%s)', async (method) => {
    const bad = encodeURIComponent('../outside');
    for (const suffix of ['screen-sharing', 'screen-context']) {
      const { status } = await call(method, `/api/workspace/${bad}/${suffix}`, method === 'PUT' ? { enabled: true } : undefined);
      expect(status, suffix).toBeGreaterThanOrEqual(400);
      expect(status, suffix).toBeLessThan(500);
    }
  });
});

describe('GET /api/workspace/:id/screen-events', () => {
  it('streams what the AI told the screen, with the right headers, and each frame carries its time as its id', async () => {
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Answer two questions', reason: 'The build is paused' } }, Date.now() - 60_000);
    const res = await app.request('/api/workspace/ws/screen-events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const frames = await readFrames(res, (f) => f.some((x) => x.event === 'screen'));
    const frame = frames.find((f) => f.event === 'screen')!;
    expect(frame.data).toMatchObject({ type: 'screen', event: { event: 'next', payload: { title: 'Answer two questions' } } });
    expect(frame.id).toBe(frame.data.event.timestamp);
  });

  it('delivers an event written after the screen connected', async () => {
    const res = await app.request('/api/workspace/ws/screen-events');
    setTimeout(() => { void appendScreenEvent(dir, { event: 'show', payload: { view: 'document', path: 'plan.md' } }); }, 100);
    const frames = await readFrames(res, (f) => f.some((x) => x.event === 'screen'));
    expect(frames.find((f) => f.event === 'screen')!.data.event.payload).toMatchObject({ path: 'plan.md' });
  });

  it('delivers a board event written after the screen connected, from the board ledger, as a screen event', async () => {
    const res = await app.request('/api/workspace/ws/screen-events');
    setTimeout(() => { void appendScreenEvent(dir, { harness: 'user', author: 'human', event: 'board', payload: { revision: 4, changes: 2 } }); }, 100);
    const frames = await readFrames(res, (f) => f.some((x) => x.event === 'screen'));
    const frame = frames.find((f) => f.event === 'screen')!;
    expect(frame.data).toMatchObject({ type: 'screen', event: { event: 'board', harness: 'user', payload: { revision: 4, changes: 2 } } });
    expect(frame.id).toBe(frame.data.event.timestamp);
    await expect(fs.access(path.join(dir, '.contextspace', BOARD_EVENTS_FILE))).resolves.toBeUndefined();
  });

  it('still replays the AI\'s earlier suggestion after a long run of board events, and replays none of the board events', async () => {
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Answer two questions', reason: 'The build is paused' } }, Date.now() - 600_000);
    const at = Date.now() - 300_000;
    const rows = Array.from({ length: 2500 }, (_, n) => JSON.stringify({
      id: `b${n}`, timestamp: new Date(at + n).toISOString(), harness: 'claude', author: 'agent', kind: 'screen_event', event: 'board', payload: { revision: n + 1, changes: 1 },
    }));
    await fs.writeFile(path.join(dir, '.contextspace', BOARD_EVENTS_FILE), `${rows.join('\n')}\n`);
    expect((await fs.stat(path.join(dir, '.contextspace', BOARD_EVENTS_FILE))).size).toBeGreaterThan(256 * 1024);

    const frames = await readFrames(await app.request('/api/workspace/ws/screen-events'), (f) => f.length >= 2, 1200);
    expect(frames.map((f) => f.data.event.event)).toEqual(['next']);
  });

  it('carries the questions the AI asks, with their options', async () => {
    const chat = path.join(dir, '.contextspace', 'chat.jsonl');
    await fs.writeFile(chat, JSON.stringify({ id: 'q1', timestamp: new Date().toISOString(), harness: 'claude', author: 'agent', kind: 'input_request', message: 'Which branch?', options: ['main', 'dev'] }) + '\n');
    const frames = await readFrames(await app.request('/api/workspace/ws/screen-events'), (f) => f.some((x) => x.event === 'question'));
    expect(frames.find((f) => f.event === 'question')!.data.request).toMatchObject({ id: 'q1', options: ['main', 'dev'] });
  });

  it('resumes after the last event a reconnecting screen saw, from either the query or Last-Event-ID', async () => {
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Old', reason: 'Seen' } }, Date.now() - 300_000);
    const seen = new Date(Date.now() - 60_000).toISOString();
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'New', reason: 'Missed' } });
    for (const res of [
      await app.request(`/api/workspace/ws/screen-events?since=${encodeURIComponent(seen)}`),
      await app.request('/api/workspace/ws/screen-events', { headers: { 'last-event-id': seen } }),
    ]) {
      const frames = await readFrames(res, (f) => f.length >= 2, 700);
      expect(frames.map((f) => f.data.event.payload.title)).toEqual(['New']);
    }
  });

  it('ignores a since that is not a date and streams from the start', async () => {
    await appendScreenEvent(dir, { event: 'next', payload: { title: 'Recent', reason: 'Shown' } });
    const frames = await readFrames(await app.request('/api/workspace/ws/screen-events?since=garbage'), (f) => f.length >= 1);
    expect(frames).toHaveLength(1);
  });

  it('refuses a workspace id outside the workspaces folder before streaming anything', async () => {
    const res = await app.request(`/api/workspace/${encodeURIComponent('../outside')}/screen-events`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
  });

  it('streams nothing, and does not fail, for a workspace with no ledger', async () => {
    const res = await app.request('/api/workspace/ws/screen-events');
    expect(res.status).toBe(200);
    expect(await readFrames(res, (f) => f.length > 0, 600)).toEqual([]);
  });
});
