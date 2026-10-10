import { describe, expect, it, vi } from 'vitest';
import { ClaudeSdkAdapter } from './ClaudeSdkAdapter.js';
import type { HarnessAdapter, SessionHandle } from '../harness/interface.js';
import type { HarnessEvent } from '../harness/types.js';

function createMockHandle(events: HarnessEvent[], sessionIdVal = '11111111-1111-1111-1111-111111111111'): {
  handle: SessionHandle;
  approvals: Array<{ requestId: string; decision: any }>;
} {
  const approvals: Array<{ requestId: string; decision: any }> = [];
  const handle: SessionHandle = {
    vendor: 'claude-code',
    sessionId: () => Promise.resolve(sessionIdVal),
    events: (async function* () {
      for (const ev of events) {
        yield ev;
      }
    })(),
    send: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    respondToApproval: vi.fn((requestId, decision) => {
      approvals.push({ requestId, decision });
    }),
  };
  return { handle, approvals };
}

function createMockAdapter(handle: SessionHandle): HarnessAdapter {
  return {
    vendor: 'claude-code',
    authStatus: vi.fn().mockResolvedValue({ configured: true, method: 'api-key' }),
    start: vi.fn().mockResolvedValue(handle),
    resume: vi.fn().mockResolvedValue(handle),
    listSessions: vi.fn().mockResolvedValue([]),
  };
}

describe('ClaudeSdkAdapter', () => {
  it('instantiates and emits events through the adapter', async () => {
    const adapter = new ClaudeSdkAdapter();
    expect(adapter).toBeDefined();

    const dataEvents: string[] = [];
    const sessionEvents: string[] = [];
    const systemEvents: string[] = [];
    let idleCalled = false;

    adapter.on('data', (text: string) => dataEvents.push(text));
    adapter.on('session', (id: string) => sessionEvents.push(id));
    adapter.on('system', (msg: string) => systemEvents.push(msg));
    adapter.on('idle', () => { idleCalled = true; });

    await adapter.start('C:/test/workspace');
    expect(adapter).toBeDefined();
  });

  it('stops and emits close', async () => {
    const adapter = new ClaudeSdkAdapter();
    let closed = false;
    adapter.on('close', () => { closed = true; });

    await adapter.start('C:/test/workspace');
    adapter.stop();

    expect(closed).toBe(true);
  });

  it('deduplicates session ID emissions between promise and session_started event', async () => {
    const sessionId = '12345678-1234-1234-1234-123456789abc';
    const { handle } = createMockHandle([
      { type: 'session_started', sessionId },
      { type: 'text_delta', text: 'Hello' },
      { type: 'turn_completed', usage: { inputTokens: 10, outputTokens: 5 } },
    ], sessionId);

    const mockAdapter = createMockAdapter(handle);
    const adapter = new ClaudeSdkAdapter(undefined, mockAdapter);

    const emittedSessions: string[] = [];
    const usageEvents: any[] = [];
    let idleCount = 0;

    adapter.on('session', (id) => emittedSessions.push(id));
    adapter.on('usage', (usage) => usageEvents.push(usage));
    adapter.on('idle', () => { idleCount++; });

    await adapter.start('C:/test/workspace');
    await adapter.send('Hi');

    await vi.waitFor(() => {
      expect(emittedSessions).toEqual([sessionId]);
      expect(usageEvents).toEqual([{ inputTokens: 10, outputTokens: 5 }]);
      expect(idleCount).toBeGreaterThanOrEqual(1);
    });
  });

  it('enforces tool-class approval gating in workspace-write profile (Issue #173)', async () => {
    const { handle, approvals } = createMockHandle([
      { type: 'approval_required', requestId: 'req-1', tool: 'Edit', input: { path: 'file.ts' } },
      { type: 'approval_required', requestId: 'req-2', tool: 'Write', input: { path: 'new.ts' } },
      { type: 'approval_required', requestId: 'req-3', tool: 'LS', input: { path: '.' } },
      { type: 'approval_required', requestId: 'req-4', tool: 'mcp__nexusflow__list_repos', input: {} },
      { type: 'approval_required', requestId: 'req-5', tool: 'mcp__nexusflow__create_workspace', input: { branchName: 'feat' } },
      { type: 'approval_required', requestId: 'req-6', tool: 'Bash', input: { command: 'rm -rf /' } },
    ]);

    const mockAdapter = createMockAdapter(handle);
    const adapter = new ClaudeSdkAdapter(undefined, mockAdapter);

    const systemMessages: string[] = [];
    adapter.on('system', (msg) => systemMessages.push(msg));

    await adapter.start('C:/test/workspace');
    await adapter.send('Edit files and run commands', 'workspace-write');

    await vi.waitFor(() => {
      expect(approvals).toHaveLength(6);
    });

    // Allowed file & fs tools and read-only NexusFlow MCP tools
    expect(approvals[0]).toEqual({ requestId: 'req-1', decision: { behavior: 'allow' } });
    expect(approvals[1]).toEqual({ requestId: 'req-2', decision: { behavior: 'allow' } });
    expect(approvals[2]).toEqual({ requestId: 'req-3', decision: { behavior: 'allow' } });
    expect(approvals[3]).toEqual({ requestId: 'req-4', decision: { behavior: 'allow' } });

    // Denied mutating MCP lifecycle tool with dashboard/CLI guidance
    expect(approvals[4]).toEqual({
      requestId: 'req-5',
      decision: {
        behavior: 'deny',
        message: "Workspace lifecycle tool 'create_workspace' requires approval and is unavailable in embedded chat. Run in CLI, full terminal, or dashboard.",
      },
    });
    expect(systemMessages).toContain("Denied 'mcp__nexusflow__create_workspace' execution: workspace lifecycle changes require dashboard or CLI.");

    // Denied shell execution with CLI guidance
    expect(approvals[5]).toEqual({
      requestId: 'req-6',
      decision: {
        behavior: 'deny',
        message: "Tool 'Bash' requires approval and is unavailable in embedded chat. Run in CLI or full terminal.",
      },
    });
    expect(systemMessages).toContain("Denied 'Bash' execution: unavailable in embedded chat.");
  });

  it('denies all tool approvals in review execution profile', async () => {
    const { handle, approvals } = createMockHandle([
      { type: 'approval_required', requestId: 'req-1', tool: 'Edit', input: { path: 'file.ts' } },
    ]);

    const mockAdapter = createMockAdapter(handle);
    const adapter = new ClaudeSdkAdapter(undefined, mockAdapter);

    await adapter.start('C:/test/workspace');
    await adapter.send('Edit files', 'review');

    await vi.waitFor(() => {
      expect(approvals).toEqual([
        {
          requestId: 'req-1',
          decision: {
            behavior: 'deny',
            message: 'Action denied: active execution profile is review-only.',
          },
        },
      ]);
    });
  });

  it.each(['workspace-write', 'review'] as const)('respects the %s profile for planning tools', async (profile) => {
    const names = ['update_milestone_plan', 'update_work_assignment', 'add_work_document', 'update_work_document', 'save_planning_notes'];
    const { handle, approvals } = createMockHandle(names.map((name, index) => ({
      type: 'approval_required', requestId: `planning-${index}`, tool: `mcp__contextspace-mcp__${name}`, input: {},
    })));
    const adapter = new ClaudeSdkAdapter(undefined, createMockAdapter(handle));
    await adapter.start('C:/test/workspace');
    await adapter.send('Set up the feature plan', profile);
    await vi.waitFor(() => expect(approvals).toHaveLength(names.length));
    expect(approvals.every((item) => item.decision.behavior === (profile === 'workspace-write' ? 'allow' : 'deny'))).toBe(true);
  });

  it.each(['workspace-write', 'review'] as const)('respects the %s profile for the screen tools', async (profile) => {
    const names = ['show_in_reader', 'annotate_document', 'suggest_next', 'get_screen_context', 'request_user_input', 'set_milestone'];
    const { handle, approvals } = createMockHandle(names.map((name, index) => ({
      type: 'approval_required', requestId: `screen-${index}`, tool: `mcp__contextspace-mcp__${name}`, input: {},
    })));
    const adapter = new ClaudeSdkAdapter(undefined, createMockAdapter(handle));
    await adapter.start('C:/test/workspace');
    await adapter.send('Show the user the plan', profile);
    await vi.waitFor(() => expect(approvals).toHaveLength(names.length));
    expect(approvals.every((item) => item.decision.behavior === (profile === 'workspace-write' ? 'allow' : 'deny'))).toBe(true);
  });

  it.each(['workspace-write', 'review'] as const)('lets the AI run a plain ctxspace plan command in the %s profile only when it may write', async (profile) => {
    const commands = ['ctxspace plan', './.contextspace/bin/ctxspace plan done T1 --resolution "Tests pass"', 'ctxspace plan; rm -rf ~', 'ctxspace plan done T1 --resolution "$(whoami)"'];
    const { handle, approvals } = createMockHandle(commands.map((command, index) => ({
      type: 'approval_required', requestId: `bash-${index}`, tool: 'Bash', input: { command },
    })));
    const mockAdapter = createMockAdapter(handle);
    const adapter = new ClaudeSdkAdapter(undefined, mockAdapter);
    await adapter.start('C:/test/workspace');
    await adapter.send('Mark T1 done', profile);
    await vi.waitFor(() => expect(approvals).toHaveLength(commands.length));
    expect(approvals.map((item) => item.decision.behavior)).toEqual(profile === 'workspace-write' ? ['allow', 'allow', 'deny', 'deny'] : ['deny', 'deny', 'deny', 'deny']);
    // The AI tool is told its name, so the plan records Claude as the one who made the change.
    expect(vi.mocked(mockAdapter.start).mock.calls[0][0].env).toMatchObject({ CTXSPACE_HARNESS: 'claude' });
  });

  it('emits idle on silent stream termination (prevents turn gate lock)', async () => {
    const { handle } = createMockHandle([
      { type: 'text_delta', text: 'Partial output' },
      // Stream terminates without turn_completed
    ]);

    const mockAdapter = createMockAdapter(handle);
    const adapter = new ClaudeSdkAdapter(undefined, mockAdapter);

    let idleFired = false;
    adapter.on('idle', () => { idleFired = true; });

    await adapter.start('C:/test/workspace');
    await adapter.send('Hi');

    await vi.waitFor(() => {
      expect(idleFired).toBe(true);
    });
  });

  it('emits approval_request when listener is present and resolves via respondToApproval', async () => {
    const { handle, approvals } = createMockHandle([
      { type: 'approval_required', requestId: 'req-interactive', tool: 'Bash', input: { command: 'npm test' } },
    ]);

    const mockAdapter = createMockAdapter(handle);
    const adapter = new ClaudeSdkAdapter(undefined, mockAdapter);

    const receivedRequests: any[] = [];
    adapter.on('approval_request', (req) => {
      receivedRequests.push(req);
      adapter.respondToApproval(req.requestId, 'allow');
    });

    await adapter.start('C:/test/workspace');
    await adapter.send('Run tests', 'workspace-write');

    await vi.waitFor(() => {
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toEqual({
        requestId: 'req-interactive',
        tool: 'Bash',
        input: { command: 'npm test' },
        description: undefined,
      });
      expect(approvals).toEqual([
        { requestId: 'req-interactive', decision: { behavior: 'allow' } },
      ]);
    });
  });
});
