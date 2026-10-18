/**
 * What changed since the user last looked, as GET /api/workspace/:id/news sends it (core/whats-new): the plan's
 * changes, the documents and images left in the workspace, the knowledge and the commits, and who made each. The
 * words are pure so they are tested alone; the queries read the list and say the user has seen it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';
import { changeLine, type PlanFileChange } from './planFile.js';
import { whenText } from './planView.js';

export interface NewsSection<T> { items: T[]; more: number }

export interface NewsDocument { name: string; kind: string; change: 'added' | 'changed'; at: string }
export interface NewsKnowledge { id: string; title: string; date: string | null; type: string | null }
export interface NewsCommit { sha: string; author: string; subject: string; at: string }
export interface NewsRepo { repo: string; commits: NewsCommit[]; more: number; moreAtLeast?: true; problem?: string }

export interface WhatsNewView {
  reader: string;
  /** When the list was made; Got it sends it back, so what is marked is exactly what was shown. */
  at: string;
  /** How far back it reaches. */
  from: string;
  /** `last-look`: since the user's last look. `first-look`: they have not looked yet, so the last few days. */
  basis: 'last-look' | 'first-look' | 'time';
  /** Oldest first; the ones listed are the newest. */
  plan: NewsSection<PlanFileChange>;
  documents: NewsSection<NewsDocument>;
  knowledge: NewsSection<NewsKnowledge>;
  commits: NewsRepo[];
  problems: string[];
  empty: boolean;
}

export const newsKey = (workspace: string | null) => ['news', workspace] as const;

/**
 * The list for the user (the address reads as the user when no reader is named), read again when the plan changes
 * (the screen feed says so) and not otherwise: every read keeps what it showed until the user says they have seen it.
 */
export function useWhatsNew(workspace: string | null) {
  return useQuery({
    queryKey: newsKey(workspace),
    queryFn: async ({ signal }) => {
      const news = await apiFetch<WhatsNewView>(`/api/workspace/${encodeURIComponent(workspace!)}/news`, { signal });
      // An older backend answers this address with something else; there is nothing to show then.
      if (typeof news?.at !== 'string' || !Array.isArray(news.commits) || !news.plan) throw new Error('the list came back in a form this version of the app does not read');
      return news;
    },
    enabled: Boolean(workspace),
    staleTime: 30_000,
  });
}

/** Got it: the user has seen the list made at `at`. A list that changed since is refused, and read again. */
export function useMarkNewsSeen(workspace: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (at: string) => apiFetch<{ ok: true }>(`/api/workspace/${encodeURIComponent(workspace)}/news/seen`, {
      method: 'POST', body: JSON.stringify({ reader: 'user', at }),
    }),
    onSuccess: () => { queryClient.setQueryData<WhatsNewView>(newsKey(workspace), (news) => news && { ...news, empty: true }); },
    onError: () => { void queryClient.invalidateQueries({ queryKey: newsKey(workspace) }); },
  });
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "just now" for under a minute, else "2 h ago", "yesterday", "Oct 7". Empty when the time is unknown. */
export function agoText(at: string | undefined, now: Date = new Date()): string {
  const then = at ? Date.parse(at) : NaN;
  if (Number.isFinite(then) && Math.abs(now.getTime() - then) < 60_000) return 'just now';
  return whenText(at, now);
}

/** What the list holds, as counts: ["3 plan changes", "1 new document", "2 commits"]. Nothing that is zero. */
export function newsCounts(news: Pick<WhatsNewView, 'plan' | 'documents' | 'knowledge' | 'commits'>): string[] {
  const documents = news.documents.items;
  const added = documents.filter((document) => document.change === 'added').length;
  // Past the ones listed, which of the rest are new is not known, so then they are only counted.
  const documentCounts = news.documents.more
    ? [count(documents.length + news.documents.more, 'document', 'documents')]
    : [added ? count(added, 'new document', 'new documents') : '', documents.length - added ? count(documents.length - added, 'changed document', 'changed documents') : ''];
  const commits = news.commits.reduce((total, repo) => total + repo.commits.length + repo.more, 0);
  const commitsAtLeast = news.commits.some((repo) => repo.moreAtLeast);
  const knowledge = news.knowledge.items.length + news.knowledge.more;
  const plan = news.plan.items.length + news.plan.more;
  return [
    plan ? count(plan, 'plan change', 'plan changes') : '',
    ...documentCounts,
    knowledge ? count(knowledge, 'new knowledge entry', 'new knowledge entries') : '',
    commits ? `${commits}${commitsAtLeast ? '+' : ''} ${commits === 1 && !commitsAtLeast ? 'commit' : 'commits'}` : '',
  ].filter(Boolean);
}

/** Where the list starts: "Since you last looked, 2 h ago", or the last few days for a first look. */
export function newsHeading(news: Pick<WhatsNewView, 'at' | 'from' | 'basis'>, now: Date = new Date()): string {
  if (news.basis === 'first-look') return `In the last ${Math.max(1, Math.round((Date.parse(news.at) - Date.parse(news.from)) / 86_400_000))} days`;
  const when = agoText(news.from, now);
  if (news.basis === 'time') return `Since ${when === 'just now' ? 'a moment ago' : when}`;
  return when === 'just now' ? 'Since you last looked just now' : `Since you last looked, ${when || 'earlier'}`;
}

/** The one line above the list: "Since you last looked, 2 h ago: 3 plan changes, 1 new document, 2 commits". */
export function newsSummary(news: WhatsNewView, now: Date = new Date()): string {
  const counts = newsCounts(news);
  return counts.length ? `${newsHeading(news, now)}: ${counts.join(', ')}` : `${newsHeading(news, now)}.`;
}

export interface NewsGroup { title: string; lines: string[] }

const withTime = (text: string, at: string, now: Date) => {
  const when = agoText(at, now);
  return when ? `${text} · ${when}` : text;
};

/** The same short lines `ctxspace news` prints, under the headings Plan, Documents, Knowledge and Commits. */
export function newsGroups(news: WhatsNewView, now: Date = new Date()): NewsGroup[] {
  const more = (n: number, what = 'more') => (n ? [`and ${n} ${what}`] : []);
  const problems = [...news.commits.filter((repo) => repo.problem).map((repo) => `${repo.repo} could not be read: ${repo.problem}`), ...news.problems];
  return [
    { title: 'Plan', lines: [...more(news.plan.more, 'earlier, not shown'), ...news.plan.items.map((change) => withTime(changeLine(change), change.at, now))] },
    { title: 'Documents', lines: [...news.documents.items.map((document) => withTime(`${document.name} ${document.change}`, document.at, now)), ...more(news.documents.more)] },
    { title: 'Knowledge', lines: [...news.knowledge.items.map((entry) => `${entry.type ?? 'note'} “${entry.title}”${entry.date ? ` · ${entry.date}` : ''}`), ...more(news.knowledge.more)] },
    { title: 'Commits', lines: news.commits.flatMap((repo) => [
      ...repo.commits.map((commit) => withTime(`${repo.repo}: ${commit.sha} ${commit.subject} (${commit.author})`, commit.at, now)),
      ...(repo.more ? [`and ${repo.more}${repo.moreAtLeast ? '+' : ''} more in ${repo.repo}`] : []),
    ]) },
    { title: 'Not read', lines: problems },
  ].filter((group) => group.lines.length > 0);
}
