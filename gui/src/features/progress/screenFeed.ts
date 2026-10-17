/**
 * The live feed from the backend's screen-events stream: what the AI told the
 * screen to show, the questions it asked, and when they were answered. Frames
 * are rebuilt field by field, because the strip acts on them (it can type a
 * suggestion into the chat prompt), so nothing is trusted just for arriving.
 * Plain functions, so the connection can be tested with a fake event source.
 */

import type { AnnotationTag, LiveEvent, OpenQuestion, ScreenEvent } from '../../types';

/** The most events kept on screen. Older ones are dropped first. */
export const FEED_MAX_EVENTS = 100;
const OPTIONS_MAX = 6;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalText = <K extends string>(key: K, value: unknown) => (isText(value) ? { [key]: value } : {}) as { [P in K]?: string };
const optionalLine = (key: 'line' | 'endLine', value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? { [key]: value } : {}) as { [P in typeof key]?: number };

/** A screen event rebuilt from untrusted JSON, or null when it is not a usable one. */
export function cleanScreenEvent(raw: unknown): ScreenEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (!isText(e.id) || !isText(e.timestamp) || !isText(e.harness) || !e.payload || typeof e.payload !== 'object') return null;
  const base = { id: e.id, timestamp: e.timestamp, harness: e.harness };
  const p = e.payload as Record<string, unknown>;
  switch (e.event) {
    case 'show': {
      const view = p.view === 'document' || p.view === 'file' || p.view === 'diff' ? p.view : null;
      if (!view) return null;
      return { ...base, event: 'show', payload: { view, ...optionalText('path', p.path), ...optionalText('repo', p.repo), ...optionalLine('line', p.line), ...optionalLine('endLine', p.endLine), ...optionalText('note', p.note) } };
    }
    case 'annotate': {
      if (!isText(p.path) || !isText(p.text) || typeof p.line !== 'number' || !Number.isInteger(p.line) || p.line < 1) return null;
      const tag: AnnotationTag = p.tag === 'risk' || p.tag === 'todo' ? p.tag : 'question';
      return { ...base, event: 'annotate', payload: { path: p.path, line: p.line, text: p.text, tag, ...optionalText('repo', p.repo) } };
    }
    case 'next': {
      if (!isText(p.title) || !isText(p.reason)) return null;
      return { ...base, event: 'next', payload: { title: p.title, reason: p.reason, ...optionalText('path', p.path), ...optionalText('repo', p.repo), ...optionalLine('line', p.line) } };
    }
    case 'milestone': {
      if (!isText(p.stepId) || (p.state !== 'in_progress' && p.state !== 'blocked' && p.state !== 'done' && p.state !== 'reopened')) return null;
      return { ...base, event: 'milestone', payload: { stepId: p.stepId, state: p.state, ...optionalText('note', p.note) } };
    }
    case 'milestone_proposal': {
      if (!isText(p.stepId) || !isText(p.reason) || (p.proposal !== 'reopen' && p.proposal !== 'complete')) return null;
      return { ...base, event: 'milestone_proposal', payload: { stepId: p.stepId, proposal: p.proposal, reason: p.reason } };
    }
    default:
      return null;
  }
}

function cleanQuestion(raw: unknown): OpenQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  if (!isText(q.id) || !isText(q.timestamp) || !isText(q.harness) || !isText(q.message)) return null;
  const options = Array.isArray(q.options) ? q.options.filter(isText).slice(0, OPTIONS_MAX) : [];
  return { id: q.id, timestamp: q.timestamp, harness: q.harness, message: q.message, ...(options.length ? { options } : {}) };
}

/** One frame's data as a live event, or null when it is malformed. */
export function parseLiveFrame(data: unknown): LiveEvent | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const frame = parsed as Record<string, unknown>;
  if (frame.type === 'screen') {
    const event = cleanScreenEvent(frame.event);
    return event ? { type: 'screen', event } : null;
  }
  if (frame.type === 'question') {
    const request = cleanQuestion(frame.request);
    return request ? { type: 'question', request } : null;
  }
  if (frame.type === 'answered' && isText(frame.timestamp)) return { type: 'answered', timestamp: frame.timestamp };
  if (frame.type === 'plan' && isText(frame.timestamp)) return { type: 'plan', timestamp: frame.timestamp };
  return null;
}

/** The events with this one added, once. The same list comes back when the event is already there. */
export function addScreenEvent(events: readonly ScreenEvent[], event: ScreenEvent): readonly ScreenEvent[] {
  if (events.some((held) => held.id === event.id)) return events;
  const next = [...events, event];
  return next.length > FEED_MAX_EVENTS ? next.slice(-FEED_MAX_EVENTS) : next;
}

// ─── The connection ─────────────────────────────────────────────────────────

/** The part of EventSource the connection uses, so a test can stand in for it. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

const CLOSED = 2;
const FRAME_TYPES = ['screen', 'question', 'answered', 'plan'] as const;

export interface ScreenFeedOptions {
  /** The stream address, resuming after the last event seen when `since` is given. */
  url: (since: string | undefined) => string;
  onLive: (live: LiveEvent) => void;
  onStatus?: (connected: boolean) => void;
  createSource?: (url: string) => EventSourceLike;
  /** How long to wait before reopening a stream the browser gave up on. */
  retryMs?: number;
}

/**
 * Keeps one stream open. The browser reconnects a dropped stream by itself and
 * sends the last event id; when it gives up instead (an error reply), this opens
 * a new one that resumes after the last event seen, so nothing is replayed twice.
 */
export function connectScreenFeed(options: ScreenFeedOptions): { close: () => void } {
  const create = options.createSource ?? ((url: string) => new EventSource(url) as EventSourceLike);
  let closed = false;
  let source: EventSourceLike | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastId: string | undefined;

  const open = () => {
    if (closed) return;
    const current = create(options.url(lastId));
    source = current;
    const live = () => !closed && source === current;
    current.addEventListener('open', () => { if (live()) options.onStatus?.(true); });
    for (const type of FRAME_TYPES) {
      current.addEventListener(type, (event) => {
        if (!live()) return;
        const parsed = parseLiveFrame(event.data);
        if (!parsed) return;
        if (isText(event.lastEventId)) lastId = event.lastEventId;
        options.onLive(parsed);
      });
    }
    current.addEventListener('error', () => {
      if (!live()) return;
      options.onStatus?.(false);
      if (current.readyState === CLOSED) {
        current.close();
        source = null;
        retry = setTimeout(open, options.retryMs ?? 2000);
      }
    });
  };

  open();
  return {
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
      source = null;
    },
  };
}
