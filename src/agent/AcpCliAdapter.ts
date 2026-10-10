import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { killTree } from './CliAdapterBase.js';
import type { AgentHarness } from './ProviderRegistry.js';
import type { AgentSession } from './session.js';
import type { NormalizedUsage, NormalizedRemainingQuota } from '../harness/types.js';
import { BRAND_NAME } from '../core/constants.js';

export interface AcpConnection {
  initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse>;
  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
  loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse>;
  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse>;
  cancel(params: acp.CancelNotification): Promise<void>;
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

export interface AcpTransport {
  process: ChildProcess;
  connection: AcpConnection;
}

export interface AcpTransportOptions {
  executable: string;
  args: string[];
  cwd: string;
  client: acp.Client;
  /** The AI tool's name, given to it as CTXSPACE_HARNESS so `ctxspace plan` records which tool made a change. */
  harness?: string;
}

export type AcpTransportFactory = (options: AcpTransportOptions) => AcpTransport;

export interface AcpCliAdapterOptions {
  executable: string;
  args: string[];
  label: string;
  harness?: string;
  loginCommand?: string;
  validateSessionId?: (id: string) => boolean;
  transportFactory?: AcpTransportFactory;
}

class FluentAcpConnection implements AcpConnection {
  private readonly connection: acp.ClientConnection;
  public readonly closed: Promise<void>;

  constructor(client: acp.Client, stream: acp.Stream) {
    const app = acp.client({ name: BRAND_NAME })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => (
        client.requestPermission(params)
      ))
      .onNotification(acp.methods.client.session.update, ({ params }) => (
        client.sessionUpdate(params)
      ));

    this.connection = app.connect(stream);
    this.closed = this.connection.closed;
  }

  private async request<Method extends acp.AgentRequestMethod>(
    method: Method,
    params: acp.AgentRequestParamsByMethod[Method],
  ): Promise<acp.AgentRequestResponsesByMethod[Method]> {
    return this.connection.agent.request(method, params);
  }

  public initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return this.request(acp.methods.agent.initialize, params);
  }

  public newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return this.request(acp.methods.agent.session.new, params);
  }

  public loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    return this.request(acp.methods.agent.session.load, params);
  }

  public prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    return this.request(acp.methods.agent.session.prompt, params);
  }

  public async cancel(params: acp.CancelNotification): Promise<void> {
    await this.connection.agent.notify(acp.methods.agent.session.cancel, params);
  }

  public async close(): Promise<void> {
    this.connection.close();
    await this.closed;
  }
}

/** Start an ACP subprocess using NDJSON over stdio and the current fluent SDK. */
export function createAcpTransport(options: AcpTransportOptions): AcpTransport {
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd,
    env: { ...process.env, FORCE_COLOR: '0', ...(options.harness ? { CTXSPACE_HARNESS: options.harness } : {}) },
    detached: process.platform !== 'win32',
    // npm installs expose a .cmd shim on Windows. All argv here is provider
    // configuration; user prompts and session ids travel inside ACP JSON.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.executable),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (!child.stdin || !child.stdout) {
    throw new Error('ACP subprocess did not expose stdin/stdout.');
  }

  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);
  const connection = new FluentAcpConnection(options.client, stream);

  return { process: child, connection };
}

/**
 * NexusFlow's first ACP surface is deliberately read-only. Tool visibility is
 * also restricted by each harness' startup flags, but permission requests are
 * boundary input and must still be checked independently.
 */
export function decideReadOnlyPermission(
  params: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse {
  // `toolCall.kind` is presentation metadata, not an authorization claim.
  // In particular, an outside-workspace path can still be labelled `read`.
  // Normal reads under the session cwd do not need escalation; every request
  // that reaches this callback is therefore rejected fail-closed.
  const option = (['reject_once', 'reject_always'] as acp.PermissionOptionKind[])
    .map((kind) => params.options.find((candidate) => candidate.kind === kind))
    .find(Boolean);

  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** ACP ids are opaque JSON values, but control characters and unbounded input are never accepted. */
export function isSafeAcpSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms.`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function extractAcpUsage(u: acp.Usage): NormalizedUsage {
  const inputTokens = typeof u?.inputTokens === 'number' && Number.isFinite(u.inputTokens) ? u.inputTokens : 0;
  const outputTokens = typeof u?.outputTokens === 'number' && Number.isFinite(u.outputTokens) ? u.outputTokens : 0;
  const cachedRead = typeof u?.cachedReadTokens === 'number' && Number.isFinite(u.cachedReadTokens) ? u.cachedReadTokens : undefined;
  const cachedWrite = typeof u?.cachedWriteTokens === 'number' && Number.isFinite(u.cachedWriteTokens) ? u.cachedWriteTokens : undefined;
  const cachedSum = (cachedRead ?? 0) + (cachedWrite ?? 0);
  const hasCache = cachedRead !== undefined || cachedWrite !== undefined;
  const cachedInputTokens = (hasCache && cachedSum > 0)
    ? cachedSum
    : (cachedRead !== undefined ? cachedRead : undefined);

  const reasoningOutputTokens = typeof u?.thoughtTokens === 'number' && Number.isFinite(u.thoughtTokens)
    ? u.thoughtTokens
    : undefined;
  const totalTokens = typeof u?.totalTokens === 'number' && Number.isFinite(u.totalTokens)
    ? u.totalTokens
    : inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cachedRead !== undefined ? { cacheReadInputTokens: cachedRead } : {}),
    ...(cachedWrite !== undefined ? { cacheWriteInputTokens: cachedWrite } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens,
    costConfidence: 'absent',
  };
}

/**
 * Shared Agent Client Protocol lifecycle for local harnesses.
 *
 * ACP keeps prompts and streamed responses on stdin/stdout as structured
 * messages, avoiding shell quoting differences and providing one transport for
 * multiple harnesses. The subprocess remains alive for the chat session.
 */
export class AcpCliAdapter extends EventEmitter implements AgentHarness {
  private readonly options: AcpCliAdapterOptions;
  private readonly transportFactory: AcpTransportFactory;

  private transport: AcpTransport | null = null;
  private ready: Promise<void> = Promise.resolve();
  private sessionId: string | null = null;
  private processing = false;
  private stopped = false;
  private reportedProcessFailure = false;
  private acceptAgentMessages = false;
  private turnProducedMessage = false;
  private stderrTail = '';
  private readonly pendingPermissions = new Map<string, {
    resolve: (response: acp.RequestPermissionResponse) => void;
    params: acp.RequestPermissionRequest;
  }>();

  constructor(options: AcpCliAdapterOptions) {
    super();
    this.options = options;
    this.transportFactory = options.transportFactory ?? createAcpTransport;
  }

  public async start(cwd: string, session?: AgentSession): Promise<void> {
    this.stopTransport(false);
    this.stopped = false;
    this.processing = false;
    this.reportedProcessFailure = false;
    this.acceptAgentMessages = false;
    this.stderrTail = '';
    this.sessionId = null;
    this.turnProducedMessage = false;

    this.ready = this.connect(cwd, session).catch((error) => {
      if (!this.stopped) this.reportConnectionFailure(error);
    });
    await this.ready;
  }

  private async connect(cwd: string, requestedSession?: AgentSession): Promise<void> {
    const client: acp.Client = {
      requestPermission: async (params) => {
        if (this.listenerCount('approval_request') > 0) {
          return new Promise<acp.RequestPermissionResponse>((resolve) => {
            const requestId = crypto.randomUUID();
            this.pendingPermissions.set(requestId, { resolve, params });
            this.emit('approval_request', {
              requestId,
              tool: params.toolCall?.title || 'ACP action',
              input: params.toolCall?.rawInput ? (params.toolCall.rawInput as Record<string, unknown>) : { options: params.options },
              description: params.toolCall?.kind,
            });
          });
        }
        return decideReadOnlyPermission(params);
      },
      sessionUpdate: async (params) => this.handleSessionUpdate(params),
    };

    const transport = this.transportFactory({
      executable: this.options.executable,
      args: [...this.options.args],
      cwd,
      client,
      ...(this.options.harness ? { harness: this.options.harness } : {}),
    });
    this.transport = transport;
    this.observeProcess(transport.process);

    void transport.connection.closed.catch((error) => {
      if (!this.stopped) this.reportConnectionFailure(error);
    });

    const initialized = await withTimeout(transport.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: BRAND_NAME, version: '2.0.0' },
    }), 10_000, `${this.options.label} ACP initialization`);
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `${this.options.label} negotiated unsupported ACP version ${initialized.protocolVersion}.`,
      );
    }

    if (requestedSession?.resume) {
      if (initialized.agentCapabilities?.loadSession) {
        await withTimeout(transport.connection.loadSession({
          sessionId: requestedSession.id,
          cwd,
          mcpServers: [],
        }), 10_000, `${this.options.label} session resume`);
        this.sessionId = requestedSession.id;
      } else {
        this.emit('system', `${this.options.label} cannot resume this ACP session; starting a new one.`);
      }
    }

    if (!this.sessionId) {
      const created = await withTimeout(
        transport.connection.newSession({ cwd, mcpServers: [] }),
        10_000,
        `${this.options.label} session creation`,
      );
      const validateSessionId = this.options.validateSessionId ?? isSafeAcpSessionId;
      if (!validateSessionId(created.sessionId)) {
        throw new Error(`${this.options.label} returned an invalid session id.`);
      }
      this.sessionId = created.sessionId;
    }

    // session/load replays history by protocol design. The renderer already has
    // its persisted transcript, so only forward chunks from subsequent turns.
    this.acceptAgentMessages = true;
    this.emit('session', this.sessionId);
  }

  private handleSessionUpdate(params: acp.SessionNotification): void {
    const update = params.update;

    if (update.sessionUpdate === 'usage_update') {
      const rawUsed = (update as any).used;
      const rawSize = (update as any).size;
      const used = typeof rawUsed === 'number' && Number.isFinite(rawUsed) ? rawUsed : 0;
      const size = typeof rawSize === 'number' && Number.isFinite(rawSize) ? rawSize : 0;
      const quota: NormalizedRemainingQuota = {
        contextWindow: {
          usedTokens: used,
          maxTokens: size,
          ...(size > 0 && Number.isFinite(used) ? { utilizationPercent: (used / size) * 100 } : {}),
        },
      };
      this.emit('quota', quota);
      return;
    }

    if (
      this.acceptAgentMessages
      && (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk')
      && update.content.type === 'text'
      && update.content.text
    ) {
      this.turnProducedMessage = true;
      this.emit('data', update.content.text);
    }
  }

  public async send(data: string): Promise<void> {
    if (this.processing || this.stopped || !data) return;
    this.processing = true;

    try {
      await this.ready;
      const connection = this.transport?.connection;
      if (!connection || !this.sessionId || this.stopped) return;

      this.turnProducedMessage = false;
      const result = await connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: data }],
      });

      if (result.usage) {
        this.emit('usage', extractAcpUsage(result.usage));
      }

      if (result.stopReason !== 'end_turn' && result.stopReason !== 'cancelled') {
        this.emit('system', `${this.options.label} stopped the turn: ${result.stopReason}.`);
      } else if (result.stopReason === 'end_turn' && !this.turnProducedMessage) {
        this.emit('error', new Error(
          `${this.options.label} ended without a recognizable response. Update the harness and try again.`,
        ));
      }
    } catch (error) {
      if (!this.stopped && !this.reportedProcessFailure) {
        this.emit('error', this.toActionableError(error));
      }
    } finally {
      this.processing = false;
      if (!this.stopped) this.emit('idle');
    }
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    const transport = this.transport;
    const sessionId = this.sessionId;
    this.transport = null;
    this.sessionId = null;
    if (transport) void this.shutdownTransport(transport, this.processing ? sessionId : null);
    this.processing = false;
    this.emit('close', 0);
  }

  private observeProcess(child: ChildProcess): void {
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-2_000);
      console.warn(`[${this.options.label} stderr]`, text.trimEnd());
    });
    child.once('error', (error) => {
      if (!this.stopped) this.reportConnectionFailure(error);
    });
    child.once('close', (code) => {
      if (!this.stopped && !this.reportedProcessFailure) {
        const suffix = this.stderrTail ? `: ${this.stderrTail.trim()}` : '';
        this.reportConnectionFailure(
          new Error(`${this.options.label} ACP process exited with code ${code}${suffix}`),
        );
      }
    });
  }

  private reportConnectionFailure(error: unknown): void {
    if (this.reportedProcessFailure) return;
    this.reportedProcessFailure = true;
    this.emit('error', this.toActionableError(error));
    // An in-flight prompt owns the idle transition in send(). Publishing idle
    // here would let the server admit a second prompt while processing is true.
    if (!this.processing) this.emit('idle');
    this.stopTransport(true);
  }

  private toActionableError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/auth(?:entication)?[_ -]?required|not authenticated|not logged in|unauthorized/i.test(message)) {
      const action = this.options.loginCommand
        ? ` Run \`${this.options.loginCommand}\` in a terminal, then try again.`
        : '';
      return new Error(`${this.options.label} is not signed in.${action}`);
    }
    return new Error(`${this.options.label} failed: ${message}`);
  }

  private stopTransport(kill: boolean): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.clear();
    const child = this.transport?.process ?? null;
    child?.stdin?.end();
    if (kill) killTree(child, { detached: process.platform !== 'win32' });
    this.transport = null;
    this.sessionId = null;
  }

  public respondToApproval(requestId: string, decision: 'allow' | 'deny', _message?: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);

    if (decision === 'allow') {
      const allowOption = (['allow_once', 'allow_always'] as acp.PermissionOptionKind[])
        .map(kind => pending.params.options.find(o => o.kind === kind))
        .find(Boolean);
      if (allowOption) {
        pending.resolve({ outcome: { outcome: 'selected', optionId: allowOption.optionId } });
        this.emit('system', `Approved tool execution.`);
        return;
      }
    }

    const rejectOption = (['reject_once', 'reject_always'] as acp.PermissionOptionKind[])
      .map(kind => pending.params.options.find(o => o.kind === kind))
      .find(Boolean);
    if (rejectOption) {
      pending.resolve({ outcome: { outcome: 'selected', optionId: rejectOption.optionId } });
    } else {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.emit('system', `Denied tool execution.`);
  }

  private async shutdownTransport(transport: AcpTransport, sessionId: string | null): Promise<void> {
    if (sessionId) {
      await Promise.race([
        transport.connection.cancel({ sessionId }).catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
    transport.process.stdin?.end();
    void transport.connection.close().catch(() => {});
    const forceKill = setTimeout(
      () => killTree(transport.process, { detached: process.platform !== 'win32', gracePeriodMs: 250 }),
      500,
    );
    forceKill.unref?.();
  }
}
