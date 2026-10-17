/**
 * @module core/screen-events
 * What the AI tells the screen, and the live feed that carries it there. A tool
 * (running in a separate MCP process) appends one line to a dedicated ledger,
 * and the app tails that ledger together with the chat ledger's questions and
 * pushes new lines to the screen. The ledger is its own file so a chatty agent
 * cannot crowd real handoff messages out of the chat ledger's small windows.
 *
 * Nothing here is trusted: every line is rebuilt field by field when read, so a
 * hand-edited or corrupt ledger can neither crash the screen nor point it at a
 * path outside the workspace.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  INPUT_REQUEST_HARNESS_LIMIT,
  cleanInputRequestText,
  ledgerEntryTime,
  parseInputAckEntry,
  parseInputRequestEntry,
  type InputRequest,
} from './attention.js';
import { resolveWorkspaceChatLedger } from './constants.js';
import { PLAN_STORE_FILE } from './plan.js';
import { readLedgerTail } from './ledger-tail.js';
import {
  cleanLineNumber as lineNumber,
  cleanRelativePath as relativePath,
  cleanRepoName as repoName,
  cleanScreenText as text,
} from './screen-clean.js';

export const SCREEN_EVENT_KIND = 'screen_event';
export const SCREEN_EVENTS_FILE = 'screen-events.jsonl';
/** Events older than this are no longer replayed to a screen that connects. */
export const SCREEN_EVENT_MAX_AGE_MS = 24 * 60 * 60_000;
/** The same event from the same agent inside this window is shown once. */
export const SCREEN_EVENT_REPEAT_WINDOW_MS = 60_000;
/** Most events replayed to a screen that connects. */
export const SCREEN_EVENT_REPLAY_LIMIT = 50;
/** The ledger is rotated when it grows past this, so it cannot grow for ever. */
export const SCREEN_EVENTS_MAX_BYTES = 2 * 1024 * 1024;
/** How much of a ledger's end each read looks at. */
const TAIL_BYTES = 256 * 1024;
/** How often the live feed looks for new lines. */
export const SCREEN_FEED_POLL_MS = 1000;

export const SCREEN_TITLE_LIMIT = 120;
export const SCREEN_REASON_LIMIT = 300;
export const SCREEN_TEXT_LIMIT = 500;
export const SCREEN_NOTE_LIMIT = 300;

export type ScreenReaderView = 'document' | 'file' | 'diff';
export type AnnotationTag = 'question' | 'risk' | 'todo';
export type MilestoneProposalKind = 'reopen' | 'complete';
/** What the AI did to a milestone: started, blocked, finished or reopened it. */
export type MilestoneEventState = 'in_progress' | 'blocked' | 'done' | 'reopened';
const MILESTONE_EVENT_STATES: readonly string[] = ['in_progress', 'blocked', 'done', 'reopened'];

interface Base { id: string; timestamp: string; harness: string }
export type ScreenEvent = Base & (
  | { event: 'show'; payload: { view: ScreenReaderView; path?: string; repo?: string; line?: number; endLine?: number; note?: string } }
  | { event: 'annotate'; payload: { path: string; repo?: string; line: number; text: string; tag: AnnotationTag } }
  | { event: 'next'; payload: { title: string; reason: string; path?: string; repo?: string; line?: number } }
  | { event: 'milestone'; payload: { stepId: string; state: MilestoneEventState; note?: string } }
  | { event: 'milestone_proposal'; payload: { stepId: string; proposal: MilestoneProposalKind; reason: string } }
);
export type ScreenEventName = ScreenEvent['event'];
export type ScreenEventInput = { [E in ScreenEvent as E['event']]: { event: E['event']; payload: E['payload'] } }[ScreenEventName];

/** Everything the live feed carries to the screen. */
export type LiveEvent =
  | { type: 'screen'; event: ScreenEvent }
  | { type: 'question'; request: InputRequest }
  | { type: 'answered'; timestamp: string }
  /** The plan changed on disk, whoever changed it (an AI's CLI or MCP, another window): read it again. */
  | { type: 'plan'; timestamp: string };

// ─── Cleaning ───────────────────────────────────────────────────────────────

const STEP_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** Rebuilds a payload from untrusted input, or returns null when it does not make a usable event. */
function cleanPayload(event: ScreenEventName, raw: unknown): ScreenEvent['payload'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const optional = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

  switch (event) {
    case 'show': {
      const view = p.view === 'document' || p.view === 'file' || p.view === 'diff' ? p.view : null;
      if (!view) return null;
      const target = relativePath(p.path);
      // A diff may name no file, meaning every change in the repository. Anything else needs a path.
      if (!target && view !== 'diff') return null;
      const line = lineNumber(p.line);
      const endLine = lineNumber(p.endLine);
      return {
        view,
        ...optional('path', target),
        ...optional('repo', repoName(p.repo)),
        ...optional('line', line),
        ...optional('endLine', line !== undefined && endLine !== undefined && endLine >= line ? endLine : undefined),
        ...optional('note', text(p.note, SCREEN_NOTE_LIMIT)),
      };
    }
    case 'annotate': {
      const target = relativePath(p.path);
      const line = lineNumber(p.line);
      const body = text(p.text, SCREEN_TEXT_LIMIT);
      const tag = p.tag === 'risk' || p.tag === 'todo' ? p.tag : 'question';
      if (!target || line === undefined || !body) return null;
      return { path: target, line, text: body, tag, ...optional('repo', repoName(p.repo)) };
    }
    case 'next': {
      const title = text(p.title, SCREEN_TITLE_LIMIT);
      const reason = text(p.reason, SCREEN_REASON_LIMIT);
      if (!title || !reason) return null;
      const target = relativePath(p.path);
      return { title, reason, ...optional('path', target), ...(target ? optional('repo', repoName(p.repo)) : {}), ...(target ? optional('line', lineNumber(p.line)) : {}) };
    }
    case 'milestone': {
      const state = typeof p.state === 'string' && MILESTONE_EVENT_STATES.includes(p.state) ? p.state as MilestoneEventState : null;
      if (typeof p.stepId !== 'string' || !STEP_ID.test(p.stepId) || !state) return null;
      return { stepId: p.stepId, state, ...optional('note', text(p.note, SCREEN_TEXT_LIMIT)) };
    }
    case 'milestone_proposal': {
      const proposal = p.proposal === 'reopen' || p.proposal === 'complete' ? p.proposal : null;
      const reason = text(p.reason, SCREEN_TEXT_LIMIT);
      if (typeof p.stepId !== 'string' || !STEP_ID.test(p.stepId) || !proposal || !reason) return null;
      return { stepId: p.stepId, proposal, reason };
    }
    default:
      return null;
  }
}

/** The screen event a ledger line holds, or null when it is not one or is not usable. */
export function parseScreenEntry(entry: any, now: number): ScreenEvent | null {
  if (!entry || typeof entry !== 'object' || entry.kind !== SCREEN_EVENT_KIND) return null;
  const time = ledgerEntryTime(entry, now);
  const names: readonly string[] = ['show', 'annotate', 'next', 'milestone', 'milestone_proposal'];
  if (time === null || typeof entry.id !== 'string' || !entry.id || !names.includes(entry.event)) return null;
  const payload = cleanPayload(entry.event, entry.payload);
  if (!payload) return null;
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    harness: cleanInputRequestText(entry.harness).slice(0, INPUT_REQUEST_HARNESS_LIMIT) || 'agent',
    event: entry.event,
    payload,
  } as ScreenEvent;
}

// ─── The ledger ─────────────────────────────────────────────────────────────

async function screenEventsPath(workspaceRoot: string): Promise<{ file: string; dir: string }> {
  const ledger = await resolveWorkspaceChatLedger(workspaceRoot);
  return { file: path.join(ledger.chatDir, SCREEN_EVENTS_FILE), dir: ledger.chatDir };
}

function parseLines(lines: readonly string[], now: number): ScreenEvent[] {
  const events: ScreenEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = parseScreenEntry(JSON.parse(trimmed), now);
      if (event) events.push(event);
    } catch {
      // A corrupt line is skipped.
    }
  }
  return events;
}

/**
 * Screen events from the last {@link SCREEN_EVENT_MAX_AGE_MS}, oldest first,
 * at most `limit`. Reads only the end of the ledger.
 */
export async function listScreenEvents(
  workspaceRoot: string,
  options: { sinceMs?: number; now?: number; limit?: number } = {},
): Promise<ScreenEvent[]> {
  const now = options.now ?? Date.now();
  const since = Math.max(options.sinceMs ?? 0, now - SCREEN_EVENT_MAX_AGE_MS);
  const { file } = await screenEventsPath(workspaceRoot);
  const tail = await readLedgerTail(file, since, TAIL_BYTES);
  return parseLines(tail.lines, now)
    .filter((event) => Date.parse(event.timestamp) >= since)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-(options.limit ?? SCREEN_EVENT_REPLAY_LIMIT));
}

function sameEvent(a: ScreenEventInput, b: ScreenEvent): boolean {
  return a.event === b.event && JSON.stringify(a.payload) === JSON.stringify(b.payload);
}

let appendQueue: Promise<unknown> = Promise.resolve();

/**
 * Appends a line unless the file has already grown past `limit`, and says whether it did. The size is read from the
 * open file itself, so it cannot be another file than the one written to.
 */
async function appendWithin(file: string, line: string, limit: number): Promise<boolean> {
  const handle = await fs.open(file, 'a');
  try {
    if ((await handle.stat()).size > limit) return false;
    await handle.appendFile(line, 'utf8');
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Records one event. An identical event from the same agent inside
 * {@link SCREEN_EVENT_REPEAT_WINDOW_MS} is not recorded again, because an agent
 * that calls a tool twice should not make the screen jump twice.
 * @throws When the payload does not make a usable event.
 */
export async function appendScreenEvent(
  workspaceRoot: string,
  input: ScreenEventInput & { harness?: string },
  now: number = Date.now(),
): Promise<{ status: 'shown' | 'already_shown'; event: ScreenEvent }> {
  const payload = cleanPayload(input.event, input.payload);
  if (!payload) throw new Error(`That is not a usable ${input.event} event.`);
  const harness = cleanInputRequestText(input.harness).slice(0, INPUT_REQUEST_HARNESS_LIMIT) || 'agent';
  const clean = { event: input.event, payload } as ScreenEventInput;

  const run = async () => {
    const { file, dir } = await screenEventsPath(workspaceRoot);
    const recent = await listScreenEvents(workspaceRoot, { sinceMs: now - SCREEN_EVENT_REPEAT_WINDOW_MS, now, limit: 100 });
    const repeat = recent.find((event) => event.harness === harness && sameEvent(clean, event));
    if (repeat) return { status: 'already_shown' as const, event: repeat };

    await fs.mkdir(dir, { recursive: true });
    const event = { id: randomUUID(), timestamp: new Date(now).toISOString(), harness, ...clean } as ScreenEvent;
    const line = JSON.stringify({ ...event, author: 'agent', kind: SCREEN_EVENT_KIND }) + '\n';
    if (!(await appendWithin(file, line, SCREEN_EVENTS_MAX_BYTES))) {
      // Keep one earlier file. Reading only ever needs the end, so nothing is lost that a screen could still want.
      await fs.rm(`${file}.1`, { force: true });
      await fs.rename(file, `${file}.1`).catch(() => {});
      await fs.appendFile(file, line, 'utf8');
    }
    return { status: 'shown' as const, event };
  };
  const result = appendQueue.then(run, run);
  appendQueue = result.catch(() => {});
  return result;
}

// ─── The live feed ──────────────────────────────────────────────────────────

async function signature(files: readonly string[]): Promise<string> {
  const parts = await Promise.all(files.map((file) => fs.stat(file).then((s) => `${s.size}:${s.mtimeMs}`, () => 'none')));
  return parts.join('|');
}

/** Every file the feed reads. The chat ledger may not exist yet (the first question creates it), so its path is always included. */
async function liveFiles(workspaceRoot: string): Promise<{ screen: string; chat: string[] }> {
  const ledger = await resolveWorkspaceChatLedger(workspaceRoot);
  const { file } = await screenEventsPath(workspaceRoot);
  return { screen: file, chat: [...new Set([ledger.chatPath, ...ledger.readPaths])] };
}

async function collect(
  workspaceRoot: string,
  sinceMs: number,
  now: number,
): Promise<Array<{ key: string; time: number; event: LiveEvent }>> {
  const { screen: file, chat } = await liveFiles(workspaceRoot);
  const found: Array<{ key: string; time: number; event: LiveEvent }> = [];

  const screen = await readLedgerTail(file, sinceMs, TAIL_BYTES);
  for (const event of parseLines(screen.lines, now)) {
    const time = Date.parse(event.timestamp);
    if (time >= sinceMs) found.push({ key: `s:${event.id}`, time, event: { type: 'screen', event } });
  }

  for (const chatFile of chat) {
    const tail = await readLedgerTail(chatFile, sinceMs, TAIL_BYTES);
    for (const line of tail.lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: unknown;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const request = parseInputRequestEntry(entry, sinceMs, now);
      if (request) {
        const { time, ...rest } = request;
        found.push({ key: `q:${request.id}`, time, event: { type: 'question', request: rest } });
        continue;
      }
      const ack = parseInputAckEntry(entry, now);
      if (ack !== null && ack >= sinceMs) {
        found.push({ key: `a:${(entry as { id?: string }).id ?? ack}`, time: ack, event: { type: 'answered', timestamp: new Date(ack).toISOString() } });
      }
    }
  }
  return found.sort((a, b) => a.time - b.time);
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * The live feed for one workspace: what the AI told the screen, the questions it
 * asked and when they were answered, oldest first. It first replays what is
 * recent (since `since`, at most the last {@link SCREEN_EVENT_REPLAY_LIMIT}), then yields
 * each new line as it is written. It polls for changes, which is cheap because a
 * poll with nothing new costs only a `stat`. A burst of more than a few hundred
 * kilobytes between two polls loses its oldest lines. Stops when `signal` aborts.
 */
export async function* watchLiveEvents(
  workspaceRoot: string,
  options: { since?: number; signal?: AbortSignal; pollMs?: number; now?: () => number } = {},
): AsyncGenerator<LiveEvent> {
  const clock = options.now ?? Date.now;
  const pollMs = options.pollMs ?? SCREEN_FEED_POLL_MS;
  const seen = new Set<string>();
  let last = '';
  let first = true;
  const planFile = path.join(workspaceRoot, PLAN_STORE_FILE);
  let planLast: string | undefined;

  while (!options.signal?.aborted) {
    const now = clock();
    // A plan written by any tool is on screen within a poll, not at the next read of the plan.
    const planNow = await signature([planFile]);
    if (planLast !== undefined && planNow !== planLast) yield { type: 'plan', timestamp: new Date(now).toISOString() };
    planLast = planNow;
    // Re-read which files exist every time: a ledger that appears after the feed started must still be seen.
    const files = await liveFiles(workspaceRoot);
    const current = await signature([files.screen, ...files.chat]);
    if (first || current !== last) {
      last = current;
      const since = Math.max(options.since ?? 0, now - SCREEN_EVENT_MAX_AGE_MS);
      let events = await collect(workspaceRoot, since, now);
      if (first) {
        // Replay only the newest few, so a long-running workspace does not flood a screen that just opened. What is
        // held back counts as seen: the next read covers the same window, and must not send it after all.
        const screens = events.filter((e) => e.event.type === 'screen');
        const drop = new Set(screens.slice(0, Math.max(0, screens.length - SCREEN_EVENT_REPLAY_LIMIT)).map((e) => e.key));
        for (const key of drop) seen.add(key);
        events = events.filter((e) => !drop.has(e.key));
      }
      for (const entry of events) {
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        if (seen.size > 2000) seen.delete(seen.values().next().value as string);
        yield entry.event;
      }
      first = false;
    }
    await pause(pollMs, options.signal);
  }
}
