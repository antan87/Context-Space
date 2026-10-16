import { useQueries, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';
import type { AISession } from '../../types.js';

export function useWorkspaceSessionSources(workspace: string, enabled: boolean, { newest }: { /** Only the newest few that can be continued, per tool: older history is not parsed. */ newest?: number } = {}) {
  const catalog = useQuery({
    queryKey: ['terminal-resume-sources'],
    queryFn: ({ signal }) => apiFetch<{ sources: string[] }>('/api/session-sources', { signal }),
    enabled,
    staleTime: Infinity,
  });
  const sources = catalog.data?.sources ?? [];
  const histories = useQueries({ queries: sources.map(source => ({
    queryKey: ['terminal-resume-source', workspace, source, newest ?? 'all'],
    queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch<{ sessions: AISession[] }>(`/api/workspace/${encodeURIComponent(workspace)}/sessions?source=${source}${newest ? `&newest=${newest}` : ''}`, { signal }),
    enabled,
    staleTime: 15_000,
  })) });
  const seen = new Set<string>();
  const sessions = histories.flatMap(history => history.data?.sessions ?? []).filter(session => {
    const key = `${session.assistant}:${session.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    histories,
    sessions,
    sourcesChecked: histories.filter(history => history.isSuccess || history.isError).length,
    sourcesPending: histories.filter(history => history.isPending).length + (enabled && catalog.isPending ? 1 : 0),
    sourcesFailed: histories.filter(history => history.isError).length + (catalog.isError ? 1 : 0),
    sourceCount: sources.length,
  };
}
