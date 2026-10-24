import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { detectClaudeCliStatus } from "../agent/cliAvailability.js";
import {
  type HarnessAdapter,
  type SessionHandle,
  type SessionSummary,
  AuthRequiredError,
  UnsupportedOperationError,
} from "./interface.js";
import { Pushable } from "./pushable.js";
import type {
  ApprovalDecision,
  AuthStatus,
  HarnessEvent,
  NormalizedRemainingQuota,
  NormalizedUsage,
  PatchKind,
  ResumeSpec,
  SerializedError,
  StartSpec,
  WorkspaceRef,
} from "./types.js";
import { toErrorMessage } from "../utils/errors.js";

interface SDKUserMessage {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string } | string> | string;
  };
  parent_tool_use_id?: string | null;
}

type BaseSpec = Omit<StartSpec, "prompt"> & { prompt?: string };

function safeToIsoString(timestamp: number | undefined): string | undefined {
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

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      message: err.message || "Unknown error",
      name: err.name,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

function extractFileChangedEvent(toolName: string, input: any): HarnessEvent | null {
  const name = toolName.replace(/^(mcp__nexusflow__|nexusflow__)/, "");
  let kind: PatchKind | null = null;
  if (name === "Write" || name === "FileWrite") {
    kind = "write";
  } else if (name === "Edit" || name === "MultiEdit" || name === "FileEdit") {
    kind = "edit";
  }
  if (!kind) return null;

  const paths: string[] = [];
  if (typeof input === "object" && input !== null) {
    if (typeof input.file_path === "string") {
      paths.push(input.file_path);
    } else if (typeof input.path === "string") {
      paths.push(input.path);
    } else if (typeof input.filePath === "string") {
      paths.push(input.filePath);
    }
    if (Array.isArray(input.paths)) {
      for (const p of input.paths) {
        if (typeof p === "string" && !paths.includes(p)) paths.push(p);
      }
    }
    if (Array.isArray(input.files)) {
      for (const f of input.files) {
        const p = typeof f === "string" ? f : f?.path || f?.file_path;
        if (typeof p === "string" && !paths.includes(p)) paths.push(p);
      }
    }
  }

  return {
    type: "file_changed",
    kind,
    paths,
  };
}

function extractClaudeErrorMessage(msg: any, subtype?: string): string {
  if (Array.isArray(msg?.errors) && msg.errors.length > 0) {
    const errorStrings = msg.errors
      .map((e: unknown) => toErrorMessage(e))
      .filter((s: string) => typeof s === "string" && s.trim().length > 0);
    if (errorStrings.length > 0) {
      return errorStrings.join("; ").slice(0, 2000);
    }
  }
  if (typeof msg?.error === "string" && msg.error.trim().length > 0) {
    return msg.error.trim().slice(0, 2000);
  }
  if (typeof msg?.error?.message === "string" && msg.error.message.trim().length > 0) {
    return msg.error.message.trim().slice(0, 2000);
  }
  if (typeof msg?.result === "string" && msg.result.trim().length > 0) {
    return msg.result.trim().slice(0, 2000);
  }
  return subtype ? `claude turn failed: ${subtype}` : "claude turn failed";
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly vendor = "claude-code" as const;
  private readonly queryFn: typeof query;

  constructor(
    private readonly sessionStore?: unknown,
    queryFn?: typeof query,
  ) {
    this.queryFn = queryFn ?? query;
  }

  async start(spec: StartSpec): Promise<SessionHandle> {
    const auth = await this.authStatus(spec.workspace, spec.env);
    if (!auth.configured) {
      throw new AuthRequiredError(this.vendor, auth.message ?? "Authentication required");
    }
    return this.spawn(spec);
  }

  async resume(spec: ResumeSpec): Promise<SessionHandle> {
    const auth = await this.authStatus(spec.workspace, spec.env);
    if (!auth.configured) {
      throw new AuthRequiredError(this.vendor, auth.message ?? "Authentication required");
    }
    return this.spawn(spec, {
      resume: spec.sessionId,
      forkSession: spec.mode === "fork", // audit-preserving retries => mode:"fork"
    });
  }

  async authStatus(_workspace?: WorkspaceRef, env?: Record<string, string>): Promise<AuthStatus> {
    const mergedEnv = env ? { ...process.env, ...env } : process.env;
    const hasApiKey = Boolean(mergedEnv.ANTHROPIC_API_KEY);
    const hasAuthToken = Boolean(mergedEnv.ANTHROPIC_AUTH_TOKEN);
    const hasOAuth = Boolean(mergedEnv.CLAUDE_CODE_OAUTH_TOKEN);
    const hasBedrock =
      mergedEnv.CLAUDE_CODE_USE_BEDROCK === "1" ||
      Boolean(mergedEnv.AWS_ACCESS_KEY_ID);
    const hasVertex =
      mergedEnv.CLAUDE_CODE_USE_VERTEX === "1" ||
      Boolean(mergedEnv.GOOGLE_APPLICATION_CREDENTIALS);
    const hasFoundry = mergedEnv.CLAUDE_CODE_USE_FOUNDRY === "1";

    const hasOtherCredentials = hasOAuth || hasBedrock || hasVertex || hasFoundry;

    // Anthropic documented precedence: API key bills first when both exist
    if (hasApiKey || hasAuthToken) {
      return {
        configured: true,
        method: "api-key",
        hasApiKeyFallback: hasOtherCredentials,
      };
    }
    if (hasOAuth) {
      return {
        configured: true,
        method: "subscription-oauth",
        hasApiKeyFallback: false,
      };
    }
    if (hasBedrock || hasVertex || hasFoundry) {
      return {
        configured: true,
        method: "cloud-gateway",
        hasApiKeyFallback: false,
      };
    }

    const cliStatus = detectClaudeCliStatus({ env: mergedEnv });
    if (cliStatus.usable) {
      return {
        configured: true,
        method: "subscription-oauth",
        hasApiKeyFallback: false,
      };
    }

    return {
      configured: false,
      method: "unauthenticated",
      message:
        cliStatus.message ??
        "No Anthropic API key, Claude Code credentials, or CLI login detected.",
    };
  }

  async listSessions(_workspace: WorkspaceRef): Promise<SessionSummary[]> {
    // Requires CLAUDE_CODE_PROJECT_DIR_NAME=<workspaceId> and CLAUDE_CONFIG_DIR
    // to have been set at session start so projectKey matches across hosts (verified in Spike 2).
    throw new UnsupportedOperationError(
      "claude-code",
      "listSessions",
      "wire to sessionStore-backed listSessions() once store adapter lands",
    );
  }

  // ── internals ──────────────────────────────────────────────────────────

  private spawn(
    spec: BaseSpec,
    overrides: Partial<Options> = {},
  ): SessionHandle {
    const out = new Pushable<HarnessEvent>();
    let disposed = false;
    const approvalTimers = new Map<string, NodeJS.Timeout>();

    const safePush = (ev: HarnessEvent) => {
      if (disposed) return;
      try {
        out.push(ev);
      } catch {
        // Stream ended or disposed concurrently; ignore to prevent unhandled rejections
      }
    };

    // Streaming-input mode: enables multi-turn `send()` without losing the session.
    const userInput = new Pushable<SDKUserMessage>();
    const approvals = new Map<string, (d: ApprovalDecision) => void>();
    const abort = new AbortController();

    let resolveId!: (s: string) => void;
    let rejectId!: (e: Error) => void;
    const sessionIdPromise = new Promise<string>((res, rej) => {
      resolveId = res;
      rejectId = rej;
    });
    // Armor against unhandled rejections if caller never attaches a handler before interrupt/dispose
    sessionIdPromise.catch(() => {});

    abort.signal.addEventListener(
      "abort",
      () => {
        try {
          rejectId(new DOMException("aborted", "AbortError"));
        } catch {}
      },
      { once: true },
    );

    if (spec.prompt !== undefined && spec.prompt.length > 0) {
      try {
        userInput.push({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: spec.prompt }],
          },
          parent_tool_use_id: null,
        });
      } catch {}
    }

    // Approval bridge: canUseTool callback ↔ approval_required event + respondToApproval()
    const canUseTool: CanUseTool = async (_toolName, _input, { signal }) => {
      if (disposed) {
        return { behavior: "deny", message: "Session disposed" };
      }
      const requestId = randomUUID();
      safePush({
        type: "approval_required",
        requestId,
        tool: _toolName as string,
        input: _input,
      });
      // Auto-deny on timeout so handles never hang indefinitely
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          approvalTimers.delete(requestId);
          approvals.delete(requestId);
          resolve({ behavior: "deny", message: "Approval request timed out after 5 minutes" });
        }, 5 * 60 * 1000);

        approvalTimers.set(requestId, timer);

        approvals.set(requestId, (decision: ApprovalDecision) => {
          clearTimeout(timer);
          approvalTimers.delete(requestId);
          approvals.delete(requestId);
          if (decision.behavior === "allow") {
            resolve({
              behavior: "allow",
              updatedInput: decision.updatedInput as Record<string, unknown> | undefined,
            });
          } else {
            resolve({
              behavior: "deny",
              message: decision.message,
            });
          }
        });

        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            approvalTimers.delete(requestId);
            approvals.delete(requestId);
            resolve({ behavior: "deny", message: "interrupted" });
          },
          { once: true },
        );
      });
    };

    void this.pump({
      spec,
      overrides,
      userInput,
      safePush,
      out,
      canUseTool,
      approvals,
      resolveId,
      rejectId,
      abortController: abort,
      isDisposed: () => disposed,
    });

    return {
      vendor: this.vendor,
      sessionId: () => sessionIdPromise,
      events: out,
      send: (prompt) => {
        if (disposed) return;
        try {
          userInput.push({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
            parent_tool_use_id: null,
          });
        } catch {}
      },
      respondToApproval: (requestId, decision) =>
        approvals.get(requestId)?.(decision),
      interrupt: async () => abort.abort(),
      dispose: async () => {
        disposed = true;
        for (const timer of approvalTimers.values()) {
          clearTimeout(timer);
        }
        approvalTimers.clear();
        approvals.clear();
        abort.abort();
        try {
          userInput.end();
        } catch {}
        try {
          out.end();
        } catch {}
      },
    };
  }

  private async pump(args: {
    spec: BaseSpec;
    overrides: Partial<Options>;
    userInput: Pushable<SDKUserMessage>;
    safePush: (ev: HarnessEvent) => void;
    out: Pushable<HarnessEvent>;
    canUseTool: CanUseTool;
    approvals: Map<string, (d: ApprovalDecision) => void>;
    resolveId: (s: string) => void;
    rejectId: (e: Error) => void;
    abortController: AbortController;
    isDisposed: () => boolean;
  }): Promise<void> {
    const { spec, overrides, userInput, safePush, out, canUseTool, abortController, isDisposed } = args;
    try {
      const options: Options = {
        cwd: spec.workspace.rootPath,
        additionalDirectories: spec.workspace.additionalDirectories,
        permissionMode: spec.permissionMode ?? "acceptEdits",
        maxTurns: spec.maxTurns,
        model: spec.model,
        // Spike 1 finding: Agent SDK env REPLACES process.env, so callers must spread parent process.env.
        env: spec.env ? { ...process.env, ...spec.env } : undefined,
        mcpServers: spec.mcpServers,
        canUseTool,
        includePartialMessages: true, // enables stream_event deltas below
        sessionStore: this.sessionStore as any,
        abortController,
        ...overrides,
        // ESCAPE HATCH — deliberately last, wins over everything above.
        ...(spec.nativeOptions as Partial<Options>),
      };

      const queryHandle = this.queryFn({
        prompt: userInput as any,
        options,
      });

      const quotaState: { current?: NormalizedRemainingQuota } = {};
      const messageArgs = { ...args, quotaState };

      for await (const msg of queryHandle) {
        if (isDisposed()) break;
        this.mapMessage(msg, safePush, messageArgs);
      }
    } catch (err) {
      try {
        args.rejectId(err instanceof Error ? err : new Error(String(err)));
      } catch {}
      safePush({ type: "turn_failed", error: serializeError(err), fatal: true });
      try {
        out.end();
      } catch {}
    }
  }

  private mapMessage(
    msg: SDKMessage,
    push: (ev: HarnessEvent) => void,
    args: {
      resolveId: (s: string) => void;
      rejectId: (e: Error) => void;
      spec: BaseSpec;
      quotaState?: { current?: NormalizedRemainingQuota };
    },
  ): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          args.resolveId(msg.session_id);
          push({ type: "session_started", sessionId: msg.session_id });
        } else if (msg.subtype === "api_retry") {
          const attempt = Number.isInteger((msg as any).attempt) ? (msg as any).attempt : null;
          const maxRetries = Number.isInteger((msg as any).max_retries) ? (msg as any).max_retries : null;
          const retryDelayMs = typeof (msg as any).retry_delay_ms === 'number' ? (msg as any).retry_delay_ms : undefined;
          const errorStatus = typeof (msg as any).error_status === 'number' ? (msg as any).error_status : undefined;
          const isRateLimit = errorStatus === 429 || (msg as any).error_type === 'rate_limit';
          if (isRateLimit || retryDelayMs !== undefined) {
            const resetInSeconds = typeof retryDelayMs === 'number' && Number.isFinite(retryDelayMs)
              ? Math.ceil(retryDelayMs / 1000)
              : undefined;
            const resetsAt = typeof retryDelayMs === 'number'
              ? safeToIsoString(Date.now() + retryDelayMs)
              : undefined;
            const quota: NormalizedRemainingQuota = {
              requests: {
                unit: 'requests',
                status: 'approaching_limit',
                resetInSeconds,
                resetsAt,
              },
              warningMessage: attempt !== null && maxRetries !== null
                ? `Rate limit retry attempt ${attempt} of ${maxRetries}`
                : 'Claude request retry in progress',
              isEstimated: true,
            };
            if (args.quotaState) args.quotaState.current = quota;
            push({ type: "quota_updated", quota });
          }
        }
        break;

      case "rate_limit_event" as any: {
        const info = (msg as any).rate_limit_info;
        if (info && typeof info === 'object') {
          const status: 'ok' | 'approaching_limit' | 'exceeded' =
            info.status === 'rejected' ? 'exceeded' :
            info.status === 'allowed_warning' ? 'approaching_limit' : 'ok';
          const resetsAt = typeof info.resetsAt === 'number'
            ? safeToIsoString(info.resetsAt > 1e11 ? info.resetsAt : info.resetsAt * 1000)
            : undefined;
          const utilization = typeof info.utilization === 'number' ? info.utilization : undefined;
          const quota: NormalizedRemainingQuota = {
            requests: utilization !== undefined ? {
              unit: 'percent',
              used: utilization,
              limit: 100,
              remaining: Math.max(0, 100 - utilization),
              resetsAt,
              status,
            } : undefined,
            planType: 'plan-included',
            label: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
            warningMessage: status !== 'ok' ? `Rate limit status: ${info.status}` : undefined,
          };
          if (args.quotaState) args.quotaState.current = quota;
          push({ type: "quota_updated", quota });
        }
        break;
      }

      case "stream_event": {
        // Partial assistant text deltas (requires includePartialMessages).
        const event = (msg as any).event;
        if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta" && event.delta.text) {
          push({ type: "text_delta", text: event.delta.text });
        }
        break;
      }

      case "assistant":
        for (const block of (msg as any).message?.content ?? []) {
          if (block.type === "text") {
            push({ type: "assistant_message", text: block.text });
          } else if (block.type === "tool_use") {
            push({
              type: "tool_requested",
              callId: block.id,
              tool: block.name,
              input: block.input,
            });
            const fileChanged = extractFileChangedEvent(block.name, block.input);
            if (fileChanged) {
              push(fileChanged);
            }
          }
        }
        break;

      case "user": {
        // Tool results arrive as user messages.
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              push({
                type: "tool_completed",
                callId: block.tool_use_id,
                ok: !block.is_error,
              });
            }
          }
        }
        break;
      }

      case "result": {
        if (msg.subtype === "success") {
          push({
            type: "turn_completed",
            usage: this.normalizeUsage((msg as any).usage, (msg as any).total_cost_usd, args.quotaState?.current),
          });
        } else {
          push({
            type: "turn_failed",
            error: { message: extractClaudeErrorMessage(msg, msg.subtype) },
            fatal: msg.subtype === "error_during_execution",
          });
        }
        break;
      }
    }

    if (args.spec.debugMirrorRaw) {
      push({ type: "raw", vendor: "claude-code", payload: msg });
    }
  }

  private normalizeUsage(u: any, costUsdEstimate?: number, quota?: NormalizedRemainingQuota): NormalizedUsage {
    const inputTokens = typeof u?.input_tokens === 'number' ? u.input_tokens : 0;
    const outputTokens = typeof u?.output_tokens === 'number' ? u.output_tokens : 0;
    const cacheRead = typeof u?.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined;
    const cacheWrite = typeof u?.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : undefined;
    const cachedInput = (cacheRead !== undefined || cacheWrite !== undefined)
      ? (cacheRead ?? 0) + (cacheWrite ?? 0)
      : (typeof u?.cached_input_tokens === 'number' ? u.cached_input_tokens : undefined);

    return {
      inputTokens,
      outputTokens,
      cachedInputTokens: cachedInput,
      cacheReadInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
      totalTokens: typeof u?.total_tokens === 'number' ? u.total_tokens : (inputTokens + outputTokens),
      costUsdEstimate,
      costConfidence: costUsdEstimate !== undefined ? 'estimated' : 'absent',
      remainingQuota: quota,
    };
  }
}
