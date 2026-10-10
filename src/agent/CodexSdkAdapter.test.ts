import { describe, expect, it, vi } from 'vitest';
import { CodexSdkAdapter } from './CodexSdkAdapter.js';
import type { HarnessAdapter, SessionHandle } from '../harness/interface.js';
import type { HarnessEvent } from '../harness/types.js';

function createMockHandle(events: HarnessEvent[], sessionIdVal = '22222222-2222-2222-2222-222222222222'): SessionHandle {
  return {
    vendor: 'codex',
    sessionId: () => Promise.resolve(sessionIdVal),
    events: (async function* () {
      for (const ev of events) {
        yield ev;
      }
    })(),
    send: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    respondToApproval: vi.fn(),
  };
}

function createMockAdapter(handle: SessionHandle): HarnessAdapter {
  return {
    vendor: 'codex',
    authStatus: vi.fn().mockResolvedValue({ configured: true, method: 'api-key' }),
    start: vi.fn().mockResolvedValue(handle),
    resume: vi.fn().mockResolvedValue(handle),
    listSessions: vi.fn().mockResolvedValue([]),
  };
}

describe('CodexSdkAdapter', () => {
  it('instantiates and manages lifecycle', async () => {
    const adapter = new CodexSdkAdapter();
    expect(adapter).toBeDefined();

    await adapter.start('C:/test/workspace');
    expect(adapter).toBeDefined();

    let closed = false;
    adapter.on('close', () => { closed = true; });
    adapter.stop();
    expect(closed).toBe(true);
  });

  it('deduplicates session ID emissions and forwards usage events', async () => {
    const sessionId = '87654321-4321-4321-4321-cba987654321';
    const handle = createMockHandle([
      { type: 'session_started', sessionId },
      { type: 'assistant_message', text: 'Codex response' },
      { type: 'turn_completed', usage: { inputTokens: 20, outputTokens: 8 } },
    ], sessionId);

    const mockAdapter = createMockAdapter(handle);
    const adapter = new CodexSdkAdapter(mockAdapter);

    const emittedSessions: string[] = [];
    const usageEvents: any[] = [];
    let idleCount = 0;

    adapter.on('session', (id) => emittedSessions.push(id));
    adapter.on('usage', (usage) => usageEvents.push(usage));
    adapter.on('idle', () => { idleCount++; });

    await adapter.start('C:/test/workspace');
    await adapter.send('Diagnose issue');

    await vi.waitFor(() => {
      expect(emittedSessions).toEqual([sessionId]);
      expect(usageEvents).toEqual([{ inputTokens: 20, outputTokens: 8 }]);
      expect(idleCount).toBeGreaterThanOrEqual(1);
    });
    // Codex is told its name, so the plan records it as the one who made a change.
    expect(vi.mocked(mockAdapter.start).mock.calls[0][0].env).toEqual({ CTXSPACE_HARNESS: 'codex' });
  });

  it('emits idle on silent stream termination', async () => {
    const handle = createMockHandle([
      { type: 'text_delta', text: 'Partial output' },
    ]);

    const mockAdapter = createMockAdapter(handle);
    const adapter = new CodexSdkAdapter(mockAdapter);

    let idleFired = false;
    adapter.on('idle', () => { idleFired = true; });

    await adapter.start('C:/test/workspace');
    await adapter.send('Hi');

    await vi.waitFor(() => {
      expect(idleFired).toBe(true);
    });
  });
});
