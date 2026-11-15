import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { getAdapter } from '../harness/index.js';
import type { HarnessAdapter, SessionHandle } from '../harness/interface.js';
import type { PermissionMode } from '../harness/types.js';
import type { AgentExecutionProfile, AgentHarness } from './ProviderRegistry.js';
import { isValidSessionUuid, type AgentSession } from './session.js';
import { getLocalMcpServerConfig } from './mcp-config.js';
import { MCP_ADAPTER_SERVER_NAME, LEGACY_MCP_ADAPTER_SERVER_NAME } from '../core/constants.js';
import { toErrorMessage } from '../utils/errors.js';

export class CodexSdkAdapter extends EventEmitter implements AgentHarness {
  private readonly adapter: HarnessAdapter;
  private handle: SessionHandle | null = null;
  private cwd = '';
  private session: AgentSession | undefined;
  private active = false;

  constructor(adapterOverride?: HarnessAdapter) {
    super();
    this.adapter = adapterOverride ?? getAdapter('codex');
  }

  async start(cwd: string, session?: AgentSession): Promise<void> {
    this.cwd = cwd;
    this.session = session;
    this.active = true;
  }

  async send(data: string, executionProfile: AgentExecutionProfile = 'review'): Promise<void> {
    if (!this.active) {
      this.emit('error', new Error('Agent is not started or has been stopped.'));
      return;
    }

    const permissionMode: PermissionMode =
      executionProfile === 'workspace-write' ? 'acceptEdits' : 'default';
    const workspaceId = path.basename(this.cwd);
    const role = executionProfile === 'workspace-write' ? 'developer' : 'review';

    if (!this.handle) {
      try {
        const spec = {
          prompt: data,
          workspace: {
            workspaceId,
            rootPath: this.cwd,
          },
          permissionMode,
          model: this.session?.model || process.env.OPENAI_MODEL || process.env.CODEX_MODEL || undefined,
          env: { CTXSPACE_HARNESS: 'codex' },
          mcpServers: {
            [MCP_ADAPTER_SERVER_NAME]: getLocalMcpServerConfig(this.cwd, role),
            [LEGACY_MCP_ADAPTER_SERVER_NAME]: getLocalMcpServerConfig(this.cwd, role),
          },
        };

        if (this.session && this.session.resume) {
          this.handle = await this.adapter.resume({
            ...spec,
            sessionId: this.session.id,
            mode: 'resume',
          });
        } else {
          this.handle = await this.adapter.start(spec);
        }

        this.bindEvents(this.handle);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(toErrorMessage(err)));
        this.emit('idle');
      }
    } else {
      this.handle.send(data);
    }
  }

  stop(): void {
    this.active = false;
    if (this.handle) {
      void this.handle.dispose();
      this.handle = null;
    }
    this.emit('close', 0);
  }

  private bindEvents(handle: SessionHandle): void {
    let sawDeltaThisTurn = false;
    let lastEmittedSessionId: string | null = null;

    const emitSessionOnce = (id: string) => {
      if (isValidSessionUuid(id) && id !== lastEmittedSessionId) {
        lastEmittedSessionId = id;
        this.emit('session', id);
      }
    };

    void (async () => {
      try {
        // Resolve lazy session ID
        void handle.sessionId().then(emitSessionOnce).catch(() => {});

        for await (const event of handle.events) {
          switch (event.type) {
            case 'session_started':
              emitSessionOnce(event.sessionId);
              break;

            case 'text_delta':
              sawDeltaThisTurn = true;
              this.emit('data', event.text);
              break;

            case 'assistant_message':
              if (!sawDeltaThisTurn && event.text) {
                this.emit('data', event.text);
              }
              break;

            case 'tool_requested':
              this.emit('system', `Tool requested: ${event.tool}`);
              break;

            case 'tool_completed':
              this.emit('system', event.ok ? `Tool completed: ${event.callId ?? ''}` : `Tool failed: ${event.callId ?? ''}`);
              break;

            case 'file_changed':
              this.emit('file_changed', { kind: event.kind, paths: event.paths });
              this.emit('system', `File ${event.kind}: ${event.paths.join(', ')}`);
              break;

            case 'turn_completed':
              sawDeltaThisTurn = false;
              this.emit('usage', event.usage);
              this.emit('idle');
              break;

            case 'turn_failed':
              sawDeltaThisTurn = false;
              this.emit('error', new Error(event.error.message));
              this.emit('idle');
              break;
          }
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(toErrorMessage(err)));
      } finally {
        if (this.active) {
          this.emit('idle');
        }
      }
    })();
  }
}
