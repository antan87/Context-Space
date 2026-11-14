import type { RecentCommits } from '../plan/whatsNew.js';

/** A commit by repository and (short or full) SHA. The same SHA prefix in two repositories is two commits. */
export interface CommitRef { repo: string; sha: string }
export interface SequenceCommit extends CommitRef {
  subject?: string;
  author?: string;
  at?: string;
  firstBodyLine?: string;
  fileCount?: number;
  pushed?: boolean;
}

/** The commits of the row a commit was opened from, in the order the row shows them, and what to call the row. */
export interface CommitSequence { label: string; commits: SequenceCommit[] }

/** What a request to open the Code window on a commit carries. */
export interface CommitOpen extends CommitRef { sequence?: CommitSequence }

const MIN_PREFIX = 7;

export const commitKey = (ref: CommitRef): string => `${ref.repo}\0${ref.sha.toLowerCase().slice(0, MIN_PREFIX)}`;

/** The same repository and one SHA a prefix of the other (a card carries a short one, the server the full one). */
export function sameCommit(a: CommitRef | null | undefined, b: CommitRef | null | undefined): boolean {
  if (!a || !b || a.repo !== b.repo) return false;
  const x = a.sha.toLowerCase();
  const y = b.sha.toLowerCase();
  if (x.length < MIN_PREFIX || y.length < MIN_PREFIX) return x === y;
  return x.startsWith(y) || y.startsWith(x);
}

export function indexInSequence(sequence: CommitSequence | null | undefined, current: CommitRef | null | undefined): number {
  if (!sequence || !current) return -1;
  return sequence.commits.findIndex((entry) => sameCommit(entry, current));
}

/** The previous (-1) or next (+1) commit of the sequence; null at its ends and when the current one is not in it. */
export function neighbourCommit(sequence: CommitSequence | null | undefined, current: CommitRef | null | undefined, delta: 1 | -1): SequenceCommit | null {
  const index = indexInSequence(sequence, current);
  if (index < 0 || !sequence) return null;
  return sequence.commits[index + delta] ?? null;
}

const byNewest = (a: { at?: string }, b: { at?: string }) => (b.at ?? '') > (a.at ?? '') ? 1 : (b.at ?? '') < (a.at ?? '') ? -1 : 0;

/** One repository's recent commits, newest first, as a sequence of its own. */
export function recentSequence(recent: RecentCommits | undefined, repo: string): CommitSequence | null {
  const entry = recent?.commits.find((item) => item.repo === repo);
  if (!entry || entry.commits.length === 0) return null;
  return {
    label: repo,
    commits: [...entry.commits].sort(byNewest).map((commit) => ({
      repo,
      sha: commit.sha,
      subject: commit.subject,
      author: commit.author,
      at: commit.at,
      ...(commit.firstBodyLine !== undefined ? { firstBodyLine: commit.firstBodyLine } : {}),
      ...(commit.fileCount !== undefined ? { fileCount: commit.fileCount } : {}),
      ...(commit.pushed !== undefined ? { pushed: commit.pushed } : {}),
    })),
  };
}

/** The newest recent commit over all repositories: what the mode opens on when no row sent it. */
export function newestRecentCommit(recent: RecentCommits | undefined): SequenceCommit | null {
  const all = (recent?.commits ?? []).flatMap((entry) => entry.commits.map((commit) => ({
    repo: entry.repo,
    sha: commit.sha,
    subject: commit.subject,
    author: commit.author,
    at: commit.at,
    ...(commit.firstBodyLine !== undefined ? { firstBodyLine: commit.firstBodyLine } : {}),
    ...(commit.fileCount !== undefined ? { fileCount: commit.fileCount } : {}),
    ...(commit.pushed !== undefined ? { pushed: commit.pushed } : {}),
  })));
  return all.sort(byNewest)[0] ?? null;
}

/**
 * The sequence [ and ] move through: the row the commit was opened from while the commit is in it; else the recent commits of the
 * commit's repository (a commit chosen from the list, or one the mode opened on).
 */
export function effectiveSequence(current: CommitRef | null, held: CommitSequence | null, recent: RecentCommits | undefined): CommitSequence | null {
  if (!current) return null;
  if (held && indexInSequence(held, current) >= 0) return held;
  const own = recentSequence(recent, current.repo);
  return own && indexInSequence(own, current) >= 0 ? own : null;
}

export interface CommitListGroup { label: string; commits: SequenceCommit[] }

/**
 * What the list in the header offers: the row's commits first, then the other recent commits of each repository, every commit
 * once (by repository and SHA). Empty groups are left out.
 */
export function composeCommitList(held: CommitSequence | null, recent: RecentCommits | undefined): CommitListGroup[] {
  const seen = new Set<string>();
  const groups: CommitListGroup[] = [];
  const take = (label: string, commits: SequenceCommit[]) => {
    const fresh = commits.filter((commit) => {
      const key = commitKey(commit);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length > 0) groups.push({ label, commits: fresh });
  };
  if (held) take(held.label, held.commits);
  for (const entry of recent?.commits ?? []) {
    const own = recentSequence(recent, entry.repo);
    if (own) take(held ? `Other recent commits in ${entry.repo}` : `Recent commits in ${entry.repo}`, own.commits);
  }
  return groups;
}

/** How the position reads: "2 of 5 · Area". Without a sequence, nothing. */
export function positionText(sequence: CommitSequence | null, current: CommitRef | null): string {
  const index = indexInSequence(sequence, current);
  if (!sequence || index < 0) return '';
  return `${index + 1} of ${sequence.commits.length} · ${sequence.label}`;
}

/**
 * What a request does to the mode: a request for a commit opens Commits on it, with the row it came from; any other request (the Code
 * button, a file) leaves Commits and shows the working tree.
 */
export interface CommitsModeState { open: boolean; commit: CommitRef | null; held: CommitSequence | null }
export function applyCodeRequest(state: CommitsModeState, request: CommitOpen | undefined): CommitsModeState {
  if (request) return { open: true, commit: { repo: request.repo, sha: request.sha }, held: request.sequence ?? null };
  return state.open ? { ...state, open: false } : state;
}
