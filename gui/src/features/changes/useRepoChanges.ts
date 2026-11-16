import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { apiFetch } from '../../lib/api/client.js';
import { summarizeChanges, type ChangeRepo } from './changeSummary.js';

const POLL_MS = 10_000;

/**
 * The uncommitted work of a workspace, for the Board's Code button and the card in the commits row. It asks the same listing
 * the Code section does, with the token it was last given, so an idle board downloads nothing. It polls only while the page is
 * visible (react-query stops in a hidden tab), and `paused` stops it while the Code window is open: that section polls itself.
 */
export function useRepoChanges(workspace: string, options: { enabled: boolean; paused: boolean }) {
  const client = useQueryClient();
  const token = useRef<string | null>(null);
  const key = ['repo-changes', workspace] as const;
  const query = useQuery({
    queryKey: key,
    enabled: options.enabled,
    refetchInterval: options.enabled && !options.paused ? POLL_MS : false,
    queryFn: async ({ signal }): Promise<ChangeRepo[]> => {
      const known = token.current ? `?known=${encodeURIComponent(token.current)}` : '';
      const response = await apiFetch<{ changes?: ChangeRepo[]; unchanged?: boolean; token?: string }>(`/api/workspace/${encodeURIComponent(workspace)}/changes${known}`, { signal });
      token.current = response.token ?? null;
      if (response.unchanged || !response.changes) return client.getQueryData<ChangeRepo[]>(key) ?? [];
      return response.changes;
    },
  });
  // The Code window may have committed or reverted something while this rested: look again the moment it closes
  const wasPaused = useRef(options.paused);
  const { refetch } = query;
  useEffect(() => {
    if (wasPaused.current && !options.paused && options.enabled) void refetch();
    wasPaused.current = options.paused;
  }, [options.paused, options.enabled, refetch]);
  const summary = useMemo(() => summarizeChanges(query.data), [query.data]);
  return { repos: query.data, summary };
}
