import { harnessName } from '../../components/icons/HarnessIcon.js';
import type { AgentMcpResult, AgentMcpStatus, McpAgentId } from '../../types.js';

/** Harnesses with `mcp: true` in `src/harnesses/registry.ts`. */
export const MCP_AGENT_IDS: readonly McpAgentId[] = ['claude', 'antigravity', 'codex', 'pi'];

/** Maps a terminal tool / target id to its MCP agent id, or null when it does not use ContextSpace's MCP config. */
export function toMcpAgentId(toolId: string): McpAgentId | null {
  const id = toolId.trim().toLowerCase();
  return (MCP_AGENT_IDS as readonly string[]).includes(id) ? (id as McpAgentId) : null;
}

export function formatAgentList(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export type McpConnectNotice =
  | { kind: 'connected'; message: string }
  | { kind: 'connected-first'; message: string }
  | { kind: 'error'; message: string; ids?: readonly McpAgentId[] };

export interface McpLineView {
  tone: 'muted' | 'neutral' | 'alert';
  text: string;
  connectIds: McpAgentId[];
  connectLabel: 'Connect' | 'Connecting…';
  staleDetails?: string[];
  staleSummary?: string;
}

export function formatConnectFailures(results: readonly AgentMcpResult[]): string {
  return results
    .filter((item): item is AgentMcpResult & { outcome: { result: 'failed'; reason: string } } => item.outcome.result === 'failed')
    .map((item) => `${harnessName(item.id)}: ${item.outcome.reason}`)
    .join(' ');
}

export function applyConnectResults(
  agents: readonly AgentMcpStatus[] | undefined,
  results: readonly AgentMcpResult[],
): AgentMcpStatus[] | undefined {
  if (!agents) return agents;
  return agents.map((agent) => {
    const match = results.find((item) => item.id === agent.id);
    if (!match) return agent;
    if (match.outcome.result === 'added') {
      return { ...agent, status: { state: 'registered', serverName: 'contextspace-mcp' } };
    }
    if (match.outcome.result === 'already') {
      return {
        ...agent,
        status: {
          state: 'registered',
          serverName: match.outcome.serverName,
          ...(match.outcome.stale ? { stale: match.outcome.stale } : {}),
        },
      };
    }
    return agent;
  });
}

interface ShownMcpAgent {
  id: McpAgentId;
  displayName: string;
  status: AgentMcpStatus['status'];
}

function formatBlockedReason(item: ShownMcpAgent): string {
  if (item.status.state === 'unsupported') return item.status.reason;
  if (item.status.state === 'unreadable') return `${item.displayName}'s MCP config could not be read (${item.status.reason}).`;
  return '';
}

export function describeShownMcpStatus({
  shownToolIds,
  agents,
  notice,
  connecting,
  connectingIds = [],
}: {
  shownToolIds: readonly string[];
  agents: readonly AgentMcpStatus[] | undefined;
  notice: McpConnectNotice | null;
  connecting: boolean;
  connectingIds?: readonly McpAgentId[];
}): McpLineView | null {
  const shown: ShownMcpAgent[] = [];
  const seen = new Set<McpAgentId>();
  if (agents) {
    for (const toolId of shownToolIds) {
      const id = toMcpAgentId(toolId);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const found = agents.find((agent) => agent.id === id);
      if (!found || found.status.state === 'not-installed') continue;
      shown.push({ id, displayName: harnessName(toolId), status: found.status });
    }
  }

  const missing = shown.filter((item) => item.status.state === 'missing');
  const blocked = shown.filter((item) => item.status.state === 'unsupported' || item.status.state === 'unreadable');
  const stale = shown.filter((item) => item.status.state === 'registered' && Boolean(item.status.stale));
  const fresh = shown.filter((item) => item.status.state === 'registered' && !item.status.stale);

  const connectIds = missing.length > 0
    ? missing.map((item) => item.id)
    : connecting
      ? [...connectingIds]
      : [];
  const connectLabel: 'Connect' | 'Connecting…' = connecting ? 'Connecting…' : 'Connect';
  const blockedText = blocked.map(formatBlockedReason).filter(Boolean).join(' ');
  const staleDetails = stale
    .map((item) => (item.status.state === 'registered' ? item.status.stale : undefined))
    .filter((value): value is string => Boolean(value));
  const stalePhrase = stale.length === 1
    ? `${stale[0]!.displayName} uses an old copy of ContextSpace's tools.`
    : stale.length > 1
      ? `${formatAgentList(stale.map((item) => item.displayName))} use an old copy of ContextSpace's tools.`
      : '';
  const staleExtra = staleDetails.length > 0
    ? { staleDetails, ...(stalePhrase ? { staleSummary: stalePhrase } : {}) }
    : {};

  const errorStillRelevant = notice?.kind === 'error' && (
    shown.length === 0
    || (notice.ids && notice.ids.length > 0
      ? notice.ids.some((id) => {
          const item = shown.find((entry) => entry.id === id);
          return Boolean(item && (item.status.state === 'missing' || item.status.state === 'unreadable'));
        })
      : missing.length > 0 || blocked.some((item) => item.status.state === 'unreadable'))
  );

  if (errorStillRelevant) {
    return {
      tone: 'alert',
      text: notice.message,
      connectIds,
      connectLabel,
      ...staleExtra,
    };
  }

  if (shown.length === 0) return null;

  if (connecting && connectIds.length > 0) {
    const missingText = missing.length > 0
      ? `${formatAgentList(missing.map((item) => item.displayName))} can't read the plan or change the Board yet.`
      : notice?.message || 'Connecting…';
    return {
      tone: 'neutral',
      text: blockedText ? `${missingText} ${blockedText}` : missingText,
      connectIds,
      connectLabel,
      ...staleExtra,
    };
  }

  if (notice && (notice.kind === 'connected' || notice.kind === 'connected-first')) {
    const missingText = missing.length > 0
      ? `${formatAgentList(missing.map((item) => item.displayName))} can't read the plan or change the Board yet.`
      : '';
    const extra = [missingText, blockedText, missing.length === 0 ? stalePhrase : ''].filter(Boolean).join(' ');
    return {
      tone: 'muted',
      text: extra ? `${notice.message} ${extra}` : notice.message,
      connectIds,
      connectLabel,
      ...(staleDetails.length > 0
        ? (missing.length === 0 ? { staleDetails } : staleExtra)
        : {}),
    };
  }

  if (missing.length > 0) {
    const missingText = `${formatAgentList(missing.map((item) => item.displayName))} can't read the plan or change the Board yet.`;
    return {
      tone: 'neutral',
      text: blockedText ? `${missingText} ${blockedText}` : missingText,
      connectIds,
      connectLabel,
      ...staleExtra,
    };
  }

  const freshPhrase = fresh.length > 0
    ? `${formatAgentList(fresh.map((item) => item.displayName))} can read the plan and change the Board.`
    : '';

  const parts = [freshPhrase, blockedText, stalePhrase].filter(Boolean);
  if (parts.length === 0) return null;

  return {
    tone: 'muted',
    text: parts.join(' '),
    connectIds: [],
    connectLabel: 'Connect',
    ...(staleDetails.length > 0 ? { staleDetails } : {}),
  };
}
