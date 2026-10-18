# Workspace Knowledge — sdk_claude_codex

> Accumulated decisions and gotchas for this feature. Append with
> `ctxspace knowledge add -t decision|gotcha -m "..."`, which creates the
> section it needs.

## Feature Goal

Improve compatibility with Codex SDK (`@openai/codex-sdk`) and Claude Agent SDK (`@anthropic-ai/claude-agent-sdk >= 0.3.234`), moving from CLI scraping to programmable first-party SDK integrations, native session resumption, MCP server exposure, and normalized harness adapters.

## Decisions

### Decision: Lazy Session Upsert on Claude Init Message
`session_id` in `@anthropic-ai/claude-agent-sdk` is only emitted mid-stream on the first `SystemMessage` (`type === "system" && subtype === "init"`) and on `ResultMessage`s. ContextSpace must create or upsert the DB session record lazily upon receiving this event rather than prior to spawning the query.

### Decision: CWD-Decoupled SessionStore Keying
`sessionStore` keys by `projectKey` derived from working directory. For multi-host/ephemeral workspaces, pass `CLAUDE_CODE_PROJECT_DIR_NAME: workspaceId` (and `CLAUDE_CONFIG_DIR`) in the query's `env` (requires Agent SDK >= 0.3.234) and key database records by `(workspaceId, sessionId)`.

### Decision: Full Transition to SessionStore APIs
Eliminate local `~/.claude/projects/` JSONL transcript scraping. All session queries (`listSessions`, `getSessionInfo`, `getSessionMessages`, `renameSession`, `tagSession`, `deleteSession`, `forkSession`, `listSubagents`, `getSubagentMessages`) must go through `sessionStore`. Provide `InMemorySessionStore` in development and Postgres/S3 in production.

### Decision: Early Usage Event Schema Normalization
Capture `turn.completed` usage (`event.usage`) on Codex and ResultMessage usage on Claude during Phase 1 schema design. Capturing and normalizing usage metrics early avoids costly database/schema retrofits when building usage reporting in Phase 3.

### Decision: Scoped Tool Surface for ContextSpace MCP Server
In Phase 2, ContextSpace's MCP server enforces role-based tool allow/deny lists (`readonly`, `review`, `ci`, `developer`, `interactive`, `full`). `ctxspace mcp run` accepts `-r, --role <role>`, `--allow`, and `--deny` flags so spawned servers strictly filter tool capabilities.

### Decision: Fail-Closed Trust Boundary for Embedded-Chat MCP Tool Approvals
In embedded-chat SDK sessions under `workspace-write`, only core file tools and read-only MCP coordination tools (`list_*`, `get_*`, `search_*`, `workspace_status`, `run_doctor`, `add_knowledge`, `promote_knowledge`, `refresh_context`) are auto-accepted. Mutating lifecycle tools (`create_workspace`, `commit_workspace`, `finish_workspace`, `isolate_repo`, `sync_workspace`) fail closed and deny with explicit guidance pointing to CLI/dashboard until interactive dashboard approval routing is implemented. Blanket namespace prefix matching is prohibited.

### Decision: In-Workspace Knowledge & Context Tool Auto-Acceptance
`add_knowledge`, `promote_knowledge`, and `refresh_context` mutate local workspace files (`nexusflow-knowledge.md` and context summaries). Because these operations are strictly in-workspace metadata updates and do not affect git remotes or external environments, they are classified alongside file edits in the `workspace-write` auto-accepted set rather than lifecycle-mutation tools.

### Decision: Pinned Local CLI Entrypoint for Harness MCP Servers
To eliminate supply-chain risk and version drift from unpinned `npx` execution against npm, harness adapters resolve the local built binary (`dist/index.js`) and spawn via `process.execPath` directly.

### Decision: Pull HarnessAdapter Forward to Phase 1 with Typed Escape Hatch
Define the normalized `HarnessAdapter` interface, session/thread abstractions, event stream unions, and token usage schemas in Phase 1 rather than deferring to Phase 3. Implement both Claude and Codex SDKs behind this interface from day one. Include a typed pass-through escape hatch (`nativeOptions?: unknown`) on the adapter interface to ensure vendor-specific features or monthly SDK changes can be used without waiting on abstraction updates.

### Decision: Orphaned Session Startup Sweep
On backend service initialization, execute a reconciliation sweep that identifies database sessions marked in a "running" state without an active process/worker, marking them as interrupted/stale and exposing a one-click resume option in the UI.

### Decision: Concurrent Mutation Lock & Worktree Isolation Policy
To prevent two agents in the same workspace from conflicting during file edits, enforce per-workspace file locks for single-worktree sessions and mandate separate git worktrees/branches for concurrent multi-agent workflows.

### Decision: SessionStore Fail-Fast on Write Errors
If a database/remote-backed `sessionStore` encounters write errors during a turn, fail the turn immediately with an explicit error rather than silently falling back to unbuffered local storage, preventing divergence between stored transcripts and runtime state.

### Decision: Multi-Agent Subagent Asymmetry & Orchestration Pattern
In Phase 3 multi-agent workflows, Claude Agent SDK supports first-class programmatic subagents (`define agents`, inspectable via `listSubagents()` and `getSubagentMessages()` in `sessionStore`). Codex SDK lacks first-class subagent primitives, so multi-agent orchestration for Codex is handled via NexusFlow-managed thread fan-out (`MultiAgentOrchestrator`) running distinct worker threads with independent session/thread IDs.

### Decision: Workspace Mutation Lock & Worktree Isolation for Concurrent Multi-Agent Workflows
When $\ge 2$ agents execute concurrently within the same workspace root without separate worktrees, `MultiAgentOrchestrator` acquires a workspace-level mutation lock (`.nexusflow-mutation.lock` via `acquireLock`) to serialize file operations and prevent clobbering. For parallel independent file edits, agents must be targeted to distinct git worktrees/branches (the caller's contract).

### Decision: Lock Heartbeat & Process-Liveness Check
To prevent long agent turns (>10s to minutes) from having their locks stolen by concurrent runs, `acquireLock` automatically heartbeats the lock file's `mtime` while held. In addition, lock staleness reclamation inspects the owner PID (`process.kill(pid, 0)`) to reclaim abandoned locks immediately upon process death without waiting for `staleMs`.

### Decision: Teamwork Pipeline Mode & Context Threading
In addition to parallel execution, `MultiAgentOrchestrator` supports sequential pipeline mode (`mode: 'pipeline'`) for dependent workflows (e.g. Plan -> Implement -> Review). In pipeline mode, downstream phases automatically receive the accumulated text outputs of prior phases (`## Context from Prior Phases:`) unless explicitly opted out (`includePriorContext: false`). If an upstream phase fails or is cancelled, downstream phases are skipped fail-fast. `TeamworkResult` reports `success: boolean`, `partialSuccess: boolean`, and `failureReason?: string`.

### Decision: Output Capping & Truncation in Multi-Agent Pipelines
`MultiAgentOrchestrator` caps accumulated stream output per agent at 16KB (`MAX_OUTPUT_CAPTURE_CHARS = 16_000`) using `appendCappedOutput()` and inserts a `[... prior output truncated ...]` marker if the cap is exceeded. This prevents unbounded memory accumulation and saves context window space from being spent on raw tool output when threading results across pipeline phases.

### Decision: Model Selection Plumbing & Chat UI Picker
Model selection is plumbed end-to-end:
1. **Provider-Owned Catalog**: `src/agent/models.ts` supplies model metadata through `ProviderStatus` for each CLI/SDK pair. The renderer has no duplicate catalog and reconciles stale persisted selections against the status response.
2. **Adapter & Engine Propagation**: `AgentSession.model` flows through `ClaudeSdkAdapter` / `CodexSdkAdapter` down to `StartSpec.model` into vendor engine options. Claude uses `query({ options: { model } })`; Codex applies `model` as a thread option on both `startThread` and `resumeThread`, never as a per-turn stream option.
3. **Frontend UX**: The chat UI provides a per-provider model picker in the composer control bar, reflects the active model in the header status badge, stores preferences in `ChatStore.modelsByProvider`, and routes choices via `ChatLaunchIntent.model` and WebSocket `startPayload.model`.
4. **Rejection UX**: The WebSocket boundary rejects model IDs absent from the selected provider's advertised catalog before adapter creation and returns remediation copy directing the user to a valid model or Automatic.

### Decision: Cross-Engine Chat Smoke Suite
The scripted cross-engine smoke suite (`scripts/smoke-chat-engines.ts` / `src/agent/smoke-chat.test.ts`) is explicitly a mocked contract smoke, not live vendor validation. It verifies:
- Provider-owned catalog shape and CLI/SDK parity by reading `ProviderStatus`, without hardcoded model IDs.
- Claude SDK model choice, approval gating (denial of mutating lifecycle tools with guidance copy), and usage extraction.
- Codex SDK model override pass-through and usage frame emission.
- Invalid-model rejection error frame surfacing.

### Decision: Embedded Harness Chat General Availability
The mounted **AI & Sessions** chat surface is generally available as of merge `c4e0384`. Promotion evidence includes protected cross-platform CI, fixed-SHA independent review, a live Codex SDK turn with `gpt-5.6-luna`, and provider-boundary rejection copy. A Claude live smoke remains a non-blocking follow-up for the next authenticated Claude session because aliases are vendor-owned and failures remain closed and actionable.

_Superseded: the built-in chat surface was removed. The CLI chat in the terminal sessions is the product's chat._

### Gotcha: Inter-Agent Context Injection & Trust Domain Boundary
In pipeline mode, upstream phase output is threaded verbatim into downstream prompts (`## Context from Prior Phases:`). In today's architecture, all pipeline agents operate within a single trusted workspace domain. However, if teamwork workflows are extended across different trust profiles or accept untrusted inputs, unvalidated upstream text acts as an inter-agent prompt-injection channel and must be strictly sanitized or distilled.

### Gotcha: TOCTOU Race Condition Mitigation in Lock Staleness Checks
To prevent time-of-check to time-of-use (TOCTOU) races where a lock file is deleted or modified concurrently during staleness inspection, `clearStaleLock` opens the file descriptor directly (`fs.open('r')`) and performs `fstat` and `read` on the open descriptor, safely ignoring `ENOENT` if the file vanished.

### Gotcha: PID Liveness Same-Host Boundary & Staleness Backstop
Lock PID liveness checks (`process.kill(pid, 0)`) operate on the local OS process table. On distributed / shared network filesystems (NFS, SMB) or when PID numbers are recycled, the `staleMs` expiration acts as the authoritative backstop.

### Gotcha: Adapter-Contract Unit Tests vs Process Termination
Contract tests in `src/harness/contract.test.ts` test adapter-level contract invariants (signal propagation, stream mapping, error translation, AbortError rejections) against injected engine fakes. They verify adapter wiring rather than testing live vendor OS process tree termination, which is covered by separate CLI-level `killTree` tests.

### Decision: Cost Estimation and BillingMode Distinction
Anthropic's `total_cost_usd` is a local client-side estimate based on standard API rate tables, not authoritative billing data (and is emitted hypothetically even for subscription users). Map this field to `costUsdEstimate?: number` in `NormalizedUsage` and derive `BillingMode = "per-token" | "plan-included"` from the auth context. The dashboard renders raw tokens prominently for `plan-included` sessions and suppresses or explicitly labels dollar figures as estimates.

### Decision: Version Drift CI Automation via Contract Tests
Pin exact package versions for `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`. Run comprehensive contract test suites in CI against Dependabot/Renovate pull requests to catch vendor breaking changes before production deployment.

## Gotchas

### Gotcha: Subscription Quota Visibility In-Stream
Subscription/keyless authentication (Claude Pro/Max, ChatGPT sign-in) does not emit programmatic quota percentages (e.g. 5-hour window or weekly caps) on the stream. Quota exhaustion manifests as mid-session turn failures. On `turn_failed` errors matching rate/window limits, render clear actionable remediation guidance (wait for reset / enable API credits / switch to API key).

### Gotcha: Headless Token Workaround (`CLAUDE_CODE_OAUTH_TOKEN`)
`claude setup-token` + `CLAUDE_CODE_OAUTH_TOKEN` functions with the Agent SDK and bills against Max subscription plans in headless environments. This is viable for personal/developer automation, but should not be productized as multi-tenant shared subscription infrastructure.

### Gotcha: Codex Working Directory Git Requirement (`skipGitRepoCheck`)
Codex CLI/SDK throws an error if `workingDirectory` is not a git repository. Multi-repo workspace roots in NexusFlow are frequently not git roots. Always pass `skipGitRepoCheck: true` on `codex.startThread()` or point threads directly at individual repository root directories.

### Gotcha: ForkSession History Branching vs File Edits
`forkSession` in `@anthropic-ai/claude-agent-sdk` rewrites `sessionId` and message UUIDs, branching conversation transcript history only. It does **not** sandbox or rollback workspace file changes. When implementing alternative-approach explorations or retries, pair `forkSession` with workspace worktree/file checkpointing. Always pass `forkSession: true` with `resume` on user retries to avoid mutating historical audit transcripts.

### Gotcha: Custom SessionStore Entry-Level Read/Write
`forkSession` iterates and remaps message records individually rather than doing blob get/put copying. Custom `sessionStore` backend adapters must support entry-level read/write operations.

### Gotcha: Rapid Vendor SDK API Drift
Both Anthropic and OpenAI frequently ship breaking changes in their agent SDKs. A strict abstraction layer without a typed escape hatch (`nativeOptions?: unknown`) creates bottlenecks; the escape hatch allows immediate access to newly added options while keeping core interfaces stable.

**Branch:** `sdk_claude_codex`
**Created:** 2026-08-22T13:07:53.868Z

## Empirical Spike Findings (Pre-Sprint Validation)

| # | Result | Evidence | Decisions Changed | TODOs Closed |
|---|---|---|---|---|
| **1** | ✅ PASS | First event: `[system:init]`, `session_id` captured prior to assistant/result messages. Stream text deltas arrive via `content_block_delta` → `delta.text`. Passing `options.env` **REPLACES** `process.env` in Agent SDK CLI subprocess. | `ClaudeCodeAdapter` must spread `process.env` when passing `spec.env` (`{ ...process.env, ...spec.env }`) so child processes retain `PATH` and system variables. | `TODO(spike-1)` & `TODO(spike-2)` |
| **2** | ✅ PASS | `sessionStore` projectKey derivation inspects `process.env.CLAUDE_CONFIG_DIR` and `process.env.CLAUDE_CODE_PROJECT_DIR_NAME`. When both are set, projectKey is keyed by `workspaceId` instead of working directory path hash. | Callers must provide both `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME` in `spec.env` to ensure cross-host resumption without path collisions. | `TODO(spike-2)` |
| **3** | ✅ PASS | `forkSession(sessionId, { sessionStore })` performs granular entry-level reads/appends; assigns fresh UUID for target sessionId, remaps all message and parent UUIDs, and writes `forkedFrom: { sessionId, messageUuid }`. | `SessionStore` must expose entry-level `load()` and `append()`; fork branches conversation transcripts only, file modifications remain shared. | `TODO(spike-3)` |
| **4** | ✅ PASS | `codex.startThread({ workingDirectory: plainTmpDir, skipGitRepoCheck: true })` bypasses git repo validation and initializes thread without error. | Pass `skipGitRepoCheck: true` by default in `CodexAdapter.start()` for multi-repo workspace roots. | `TODO(spike-4)` |
| **5** | ✅ PASS | `codex.resumeThread(threadId)` instantiates `Thread` handle from `~/.codex/sessions`. Pinned SDK types confirm `runStreamed(prompt, { signal })` accepts `AbortSignal`; runtime cancellation behavior tested via `handle.interrupt()` under Issue #174. | Wire `AbortController` into `runStreamed` and implement `interrupt(): async () => abortController.abort()`. | `TODO(spike-5)` |
| **6** | ✅ PASS | Complete Codex event census recorded: `thread.started`, `turn.started`, `item.started`, `item.updated`, `item.completed`, `turn.completed`, `turn.failed`, `error`. Items: `agent_message`, `file_change`, `command_execution`, `mcp_tool_call`. Usage: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. No text deltas (agent_message is item-atomic). | Import and use exact `ThreadEvent` and `ThreadItem` union types in `codex.ts`; retain `sawDeltaThisTurn` for forward compatibility. | `TODO(spike-6)` |
| **7** | ✅ PASS | Claude Agent SDK accepts `mcpServers` in `Options` (`createSdkMcpServer`); Codex accepts MCP server configs via `CodexOptions.config` (`mcp_servers`). | Mount NexusFlow MCP tools directly via `Options.mcpServers` (Claude) and `CodexOptions.config` (Codex). | `TODO(spike-7)` |

## Repos in This Workspace

- **NexusFlow** (typescript — hono, react)

## Implementation Progress

- [x] Pre-Sprint Empirical Spikes (1-7) validated and recorded
- [x] Phase 1 Core Harness Abstraction (`src/harness/`) implemented and tested
- [x] Phase 1 Session Dispatcher Migration (`ClaudeSdkAdapter` and `CodexSdkAdapter` registered in `ProviderRegistry`)
- [x] Phase 2 NexusFlow MCP Server Implementation (Full lifecycle tools: `create_workspace`, `list_workspaces`, `list_repos`, and role-based tool surface scoping)
- [x] Phase 3 Multi-Agent Orchestration & Contract Test Suite
