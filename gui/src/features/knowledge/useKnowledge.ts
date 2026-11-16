import { useQuery } from '@tanstack/react-query';

import { ApiError, apiFetch } from '../../lib/api/client.js';

export const knowledgeFileKey = (workspace: string | null) => ['knowledge-file', workspace] as const;

/**
 * The workspace's knowledge file as written (GET /api/workspace/:id/knowledge). A workspace that has none answers with a short
 * note, or an older server with nothing: both read as "no entries", not as a failure.
 */
export function useKnowledge(workspace: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: knowledgeFileKey(workspace),
    queryFn: async ({ signal }): Promise<string> => {
      try {
        const data = await apiFetch<{ content?: unknown }>(`/api/workspace/${encodeURIComponent(workspace!)}/knowledge`, { signal });
        if (typeof data?.content !== 'string') throw new Error('the knowledge came back in a form this version of the app does not read');
        return data.content;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return '';
        throw error;
      }
    },
    enabled: Boolean(workspace) && (options.enabled ?? true),
    staleTime: 30_000,
    retry: false,
  });
}
