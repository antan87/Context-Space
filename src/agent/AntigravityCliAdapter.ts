import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CliAdapterBase } from './CliAdapterBase.js';
import { isValidSessionUuid, type AgentSession } from './session.js';
import type { AgentExecutionProfile } from './ProviderRegistry.js';
import type { NormalizedUsage, NormalizedRemainingQuota } from '../harness/types.js';

export type AntigravityOutputEvent =
  | { type: 'session'; id: string }
  | { type: 'message'; text: string }
  | { type: 'step_update'; message: string }
  | { type: 'quota'; quota: NormalizedRemainingQuota }
  | { type: 'result'; text?: string; usage?: NormalizedUsage }
  | { type: 'error'; message: string; source: 'protocol' | 'provider' };

const MAX_JSONL_RECORD_CHARS = 8 * 1024 * 1024;
const OVERSIZED_RECORD_MESSAGE =
  'Antigravity structured output exceeded the supported record size.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractNormalizedUsage(raw: Record<string, unknown>): NormalizedUsage {
  const inputTokens = typeof raw.input_tokens === 'number'
    ? raw.input_tokens
    : typeof raw.inputTokens === 'number'
    ? raw.inputTokens
    : typeof raw.prompt_tokens === 'number'
    ? raw.prompt_tokens
    : typeof raw.promptTokens === 'number'
    ? raw.promptTokens
    : typeof raw.input_token_count === 'number'
    ? raw.input_token_count
    : 0;

  const outputTokens = typeof raw.output_tokens === 'number'
    ? raw.output_tokens
    : typeof raw.outputTokens === 'number'
    ? raw.outputTokens
    : typeof raw.completion_tokens === 'number'
    ? raw.completion_tokens
    : typeof raw.completionTokens === 'number'
    ? raw.completionTokens
    : typeof raw.output_token_count === 'number'
    ? raw.output_token_count
    : typeof raw.candidates_token_count === 'number'
    ? raw.candidates_token_count
    : 0;

  const cacheRead = typeof raw.cache_read_input_tokens === 'number'
    ? raw.cache_read_input_tokens
    : typeof raw.cacheReadInputTokens === 'number'
    ? raw.cacheReadInputTokens
    : typeof raw.cached_content_token_count === 'number'
    ? raw.cached_content_token_count
    : undefined;

  const cacheCreation = typeof raw.cache_creation_input_tokens === 'number'
    ? raw.cache_creation_input_tokens
    : typeof raw.cache_write_input_tokens === 'number'
    ? raw.cache_write_input_tokens
    : typeof raw.cacheWriteInputTokens === 'number'
    ? raw.cacheWriteInputTokens
    : undefined;

  let cachedInputTokens: number | undefined;
  if (typeof raw.cached_input_tokens === 'number') {
    cachedInputTokens = raw.cached_input_tokens;
  } else if (typeof raw.cachedInputTokens === 'number') {
    cachedInputTokens = raw.cachedInputTokens;
  } else if (typeof raw.cached_tokens === 'number') {
    cachedInputTokens = raw.cached_tokens;
  } else if (cacheRead !== undefined || cacheCreation !== undefined) {
    cachedInputTokens = (cacheRead ?? 0) + (cacheCreation ?? 0);
  } else if (typeof raw.cached_content_token_count === 'number') {
    cachedInputTokens = raw.cached_content_token_count;
  }

  const reasoningOutputTokens = typeof raw.reasoning_output_tokens === 'number'
    ? raw.reasoning_output_tokens
    : typeof raw.reasoningOutputTokens === 'number'
    ? raw.reasoningOutputTokens
    : typeof raw.thinking_tokens === 'number'
    ? raw.thinking_tokens
    : typeof raw.thoughts_token_count === 'number'
    ? raw.thoughts_token_count
    : undefined;

  const totalTokens = typeof raw.total_tokens === 'number'
    ? raw.total_tokens
    : typeof raw.totalTokens === 'number'
    ? raw.totalTokens
    : typeof raw.total_token_count === 'number'
    ? raw.total_token_count
    : (inputTokens + outputTokens);

  const costUsd = typeof raw.cost_usd === 'number'
    ? raw.cost_usd
    : typeof raw.costUsd === 'number'
    ? raw.costUsd
    : typeof raw.total_cost_usd === 'number'
    ? raw.total_cost_usd
    : typeof raw.costUsdEstimate === 'number'
    ? raw.costUsdEstimate
    : undefined;

  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheWriteInputTokens: cacheCreation } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens,
    ...(costUsd !== undefined ? { costUsdEstimate: costUsd } : {}),
    costConfidence: costUsd !== undefined ? 'estimated' : 'absent',
  };
}

export function safeToIsoString(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return undefined;
  }
  if (timestamp < -8.64e15 || timestamp > 8.64e15) {
    return undefined;
  }
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

export function parseAntigravityQuotaError(message: string): NormalizedRemainingQuota | null {
  const isResourceExhausted = /RESOURCE_EXHAUSTED/i.test(message);
  const is429 = /429/.test(message);
  const isRateLimit = isResourceExhausted || is429 || /rate[- ]limit/i.test(message);
  const isQuotaExceeded = /quota exceeded|quota limit|daily quota|credit balance/i.test(message);

  if (!isRateLimit && !isQuotaExceeded) {
    return null;
  }

  const retryMatch = message.match(/retry(?:ing)? after (\d+)(?:\s*(?:s|seconds?|ms))?/i)
    || message.match(/wait (\d+)\s*(?:s|seconds?)/i)
    || message.match(/retry in (\d+)\s*(?:s|seconds?)/i);
  const retrySec = retryMatch ? parseInt(retryMatch[1], 10) : undefined;

  return {
    requests: {
      unit: 'requests',
      remaining: 0,
      status: 'exceeded',
      resetInSeconds: retrySec,
      resetsAt: retrySec !== undefined ? safeToIsoString(Date.now() + retrySec * 1000) : undefined,
    },
    warningMessage: message,
    isEstimated: false,
  };
}

function antigravityFailureMessage(value: Record<string, unknown>): string {
  const errorObj = isRecord(value.error) ? value.error : null;
  const errors = Array.isArray(value.errors)
    ? value.errors.filter((error): error is string => typeof error === 'string' && error.trim().length > 0)
    : [];
  if (errors.length > 0) return errors.join('; ').slice(0, 2_000);
  const candidates = [
    errorObj?.message,
    typeof value.error === 'string' ? value.error : null,
    value.message,
    value.detail,
    value.details,
  ];
  const message = candidates.find((candidate): candidate is string => (
    typeof candidate === 'string' && candidate.trim().length > 0
  ));
  return message?.trim().slice(0, 2_000) ?? 'Antigravity could not complete the turn.';
}

/** Decode one complete record from Antigravity's stream-json output. */
export function decodeAntigravityLine(line: string): AntigravityOutputEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [{
      type: 'error',
      message: 'Antigravity emitted malformed structured output.',
      source: 'protocol',
    }];
  }
  if (!isRecord(value)) {
    return [{
      type: 'error',
      message: 'Antigravity emitted an invalid structured record.',
      source: 'protocol',
    }];
  }

  const rawId = value.conversationId ?? value.conversation_id ?? value.sessionId ?? value.session_id ?? value.id;
  const convId = typeof rawId === 'string' && isValidSessionUuid(rawId) ? rawId : undefined;

  const eventType = typeof value.event === 'string' ? value.event : typeof value.type === 'string' ? value.type : '';

  if (eventType === 'init' || (value.type === 'system' && value.subtype === 'init')) {
    return convId
      ? [{ type: 'session', id: convId }]
      : [{ type: 'error', message: 'Antigravity started without a valid session identity.', source: 'protocol' }];
  }

  if (eventType === 'stream_event') {
    const event = isRecord(value.event) ? value.event : isRecord(value.data) ? value.data : null;
    const delta = event && isRecord(event.delta) ? event.delta : (isRecord(value.delta) ? value.delta : null);
    const text =
      (delta && typeof delta.text === 'string' && delta.text) ||
      (delta && typeof delta.content === 'string' && delta.content) ||
      (event && typeof event.text === 'string' && event.text) ||
      (event && typeof event.content === 'string' && event.content) ||
      (typeof value.text === 'string' && value.text) ||
      (typeof value.content === 'string' && value.content) ||
      null;
    if (text) {
      return [{ type: 'message', text }];
    }
    return [];
  }

  if (eventType === 'message') {
    const text =
      (typeof value.text === 'string' && value.text) ||
      (typeof value.content === 'string' && value.content) ||
      (typeof value.message === 'string' && value.message) ||
      (isRecord(value.delta) && typeof value.delta.text === 'string' && value.delta.text) ||
      null;
    if (text) {
      return [{ type: 'message', text }];
    }
    return [];
  }

  if (eventType === 'step_update' || eventType === 'step') {
    const stepUpdateObj = isRecord(value.step_update) ? value.step_update : isRecord(value.step) ? value.step : null;
    const textDelta = stepUpdateObj && typeof stepUpdateObj.text_delta === 'string' ? stepUpdateObj.text_delta : null;
    if (textDelta) {
      return [{ type: 'message', text: textDelta }];
    }

    const stepMessage =
      (stepUpdateObj && typeof stepUpdateObj.description === 'string' && stepUpdateObj.description) ||
      (stepUpdateObj && typeof stepUpdateObj.status === 'string' && stepUpdateObj.status) ||
      (typeof value.message === 'string' && value.message) ||
      (typeof value.content === 'string' && value.content) ||
      (typeof value.description === 'string' && value.description) ||
      (typeof value.status === 'string' && value.status) ||
      (typeof value.step === 'string' && value.step) ||
      (typeof value.update === 'string' && value.update) ||
      (typeof value.details === 'string' && value.details) ||
      null;
    if (stepMessage) {
      const events: AntigravityOutputEvent[] = [{ type: 'step_update', message: stepMessage }];
      const backoffMatch = stepMessage.match(/backing off for (\d+)\s*(?:s|seconds?)/i)
        || stepMessage.match(/rate[- ]limit.*?(?:wait|retry).*?(\d+)\s*(?:s|seconds?)/i);
      if (backoffMatch) {
        const sec = parseInt(backoffMatch[1], 10);
        events.push({
          type: 'quota',
          quota: {
            requests: {
              unit: 'requests',
              status: 'approaching_limit',
              resetInSeconds: sec,
              resetsAt: safeToIsoString(Date.now() + sec * 1000),
            },
            warningMessage: stepMessage,
            isEstimated: true,
          },
        });
      }
      return events;
    }
    return [];
  }

  if (eventType === 'result') {
    const events: AntigravityOutputEvent[] = [];
    const resultObj = isRecord(value.result) ? value.result : null;
    const resultConvId = resultObj && typeof resultObj.conversation_id === 'string' && isValidSessionUuid(resultObj.conversation_id)
      ? resultObj.conversation_id
      : convId;

    if (resultConvId) {
      events.push({ type: 'session', id: resultConvId });
    }
    const isError = value.is_error === true
      || value.subtype === 'error'
      || value.status === 'error'
      || (resultObj && (resultObj.status === 'ERROR' || resultObj.is_error === true));

    if (!isError) {
      let usage: NormalizedUsage | undefined;
      const rawUsage = isRecord(value.usage)
        ? value.usage
        : (resultObj && isRecord(resultObj.usage) ? resultObj.usage : (isRecord(value.stats) ? value.stats : null));
      if (rawUsage) {
        usage = extractNormalizedUsage(rawUsage);
      }
      const text = (resultObj && typeof resultObj.response === 'string' ? resultObj.response : null)
        ?? (typeof value.result === 'string' ? value.result : null)
        ?? (typeof value.text === 'string' ? value.text : null)
        ?? (typeof value.response === 'string' ? value.response : null)
        ?? undefined;
      events.push({ type: 'result', text, usage });
    } else {
      const errMsg = (resultObj && typeof resultObj.error === 'string' ? resultObj.error : null) || antigravityFailureMessage(value);
      const quota = parseAntigravityQuotaError(errMsg);
      if (quota) {
        events.push({ type: 'quota', quota });
      }
      events.push({
        type: 'error',
        message: errMsg,
        source: 'provider',
      });
    }
    return events;
  }

  if (eventType === 'error') {
    const errMsg = antigravityFailureMessage(value);
    const events: AntigravityOutputEvent[] = [];
    const quota = parseAntigravityQuotaError(errMsg);
    if (quota) {
      events.push({ type: 'quota', quota });
    }
    events.push({
      type: 'error',
      message: errMsg,
      source: 'provider',
    });
    return events;
  }

  return [];
}

/** Incrementally decode Antigravity's newline-delimited JSON output. */
export class AntigravityJsonlDecoder {
  private buffer = '';
  private failed = false;

  public constructor(private readonly maxRecordChars = MAX_JSONL_RECORD_CHARS) {}

  push(chunk: string): AntigravityOutputEvent[] {
    if (this.failed) return [];
    this.buffer += chunk;
    const events: AntigravityOutputEvent[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      if (newline > this.maxRecordChars) return this.failOversizedRecord();
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) events.push(...decodeAntigravityLine(line));
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.maxRecordChars) return this.failOversizedRecord();
    return events;
  }

  finish(): AntigravityOutputEvent[] {
    if (this.failed) return [];
    if (this.buffer.length > this.maxRecordChars) return this.failOversizedRecord();
    const line = this.buffer.trim();
    this.buffer = '';
    return line ? decodeAntigravityLine(line) : [];
  }

  private failOversizedRecord(): AntigravityOutputEvent[] {
    this.failed = true;
    this.buffer = '';
    return [{ type: 'error', message: OVERSIZED_RECORD_MESSAGE, source: 'protocol' }];
  }
}

export function getAntigravityHistoryPath(): string {
  const agDir = process.env.ANTIGRAVITY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
  return path.join(agDir, 'history.jsonl');
}

/**
 * Searches Antigravity's history.jsonl for the newest session matching cwd and started at or after turnStartTime.
 */
export function findAntigravitySessionIdForWorkspace(
  cwd: string,
  sinceEpochMs: number,
  historyPath = getAntigravityHistoryPath(),
): string | null {
  try {
    if (!fs.existsSync(historyPath)) return null;
    const content = fs.readFileSync(historyPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const normalize = (p: string) => path.normalize(p).toLowerCase();
    const normCwd = normalize(cwd);

    // Scan backwards from newest entry
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!entry.conversationId || !isValidSessionUuid(entry.conversationId)) continue;
        if (!entry.workspace) continue;
        const normEntryWs = normalize(entry.workspace);
        const matchesWs =
          normEntryWs === normCwd ||
          normEntryWs.startsWith(normCwd + path.sep) ||
          normCwd.startsWith(normEntryWs + path.sep);
        if (!matchesWs) continue;

        const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : new Date(entry.timestamp).getTime();
        if (!Number.isNaN(timestamp) && timestamp >= sinceEpochMs - 10000) {
          return entry.conversationId;
        }
      } catch {}
    }
  } catch {}
  return null;
}

export function buildAntigravityTurnArgs(
  isFirstTurn: boolean,
  prompt: string,
  session?: AgentSession,
  executionProfile: AgentExecutionProfile = 'review',
  cwd?: string,
): string[] {
  const args: string[] = ['--output-format', 'stream-json'];

  if (cwd) {
    args.push('--add-dir', cwd);
  }

  // --conversation only loads an existing provider-owned conversation. It is
  // not a caller-assigned session id, so a new chat must let agy create one.
  if (session?.resume) {
    args.push('--conversation', session.id);
  } else if (!isFirstTurn) {
    args.push('-c');
  }

  // Never inherit agy's persisted global mode. The profile selected for this
  // turn is the authority for whether the harness may edit the workspace.
  if (executionProfile === 'workspace-write') {
    args.push('--mode', 'accept-edits', '--dangerously-skip-permissions');
  } else {
    args.push('--mode', 'plan');
  }

  if (session?.model) {
    args.push('--model', session.model);
  }

  if (session?.effort) {
    args.push('--effort', session.effort);
  }

  args.push('-p', prompt);
  return args;
}

export class AntigravityCliAdapter extends CliAdapterBase {
  protected readonly binary = 'agy';
  protected readonly label = 'agy CLI';
  protected override readonly harness = 'antigravity';
  protected readonly useShell = false;
  protected readonly promptViaStdin = false;
  protected readonly advanceFirstTurnOnDispatch = false;

  private session?: AgentSession;
  private turnStartTime: number = 0;
  private decoder = new AntigravityJsonlDecoder();
  private sawTextDelta = false;
  private sawTurnOutcome = false;
  private acknowledgedThisTurn = false;
  private turnFinished = false;

  public async start(cwd: string, session?: AgentSession): Promise<void> {
    await super.start(cwd);
    this.session = session;
    this.turnStartTime = 0;
    this.decoder = new AntigravityJsonlDecoder();
    this.sawTextDelta = false;
    this.sawTurnOutcome = false;
    this.acknowledgedThisTurn = Boolean(session?.id && session.resume);
    this.turnFinished = false;
  }

  public override async send(data: string, executionProfile?: AgentExecutionProfile): Promise<void> {
    this.turnStartTime = Date.now();
    return super.send(data, executionProfile);
  }

  protected buildArgs(
    isFirstTurn: boolean,
    prompt: string,
    executionProfile: AgentExecutionProfile = 'review',
  ): string[] {
    this.decoder = new AntigravityJsonlDecoder();
    this.sawTextDelta = false;
    this.sawTurnOutcome = false;
    this.acknowledgedThisTurn = Boolean(this.session?.id && this.session.resume);
    this.turnFinished = false;
    return buildAntigravityTurnArgs(isFirstTurn, prompt, this.session, executionProfile, this.cwd);
  }

  protected override handleStdout(text: string): boolean {
    return this.emitDecoded(this.decoder.push(text));
  }

  protected override finishStdout(exitCode: number | null): boolean {
    const handled = this.emitDecoded(this.decoder.finish());

    if (!this.session?.id || !this.session.resume) {
      const capturedId = findAntigravitySessionIdForWorkspace(this.cwd, this.turnStartTime);
      if (capturedId) {
        this.session = { ...this.session, id: capturedId, resume: true };
        this.acknowledgedThisTurn = true;
        this.acknowledgeFirstTurn();
        this.emit('session', capturedId);
      }
    }

    if (!this.sawTurnOutcome && exitCode === 0 && (this.sawTextDelta || this.acknowledgedThisTurn)) {
      this.sawTurnOutcome = true;
      return true;
    }

    if (!this.sawTurnOutcome && exitCode === 0) {
      this.sawTurnOutcome = true;
      this.failCurrentTurn(new Error(
        'Antigravity CLI ended without a recognized result. Update Antigravity and try again; its structured output may be incompatible with this NexusFlow version.',
      ));
      return true;
    }

    return handled;
  }

  private emitDecoded(events: AntigravityOutputEvent[]): boolean {
    let handledOutcome = false;
    for (const event of events) {
      if (this.turnFinished) break;

      if (event.type === 'session') {
        const expectedId = this.session?.id;
        const matchesExpectedId = expectedId === undefined
          || !this.session?.resume
          || event.id.toLowerCase() === expectedId.toLowerCase();

        if (!isValidSessionUuid(event.id) || !matchesExpectedId) {
          const wasAcknowledged = this.acknowledgedThisTurn;
          this.turnFinished = true;
          this.sawTurnOutcome = true;
          handledOutcome = true;
          this.failCurrentTurn(new Error(
            wasAcknowledged
              ? 'Antigravity returned a conflicting session identity. The unexpected identity was rejected; the acknowledged session remains resumable.'
              : 'Antigravity returned an unexpected session identity. The turn was not marked resumable.',
          ), true);
          continue;
        }

        if (!this.acknowledgedThisTurn || this.session?.id !== event.id) {
          this.acknowledgedThisTurn = true;
          this.acknowledgeFirstTurn();
          this.session = { ...this.session, id: expectedId ?? event.id, resume: true };
          this.emit('session', expectedId ?? event.id);
        }
      } else if (event.type === 'message') {
        this.sawTextDelta = true;
        this.emit('data', event.text);
      } else if (event.type === 'step_update') {
        this.emit('system', event.message);
      } else if (event.type === 'quota') {
        this.emit('quota', event.quota);
      } else if (event.type === 'result') {
        this.turnFinished = true;
        this.sawTurnOutcome = true;
        handledOutcome = true;

        if (event.usage) {
          this.emit('usage', event.usage);
        }

        if (!this.sawTextDelta && event.text) {
          this.emit('data', event.text);
        }
      } else if (event.type === 'error') {
        this.turnFinished = true;
        this.sawTurnOutcome = true;
        handledOutcome = true;
        const message = event.source === 'protocol'
          ? `${event.message} ${this.acknowledgedThisTurn
            ? 'The acknowledged session remains resumable.'
            : 'The turn was not marked resumable.'}`
          : event.message;
        this.failCurrentTurn(new Error(message), true);
      }
    }
    return handledOutcome;
  }
}
