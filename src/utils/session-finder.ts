/**
 * @module utils/session-finder
 * Scans local storage directories of various AI coding assistants to find conversation histories.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AISession, ChatMessage, NormalizedUsage, NormalizedRemainingQuota, SessionAssistant } from '../types.js';
import type { SessionSource } from './cli-harnesses.js';
import type { IDatabaseSync } from '../storage/db.js';
import { MODULAR_SESSION_READERS, modularSessionReader } from './session-readers.js';
export { SESSION_SOURCES } from './cli-harnesses.js';
export type { SessionSource } from './cli-harnesses.js';

export function extractRecordUsage(record: any): { usage?: NormalizedUsage; quota?: NormalizedRemainingQuota } {
  if (!record || typeof record !== 'object') return {};

  const rawUsage = record.usage || record.message?.usage || record.payload?.usage;
  const rawQuota = record.quota || record.payload?.quota || rawUsage?.remainingQuota;

  let usage: NormalizedUsage | undefined;

  if (rawUsage && typeof rawUsage === 'object') {
    const input = typeof rawUsage.inputTokens === 'number'
      ? rawUsage.inputTokens
      : (typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : 0);
    const output = typeof rawUsage.outputTokens === 'number'
      ? rawUsage.outputTokens
      : (typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : 0);

    const cacheRead = typeof rawUsage.cacheReadInputTokens === 'number'
      ? rawUsage.cacheReadInputTokens
      : (typeof rawUsage.cache_read_input_tokens === 'number' ? rawUsage.cache_read_input_tokens : undefined);
    const cacheWrite = typeof rawUsage.cacheWriteInputTokens === 'number'
      ? rawUsage.cacheWriteInputTokens
      : (typeof rawUsage.cache_creation_input_tokens === 'number'
          ? rawUsage.cache_creation_input_tokens
          : (typeof rawUsage.cache_write_input_tokens === 'number' ? rawUsage.cache_write_input_tokens : undefined));

    let cached: number | undefined;
    if (typeof rawUsage.cachedInputTokens === 'number') {
      cached = rawUsage.cachedInputTokens;
    } else if (typeof rawUsage.cached_input_tokens === 'number') {
      cached = rawUsage.cached_input_tokens;
    } else if (cacheRead !== undefined || cacheWrite !== undefined) {
      cached = (cacheRead ?? 0) + (cacheWrite ?? 0);
    }

    const reasoning = typeof rawUsage.reasoningOutputTokens === 'number'
      ? rawUsage.reasoningOutputTokens
      : (typeof rawUsage.reasoning_output_tokens === 'number' ? rawUsage.reasoning_output_tokens : undefined);

    const cost = typeof rawUsage.costUsdEstimate === 'number'
      ? rawUsage.costUsdEstimate
      : (typeof rawUsage.cost_usd_estimate === 'number'
          ? rawUsage.cost_usd_estimate
          : (typeof record.totalCostUsd === 'number' ? record.totalCostUsd : undefined));

    if (input > 0 || output > 0 || (cached !== undefined && cached > 0) || cost !== undefined) {
      usage = {
        inputTokens: input,
        outputTokens: output,
        ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
        ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
        ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
        totalTokens: input + output,
        ...(cost !== undefined ? { costUsdEstimate: cost } : {}),
      };
    }
  } else if (typeof record.totalCostUsd === 'number') {
    usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsdEstimate: record.totalCostUsd,
    };
  }

  let quota: NormalizedRemainingQuota | undefined;
  if (rawQuota && typeof rawQuota === 'object') {
    quota = rawQuota;
  }

  return { usage, quota };
}

export function accumulateUsage(acc: NormalizedUsage | undefined, turn: NormalizedUsage): NormalizedUsage {
  const next: NormalizedUsage = {
    inputTokens: (acc?.inputTokens ?? 0) + turn.inputTokens,
    outputTokens: (acc?.outputTokens ?? 0) + turn.outputTokens,
  };
  const cached = (acc?.cachedInputTokens ?? 0) + (turn.cachedInputTokens ?? 0);
  if (cached > 0 || acc?.cachedInputTokens !== undefined || turn.cachedInputTokens !== undefined) {
    next.cachedInputTokens = cached;
  }
  if (acc?.cacheReadInputTokens !== undefined || turn.cacheReadInputTokens !== undefined) {
    next.cacheReadInputTokens = (acc?.cacheReadInputTokens ?? 0) + (turn.cacheReadInputTokens ?? 0);
  }
  if (acc?.cacheWriteInputTokens !== undefined || turn.cacheWriteInputTokens !== undefined) {
    next.cacheWriteInputTokens = (acc?.cacheWriteInputTokens ?? 0) + (turn.cacheWriteInputTokens ?? 0);
  }
  if (acc?.reasoningOutputTokens !== undefined || turn.reasoningOutputTokens !== undefined) {
    next.reasoningOutputTokens = (acc?.reasoningOutputTokens ?? 0) + (turn.reasoningOutputTokens ?? 0);
  }
  if (acc?.costUsdEstimate !== undefined || turn.costUsdEstimate !== undefined) {
    next.costUsdEstimate = (acc?.costUsdEstimate ?? 0) + (turn.costUsdEstimate ?? 0);
  }
  next.totalTokens = next.inputTokens + next.outputTokens;
  return next;
}

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true if the given value is a canonical UUIDv4-shaped string. */
export function isUuid(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/** Enforce UUID format for session IDs interpolated into filesystem paths. */
export function assertSafeSessionId(assistant: string, sessionId: string): void {
  if (!isUuid(sessionId)) {
    if (assistant.toLowerCase() === 'codex') {
      throw new Error('Invalid Codex session id');
    }
    throw new Error(`Invalid ${assistant} session id`);
  }
}

/**
 * Resolves the root directory for Antigravity session storage, respecting
 * ANTIGRAVITY_CLI_HOME and GEMINI_CLI_HOME environment variables.
 */
export function getAntigravityDir(): string {
  if (process.env.ANTIGRAVITY_CLI_HOME) {
    return process.env.ANTIGRAVITY_CLI_HOME;
  }
  if (process.env.GEMINI_CLI_HOME) {
    const base = process.env.GEMINI_CLI_HOME;
    return path.basename(base) === 'antigravity-cli'
      ? base
      : path.join(base, 'antigravity-cli');
  }
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Derives the directory name that Claude Code uses inside `~/.claude/projects/`
 * for a given absolute project directory path.
 *
 * Claude Code replaces EVERY non-alphanumeric character with a hyphen and does
 * not collapse runs, so a Windows path like `C:\Users\a.b\Git\improve_las`
 * becomes `C--Users-a-b-Git-improve-las` (the drive colon and the `\` each map
 * to their own dash → `C--`, and the `.` in the user name becomes a dash).
 */
export function getClaudeProjectFolderName(absolutePath: string): string {
  const trimmed = absolutePath.replace(/[/\\]+$/, '');
  return trimmed.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Extract plain text from a Claude transcript record's message. */
export function claudeRecordText(record: any): string {
  const raw = record?.message?.text ?? record?.message?.content ?? record?.text ?? '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((b: any) => (typeof b === 'string' ? b : b?.text || b?.content || '')).join(' ');
  }
  return '';
}

/**
 * True for a Claude "user" record that is CLI-injected noise rather than a
 * typed prompt: meta caveats, slash-command wrappers, command stdout, or a
 * tool-result payload. These pollute session titles and loaded transcripts.
 */
export function isNoiseUserRecord(record: any, text: string): boolean {
  if (record?.isMeta) return true;
  // Content that is only tool_result / non-text blocks isn't a real prompt.
  const raw = record?.message?.content;
  if (Array.isArray(raw) && !raw.some((b: any) => typeof b === 'string' || b?.type === 'text')) {
    return true;
  }
  const t = text.trimStart();
  if (t === '') return true;
  return /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/.test(t);
}

/** Extract plain text from a Codex `response_item` message payload. */
export function codexMessageText(payload: any): string {
  const content = payload?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  return '';
}

/** Extract the resumable thread UUID from a Codex `session_meta` record. */
export function codexSessionId(record: any): string | null {
  const id = record?.type === 'session_meta' ? record?.payload?.id : null;
  return isCodexSessionId(id) ? id : null;
}

export function isCodexSessionId(id: unknown): id is string {
  return isUuid(id);
}

/** Preserve only provider-recorded dates; discovery time is not session activity. */
function sessionTimestamp(value: unknown): string | undefined {
  if ((typeof value !== 'string' || !value.trim()) && typeof value !== 'number') return undefined;
  const ms = new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
function sessionTimes() {
  let first: string | undefined, last: string | undefined;
  return {
    add(value: unknown) {
      const iso = sessionTimestamp(value);
      if (!iso) return;
      if (!first || iso < first) first = iso;
      if (!last || iso > last) last = iso;
    },
    values: () => ({ createdAt: first ?? '', updatedAt: last ?? '' }),
  };
}

export function codexThreadIdentity(meta: any): Pick<AISession, 'threadKind' | 'parentSessionId'> {
  const source = meta?.source;
  if (source && typeof source === 'object' && Object.hasOwn(source, 'subagent')) {
    const parent = source.subagent?.thread_spawn?.parent_thread_id;
    return { threadKind: 'subagent', ...(isUuid(parent) ? { parentSessionId: parent } : {}) };
  }
  if (source === 'subagent') return { threadKind: 'subagent' };
  // forked_from_id is a user-created fork, not proof of a subagent.
  return { threadKind: ['cli', 'vscode', 'exec', 'mcp'].includes(source) ? 'main' : 'unknown' };
}

/**
 * True for a user message that is CLI-injected context (Codex
 * <environment_context>/<user_instructions>, Copilot <system_reminder>) rather
 * than something the user typed.
 */
export function isInjectedContextText(text: string): boolean {
  const t = text.trimStart();
  return /^<(system_reminder|system-reminder|environment_context|user_instructions)>/.test(t);
}

/**
 * Sanitizes and single-lines a session title, capping its length.
 */
export function sanitizeSessionTitle(rawTitle: string, maxLength = 80): string {
  const singleLine = rawTitle.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'Untitled Session';
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '...' : singleLine;
}

export interface CopilotSessionRow {
  id: string;
  cwd: string;
  summary: string | null;
  created_at: string | number | null;
  updated_at: string | number | null;
}

export interface CopilotTurnCountRow {
  n: number | null;
}

export interface CopilotFirstMessageRow {
  user_message: string | null;
}

export interface CopilotCwdRow {
  cwd: string | null;
}

export interface CopilotTranscriptTurnRow {
  user_message: string | null;
  assistant_response: string | null;
  timestamp?: string | number | null;
}

/**
 * Opens GitHub Copilot's SQLite session store (`~/.copilot/session-store.db`)
 * read-only via Node's built-in `node:sqlite`. Returns null when the store is
 * absent or the runtime lacks node:sqlite (e.g. an older bundled Node in a
 * packaged Electron build) so Copilot support degrades gracefully instead of
 * throwing. Caller must close the returned handle.
 */
export async function openCopilotDb(customPath?: string): Promise<IDatabaseSync | null> {
  try {
    const dbPath = customPath || process.env.COPILOT_DB_PATH || path.join(os.homedir(), '.copilot', 'session-store.db');
    await fs.access(dbPath);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000;');
    } catch {}
    return db as unknown as IDatabaseSync;
  } catch {
    return null;
  }
}

/**
 * Recursively retrieves all files in a directory that match a specific extension.
 */
async function getFilesRecursively(dir: string, extension: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getFilesRecursively(fullPath, extension);
        result.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        result.push(fullPath);
      }
    }
  } catch {}
  return result;
}

// Real session_meta lines carry Codex's base instructions and measure about
// 20 KB, so a first read of 32 KB almost always suffices.
const CODEX_HEADER_READS = [32 * 1024, 256 * 1024];

/** Read the first Codex record without loading a potentially large rollout. */
async function codexSessionHeader(filePath: string): Promise<any | null> {
  const file = await fs.open(filePath, 'r');
  try {
    for (const size of CODEX_HEADER_READS) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      if (end >= 0) {
        try { return JSON.parse(buffer.toString('utf8', 0, end)); } catch { return null; }
      }
      if (bytesRead < size) return null; // the whole file had no line break
    }
    return null;
  } finally {
    await file.close();
  }
}

// ─── Parsed transcript cache ───────────────────────────────────────────────
// Session lists re-read every transcript on every request, which at scale is
// hundreds of megabytes per call. A parse depends only on the file, so keep it
// while the file's size and mtime are unchanged. Transcripts only grow while a
// session is active, so a changed file is always re-parsed.
interface ParsedTranscriptEntry { mtimeMs: number; size: number; value: unknown }
const PARSED_TRANSCRIPT_LIMIT = 4_000;
let parsedTranscripts = new Map<string, ParsedTranscriptEntry>();

async function parsedTranscript<T>(filePath: string, parse: (content: string) => T): Promise<T> {
  // Stat and read through one handle, so both describe the same file. The
  // stat comes first: a write after it changes the mtime, so the next request
  // re-parses instead of trusting this result.
  const handle = await fs.open(filePath, 'r');
  let stat;
  let content;
  try {
    stat = await handle.stat();
    const hit = parsedTranscripts.get(filePath);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value as T;
    content = await handle.readFile({ encoding: 'utf-8' });
  } finally {
    await handle.close();
  }
  const value = parse(content);
  parsedTranscripts.delete(filePath);
  parsedTranscripts.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  if (parsedTranscripts.size > PARSED_TRANSCRIPT_LIMIT) parsedTranscripts.delete(parsedTranscripts.keys().next().value!);
  return value;
}

/** Workspace-independent summary of one Claude transcript. */
function parseClaudeTranscript(content: string, sessionId: string, fileName: string): Omit<AISession, 'workspacePath'> {
  let messageCount = 0;
  const times = sessionTimes();
  let title = 'Claude Session';
  let recordedCwd: string | undefined;
  let threadKind: AISession['threadKind'] = fileName.startsWith('agent-') ? 'subagent' : 'unknown';
  let sessionUsage: NormalizedUsage | undefined;
  let latestQuota: NormalizedRemainingQuota | undefined;

  for (const line of content.split('\n')) {
    if (!line) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    times.add(record.timestamp);

    if (record.sessionId === sessionId && typeof record.cwd === 'string') recordedCwd ??= record.cwd;
    if (record.isSidechain === true) threadKind = 'subagent';
    else if (record.isSidechain === false && threadKind === 'unknown') threadKind = 'main';

    if (record.type === 'user' || record.type === 'assistant') {
      const text = claudeRecordText(record);
      // CLI-injected caveats, slash commands and tool results aren't
      // real turns — exclude them from the count and the title.
      const isNoise = record.type === 'user' && isNoiseUserRecord(record, text);
      if (isNoise) continue;
      messageCount++;
      if (record.type === 'user' && title === 'Claude Session' && text.trim()) {
        title = text.trim();
      }
    }
    const { usage: turnUsage, quota: turnQuota } = extractRecordUsage(record);
    if (turnUsage) sessionUsage = accumulateUsage(sessionUsage, turnUsage);
    if (turnQuota) latestQuota = turnQuota;
  }

  return {
    id: sessionId,
    assistant: 'claude',
    title: sanitizeSessionTitle(title),
    ...times.values(),
    messageCount,
    recordedCwd,
    threadKind,
    ...(sessionUsage ? { usage: sessionUsage } : {}),
    ...(latestQuota ? { quota: latestQuota } : {}),
  };
}

/** Workspace-independent summary of one Codex rollout. */
interface CodexRollout {
  sessionCwd: string | null;
  sessionId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  identity: Pick<AISession, 'threadKind' | 'parentSessionId'>;
  usage?: NormalizedUsage;
  quota?: NormalizedRemainingQuota;
}

function parseCodexRollout(content: string): CodexRollout {
  let sessionCwd: string | null = null;
  let sessionId: string | null = null;
  let messageCount = 0;
  const times = sessionTimes();
  let title = 'Codex Session';
  let identity: Pick<AISession, 'threadKind' | 'parentSessionId'> = { threadKind: 'unknown' };
  let sessionUsage: NormalizedUsage | undefined;
  let reportedTotalUsage: NormalizedUsage | undefined;
  let latestQuota: NormalizedRemainingQuota | undefined;

  for (const line of content.split('\n')) {
    if (!line) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }

    times.add(record.timestamp);
    times.add(record.payload?.timestamp);

    if (record.type === 'session_meta') {
      if (record.payload?.cwd) sessionCwd = record.payload.cwd;
      sessionId = codexSessionId(record) ?? sessionId;
      identity = codexThreadIdentity(record.payload);
    } else if (record.type === 'response_item' && record.payload?.type === 'message') {
      const role = record.payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = codexMessageText(record.payload).trim();
      if (role === 'user' && (!text || isInjectedContextText(text))) continue;
      messageCount++;
      if (role === 'user' && title === 'Codex Session' && text) {
        title = text;
      }
    }
    // Interactive Codex writes cumulative totals in token_count events,
    // rather than a top-level usage field. Keep the latest total instead
    // of summing snapshots from each turn.
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
      const total = record.payload.info?.total_token_usage;
      if (total) {
        const parsed = extractRecordUsage({ usage: total }).usage;
        if (parsed) {
          if (typeof total.cache_write_input_tokens === 'number') {
            parsed.cachedInputTokens = (typeof total.cached_input_tokens === 'number' ? total.cached_input_tokens : 0)
              + total.cache_write_input_tokens;
          }
          reportedTotalUsage = parsed;
        }
      }
    }
    const { usage: turnUsage, quota: turnQuota } = extractRecordUsage(record);
    if (turnUsage) sessionUsage = accumulateUsage(sessionUsage, turnUsage);
    if (turnQuota) latestQuota = turnQuota;
  }

  const usage = reportedTotalUsage ?? sessionUsage;
  return {
    sessionCwd, sessionId, title: sanitizeSessionTitle(title), ...times.values(), messageCount, identity,
    ...(usage ? { usage } : {}),
    ...(latestQuota ? { quota: latestQuota } : {}),
  };
}

/** Older rollouts carry no cwd; match them by scanning their content, as before. */
async function legacyRolloutMentions(file: string, normWorkspace: string, wsFolderName: string): Promise<boolean> {
  const content = await fs.readFile(file, 'utf-8');
  return content.toLowerCase().includes(normWorkspace) || content.includes(wsFolderName);
}

/**
 * Compare already-canonical paths without weakening case rules on POSIX.
 * Windows drive paths are case-insensitive; POSIX paths remain case-sensitive.
 */
export function isCanonicalPathWithin(
  rootPath: string,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string) => {
    const resolved = pathApi.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const root = normalize(rootPath);
  const candidate = normalize(candidatePath);
  const relative = pathApi.relative(root, candidate);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative));
}

/**
 * Authorize a Codex Desktop handoff using only the rollout's recorded cwd.
 * Discovery may use fuzzy matching for old files, but process-launch boundaries
 * must never treat transcript text or a workspace basename as ownership proof.
 */
export async function canOpenCodexSessionInWorkspace(
  workspacePath: string,
  repoPaths: string[],
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!isCodexSessionId(sessionId)) return false;

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const roots = (await Promise.all(
    [workspacePath, ...repoPaths].map(async (candidate) => {
      try {
        return await fs.realpath(candidate);
      } catch {
        return null;
      }
    }),
  )).filter((candidate): candidate is string => candidate !== null);
  if (roots.length === 0) return false;

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexFiles = await getFilesRecursively(path.join(codexHome, 'sessions'), '.jsonl');
  const candidates = [...codexFiles].sort((a, b) => {
    const aMatch = path.basename(a, '.jsonl').includes(sessionId) ? 0 : 1;
    const bMatch = path.basename(b, '.jsonl').includes(sessionId) ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return b.localeCompare(a);
  });
  for (const file of candidates) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      for (const line of content.split('\n').filter(Boolean)) {
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        if (codexSessionId(record) !== sessionId) continue;
        const recordedCwd = record?.payload?.cwd;
        if (typeof recordedCwd !== 'string' || !pathApi.isAbsolute(recordedCwd)) continue;

        let canonicalCwd: string;
        try {
          canonicalCwd = await fs.realpath(recordedCwd);
        } catch {
          continue;
        }
        if (roots.some((root) => isCanonicalPathWithin(root, canonicalCwd, platform))) {
          return true;
        }
      }
    } catch {
      // Ignore unreadable or concurrently-rotated rollout files.
    }
  }
  return false;
}

/**
 * Verify that a Claude transcript can be handed from the CLI to Desktop.
 * Claude project folder names are lossy, so the folder and filename alone are
 * never enough: the exact UUID and a canonical recorded cwd must both match.
 */
export async function canTransferClaudeSessionInWorkspace(
  workspacePath: string,
  repoPaths: string[],
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!isUuid(sessionId)) return false;

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const candidatePaths = [workspacePath, ...repoPaths];
  const roots = (await Promise.all(candidatePaths.map(async (candidate) => {
    try {
      return await fs.realpath(candidate);
    } catch {
      return null;
    }
  }))).filter((candidate): candidate is string => candidate !== null);
  if (roots.length === 0) return false;

  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const candidateFiles = [...new Set(candidatePaths.map((candidate) => path.join(
    claudeConfigDir,
    'projects',
    getClaudeProjectFolderName(candidate),
    `${sessionId}.jsonl`,
  )))];

  for (const file of candidateFiles) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      for (const line of content.split('\n').filter(Boolean)) {
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.sessionId !== sessionId) continue;
        const recordedCwd = record?.cwd;
        if (typeof recordedCwd !== 'string' || !pathApi.isAbsolute(recordedCwd)) continue;

        let canonicalCwd: string;
        try {
          canonicalCwd = await fs.realpath(recordedCwd);
        } catch {
          continue;
        }
        if (roots.some((root) => isCanonicalPathWithin(root, canonicalCwd, platform))) {
          return true;
        }
      }
    } catch {
      // Ignore missing or concurrently-rotated transcript files.
    }
  }
  return false;
}

/**
 * Scans the local filesystem for conversation histories belonging to Claude, Antigravity,
 * Codex, Copilot, and Pi that relate to the specified workspace.
 *
 * @param workspacePath - Root directory of the active workspace.
 * @param repoPaths - Directories of sub-repositories included in the workspace.
 * @param source - Optional history source to scan independently for progressive loading.
 * @returns A promise that resolves to an array of {@link AISession} objects sorted by update time descending.
 */
/** A conversation the user can continue: its own thread, recorded in a folder. */
export const isResumableSession = (session: AISession): boolean => session.threadKind !== 'subagent' && Boolean(session.recordedCwd);

/** Paths with their modification time, newest first. A file that cannot be read goes last. */
async function byRecentActivity(files: readonly string[]): Promise<string[]> {
  const stamped = await Promise.all(files.map(async (file) => ({ file, at: await fs.stat(file).then((s) => s.mtimeMs, () => 0) })));
  return stamped.sort((a, b) => b.at - a.at).map((entry) => entry.file);
}

/**
 * Every saved session of the workspace from the AI tools' history, newest first. With `newest`, only that many
 * resumable sessions per Claude and Codex are needed: their history is read in order of last activity and the scan
 * stops once they are found, instead of parsing every transcript (hundreds of megabytes on a busy machine).
 */
export async function findSessions(workspacePath: string, repoPaths: string[] = [], source?: SessionSource, options: { newest?: number } = {}): Promise<AISession[]> {
  const sessions: AISession[] = [];
  const enough = (assistant: AISession['assistant']) => options.newest !== undefined
    && sessions.filter((session) => session.assistant === assistant && isResumableSession(session)).length >= options.newest;
  const wsFolderName = path.basename(workspacePath);

  // Normalization helper for accurate path comparison
  const cleanPath = (p: string) => {
    const resolved = path.resolve(p).replace(/[/\\]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const normWorkspace = cleanPath(workspacePath);
  const normRepos = repoPaths.map(cleanPath);
  const sep = path.sep;

  const isPathMatch = (sessPath?: string) => {
    if (!sessPath) return false;
    const normSess = cleanPath(sessPath);
    if (normSess === normWorkspace || normSess.startsWith(normWorkspace + sep)) return true;
    for (const r of normRepos) {
      if (normSess === r || normSess.startsWith(r + sep)) return true;
    }
    return false;
  };

  const resolveTargetCwd = (sessPath?: string): string => {
    if (!sessPath) return workspacePath;
    const normSess = cleanPath(sessPath);
    for (let i = 0; i < repoPaths.length; i++) {
      const r = normRepos[i];
      if (normSess === r || normSess.startsWith(r + sep)) {
        return repoPaths[i];
      }
    }
    if (normSess === normWorkspace || normSess.startsWith(normWorkspace + sep)) {
      return sessPath;
    }
    return workspacePath;
  };

  // ─── 1. Scan Antigravity Sessions ──────────────────────────────────────
  if (!source || source === 'antigravity') {
  const agDir = getAntigravityDir();
  const agHistoryPath = path.join(agDir, 'history.jsonl');
  
  try {
    const historyContent = await fs.readFile(agHistoryPath, 'utf-8');
    const lines = historyContent.split('\n').filter(Boolean);
    const conversationsMap = new Map<string, { id: string; title: string; entries: any[] }>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.conversationId && isPathMatch(entry.workspace)) {
          if (!conversationsMap.has(entry.conversationId)) {
            conversationsMap.set(entry.conversationId, {
              id: entry.conversationId,
              title: entry.display || 'Untitled Conversation',
              entries: [],
            });
          }
          conversationsMap.get(entry.conversationId)!.entries.push(entry);
        }
      } catch {}
    }

    for (const [convId, convData] of conversationsMap.entries()) {
      const transcriptPath = path.join(agDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
      let messageCount = 0;
      const times = sessionTimes();
      for (const entry of convData.entries) times.add(entry.timestamp);
      let title = convData.title;
      let sessionUsage: NormalizedUsage | undefined;
      let latestQuota: NormalizedRemainingQuota | undefined;

      try {
        const transcriptContent = await fs.readFile(transcriptPath, 'utf-8');
        const transcriptLines = transcriptContent.split('\n').filter(Boolean);
        let firstUserMessage = null;

        for (const line of transcriptLines) {
          try {
            const tObj = JSON.parse(line);
            times.add(tObj.timestamp);
            if (tObj.type === 'USER_INPUT' || tObj.type === 'PLANNER_RESPONSE') {
              messageCount++;
              if (tObj.type === 'USER_INPUT' && !firstUserMessage) {
                firstUserMessage = tObj.content;
              }
            }
            const { usage: turnUsage, quota: turnQuota } = extractRecordUsage(tObj);
            if (turnUsage) sessionUsage = accumulateUsage(sessionUsage, turnUsage);
            if (turnQuota) latestQuota = turnQuota;
          } catch {}
        }

        if (firstUserMessage) {
          const cleanMatch = firstUserMessage.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          title = cleanMatch ? cleanMatch[1].trim() : firstUserMessage.trim();
        }
      } catch {
        messageCount = convData.entries.length * 2;
      }

      sessions.push({
        id: convId,
        assistant: 'antigravity',
        title: sanitizeSessionTitle(title),
        ...times.values(),
        messageCount,
        workspacePath: resolveTargetCwd(convData.entries[0]?.workspace),
        recordedCwd: convData.entries[0]?.workspace,
        threadKind: 'unknown',
        ...(sessionUsage ? { usage: sessionUsage } : {}),
        ...(latestQuota ? { quota: latestQuota } : {}),
      });
    }
  } catch {}
  }

  // ─── 2. Scan Claude Code Sessions ──────────────────────────────────────
  if (!source || source === 'claude') {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const claudeProjectsDir = path.join(claudeConfigDir, 'projects');
  
  try {
    const candidateTargets = [
      { folder: getClaudeProjectFolderName(workspacePath), targetPath: workspacePath },
      ...repoPaths.map(r => ({ folder: getClaudeProjectFolderName(r), targetPath: r }))
    ];

    const transcripts: Array<{ filePath: string; targetPath: string }> = [];
    for (const { folder, targetPath } of candidateTargets) {
      const projectPath = path.join(claudeProjectsDir, folder);
      try {
        const files = await fs.readdir(projectPath);
        for (const file of files.filter(f => f.endsWith('.jsonl'))) transcripts.push({ filePath: path.join(projectPath, file), targetPath });
      } catch {}
    }
    const targetOf = new Map(transcripts.map((entry) => [entry.filePath, entry.targetPath]));
    const ordered = options.newest === undefined ? transcripts.map((entry) => entry.filePath) : await byRecentActivity(transcripts.map((entry) => entry.filePath));
    for (const filePath of ordered) {
      if (enough('claude')) break;
      const file = path.basename(filePath);
      const sessionId = path.basename(file, '.jsonl');
      try {
        const parsed = await parsedTranscript(filePath, (content) => parseClaudeTranscript(content, sessionId, file));
        sessions.push({ ...parsed, workspacePath: targetOf.get(filePath)! });
      } catch {}
    }
  } catch {}
  }

  // ─── 3. OpenAI Codex Sessions (rollout-*.jsonl) ──────────────────────────
  if (!source || source === 'codex') {
  // Codex writes a `session_meta` record (payload.cwd) followed by
  // `response_item` records (payload.type==='message', role, content[].text).
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexSessionsDir = path.join(codexHome, 'sessions');
  try {
    const codexFiles = await getFilesRecursively(codexSessionsDir, '.jsonl');
    // Sort candidate rollout files so most recent / newest are scanned first
    const sortedCodexFiles = [...codexFiles].sort((a, b) => b.localeCompare(a));
    const MAX_CODEX_SCAN = 200;
    const newestByName = sortedCodexFiles.slice(0, MAX_CODEX_SCAN);
    // A rollout's name holds its start; a long conversation can be the most recently active, so `newest` goes by mtime.
    const filesToScan = options.newest === undefined ? newestByName : await byRecentActivity(newestByName);
    for (const file of filesToScan) {
      if (enough('codex')) break;
      try {
        // Rollouts record their cwd up front, and it never changes. Skip
        // unrelated conversations before opening their sometimes very large logs.
        let cwd = codexCwdCache.get(file)?.cwd ?? null;
        if (!cwd) {
          const header = await codexSessionHeader(file);
          const headerCwd = header?.type === 'session_meta' ? header.payload?.cwd : undefined;
          if (typeof headerCwd === 'string') {
            cwd = headerCwd;
            rememberCodexCwd(file, headerCwd);
          }
        }
        if (cwd && !isPathMatch(cwd)) continue;

        const rollout = await parsedTranscript(file, parseCodexRollout);
        if (rollout.sessionCwd) rememberCodexCwd(file, rollout.sessionCwd);
        // Match on the recorded cwd; fall back to a content scan for older files.
        const matched = rollout.sessionCwd
          ? isPathMatch(rollout.sessionCwd)
          : await legacyRolloutMentions(file, normWorkspace, wsFolderName);
        if (!matched) continue;
        // Skip contentless sessions (only injected context, no real turns).
        if (rollout.messageCount === 0) continue;

        // Current rollout filenames include timestamps. The stable resume id is
        // session_meta.payload.id, not the filename.
        if (!rollout.sessionId) continue;
        sessions.push({
          id: rollout.sessionId,
          assistant: 'codex',
          title: rollout.title,
          createdAt: rollout.createdAt,
          updatedAt: rollout.updatedAt,
          messageCount: rollout.messageCount,
          workspacePath: resolveTargetCwd(rollout.sessionCwd || undefined),
          recordedCwd: rollout.sessionCwd ?? undefined,
          ...rollout.identity,
          ...(rollout.usage ? { usage: rollout.usage } : {}),
          ...(rollout.quota ? { quota: rollout.quota } : {}),
        });
      } catch {}
    }
  } catch {}
  }

  // ─── 4. GitHub Copilot Sessions (SQLite session store) ───────────────────
  if (!source || source === 'copilot') {
  // Copilot keeps sessions in ~/.copilot/session-store.db: a `sessions` table
  // (id, cwd, summary, timestamps) and a `turns` table (user_message /
  // assistant_response per turn). Match on `cwd` like the other harnesses.
  const copilotDb = await openCopilotDb();
  if (copilotDb) {
    try {
      const rows = copilotDb.prepare<CopilotSessionRow>(
        'SELECT id, cwd, summary, created_at, updated_at FROM sessions'
      ).all();
      const countStmt = copilotDb.prepare<CopilotTurnCountRow>(
        `SELECT
           SUM(CASE WHEN TRIM(COALESCE(user_message, '')) != '' THEN 1 ELSE 0 END)
           + SUM(CASE WHEN TRIM(COALESCE(assistant_response, '')) != '' THEN 1 ELSE 0 END) AS n
         FROM turns WHERE session_id = ?`
      );
      const firstStmt = copilotDb.prepare<CopilotFirstMessageRow>(
        `SELECT user_message FROM turns
         WHERE session_id = ? AND TRIM(COALESCE(user_message, '')) != ''
           AND TRIM(user_message) NOT LIKE '<%'
         ORDER BY turn_index LIMIT 1`
      );
      for (const row of rows) {
        if (!isPathMatch(row.cwd)) continue;

        const counted = countStmt.get(row.id);
        const messageCount = Number(counted?.n ?? 0);

        let title = (row.summary || '').trim();
        if (!title) {
          const first = firstStmt.get(row.id);
          title = (first?.user_message || '').trim();
        }
        // Skip contentless sessions (no summary and no turns).
        if (!title && messageCount === 0) continue;
        if (!title) title = 'Copilot Session';

        sessions.push({
          id: row.id,
          assistant: 'copilot',
          title: sanitizeSessionTitle(title),
          createdAt: sessionTimestamp(row.created_at) ?? '',
          updatedAt: sessionTimestamp(row.updated_at) ?? '',
          messageCount,
          workspacePath: resolveTargetCwd(row.cwd),
          recordedCwd: row.cwd,
          threadKind: 'unknown',
        });
      }
    } catch {
      // Leave Copilot out rather than fail the whole listing.
    } finally {
      try { copilotDb.close(); } catch {}
    }
  }
  }

  // ─── Modular history readers ────────────────────────────────────────────
  const scanContext = { roots: [workspacePath, ...repoPaths], matchesCwd: isPathMatch, targetCwd: resolveTargetCwd };
  for (const [id, reader] of Object.entries(MODULAR_SESSION_READERS)) {
    if (!source || source === id) sessions.push(...await reader.list(scanContext));
  }

  // ─── Scan Workspace .sessions Directory ──────────────────────────────────
  if (!source || source === 'workspace') {
  try {
    const wsSessionsDir = path.join(workspacePath, '.sessions');
    const sessionFiles = await getFilesRecursively(wsSessionsDir, '.jsonl').catch(() => []);
    for (const filePath of sessionFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length === 0) continue;

        let sessionId = path.basename(filePath, '.jsonl');
        let assistant: SessionAssistant = 'claude';
        let title = 'AI Session';
        let messageCount = 0;
        const times = sessionTimes();
        let sessionUsage: NormalizedUsage | undefined;
        let latestQuota: NormalizedRemainingQuota | undefined;

        for (const line of lines) {
          let record: any;
          try { record = JSON.parse(line); } catch { continue; }
          times.add(record.timestamp);

          if (record.sessionId) sessionId = record.sessionId;
          if (record.provider) {
            const p = String(record.provider).toLowerCase();
            if (p.includes('claude')) assistant = 'claude';
            else if (p.includes('codex')) assistant = 'codex';
            else if (p.includes('antigravity') || p.includes('gemini')) assistant = 'antigravity';
            else if (p.includes('copilot')) assistant = 'copilot';
            else if (p === 'pi') assistant = 'pi';
          }
          if (record.userPrompt && title === 'AI Session') {
            title = String(record.userPrompt).trim();
          }
          if (record.userPrompt || record.assistantResponse) {
            messageCount += (record.userPrompt ? 1 : 0) + (record.assistantResponse ? 1 : 0);
          }

          const { usage: turnUsage, quota: turnQuota } = extractRecordUsage(record);
          if (turnUsage) sessionUsage = accumulateUsage(sessionUsage, turnUsage);
          if (turnQuota) latestQuota = turnQuota;
        }

        if (!sessions.some((s) => s.id === sessionId)) {
          sessions.push({
            id: sessionId,
            assistant,
            title: sanitizeSessionTitle(title),
            ...times.values(),
            messageCount: messageCount || lines.length,
            workspacePath,
            threadKind: 'unknown',
            ...(sessionUsage ? { usage: sessionUsage } : {}),
            ...(latestQuota ? { quota: latestQuota } : {}),
          });
        }
      } catch {}
    }
  } catch {}
  }

  // Sort by updatedAt descending
  sessions.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return sessions;
}

/**
 * Quickly checks which AI assistants have active/recorded sessions for a given workspace.
 * Unlike `findSessions`, this function returns as soon as each assistant is found,
 * without reading full transcripts or parsing unnecessary session content.
 *
 * @param workspacePath - Root directory of the active workspace.
 * @param repoPaths - Directories of sub-repositories included in the workspace.
 * @returns A promise that resolves to an array of unique session assistant names.
 */
// ─── High-Performance mtime-aware Session Caches ────────────────────────────
let agHistoryCache: { mtime: number; workspaces: string[] } | null = null;
let copilotSessionsCache: { mtime: number; cwds: string[] } | null = null;
// Per-rollout cwd, keyed by file path. A rollout's cwd is fixed once its
// session_meta record exists; files without one are retried when they change.
type CodexCwdEntry = { cwd: string | null; mtimeMs: number; size: number };
let codexCwdCache = new Map<string, CodexCwdEntry>();

/** Records a rollout's cwd, which never changes once written. */
function rememberCodexCwd(file: string, cwd: string): void {
  codexCwdCache.set(file, { cwd, mtimeMs: 0, size: 0 });
}

/** Clears internal caches used by session detection (primarily for unit tests). */
export function clearSessionFinderCache(): void {
  agHistoryCache = null;
  copilotSessionsCache = null;
  codexCwdCache = new Map();
  parsedTranscripts = new Map();
}

async function getAntigravityWorkspaces(agDir: string): Promise<string[]> {
  const agHistoryPath = path.join(agDir, 'history.jsonl');
  try {
    const handle = await fs.open(agHistoryPath, 'r');
    try {
      const stat = await handle.stat();
      if (agHistoryCache && agHistoryCache.mtime === stat.mtimeMs) {
        return agHistoryCache.workspaces;
      }
      const historyContent = await handle.readFile({ encoding: 'utf-8' });
      const lines = historyContent.split('\n').filter(Boolean);
      const workspaces: string[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.conversationId && typeof entry.workspace === 'string') {
            workspaces.push(entry.workspace);
          }
        } catch {}
      }
      agHistoryCache = { mtime: stat.mtimeMs, workspaces };
      return workspaces;
    } finally {
      await handle.close();
    }
  } catch {
    agHistoryCache = null;
    return [];
  }
}

async function getCopilotCwds(): Promise<string[]> {
  const dbPath = process.env.COPILOT_DB_PATH || path.join(os.homedir(), '.copilot', 'session-store.db');
  try {
    const stat = await fs.stat(dbPath);
    if (copilotSessionsCache && copilotSessionsCache.mtime === stat.mtimeMs) {
      return copilotSessionsCache.cwds;
    }
    const copilotDb = await openCopilotDb();
    if (!copilotDb) return [];
    try {
      const rows = copilotDb.prepare<CopilotCwdRow>('SELECT cwd FROM sessions').all();
      const cwds = rows.map((r) => r.cwd).filter((c): c is string => typeof c === 'string');
      copilotSessionsCache = { mtime: stat.mtimeMs, cwds };
      return cwds;
    } finally {
      try { copilotDb.close(); } catch {}
    }
  } catch {
    copilotSessionsCache = null;
    return [];
  }
}

/** Returns the cwd recorded by a rollout's session_meta record, if any. */
async function readCodexRolloutCwd(file: string): Promise<string | null> {
  const header = await codexSessionHeader(file);
  if (header?.type === 'session_meta' && typeof header.payload?.cwd === 'string') {
    return header.payload.cwd;
  }
  const content = await fs.readFile(file, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === 'session_meta' && typeof record.payload?.cwd === 'string') {
        return record.payload.cwd;
      }
    } catch {}
  }
  return null;
}

// The status overview checks up to 24 workspaces at once. Without sharing,
// each check scanned every rollout header before any of them filled the
// cache: 600 MiB of reads for one page at tier L. Callers that arrive while a
// scan is running share it.
let codexCwdsInFlight: { codexHome: string; result: Promise<string[]> } | null = null;

function getCodexCwds(codexHome: string): Promise<string[]> {
  if (codexCwdsInFlight?.codexHome === codexHome) return codexCwdsInFlight.result;
  const result = scanCodexCwds(codexHome).finally(() => {
    if (codexCwdsInFlight?.result === result) codexCwdsInFlight = null;
  });
  codexCwdsInFlight = { codexHome, result };
  return result;
}

async function scanCodexCwds(codexHome: string): Promise<string[]> {
  // Codex writes rollouts into nested YYYY/MM/DD folders, so the sessions
  // root's mtime does not change when a session starts. List the tree on
  // every call and cache per file instead.
  const codexFiles = await getFilesRecursively(path.join(codexHome, 'sessions'), '.jsonl');
  const MAX_CODEX_SCAN = 100;
  const filesToScan = [...codexFiles].sort((a, b) => b.localeCompare(a)).slice(0, MAX_CODEX_SCAN);
  const cwds: string[] = [];
  for (const file of filesToScan) {
    try {
      const cached = codexCwdCache.get(file);
      if (cached?.cwd) {
        cwds.push(cached.cwd);
        continue;
      }
      const stat = await fs.stat(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
      const cwd = await readCodexRolloutCwd(file);
      codexCwdCache.set(file, { cwd, mtimeMs: stat.mtimeMs, size: stat.size });
      if (cwd) cwds.push(cwd);
    } catch {}
  }
  // The session list shares this map for a wider window; forget only deleted rollouts.
  const listed = new Set(codexFiles);
  for (const file of codexCwdCache.keys()) if (!listed.has(file)) codexCwdCache.delete(file);
  return cwds;
}

/**
 * Quickly checks which AI assistants have active/recorded sessions for a given workspace.
 * Uses mtime-checked metadata caching and early exit to ensure sub-millisecond execution.
 *
 * @param workspacePath - Root directory of the active workspace.
 * @param repoPaths - Directories of sub-repositories included in the workspace.
 * @returns A promise that resolves to an array of unique session assistant names.
 */
export async function findActiveAssistants(
  workspacePath: string,
  repoPaths: string[] = []
): Promise<SessionAssistant[]> {
  const active = new Set<SessionAssistant>();
  const wsFolderName = path.basename(workspacePath);

  const cleanPath = (p: string) => {
    const resolved = path.resolve(p).replace(/[/\\]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const normWorkspace = cleanPath(workspacePath);
  const normRepos = repoPaths.map(cleanPath);
  const sep = path.sep;

  const isPathMatch = (sessPath?: string) => {
    if (!sessPath) return false;
    const normSess = cleanPath(sessPath);
    if (normSess === normWorkspace || normSess.startsWith(normWorkspace + sep)) return true;
    for (const r of normRepos) {
      if (normSess === r || normSess.startsWith(r + sep)) return true;
    }
    return false;
  };

  // 1. Antigravity Sessions (cached with mtime check)
  const agWorkspaces = await getAntigravityWorkspaces(getAntigravityDir());
  if (agWorkspaces.some(isPathMatch)) {
    active.add('antigravity');
  }

  // 2. Claude Code Sessions (direct folder exists & non-empty check)
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const claudeProjectsDir = path.join(claudeConfigDir, 'projects');
  const candidateFolders = [
    getClaudeProjectFolderName(workspacePath),
    ...repoPaths.map((r) => getClaudeProjectFolderName(r)),
  ];
  for (const folder of candidateFolders) {
    const projectPath = path.join(claudeProjectsDir, folder);
    try {
      const files = await fs.readdir(projectPath);
      if (files.some((f) => f.endsWith('.jsonl'))) {
        active.add('claude');
        break;
      }
    } catch {}
  }

  // 3. OpenAI Codex Sessions (cached with mtime check)
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexCwds = await getCodexCwds(codexHome);
  if (codexCwds.some((cwd) => isPathMatch(cwd) || cwd.includes(wsFolderName))) {
    active.add('codex');
  }

  // 4. GitHub Copilot Sessions (cached with mtime check)
  const copilotCwds = await getCopilotCwds();
  if (copilotCwds.some(isPathMatch)) {
    active.add('copilot');
  }

  for (const [id, reader] of Object.entries(MODULAR_SESSION_READERS)) {
    if (await reader.hasAny({ roots: [workspacePath, ...repoPaths], matchesCwd: isPathMatch })) active.add(id as SessionAssistant);
  }

  return Array.from(active);
}

/**
 * Reads and parses the full transcript for a specific assistant conversation session.
 *
 * @param assistant - The name of the AI assistant ('antigravity', 'claude', 'codex', 'copilot', 'pi').
 * @param sessionId - Unique ID of the conversation session.
 * @returns A promise that resolves to an array of {@link ChatMessage} objects.
 */
export async function getSessionTranscript(assistant: string, sessionId: string): Promise<ChatMessage[]> {
  assertSafeSessionId(assistant, sessionId);
  const messages: ChatMessage[] = [];

  const modularReader = modularSessionReader(assistant);
  if (modularReader) {
    messages.push(...await modularReader.transcript(sessionId));
  } else if (assistant === 'antigravity') {
    const agDir = getAntigravityDir();
    const transcriptPath = path.join(agDir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'USER_INPUT') {
          const rawContent = obj.content || '';
          const cleanMatch = typeof rawContent === 'string' ? rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/) : null;
          const cleanContent = cleanMatch ? cleanMatch[1].trim() : (typeof rawContent === 'string' ? rawContent.trim() : '');
          if (cleanContent) {
            messages.push({
              role: 'user',
              content: cleanContent,
              timestamp: obj.created_at || obj.timestamp,
            });
          }
        } else if (obj.type === 'PLANNER_RESPONSE') {
          const content = (typeof obj.content === 'string' ? obj.content : '').trim();
          if (content) {
            const { usage } = extractRecordUsage(obj);
            messages.push({
              role: 'assistant',
              content,
              timestamp: obj.created_at || obj.timestamp,
              ...(usage ? { usage } : {}),
            });
          }
        }
      } catch {}
    }
  } else if (assistant === 'claude') {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const claudeProjectsDir = path.join(claudeConfigDir, 'projects');
    const projectFolders = await fs.readdir(claudeProjectsDir).catch(() => [] as string[]);
    let transcriptPath: string | null = null;

    for (const folder of projectFolders) {
      const p = path.join(claudeProjectsDir, folder, `${sessionId}.jsonl`);
      try {
        await fs.access(p);
        transcriptPath = p;
        break;
      } catch {}
    }

    if (!transcriptPath) {
      throw new Error(`Claude session ${sessionId} not found`);
    }

    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const isUser = record.type === 'user' || record.role === 'user';
      const isAssistant = record.type === 'assistant' || record.role === 'assistant';
      if (!isUser && !isAssistant) continue;

      const cleanText = claudeRecordText(record).trim();
      // Drop CLI-injected caveats/slash-commands/tool-results and empty turns.
      if (isUser && isNoiseUserRecord(record, cleanText)) continue;
      if (!cleanText) continue;

      if (isUser) {
        messages.push({
          role: 'user',
          content: cleanText,
          timestamp: record.timestamp || record.created_at,
        });
      } else {
        const { usage } = extractRecordUsage(record);
        messages.push({
          role: 'assistant',
          content: cleanText,
          timestamp: record.timestamp || record.created_at,
          ...(usage ? { usage } : {}),
        });
      }
    }
  } else if (assistant === 'codex') {
    if (!isCodexSessionId(sessionId)) {
      throw new Error('Invalid Codex session id');
    }
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const codexSessionsDir = path.join(codexHome, 'sessions');
    const codexFiles = await getFilesRecursively(codexSessionsDir, '.jsonl');
    let transcriptPath: string | null = null;

    // Filename matches are checked first for speed, but metadata is always the
    // authority; a suffix collision or renamed rollout must never select a
    // different thread.
    const candidates = [...codexFiles].sort((a, b) => {
      const aMatch = path.basename(a, '.jsonl').endsWith(sessionId) ? 0 : 1;
      const bMatch = path.basename(b, '.jsonl').endsWith(sessionId) ? 0 : 1;
      return aMatch - bMatch;
    });
    for (const file of candidates) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const found = content
          .split('\n')
          .filter(Boolean)
          .some((line) => {
            try { return codexSessionId(JSON.parse(line)) === sessionId; } catch { return false; }
          });
        if (found) {
          transcriptPath = file;
          break;
        }
      } catch {
        // Ignore unreadable or concurrently-rotated rollout files.
      }
    }

    if (!transcriptPath) {
      throw new Error(`Codex session ${sessionId} not found`);
    }

    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'response_item' || record.payload?.type !== 'message') continue;
      const role = record.payload.role;
      if (role === 'user' || role === 'assistant') {
        const text = codexMessageText(record.payload).trim();
        if (role === 'user' && isInjectedContextText(text)) continue;
        if (!text) continue;
        const ts = record.timestamp || record.payload?.timestamp;
        const { usage } = extractRecordUsage(record);
        messages.push({
          role: role as 'user' | 'assistant',
          content: text,
          timestamp: ts ? new Date(ts).toISOString() : undefined,
          ...(role === 'assistant' && usage ? { usage } : {}),
        });
      }
    }
  } else if (assistant === 'copilot') {
    const copilotDb = await openCopilotDb();
    if (!copilotDb) {
      throw new Error('Copilot session store is unavailable in this runtime.');
    }
    try {
      const turns = copilotDb.prepare<CopilotTranscriptTurnRow>(
        'SELECT user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index'
      ).all(sessionId);
      for (const t of turns) {
        const user = (t.user_message || '').trim();
        const assistantText = (t.assistant_response || '').trim();
        const ts = t.timestamp ? String(t.timestamp) : undefined;
        // Skip Copilot's injected <system_reminder> pseudo-turns.
        if (user && !isInjectedContextText(user)) {
          messages.push({ role: 'user', content: user, timestamp: ts });
        }
        if (assistantText) messages.push({ role: 'assistant', content: assistantText, timestamp: ts });
      }
    } finally {
      try { copilotDb.close(); } catch {}
    }
  }

  if (messages.length === 0) {
    try {
      const wsSessionsDir = path.join(process.cwd(), '.sessions');
      const sessionFiles = await getFilesRecursively(wsSessionsDir, '.jsonl').catch(() => []);
      const matchFile = sessionFiles.find((f) => path.basename(f, '.jsonl') === sessionId);
      if (matchFile) {
        const content = await fs.readFile(matchFile, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            if (record.userPrompt) {
              messages.push({
                role: 'user',
                content: String(record.userPrompt).trim(),
                timestamp: record.timestamp,
              });
            }
            if (record.assistantResponse) {
              const { usage } = extractRecordUsage(record);
              messages.push({
                role: 'assistant',
                content: String(record.assistantResponse).trim(),
                timestamp: record.timestamp,
                ...(usage ? { usage } : {}),
              });
            }
          } catch {}
        }
      }
    } catch {}
  }

  return messages;
}
