/**
 * @module core/attention
 * Finds the "agent needs the user" requests in a workspace's chat ledger,
 * so the app can flag the CLI chat that is waiting. Written by the MCP
 * `request_user_input` tool as a `kind: 'input_request'` ledger entry. The app
 * answers with a `kind: 'input_ack'` entry, because replies typed into the chat
 * terminal never reach the ledger.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { resolveWorkspaceChatLedger } from './constants.js';
import { readLedgerTail } from './ledger-tail.js';

/** Longest request message handed to the app, whatever the ledger holds. */
export const INPUT_REQUEST_DISPLAY_LIMIT = 500;
/** Longest harness name kept with a request. */
export const INPUT_REQUEST_HARNESS_LIMIT = 40;
/** Requests older than this are no longer worth an alert. */
export const INPUT_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000;
/** How far ahead of this machine's clock an entry may claim to be. */
const CLOCK_SKEW_MS = 5 * 60_000;
/**
 * How much of the end of a ledger is read, tried in turn. A request is nearly
 * always near the end, so the first step answers; the second finds one with a
 * lot of newer entries after it. Beyond the last step a request is not seen.
 */
const TAIL_STEPS = [64 * 1024, 512 * 1024];

/** Most answer options a request can offer. */
export const INPUT_REQUEST_OPTIONS_MAX = 6;
/** Longest answer option, in characters. */
export const INPUT_REQUEST_OPTION_LIMIT = 80;

export interface InputRequest {
  id: string;
  timestamp: string;
  harness: string;
  message: string;
  /** Short answers the agent suggests. A button fills the prompt with one; the user still presses Enter. */
  options?: string[];
}

/**
 * Text from an agent or a ledger made safe to show: control characters, which can
 * reshape a terminal or a toast, are removed and the ends are trimmed. Newlines and
 * tabs stay. Anything that is not a string becomes the empty string.
 */
export function cleanInputRequestText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}

/**
 * Answer options from an agent or a ledger, made safe to show: cleaned like any
 * ledger text, cut to length, without blanks or repeats, and at most
 * {@link INPUT_REQUEST_OPTIONS_MAX}. Returns undefined when nothing usable is left.
 */
export function cleanInputOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const options: string[] = [];
  for (const item of value) {
    const option = cleanInputRequestText(item).replace(/\s+/g, ' ').slice(0, INPUT_REQUEST_OPTION_LIMIT).trim();
    if (!option || seen.has(option)) continue;
    seen.add(option);
    options.push(option);
    if (options.length === INPUT_REQUEST_OPTIONS_MAX) break;
  }
  return options.length ? options : undefined;
}

type Candidate = InputRequest & { time: number };

/** When a ledger entry says it was written, or null when that is missing, invalid or implausibly far ahead. */
export function ledgerEntryTime(entry: any, now: number): number | null {
  const time = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  // A timestamp from the future would stay "newest" and pin its alert.
  return Number.isFinite(time) && time <= now + CLOCK_SKEW_MS ? time : null;
}

/** The input request a ledger entry holds, or null when it is not one, is stale, or has no message. */
export function parseInputRequestEntry(entry: any, sinceMs: number, now: number): Candidate | null {
  if (!entry || typeof entry !== 'object' || entry.kind !== 'input_request') return null;
  const time = ledgerEntryTime(entry, now);
  const message = cleanInputRequestText(entry.message).slice(0, INPUT_REQUEST_DISPLAY_LIMIT);
  if (time === null || time < sinceMs || !message) return null;
  const options = cleanInputOptions(entry.options);
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : `${entry.timestamp}`,
    timestamp: entry.timestamp,
    harness: cleanInputRequestText(entry.harness).slice(0, INPUT_REQUEST_HARNESS_LIMIT) || 'agent',
    message,
    ...(options ? { options } : {}),
    time,
  };
}

/** When an acknowledgement entry was written, or null when the entry is not one. */
export function parseInputAckEntry(entry: any, now: number): number | null {
  return entry && typeof entry === 'object' && entry.kind === 'input_ack' ? ledgerEntryTime(entry, now) : null;
}

interface LedgerScan {
  /** Valid input requests in file order. */
  requests: Candidate[];
  /** Time of the newest acknowledgement, or 0 when there is none. */
  ackTime: number;
}

function scanLedger(lines: readonly string[], sinceMs: number, now: number): LedgerScan {
  const requests: Candidate[] = [];
  let ackTime = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ack = parseInputAckEntry(entry, now);
    if (ack !== null) {
      ackTime = Math.max(ackTime, ack);
      continue;
    }
    const request = parseInputRequestEntry(entry, sinceMs, now);
    if (request) requests.push(request);
  }
  return { requests, ackTime };
}

/** The newest request in a scan. A later entry wins a tie. Acknowledgements are applied by the caller. */
function newestOf(requests: readonly Candidate[]): Candidate | null {
  let latest: Candidate | null = null;
  for (const request of requests) {
    if (latest && request.time < latest.time) continue;
    latest = request;
  }
  return latest;
}

/**
 * Returns the newest input request in the workspace's ledger that is no older
 * than {@link INPUT_REQUEST_MAX_AGE_MS} and has not been acknowledged, or null.
 * Malformed lines and entries without a valid timestamp or message are skipped.
 */
export async function latestInputRequest(
  workspaceDir: string,
  now: number = Date.now(),
): Promise<InputRequest | null> {
  const sinceMs = now - INPUT_REQUEST_MAX_AGE_MS;
  const ledger = await resolveWorkspaceChatLedger(workspaceDir);
  let latest: Candidate | null = null;
  let ackTime = 0;

  for (const file of ledger.readPaths) {
    for (const bytes of TAIL_STEPS) {
      const tail = await readLedgerTail(file, sinceMs, bytes);
      const scan = scanLedger(tail.lines, sinceMs, now);
      const found = newestOf(scan.requests);
      ackTime = Math.max(ackTime, scan.ackTime);
      if (found && (!latest || found.time >= latest.time)) latest = found;
      // An acknowledgement in the tail answers everything before it, so reading further back finds nothing open.
      if (found || scan.ackTime > 0 || tail.complete) break;
    }
  }

  if (!latest || latest.time < ackTime) return null;
  const { time: _time, ...request } = latest;
  return request;
}

/** Most open requests returned by {@link listOpenInputRequests}. */
export const INPUT_REQUEST_LIST_LIMIT = 20;

/**
 * Every input request from the last {@link INPUT_REQUEST_MAX_AGE_MS} that has
 * not been acknowledged, oldest first (the one waiting longest leads), at most
 * {@link INPUT_REQUEST_LIST_LIMIT}. Reads the end of each ledger only.
 */
export async function listOpenInputRequests(
  workspaceDir: string,
  now: number = Date.now(),
): Promise<InputRequest[]> {
  const sinceMs = now - INPUT_REQUEST_MAX_AGE_MS;
  const ledger = await resolveWorkspaceChatLedger(workspaceDir);
  const byId = new Map<string, Candidate>();
  let ackTime = 0;

  for (const file of ledger.readPaths) {
    const tail = await readLedgerTail(file, sinceMs, TAIL_STEPS[TAIL_STEPS.length - 1]!);
    const scan = scanLedger(tail.lines, sinceMs, now);
    ackTime = Math.max(ackTime, scan.ackTime);
    for (const request of scan.requests) byId.set(request.id, request);
  }

  // A request at the same instant as an acknowledgement stays open: showing a question twice is safer than hiding one.
  return [...byId.values()]
    .filter((request) => request.time >= ackTime)
    .sort((a, b) => a.time - b.time)
    .slice(-INPUT_REQUEST_LIST_LIMIT)
    .map(({ time: _time, ...request }) => request);
}

/**
 * Marks every question asked so far as answered. Replies typed into the chat
 * terminal never reach the ledger, so the app records this explicitly, and the
 * alert and the open-question count both honour it.
 */
export async function acknowledgeInputRequests(
  workspaceDir: string,
  now: number = Date.now(),
): Promise<{ acknowledged: number; timestamp: string; requests: InputRequest[] }> {
  const open = await listOpenInputRequests(workspaceDir, now);
  const ledger = await resolveWorkspaceChatLedger(workspaceDir);
  await fs.mkdir(ledger.chatDir, { recursive: true });
  const timestamp = new Date(now).toISOString();
  const entry = { id: randomUUID(), timestamp, harness: 'developer', author: 'human', kind: 'input_ack', message: 'Marked answered' };
  await fs.appendFile(ledger.chatPath, JSON.stringify(entry) + '\n', 'utf8');
  return { acknowledged: open.length, timestamp, requests: open };
}
