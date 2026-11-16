import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';
import { cleanAnswers, type QuestionAnswerDto } from './questionsArea.js';

export const questionsKey = (workspace: string | null) => ['workspace-questions', workspace] as const;

/** How often the answers are read again while the Board shows: every few minutes, as the Workspace files listing is. */
export const QUESTIONS_REFETCH_MS = 3 * 60_000;

/**
 * Reads the answers of a workspace (`explain/*.md`, with each copied code block checked). Read when the Board shows, when the window
 * regains focus, when the news says documents changed (the Board invalidates the key), and otherwise every few minutes. A read that
 * fails keeps the answers that were shown. Nothing here writes.
 */
export function useQuestions(workspace: string | null, options: { active?: boolean } = {}) {
  const queryClient = useQueryClient();
  const active = Boolean(workspace) && (options.active ?? true);
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const onFocus = () => { void queryClient.invalidateQueries({ queryKey: questionsKey(workspace) }); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active, queryClient, workspace]);

  return useQuery({
    queryKey: questionsKey(workspace),
    queryFn: async ({ signal }): Promise<QuestionAnswerDto[]> => cleanAnswers(await apiFetch<unknown>(`/api/workspace/${encodeURIComponent(workspace!)}/questions`, { signal })),
    enabled: Boolean(workspace),
    staleTime: QUESTIONS_REFETCH_MS,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: options.active ? QUESTIONS_REFETCH_MS : false,
    retry: false,
  });
}
