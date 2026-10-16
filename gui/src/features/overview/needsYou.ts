/**
 * What needs the developer across workspaces, as GET /api/needs-you sends it (core/needs-you), and how the
 * Overview orders it. Pure apart from the query, so the order is tested on its own.
 */

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';

export interface WorkspaceNeeds {
  workspaceId: string;
  chatQuestion?: { message: string; timestamp: string; harness: string; options?: string[] };
  questions: Array<{ id: string; title: string; holdsUp: string[]; askedBy?: string; at: string }>;
  proposals: Array<{ id: string; title: string; action: string; by: string; at: string }>;
  failedChecks: Array<{ id: string; title: string; at?: string }>;
  closedByAi: Array<{ id: string; title: string; action: string; by: string; at: string; note?: string }>;
  current?: { id: string; title: string };
  next?: { id: string; title: string; waitsFor: string[] };
}

/** One thing that waits for the developer, wherever it is. */
export type NeedItem =
  | { kind: 'chat'; workspaceId: string; text: string; by: string; at: string }
  | { kind: 'question'; workspaceId: string; id: string; text: string; holdsUp: string[]; by?: string; at: string }
  | { kind: 'proposal'; workspaceId: string; id: string; text: string; action: string; by: string; at: string }
  | { kind: 'check'; workspaceId: string; id: string; text: string };

/** Everything that waits, one workspace at a time; within one, the AI waiting in the chat first, then the oldest question. */
export function needItems(needs: readonly WorkspaceNeeds[]): Array<{ workspaceId: string; items: NeedItem[] }> {
  return needs.map((workspace) => {
    const items: NeedItem[] = [
      ...(workspace.chatQuestion ? [{ kind: 'chat' as const, workspaceId: workspace.workspaceId, text: workspace.chatQuestion.message, by: workspace.chatQuestion.harness, at: workspace.chatQuestion.timestamp }] : []),
      ...workspace.questions.map((question) => ({ kind: 'question' as const, workspaceId: workspace.workspaceId, id: question.id, text: question.title, holdsUp: question.holdsUp, by: question.askedBy, at: question.at })),
      ...workspace.proposals.map((proposal) => ({ kind: 'proposal' as const, workspaceId: workspace.workspaceId, id: proposal.id, text: proposal.title, action: proposal.action, by: proposal.by, at: proposal.at })),
      ...workspace.failedChecks.map((check) => ({ kind: 'check' as const, workspaceId: workspace.workspaceId, id: check.id, text: check.title })),
    ];
    return { workspaceId: workspace.workspaceId, items };
  }).filter((group) => group.items.length > 0)
    // The workspace that has waited longest comes first.
    .sort((a, b) => oldest(a.items).localeCompare(oldest(b.items)));
}

function oldest(items: readonly NeedItem[]): string {
  return items.map((item) => ('at' in item ? item.at : '')).filter(Boolean).sort()[0] ?? '9999';
}

/** What the AI closed lately, across workspaces, newest first. */
export function aiClosedLately(needs: readonly WorkspaceNeeds[]): Array<WorkspaceNeeds['closedByAi'][number] & { workspaceId: string }> {
  return needs.flatMap((workspace) => workspace.closedByAi.map((entry) => ({ ...entry, workspaceId: workspace.workspaceId })))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export const needsYouKey = (ids: readonly string[]) => ['needs-you', ids.join(',')] as const;

/** What needs the developer in the named workspaces. Read again every half minute while the Overview is open. */
export function useNeedsYou(ids: readonly string[]) {
  return useQuery({
    queryKey: needsYouKey(ids),
    queryFn: ({ signal }) => apiFetch<{ workspaces: WorkspaceNeeds[] }>(`/api/needs-you?workspaces=${encodeURIComponent(ids.join(','))}`, { signal }),
    enabled: ids.length > 0,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
