import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HarnessAdapter, SessionHandle } from '../harness/interface.js';
import type { NormalizedUsage } from '../harness/types.js';
import type { AgentExecutionProfile, AgentHarness } from './ProviderRegistry.js';
import { ClaudeSdkAdapter } from './ClaudeSdkAdapter.js';
import { CodexSdkAdapter } from './CodexSdkAdapter.js';
import { acquireLock, type ReleaseLock } from '../core/locks.js';
import { checkGenerationLock } from '../core/generation-lock.js';
import { resolveWorkspaceFilePath } from '../core/constants.js';
import { toErrorMessage } from '../utils/errors.js';

export interface TeamAgentSpec {
  id: string;
  name: string;
  role: 'lead' | 'researcher' | 'developer' | 'reviewer';
  vendor?: 'claude-code' | 'codex';
  executionProfile?: AgentExecutionProfile;
  prompt: string;
  worktreePath?: string;
  /** Whether to thread prior phases' outputs into this agent's kickoff in pipeline mode (defaults to true). */
  includePriorContext?: boolean;
}

export interface AgentExecutionStatus {
  id: string;
  name: string;
  role: string;
  vendor: 'claude-code' | 'codex';
  sessionId?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  usage?: NormalizedUsage;
  error?: string;
  lastOutput?: string;
}

export const MAX_OUTPUT_CAPTURE_CHARS = 16_000;

export function appendCappedOutput(
  existing: string | undefined,
  chunk: string,
  maxChars = MAX_OUTPUT_CAPTURE_CHARS,
): string {
  const combined = (existing ?? '') + chunk;
  if (combined.length <= maxChars) {
    return combined;
  }
  const truncated = combined.slice(combined.length - maxChars);
  return `[... prior output truncated ...]\n${truncated}`;
}

export type TeamworkMode = 'parallel' | 'pipeline';

export interface RunTeamOptions {
  mode?: TeamworkMode;
}

export interface MultiAgentOrchestratorOptions {
  claudeAdapterFactory?: () => AgentHarness;
  codexAdapterFactory?: () => AgentHarness;
}

export interface TeamworkResult {
  workspacePath: string;
  agents: AgentExecutionStatus[];
  totalUsage: NormalizedUsage;
  success: boolean;
  partialSuccess: boolean;
  failureReason?: string;
}

/**
 * Multi-Agent Orchestrator (Phase 3).
 *
 * Coordinates concurrent agents across Claude and Codex harnesses:
 * - Claude: Programmatic subagent definitions or isolated SDK sessions with independent UUIDs.
 * - Codex: Orchestrator-level thread fan-out with independent thread sessions.
 * - Concurrency: Enforces workspace mutation locks (for shared workspaces) and worktree branch isolation (when worktreePath is provided).
 * - Pipelines: Supports sequential pipeline execution with fail-fast skip on upstream failure.
 */
export class MultiAgentOrchestrator extends EventEmitter {
  private readonly workspacePath: string;
  private readonly options?: MultiAgentOrchestratorOptions;
  private readonly runningHandles: Map<string, SessionHandle | AgentHarness> = new Map();
  private isInterrupted = false;

  constructor(workspacePath: string, options?: MultiAgentOrchestratorOptions) {
    super();
    this.workspacePath = workspacePath;
    this.options = options;
  }

  async runTeam(specs: TeamAgentSpec[], runOptions?: RunTeamOptions): Promise<TeamworkResult> {
    if (!specs || specs.length < 2) {
      throw new Error('Teamwork orchestration requires at least 2 agents (e.g. Lead Planner + Developer).');
    }

    const freshness = await checkGenerationLock(this.workspacePath, { markDocuments: true });
    if (!freshness.fresh) {
      this.emit('warning', {
        type: 'stale-context',
        message: freshness.drift.map((item) => item.message).join(' '),
      });
    }

    // Verify unique agent IDs
    const idSet = new Set<string>();
    for (const spec of specs) {
      if (idSet.has(spec.id)) {
        throw new Error(`Duplicate agent ID detected in teamwork spec: "${spec.id}"`);
      }
      idSet.add(spec.id);
    }

    const statuses: Map<string, AgentExecutionStatus> = new Map();
    for (const spec of specs) {
      statuses.set(spec.id, {
        id: spec.id,
        name: spec.name,
        role: spec.role,
        vendor: spec.vendor ?? 'claude-code',
        status: 'pending',
      });
    }

    const mode = runOptions?.mode ?? 'parallel';

    if (this.isInterrupted) {
      for (const status of statuses.values()) {
        status.status = 'cancelled';
      }
      return this.buildResult(statuses);
    }

    // Enforce workspace-level mutation lock across concurrent agents in the same workspace root
    let releaseMutationLock: ReleaseLock | null = null;
    const isSharedWorktree = specs.every(s => !s.worktreePath || s.worktreePath === this.workspacePath);
    if (isSharedWorktree) {
      const lockRes = await resolveWorkspaceFilePath(this.workspacePath, 'mutationLock');
      const lockPath = lockRes.path;
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      try {
        releaseMutationLock = await acquireLock(lockPath, {
          staleMs: 60_000,
          timeoutMs: 10_000,
          timeoutMessage: 'Could not acquire multi-agent workspace mutation lock.',
        });
      } catch (err) {
        if (this.isInterrupted) {
          for (const status of statuses.values()) {
            status.status = 'cancelled';
          }
          return this.buildResult(statuses);
        }
        throw err;
      }
    }

    try {
      if (mode === 'pipeline') {
        // Sequential pipeline execution (e.g. Planner -> Implementer -> Reviewer)
        let accumulatedContext = '';
        for (const spec of specs) {
          if (this.isInterrupted) {
            statuses.get(spec.id)!.status = 'cancelled';
            continue;
          }
          // If any previous agent failed or was cancelled, skip downstream phases
          const previousFailure = Array.from(statuses.values()).find(
            s => s.status === 'failed' || s.status === 'cancelled',
          );
          if (previousFailure) {
            const status = statuses.get(spec.id)!;
            status.status = 'cancelled';
            status.error = `Skipped due to upstream phase failure in ${previousFailure.id} (${previousFailure.role})`;
            continue;
          }

          const shouldIncludeContext = spec.includePriorContext !== false;
          const effectivePrompt = (shouldIncludeContext && accumulatedContext)
            ? `${spec.prompt}\n\n## Context from Prior Phases:\n${accumulatedContext.trim()}`
            : spec.prompt;

          await this.executeAgent({ ...spec, prompt: effectivePrompt }, statuses);

          const completedStatus = statuses.get(spec.id);
          if (completedStatus && completedStatus.status === 'completed' && completedStatus.lastOutput) {
            accumulatedContext += `### Phase Output: ${spec.name} (${spec.role})\n${completedStatus.lastOutput.trim()}\n\n`;
          }
        }
      } else {
        // Parallel fan-out with independent session contexts
        const promises = specs.map((spec) => this.executeAgent(spec, statuses));
        await Promise.allSettled(promises);
      }
    } finally {
      if (releaseMutationLock) {
        await releaseMutationLock();
      }
    }

    return this.buildResult(statuses);
  }

  private buildResult(statuses: Map<string, AgentExecutionStatus>): TeamworkResult {
    const results = Array.from(statuses.values());
    const totalUsage = this.aggregateUsage(results);
    const completedCount = results.filter(r => r.status === 'completed').length;
    const success = results.length > 0 && completedCount === results.length;
    const partialSuccess = completedCount > 0 && !success;

    const failedAgents = results.filter(r => r.status === 'failed' || r.status === 'cancelled');
    const failureReason = failedAgents.length > 0
      ? failedAgents.map(a => `${a.id} (${a.role}): ${a.error || a.status}`).join('; ')
      : undefined;

    return {
      workspacePath: this.workspacePath,
      agents: results,
      totalUsage,
      success,
      partialSuccess,
      failureReason,
    };
  }

  async interruptAll(): Promise<void> {
    this.isInterrupted = true;
    const interrupts: Promise<void>[] = [];
    for (const handle of this.runningHandles.values()) {
      if ('interrupt' in handle && typeof handle.interrupt === 'function') {
        interrupts.push(handle.interrupt());
      } else if ('stop' in handle && typeof handle.stop === 'function') {
        interrupts.push(Promise.resolve(handle.stop()));
      }
    }
    await Promise.allSettled(interrupts);
  }

  private async executeAgent(
    spec: TeamAgentSpec,
    statuses: Map<string, AgentExecutionStatus>,
  ): Promise<void> {
    const status = statuses.get(spec.id)!;
    status.status = 'running';
    const targetCwd = spec.worktreePath ?? this.workspacePath;
    const vendor = spec.vendor ?? 'claude-code';

    if (this.isInterrupted) {
      status.status = 'cancelled';
      return;
    }

    const adapter = vendor === 'codex'
      ? (this.options?.codexAdapterFactory ? this.options.codexAdapterFactory() : new CodexSdkAdapter())
      : (this.options?.claudeAdapterFactory ? this.options.claudeAdapterFactory() : new ClaudeSdkAdapter());
    this.runningHandles.set(spec.id, adapter);

    try {
      await new Promise<void>((resolve, reject) => {
        adapter.on('session', (sessionId: string) => {
          status.sessionId = sessionId;
          this.emit('agent_session', { agentId: spec.id, sessionId });
        });

        adapter.on('data', (chunk: string) => {
          status.lastOutput = appendCappedOutput(status.lastOutput, chunk);
          this.emit('agent_data', { agentId: spec.id, data: chunk });
        });

        adapter.on('usage', (usage: NormalizedUsage) => {
          status.usage = usage;
          this.emit('agent_usage', { agentId: spec.id, usage });
        });

        adapter.on('error', (err: Error) => {
          status.status = 'failed';
          status.error = err.message;
        });

        adapter.on('idle', () => {
          if (status.status === 'running') {
            status.status = 'completed';
          }
          resolve();
        });

        adapter.on('close', (code?: number) => {
          if (status.status === 'running') {
            if (code !== undefined && code !== 0) {
              status.status = 'failed';
            } else {
              status.status = this.isInterrupted ? 'cancelled' : 'completed';
            }
          }
          resolve();
        });

        void (async () => {
          try {
            await adapter.start(targetCwd);
            await adapter.send(spec.prompt, spec.executionProfile ?? 'review');
          } catch (err) {
            status.status = 'failed';
            status.error = toErrorMessage(err);
            reject(err);
          }
        })();
      });
    } catch (err) {
      status.status = 'failed';
      status.error = toErrorMessage(err);
    } finally {
      this.runningHandles.delete(spec.id);
    }
  }

  private aggregateUsage(statuses: AgentExecutionStatus[]): NormalizedUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens: number | undefined = undefined;
    let costUsdEstimate: number | undefined = undefined;

    for (const status of statuses) {
      if (status.usage) {
        inputTokens += status.usage.inputTokens ?? 0;
        outputTokens += status.usage.outputTokens ?? 0;
        if (status.usage.cachedInputTokens !== undefined) {
          cachedInputTokens = (cachedInputTokens ?? 0) + status.usage.cachedInputTokens;
        }
        if (status.usage.costUsdEstimate !== undefined) {
          costUsdEstimate = (costUsdEstimate ?? 0) + status.usage.costUsdEstimate;
        }
      }
    }

    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      costUsdEstimate,
    };
  }
}
