import { describe, expect, it } from 'vitest';

import { HARNESSES, HARNESS_IDS } from '../../../../src/harnesses/registry.js';
import type { AgentMcpResult, AgentMcpStatus, McpAgentId } from '../../types.js';
import {
  MCP_AGENT_IDS,
  applyConnectResults,
  describeShownMcpStatus,
  formatAgentList,
  formatConnectFailures,
  toMcpAgentId,
} from './mcpTools.js';

const agent = (id: McpAgentId, status: AgentMcpStatus['status']): AgentMcpStatus => ({
  id,
  name: id,
  configPath: `/tmp/.${id}`,
  status,
});

describe('toMcpAgentId', () => {
  it('maps every mcp: true harness in the registry to itself, and mcp: false / shell / unknown to null', () => {
    const expectedMcp = HARNESS_IDS.filter((id) => HARNESSES[id].mcp);
    expect([...MCP_AGENT_IDS].sort()).toEqual([...expectedMcp].sort());

    for (const id of HARNESS_IDS) {
      expect(toMcpAgentId(id)).toBe(HARNESSES[id].mcp ? id : null);
    }
    expect(toMcpAgentId('shell')).toBeNull();
    expect(toMcpAgentId('copilot')).toBeNull();
    expect(toMcpAgentId('cursor')).toBeNull();
    expect(toMcpAgentId('')).toBeNull();
    expect(toMcpAgentId('unknown-tool')).toBeNull();
  });
});

describe('formatAgentList', () => {
  it('formats 1, 2, and 3+ names cleanly', () => {
    expect(formatAgentList([])).toBe('');
    expect(formatAgentList(['Codex'])).toBe('Codex');
    expect(formatAgentList(['Claude Code', 'Codex'])).toBe('Claude Code and Codex');
    expect(formatAgentList(['Claude Code', 'Codex', 'Antigravity'])).toBe('Claude Code, Codex and Antigravity');
  });
});

describe('describeShownMcpStatus', () => {
  it('ignores non-MCP tools and tools not shown as buttons', () => {
    const agents = [
      agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
      agent('codex', { state: 'registered', serverName: 'contextspace-mcp' }),
      agent('antigravity', { state: 'registered', serverName: 'contextspace-mcp' }),
      agent('pi', { state: 'unsupported', reason: 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter' }),
    ];

    expect(describeShownMcpStatus({
      shownToolIds: ['claude', 'codex', 'antigravity', 'copilot', 'shell'],
      agents,
      notice: null,
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: 'Claude Code, Codex and Antigravity can read the plan and change the Board.',
      connectIds: [],
      connectLabel: 'Connect',
    });

    expect(describeShownMcpStatus({
      shownToolIds: ['copilot', 'cursor', 'shell'],
      agents,
      notice: null,
      connecting: false,
    })).toBeNull();
  });

  it('omits tools reported as not-installed and handles undefined agents', () => {
    expect(describeShownMcpStatus({
      shownToolIds: ['claude', 'codex'],
      agents: [agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }), agent('codex', { state: 'not-installed' })],
      notice: null,
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: 'Claude Code can read the plan and change the Board.',
      connectIds: [],
      connectLabel: 'Connect',
    });

    expect(describeShownMcpStatus({
      shownToolIds: ['claude'],
      agents: undefined,
      notice: null,
      connecting: false,
    })).toBeNull();
  });

  it('shows missing tools with a Connect button and Connecting… while running', () => {
    const agents = [
      agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
      agent('codex', { state: 'missing' }),
    ];

    expect(describeShownMcpStatus({
      shownToolIds: ['claude', 'codex'],
      agents,
      notice: null,
      connecting: false,
    })).toEqual({
      tone: 'neutral',
      text: "Codex can't read the plan or change the Board yet.",
      connectIds: ['codex'],
      connectLabel: 'Connect',
    });

    expect(describeShownMcpStatus({
      shownToolIds: ['claude', 'codex'],
      agents,
      notice: null,
      connecting: true,
    })).toEqual({
      tone: 'neutral',
      text: "Codex can't read the plan or change the Board yet.",
      connectIds: ['codex'],
      connectLabel: 'Connecting…',
    });
  });

  it('shows unsupported and unreadable reasons with no Connect button', () => {
    const piReason = 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter';
    expect(describeShownMcpStatus({
      shownToolIds: ['pi'],
      agents: [agent('pi', { state: 'unsupported', reason: piReason })],
      notice: null,
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: piReason,
      connectIds: [],
      connectLabel: 'Connect',
    });

    expect(describeShownMcpStatus({
      shownToolIds: ['claude'],
      agents: [agent('claude', { state: 'unreadable', reason: '/home/me/.claude.json: Unexpected token' })],
      notice: null,
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: "Claude Code's MCP config could not be read (/home/me/.claude.json: Unexpected token).",
      connectIds: [],
      connectLabel: 'Connect',
    });
  });

  it('shows stale state with disclosure details and no Connect button', () => {
    const staleText = '"contextspace-mcp" runs the npm package, which stopped at 2.39.';
    expect(describeShownMcpStatus({
      shownToolIds: ['codex'],
      agents: [agent('codex', { state: 'registered', serverName: 'contextspace-mcp', stale: staleText })],
      notice: null,
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: "Codex uses an old copy of ContextSpace's tools.",
      connectIds: [],
      connectLabel: 'Connect',
      staleDetails: [staleText],
    });
  });

  it('preserves connected and error notices across polls', () => {
    const registered = [agent('codex', { state: 'registered', serverName: 'contextspace-mcp' })];
    expect(describeShownMcpStatus({
      shownToolIds: ['codex'],
      agents: registered,
      notice: { kind: 'connected', message: 'Connected. Sessions already running get the tools when they start again.' },
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: 'Connected. Sessions already running get the tools when they start again.',
      connectIds: [],
      connectLabel: 'Connect',
    });

    expect(describeShownMcpStatus({
      shownToolIds: ['codex'],
      agents: registered,
      notice: { kind: 'connected-first', message: "Connected Codex to ContextSpace's tools first." },
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: "Connected Codex to ContextSpace's tools first.",
      connectIds: [],
      connectLabel: 'Connect',
    });

    expect(describeShownMcpStatus({
      shownToolIds: ['claude', 'codex'],
      agents: [agent('claude', { state: 'missing' }), agent('codex', { state: 'registered', serverName: 'contextspace-mcp' })],
      notice: { kind: 'connected-first', message: "Connected Codex to ContextSpace's tools first." },
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: "Connected Codex to ContextSpace's tools first. Claude Code can't read the plan or change the Board yet.",
      connectIds: ['claude'],
      connectLabel: 'Connect',
    });

    expect(describeShownMcpStatus({
      shownToolIds: ['codex'],
      agents: [agent('codex', { state: 'missing' })],
      notice: { kind: 'error', message: 'Codex: spawn EACCES' },
      connecting: false,
    })).toEqual({
      tone: 'alert',
      text: 'Codex: spawn EACCES',
      connectIds: ['codex'],
      connectLabel: 'Connect',
    });

    // External fix detected on a poll clears a stale connect error once all shown tools are registered.
    expect(describeShownMcpStatus({
      shownToolIds: ['codex'],
      agents: registered,
      notice: { kind: 'error', message: 'Codex: spawn EACCES' },
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: 'Codex can read the plan and change the Board.',
      connectIds: [],
      connectLabel: 'Connect',
    });

    // An unsupported tool (e.g. Pi) stays calm and does not keep an obsolete Codex connect error stuck after Codex is registered.
    expect(describeShownMcpStatus({
      shownToolIds: ['codex', 'pi'],
      agents: [
        agent('codex', { state: 'registered', serverName: 'contextspace-mcp' }),
        agent('pi', { state: 'unsupported', reason: 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter' }),
      ],
      notice: { kind: 'error', message: 'Codex: spawn EACCES', ids: ['codex'] },
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: 'Codex can read the plan and change the Board. Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter',
      connectIds: [],
      connectLabel: 'Connect',
    });

    // If the failed tool became unreadable instead of registered, the error remains visible.
    expect(describeShownMcpStatus({
      shownToolIds: ['codex', 'pi'],
      agents: [
        agent('codex', { state: 'unreadable', reason: '/tmp/.codex/config.toml: invalid TOML' }),
        agent('pi', { state: 'unsupported', reason: 'Pi needs the pi-mcp-adapter package for MCP servers: pi install npm:pi-mcp-adapter' }),
      ],
      notice: { kind: 'error', message: 'Codex: spawn EACCES', ids: ['codex'] },
      connecting: false,
    })).toEqual({
      tone: 'alert',
      text: 'Codex: spawn EACCES',
      connectIds: [],
      connectLabel: 'Connect',
    });
  });

  it('keeps stale disclosure when missing tools exist alongside stale tools and after Connect succeeds', () => {
    const staleText = '"contextspace-mcp" runs the npm package, which stopped at 2.39.';
    const missingAndStale = [
      agent('claude', { state: 'registered', serverName: 'contextspace-mcp', stale: staleText }),
      agent('codex', { state: 'missing' }),
    ];

    expect(describeShownMcpStatus({
      shownToolIds: ['claude', 'codex'],
      agents: missingAndStale,
      notice: null,
      connecting: false,
    })).toEqual({
      tone: 'neutral',
      text: "Codex can't read the plan or change the Board yet.",
      connectIds: ['codex'],
      connectLabel: 'Connect',
      staleSummary: "Claude Code uses an old copy of ContextSpace's tools.",
      staleDetails: [staleText],
    });

    const connectedAndStale = [
      agent('claude', { state: 'registered', serverName: 'contextspace-mcp', stale: staleText }),
      agent('codex', { state: 'registered', serverName: 'contextspace-mcp' }),
    ];
    expect(describeShownMcpStatus({
      shownToolIds: ['claude', 'codex'],
      agents: connectedAndStale,
      notice: { kind: 'connected', message: 'Connected. Sessions already running get the tools when they start again.' },
      connecting: false,
    })).toEqual({
      tone: 'muted',
      text: "Connected. Sessions already running get the tools when they start again. Claude Code uses an old copy of ContextSpace's tools.",
      connectIds: [],
      connectLabel: 'Connect',
      staleDetails: [staleText],
    });
  });
});

describe('applyConnectResults and formatConnectFailures', () => {
  it('updates added/already agents in cache while keeping failed and untouched agents', () => {
    const before = [
      agent('claude', { state: 'missing' }),
      agent('codex', { state: 'missing' }),
    ];
    const results: AgentMcpResult[] = [
      { id: 'claude', name: 'Claude Code', outcome: { result: 'added', how: 'claude mcp add' } },
      { id: 'codex', name: 'Codex', outcome: { result: 'failed', reason: 'spawn EACCES' } },
    ];
    expect(applyConnectResults(before, results)).toEqual([
      agent('claude', { state: 'registered', serverName: 'contextspace-mcp' }),
      agent('codex', { state: 'missing' }),
    ]);
    expect(formatConnectFailures(results)).toBe('Codex: spawn EACCES');
  });
});
