/**
 * What needs the developer across workspaces, as GET /api/needs-you sends it (core/needs-you), and how the
 * Overview orders it. Pure apart from the query, so the order is tested on its own.
 */

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';

export interface WorkspaceNeeds {
  workspaceId: string;
  chatQuestion?: { message: string; timestamp: string; harness: string; options?: string[] };
  /** `holdsUp` is the open work only; `detail` says why it is asked, with its suggested answers; `waiting`: the AI waits in the chat. */
  questions: Array<{ id: string; title: string; holdsUp: string[]; detail?: string; askedBy?: string; at: string; waiting?: true }>;
  proposals: Array<{ id: string; title: string; action: string; by: string; at: string }>;
  failedChecks: Array<{ id: string; title: string; at?: string }>;
  closedByAi: Array<{ id: string; title: string; action: string; by: string; at: string; note?: string }>;
  current?: { id: string; title: string };
  next?: { id: string; title: string; waitsFor: string[] };
}

/** One thing that waits for the developer, wherever it is. */
export type NeedItem =
  | { kind: 'chat'; workspaceId: string; text: string; by: string; at: string }
  | QuestionNeed
  | { kind: 'proposal'; workspaceId: string; id: string; text: string; action: string; by: string; at: string }
  | { kind: 'check'; workspaceId: string; id: string; text: string };

export interface QuestionNeed { kind: 'question'; workspaceId: string; id: string; text: string; holdsUp: string[]; detail?: string; by?: string; at: string; waiting?: boolean }

/** A question needs the developer when work waits for its answer, or the AI that asked it waits in the chat. */
export const isUrgent = (question: Pick<QuestionNeed, 'holdsUp' | 'waiting'>) => question.holdsUp.length > 0 || Boolean(question.waiting);

/**
 * What waits, one workspace at a time, the one that waited longest first; within one, the AI waiting in the chat,
 * then the questions, old approval requests and failed checks. A question nothing and nobody waits for goes `aside`,
 * and does not count as needing the developer.
 */
export function needItems(needs: readonly WorkspaceNeeds[]): { groups: Array<{ workspaceId: string; items: NeedItem[] }>; aside: QuestionNeed[] } {
  const question = (workspaceId: string, entry: WorkspaceNeeds['questions'][number]): QuestionNeed => ({
    kind: 'question', workspaceId, id: entry.id, text: entry.title, holdsUp: entry.holdsUp, detail: entry.detail, by: entry.askedBy, at: entry.at, waiting: entry.waiting,
  });
  const groups = needs.map((workspace) => {
    const items: NeedItem[] = [
      ...(workspace.chatQuestion ? [{ kind: 'chat' as const, workspaceId: workspace.workspaceId, text: workspace.chatQuestion.message, by: workspace.chatQuestion.harness, at: workspace.chatQuestion.timestamp }] : []),
      ...workspace.questions.filter(isUrgent).map((entry) => question(workspace.workspaceId, entry)),
      ...workspace.proposals.map((proposal) => ({ kind: 'proposal' as const, workspaceId: workspace.workspaceId, id: proposal.id, text: proposal.title, action: proposal.action, by: proposal.by, at: proposal.at })),
      ...workspace.failedChecks.map((check) => ({ kind: 'check' as const, workspaceId: workspace.workspaceId, id: check.id, text: check.title })),
    ];
    return { workspaceId: workspace.workspaceId, items };
  }).filter((group) => group.items.length > 0)
    // The workspace that has waited longest comes first.
    .sort((a, b) => oldest(a.items).localeCompare(oldest(b.items)));
  const aside = needs.flatMap((workspace) => workspace.questions.filter((entry) => !isUrgent(entry)).map((entry) => question(workspace.workspaceId, entry)))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { groups, aside };
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
