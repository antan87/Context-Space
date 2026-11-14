/**
 * What changed since the user last looked, as GET /api/workspace/:id/news sends it (core/whats-new): the plan's
 * changes, the documents and images left in the workspace, the knowledge and the commits, and who made each. The
 * words are pure so they are tested alone; the queries read the list and say the user has seen it.
 */

import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api/client.js';
import { changeLine, type PlanFileChange } from './planFile.js';
import { whenText } from './planView.js';

export interface NewsSection<T> { items: T[]; more: number }

export interface NewsDocument { name: string; kind: string; change: 'added' | 'changed'; at: string }
export interface NewsKnowledge { id: string; title: string; date: string | null; type: string | null }
export interface NewsCommit {
  sha: string;
  author: string;
  subject: string;
  at: string;
  firstBodyLine?: string;
  fileCount?: number;
  pushed?: boolean;
}
export interface NewsRepo { repo: string; commits: NewsCommit[]; more: number; moreAtLeast?: true; problem?: string }

export type IncomingState = 'ok' | 'checking' | 'sign-in' | 'offline' | 'busy' | 'no-remote' | 'no-upstream' | 'error';

export interface IncomingHost {
  kind: 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'local' | 'other';
  name: string;
}

export interface IncomingCommitView {
  sha: string;
  author: string;
  subject: string;
  at: string;
  firstBodyLine?: string;
  fileCount?: number;
  incoming: true;
  webUrl?: string | null;
}

export interface IncomingRepoView {
  repo: string;
  remote: string | null;
  branch: string | null;
  host: IncomingHost | null;
  lastFetchAt: string | null;
  fetching: boolean;
  state: IncomingState;
  message: string | null;
  behind: number;
  commits: IncomingCommitView[];
  more: number;
}

export interface IncomingCommitsReport {
  at: string;
  repos: IncomingRepoView[];
}

export interface NewsIncomingGroupView {
  author: string;
  count: number;
  newestSha: string;
  newestAt: string;
  subject: string;
}

export interface NewsIncomingRepoView {
  repo: string;
  host: IncomingHost | null;
  groups: NewsIncomingGroupView[];
}

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
  /** Unseen commits on local remote-tracking refs (never triggers a fetch). */
  incoming?: NewsIncomingRepoView[];
  /** Only on what the Board draws (`boardNews`): the commits that are new to the reader, a part of `commits`, which is the recent ones. */
  unseenCommits?: NewsRepo[];
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

/** The commits of the last few days, whatever the user has seen: the Board draws these, so that Got it never takes work off it. */
export interface RecentCommits { at: string; from: string; commits: NewsRepo[] }

export const recentCommitsKey = (workspace: string | null) => ['recent-commits', workspace] as const;

export const incomingCommitsKey = (workspace: string | null) => ['incoming-commits', workspace] as const;

const INCOMING_FETCH_RETRY_MS = 5_000;
const INCOMING_FETCH_MAX_RETRIES = 8;

interface IncomingWatcherState {
  subscribers: number;
  timer: ReturnType<typeof setTimeout> | null;
  retries: number;
  exhausted: boolean;
  wasFetching: boolean;
  inFlightRequests: number;
  activeRetry: boolean;
  lastFetchFailed: boolean;
  wantsFollowUp: boolean;
  listeners: Set<() => void>;
}

const incomingWatchersByClient = new WeakMap<QueryClient, Map<string, IncomingWatcherState>>();

function getClientWatchers(queryClient: QueryClient): Map<string, IncomingWatcherState> {
  let map = incomingWatchersByClient.get(queryClient);
  if (!map) {
    map = new Map();
    incomingWatchersByClient.set(queryClient, map);
  }
  return map;
}

function getWatcher(queryClient: QueryClient, workspace: string | null): IncomingWatcherState | undefined {
  if (!workspace) return undefined;
  return getClientWatchers(queryClient).get(workspace);
}

function ensureWatcher(queryClient: QueryClient, workspace: string): IncomingWatcherState {
  const map = getClientWatchers(queryClient);
  let watcher = map.get(workspace);
  if (!watcher) {
    watcher = {
      subscribers: 0,
      timer: null,
      retries: 0,
      exhausted: false,
      wasFetching: false,
      inFlightRequests: 0,
      activeRetry: false,
      lastFetchFailed: false,
      wantsFollowUp: false,
      listeners: new Set(),
    };
    map.set(workspace, watcher);
  }
  return watcher;
}

function notifyWatcher(watcher: IncomingWatcherState): void {
  for (const listener of watcher.listeners) listener();
}

function cancelWatcherTimer(watcher: IncomingWatcherState): void {
  if (watcher.timer !== null) {
    clearTimeout(watcher.timer);
    watcher.timer = null;
  }
}

function isWatcherPending(watcher: IncomingWatcherState | undefined): boolean {
  if (!watcher) return false;
  return watcher.inFlightRequests > 0 || watcher.activeRetry || watcher.timer !== null;
}

function scheduleWatcherRetry(queryClient: QueryClient, workspace: string, watcher: IncomingWatcherState): void {
  if (
    watcher.timer !== null
    || watcher.subscribers <= 0
    || watcher.exhausted
    || watcher.lastFetchFailed
    || watcher.retries >= INCOMING_FETCH_MAX_RETRIES
  ) {
    return;
  }
  watcher.timer = setTimeout(() => {
    const current = getWatcher(queryClient, workspace);
    if (!current) return;
    current.timer = null;
    if (current.subscribers <= 0 || current.exhausted || current.retries >= INCOMING_FETCH_MAX_RETRIES) {
      current.wantsFollowUp = false;
      notifyWatcher(current);
      return;
    }
    current.retries += 1;
    current.activeRetry = true;
    notifyWatcher(current);
    void queryClient.invalidateQueries({ queryKey: incomingCommitsKey(workspace) }).finally(() => {
      current.activeRetry = false;
      notifyWatcher(current);
    });
  }, INCOMING_FETCH_RETRY_MS);
}

function applyIncomingReport(
  queryClient: QueryClient,
  workspace: string,
  watcher: IncomingWatcherState,
  report: IncomingCommitsReport,
): void {
  const fetching = report.repos.some((repo) => repo.fetching);
  watcher.lastFetchFailed = false;
  if (!fetching) {
    cancelWatcherTimer(watcher);
    const justFinished = watcher.wasFetching;
    watcher.wasFetching = false;
    watcher.wantsFollowUp = false;
    watcher.retries = 0;
    watcher.exhausted = false;
    if (justFinished) {
      void queryClient.invalidateQueries({ queryKey: newsKey(workspace) });
    }
    return;
  }
  watcher.wasFetching = true;
  if (watcher.retries >= INCOMING_FETCH_MAX_RETRIES) {
    cancelWatcherTimer(watcher);
    watcher.exhausted = true;
    watcher.wantsFollowUp = false;
    return;
  }
  watcher.wantsFollowUp = true;
  scheduleWatcherRetry(queryClient, workspace, watcher);
}

export async function fetchIncomingCommits(workspace: string, opts?: { refresh?: boolean; signal?: AbortSignal }): Promise<IncomingCommitsReport> {
  const suffix = opts?.refresh ? '?refresh=1' : '';
  const report = await apiFetch<IncomingCommitsReport>(`/api/workspace/${encodeURIComponent(workspace)}/incoming${suffix}`, { signal: opts?.signal });
  if (typeof report?.at !== 'string' || !Array.isArray(report.repos)) {
    throw new Error('the incoming commits came back in a form this version of the app does not read');
  }
  return report;
}

export async function refreshIncomingCommits(queryClient: QueryClient, workspace: string): Promise<IncomingCommitsReport> {
  const watcher = ensureWatcher(queryClient, workspace);
  cancelWatcherTimer(watcher);
  watcher.retries = 0;
  watcher.exhausted = false;
  watcher.lastFetchFailed = false;
  watcher.wantsFollowUp = false;
  watcher.activeRetry = false;
  watcher.inFlightRequests += 1;
  notifyWatcher(watcher);
  try {
    const report = await fetchIncomingCommits(workspace, { refresh: true });
    applyIncomingReport(queryClient, workspace, watcher, report);
    queryClient.setQueryData(incomingCommitsKey(workspace), report);
    void queryClient.invalidateQueries({ queryKey: recentCommitsKey(workspace) });
    if (!report.repos.some((repo) => repo.fetching)) {
      void queryClient.invalidateQueries({ queryKey: newsKey(workspace) });
    }
    return report;
  } catch (error) {
    watcher.lastFetchFailed = true;
    watcher.wantsFollowUp = false;
    cancelWatcherTimer(watcher);
    throw error;
  } finally {
    watcher.inFlightRequests = Math.max(0, watcher.inFlightRequests - 1);
    notifyWatcher(watcher);
  }
}

export function useIncomingCommits(workspace: string | null, options: { enabled?: boolean } = {}) {
  const enabled = Boolean(workspace) && (options.enabled ?? true);
  const queryClient = useQueryClient();

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled || !workspace) return () => undefined;
      const watcher = ensureWatcher(queryClient, workspace);
      watcher.listeners.add(listener);
      return () => {
        watcher.listeners.delete(listener);
      };
    },
    [enabled, workspace, queryClient],
  );

  const getSnapshot = useCallback(
    () => (enabled && workspace ? isWatcherPending(getWatcher(queryClient, workspace)) : false),
    [enabled, workspace, queryClient],
  );

  const watcherPending = useSyncExternalStore(subscribe, getSnapshot, () => false);

  const query = useQuery({
    queryKey: incomingCommitsKey(workspace),
    queryFn: async ({ signal }) => {
      const watcher = ensureWatcher(queryClient, workspace!);
      watcher.inFlightRequests += 1;
      notifyWatcher(watcher);
      try {
        const report = await fetchIncomingCommits(workspace!, { signal });
        applyIncomingReport(queryClient, workspace!, watcher, report);
        return report;
      } catch (error) {
        if (!signal.aborted) {
          watcher.lastFetchFailed = true;
          watcher.wantsFollowUp = false;
          cancelWatcherTimer(watcher);
        }
        throw error;
      } finally {
        watcher.inFlightRequests = Math.max(0, watcher.inFlightRequests - 1);
        notifyWatcher(watcher);
      }
    },
    enabled,
    staleTime: 30_000,
    retry: false,
  });

  useLayoutEffect(() => {
    if (!enabled || !workspace) return undefined;
    const watcher = ensureWatcher(queryClient, workspace);
    watcher.subscribers += 1;
    if (watcher.wantsFollowUp && !watcher.exhausted && !watcher.lastFetchFailed) {
      scheduleWatcherRetry(queryClient, workspace, watcher);
      notifyWatcher(watcher);
    }
    return () => {
      const current = getWatcher(queryClient, workspace);
      if (!current) return;
      current.subscribers = Math.max(0, current.subscribers - 1);
      if (current.subscribers <= 0) {
        cancelWatcherTimer(current);
      }
    };
  }, [enabled, workspace, queryClient]);

  const checking = enabled && (query.fetchStatus === 'fetching' || watcherPending);
  return { ...query, checking };
}

export function useRecentCommits(workspace: string | null) {
  return useQuery({
    queryKey: recentCommitsKey(workspace),
    queryFn: async ({ signal }) => {
      const recent = await apiFetch<RecentCommits>(`/api/workspace/${encodeURIComponent(workspace!)}/recent-commits`, { signal });
      if (typeof recent?.at !== 'string' || !Array.isArray(recent.commits)) throw new Error('the commits came back in a form this version of the app does not read');
      return recent;
    },
    enabled: Boolean(workspace),
    staleTime: 30_000,
    // The Board does without it (it keeps what the news lists), so a failure is not retried or shown
    retry: false,
  });
}

/**
 * Maximum commits per repository passed to the Board, matching backend `NEWS_LIMIT` (`10`)
 * while Review's `Commits` list reads up to `50` directly from `useRecentCommits`.
 */
const BOARD_RECENT_COMMITS_LIMIT = 10;

/**
 * What the Board draws its commits from: the recent commits (the last few days) and whatever the news lists, each once, with the
 * news only saying which are new. Marking the news as seen empties `news`, and takes nothing off the board. A recent list that could
 * not be read leaves the news's own commits, as before.
 */
export function boardNews(news: WhatsNewView | undefined, recent: RecentCommits | undefined): WhatsNewView | undefined {
  if (!news) return undefined;
  if (!recent) return { ...news, unseenCommits: news.commits };
  const unseen = news.empty ? [] : news.commits;
  const commits = [...recent.commits.map((repo) => repo.repo), ...news.commits.map((repo) => repo.repo)].filter((name, index, all) => all.indexOf(name) === index).map((name): NewsRepo => {
    const a = recent.commits.find((repo) => repo.repo === name);
    const b = news.commits.find((repo) => repo.repo === name);
    const aSorted = [...(a?.commits ?? [])].sort((x, y) => (y.at > x.at ? 1 : y.at < x.at ? -1 : 0));
    const aShown = aSorted.slice(0, BOARD_RECENT_COMMITS_LIMIT);
    const aOverflow = aSorted.length - aShown.length;
    const seen = new Set<string>();
    const list = [...aShown, ...(b?.commits ?? [])].filter((commit) => {
      const key = commit.sha.slice(0, 7);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((x, y) => (y.at > x.at ? 1 : y.at < x.at ? -1 : 0));
    const problem = a?.problem ?? b?.problem;
    return { repo: name, commits: list, more: Math.max((a?.more ?? 0) + aOverflow, b?.more ?? 0), ...(a?.moreAtLeast || b?.moreAtLeast ? { moreAtLeast: true as const } : {}), ...(problem && list.length === 0 ? { problem } : {}) };
  });
  return { ...news, basis: 'first-look', from: recent.from < news.from ? recent.from : news.from, commits, unseenCommits: unseen };
}

/** Got it: the user has seen the list made at `at`. A list that changed since is refused, and read again. */
export function useMarkNewsSeen(workspace: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (at: string) => apiFetch<{ ok: true }>(`/api/workspace/${encodeURIComponent(workspace)}/news/seen`, {
      method: 'POST', body: JSON.stringify({ reader: 'user', at }),
    }),
    onSuccess: () => {
      queryClient.setQueryData<WhatsNewView>(newsKey(workspace), (news) => news && {
        ...news,
        empty: true,
        plan: { items: [], more: 0 },
      });
    },
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

export function formatIncomingNewsLine(repo: string, count: number, author: string, host: { name: string } | null | undefined): string {
  const noun = count === 1 ? 'commit' : 'commits';
  const summary = host?.name
    ? `${count} new ${noun} from ${author} on ${host.name}`
    : `${count} new ${noun} from ${author}`;
  return `${repo}: ${summary}`;
}

/** What the list holds, as counts: ["3 plan changes", "1 new document", "2 commits"]. Nothing that is zero. */
export function newsCounts(news: Pick<WhatsNewView, 'plan' | 'documents' | 'knowledge' | 'commits' | 'incoming'>): string[] {
  const documents = news.documents.items;
  const added = documents.filter((document) => document.change === 'added').length;
  // Past the ones listed, which of the rest are new is not known, so then they are only counted.
  const documentCounts = news.documents.more
    ? [count(documents.length + news.documents.more, 'document', 'documents')]
    : [added ? count(added, 'new document', 'new documents') : '', documents.length - added ? count(documents.length - added, 'changed document', 'changed documents') : ''];
  const incomingCommits = (news.incoming ?? []).reduce((total, repo) => total + repo.groups.reduce((sum, group) => sum + group.count, 0), 0);
  const commits = news.commits.reduce((total, repo) => total + repo.commits.length + repo.more, 0) + incomingCommits;
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

/** What a line of the list is about, so that a screen can take the reader to it: a plan item, a document by name, or a commit. */
export type NewsRef =
  | { kind: 'plan'; item: PlanFileChange['kind']; key: string; removed: boolean }
  | { kind: 'document'; name: string }
  | { kind: 'commit'; repo: string; sha: string }
  | { kind: 'incoming'; repo: string; sha: string; author: string; count: number; host: string | null }
  /** A knowledge entry by its day and title, or the knowledge in general (the line "and 3 more"). */
  | { kind: 'knowledge'; title?: string; date?: string | null };

/** One line of the list, the group it is under, when it happened (the newest first when sorted) and what it is about, if anything. */
export interface NewsEntry { group: string; text: string; at?: string; ref?: NewsRef }

const withTime = (text: string, at: string, now: Date) => {
  const when = agoText(at, now);
  return when ? `${text} · ${when}` : text;
};

/** Every line of the list, in the order of `ctxspace news`: the groups Plan, Documents, Knowledge, Commits and Not read. */
export function newsEntries(news: WhatsNewView, now: Date = new Date()): NewsEntry[] {
  const more = (group: string, n: number, what = 'more'): NewsEntry[] => (n ? [{ group, text: `and ${n} ${what}` }] : []);
  const problems = [...news.commits.filter((repo) => repo.problem).map((repo) => `${repo.repo} could not be read: ${repo.problem}`), ...news.problems];
  return [
    ...more('Plan', news.plan.more, 'earlier, not shown'),
    ...news.plan.items.map((change): NewsEntry => ({ group: 'Plan', text: withTime(changeLine(change), change.at, now), at: change.at, ref: { kind: 'plan', item: change.kind, key: change.key, removed: change.action === 'removed' } })),
    ...news.documents.items.map((document): NewsEntry => ({ group: 'Documents', text: withTime(`${document.name} ${document.change}`, document.at, now), at: document.at, ref: { kind: 'document', name: document.name } })),
    ...more('Documents', news.documents.more),
    ...news.knowledge.items.map((entry): NewsEntry => ({ group: 'Knowledge', text: `${entry.type ?? 'note'} “${entry.title}”${entry.date ? ` · ${entry.date}` : ''}`, ref: { kind: 'knowledge', title: entry.title, date: entry.date } })),
    ...more('Knowledge', news.knowledge.more).map((line): NewsEntry => ({ ...line, ref: { kind: 'knowledge' } })),
    ...news.commits.flatMap((repo): NewsEntry[] => [
      ...repo.commits.map((commit): NewsEntry => ({ group: 'Commits', text: withTime(`${repo.repo}: ${commit.sha} ${commit.subject} (${commit.author})`, commit.at, now), at: commit.at, ref: { kind: 'commit', repo: repo.repo, sha: commit.sha } })),
      ...(repo.more ? [{ group: 'Commits', text: `and ${repo.more}${repo.moreAtLeast ? '+' : ''} more in ${repo.repo}` }] : []),
    ]),
    ...(news.incoming ?? []).flatMap((repo): NewsEntry[] =>
      repo.groups.map((group): NewsEntry => ({
        group: 'Commits',
        text: formatIncomingNewsLine(repo.repo, group.count, group.author, repo.host),
        at: group.newestAt,
        ref: { kind: 'incoming', repo: repo.repo, sha: group.newestSha, author: group.author, count: group.count, host: repo.host?.name ?? null },
      })),
    ),
    ...problems.map((text): NewsEntry => ({ group: 'Not read', text })),
  ];
}

/** The same short lines `ctxspace news` prints, under the headings Plan, Documents, Knowledge and Commits. */
export function newsGroups(news: WhatsNewView, now: Date = new Date()): NewsGroup[] {
  const entries = newsEntries(news, now);
  return ['Plan', 'Documents', 'Knowledge', 'Commits', 'Not read']
    .map((title) => ({ title, lines: entries.filter((entry) => entry.group === title).map((entry) => entry.text) }))
    .filter((group) => group.lines.length > 0);
}

/** How many things are new: plan changes, documents, knowledge entries and commits, including those past the ones listed. Zero when it was seen. */
export function newsTotal(news: WhatsNewView | undefined): number {
  if (!news || news.empty) return 0;
  return news.plan.items.length + news.plan.more + news.documents.items.length + news.documents.more + news.knowledge.items.length + news.knowledge.more
    + news.commits.reduce((total, repo) => total + repo.commits.length + repo.more, 0)
    + (news.incoming ?? []).reduce((total, repo) => total + repo.groups.reduce((sum, group) => sum + group.count, 0), 0);
}
